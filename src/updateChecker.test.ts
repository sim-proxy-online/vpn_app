import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate, pickAssetUrl, selectRelease } from './utils/UpdateChecker';

const asset = (name: string) => ({ name, browser_download_url: `https://example.com/dl/${name}` });
const rel = (tag: string, names: string[], extra: Record<string, unknown> = {}) =>
  ({ tag_name: tag, draft: false, prerelease: false, assets: names.map(asset), ...extra });

describe('pickAssetUrl', () => {
  const assets = [asset('SimProxy-v2.4.9.apk'), asset('SimProxy-2.4.9-portable.exe'), asset('SimProxy-Setup-2.4.9.exe'), asset('latest.yml')];

  it('android takes the .apk', () => {
    expect(pickAssetUrl(assets, false)).toMatch(/\.apk$/);
  });

  it('desktop prefers the NSIS installer over portable, and falls back to any .exe', () => {
    expect(pickAssetUrl(assets, true)).toMatch(/Setup-2\.4\.9\.exe$/);
    expect(pickAssetUrl([asset('a-portable.exe'), asset('x.apk')], true)).toMatch(/portable\.exe$/);
    expect(pickAssetUrl([asset('x.apk')], true)).toBeUndefined();
  });

  it('returns undefined when nothing matches the platform', () => {
    expect(pickAssetUrl([asset('notes.txt')], false)).toBeUndefined();
  });
});

describe('Microsoft Store build', () => {
  afterEach(() => { delete (window as any).__SIM_STORE__; vi.unstubAllGlobals(); });

  it('never checks GitHub or offers a download: the store updates the app', async () => {
    (window as any).__SIM_STORE__ = true;
    const f = vi.fn().mockRejectedValue(new Error('network must not be touched'));
    vi.stubGlobal('fetch', f);
    const u = await checkForUpdate();
    expect(u.hasUpdate).toBe(false);
    expect(u.downloadUrl).toBeUndefined();
    expect(u.latest).toBe(u.current);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('Google Play build', () => {
  afterEach(() => { delete (window as any).SimNativeV2; vi.unstubAllGlobals(); });

  it('the native bridge marks the build as a store build, so GitHub is never asked', async () => {
    (window as any).SimNativeV2 = {
      isStoreBuild: () => true,
      getAppVersion: () => JSON.stringify({ versionName: '2.5.1', versionCode: 38, store: true }),
    };
    const f = vi.fn().mockRejectedValue(new Error('network must not be touched'));
    vi.stubGlobal('fetch', f);
    const u = await checkForUpdate();
    expect(u.hasUpdate).toBe(false);
    expect(u.downloadUrl).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('selectRelease', () => {
  // Как в реальном репозитории: свежие релизы без Windows-файлов, а один — без APK.
  const list = [
    rel('v2.6.0', ['SimProxy-Setup-2.6.0.exe', 'latest.yml']),          // только Windows
    rel('v2.5.1', ['SimProxy-v2.5.1.apk']),                              // только Android
    rel('v2.4.9', ['SimProxy-v2.4.9.apk', 'SimProxy-Setup-2.4.9.exe']),
  ];

  it('android skips a newer release that has no .apk', () => {
    expect(selectRelease(list, false).tag_name).toBe('v2.5.1');
  });

  it('desktop skips newer releases that have no installer', () => {
    expect(selectRelease(list, true).tag_name).toBe('v2.6.0');
    expect(selectRelease(list.slice(1), true).tag_name).toBe('v2.4.9');
  });

  it('ignores drafts and pre-releases', () => {
    const l = [rel('v9.0.0', ['a.apk'], { prerelease: true }), rel('v8.0.0', ['b.apk'], { draft: true }), ...list];
    expect(selectRelease(l, false).tag_name).toBe('v2.5.1');
  });

  it('falls back to the newest published release when no release has a suitable file', () => {
    expect(selectRelease([rel('v1.1.0', ['notes.txt']), rel('v1.0.0', [])], false).tag_name).toBe('v1.1.0');
  });

  it('returns null for an empty list', () => {
    expect(selectRelease([], false)).toBeNull();
  });
});
