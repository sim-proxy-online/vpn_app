// Desktop "native" bridge for the Electron client.
// Mirrors the method surface the React renderer expects from window.SimNativeV2,
// but backed by a bundled xray.exe + the Windows system proxy (WinINET).
//
// v1 networking mode: SYSTEM PROXY (no admin, no TUN). xray exposes a local
// HTTP+SOCKS inbound; we point the Windows system proxy at the HTTP inbound.
// Apps that honour the system proxy (browsers, most desktop apps) go through it.

const { spawn } = require('child_process');
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

const LOG_FILE = path.join(os.tmpdir(), 'simproxy-bridge.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logBuf.push(line);
  if (logBuf.length > 500) logBuf.shift();
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ── Config adaptation ────────────────────────────────────────────────────────
// The renderer builds an Android-oriented config (TUN inbound + socks-in). For
// the desktop core we strip TUN and expose HTTP+SOCKS inbounds on localhost.
function adaptConfig(rawConfig) {
  let cfg;
  try {
    cfg = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig;
  } catch (e) {
    throw new Error('bad config json: ' + e.message);
  }
  const inbounds = (cfg.inbounds || []).filter(
    (i) => i && i.protocol !== 'tun' && i.protocol !== 'dokodemo-door'
  );

  // SOCKS inbound (reuse existing if present)
  let socks = inbounds.find((i) => i.protocol === 'socks');
  if (!socks) {
    socks = { tag: 'socks-in', protocol: 'socks', listen: '127.0.0.1', settings: {} };
    inbounds.push(socks);
  }
  socks.listen = '127.0.0.1';
  socks.port = SOCKS_PORT;
  socks.settings = { ...(socks.settings || {}), udp: true, auth: 'noauth' };

  // HTTP inbound for the Windows system proxy
  let httpIn = inbounds.find((i) => i.protocol === 'http');
  if (!httpIn) {
    httpIn = { tag: 'http-in', protocol: 'http', listen: '127.0.0.1', settings: {} };
    inbounds.push(httpIn);
  }
  httpIn.listen = '127.0.0.1';
  httpIn.port = HTTP_PORT;

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

// Kill orphaned xray cores WE spawned (identified by our temp config name) that
// survived a crash/force-kill of the app. Prevents "port already in use" on the
// next connect — the #1 cause of a silent "no internet" after a reconnect.
function killStrayXray() {
  if (process.platform !== 'win32') return;
  try {
    const { spawnSync } = require('child_process');
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"name='xray.exe'\" | " +
          "Where-Object { $_.CommandLine -like '*simproxy-desktop*' } | " +
          'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
      ],
      { windowsHide: true, timeout: 6000 }
    );
  } catch (_) {}
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

// Чистим осиротевшие mihomo-ядра, поднятые НАМИ (по нашему temp-каталогу конфига).
function killStrayMihomo() {
  if (process.platform !== 'win32') return;
  try {
    const { spawnSync } = require('child_process');
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='mihomo.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*simproxy-mihomo*' } | " +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    ], { windowsHide: true, timeout: 6000 });
  } catch (_) {}
}

// Десктоп не использует TUN — гоним трафик через системный прокси (mixed-port).
// Из конфига убираем tun, фиксируем mixed-port, а fake-ip DNS меняем на redir-host
// (совместимее с HTTP-прокси, где хост резолвит само ядро).
function adaptMihomoConfig(rawConfig) {
  // JSON-конфиг от buildMihomoConfig — основной путь (share-link протоколы).
  try {
    const o = JSON.parse(rawConfig);
    delete o.tun;
    o['mixed-port'] = MIXED_PORT;
    o['bind-address'] = '127.0.0.1';
    o['allow-lan'] = false;
    o['external-controller'] = '';
    if (o.dns && o.dns['enhanced-mode'] === 'fake-ip') o.dns['enhanced-mode'] = 'redir-host';
    return { text: JSON.stringify(o, null, 2), port: MIXED_PORT };
  } catch (_) { /* не JSON — это сырой Clash-YAML */ }

  // Сырой Clash-YAML: best-effort. Если свой mixed-port есть — используем его и
  // выключаем TUN; иначе добавляем наш mixed-port сверху.
  let yaml = rawConfig.replace(/^[ \t]*tun:\s*\n(?:[ \t]+.*\n?)*/m, ''); // срезаем блок tun
  const mp = yaml.match(/^\s*mixed-port\s*:\s*(\d+)/m);
  let port = MIXED_PORT;
  if (mp) {
    port = parseInt(mp[1], 10);
  } else {
    yaml = `mixed-port: ${MIXED_PORT}\nbind-address: 127.0.0.1\nallow-lan: false\n` + yaml;
  }
  return { text: yaml, port };
}

async function startMihomo(config, _settings) {
  const exe = mihomoPath();
  if (!fs.existsSync(exe)) {
    lastError = 'mihomo.exe not found at ' + exe;
    log(lastError);
    return { ok: false, error: lastError };
  }
  const { text, port } = adaptMihomoConfig(config);

  // Рабочий каталог с маркером 'simproxy-mihomo' в имени — по нему killStrayMihomo
  // находит наши осиротевшие процессы.
  const home = path.join(os.tmpdir(), `simproxy-mihomo-${Date.now()}`);
  fs.mkdirSync(home, { recursive: true });
  const cfgPath = path.join(home, 'config.yaml');
  fs.writeFileSync(cfgPath, text, 'utf8');

  killStrayMihomo();
  const free = await waitPortsFree([port], 4000);
  if (!free) {
    lastError = `local port ${port} busy (another instance?)`;
    log(lastError);
    return { ok: false, error: lastError };
  }

  log('starting mihomo: ' + exe + ' -d ' + home + ' -f ' + cfgPath);
  let earlyExit = null;
  const tail = [];
  const keepTail = (s) => { tail.push(s); if (tail.length > 8) tail.shift(); };
  mihomoProc = spawn(exe, ['-d', home, '-f', cfgPath], { windowsHide: true });
  mihomoProc.stdout.on('data', (d) => { const t = d.toString().trim(); keepTail(t); log('mihomo: ' + t); });
  mihomoProc.stderr.on('data', (d) => { const t = d.toString().trim(); keepTail(t); log('mihomo! ' + t); });
  mihomoProc.on('exit', (code) => {
    log('mihomo exited code ' + code);
    if (!connected) earlyExit = code;
    mihomoProc = null;
    connected = false;
  });

  const deadline = Date.now() + 12000;
  let up = false;
  while (Date.now() < deadline) {
    if (earlyExit !== null) {
      lastError = 'mihomo exited on start: ' + (tail.join(' | ') || 'code ' + earlyExit);
      log(lastError);
      await stopVpn();
      return { ok: false, error: lastError };
    }
    if (await waitForPort(port, 400)) { up = true; break; }
  }
  if (!up) {
    lastError = 'mihomo mixed-port did not open (see logs)';
    log(lastError);
    await stopVpn();
    return { ok: false, error: lastError };
  }

  activeCore = 'mihomo';
  activeProxyPort = port;
  setSystemProxy(true, `127.0.0.1:${port}`);
  connected = true;
  startedAt = Date.now();
  totalUp = 0;
  totalDown = 0;
  lastError = '';
  log('connected (mihomo); system proxy -> 127.0.0.1:' + port);
  return { ok: true };
}

async function startVpn(payload) {
  try {
    if (xrayProc || mihomoProc) await stopVpn();

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

    const cfg = adaptConfig(config);
    const cfgPath = writeTempConfig(cfg);
    const exe = xrayPath();
    if (!fs.existsSync(exe)) {
      lastError = 'xray.exe not found at ' + exe;
      log(lastError);
      return { ok: false, error: lastError };
    }

    // Clear orphaned cores + make sure our ports are free, else the new xray
    // fails to bind and the connection silently has no internet.
    killStrayXray();
    const free = await waitPortsFree([HTTP_PORT, SOCKS_PORT], 4000);
    if (!free) {
      lastError = `local ports ${HTTP_PORT}/${SOCKS_PORT} busy (another instance?)`;
      log(lastError);
      return { ok: false, error: lastError };
    }

    log('starting xray: ' + exe + ' -c ' + cfgPath);
    let earlyExit = null;
    xrayProc = spawn(exe, ['run', '-c', cfgPath], {
      env: { ...process.env, XRAY_LOCATION_ASSET: resourcesDir() },
      windowsHide: true,
    });
    const tail = [];
    const keepTail = (s) => { tail.push(s); if (tail.length > 8) tail.shift(); };
    xrayProc.stdout.on('data', (d) => { const t = d.toString().trim(); keepTail(t); log('xray: ' + t); });
    xrayProc.stderr.on('data', (d) => { const t = d.toString().trim(); keepTail(t); log('xray! ' + t); });
    xrayProc.on('exit', (code) => {
      log('xray exited code ' + code);
      if (!connected) earlyExit = code;
      xrayProc = null;
      connected = false;
    });

    // Race port-open against process-exit: if xray dies first (bad config / port
    // bind / unreachable assets), report the real failure instead of a false ok.
    const deadline = Date.now() + 12000;
    let up = false;
    while (Date.now() < deadline) {
      if (earlyExit !== null) {
        lastError = 'xray exited on start: ' + (tail.join(' | ') || 'code ' + earlyExit);
        log(lastError);
        await stopVpn();
        return { ok: false, error: lastError };
      }
      if (await waitForPort(HTTP_PORT, 400)) { up = true; break; }
    }
    if (!up) {
      lastError = 'xray HTTP inbound did not open (see logs)';
      log(lastError);
      await stopVpn();
      return { ok: false, error: lastError };
    }

    activeCore = 'xray';
    activeProxyPort = HTTP_PORT;
    setSystemProxy(true, `127.0.0.1:${HTTP_PORT}`);
    connected = true;
    startedAt = Date.now();
    totalUp = 0;
    totalDown = 0;
    lastError = '';
    log('connected (xray); system proxy -> 127.0.0.1:' + HTTP_PORT);
    return { ok: true };
  } catch (e) {
    lastError = String(e && e.message ? e.message : e);
    log('startVpn error: ' + lastError);
    return { ok: false, error: lastError };
  }
}

async function stopVpn() {
  setSystemProxy(false);
  connected = false;
  if (xrayProc) {
    try {
      xrayProc.kill();
    } catch (_) {}
    xrayProc = null;
  }
  if (mihomoProc) {
    try {
      mihomoProc.kill();
    } catch (_) {}
    mihomoProc = null;
  }
  // Подстраховка: добиваем возможные осиротевшие ядра (оба) и сбрасываем DNS-кэш,
  // чтобы после отключения трафик гарантированно шёл напрямую, а не в мёртвый порт.
  killStrayXray();
  killStrayMihomo();
  flushDns();
  log('disconnected');
  return true;
}

function flushDns() {
  if (process.platform !== 'win32') return;
  try {
    require('child_process').spawnSync('ipconfig', ['/flushdns'], { windowsHide: true, timeout: 4000 });
  } catch (_) {}
}

// ── Windows system proxy (WinINET registry + refresh) ────────────────────────
function setSystemProxy(enable, server) {
  if (process.platform !== 'win32') return;
  const base =
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  try {
    if (enable) {
      runSync('reg', ['add', base, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
      runSync('reg', ['add', base, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', server, '/f']);
      // Bypass local addresses
      runSync('reg', ['add', base, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', '<local>', '/f']);
    } else {
      // Выключаем прокси И убираем НАШ адрес целиком. Если оставить ProxyServer
      // указывающим на 127.0.0.1:HTTP_PORT, после убийства xray приложения
      // продолжают слать трафик в мёртвый порт = «нет интернета».
      runSync('reg', ['add', base, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
      if (proxyServerIsOurs(base)) {
        try { runSync('reg', ['delete', base, '/v', 'ProxyServer', '/f']); } catch (_) {}
        try { runSync('reg', ['delete', base, '/v', 'ProxyOverride', '/f']); } catch (_) {}
      }
    }
    refreshWinInet();
  } catch (e) {
    log('setSystemProxy failed: ' + e);
    // Аварийно: при сбое всё равно пытаемся хотя бы выключить прокси и обновить,
    // чтобы не оставить машину без интернета.
    if (!enable) {
      try {
        runSync('reg', ['add', base, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
        refreshWinInet();
      } catch (_) {}
    }
  }
}

// Проверяет, что текущий системный прокси выставлен НАМИ (наш локальный порт),
// чтобы при отключении случайно не стереть собственный прокси пользователя.
function proxyServerIsOurs(base) {
  try {
    const { spawnSync } = require('child_process');
    const q = spawnSync('reg', ['query', base, '/v', 'ProxyServer'], { windowsHide: true, encoding: 'utf8' });
    const out = q.stdout || '';
    return out.includes(`127.0.0.1:${HTTP_PORT}`) || out.includes(`127.0.0.1:${MIXED_PORT}`);
  } catch (_) {
    return false;
  }
}

function runSync(cmd, args) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(cmd, args, { windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} -> ${r.status} ${r.stderr}`);
  }
}

// Notify WinINET that settings changed so apps pick it up without a restart.
function refreshWinInet() {
  if (process.platform !== 'win32') return;
  const ps = `
$sig = @"
[System.Runtime.InteropServices.DllImport("wininet.dll", SetLastError=true)]
public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
"@
$t = Add-Type -MemberDefinition $sig -Name WinInet -Namespace Pinvoke -PassThru
[void]$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) # SETTINGS_CHANGED
[void]$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) # REFRESH
`.trim();
  try {
    const { spawnSync } = require('child_process');
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
    });
  } catch (e) {
    log('refreshWinInet failed: ' + e);
  }
}

// ── Stats ────────────────────────────────────────────────────────────────────
function queryStat(name) {
  return new Promise((resolve) => {
    const exe = xrayPath();
    const { execFile } = require('child_process');
    execFile(
      exe,
      ['api', 'statsquery', `--server=127.0.0.1:${HTTP_PORT + 1000}`, '-pattern', name],
      { windowsHide: true, timeout: 2000 },
      () => resolve(0) // stats API needs an api inbound; best-effort, default 0
    );
  });
}

async function getStats() {
  const sec = connected ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  return {
    upload: totalUp,
    download: totalDown,
    uplinkSpeed: 0,
    downlinkSpeed: 0,
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
function proxyDelay(timeoutMs) {
  return new Promise((resolve) => {
    if (!connected) return resolve(-1);
    const start = Date.now();
    const req = http.request(
      {
        host: '127.0.0.1',
        port: activeProxyPort,
        method: 'GET',
        path: 'http://cp.cloudflare.com/generate_204',
        headers: { Host: 'cp.cloudflare.com' },
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

  // Маркер 'simproxy-desktop' в имени → killStrayXray добьёт ядро, если приложение
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
function fetchUrl(url, userAgent) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(
        url,
        {
          headers: { 'User-Agent': userAgent || 'v2rayNG/1.8.19', 'Accept-Encoding': 'identity' },
          timeout: 20000,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return fetchUrl(res.headers.location, userAgent).then(resolve);
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            const headers = {};
            for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
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
  const { execFile } = require('child_process');
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

// ── Самообновление (download .exe installer + run) ───────────────────────────
// На Windows «обновление» = скачать NSIS-инсталлятор (SimProxy-Setup-X.Y.Z.exe) и
// запустить его, затем закрыть приложение, чтобы установщик заменил файлы. Прогресс
// отдаём в renderer тем же событием 'update-progress', что и Android-слой.
let progressSender = null; // (pct:number) => void — выставляется из main.cjs
function setProgressSender(fn) { progressSender = fn; }
function emitProgress(pct) { try { if (progressSender) progressSender(pct); } catch (_) {} }

let lastDownloadedInstaller = null;

function downloadFile(url, destPath, onProgress, redirects) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'SimProxy-Desktop' } }, (res) => {
      // GitHub release-ассеты отдаются через 302-редиректы на CDN.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((redirects || 0) > 5) return reject(new Error('too many redirects'));
        return downloadFile(res.headers.location, destPath, onProgress, (redirects || 0) + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      let lastPct = -1;
      const out = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0 && onProgress) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(destPath)));
      out.on('error', (e) => { try { fs.unlinkSync(destPath); } catch (_) {} reject(e); });
    });
    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(new Error('download timeout')); });
  });
}

function runInstaller(exePath) {
  // Тихое обновление «внутри», без мастера установки (как electron-updater):
  //   /S          — silent-режим NSIS: файлы заменяются молча, без окон «Далее».
  //   --force-run — после установки сразу перезапустить приложение.
  // Запускаем отделённым процессом и закрываем текущий экземпляр, чтобы NSIS мог
  // перезаписать занятые .exe (электрон-builder NSIS дожидается выхода процесса).
  const child = spawn(exePath, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  setTimeout(() => {
    try { require('electron').app.quit(); } catch (_) {}
  }, 1500);
}

async function downloadAndInstallExe(url) {
  if (!url) return { ok: false, status: 'not_native', error: 'no download url' };
  try {
    const dest = path.join(os.tmpdir(), `SimProxy-Update-${Date.now()}.exe`);
    emitProgress(0);
    await downloadFile(url, dest, (pct) => emitProgress(pct));
    emitProgress(100);
    lastDownloadedInstaller = dest;
    log('update: downloaded installer -> ' + dest + ', launching');
    runInstaller(dest);
    return { ok: true, status: 'installing' };
  } catch (e) {
    const err = String(e && e.message ? e.message : e);
    log('update download/install failed: ' + err);
    return { ok: false, status: 'not_native', error: err };
  }
}

function installDownloadedExe() {
  if (lastDownloadedInstaller && fs.existsSync(lastDownloadedInstaller)) {
    runInstaller(lastDownloadedInstaller);
    return { ok: true, status: 'installing' };
  }
  return { ok: false, status: 'not_native', error: 'no downloaded installer' };
}

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
  testProxyDelay: () => proxyDelay(8000),
  // Самообновление: на desktop url ведёт на .exe-инсталлятор (см. pickAssetUrl).
  downloadAndInstallApk: (url) => downloadAndInstallExe(url),
  installDownloadedApk: () => installDownloadedExe(),
};

// Self-heal a previous crash / force-kill: a hard kill of the app bypasses
// stopVpn, leaving (a) an orphaned xray.exe and (b) the Windows system proxy
// still pointing at our now-dead 127.0.0.1:HTTP_PORT — which breaks internet for
// the WHOLE machine until cleared. Run this on startup.
function recoverFromCrash() {
  killStrayXray();
  killStrayMihomo();
  if (process.platform !== 'win32') return;
  try {
    const { spawnSync } = require('child_process');
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const q = spawnSync('reg', ['query', base, '/v', 'ProxyServer'], { windowsHide: true, encoding: 'utf8' });
    const out = (q.stdout || '');
    // Only clear if the stale proxy is OURS — never touch a user's own proxy.
    if (out.includes(`127.0.0.1:${HTTP_PORT}`) || out.includes(`127.0.0.1:${MIXED_PORT}`)) {
      log('recover: clearing stale system proxy from a previous crash');
      setSystemProxy(false);
    }
  } catch (e) {
    log('recoverFromCrash failed: ' + e);
  }
}

module.exports = { handlers, stopVpn, recoverFromCrash, setProgressSender };
