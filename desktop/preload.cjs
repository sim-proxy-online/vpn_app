// Preload: injects window.SimNativeV2 implementing the contract the React
// renderer expects (see src/native/bridge.ts).
//
// Two calling conventions are used by the renderer:
//   • taskId-async  — n[method](...args, taskId); result delivered via
//                     window.onNativeTaskComplete(taskId, result). Return ignored.
//   • direct        — n[method](...args); the returned value/Promise is used.
// We classify by a hardcoded set (the only taskId methods in the renderer).
const { ipcRenderer } = require('electron');

const TASKID_METHODS = new Set([
  'startVpnWithResult',
  'pingServer',
  'pingProxyServer',
  'getPendingDeepLink',
  'warmupCore',
  'fetchUrl',
  'requestVpnPermission',
  'requestAllPermissions',
  'scanQrCode',
  'testProxyDelay',
  'startSpeedTest',
  'testIpLeak',
  // Пинг «через прокси» при выключенном VPN — поднимает временное ядро, меряет,
  // отдаёт мс через onNativeTaskComplete (как остальные taskId-методы).
  'measureDelay',
  // Резолв домена через прокси (Android: DoH сквозь SOCKS). На desktop не нужен —
  // Node.js резолвит DNS напрямую — возвращаем '' немедленно через taskId-путь.
  'resolveHostViaProxy',
  // Самообновление desktop: качаем .exe-инсталлятор и запускаем его. Результат
  // (InstallResult) должен вернуться в renderer через onNativeTaskComplete.
  'downloadAndInstallApk',
  'installDownloadedApk',
]);

// Synchronous boolean methods (used in `if (n.x(...))` style).
const SYNC_TRUE = new Set(['hasPermission']);

function complete(taskId, result) {
  try {
    if (typeof window.onNativeTaskComplete === 'function') {
      window.onNativeTaskComplete(taskId, result);
    }
  } catch (e) {
    console.error('onNativeTaskComplete failed', e);
  }
}

const bridge = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (SYNC_TRUE.has(prop)) return () => true;

      if (TASKID_METHODS.has(prop)) {
        return (...args) => {
          const taskId = args.pop();
          ipcRenderer
            .invoke('sim:call', prop, args)
            .then((r) => complete(taskId, r))
            .catch((err) => complete(taskId, { ok: false, error: String(err) }));
          return undefined;
        };
      }

      // Direct-return methods: hand back the Promise; the renderer awaits it.
      return (...args) => ipcRenderer.invoke('sim:call', prop, args);
    },
  }
);

window.SimNativeV2 = bridge;
window.__SIM_DESKTOP__ = true;
