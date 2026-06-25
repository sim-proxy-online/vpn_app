// Electron main process for the SimProxy Windows client.
const { app, BrowserWindow, Menu, ipcMain, clipboard, shell, Notification } = require('electron');
const path = require('path');
const { handlers, stopVpn, recoverFromCrash, setProgressSender } = require('./bridge.cjs');
// electron-updater is deferred (lazy require inside setupAutoUpdater) to avoid
// it calling app.getVersion() at require-time before the app is ready.

// Standard Windows edit shortcuts (Ctrl+C/V/X/A/Z, etc.). Without an application
// menu Electron drops these accelerators, so editable fields would ignore the
// keyboard. The bar stays hidden (autoHideMenuBar) — we only need the roles.
function installEditMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Правка',
        submenu: [
          { role: 'undo', label: 'Отменить' },
          { role: 'redo', label: 'Повторить' },
          { type: 'separator' },
          { role: 'cut', label: 'Вырезать' },
          { role: 'copy', label: 'Копировать' },
          { role: 'paste', label: 'Вставить' },
          { role: 'delete', label: 'Удалить' },
          { type: 'separator' },
          { role: 'selectAll', label: 'Выделить всё' },
        ],
      },
    ]),
  );
}

// Right-click context menu: copy/paste/cut/select-all plus "open link" and
// "copy link" when the cursor is over a hyperlink. Items are enabled per the
// renderer's edit flags so e.g. Paste only lights up inside editable fields.
function installContextMenu(contents) {
  contents.on('context-menu', (_e, params) => {
    const f = params.editFlags || {};
    const hasText = !!params.selectionText?.trim();
    const template = [];

    if (params.linkURL) {
      template.push(
        { label: 'Открыть ссылку', click: () => shell.openExternal(params.linkURL) },
        { label: 'Копировать ссылку', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }

    template.push(
      { role: 'cut', label: 'Вырезать', enabled: !!f.canCut },
      { role: 'copy', label: 'Копировать', enabled: !!f.canCopy && hasText },
      { role: 'paste', label: 'Вставить', enabled: !!f.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: 'Выделить всё', enabled: f.canSelectAll !== false },
    );

    Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(contents) });
  });
}

let win = null;

// ── Deep links (sim:// / happ://) ────────────────────────────────────────────
// Добавление подписки прямо из браузера, как на Android: ссылка вида
// sim://import/<...>, sim://add/<url>, sim://subscribe/<url> открывает приложение
// и импортирует подписку/сервер. Логика разбора уже есть в рендере (src/App.tsx).
const DEEP_LINK_SCHEMES = ['sim', 'happ'];
let pendingDeepLink = null;

function extractDeepLink(argv) {
  if (!Array.isArray(argv)) return null;
  return (
    argv.find(
      (a) => typeof a === 'string' && DEEP_LINK_SCHEMES.some((s) => a.toLowerCase().startsWith(s + '://'))
    ) || null
  );
}

// Доставляет ссылку в рендерер. Если окно ещё не готово — запоминаем её и отдаём
// позже через getPendingDeepLink (холодный старт).
function deliverDeepLink(uri) {
  if (!uri) return;
  if (win && !win.isDestroyed() && win.webContents) {
    const send = () => {
      win.webContents
        .executeJavaScript(`window.dispatchEvent(new CustomEvent('deeplink',{detail:${JSON.stringify(uri)}}));`)
        .catch(() => {});
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
    try {
      if (win.isMinimized()) win.restore();
      win.focus();
    } catch (_) {}
  } else {
    pendingDeepLink = uri;
  }
}

const INDEX_HTML = path.join(__dirname, '..', 'dist', 'index.html');

function loadUI() {
  if (win && !win.isDestroyed()) win.loadFile(INDEX_HTML);
}

function createWindow() {
  win = new BrowserWindow({
    // Десктоп-раскладка (боковое меню + панель профиля на главной) включается
    // на ширине ≥1024px (Tailwind lg:). Стартуем сразу в широком окне, чтобы
    // пользователю не приходилось растягивать его вручную.
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0a0a1a',
    autoHideMenuBar: true,
    title: 'Sim Proxy', // never fall back to the package name in the title bar
    icon: path.join(__dirname, '..', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: false, // preload injects window.SimNativeV2 directly
      nodeIntegration: false,
      sandbox: false,
      // Как на Android (foreground-сервис): таймер подключения и поллинг статистики
      // должны идти и в свёрнутом окне. Chromium по умолчанию тротлит таймеры
      // фоновых/свёрнутых страниц (~1/мин), из-за чего setInterval(1000) в App.tsx
      // «замирает». Отключаем троттлинг, чтобы счётчик времени шёл непрерывно.
      backgroundThrottling: false,
    },
  });

  // Keep the title stable even if the page sets/changes it.
  win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle('Sim Proxy'); });

  // Windows clipboard UX: right-click context menu + standard edit shortcuts.
  installContextMenu(win.webContents);

  // Self-heal a transient blank screen: a Chromium network-service/renderer
  // hiccup can make the first file:// load fail (blank window). Auto-retry so the
  // user never gets stuck on an empty screen.
  let reloads = 0;
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (url && url.startsWith('devtools')) return;
    if (reloads++ < 5) { console.warn('did-fail-load', code, desc, '-> reloading'); setTimeout(loadUI, 400); }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.warn('render-process-gone', details && details.reason, '-> reloading');
    if (reloads++ < 5) setTimeout(loadUI, 400);
  });

  // Renderer is the single-file Vite build.
  loadUI();

  // Прогресс скачивания обновления (.exe) из bridge.cjs → событие в renderer
  // (то же 'update-progress', что слушает UpdatePrompt на Android).
  setProgressSender((pct) => {
    try {
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.executeJavaScript(
          `window.dispatchEvent(new CustomEvent('update-progress',{detail:{pct:${Number(pct) || 0}}}));`
        ).catch(() => {});
      }
    } catch (_) { /* окно закрывается — игнор */ }
  });

  if (process.env.SIM_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

// ── Авто-обновление (electron-updater) ───────────────────────────────────────
// «Полноценный» незаметный апдейтер: качает дельту в фоне и ставит тихо при
// выходе из приложения (autoInstallOnAppQuit). Пользователь ничего не делает.
// Текущее состояние отдаём в renderer для ненавязчивой плашки и для кнопки
// «Проверить обновление» в настройках.
let desktopUpdateState = { status: 'idle', version: null, progress: 0, error: null };
let autoUpdater = null; // populated by setupAutoUpdater() after app is ready

function sendToRenderer(channel, detail) {
  try {
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents
        .executeJavaScript(`window.dispatchEvent(new CustomEvent(${JSON.stringify(channel)},{detail:${JSON.stringify(detail)}}));`)
        .catch(() => {});
    }
  } catch (_) { /* окно закрывается */ }
}

function setupAutoUpdater() {
  // В dev (не упакованное приложение) app-update.yml отсутствует — пропускаем,
  // чтобы не сыпать ошибками «dev-app-update.yml not found».
  if (!app.isPackaged) return;

  // Lazy-require so that electron-updater never calls app.getVersion() at
  // module load time (before the app is ready), which crashes in dev mode.
  autoUpdater = require('electron-updater').autoUpdater;

  autoUpdater.autoDownload = true;          // докачка в фоне сразу при обнаружении
  autoUpdater.autoInstallOnAppQuit = true;  // тихая установка при выходе
  autoUpdater.allowDowngrade = false;
  autoUpdater.autoRunAppAfterInstall = true;

  autoUpdater.on('checking-for-update', () => { desktopUpdateState = { ...desktopUpdateState, status: 'checking', error: null }; });
  autoUpdater.on('update-available', (info) => {
    desktopUpdateState = { status: 'downloading', version: info?.version || null, progress: 0, error: null };
    sendToRenderer('desktop-update', desktopUpdateState);
  });
  autoUpdater.on('update-not-available', () => { desktopUpdateState = { ...desktopUpdateState, status: 'latest', error: null }; });
  autoUpdater.on('download-progress', (p) => {
    const pct = Math.round(p?.percent || 0);
    desktopUpdateState = { ...desktopUpdateState, status: 'downloading', progress: pct };
    sendToRenderer('update-progress', { pct });
  });
  autoUpdater.on('update-downloaded', (info) => {
    // Скачано — установим тихо при выходе. Сообщаем renderer, чтобы показать
    // ненавязчивую плашку «Обновить и перезапустить» для немедленной установки.
    desktopUpdateState = { status: 'downloaded', version: info?.version || null, progress: 100, error: null };
    sendToRenderer('desktop-update', desktopUpdateState);
  });
  autoUpdater.on('error', (err) => {
    desktopUpdateState = { ...desktopUpdateState, status: 'error', error: String(err && err.message ? err.message : err) };
  });

  // Проверка на старте (после загрузки UI) и далее каждые 6 часов.
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 8000);
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 6 * 60 * 60 * 1000);
}

// ── IPC: route renderer "native" calls to the desktop bridge ─────────────────
// Default behaviours for methods we don't implement yet, so the UI never breaks.
function defaultFor(method) {
  if (/^(get|list|fetch)/i.test(method)) return null;
  if (/^(is|has|toggle|set|enable|disable|start|stop|test|change|update|request)/i.test(method))
    return false;
  return null;
}

ipcMain.handle('sim:call', async (_e, method, args) => {
  try {
    // Electron-native conveniences handled here directly.
    switch (method) {
      case 'copyToClipboard':
        clipboard.writeText(String(args[0] ?? ''));
        return true;
      case 'readClipboard':
        return clipboard.readText();
      case 'openUrl':
        if (args[0]) shell.openExternal(String(args[0]));
        return true;
      case 'showNotification':
        try { new Notification({ title: String(args[0] ?? ''), body: String(args[1] ?? '') }).show(); } catch (_) {}
        return true;
      case 'minimizeApp':
        if (win) win.minimize();
        return true;
      case 'getPendingDeepLink': {
        // Холодный старт: ссылка, с которой приложение было запущено из браузера.
        const u = pendingDeepLink;
        pendingDeepLink = null;
        return u || '';
      }
      case 'getAppVersion':
        // Реальная версия desktop-сборки (из package.json) — чтобы проверка
        // обновлений сравнивала с актуальной, а не с веб-константой APP_VERSION.
        return JSON.stringify({ versionName: app.getVersion(), versionCode: 0 });
      case 'checkForUpdatesNow':
        // Ручная проверка из настроек. electron-updater сам качает в фоне.
        if (!app.isPackaged || !autoUpdater) return { ok: false, status: 'dev' };
        autoUpdater.checkForUpdates().catch(() => {});
        return { ok: true, status: desktopUpdateState.status, version: desktopUpdateState.version };
      case 'getDesktopUpdateState':
        return desktopUpdateState;
      case 'quitAndInstallUpdate':
        // Немедленная установка по кнопке «Обновить и перезапустить».
        if (!autoUpdater) return { ok: false, error: 'updater not ready' };
        try { setImmediate(() => autoUpdater.quitAndInstall(true, true)); return { ok: true }; }
        catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
      case 'requestVpnPermission':
        return true; // desktop: no per-app VPN permission
      case 'requestAllPermissions':
        return true;
      case 'getSystemInfo':
        return {
          osVersion: require('os').release(),
          apiLevel: 0,
          model: 'PC',
          manufacturer: require('os').hostname(),
          totalMemory: require('os').totalmem(),
          freeMemory: require('os').freemem(),
          maxMemory: require('os').totalmem(),
        };
    }
    const h = handlers[method];
    if (h) return await h(...(args || []));
    return defaultFor(method);
  } catch (e) {
    console.error('sim:call', method, e);
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

// Single-instance: если приложение уже запущено и пользователь кликнул sim://-ссылку
// в браузере, Windows стартует второй экземпляр с URL в argv — перехватываем его и
// передаём в уже открытое окно, второй экземпляр закрываем.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const uri = extractDeepLink(argv);
    if (uri) deliverDeepLink(uri);
    else if (win) {
      try {
        if (win.isMinimized()) win.restore();
        win.focus();
      } catch (_) {}
    }
  });

  // macOS доставляет схему через open-url (на Windows не используется, но безвредно).
  app.on('open-url', (e, url) => { e.preventDefault(); deliverDeepLink(url); });

  app.whenReady().then(() => {
    // Регистрируем приложение обработчиком схем sim:// и happ://.
    for (const s of DEEP_LINK_SCHEMES) {
      try { app.setAsDefaultProtocolClient(s); } catch (_) {}
    }
    // Ссылка холодного старта (приложение открыли кликом по sim://-ссылке).
    pendingDeepLink = extractDeepLink(process.argv);

    installEditMenu(); // register Ctrl+C/V/X/A accelerators (menu bar stays hidden)
    createWindow(); // window first — keep startup snappy and the renderer stable
    setupAutoUpdater(); // фоновая докачка обновлений + тихая установка при выходе
    // Self-heal a previous crash (stray xray + stale system proxy) off the critical
    // startup path so the synchronous cleanup never stalls the renderer launch.
    setTimeout(() => { try { recoverFromCrash(); } catch (_) {} }, 300);
  });
}

app.on('window-all-closed', async () => {
  await stopVpn();
  if (process.platform !== 'darwin') app.quit();
});

// Always clear the system proxy on exit so we don't leave the machine broken.
app.on('before-quit', async () => {
  try { await stopVpn(); } catch (_) {}
});
process.on('exit', () => { try { stopVpn(); } catch (_) {} });
