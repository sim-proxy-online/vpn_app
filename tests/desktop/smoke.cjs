// Смоук-запуск собранного десктоп-приложения.
//   node tests/desktop/smoke.cjs <SimProxy.exe>            — упакованная сборка
//   node tests/desktop/smoke.cjs <electron.exe> <main.cjs> — запуск из исходников
// Запускает приложение в режиме SIM_SMOKE_TEST (не трогает реестр, sim://, чужие процессы),
// с отдельным временным профилем и портом отладки, ждёт загрузки страницы и проверяет через
// CDP, что React смонтировался и мост window.SimNativeV2 на месте. Код возврата 1 — сбой.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const [exe, ...appArgs] = process.argv.slice(2);
if (!exe || !fs.existsSync(exe)) {
  console.error('usage: node tests/desktop/smoke.cjs <exe> [appPath]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 1500 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function evalInPage(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('CDP timeout')); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id === 1) { clearTimeout(t); ws.close(); resolve(d.result && d.result.result && d.result.result.value); }
    };
    ws.onerror = () => { clearTimeout(t); reject(new Error('CDP websocket error')); };
  });
}

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'simproxy-smoke-'));
  const port = await freePort();
  let exited = null;
  const child = spawn(
    exe,
    [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--no-first-run', ...appArgs],
    { env: { ...process.env, SIM_SMOKE_TEST: '1' }, stdio: 'ignore' },
  );
  child.on('error', (e) => { exited = { error: String(e) }; });
  child.on('exit', (code) => { exited = { code }; });

  const fail = (msg) => { console.error('SMOKE FAIL: ' + msg); return false; };
  let ok = false;
  try {
    let target = null;
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && !exited) {
      try {
        const list = await getJson(port, '/json/list');
        target = list.find((x) => x.type === 'page' && /index\.html/.test(x.url || ''));
        if (target) break;
      } catch (_) { /* ещё не поднялся */ }
      await sleep(400);
    }
    if (exited) ok = fail('приложение завершилось до загрузки страницы: ' + JSON.stringify(exited));
    else if (!target) ok = fail('страница index.html не загрузилась за 40 с');
    else {
      await sleep(3000); // React успевает смонтироваться
      const page = JSON.parse(await evalInPage(target.webSocketDebuggerUrl,
        `JSON.stringify({desktop: window.__SIM_DESKTOP__ === true, bridge: typeof window.SimNativeV2,
          root: document.getElementById('root') ? document.getElementById('root').children.length : -1,
          text: document.body.innerText.length,
          errors: (window.__simErrors || []).length})`));
      console.log('page:', JSON.stringify(page));
      if (!page.desktop || page.bridge !== 'object') ok = fail('мост preload не подключился');
      else if (page.root < 1 || page.text < 10) ok = fail('React не отрисовал интерфейс');
      else if (page.errors > 0) ok = fail('на странице зафиксированы необработанные ошибки (window.__simErrors)');
      else { ok = true; console.log('SMOKE OK'); }
    }
  } catch (e) {
    ok = fail(String(e && e.message || e));
  } finally {
    if (!exited) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    await sleep(500);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(ok ? 0 : 1);
})();
