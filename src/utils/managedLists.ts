/**
 * Разбор списков из параметров управления провайдера (Happ): приложения в обход/через VPN
 * (per-app-proxy-*) и подсети в обход туннеля (exclude-routes*). Только проверка и план — сами
 * изменения выполняет managedNative.ts, и только для доверенного профиля (см. appManagement.ts).
 *
 * Эти параметры могут пустить трафик мимо туннеля, поэтому проверка строгая: мусор отбрасывается,
 * а слишком широкие префиксы (0.0.0.0/0, 128.0.0.0/1…), которые вывели бы весь трафик мимо VPN, отклоняются.
 */

export interface PerAppPlan {
  /** on — только перечисленные приложения идут через VPN; bypass — перечисленные идут мимо VPN. */
  mode: 'on' | 'bypass';
  list: string[];
  /** true — сначала убрать прежние отметки этого вида (варианты «-set»). */
  replace: boolean;
}

export interface ExcludePlan {
  list: string[];
  replace: boolean;
}

const MAX_ITEMS = 200;
const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
// Само приложение нельзя ни пускать мимо туннеля, ни исключать из списка «через VPN» — иначе петля.
const SELF_PACKAGES = new Set(['party.petrovich.app', 'com.simproxy.app']);

export function splitList(v: string | undefined): string[] {
  return (v ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

/** Список имён пакетов Android; недопустимые отбрасываются, пусто → undefined. */
export function parsePackageList(v: string | undefined): string[] | undefined {
  const items = splitList(v);
  if (items.length === 0 || items.length > MAX_ITEMS) return undefined;
  const ok = items.filter((i) => i.length <= 255 && PKG_RE.test(i) && !SELF_PACKAGES.has(i));
  return ok.length ? Array.from(new Set(ok)) : undefined;
}

/**
 * per-app-proxy-mode + один из списков. Возвращает undefined, если делать нечего (параметров нет, режим off
 * или есть только режим), null — если параметры есть, но непригодны (их нужно отклонить).
 *  • list: перечисленные приложения получают режим;
 *  • list-invert: «все, кроме перечисленных» — значит перечисленным достаётся противоположный режим;
 *  • list-set: как list, но прежние отметки этого вида сначала снимаются.
 */
export function planPerApp(modeRaw: string | undefined, list?: string, invert?: string, set?: string): PerAppPlan | null | undefined {
  if (modeRaw === undefined && list === undefined && invert === undefined && set === undefined) return undefined;
  const mode = (modeRaw ?? '').trim().toLowerCase();
  if (mode === 'off') return undefined;
  if (mode !== 'on' && mode !== 'bypass') return null;
  const src = set !== undefined ? { v: set, replace: true, inv: false }
    : list !== undefined ? { v: list, replace: false, inv: false }
    : invert !== undefined ? { v: invert, replace: false, inv: true }
    : undefined;
  if (!src) return undefined;
  const pkgs = parsePackageList(src.v);
  if (!pkgs) return null;
  const effective: 'on' | 'bypass' = src.inv ? (mode === 'on' ? 'bypass' : 'on') : mode;
  return { mode: effective, list: pkgs, replace: src.replace };
}

function ipv4Ok(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(s);
  if (!m) return false;
  if ([m[1], m[2], m[3], m[4]].some((o) => Number(o) > 255)) return false;
  if (m[5] === undefined) return true;
  const p = Number(m[5]);
  return p >= 8 && p <= 32;
}

function ipv6Ok(s: string): boolean {
  const m = /^([0-9a-f:]{2,45})(?:\/(\d{1,3}))?$/i.exec(s);
  if (!m || !m[1].includes(':')) return false;
  if (m[2] === undefined) return true;
  const p = Number(m[2]);
  return p >= 16 && p <= 128;
}

/** Адрес или подсеть, которую можно пустить мимо туннеля. Префиксы короче /8 (IPv6 — /16) не принимаются. */
export function isSafeExcludeRoute(s: string): boolean {
  return ipv4Ok(s) || ipv6Ok(s);
}

/**
 * exclude-routes (добавить) и exclude-routes-set (заменить). undefined — параметров нет; null — ничего пригодного.
 * Пустое значение у «-set» — это команда очистить список.
 */
export function planExcludeRoutes(add?: string, set?: string): ExcludePlan | null | undefined {
  if (add === undefined && set === undefined) return undefined;
  const replace = set !== undefined;
  const items = splitList(replace ? set : add);
  if (items.length > MAX_ITEMS) return null;
  const ok = items.filter(isSafeExcludeRoute);
  if (items.length > 0 && ok.length === 0) return null;
  if (items.length === 0 && !replace) return undefined;
  return { list: Array.from(new Set(ok)), replace };
}
