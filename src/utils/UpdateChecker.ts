/**
 * UpdateChecker — проверка новой версии через GitHub Releases API.
 * Источники: sim-proxy-online/vpn_app и sim-proxy-online/petrovich — списки релизов
 * из обоих сливаются, берётся самый свежий релиз с файлом под нашу платформу.
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
// Репозитории-источники релизов: старый (vpn_app) и новый (petrovich — релизы и сайт).
// Проверяются оба: релиз может выйти только в одном из них, и приложение должно
// узнать о нём независимо от того, куда он выложен.
export const RELEASE_REPOS = ['sim-proxy-online/vpn_app', 'sim-proxy-online/petrovich'];
// Список релизов, а не /releases/latest: в репозитории релизы выходят и для одной
// платформы (например, только Windows-файлы), и «последний релиз» может не содержать
// APK — тогда Android-пользователям показывалось бы обновление, которого для них нет.
const apiReleases = (repo: string) => `https://api.github.com/repos/${repo}/releases?per_page=15`;
export const RELEASES_PAGE = `https://github.com/${RELEASE_REPOS[0]}/releases/latest`;

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

// Один запрос списка релизов. Бросает при сетевой или форматной ошибке — её
// гасит вызывающий: в checkForUpdate запросы идут через Promise.allSettled.
async function fetchReleaseList(repo: string): Promise<any[]> {
  const res = await nativeFetchUrl(apiReleases(repo));
  let body = '';
  if (typeof res === 'string') body = res;
  else if (res && typeof res === 'object') {
    if ((res as FetchResult).ok === false) throw new Error((res as FetchResult).error || 'Ошибка сети');
    body = (res as FetchResult).body || '';
  }
  if (!body.trim()) throw new Error('Пустой ответ GitHub');

  let parsed: any;
  try { parsed = JSON.parse(body); } catch { throw new Error('Некорректный ответ GitHub (не JSON)'); }
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Слияние списков релизов из разных репозиторий в один «от новых к старым».
 * GitHub отдаёт каждый список по убыванию published_at; между репозиториями
 * сравниваем дату публикации (created_at — запасной вариант), при равенстве —
 * тег (посегментно: v2.10.0 > v2.9.0, лексикография соврала бы). sort стабилен:
 * при полном равенстве сохраняется порядок репозиториев из RELEASE_REPOS.
 */
export function mergeReleaseLists(lists: any[][]): any[] {
  const merged = lists.flat().filter((r) => r && typeof r === 'object' && r.tag_name);
  return merged.sort((a, b) =>
    (Date.parse(b.published_at || b.created_at || '') || 0) - (Date.parse(a.published_at || a.created_at || '') || 0)
    || compareVersions(b.tag_name || '', a.tag_name || ''));
}

/** Проверить наличие обновления. Бросает только при сетевой ошибке. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  // Сборку из магазина (Microsoft Store, Google Play) обновляет магазин: ссылку на файл
  // из GitHub ей показывать нельзя.
  if (isStoreBuild()) {
    const current = await getCurrentVersion();
    return { hasUpdate: false, current, latest: current, pageUrl: RELEASES_PAGE };
  }
  // Два репозитория-источника: проверяем оба и работаем, даже если ответил
  // только один (лимит API, 404 у переименованного). Если пусто у обоих —
  // пробрасываем первую ошибку, вызывающий остаётся на текущей версии.
  const settled = await Promise.allSettled(RELEASE_REPOS.map(fetchReleaseList));
  const lists = settled
    .filter((s): s is PromiseFulfilledResult<any[]> => s.status === 'fulfilled')
    .map((s) => s.value);
  if (!lists.length) {
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    throw failed ? failed.reason : new Error('Ошибка сети');
  }

  const json: any = selectRelease(mergeReleaseLists(lists));
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
