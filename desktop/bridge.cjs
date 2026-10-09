// Desktop "native" bridge for the Electron client.
// Mirrors the method surface the React renderer expects from window.SimNativeV2,
// but backed by a bundled xray.exe + the Windows system proxy (WinINET).
//
// v1 networking mode: SYSTEM PROXY (no admin, no TUN). xray exposes a local
// HTTP+SOCKS inbound; we point the Windows system proxy at the HTTP inbound.
// Apps that honour the system proxy (browsers, most desktop apps) go through it.

const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Resource resolution ──────────────────────────────────────────────────────
// In dev, resources live in desktop/resources. When packaged by electron-builder
// (extraResources), they land in process.resourcesPath.
function resourcesDir() {
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, 'xray')
    : null;
  if (packaged && fs.existsSync(path.join(packaged, xrayExeName()))) return packaged;
  return path.join(__dirname, 'resources');
}
function xrayExeName() {
  return process.platform === 'win32' ? 'xray.exe' : 'xray';
}
function xrayPath() {
  return path.join(resourcesDir(), xrayExeName());
}
function mihomoExeName() {
  return process.platform === 'win32' ? 'mihomo.exe' : 'mihomo';
}
function mihomoPath() {
  return path.join(resourcesDir(), mihomoExeName());
}

// ── State ────────────────────────────────────────────────────────────────────
// Предпочтительные (исторические) локальные порты: к ним могут быть привязаны внешние
// приложения, поэтому берём их, пока свободны. Если порт занят чужим процессом —
// запуск берёт свободный (см. pickPorts) вместо ошибки «port busy».
const HTTP_PORT = 12334; // xray system-proxy HTTP inbound
const SOCKS_PORT = 12335; // xray SOCKS inbound (apps that prefer SOCKS)
const MIXED_PORT = 12336; // mihomo mixed (HTTP+SOCKS) inbound for the system proxy
let xrayProc = null;
let mihomoProc = null;     // второе ядро (mihomo/Clash.Meta) для hysteria/tuic/anytls/…
let activeCore = 'xray';   // какое ядро сейчас поднято: 'xray' | 'mihomo'
let activeProxyPort = HTTP_PORT; // порт, на который указывает системный прокси
let connected = false;
let startedAt = 0;
let lastError = '';
const logBuf = [];
let totalUp = 0;
let totalDown = 0;

// ── Log file ─────────────────────────────────────────────────────────────────
// Файл раньше рос бесконечно. Теперь при превышении лимита он переезжает в .old
// (хранится одно поколение): проверка на старте и раз в LOG_CHECK_EVERY записей.
const LOG_FILE = path.join(os.tmpdir(), 'simproxy-bridge.log');
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_CHECK_EVERY = 200;
let logWrites = 0;
function rotateLogIfNeeded() {
  try {
    if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
  } catch (_) { /* файла ещё нет / занят — не критично */ }
}
rotateLogIfNeeded();
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logBuf.push(line);
  if (logBuf.length > 500) logBuf.shift();
  console.log(line);
  if (++logWrites % LOG_CHECK_EVERY === 0) rotateLogIfNeeded();
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ── Запуск внешних утилит (reg / powershell / ipconfig) ──────────────────────
// Главный процесс Electron обслуживает и окно, и IPC. Долгий spawnSync (PowerShell
// стартует секунду и больше, без таймаута мог зависнуть навсегда) морозит всё
// приложение, поэтому на «горячих» путях (подключение/отключение) используем
// runAsync, а синхронный runSync — только при выходе, где ждать надо, и всегда
// с таймаутом.
const { execFile, spawnSync } = require('child_process');

function runAsync(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err && typeof err.code === 'number' ? err.code : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function runSync(cmd, args, timeout = 6000) {
  try {
    const r = spawnSync(cmd, args, { windowsHide: true, timeout, encoding: 'utf8' });
    return { ok: r.status === 0 && !r.error, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e) {
    return { ok: false, code: -1, stdout: '', stderr: String(e) };
  }
}

// Файлы с ключами доступа (UUID/пароли серверов) не должны оставаться в %TEMP%.
function rmQuiet(p) {
  if (!p) return;
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* занят/нет — не критично */ }
}

// Сериализация операций подключения/отключения: два одновременных startVpn (двойной
// клик, авто-коннект + ручной) не должны гоняться за портами и системным прокси.
let opChain = Promise.resolve();
function serialize(fn) {
  const p = opChain.then(fn, fn);
  opChain = p.catch(() => {});
  return p;
}

// ── Config adaptation ────────────────────────────────────────────────────────
// The renderer builds an Android-oriented config (TUN inbound + socks-in). For
// the desktop core we strip TUN and expose HTTP+SOCKS inbounds on localhost.
// ports = { http, socks, api } — локальные порты этой сессии (api — для статистики).
function adaptConfig(rawConfig, ports) {
  let cfg;
  try {
    cfg = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig;
  } catch (e) {
    throw new Error('bad config json: ' + e.message);
  }
  const inbounds = (cfg.inbounds || []).filter(
    (i) => i && i.protocol !== 'tun' && i.protocol !== 'dokodemo-door' && i.tag !== 'api'
  );

  // SOCKS inbound (reuse existing if present)
  let socks = inbounds.find((i) => i.protocol === 'socks');
  if (!socks) {
    socks = { tag: 'socks-in', protocol: 'socks', listen: '127.0.0.1', settings: {} };
    inbounds.push(socks);
  }
  socks.listen = '127.0.0.1';
  socks.port = ports.socks;
  socks.settings = { ...(socks.settings || {}), udp: true, auth: 'noauth' };

  // HTTP inbound for the Windows system proxy
  let httpIn = inbounds.find((i) => i.protocol === 'http');
  if (!httpIn) {
    httpIn = { tag: 'http-in', protocol: 'http', listen: '127.0.0.1', settings: {} };
    inbounds.push(httpIn);
  }
  httpIn.listen = '127.0.0.1';
  httpIn.port = ports.http;

  cfg.inbounds = inbounds;

  // metrics конфликтует со stats-feature xray-core → "panic: Reuse of exported var name: stats"
  // → SIGABRT → «ошибка ядра» на Windows / краш на Android. Убираем — это серверный
  // Prometheus-endpoint, клиенту не нужен.
  delete cfg.metrics;

  // Stats API so getStats can report traffic (optional but nice).
  cfg.stats = cfg.stats || {};
  cfg.policy = cfg.policy || {};
  cfg.policy.system = {
    ...(cfg.policy.system || {}),
    statsInboundUplink: true,
    statsInboundDownlink: true,
  };

  // Subscription configs often reference geosite:category-*-ru and other custom
  // categories absent from the standard geosite.dat shipped with Xray releases.
  // Xray 26.x rejects the WHOLE config on the first missing category ("EOF"), so
  // strip any geosite:category- entries from domain arrays before validation.
  // Standard entries (geosite:cn, geosite:geolocation-!cn, geosite:google, …) are
  // kept — they exist in the bundled dat. For a system-proxy desktop client
  // geo-routing is nice-to-have, so losing custom RU-category rules is acceptable.
  if (cfg.routing && Array.isArray(cfg.routing.rules)) {
    cfg.routing.rules.forEach((r) => {
      if (r && Array.isArray(r.domain)) {
        r.domain = r.domain.filter((d) => !/^geosite:category-/i.test(String(d)));
        if (!r.domain.length) delete r.domain;
      }
    });
  }

  // Safety net: drop routing rules with no effective matcher fields. Xray-core 26.x
  // rejects the WHOLE config on start if any rule has only an outboundTag/balancerTag
  // and nothing to match on ("app/router: this rule has no effective fields") — the
  // core never binds its ports and the connection reports not_running. Subscriptions'
  // metrics route ({ inboundTag:["metrics_out"], outboundTag:"metrics_out" }) becomes
  // empty once the renderer strips inboundTag; this guards against that and any other
  // source of degenerate rules, regardless of which code path built the config.
  if (cfg.routing && Array.isArray(cfg.routing.rules)) {
    const MATCHERS = ['domain', 'ip', 'port', 'sourcePort', 'network', 'protocol',
      'inboundTag', 'source', 'user', 'attrs'];
    cfg.routing.rules = cfg.routing.rules.filter((r) => {
      if (!r || typeof r !== 'object') return false;
      return MATCHERS.some((k) => {
        const v = r[k];
        return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
      });
    });
  }

  // Локальный Stats API: по нему getStats() читает счётчики трафика. Слушает только
  // 127.0.0.1 на свободном порту. Правило маршрутизации — первым, чтобы запросы к API
  // не попали ни в одно пользовательское правило. Собственный трафик API считается в
  // inbound>>>api>>>… — при подсчёте он исключается (см. queryXrayTraffic).
  cfg.api = { tag: 'api', services: ['StatsService'] };
  cfg.inbounds.push({
    tag: 'api', listen: '127.0.0.1', port: ports.api, protocol: 'dokodemo-door',
    settings: { address: '127.0.0.1' },
  });
  cfg.routing = cfg.routing || {};
  cfg.routing.rules = Array.isArray(cfg.routing.rules) ? cfg.routing.rules : [];
  cfg.routing.rules.unshift({ type: 'field', inboundTag: ['api'], outboundTag: 'api' });

  if (!cfg.log) cfg.log = { loglevel: 'warning' };
  return cfg;
}

// ── xray process lifecycle ───────────────────────────────────────────────────
function writeTempConfig(cfg) {
  const p = path.join(os.tmpdir(), `simproxy-desktop-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return p;
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = () => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => {
        s.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function waitPortsFree(ports, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = await Promise.all(ports.map(isPortFree));
    if (states.every(Boolean)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Kill orphaned cores WE spawned (identified by our temp config / home dir name:
// 'simproxy-desktop' for xray, 'simproxy-mihomo' for mihomo) that survived a
// crash/force-kill of the app. Prevents "port already in use" on the next connect —
// the #1 cause of a silent "no internet" after a reconnect. Один запуск PowerShell
// на оба ядра (раньше было два — по одному на каждое).
const KILL_STRAY_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  "Get-CimInstance Win32_Process -Filter \"name='xray.exe' or name='mihomo.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*simproxy-desktop*' -or $_.CommandLine -like '*simproxy-mihomo*' } | " +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
];
async function killStrayCores() {
  if (process.platform !== 'win32') return;
  await runAsync('powershell', KILL_STRAY_ARGS, 8000);
}
function killStrayCoresSync() {
  if (process.platform !== 'win32') return;
  runSync('powershell', KILL_STRAY_ARGS, 6000);
}

// ── Core detection (xray JSON vs mihomo/Clash) ───────────────────────────────
// Рендерер сам выбирает ядро (см. shouldUseMihomo): hysteria/hysteria2/tuic/anytls/
// shadowtls/naive и Clash-YAML идут на mihomo, остальное (vless/vmess/trojan/ss/wg)
// — на xray. Конфиг mihomo узнаём по `proxies`/`mixed-port` (или YAML-маркерам);
// конфиг xray — по `outbounds`.
function looksLikeMihomo(str) {
  if (typeof str !== 'string') return false;
  if (/^\s*(mixed-port|socks-port|proxies|proxy-groups)\s*:/m.test(str)) return true; // YAML
  try {
    const o = JSON.parse(str);
    if (o && typeof o === 'object' && !o.outbounds &&
        (Array.isArray(o.proxies) || o['mixed-port'] !== undefined || o['socks-port'] !== undefined)) {
      return true;
    }
  } catch (_) { /* not JSON */ }
  return false;
}

// Десктоп не использует TUN — гоним трафик через системный прокси (mixed-port).
// Из конфига убираем tun, фиксируем mixed-port, а fake-ip DNS меняем на redir-host
// (совместимее с HTTP-прокси, где хост резолвит само ядро).
// ports = { mixed, api, secret }: api/secret — REST-контроллер mihomo на 127.0.0.1 (по нему
// getStats() читает счётчики трафика); секрет случайный на сессию.
function adaptMihomoConfig(rawConfig, ports) {
  // JSON-конфиг от buildMihomoConfig — основной путь (share-link протоколы).
  try {
    const o = JSON.parse(rawConfig);
    delete o.tun;
    o['mixed-port'] = ports.mixed;
    o['bind-address'] = '127.0.0.1';
    o['allow-lan'] = false;
    o['external-controller'] = `127.0.0.1:${ports.api}`;
    o.secret = ports.secret;
    delete o['external-ui'];
    if (o.dns && o.dns['enhanced-mode'] === 'fake-ip') o.dns['enhanced-mode'] = 'redir-host';
    return { text: JSON.stringify(o, null, 2), port: ports.mixed };
  } catch (_) { /* не JSON — это сырой Clash-YAML */ }

  // Сырой Clash-YAML: best-effort. Если свой mixed-port есть — используем его и
  // выключаем TUN; иначе добавляем наш mixed-port сверху. Собственный контроллер и
  // секрет из YAML заменяем нашими (иначе статистика недоступна, а чужой контроллер
  // мог бы слушать не на localhost).
  let yaml = rawConfig.replace(/^[ \t]*tun:\s*\n(?:[ \t]+.*\n?)*/m, ''); // срезаем блок tun
  yaml = yaml.replace(/^(external-controller|external-ui|secret)\s*:.*\r?\n?/gm, '');
  const mp = yaml.match(/^\s*mixed-port\s*:\s*(\d+)/m);
  let port = ports.mixed;
  let head = `external-controller: 127.0.0.1:${ports.api}\nsecret: "${ports.secret}"\n`;
  if (mp) {
    port = parseInt(mp[1], 10);
  } else {
    head += `mixed-port: ${ports.mixed}\nbind-address: 127.0.0.1\nallow-lan: false\n`;
  }
  return { text: head + yaml, port };
}

// Порты для запуска: предпочтительные, а если заняты — свободные. Небольшое ожидание
// нужно, чтобы только что убитое ядро успело освободить сокет.
async function pickPorts(preferred, waitMs) {
  if (await waitPortsFree(preferred, waitMs)) return preferred.slice();
  const free = await Promise.all(preferred.map(isPortFree));
  const out = [];
  for (let i = 0; i < preferred.length; i++) out.push(free[i] ? preferred[i] : await getFreePort());
  log(`preferred ports ${preferred.join('/')} busy -> using ${out.join('/')}`);
  return out;
}

async function startMihomo(config, _settings) {
  const exe = mihomoPath();
  if (!fs.existsSync(exe)) {
    lastError = 'mihomo.exe not found at ' + exe;
    log(lastError);
    return { ok: false, error: lastError };
  }
  await killStrayCores();

  // Порт: наш предпочтительный, а если занят чужим процессом — свободный. Если YAML
  // сам закрепляет mixed-port, он остаётся как есть (занят — честная ошибка).
  const apiPortM = await getFreePort();
  const secret = crypto.randomBytes(16).toString('hex');
  let adapted = adaptMihomoConfig(config, { mixed: MIXED_PORT, api: apiPortM, secret });
  let port = adapted.port;
  if (!(await waitPortsFree([port], 2500))) {
    if (port !== MIXED_PORT) {
      lastError = `local port ${port} busy (another instance?)`;
      log(lastError);
      return { ok: false, error: lastError };
    }
    port = await getFreePort();
    log(`preferred port ${MIXED_PORT} busy -> using ${port}`);
    adapted = adaptMihomoConfig(config, { mixed: port, api: apiPortM, secret });
  }
  const { text } = adapted;

  // Рабочий каталог с маркером 'simproxy-mihomo' в имени — по нему killStrayCores
  // находит наши осиротевшие процессы. Конфиг содержит ключи серверов, поэтому
  // каталог удаляется при остановке (см. stopVpnCore) и при сбое запуска.
  const home = path.join(os.tmpdir(), `simproxy-mihomo-${Date.now()}`);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  activeTemp.push(home);
  const cfgPath = path.join(home, 'config.yaml');
  fs.writeFileSync(cfgPath, text, { encoding: 'utf8', mode: 0o600 });

  log('starting mihomo: ' + exe + ' -d ' + home + ' -f ' + cfgPath);
  let earlyExit = null;
  const tail = [];
  const keepTail = (s) => { tail.push(s); if (tail.length > 8) tail.shift(); };
  const proc = spawn(exe, ['-d', home, '-f', cfgPath], { windowsHide: true });
  mihomoProc = proc;
  proc.stdout.on('data', (d) => { const t = d.toString().trim(); keepTail(t); log('mihomo: ' + t); });
  proc.stderr.on('data', (d) => { const t = d.toString().trim(); keepTail(t); log('mihomo! ' + t); });
  proc.on('exit', (code) => onCoreExit('mihomo', proc, code, () => { if (!connected) earlyExit = code; }));

  const deadline = Date.now() + 12000;
  let up = false;
  while (Date.now() < deadline) {
    if (earlyExit !== null) {
      lastError = 'mihomo exited on start: ' + (tail.join(' | ') || 'code ' + earlyExit);
      log(lastError);
      await stopVpnCore();
      return { ok: false, error: lastError };
    }
    if (await waitForPort(port, 400)) { up = true; break; }
  }
  if (!up) {
    lastError = 'mihomo mixed-port did not open (see logs)';
    log(lastError);
    await stopVpnCore();
    return { ok: false, error: lastError };
  }

  // Ядро прочитало конфиг при старте — файл с ключами больше не нужен.
  rmQuiet(cfgPath);

  activeCore = 'mihomo';
  activeProxyPort = port;
  trafficApi = { port: apiPortM, secret };
  const proxyOk = await setSystemProxyAsync(true, `127.0.0.1:${port}`);
  if (!proxyOk || mihomoProc !== proc) {
    lastError = proxyOk ? 'mihomo exited right after start' : 'failed to set system proxy (see logs)';
    log(lastError);
    await stopVpnCore();
    return { ok: false, error: lastError };
  }
  connected = true;
  startedAt = Date.now();
  resetTraffic();
  lastError = '';
  log('connected (mihomo); system proxy -> 127.0.0.1:' + port);
  return { ok: true };
}

// ── Временные файлы сессии ───────────────────────────────────────────────────
// Конфиги ядер содержат ключи доступа (UUID/пароли серверов), поэтому лежат в
// %TEMP% только пока нужны: xray/mihomo читают конфиг при старте, после чего файл
// удаляется; остатки (каталог mihomo) чистит releaseTemp() при остановке.
let activeTemp = [];
function releaseTemp() {
  const list = activeTemp;
  activeTemp = [];
  list.forEach(rmQuiet);
  // Каталог только что убитого ядра Windows может подержать занятым — добиваем позже.
  if (list.length) setTimeout(() => list.forEach(rmQuiet), 2000).unref();
}

// Остатки прошлых запусков (жёсткое завершение приложения): вызывается при старте,
// когда наши ядра уже убиты.
function sweepTempArtifacts() {
  let names;
  try { names = fs.readdirSync(os.tmpdir()); } catch (_) { return; }
  for (const n of names) {
    if (/^simproxy-desktop(-ping)?-.*\.json$/.test(n) || /^simproxy-mihomo-\d+$/.test(n)) {
      rmQuiet(path.join(os.tmpdir(), n));
    }
  }
}

// Выход ядра. Различаем три случая:
//  1) ядро упало во время запуска — startVpn узнаёт об этом через markEarlyExit;
//  2) ядро остановили мы (stopVpnCore обнуляет ссылку заранее) или его уже заменило
//     новое — ничего не делаем, иначе старое событие exit сбросило бы состояние
//     нового ядра;
//  3) ядро упало при активном подключении — сразу снимаем системный прокси, чтобы
//     у пользователя не пропал интернет на всей машине, не дожидаясь опроса из UI.
function onCoreExit(name, proc, code, markEarlyExit) {
  log(name + ' exited code ' + code);
  if (markEarlyExit) markEarlyExit();
  const current = name === 'xray' ? xrayProc : mihomoProc;
  if (current !== proc) return;
  if (name === 'xray') xrayProc = null; else mihomoProc = null;
  const wasConnected = connected;
  connected = false;
  if (wasConnected) {
    log(name + ' died while connected -> clearing system proxy');
    setSystemProxyAsync(false).catch(() => {});
  }
}

async function startVpnCore(payload) {
  try {
    if (xrayProc || mihomoProc) await stopVpnCore();

    let config = payload;
    let _settings = {};
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object' && 'config' in parsed) {
        config = parsed.config;
        _settings = parsed.settings ? JSON.parse(parsed.settings) : {};
      }
    } catch (_) {
      /* payload was already a raw config string */
    }

    // Мульти-ядро: рендерер уже выбрал ядро (см. shouldUseMihomo в App.tsx) и
    // кладёт его в settings.core ('xray' | 'mihomo'). Доверяем явному выбору в
    // первую очередь — так на mihomo гарантированно уходят ВСЕ его протоколы
    // (hysteria/hysteria2/tuic/anytls/shadowtls/naive), даже если строковая
    // эвристика их не распознала. looksLikeMihomo остаётся запасным вариантом
    // для сырых Clash-YAML/JSON, где core не проставлен.
    const wantCore = String(_settings.core || '').toLowerCase();
    if (wantCore === 'mihomo' || (wantCore !== 'xray' && looksLikeMihomo(config))) {
      return await startMihomo(config, _settings);
    }

    // Битый конфиг отсекаем до убийства ядер и занятия портов (результат не нужен).
    adaptConfig(config, { http: 0, socks: 0, api: 0 });
    const exe = xrayPath();
    if (!fs.existsSync(exe)) {
      lastError = 'xray.exe not found at ' + exe;
      log(lastError);
      return { ok: false, error: lastError };
    }

    // Clear orphaned cores + make sure our ports are free, else the new xray
    // fails to bind and the connection silently has no internet. Если предпочтительные
    // порты заняты чужим процессом — берём свободные, а не падаем с «port busy».
    await killStrayCores();
    const [httpPort, socksPort] = await pickPorts([HTTP_PORT, SOCKS_PORT], 2500);
    const apiPort = await getFreePort();
    const cfg = adaptConfig(config, { http: httpPort, socks: socksPort, api: apiPort });
    const cfgPath = writeTempConfig(cfg);
    activeTemp.push(cfgPath);

    log('starting xray: ' + exe + ' -c ' + cfgPath);
    let earlyExit = null;
    const proc = spawn(exe, ['run', '-c', cfgPath], {
      env: { ...process.env, XRAY_LOCATION_ASSET: resourcesDir() },
      windowsHide: true,
    });
    xrayProc = proc;
    const tail = [];
    const keepTail = (s) => { tail.push(s); if (tail.length > 8) tail.shift(); };
    proc.stdout.on('data', (d) => { const t = d.toString().trim(); keepTail(t); log('xray: ' + t); });
    proc.stderr.on('data', (d) => { const t = d.toString().trim(); keepTail(t); log('xray! ' + t); });
    proc.on('exit', (code) => onCoreExit('xray', proc, code, () => { if (!connected) earlyExit = code; }));

    // Race port-open against process-exit: if xray dies first (bad config / port
    // bind / unreachable assets), report the real failure instead of a false ok.
    const deadline = Date.now() + 12000;
    let up = false;
    while (Date.now() < deadline) {
      if (earlyExit !== null) {
        lastError = 'xray exited on start: ' + (tail.join(' | ') || 'code ' + earlyExit);
        log(lastError);
        await stopVpnCore();
        return { ok: false, error: lastError };
      }
      if (await waitForPort(httpPort, 400)) { up = true; break; }
    }
    if (!up) {
      lastError = 'xray HTTP inbound did not open (see logs)';
      log(lastError);
      await stopVpnCore();
      return { ok: false, error: lastError };
    }

    // Ядро прочитало конфиг при старте — файл с ключами больше не нужен.
    rmQuiet(cfgPath);

    activeCore = 'xray';
    activeProxyPort = httpPort;
    trafficApi = { port: apiPort, secret: '' };
    const proxyOk = await setSystemProxyAsync(true, `127.0.0.1:${httpPort}`);
    if (!proxyOk || xrayProc !== proc) {
      // Либо реестр не записался (политика/права), либо ядро умерло, пока мы
      // ставили прокси: «подключено» без рабочего пути — хуже честной ошибки.
      lastError = proxyOk ? 'xray exited right after start' : 'failed to set system proxy (see logs)';
      log(lastError);
      await stopVpnCore();
      return { ok: false, error: lastError };
    }
    connected = true;
    startedAt = Date.now();
    resetTraffic();
    lastError = '';
    log('connected (xray); system proxy -> 127.0.0.1:' + httpPort);
    return { ok: true };
  } catch (e) {
    lastError = String(e && e.message ? e.message : e);
    log('startVpn error: ' + lastError);
    releaseTemp();
    return { ok: false, error: lastError };
  }
}

// Публичные операции идут через очередь (см. serialize): в каждый момент
// выполняется не больше одной операции подключения/отключения.
function startVpn(payload) { return serialize(() => startVpnCore(payload)); }
function stopVpn() { return serialize(stopVpnCore); }

function killCores() {
  const x = xrayProc;
  const m = mihomoProc;
  // Ссылки обнуляем ДО kill: обработчик exit по ним отличает штатную остановку.
  xrayProc = null;
  mihomoProc = null;
  if (x) { try { x.kill(); } catch (_) {} }
  if (m) { try { m.kill(); } catch (_) {} }
}

async function stopVpnCore() {
  connected = false;
  // Сначала снимаем системный прокси, потом гасим ядро — иначе трафик приложений
  // уйдёт в мёртвый порт.
  await setSystemProxyAsync(false);
  killCores();
  // Подстраховка: добиваем возможные осиротевшие ядра (оба) и сбрасываем DNS-кэш,
  // чтобы после отключения трафик гарантированно шёл напрямую, а не в мёртвый порт.
  await killStrayCores();
  releaseTemp();
  flushDnsAsync();
  log('disconnected');
  return true;
}

// Синхронная остановка — ТОЛЬКО для выхода из приложения (обработчики 'exit' не
// могут ждать промисы). Всё с таймаутами, чтобы завершение не зависало.
function stopVpnSync() {
  connected = false;
  disableSystemProxySync();
  killCores();
  killStrayCoresSync();
  releaseTemp();
  if (process.platform === 'win32') runSync('ipconfig', ['/flushdns'], 3000);
  log('disconnected (exit)');
  return true;
}

function flushDnsAsync() {
  if (process.platform !== 'win32') return;
  runAsync('ipconfig', ['/flushdns'], 4000); // результат не нужен — не ждём
}

// ── Windows system proxy (WinINET registry + refresh) ────────────────────────
const INET_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

// true, пока системный прокси выставлен НАМИ. Без этого «отключение» после неудачного
// запуска выключало бы и собственный прокси пользователя, который мы не трогали.
let systemProxyOwned = false;

// Наш прокси узнаём по маркеру в списке исключений ProxyOverride (несуществующий хост
// .invalid — на работу обхода не влияет). Раньше признаком были только фиксированные
// порты, и запуск на других портах сделал бы восстановление после аварии невозможным.
// Порты 12334/12336 (и активный) проверяем тоже — так подчищается и прокси, оставленный
// прежними версиями приложения.
const OUR_PROXY_MARKER = 'simproxy.invalid';

function parseInetValues(out) {
  const get = (name) => {
    const m = String(out).match(new RegExp('^\\s*' + name + '\\s+REG_\\w+\\s+(.*)$', 'im'));
    return m ? m[1].trim() : '';
  };
  return { server: get('ProxyServer'), override: get('ProxyOverride') };
}

// Проверяем, что системный прокси выставлен НАМИ, чтобы при отключении случайно не
// стереть собственный прокси пользователя. Принимает вывод `reg query` всего ключа.
function isOurProxyValue(out) {
  const { server, override } = parseInetValues(out);
  return (
    override.includes(OUR_PROXY_MARKER) ||
    server.includes(`127.0.0.1:${HTTP_PORT}`) ||
    server.includes(`127.0.0.1:${MIXED_PORT}`) ||
    server.includes(`127.0.0.1:${activeProxyPort}`)
  );
}

function proxyRegSteps(enable, server, deleteOurs) {
  const add = (name, type, data) => ({ args: ['add', INET_KEY, '/v', name, '/t', type, '/d', String(data), '/f'], required: true });
  const del = (name) => ({ args: ['delete', INET_KEY, '/v', name, '/f'], required: false });
  if (enable) {
    return [
      add('ProxyEnable', 'REG_DWORD', 1),
      add('ProxyServer', 'REG_SZ', server),
      add('ProxyOverride', 'REG_SZ', `<local>;${OUR_PROXY_MARKER}`), // Bypass local addresses + наш маркер
    ];
  }
  // Выключаем прокси И убираем НАШ адрес целиком. Если оставить ProxyServer
  // указывающим на 127.0.0.1:HTTP_PORT, после убийства ядра приложения
  // продолжают слать трафик в мёртвый порт = «нет интернета».
  const steps = [add('ProxyEnable', 'REG_DWORD', 0)];
  if (deleteOurs) steps.push(del('ProxyServer'), del('ProxyOverride'));
  return steps;
}

// Возвращает true, если состояние реестра соответствует запрошенному.
async function setSystemProxyAsync(enable, server, force = false) {
  if (process.platform !== 'win32') return true;
  if (!enable && !force && !systemProxyOwned) return true; // мы его не включали
  // При включении помечаем владение ДО записи: если запись оборвётся на полпути,
  // последующее отключение всё равно должно убрать частично записанные значения.
  if (enable) systemProxyOwned = true;
  try {
    let deleteOurs = false;
    if (!enable) {
      const q = await runAsync('reg', ['query', INET_KEY], 5000);
      deleteOurs = isOurProxyValue(q.stdout);
    }
    for (const s of proxyRegSteps(enable, server, deleteOurs)) {
      const r = await runAsync('reg', s.args, 5000);
      if (!r.ok && s.required) throw new Error(`reg ${s.args.join(' ')} -> ${r.code} ${r.stderr}`);
    }
    systemProxyOwned = enable;
    await refreshWinInetAsync();
    return true;
  } catch (e) {
    log('setSystemProxy failed: ' + e);
    if (!enable) {
      // Аварийно: при сбое всё равно пытаемся хотя бы выключить прокси и обновить,
      // чтобы не оставить машину без интернета.
      const r = await runAsync('reg', proxyRegSteps(false, null, false)[0].args, 5000);
      if (r.ok) { systemProxyOwned = false; await refreshWinInetAsync(); }
    }
    return false;
  }
}

function disableSystemProxySync() {
  if (process.platform !== 'win32' || !systemProxyOwned) return;
  const q = runSync('reg', ['query', INET_KEY], 4000);
  for (const s of proxyRegSteps(false, null, isOurProxyValue(q.stdout))) runSync('reg', s.args, 4000);
  systemProxyOwned = false;
  refreshWinInetSync();
}

// Notify WinINET that settings changed so apps pick it up without a restart.
const WININET_REFRESH_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `
$sig = @"
[System.Runtime.InteropServices.DllImport("wininet.dll", SetLastError=true)]
public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
"@
$t = Add-Type -MemberDefinition $sig -Name WinInet -Namespace Pinvoke -PassThru
[void]$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) # SETTINGS_CHANGED
[void]$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) # REFRESH
`.trim(),
];
async function refreshWinInetAsync() {
  if (process.platform !== 'win32') return;
  const r = await runAsync('powershell', WININET_REFRESH_ARGS, 10000);
  if (!r.ok) log('refreshWinInet failed: ' + r.stderr.trim().slice(0, 200));
}
function refreshWinInetSync() {
  if (process.platform !== 'win32') return;
  const r = runSync('powershell', WININET_REFRESH_ARGS, 8000);
  if (!r.ok) log('refreshWinInet failed: ' + r.stderr.trim().slice(0, 200));
}


// ── Stats ────────────────────────────────────────────────────────────────────
// Раньше трафик и скорости на десктопе всегда были нулями (API-inbound не настраивался),
// из-за чего виджеты были пустыми, а watchdog по замиранию байтов не работал. Теперь:
//  • xray — локальный Stats API, счётчики inbound>>>*>>>traffic>>>{uplink,downlink};
//  • mihomo — REST-контроллер на localhost, GET /connections → uploadTotal/downloadTotal.
// Скорость считается по разнице двух замеров.
let trafficApi = { port: 0, secret: '' };
let upSpeed = 0;
let downSpeed = 0;
let lastSample = null;       // { ts, up, down }
let lastTrafficAttempt = 0;  // время последней попытки (успешной или нет) — чтобы при сбое API не долбить его
let trafficRefreshing = null; // общий промис: параллельные getStats не плодят процессы
const TRAFFIC_STALE_MS = 2000;

function resetTraffic() {
  totalUp = 0;
  totalDown = 0;
  upSpeed = 0;
  downSpeed = 0;
  lastSample = null;
  lastTrafficAttempt = 0;
}

async function queryXrayTraffic() {
  const r = await runAsync(
    xrayPath(),
    ['api', 'statsquery', `--server=127.0.0.1:${trafficApi.port}`, '-pattern', 'inbound>>>'],
    3000
  );
  if (!r.ok) return null;
  let doc;
  try { doc = JSON.parse(r.stdout); } catch (_) { return null; }
  let up = 0;
  let down = 0;
  for (const s of Array.isArray(doc && doc.stat) ? doc.stat : []) {
    const m = /^inbound>>>(.+)>>>traffic>>>(uplink|downlink)$/.exec(String(s && s.name));
    if (!m || m[1] === 'api') continue; // собственный трафик Stats API не считаем
    const v = Number(s.value) || 0;      // при нуле поле value в ответе отсутствует
    if (m[2] === 'uplink') up += v; else down += v;
  }
  return { up, down };
}

function queryMihomoTraffic() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: trafficApi.port,
        path: '/connections',
        headers: { Authorization: 'Bearer ' + trafficApi.secret },
        timeout: 2500,
      },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = [];
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes > 5 * 1024 * 1024) { req.destroy(); return resolve(null); }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve({ up: Number(j.uploadTotal) || 0, down: Number(j.downloadTotal) || 0 });
          } catch (_) { resolve(null); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function refreshTraffic() {
  if (!connected || !trafficApi.port) return Promise.resolve();
  if (trafficRefreshing) return trafficRefreshing;
  const core = activeCore;
  lastTrafficAttempt = Date.now();
  trafficRefreshing = (async () => {
    try {
      const s = core === 'mihomo' ? await queryMihomoTraffic() : await queryXrayTraffic();
      if (!s || !connected) return;
      const now = Date.now();
      if (lastSample) {
        const dt = (now - lastSample.ts) / 1000;
        if (dt > 0) {
          upSpeed = Math.max(0, Math.round((s.up - lastSample.up) / dt));
          downSpeed = Math.max(0, Math.round((s.down - lastSample.down) / dt));
        }
      }
      lastSample = { ts: now, up: s.up, down: s.down };
      totalUp = s.up;
      totalDown = s.down;
    } catch (_) {
      /* статистика — best effort: при сбое остаются прошлые значения */
    } finally {
      trafficRefreshing = null;
    }
  })();
  return trafficRefreshing;
}

async function getStats() {
  if (connected && Date.now() - lastTrafficAttempt > TRAFFIC_STALE_MS) {
    await refreshTraffic();
  }
  const sec = connected ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  return {
    upload: totalUp,
    download: totalDown,
    uplinkSpeed: connected ? upSpeed : 0,
    downlinkSpeed: connected ? downSpeed : 0,
    connectedSec: sec,
    status: connected ? 'running' : 'not_running',
  };
}

// ── Ping ─────────────────────────────────────────────────────────────────────
function tcpPing(address, port, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const s = new net.Socket();
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (_) {}
      resolve(val);
    };
    s.setTimeout(timeout || 5000);
    s.once('connect', () => finish(Date.now() - start));
    s.once('timeout', () => finish(-1));
    s.once('error', () => finish(-1));
    s.connect(port, address);
  });
}

// Real "proxy delay": time a GET through the local proxy to a connectivity
// endpoint. Reflects true end-to-end internet through the tunnel (feeds the
// "Proxy Ping / Нет доступа в интернет" badge). Returns ms, or -1 on failure.
// Две независимые цели: сбой одного адреса (или одного выхода балансировщика на миг) не должен выглядеть
// как падение туннеля — по этому сигналу приложение перезапускает ядро.
async function proxyDelay(timeoutMs) {
  const first = await proxyDelayOnce('cp.cloudflare.com', timeoutMs);
  if (first > 0) return first;
  return proxyDelayOnce('connectivitycheck.gstatic.com', timeoutMs);
}

function proxyDelayOnce(host, timeoutMs) {
  return new Promise((resolve) => {
    if (!connected) return resolve(-1);
    const start = Date.now();
    const req = http.request(
      {
        host: '127.0.0.1',
        port: activeProxyPort,
        method: 'GET',
        path: `http://${host}/generate_204`,
        headers: { Host: host },
        timeout: timeoutMs || 8000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 400 ? Date.now() - start : -1);
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(-1); });
    req.on('error', () => resolve(-1));
    req.end();
  });
}

// Свободный эфемерный порт (OS назначает). Для временного ядра-измерителя, чтобы
// параллельные пинги серверного списка не дрались за один порт.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// Пинг «через прокси» при ВЫКЛЮЧЕННОМ VPN (зеркало libxray measureOutboundDelay на
// Android). Поднимаем временное xray-ядро из конфига ноды с локальным HTTP-входом,
// меряем GET через него до connectivity-эндпоинта и сразу гасим ядро. Так замер идёт
// тем же дайлером (REALITY/fragment/ws…), что и боевое соединение, и проходит DPI
// белого списка, где прямой TCP к серверу дропается. Возвращает мс или -1.
async function measureDelay(rawConfig, _url) {
  const exe = xrayPath();
  if (!fs.existsSync(exe)) return -1;

  let cfg;
  try { cfg = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig; }
  catch { return -1; }
  if (!cfg || !Array.isArray(cfg.outbounds) || !cfg.outbounds.length) return -1;

  let httpPort;
  try { httpPort = await getFreePort(); } catch { return -1; }

  // Вход — только наш HTTP на свободном порту (TUN/socks/dokodemo выкидываем).
  // outbounds/routing/dns ноды сохраняем как есть — цепочка идентична боевой.
  const inbounds = (cfg.inbounds || []).filter(
    (i) => i && i.protocol !== 'tun' && i.protocol !== 'dokodemo-door' && i.protocol !== 'socks'
  );
  inbounds.push({ tag: 'http-measure', protocol: 'http', listen: '127.0.0.1', port: httpPort, settings: {} });
  cfg.inbounds = inbounds;
  cfg.log = { loglevel: 'warning' };

  // Маркер 'simproxy-desktop' в имени → killStrayCores добьёт ядро, если приложение
  // упадёт прямо во время замера.
  const cfgPath = path.join(os.tmpdir(), `simproxy-desktop-ping-${Date.now()}-${httpPort}.json`);
  try { fs.writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8'); } catch { return -1; }

  let proc = null;
  try {
    proc = spawn(exe, ['run', '-c', cfgPath], {
      env: { ...process.env, XRAY_LOCATION_ASSET: resourcesDir() },
      windowsHide: true,
    });
    let exited = false;
    proc.on('exit', () => { exited = true; });
    if (proc.stdout) proc.stdout.on('data', () => {});
    if (proc.stderr) proc.stderr.on('data', () => {});

    const up = await waitForPort(httpPort, 6000);
    if (!up || exited) return -1;

    return await new Promise((resolve) => {
      const start = Date.now();
      const req = http.request(
        {
          host: '127.0.0.1',
          port: httpPort,
          method: 'GET',
          path: 'http://www.gstatic.com/generate_204',
          headers: { Host: 'www.gstatic.com' },
          timeout: 8000,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode >= 200 && res.statusCode < 400 ? Date.now() - start : -1);
        }
      );
      req.on('timeout', () => { req.destroy(); resolve(-1); });
      req.on('error', () => resolve(-1));
      req.end();
    });
  } catch {
    return -1;
  } finally {
    try { if (proc) proc.kill(); } catch (_) {}
    try { fs.unlinkSync(cfgPath); } catch (_) {}
  }
}

// ── HTTP fetch (subscriptions, DoH, etc.) ────────────────────────────────────
// Ограничения: только http(s); не больше FETCH_MAX_REDIRECTS переходов (раньше петля
// редиректов рекурсировала бесконечно); переход с https на http не допускается
// (подписка с токеном не должна утекать по открытому каналу); тело не больше
// FETCH_MAX_BYTES (раньше огромный ответ целиком копился в памяти главного процесса).
const FETCH_MAX_REDIRECTS = 5;
const FETCH_MAX_BYTES = 8 * 1024 * 1024;

// Наш User-Agent по умолчанию: Petrovich/<версия приложения>.
function defaultUserAgent() {
  let ver = '0';
  try { ver = require('electron').app.getVersion() || ver; } catch { /* вне Electron (тесты) */ }
  return 'Petrovich/' + ver;
}

function fetchUrl(url, userAgent, redirects = 0) {
  return new Promise((resolve) => {
    try {
      const u = new URL(String(url));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return resolve({ ok: false, error: 'unsupported protocol' });
      }
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(
        u,
        {
          headers: { 'User-Agent': userAgent || defaultUserAgent(), 'Accept-Encoding': 'identity' },
          timeout: 20000,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirects >= FETCH_MAX_REDIRECTS) return resolve({ ok: false, error: 'too many redirects' });
            let next;
            try { next = new URL(res.headers.location, u); } // Location может быть относительным
            catch (_) { return resolve({ ok: false, error: 'bad redirect' }); }
            if (u.protocol === 'https:' && next.protocol !== 'https:') {
              return resolve({ ok: false, error: 'redirect downgrades https to http' });
            }
            return fetchUrl(next.toString(), userAgent, redirects + 1).then(resolve);
          }
          const chunks = [];
          let bytes = 0;
          res.on('data', (c) => {
            bytes += c.length;
            if (bytes > FETCH_MAX_BYTES) {
              req.destroy();
              resolve({ ok: false, error: 'response too large' });
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const headers = {};
            for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({ ok: res.statusCode === 200, body, headers, error: res.statusCode === 200 ? undefined : 'HTTP ' + res.statusCode });
          });
        }
      );
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

// ── Core version ─────────────────────────────────────────────────────────────
function getCoreVersions() {
  const xrayV = new Promise((resolve) => {
    execFile(xrayPath(), ['version'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      let xray = 'unknown';
      if (!err && stdout) {
        const m = stdout.match(/Xray\s+([0-9.]+)/i);
        if (m) xray = m[1];
      }
      resolve(xray);
    });
  });
  const mihomoV = new Promise((resolve) => {
    if (!fs.existsSync(mihomoPath())) return resolve('-');
    execFile(mihomoPath(), ['-v'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      let mihomo = '-';
      if (!err && stdout) {
        const m = stdout.match(/(alpha-[0-9a-f]+|v?\d+\.\d+\.\d+)/i);
        if (m) mihomo = m[1];
      }
      resolve(mihomo);
    });
  });
  return Promise.all([xrayV, mihomoV]).then(([xray, mihomo]) => ({ xray, singbox: '-', mihomo }));
}

// Самообновление на desktop делает electron-updater в main.cjs: он сверяет sha512 из
// latest.yml и ставит обновление при выходе. Прежний путь «скачать любой .exe по URL из
// рендерера и молча запустить» удалён — без проверки хеша/подписи любая XSS в рендерере
// (contextIsolation выключен) превращалась в запуск произвольного кода.

// ── Dispatch table ───────────────────────────────────────────────────────────
// Methods the renderer may call. Unknown ones get a sane default in main.cjs.
const handlers = {
  startVpnWithResult: (payload) => startVpn(payload),
  startVpn: (payload) => startVpn(payload).then((r) => r.ok),
  stopVpn: () => stopVpn(),
  getVpnStatus: () => (connected ? 'connected' : 'disconnected'),
  getStats: () => getStats(),
  pingServer: (address, port, timeout) => tcpPing(address, port, timeout),
  // When connected: real GET through the live HTTP proxy.
  // When disconnected: spin up a temporary xray core from the config and measure
  // GET through it — same path as measureDelay, but called from the unified
  // nativePingProxy JS path (which replaced the split VPN-on/VPN-off logic).
  pingProxyServer: (configJson, _mode) => {
    if (connected) return proxyDelay(8000);
    return measureDelay(configJson, 'http://cp.cloudflare.com/generate_204');
  },
  // Пинг «через прокси» при выключенном VPN: временное ядро + GET через него.
  measureDelay: (config, url) => measureDelay(config, url),
  // На Android: резолвит домен сервера DoH-запросом сквозь живой SOCKS-тоннель.
  // На desktop Node.js резолвит DNS напрямую — handler не нужен, возвращаем ''.
  resolveHostViaProxy: () => '',
  warmupCore: () => {},
  fetchUrl: (url, ua) => fetchUrl(url, ua),
  getCoreVersions: () => getCoreVersions(),
  getLastError: () => lastError,
  getLogs: () => logBuf.join('\n'),
  testProxyDelay: () => proxyDelay(5000), // на каждую из двух целей
};

// Self-heal a previous crash / force-kill: a hard kill of the app bypasses
// stopVpn, leaving (a) an orphaned xray.exe / mihomo.exe, (b) the Windows system
// proxy still pointing at our now-dead 127.0.0.1:PORT — which breaks internet for
// the WHOLE machine until cleared — and (c) temp configs with server keys.
// Run this on startup. Идёт через очередь операций, и если ядро уже поднято (быстрый
// авто-коннект успел раньше) — ничего не делает, чтобы не убить свежий процесс.
function recoverFromCrash() {
  return serialize(async () => {
    if (xrayProc || mihomoProc || connected) return;
    await killStrayCores();
    sweepTempArtifacts();
    if (process.platform !== 'win32') return;
    try {
      const q = await runAsync('reg', ['query', INET_KEY], 5000);
      // Only clear if the stale proxy is OURS — never touch a user's own proxy.
      if (isOurProxyValue(q.stdout)) {
        log('recover: clearing stale system proxy from a previous crash');
        await setSystemProxyAsync(false, undefined, true);
      }
    } catch (e) {
      log('recoverFromCrash failed: ' + e);
    }
  });
}

module.exports = { handlers, stopVpn, stopVpnSync, recoverFromCrash };
