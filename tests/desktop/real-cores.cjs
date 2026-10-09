// Настоящие xray.exe / mihomo.exe (desktop/resources) на localhost. Системные команды
// (reg / powershell / ipconfig) подменены — реестр и чужие процессы не затрагиваются.
// Запуск: npm run test:desktop:real. Без бинарников ядер (они не в репозитории, см.
// download_xray.ps1) тест пропускается. Требует свободных портов 12334–12336.
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const RES = path.join(__dirname, '..', '..', 'desktop', 'resources');
if (process.platform !== 'win32' || !fs.existsSync(path.join(RES, 'xray.exe')) || !fs.existsSync(path.join(RES, 'mihomo.exe'))) {
  console.log('SKIP: нужны Windows и desktop/resources/{xray,mihomo}.exe');
  process.exit(0);
}

const reg = { ProxyEnable: 0, ProxyServer: undefined, ProxyOverride: undefined };
const FAKE = new Set(['reg', 'powershell', 'ipconfig']);
function fake(cmd, args) {
  if (cmd === 'reg') {
    const [op, , , name, , , , data] = args;
    if (op === 'query') {
      const l = [`    ProxyEnable    REG_DWORD    0x${reg.ProxyEnable}`];
      if (reg.ProxyServer !== undefined) l.push(`    ProxyServer    REG_SZ    ${reg.ProxyServer}`);
      if (reg.ProxyOverride !== undefined) l.push(`    ProxyOverride    REG_SZ    ${reg.ProxyOverride}`);
      return { code: 0, out: l.join('\r\n') };
    }
    if (op === 'add') reg[name] = name === 'ProxyEnable' ? Number(data) : data;
    if (op === 'delete') reg[name] = undefined;
  }
  return { code: 0, out: '' };
}
const realExecFile = cp.execFile;
cp.execFile = (cmd, args, opts, cb) => {
  if (!FAKE.has(cmd)) return realExecFile(cmd, args, opts, cb);
  const r = fake(cmd, args);
  setImmediate(() => cb(null, r.out, ''));
  return {};
};
const realSpawnSync = cp.spawnSync;
cp.spawnSync = (cmd, args, opts) => {
  if (!FAKE.has(cmd)) return realSpawnSync(cmd, args, opts);
  const r = fake(cmd, args);
  return { status: 0, stdout: r.out, stderr: '' };
};

const bridge = require(path.join(__dirname, '..', '..', 'desktop', 'bridge.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isListening = (port) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
});

const body = Buffer.alloc(60 * 1024, 65);
const origin = http.createServer((req, res) => { res.writeHead(200, { 'content-length': body.length }); res.end(body); });

function viaProxy(proxyPort, originPort) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: proxyPort, method: 'GET',
      path: `http://127.0.0.1:${originPort}/x`, headers: { Host: `127.0.0.1:${originPort}`, Connection: 'close' },
      agent: false, timeout: 8000,
    }, (res) => {
      let n = 0; res.on('data', (c) => (n += c.length)); res.on('end', () => resolve({ status: res.statusCode, bytes: n }));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

async function scenario(label, payload) {
  await t(`${label}: starts on real core, system proxy set (fake registry)`, async () => {
    const r = await bridge.handlers.startVpnWithResult(payload);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.match(reg.ProxyServer, /^127\.0\.0\.1:\d+$/);
  });
  const proxyPort = Number((reg.ProxyServer || '').split(':')[1]);
  const originPort = origin.address().port;

  await t(`${label}: initial stats are zero-ish and status running`, async () => {
    const s = await bridge.handlers.getStats();
    assert.strictEqual(s.status, 'running');
    assert.ok(s.upload >= 0 && s.download >= 0);
  });

  await t(`${label}: traffic through the proxy shows up in stats (upload>0, download>0)`, async () => {
    const r = await viaProxy(proxyPort, originPort);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.bytes, body.length);
    await sleep(2200); // getStats кэширует замер на ~2 c
    const s = await bridge.handlers.getStats();
    assert.ok(s.download >= body.length, `download ${s.download} < ${body.length}`);
    assert.ok(s.upload > 0, `upload ${s.upload}`);
  });

  await t(`${label}: speed is computed from the delta between samples`, async () => {
    // окно замера ≈ 2.3 c; за это время качаем ещё несколько раз
    for (let i = 0; i < 4; i++) await viaProxy(proxyPort, originPort);
    await sleep(2200);
    const s = await bridge.handlers.getStats();
    assert.ok(s.downlinkSpeed > 0, `downlinkSpeed ${s.downlinkSpeed}`);
    assert.ok(s.uplinkSpeed > 0, `uplinkSpeed ${s.uplinkSpeed}`);
  });

  await t(`${label}: stop kills the real core and clears the proxy`, async () => {
    await bridge.handlers.stopVpn();
    assert.strictEqual(reg.ProxyEnable, 0);
    assert.strictEqual(reg.ProxyServer, undefined);
    await sleep(500);
    assert.strictEqual(await isListening(proxyPort), false, 'core still listening after stop');
    const s = await bridge.handlers.getStats();
    assert.strictEqual(s.status, 'not_running');
    assert.strictEqual(s.downlinkSpeed, 0);
  });
}

(async () => {
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));

  await scenario('xray', JSON.stringify({
    config: JSON.stringify({ outbounds: [{ protocol: 'freedom', tag: 'direct' }] }),
    settings: JSON.stringify({ core: 'xray' }),
  }));

  await scenario('mihomo', JSON.stringify({
    config: JSON.stringify({ 'mode': 'rule', 'log-level': 'warning', proxies: [], rules: ['MATCH,DIRECT'] }),
    settings: JSON.stringify({ core: 'mihomo' }),
  }));

  // 12334 занят чужим процессом → мост должен взять свободный порт и работать
  const squatter = net.createServer((s) => s.destroy());
  await new Promise((r) => squatter.listen(12334, '127.0.0.1', r));
  await scenario('xray (12334 squatted)', JSON.stringify({
    config: JSON.stringify({ outbounds: [{ protocol: 'freedom', tag: 'direct' }] }),
    settings: JSON.stringify({ core: 'xray' }),
  }));
  await t('xray (12334 squatted): the proxy really was on a different port', async () => {
    // после stop прокси очищен, поэтому проверяем по логу моста
    const os = require('os');
    const log = fs.readFileSync(path.join(os.tmpdir(), 'simproxy-bridge.log'), 'utf8').split('\n').slice(-400).join('\n');
    assert.match(log, /preferred ports 12334\/12335 busy -> using \d+\/12335/);
  });
  squatter.close();

  origin.close();
  console.log(failed ? `\n${failed} FAILED` : '\nall real-core checks passed');
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
})();
