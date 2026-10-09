/**
 * UpdateChecker — проверка новой версии через GitHub Releases API.
 * Репозиторий: sim-proxy-online/vpn_app.
 * Использует нативный HTTP (nativeFetchUrl), чтобы обойти CORS в WebView.
 */
import { nativeFetchUrl, nativeGetAppVersion, isStoreBuild, type FetchResult } from '../native/bridge';

// Запасное значение, если нативный слой недоступен (веб-режим). В установленном
// APK реальная версия берётся из getAppVersion() — см. getCurrentVersion().
// Источник версии один — "version" в package.json: Vite подставляет его сюда,
// а build.gradle читает тот же файл, так что при релизе поднимаем её в одном месте.
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

// Версия установленного приложения: нативная (источник истины) с откатом на
// константу. Кэшируется на сессию через Promise, чтобы конкурентные вызовы
// не запускали nativeGetAppVersion дважды (race condition с null-кешом).
let cachedVersionPromise: Promise<string> | null = null;
export function getCurrentVersion(): Promise<string> {
  if (!cachedVersionPromise) {
    cachedVersionPromise = (async () => {
      try {
        const v = await nativeGetAppVersion();
        if (v?.versionName) return v.versionName;
      } catch { /* веб-режим / старый мост */ }
      return APP_VERSION;
    })();
  }
  return cachedVersionPromise;
}
const REPO = 'sim-proxy-online/vpn_app';
// Список релизов, а не /releases/latest: в репозитории релизы выходят и для одной
// платформы (например, только Windows-файлы), и «последний релиз» может не содержать
// APK — тогда Android-пользователям показывалось бы обновление, которого для них нет.
const API_RELEASES = `https://api.github.com/repos/${REPO}/releases?per_page=15`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

export interface UpdateInfo {
  hasUpdate: boolean;
  current: string;
  latest: string;
  downloadUrl?: string;  // прямая ссылка на нужный платформе ассет (.apk на Android, .exe на Windows)
  pageUrl: string;       // страница релиза
  notes?: string;
}

// Desktop (Electron) выставляет этот флаг в preload — по нему выбираем .exe, а не .apk.
function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__SIM_DESKTOP__;
}

// Выбирает ассет релиза под платформу: Windows → инсталлятор .exe
// (предпочитаем NSIS «Setup», не portable), иначе → .apk.
export function pickAssetUrl(assets: any[], desktop: boolean = isDesktop()): string | undefined {
  const find = (pred: (name: string) => boolean): string | undefined => {
    const a = assets.find((x) => typeof x?.browser_download_url === 'string'
      && pred(String(x.name || x.browser_download_url).toLowerCase()));
    return a?.browser_download_url;
  };
  if (desktop) {
    return find((n) => n.includes('setup') && n.endsWith('.exe'))  // NSIS-инсталлятор
        || find((n) => n.endsWith('.exe') && !n.includes('portable'))
        || find((n) => n.endsWith('.exe'));
  }
  return find((n) => n.endsWith('.apk'));
}

/** Сравнение semver-строк ("2.0.4" vs "2.1.0"). >0 если a новее b. */
export function compareVersions(a: string, b: string): number {
  // Убираем build metadata (+build.xxx) до сплита — parseInt('build')===0 давал ложные результаты
  const clean = (s: string) => s.replace(/^v/i, '').replace(/[-+].*$/, '');
  const pa = clean(a).split(/[.-]/).map(n => Number.parseInt(n, 10) || 0);
  const pb = clean(b).split(/[.-]/).map(n => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Из списка релизов (GitHub отдаёт от новых к старым) берёт самый свежий опубликованный
 * не-пре-релиз, у которого есть файл под нашу платформу. Если ни у одного нет — самый
 * свежий опубликованный (прежнее поведение: пользователь увидит страницу релиза).
 */
export function selectRelease(releases: any[], desktop: boolean = isDesktop()): any | null {
  const published = releases.filter((r) => r && !r.draft && !r.prerelease);
  const withAsset = published.find((r) => Array.isArray(r.assets) && pickAssetUrl(r.assets, desktop));
  return withAsset ?? published[0] ?? null;
}

/** Проверить наличие обновления. Бросает только при сетевой ошибке. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  // Сборку из магазина (Microsoft Store, Google Play) обновляет магазин: ссылку на файл
  // из GitHub ей показывать нельзя.
  if (isStoreBuild()) {
    const current = await getCurrentVersion();
    return { hasUpdate: false, current, latest: current, pageUrl: RELEASES_PAGE };
  }
  const res = await nativeFetchUrl(API_RELEASES);
  let body = '';
  if (typeof res === 'string') body = res;
  else if (res && typeof res === 'object') {
    if ((res as FetchResult).ok === false) throw new Error((res as FetchResult).error || 'Ошибка сети');
    body = (res as FetchResult).body || '';
  }
  if (!body.trim()) throw new Error('Пустой ответ GitHub');

  let parsed: any;
  try { parsed = JSON.parse(body); } catch { throw new Error('Некорректный ответ GitHub (не JSON)'); }
  const json: any = Array.isArray(parsed) ? selectRelease(parsed) : parsed;
  if (!json) throw new Error('Релизы не найдены');
  const latestTag: string = json.tag_name || json.name || '';
  const latest = latestTag.replace(/^v/i, '');
  const pageUrl: string = json.html_url || RELEASES_PAGE;
  const notes: string = json.body || '';

  const downloadUrl = Array.isArray(json.assets) ? pickAssetUrl(json.assets) : undefined;

  const current = await getCurrentVersion();
  return {
    hasUpdate: latest !== '' && compareVersions(latest, current) > 0,
    current,
    latest: latest || current,
    downloadUrl,
    pageUrl,
    notes,
  };
}
