// Electron main process for the SimProxy Windows client.
const { app, BrowserWindow, Menu, ipcMain, clipboard, shell, Notification } = require('electron');
const path = require('path');
const { handlers, stopVpnSync, recoverFromCrash } = require('./bridge.cjs');
const { getDeviceId } = require('./deviceId.cjs');
// electron-updater is deferred (lazy require inside setupAutoUpdater) to avoid
// it calling app.getVersion() at require-time before the app is ready.

// Windows: без своего AppUserModelID Electron подписывает уведомления как «electron.app.…», и
// в заголовке всплывающего тоста вместо «Петрович» видно эту строку. Идентификатор совпадает с
// appId в electron-builder.yml; дружественное имя для него живёт в ветке реестра
// HKCU\Software\Classes\AppUserModelId (её создаёт installScripts\setup-aumid.ps1).
if (process.platform === 'win32') {
  try { app.setAppUserModelId('party.petrovich.desktop'); } catch (_) {}
}

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

// Открываем во внешнем приложении только http(s). Рендерер (contextIsolation
// выключен) и страницы подписок не должны запускать file:, ms-*: и прочие схемы.
function openExternalSafe(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch (_) { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  shell.openExternal(u.toString()).catch(() => {});
  return true;
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
        { label: 'Открыть ссылку', click: () => openExternalSafe(params.linkURL) },
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

// SIM_SMOKE_TEST=1 — режим проверки собранного приложения (запуск в CI или вручную): не
// регистрирует sim:// / happ:// в системе, не запускает автообновление, не выполняет
// восстановление после аварии и очистку при выходе. Так проверочный запуск не трогает
// системный прокси, чужие процессы и настройки протоколов на машине.
const SMOKE_TEST = !!process.env.SIM_SMOKE_TEST;

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
    title: 'Петрович', // never fall back to the package name in the title bar
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
  win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle('Петрович'); });

  // Windows clipboard UX: right-click context menu + standard edit shortcuts.
  installContextMenu(win.webContents);

  // Окно грузит только собственный dist/index.html: любую навигацию на чужой URL
  // (в т.ч. по ссылке из контента подписки) отменяем и, если это http(s), открываем
  // в браузере. Иначе внешняя страница получила бы window.SimNativeV2 из preload.
  const isOwnPage = (url) => {
    try { return new URL(url).protocol === 'file:'; } catch (_) { return false; }
  };
  win.webContents.on('will-navigate', (e, url) => {
    if (isOwnPage(url)) return;
    e.preventDefault();
    openExternalSafe(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });

  // Self-heal a transient blank screen: a Chromium network-service/renderer
  // hiccup can make the first file:// load fail (blank window). Auto-retry so the
  // user never gets stuck on an empty screen. Счётчик — это серия подряд идущих
  // сбоев: после успешной загрузки он обнуляется, иначе 5 редких падений за
  // всё время работы оставили бы окно пустым навсегда.
  let reloads = 0;
  win.webContents.on('did-finish-load', () => { reloads = 0; });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;           // сбой подфрейма/ресурса — не повод перезагружать окно
    if (code === -3) return;            // ERR_ABORTED: навигацию отменили сами
    if (url && url.startsWith('devtools')) return;
    if (reloads++ < 5) { console.warn('did-fail-load', code, desc, '-> reloading'); setTimeout(loadUI, 400); }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details && details.reason === 'clean-exit') return;
    console.warn('render-process-gone', details && details.reason, '-> reloading');
    if (reloads++ < 5) setTimeout(loadUI, 400);
  });

  // Renderer is the single-file Vite build.
  loadUI();

  if (process.env.SIM_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

// ── Авто-обновление (electron-updater) ───────────────────────────────────────
// «Полноценный» незаметный апдейтер: качает дельту в фоне и ставит тихо при
// выходе из приложения (autoInstallOnAppQuit). Пользователь ничего не делает.
// Текущее состояние отдаём в renderer для ненавязчивой плашки и для кнопки
// «Проверить обновление» в настройках.
let desktopUpdateState = { status: 'idle', version: null, progress: 0, error: null };
let autoUpdater = null; // populated by setupAutoUpdater() after app is ready

// Репозиторий с релизами (тот же, что в publish: desktop/electron-builder.yml).
const UPDATE_OWNER = 'sim-proxy-online';
const UPDATE_REPO = 'vpn_app';
let currentFeedUrl = null;

// Проверка обновлений с выбором источника: провайдер github смотрит только в ПОСЛЕДНИЙ
// релиз, а релиз без latest.yml (например, только с APK) молча ломает автообновление.
// Находим свежайший релиз, где latest.yml есть (см. updateFeed.cjs). Если определить не
// вышло (нет сети, лимит GitHub API) — остаёмся на настройках по умолчанию.
async function checkForUpdatesResolved() {
  try {
    const { resolveFeedUrl } = require('./updateFeed.cjs');
    const url = await resolveFeedUrl({ owner: UPDATE_OWNER, repo: UPDATE_REPO });
    if (url && url !== currentFeedUrl) {
      autoUpdater.setFeedURL({ provider: 'generic', url });
      currentFeedUrl = url;
    }
  } catch (e) {
    console.warn('update feed: using the default provider:', e && e.message ? e.message : e);
  }
  return autoUpdater.checkForUpdates();
}

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
  // В сборке из Microsoft Store (MSIX) приложение обновляет магазин: правила магазина запрещают
  // качать и ставить обновления в обход него, а установщик внутри пакета всё равно не запустится.
  if (!app.isPackaged || SMOKE_TEST || process.windowsStore) return;

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
  setTimeout(() => { checkForUpdatesResolved().catch(() => {}); }, 8000);
  setInterval(() => { checkForUpdatesResolved().catch(() => {}); }, 6 * 60 * 60 * 1000);
}

// ── IPC: route renderer "native" calls to the desktop bridge ─────────────────
// Default behaviours for methods we don't implement yet, so the UI never breaks.
const warnedUnknownMethods = new Set();
function defaultFor(method) {
  // Молчаливая заглушка скрывала бы недописанные методы: пишем предупреждение — один раз на метод.
  if (!warnedUnknownMethods.has(method)) {
    warnedUnknownMethods.add(method);
    console.warn('sim:call: no desktop handler for', method, '- returning default');
  }
  if (/^(get|list|fetch)/i.test(method)) return null;
  if (/^(is|has|toggle|set|enable|disable|start|stop|test|change|update|request)/i.test(method))
    return false;
  return null;
}

ipcMain.handle('sim:call', async (e, method, args) => {
  // Принимаем вызовы только от нашей страницы (file://), не от внешнего содержимого.
  const frameUrl = e && e.senderFrame && e.senderFrame.url;
  if (frameUrl && !frameUrl.startsWith('file:')) return { ok: false, error: 'forbidden' };
  if (typeof method !== 'string') return { ok: false, error: 'bad method' };
  args = Array.isArray(args) ? args : [];
  try {
    // Electron-native conveniences handled here directly.
    switch (method) {
      case 'copyToClipboard':
        clipboard.writeText(String(args[0] ?? ''));
        return true;
      case 'readClipboard':
        return clipboard.readText();
      case 'openUrl':
        return args[0] ? openExternalSafe(args[0]) : false;
      case 'showNotification': {
        // Имя приложения в уведомлениях — «Петрович», как в заголовке окна и ярлыке.
        // Рендерер шлёт старое «Квадрат Петровича» (общее с Android), здесь нормализуем.
        const title = String(args[0] ?? '');
        const notifTitle = title === 'Квадрат Петровича' ? 'Петрович' : title;
        try { new Notification({ title: notifTitle, body: String(args[1] ?? '') }).show(); } catch (_) {}
        return true;
      }
      case 'minimizeApp':
        if (win) win.minimize();
        return true;
      case 'getPendingDeepLink': {
        // Холодный старт: ссылка, с которой приложение было запущено из браузера.
        const u = pendingDeepLink;
        pendingDeepLink = null;
        return u || '';
      }
      case 'getDeviceId':
        // В тестовом режиме настоящий ID не отдаём: автотесты не должны заводить этот компьютер в боевой
        // журнал пробных периодов. Для проверки обмена с сервером можно задать тестовый SIM_TEST_DEVICE_ID.
        return process.env.SIM_SMOKE_TEST ? (process.env.SIM_TEST_DEVICE_ID || null) : getDeviceId();
      case 'getAppVersion':
        // Реальная версия desktop-сборки (из package.json) — чтобы проверка
        // обновлений сравнивала с актуальной, а не с веб-константой APP_VERSION.
        return JSON.stringify({ versionName: app.getVersion(), versionCode: 0 });
      case 'checkForUpdatesNow':
        // Ручная проверка из настроек. electron-updater сам качает в фоне.
        if (!app.isPackaged || !autoUpdater) return { ok: false, status: 'dev' };
        checkForUpdatesResolved().catch(() => {});
        return { ok: true, status: desktopUpdateState.status, version: desktopUpdateState.version };
      case 'getDesktopUpdateState':
        return desktopUpdateState;
      case 'quitAndInstallUpdate':
        // Немедленная установка по кнопке «Обновить и перезапустить».
        if (!autoUpdater) return { ok: false, error: 'updater not ready' };
        try { setImmediate(() => autoUpdater.quitAndInstall(true, true)); return { ok: true }; }
        catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
      case 'downloadAndInstallApk':
      case 'installDownloadedApk':
      case 'downloadUpdateApk':
        // Android-методы самообновления. На desktop обновляет electron-updater (проверка
        // sha512 из latest.yml); скачивание и запуск .exe по URL из рендерера убраны.
        return { ok: false, status: 'not_native', error: 'desktop updates are handled by electron-updater' };
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
    // Только собственные методы: без hasOwn через handlers['constructor'] и т.п.
    // достались бы методы прототипа Object.
    if (Object.prototype.hasOwnProperty.call(handlers, method)) return await handlers[method](...args);
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
    // Регистрируем приложение обработчиком схем sim:// и happ://. В MSIX схемы объявлены в манифесте
    // (запись в реестр из пакета уходит в приватный куст и системе не видна).
    if (!SMOKE_TEST && !process.windowsStore) {
      for (const s of DEEP_LINK_SCHEMES) {
        try { app.setAsDefaultProtocolClient(s); } catch (_) {}
      }
    }
    // Ссылка холодного старта (приложение открыли кликом по sim://-ссылке).
    pendingDeepLink = extractDeepLink(process.argv);

    installEditMenu(); // register Ctrl+C/V/X/A accelerators (menu bar stays hidden)
    createWindow(); // window first — keep startup snappy and the renderer stable
    setupAutoUpdater(); // фоновая докачка обновлений + тихая установка при выходе
    // Self-heal a previous crash (stray xray + stale system proxy) off the critical
    // startup path so the synchronous cleanup never stalls the renderer launch.
    if (!SMOKE_TEST) setTimeout(() => { try { recoverFromCrash().catch(() => {}); } catch (_) {} }, 300);
  });
}

// Always clear the system proxy on exit so we don't leave the machine broken.
// Выполняем очистку ровно один раз: раньше её вызывали подряд window-all-closed,
// before-quit и exit, и каждый раз она запускала PowerShell/reg заново.
// Второй экземпляр (его запускает клик по sim://-ссылке, single-instance lock он не
// получает) ничего чистить не должен — иначе он убьёт ядро и сбросит системный
// прокси у уже работающего первого экземпляра.
// stopVpnSync() полностью синхронный (с таймаутами), поэтому успевает завершиться и в
// обработчике 'exit', где промисы ждать нельзя.
let vpnShutdownDone = false;
function shutdownVpnOnce() {
  if (SMOKE_TEST || !gotTheLock || vpnShutdownDone) return;
  vpnShutdownDone = true;
  try { stopVpnSync(); } catch (_) {}
}

app.on('window-all-closed', () => {
  shutdownVpnOnce();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', shutdownVpnOnce);
process.on('exit', shutdownVpnOnce);
