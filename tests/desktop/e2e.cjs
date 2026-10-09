// e2e в живом Electron (режим SIM_SMOKE_TEST — реестр, sim:// и чужие процессы не трогаются):
// подтверждения deep-ссылок, openUrl, защита IPC, глобальные обработчики ошибок.
// Запуск: npm run build && npm run test:desktop:e2e  (нужна Windows и собранный dist/).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), http = require('http'), net = require('net'), os = require('os'), path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..', '..');
const exe = process.argv[2] || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const mainJs = process.argv[3] || path.join(ROOT, 'desktop', 'main.cjs');
if (process.platform !== 'win32' || !fs.existsSync(exe) || !fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.log('SKIP: нужны Windows, установленный electron и собранный dist/ (npm run build)');
  process.exit(0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const getJson = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p, timeout: 1500 }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

let ws, seq = 0; const pending = new Map();
function cdp(method, params) { return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.delete(id)) rej(new Error('cdp timeout ' + method)); }, 10000); }); }
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
const bodyText = () => ev('document.body.innerText');
const dispatch = (uri) => ev(`window.dispatchEvent(new CustomEvent('deeplink',{detail:${JSON.stringify(uri)}})); true`);
const clickButton = (label) => ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim().toLowerCase()===${JSON.stringify(label.toLowerCase())}); if(!b) return false; b.click(); return true; })()`);

let failed = 0;
async function t(name, fn) { try { await fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); } }

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'simproxy-e2e-'));
  const port = await freePort();
  const child = spawn(exe, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--no-first-run', mainJs], { env: { ...process.env, SIM_SMOKE_TEST: '1' }, stdio: 'ignore' });
  try {
    let target; const dl = Date.now() + 40000;
    while (Date.now() < dl) { try { target = (await getJson(port, '/json/list')).find((x) => x.type === 'page' && /index\.html/.test(x.url)); if (target) break; } catch (_) {} await sleep(400); }
    assert.ok(target, 'page did not load');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); p.res(d.result || d.error); } };
    await sleep(2500);
    // онбординг перекрывает экран при первом запуске — закрываем через localStorage и перезагружаем
    await ev(`localStorage.setItem('sim-onboarded','true'); true`);
    await cdp('Page.reload', {});
    await sleep(3500);

    await t('trial: without a device id (test mode) a fresh install gets no trial and stores nothing', async () => {
      assert.strictEqual(await ev(`window.SimNativeV2.getDeviceId()`), null);
      const profiles = await ev(`localStorage.getItem('sim-profiles')`);
      assert.ok(!profiles || !profiles.includes('trialExpiresAt'), 'unexpected trial: ' + String(profiles).slice(0, 120));
    });

    await t('vpn/off deep link asks for confirmation instead of acting', async () => {
      await dispatch('sim://vpn/off');
      await sleep(600);
      const txt = await bodyText();
      assert.ok(txt.includes('Отключить VPN?'), 'modal not shown: ' + txt.slice(0, 200));
      assert.ok(await clickButton('Отмена'));
      await sleep(400);
      assert.ok(!(await bodyText()).includes('Отключить VPN?'), 'modal did not close');
    });

    await t('subscription link shows host + full URL and needs confirmation', async () => {
      await dispatch('sim://add/https://sub.example.org/api/token123');
      await sleep(600);
      const txt = await bodyText();
      assert.ok(txt.includes('Добавить подписку?'), txt.slice(0, 200));
      assert.ok(txt.includes('sub.example.org'));
      assert.ok(txt.includes('https://sub.example.org/api/token123'));
      const profilesBefore = await ev(`localStorage.getItem('sim-profiles')`);
      assert.ok(await clickButton('Отмена'));
      await sleep(400);
      assert.strictEqual(await ev(`localStorage.getItem('sim-profiles')`), profilesBefore, 'cancel must not add anything');
    });

    await t('routing import link needs confirmation and shows the profile name', async () => {
      const b64 = Buffer.from(JSON.stringify({ Name: 'Evil Routing', Rules: [] })).toString('base64');
      await dispatch('sim://routing/add/' + b64);
      await sleep(600);
      const txt = await bodyText();
      assert.ok(txt.includes('Импортировать маршрутизацию?') && txt.includes('Evil Routing'), txt.slice(0, 200));
      assert.ok(await clickButton('Отмена'));
    });

    await t('confirmed server import adds the node (proves the confirm path executes)', async () => {
      const link = 'vless://11111111-1111-1111-1111-111111111111@example.com:443?security=tls&sni=example.com#E2E';
      await dispatch('sim://import/' + encodeURIComponent(link));
      await sleep(600);
      const txt = await bodyText();
      assert.ok(txt.includes('Добавить сервер?'), txt.slice(0, 200));
      assert.ok(await clickButton('Добавить'));
      await sleep(800);
      const profiles = await ev(`localStorage.getItem('sim-profiles')`);
      assert.ok(profiles && profiles.includes('example.com'), 'node not saved: ' + String(profiles).slice(0, 120));
    });

    await t('openUrl refuses non-http(s) schemes (file:, javascript:, ms-settings:)', async () => {
      for (const u of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'ms-settings:network-proxy', 'not a url']) {
        const r = await ev(`window.SimNativeV2.openUrl(${JSON.stringify(u)})`);
        assert.strictEqual(r, false, u + ' -> ' + r);
      }
    });

    await t('unknown native method returns a safe default and does not throw', async () => {
      assert.strictEqual(await ev(`window.SimNativeV2.someMethodThatDoesNotExist()`), null);
    });

    await t('prototype methods are not callable through the IPC bridge', async () => {
      const r = await ev(`window.SimNativeV2.constructor()`);
      // handlers.constructor не должен быть вызван: ожидаем «безопасный дефолт», а не результат Object()
      assert.ok(r === null || r === false, 'got ' + JSON.stringify(r));
    });

    await t('desktop getStats works through the real IPC (status not_running, zero traffic)', async () => {
      const s = await ev(`window.SimNativeV2.getStats()`);
      assert.strictEqual(s.status, 'not_running');
      assert.strictEqual(s.upload, 0);
    });

    // ── Пробный сервер: живой и истёкший профиль в реальном рендерере (сервер не задействован) ──
    const TRIAL_NAME = 'Тестовый сервер Sim-Proxy.biz';
    const trialProfile = (expiresAt) => ({
      id: 'sim-trial-profile', name: TRIAL_NAME, url: '', autoUpdate: false, status: 'healthy',
      updatedAt: new Date().toLocaleString('ru-RU'), lastUpdateTimestamp: Date.now(),
      webPage: 'https://sim-proxy.biz/', supportUrl: 'https://sim-proxy.biz/', trialExpiresAt: expiresAt,
      traffic: { upload: 0, download: 0, total: 0, expire: Math.floor(expiresAt / 1000), remainingDays: 3 },
      nodes: [{ id: 'sim-trial-node', name: TRIAL_NAME, remark: TRIAL_NAME, address: '185.253.23.122', port: 443, protocol: 'vless',
                rawLink: 'vless://11111111-1111-1111-1111-111111111111@185.253.23.122:443?security=tls&sni=example.com#trial' }],
    });
    const loadProfiles = async (profiles) => {
      await ev(`localStorage.setItem('sim-profiles', ${JSON.stringify(JSON.stringify(profiles))});
                localStorage.setItem('sim-selected-node', ${JSON.stringify(JSON.stringify(profiles[0].nodes[0]))});
                localStorage.setItem('sim-active-profile', '"sim-trial-profile"');
                localStorage.setItem('sim-trial-offered', 'true'); true`);
      await cdp('Page.reload', {});
      await sleep(3500);
    };

    await t('trial: a running trial shows the server and no "expired" block', async () => {
      await loadProfiles([trialProfile(Date.now() + 2 * 86400000)]);
      const txt = await bodyText();
      assert.ok(txt.includes(TRIAL_NAME), 'trial server not shown: ' + txt.slice(0, 200));
      assert.ok(!txt.includes('Пробный период закончился'), 'shown as expired too early');
      const saved = JSON.parse(await ev(`localStorage.getItem('sim-profiles')`));
      assert.strictEqual(saved[0].nodes.length, 1);
      const sel = JSON.parse(await ev(`localStorage.getItem('sim-selected-node')`));
      assert.strictEqual(sel && sel.id, 'sim-trial-node', 'selected trial server must stay selected');
    });

    await t('trial: after the deadline the server disappears and only the link to get a subscription is left', async () => {
      await loadProfiles([trialProfile(Date.now() - 1000)]);
      const txt = await bodyText();
      assert.ok(txt.includes('Пробный период закончился'), 'no expiry notice: ' + txt.slice(0, 300));
      assert.ok(txt.toLowerCase().includes('получить подписку'), 'no link to get a subscription');
      assert.ok(!txt.includes('Добавить подписку →'), 'the plain "add subscription" hint must not replace the link');
      const saved = JSON.parse(await ev(`localStorage.getItem('sim-profiles')`));
      assert.deepStrictEqual(saved[0].nodes, [], 'server must be removed from storage');
      assert.strictEqual(saved[0].status, 'expired');
      assert.strictEqual(saved[0].webPage, 'https://sim-proxy.biz/');
      // Копия сервера (с конфигом) в выбранном узле тоже должна исчезнуть, иначе она пережила бы срок.
      assert.strictEqual(await ev(`localStorage.getItem('sim-selected-node')`), 'null', 'selected trial server must be cleared');
    });

    await t('global error hooks record uncaught errors', async () => {
      await ev(`setTimeout(() => { throw new Error('e2e-boom'); }, 0); true`);
      await sleep(500);
      const n = await ev(`(window.__simErrors||[]).filter(e => e.msg.includes('e2e-boom')).length`);
      assert.ok(n >= 1, 'not recorded');
    });
  } catch (e) {
    failed++; console.log('  FAIL setup: ' + (e && e.message || e));
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    await sleep(500);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall e2e checks passed');
  process.exit(failed ? 1 : 0);
})();
