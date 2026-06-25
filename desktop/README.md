# SimProxy — Windows desktop client (Electron)

Reuses the existing React UI (`src/`, built by Vite into `dist/index.html`) and
drives a bundled **xray.exe** via a desktop "native" bridge that mirrors the
`window.SimNativeV2` contract the renderer expects (see `src/native/bridge.ts`).

## Networking mode (v1)

**System proxy** — no admin, no TUN. xray exposes a local HTTP inbound
(`127.0.0.1:12334`) + SOCKS (`127.0.0.1:12335`); the app points the Windows
system proxy (WinINET registry + refresh) at the HTTP inbound. Apps that honour
the system proxy (browsers, most desktop apps) route through it. The proxy is
always cleared on disconnect/quit.

TUN/full-VPN mode (route everything, needs admin + wintun) is a planned follow-up.

## Files

- `main.cjs` — Electron main process: window, IPC routing, Electron-native
  conveniences (clipboard/notifications/openUrl), default stubs for
  not-yet-implemented methods so the UI never breaks.
- `preload.cjs` — injects `window.SimNativeV2`. Splits the renderer's two calling
  conventions: taskId-async (`fetchUrl`, `pingServer`, `startVpnWithResult`, …)
  vs direct-return (`getVpnStatus`, `stopVpn`, `getStats`, …).
- `bridge.cjs` — the real logic: config adaptation (strip Android TUN inbound,
  add HTTP+SOCKS), spawn/stop xray.exe, Windows system proxy, TCP ping, HTTP
  fetch, stats, core version. Depends only on Node core — unit-testable without
  Electron.
- `resources/` — `xray.exe` + `geoip.dat` + `geosite.dat` (bundled into the app
  under `resources/xray/` by electron-builder `extraResources`).
- `electron-builder.yml` — portable x64 target → `dist-exe/SimProxy-<ver>-portable.exe`.

## Develop

```powershell
npm run desktop:dev      # vite build + launch Electron against dist/
```

## Build the .exe

```powershell
npm run desktop:build    # portable single-file exe -> desktop/dist-exe/
# or unpacked folder (no installer tooling needed):
npm run desktop:pack     # -> desktop/dist-exe/win-unpacked/SimProxy.exe
```

## Notes / gotchas

- **`ELECTRON_RUN_AS_NODE`**: if this env var is set to `1` (it is on some CI/dev
  sandboxes), `electron.exe` runs the main script as plain Node and
  `require('electron')` returns a path string instead of the API. Clear it before
  launching: `Remove-Item Env:\ELECTRON_RUN_AS_NODE`. End users are unaffected.
- **GitHub throttling (RU)**: electron / electron-builder binaries and xray are
  pulled via the `npmmirror.com` mirror. Set
  `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` to the npmmirror paths
  if a fresh machine can't reach github.com.
- Ports `12334` (HTTP) / `12335` (SOCKS) are fixed in `bridge.cjs`.
