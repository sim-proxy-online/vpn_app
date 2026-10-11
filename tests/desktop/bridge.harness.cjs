// Изолированный прогон desktop/bridge.cjs: child_process подменён (реестр, PowerShell,
// ядра xray), реальны только порты, временные файлы и HTTP. Ничего системного не трогает.
// Запуск: npm run test:desktop (нужна Windows: мост управляет WinINET-прокси только там).
// Требует свободных локальных портов 12334/12335 — закройте SimProxy перед запуском.
const assert = require('assert');
const cp = require('child_process');
const { EventEmitter } = require('events');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'win32') {
  console.log('SKIP: тест моста имеет смысл только на Windows (WinINET-прокси)');
  process.exit(0);
}

// ── фейковый реестр ──
const reg = { ProxyEnable: 0, ProxyServer: undefined, ProxyOverride: undefined };
const calls = [];           // все вызовы внешних утилит
let killStrayCalls = 0;
const isKillStray = (cmd, args) => cmd === 'powershell' && String(args[args.length - 1]).includes('Stop-Process');

function fakeRun(cmd, args) {
  calls.push([cmd, ...args]);
  if (isKillStray(cmd, args)) { killStrayCalls++; return { code: 0, out: '' }; }
  if (cmd === 'reg') {
    const [op, , , name, , , , data] = args; // add KEY /v NAME /t TYPE /d DATA /f
    if (op === 'query') { // весь ключ Internet Settings
      const lines = ['HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        `    ProxyEnable    REG_DWORD    0x${reg.ProxyEnable}`];
      if (reg.ProxyServer !== undefined) lines.push(`    ProxyServer    REG_SZ    ${reg.ProxyServer}`);
      if (reg.ProxyOverride !== undefined) lines.push(`    ProxyOverride    REG_SZ    ${reg.ProxyOverride}`);
      return { code: 0, out: lines.join('\r\n') + '\r\n' };
    }
    if (op === 'add') { reg[name] = name === 'ProxyEnable' ? Number(data) : data; return { code: 0, out: '' }; }
    if (op === 'delete') { reg[name] = undefined; return { code: 0, out: '' }; }
  }
  return { code: 0, out: '' };
}
cp.execFile = (cmd, args, opts, cb) => {
  const r = fakeRun(cmd, args);
  const err = r.code ? Object.assign(new Error('fail'), { code: r.code }) : null;
  setImmediate(() => cb(err, r.out, r.err || ''));
  return {};
};
cp.spawnSync = (cmd, args) => { const r = fakeRun(cmd, args); return { status: r.code, stdout: r.out, stderr: r.err || '' }; };

// ── фейковое ядро xray ──
let procs = [];
let spawnMode = 'ok'; // 'ok' | 'die' | 'hold' (порт не открывается, пока тест не вызовет p.open())
let nextPid = 4000;
cp.spawn = (exe, args) => {
  const p = new EventEmitter();
  p.pid = nextPid++;
  p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
  p.cfgPath = args[args.indexOf('-c') + 1];
  p.cfgExistedAtSpawn = fs.existsSync(p.cfgPath);
  try { p.cfg = JSON.parse(fs.readFileSync(p.cfgPath, 'utf8')); } catch (_) { p.cfg = null; }
  p.httpPort = p.cfg && (p.cfg.inbounds.find((i) => i.protocol === 'http') || {}).port;
  p.killed = false; p.server = null;
  const closeAll = (code) => {
    if (p.server) { p.server.close(); p.server = null; }
    setImmediate(() => p.emit('exit', code));
  };
  p.kill = () => { p.killed = true; closeAll(0); };
  p.crash = () => closeAll(139);
  procs.push(p);
  p.open = () => { p.server = net.createServer((s) => s.destroy()).listen(p.httpPort || 12334, '127.0.0.1'); };
  if (spawnMode === 'ok') {
    p.open();
  } else if (spawnMode === 'hold') {
    /* ядро «запускается»: порт откроет сам тест */
  } else {
    setTimeout(() => { p.stderr.emit('data', Buffer.from('bad config')); closeAll(1); }, 50);
  }
  return p;
};

// xray.exe «существует»
const realExists = fs.existsSync;
fs.existsSync = (p) => /[\\/](xray|mihomo)\.exe$/i.test(String(p)) ? true : realExists(p);

const bridge = require(process.env.BRIDGE || path.join(__dirname, '..', '..', 'desktop', 'bridge.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const payload = () => JSON.stringify({
  config: JSON.stringify({ outbounds: [{ protocol: 'freedom', tag: 'direct' }] }),
  settings: JSON.stringify({ core: 'xray' }),
});
const tmpCfgs = () => fs.readdirSync(os.tmpdir()).filter((n) => /^simproxy-desktop-\d+\.json$/.test(n));
const regAdds = (v) => calls.filter((c) => c[0] === 'reg' && c[1] === 'add' && c[4] === v);
const reset = () => { calls.length = 0; procs = []; killStrayCalls = 0; };

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); process.exitCode = 1; }
}

(async () => {
  const before = new Set(tmpCfgs());

  await t('start: ok, proxy enabled, temp config removed after startup', async () => {
    reset();
    const r = await bridge.handlers.startVpnWithResult(payload());
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(bridge.handlers.getVpnStatus(), 'connected');
    assert.strictEqual(reg.ProxyEnable, 1);
    assert.strictEqual(reg.ProxyServer, '127.0.0.1:12334');
    assert.ok(procs[0].cfgExistedAtSpawn, 'config must exist when core starts');
    assert.ok(!fs.existsSync(procs[0].cfgPath), 'config with keys must be deleted after startup');
  });

  await t('crash while connected: proxy cleared immediately by the bridge itself', async () => {
    const p = procs[procs.length - 1];
    p.crash();
    await sleep(300);
    assert.strictEqual(bridge.handlers.getVpnStatus(), 'disconnected');
    assert.strictEqual(reg.ProxyEnable, 0);
    assert.strictEqual(reg.ProxyServer, undefined, 'our ProxyServer value must be removed');
  });

  await t('stop after a normal start: core killed once, proxy off, no leftovers', async () => {
    reset();
    await bridge.handlers.startVpnWithResult(payload());
    const p = procs[0];
    await bridge.handlers.stopVpn();
    assert.ok(p.killed);
    assert.strictEqual(reg.ProxyEnable, 0);
    assert.strictEqual(bridge.handlers.getVpnStatus(), 'disconnected');
    await sleep(100);
    assert.strictEqual(procs.length, 1);
  });

  await t('old core exit event must not reset state of the NEW core (restart race)', async () => {
    reset();
    await bridge.handlers.startVpnWithResult(payload());
    const oldP = procs[0];
    // перезапуск: вторая операция останавливает первое ядро и поднимает новое
    const r2 = await bridge.handlers.startVpnWithResult(payload());
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
    oldP.emit('exit', 0); // запоздавшее событие старого ядра
    await sleep(100);
    assert.strictEqual(bridge.handlers.getVpnStatus(), 'connected');
    await bridge.handlers.stopVpn();
  });

  await t('concurrent starts are serialized (no overlapping cores)', async () => {
    reset();
    const [a, b] = await Promise.all([
      bridge.handlers.startVpnWithResult(payload()),
      bridge.handlers.startVpnWithResult(payload()),
    ]);
    assert.strictEqual(a.ok, true, JSON.stringify(a));
    assert.strictEqual(b.ok, true, JSON.stringify(b));
    assert.strictEqual(procs.length, 2);
    assert.ok(procs[0].killed, 'first core must be stopped by the second start');
    assert.strictEqual(bridge.handlers.getVpnStatus(), 'connected');
    await bridge.handlers.stopVpn();
  });

  await t('failed start: error reported, temp config removed, user proxy untouched', async () => {
    reset();
    reg.ProxyEnable = 1; reg.ProxyServer = 'corp-proxy:8080'; reg.ProxyOverride = 'x';
    spawnMode = 'die';
    const r = await bridge.handlers.startVpnWithResult(payload());
    spawnMode = 'ok';
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /exited on start/);
    assert.ok(!fs.existsSync(procs[0].cfgPath));
    assert.strictEqual(reg.ProxyEnable, 1, "user's own proxy must stay enabled");
    assert.strictEqual(reg.ProxyServer, 'corp-proxy:8080');
    assert.strictEqual(regAdds('ProxyEnable').length, 0, 'we never touched ProxyEnable');
    reg.ProxyEnable = 0; reg.ProxyServer = undefined; reg.ProxyOverride = undefined;
  });

  await t('stopVpnSync (exit path): sync, proxy off, core killed, no PowerShell hang', async () => {
    reset();
    await bridge.handlers.startVpnWithResult(payload());
    const p = procs[0];
    bridge.stopVpnSync();
    assert.ok(p.killed);
    assert.strictEqual(reg.ProxyEnable, 0);
    assert.strictEqual(bridge.handlers.getVpnStatus(), 'disconnected');
    await sleep(100);
  });

  await t('recoverFromCrash: clears OUR stale proxy, leaves a foreign one alone', async () => {
    reset();
    reg.ProxyEnable = 1; reg.ProxyServer = '127.0.0.1:12334';
    await bridge.recoverFromCrash();
    assert.strictEqual(reg.ProxyEnable, 0);
    assert.strictEqual(reg.ProxyServer, undefined);
    assert.ok(killStrayCalls >= 1);
    reg.ProxyEnable = 1; reg.ProxyServer = 'corp-proxy:8080';
    await bridge.recoverFromCrash();
    assert.strictEqual(reg.ProxyEnable, 1, 'foreign proxy must stay');
    assert.strictEqual(reg.ProxyServer, 'corp-proxy:8080');
    reg.ProxyEnable = 0; reg.ProxyServer = undefined;
  });

  await t('config: local stats API inbound + api routing rule first; ports from pickPorts', async () => {
    reset();
    await bridge.handlers.startVpnWithResult(payload());
    const c = procs[0].cfg;
    assert.deepStrictEqual(c.api, { tag: 'api', services: ['StatsService'] });
    const api = c.inbounds.find((i) => i.tag === 'api');
    assert.ok(api && api.protocol === 'dokodemo-door' && api.listen === '127.0.0.1' && api.port > 0);
    assert.deepStrictEqual(c.routing.rules[0], { type: 'field', inboundTag: ['api'], outboundTag: 'api' });
    assert.strictEqual(c.inbounds.find((i) => i.protocol === 'http').port, 12334);
    assert.strictEqual(c.inbounds.find((i) => i.protocol === 'socks').port, 12335);
    assert.match(reg.ProxyOverride, /simproxy\.invalid/);
    await bridge.handlers.stopVpn();
  });

  await t('preferred port busy -> falls back to a free port, proxy points there, stop cleans up', async () => {
    reset();
    const squatter = net.createServer((s) => s.destroy()).listen(12334, '127.0.0.1');
    await new Promise((r) => squatter.once('listening', r));
    const r = await bridge.handlers.startVpnWithResult(payload());
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const used = procs[0].httpPort;
    assert.notStrictEqual(used, 12334);
    assert.strictEqual(reg.ProxyServer, `127.0.0.1:${used}`);
    await bridge.handlers.stopVpn();
    assert.strictEqual(reg.ProxyEnable, 0);
    assert.strictEqual(reg.ProxyServer, undefined, 'dynamic-port proxy must be recognised as ours via the marker');
    squatter.close();
  });

  await t('recoverFromCrash: proxy on a dynamic port is recognised by the marker', async () => {
    reset();
    reg.ProxyEnable = 1; reg.ProxyServer = '127.0.0.1:45678'; reg.ProxyOverride = '<local>;simproxy.invalid';
    await bridge.recoverFromCrash();
    assert.strictEqual(reg.ProxyEnable, 0);
    assert.strictEqual(reg.ProxyServer, undefined);
    reg.ProxyEnable = 1; reg.ProxyServer = '127.0.0.1:45678'; reg.ProxyOverride = '<local>';
    await bridge.recoverFromCrash();
    assert.strictEqual(reg.ProxyEnable, 1, 'a foreign local proxy without our marker must stay');
    reg.ProxyEnable = 0; reg.ProxyServer = undefined; reg.ProxyOverride = undefined;
  });

  await t('recoverFromCrash does not kill a core that is already running', async () => {
    reset();
    await bridge.handlers.startVpnWithResult(payload());
    killStrayCalls = 0;
    await bridge.recoverFromCrash();
    assert.strictEqual(killStrayCalls, 0);
    await bridge.handlers.stopVpn();
  });

  // ── пинг при включённом VPN ──
  const nodeCfg = (address) => JSON.stringify({
    outbounds: [{ protocol: 'vless', tag: 'proxy', settings: { vnext: [{ address, port: 443, users: [] }] } }],
  });
  const nodePayload = (address) => JSON.stringify({ config: nodeCfg(address), settings: JSON.stringify({ core: 'xray' }) });
  const isPingCore = (p) => /simproxy-desktop-ping-/.test(p.cfgPath);

  await t('ping while connected: the connected server goes through the live proxy, another server gets its own core', async () => {
    reset();
    await bridge.handlers.startVpnWithResult(nodePayload('a.example'));
    await bridge.handlers.pingProxyServer(nodeCfg('a.example'));
    assert.strictEqual(procs.filter(isPingCore).length, 0, 'no temporary core for the connected server');
    await bridge.handlers.pingProxyServer(nodeCfg('b.example'));
    const ping = procs.filter(isPingCore);
    assert.strictEqual(ping.length, 1, 'another server must be measured by a temporary core');
    assert.ok(ping[0].killed, 'temporary core is stopped after the measurement');
    assert.ok(!fs.existsSync(ping[0].cfgPath), 'ping config with keys must be deleted');
    await bridge.handlers.stopVpn();
  });

  await t('ping core in flight is not killed as a stray core by connect/disconnect', async () => {
    reset();
    spawnMode = 'hold';
    const pending = bridge.handlers.pingProxyServer(nodeCfg('b.example')); // VPN выключен -> временное ядро
    while (!procs.some(isPingCore)) await sleep(20);
    const ping = procs.find(isPingCore);
    spawnMode = 'ok';
    await bridge.handlers.startVpnWithResult(nodePayload('a.example'));
    const sweep = calls.filter((c) => isKillStray(c[0], c.slice(1))).map((c) => c[c.length - 1]);
    assert.ok(sweep.length >= 1);
    for (const cmd of sweep) assert.ok(cmd.includes(`-notin @(${ping.pid})`), 'sweep must skip the ping core: ' + cmd);
    assert.ok(!ping.killed, 'ping core must survive the connect');
    ping.open(); // порт открылся -> замер завершается сам
    await pending;
    assert.ok(ping.killed, 'ping core is stopped by its own measurement');
    await bridge.handlers.stopVpn();
    const after = calls.filter((c) => isKillStray(c[0], c.slice(1))).pop();
    assert.ok(!after[after.length - 1].includes('-notin'), 'no ping cores left -> plain sweep');
  });

  await t('no simproxy-desktop-*.json left in %TEMP% by these runs', async () => {
    await sleep(2300); // releaseTemp добивает повторно через 2 c
    const leaked = tmpCfgs().filter((n) => !before.has(n));
    assert.deepStrictEqual(leaked, []);
  });

  // ── fetchUrl ──
  const big = Buffer.alloc(9 * 1024 * 1024, 97);
  const srv = http.createServer((req, res) => {
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end(); }
    if (req.url === '/rel') { res.writeHead(302, { Location: '/ok' }); return res.end(); }
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('привет'); }
    if (req.url === '/big') { res.writeHead(200); return res.end(big); }
    res.writeHead(404); res.end();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  await t('fetchUrl: relative redirect followed, UTF-8 intact', async () => {
    const r = await bridge.handlers.fetchUrl(base + '/rel');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.body, 'привет');
  });
  await t('fetchUrl: redirect loop stops', async () => {
    const r = await bridge.handlers.fetchUrl(base + '/loop');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /too many redirects/);
  });
  await t('fetchUrl: oversized response rejected', async () => {
    const r = await bridge.handlers.fetchUrl(base + '/big');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /too large/);
  });
  await t('fetchUrl: non-http protocols rejected', async () => {
    for (const u of ['file:///C:/Windows/win.ini', 'ftp://x/y', 'javascript:1', 'not a url']) {
      const r = await bridge.handlers.fetchUrl(u);
      assert.strictEqual(r.ok, false, u);
    }
  });
  await t('fetchUrl: HTTP error status surfaced', async () => {
    const r = await bridge.handlers.fetchUrl(base + '/nope');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'HTTP 404');
  });

  srv.close();
  console.log(`\n${passed} passed` + (process.exitCode ? ', SOME FAILED' : ''));
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
