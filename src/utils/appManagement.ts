/**
 * Управление приложением со стороны провайдера подписки — по образцу Happ
 * (https://www.happ.su/main/ru/dev-docs/app-management).
 *
 * Провайдер кладёт параметры в HTTP-заголовки ответа подписки или в первые строки тела
 * вида «#имя-параметра: значение». Здесь они разбираются, проверяются и применяются.
 *
 * У Happ расширенные параметры доступны только провайдерам с проверенным Provider ID. Реестра
 * провайдеров у нас нет, поэтому вместо него — уровни доверия:
 *  • безопасные (текст объявления, срок подписки, кнопки-ссылки, порядок серверов, закрепление и
 *    раскрытие подписки) показываются всегда и ничего не меняют в работе VPN;
 *  • настройки приложения (фрагментация, шумы, sniffing, mux, автоподключение, тип пинга, смена
 *    адреса подписки, User-Agent, приложения и подсети в обход туннеля) применяются только
 *    доверенному профилю: встроенный пробный, адрес из TRUSTED_HOSTS или профиль, которому
 *    пользователь сам разрешил управление. Для остальных настройки ждут разрешения
 *    (managed.pending) и не применяются;
 *  • то, что подменяет учётные данные или заменяет туннель (custom-tunnel-config, socks/http-auth…),
 *    не применяется никогда.
 *
 * Описание сервера (serverDescription) — не параметр подписки, а параметр каждого сервера: оно
 * разбирается из ссылки сервера или из meta конфига, см. linkMeta.ts.
 *
 * Значения проверяются и ограничиваются: подписка не должна суметь выставить, например,
 * интервал фрагментации в минуту или ссылку на чужую схему, а списки обхода — подсеть 0.0.0.0/0.
 */
import type { ManagedProfileState, SubscriptionProfile, SubscriptionTraffic } from '../types';
import { planExcludeRoutes, planPerApp } from './managedLists';
import { parseColorProfile } from './providerColor';

export type ParamBag = Record<string, string>;
export type InfoColor = 'red' | 'blue' | 'green';
export type SettingValue = string | number | boolean;
export type SettingWriter = (key: string, value: SettingValue) => void;

export interface ManagedParams {
  announce?: string;
  /** Адрес кабинета (x-cabinet-url): куда приложение открывает продление подписки. */
  cabinetUrl?: string;
  info?: { text: string; color: InfoColor; buttonText?: string; buttonLink?: string };
  expire?: { warn: boolean; notify: boolean; buttonLink?: string };
  sortType?: 'without' | 'ping' | 'alphabet';
  pin?: boolean;
  expandNow?: boolean;
  alwaysExpanded?: boolean;
  userAgent?: string;
  /** Фирменный цвет провайдера (#rrggbb) из color-profile; нет — подписка в нашей теме. */
  accent?: string;
  /** Готовые, уже проверенные ключи настроек приложения (sim-*). Применяются только доверенным профилям. */
  settings: Record<string, SettingValue>;
  autoUpdate?: boolean;
  hideSettings?: boolean;
  newUrl?: string;
  newDomain?: string;
  fallbackUrl?: string;
  /** Известные параметры Happ, которые приложение не поддерживает. */
  ignored: string[];
  /** Параметры, значение которых не прошло проверку. */
  rejected: string[];
}

/** Адреса провайдеров, которым доверяем управление настройками без отдельного разрешения. */
export const TRUSTED_HOSTS = ['petrovich.party', 'sim-proxy.biz', 'sim-proxy.online'];

// Параметры, которые уже читает parseSubscription отдельно — здесь не считаются «неподдерживаемыми».
const HANDLED_ELSEWHERE = new Set(['profile-title', 'profile-update-interval', 'subscription-userinfo', 'support-url', 'profile-web-page-url']);

// Применяются (после проверки и только доверенным профилям).
const TUNING_KEYS = new Set([
  'fragmentation-enable', 'fragmentation-packets', 'fragmentation-length', 'fragmentation-interval', 'fragmentation-maxsplit',
  'noises-enable', 'noises-packet-type', 'noises-packet', 'noises-delay', 'noises-rand', 'noises-rand-range',
  'sniffing-enable', 'mux-enable', 'mux-tcp-connections', 'subscription-autoconnect', 'subscription-auto-update-enable',
  'hide-settings', 'new-url', 'new-domain', 'fallback-url',
  'ping-type', 'routing-enable', 'subscription-autoconnect-type', 'subscription-auto-update-open-enable',
  'subscription-ping-onopen-enabled', 'change-user-agent',
  'per-app-proxy-mode', 'per-app-proxy-list', 'per-app-proxy-list-invert', 'per-app-proxy-list-set',
  'exclude-routes', 'exclude-routes-set',
]);

// Показываются всем: ничего не меняют в работе VPN.
const SAFE_KEYS = new Set([
  'announce', 'sub-info-text', 'sub-info-color', 'sub-info-button-text', 'sub-info-button-link',
  'sub-expire', 'sub-expire-button-link', 'notification-subs-expire',
  'x-cabinet-url',
  'subscriptions-sort-type', 'subscription-pin', 'subscriptions-collapse', 'subscriptions-expand-now',
  'color-profile',
]);

// Известны по документации Happ, но в приложении не реализованы (нет такой функции или это настройки
// другой платформы) или намеренно отключены — см. шапку файла.
const IGNORED_KEYS = new Set([
  'custom-tunnel-config', 'socks-auth-mode', 'socks-auth-user', 'socks-auth-password',
  'http-auth-mode', 'http-auth-user', 'http-auth-password', 'tun-type', 'app-auto-start',
  'check-url-via-proxy', 'ping-result', 'proxy-ping-timeout', 'proxy-ping-mode',
  'manual-block-user-agent', 'user-agent-geo-files', 'subscription-always-hwid-enable', 'subscription-alternative-hwid-enabled',
  'mux-xudp-connections', 'mux-quic', 'no-limit-enabled', 'no-limit-xhttp-enabled',
  'dns-from-json-enable', 'server-address-resolve-enable', 'server-address-resolve-dns-domain', 'server-address-resolve-dns-ip',
  'proxy-enable', 'tun-enable', 'tun-mode', 'xray-tun-enable', 'xray-tun-mtu', 'include-all-networks-enable',
  'exclude-local-networks-enable', 'exclude-apns-enable', 'inbound-http-enable',
  'dont-use-filter', 'subscription-request-timeout', 'hide-vpn-icon', 'block-bind-to-tunnel-enable',
]);

/** Все заголовки, которые нужно забрать из ответа подписки, чтобы разобрать параметры управления (браузерный путь читает заголовки по списку). */
export const MANAGEMENT_HEADER_KEYS: string[] = Array.from(new Set([...TUNING_KEYS, ...SAFE_KEYS, ...IGNORED_KEYS, ...HANDLED_ELSEWHERE]));

function isKnownKey(k: string): boolean {
  return TUNING_KEYS.has(k) || SAFE_KEYS.has(k) || IGNORED_KEYS.has(k) || HANDLED_ELSEWHERE.has(k);
}

/** Параметры из заголовков и тела («#ключ: значение»); заголовок важнее строки тела. Чужие ключи отбрасываются. */
export function collectParams(headers: Record<string, string> | undefined, body: string): ParamBag {
  const bag: ParamBag = {};
  for (const line of body.split(/\r?\n/).slice(0, 80)) {
    const m = /^#\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase().replace(/_/g, '-');
    if (isKnownKey(k)) bag[k] = m[2].trim();
  }
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      const k = name.toLowerCase();
      if (isKnownKey(k) && value != null) bag[k] = String(value).trim();
    }
  }
  return bag;
}

/** «true» и «1» включают, любое другое непустое значение выключает (как у Happ). */
export function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  return /^(1|true)$/i.test(v.trim());
}

function decodeBase64Text(v: string): string {
  try {
    const bin = atob(v.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return v; }
}

/** Текст параметра: «base64:…» декодируется, управляющие символы убираются, длина ограничивается. */
export function cleanText(v: string | undefined, max: number): string | undefined {
  if (v === undefined) return undefined;
  let s = v.trim();
  if (/^base64:/i.test(s)) s = decodeBase64Text(s.slice(7).trim());
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

/** Диапазон «a» или «a-b» с ограничением значений. */
export function normRange(v: string | undefined, min: number, max: number): string | undefined {
  const m = /^\s*(\d{1,5})(?:\s*-\s*(\d{1,5}))?\s*$/.exec(v ?? '');
  if (!m) return undefined;
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const a = clamp(Number(m[1]));
  if (m[2] === undefined) return String(a);
  const b = clamp(Number(m[2]));
  return a <= b ? `${a}-${b}` : `${b}-${a}`;
}

function isPrivateHost(h: string): boolean {
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
    || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '::1' || h.startsWith('[');
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;

/** https-ссылка без логина и пароля на не локальный адрес; иначе undefined. */
export function safeHttpsUrl(v: string | undefined): string | undefined {
  if (!v || v.length > 2048) return undefined;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return undefined;
    if (isPrivateHost(u.hostname.toLowerCase())) return undefined;
    return u.toString();
  } catch { return undefined; }
}

/** Ссылка для кнопки: https или tg. */
export function safeButtonLink(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (/^tg:\/\/[\w./?=&%-]{1,300}$/i.test(v.trim())) return v.trim();
  return safeHttpsUrl(v);
}

export function safeHostname(v: string | undefined): string | undefined {
  const h = (v ?? '').trim().toLowerCase();
  return HOSTNAME_RE.test(h) && !isPrivateHost(h) ? h : undefined;
}

/** Новый адрес подписки: полный (new-url) или с заменой только домена (new-domain, путь сохраняется). */
export function migrateUrl(currentUrl: string, newUrl?: string, newDomain?: string): string | undefined {
  const full = safeHttpsUrl(newUrl);
  if (full) return full;
  const host = safeHostname(newDomain);
  if (!host) return undefined;
  try {
    const u = new URL(currentUrl);
    u.hostname = host;
    u.port = '';
    return u.toString();
  } catch { return undefined; }
}

const NOISE_TYPES: Record<string, string> = { array: 'rand', rand: 'rand', str: 'str', hex: 'hex', base64: 'base64' };

/** Разбирает и проверяет параметры; undefined, если провайдер ничего не прислал. */
export function extractManagedParams(headers: Record<string, string> | undefined, body: string): ManagedParams | undefined {
  const bag = collectParams(headers, body);
  const keys = Object.keys(bag).filter((k) => !HANDLED_ELSEWHERE.has(k));
  if (keys.length === 0) return undefined;

  const out: ManagedParams = { settings: {}, ignored: [], rejected: [] };
  const reject = (k: string) => { if (!out.rejected.includes(k)) out.rejected.push(k); };
  const put = (key: string, value: SettingValue | undefined, param: string) => {
    if (value === undefined) { reject(param); return; }
    out.settings[key] = value;
  };
  const bool = (param: string): boolean | undefined => {
    const b = parseBool(bag[param]);
    if (b === undefined && param in bag) reject(param);
    return b;
  };

  for (const k of keys) if (IGNORED_KEYS.has(k)) out.ignored.push(k);

  // ── безопасные ──
  out.announce = cleanText(bag['announce'], 200);
  // Адрес кабинета: только https и не локальный хост (safeHttpsUrl), иначе параметр отбрасывается.
  if ('x-cabinet-url' in bag) {
    out.cabinetUrl = safeHttpsUrl(bag['x-cabinet-url']);
    if (!out.cabinetUrl) reject('x-cabinet-url');
  }
  const infoText = cleanText(bag['sub-info-text'], 200);
  if (infoText) {
    const c = (bag['sub-info-color'] || '').toLowerCase();
    out.info = {
      text: infoText,
      color: c === 'red' || c === 'green' ? c : 'blue',
      buttonText: cleanText(bag['sub-info-button-text'], 25),
      buttonLink: safeButtonLink(bag['sub-info-button-link']),
    };
    if (out.info.buttonText && !out.info.buttonLink) out.info.buttonText = undefined;
  }
  if ('sub-expire' in bag || 'notification-subs-expire' in bag) {
    out.expire = {
      warn: parseBool(bag['sub-expire']) === true,
      notify: parseBool(bag['notification-subs-expire']) === true,
      buttonLink: safeButtonLink(bag['sub-expire-button-link']),
    };
  }

  // ── вид списка подписок: порядок серверов, закрепление, раскрытие ──
  if ('subscriptions-sort-type' in bag) {
    const s = bag['subscriptions-sort-type'].trim().toLowerCase();
    if (s === 'without' || s === 'ping' || s === 'alphabet') out.sortType = s; else reject('subscriptions-sort-type');
  }
  out.pin = bool('subscription-pin');
  // «subscriptions-collapse: 0» — список серверов всегда раскрыт; «expand-now: 1» — раскрыть сейчас (false игнорируется).
  if (parseBool(bag['subscriptions-collapse']) === false) out.alwaysExpanded = true;
  if (parseBool(bag['subscriptions-expand-now']) === true) out.expandNow = true;

  // Цвет подписки: из темы Happ берётся один акцент (см. providerColor.ts); «resetcolors» и отсутствие параметра — наш цвет.
  if ('color-profile' in bag) {
    const cp = parseColorProfile(bag['color-profile']);
    if (cp) out.accent = cp.accent; else reject('color-profile');
  }

  // ── фрагментация ──
  const fragEnable = bool('fragmentation-enable');
  if (fragEnable !== undefined) out.settings['sim-frag-enable'] = fragEnable;
  if ('fragmentation-packets' in bag) {
    const p = bag['fragmentation-packets'].trim().toLowerCase();
    put('sim-frag-packets', p === 'tlshello' ? p : /^\d{1,2}(-\d{1,2})?$/.test(p) ? p : undefined, 'fragmentation-packets');
  }
  if ('fragmentation-length' in bag) put('sim-frag-length', normRange(bag['fragmentation-length'], 1, 2000), 'fragmentation-length');
  if ('fragmentation-interval' in bag) put('sim-frag-interval', normRange(bag['fragmentation-interval'], 0, 500), 'fragmentation-interval');
  if ('fragmentation-maxsplit' in bag) put('sim-frag-maxsplit', normRange(bag['fragmentation-maxsplit'], 1, 2000), 'fragmentation-maxsplit');

  // ── шумы (в Xray действуют только на UDP) ──
  const noisesEnable = bool('noises-enable');
  if (noisesEnable !== undefined) out.settings['sim-noises-enable'] = noisesEnable;
  let noiseType = 'rand';
  if ('noises-packet-type' in bag) {
    const t = NOISE_TYPES[bag['noises-packet-type'].trim().toLowerCase()];
    if (t) { noiseType = t; out.settings['sim-noises-type'] = t; } else reject('noises-packet-type');
  }
  if ('noises-delay' in bag) put('sim-noises-delay', normRange(bag['noises-delay'], 0, 5000), 'noises-delay');
  if ('noises-rand' in bag && noiseType === 'rand') put('sim-noises-rand', normRange(bag['noises-rand'], 1, 8192), 'noises-rand');
  if ('noises-packet' in bag && noiseType !== 'rand') {
    const p = cleanText(bag['noises-packet'], 512);
    put('sim-noises-rand', p, 'noises-packet');
  }

  // ── прочие настройки ──
  const sniffing = bool('sniffing-enable');
  if (sniffing !== undefined) out.settings['sim-sniffing'] = sniffing;
  const mux = bool('mux-enable');
  if (mux !== undefined) out.settings['sim-mux-enabled'] = mux;
  if ('mux-tcp-connections' in bag) {
    const n = Number.parseInt(bag['mux-tcp-connections'], 10);
    put('sim-mux-concurrency', Number.isFinite(n) && n >= 1 && n <= 128 ? n : undefined, 'mux-tcp-connections');
  }
  const autoConnect = bool('subscription-autoconnect');
  if (autoConnect !== undefined) out.settings['sim-autoconnect'] = autoConnect;
  if ('subscription-autoconnect-type' in bag) {
    const t = bag['subscription-autoconnect-type'].trim().toLowerCase();
    put('sim-autoconnect-type', t === 'lastused' || t === 'lowestdelay' || t === 'random' ? t : undefined, 'subscription-autoconnect-type');
  }
  const updateOnOpen = bool('subscription-auto-update-open-enable');
  if (updateOnOpen !== undefined) out.settings['sim-update-on-open'] = updateOnOpen;
  const pingOnOpen = bool('subscription-ping-onopen-enabled');
  if (pingOnOpen !== undefined) out.settings['sim-ping-on-open'] = pingOnOpen;
  // Способ пинга: у нас два — реальный запрос через прокси и TCP; proxy-head — тот же запрос через прокси, icmp в приложении нет.
  if ('ping-type' in bag) {
    const t = bag['ping-type'].trim().toLowerCase();
    put('sim-ping-mode', t === 'proxy' || t === 'proxy-head' ? 'proxy' : t === 'tcp' || t === 'icmp' ? 'tcp' : undefined, 'ping-type');
  }
  // routing-enable: 0 отключает правила маршрутизации — весь трафик через VPN. Включение ничего не меняет.
  if (parseBool(bag['routing-enable']) === false) out.settings['sim-routing'] = 'global';
  out.autoUpdate = bool('subscription-auto-update-enable');
  out.hideSettings = bool('hide-settings');
  if ('change-user-agent' in bag) {
    const ua = bag['change-user-agent'].trim();
    if (/^[\x20-\x7e]{1,200}$/.test(ua)) out.userAgent = ua; else reject('change-user-agent');
  }

  // ── приложения и подсети в обход туннеля (применяет managedNative.ts, только доверенному профилю) ──
  const perApp = planPerApp(bag['per-app-proxy-mode'], bag['per-app-proxy-list'], bag['per-app-proxy-list-invert'], bag['per-app-proxy-list-set']);
  if (perApp === null) { reject('per-app-proxy-mode'); }
  else if (perApp) out.settings['sim-managed-per-app'] = JSON.stringify(perApp);
  const exclude = planExcludeRoutes(bag['exclude-routes'], bag['exclude-routes-set']);
  if (exclude === null) { reject('exclude-routes-set' in bag ? 'exclude-routes-set' : 'exclude-routes'); }
  else if (exclude) out.settings['sim-managed-exclude-routes'] = JSON.stringify(exclude);

  // ── адрес подписки ──
  if ('new-url' in bag) { out.newUrl = safeHttpsUrl(bag['new-url']); if (!out.newUrl) reject('new-url'); }
  if ('new-domain' in bag) { out.newDomain = safeHostname(bag['new-domain']); if (!out.newDomain) reject('new-domain'); }
  if ('fallback-url' in bag) { out.fallbackUrl = safeHttpsUrl(bag['fallback-url']); if (!out.fallbackUrl) reject('fallback-url'); }

  return out;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

export function hostMatches(host: string, suffixes: string[]): boolean {
  return suffixes.some((s) => host === s || host.endsWith('.' + s));
}

/** Доверенный профиль: с адресом из TRUSTED_HOSTS или с разрешением пользователя. */
export function isTrustedProfile(p: Pick<SubscriptionProfile, 'id' | 'url' | 'managed'>): boolean {
  return p.managed?.trusted === true || (!!p.url && hostMatches(hostOf(p.url), TRUSTED_HOSTS));
}

const writeLocalStorage: SettingWriter = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* хранилище недоступно */ }
};

/**
 * Применяет разобранные параметры к профилю. Безопасные идут в profile.managed всегда; настройки
 * приложения и смена адреса подписки — только доверенному профилю, остальным настройки ждут в
 * managed.pending, пока пользователь не разрешит управление (см. trustProfile).
 */
export function applyManagement(profile: SubscriptionProfile, params: ManagedParams | undefined, write: SettingWriter = writeLocalStorage): SubscriptionProfile {
  if (!params) return profile;
  const trusted = isTrustedProfile(profile);
  const hasSettings = Object.keys(params.settings).length > 0;
  const managed: ManagedProfileState = {
    ...profile.managed,
    announce: params.announce,
    // Заголовок может прийти не со всех адресов подписки — старый адрес кабинета сохраняем.
    cabinetUrl: params.cabinetUrl ?? profile.managed?.cabinetUrl,
    info: params.info,
    expire: params.expire,
    hideSettings: trusted ? params.hideSettings : undefined,
    fallbackUrl: trusted ? params.fallbackUrl : undefined,
    sortType: params.sortType,
    pinned: params.pin,
    expandNow: params.expandNow,
    alwaysExpanded: params.alwaysExpanded,
    accent: params.accent,
    // Запоминаем всегда, а применяем (userAgentFor) только доверенному профилю — тогда разрешение пользователя подействует сразу.
    userAgent: params.userAgent,
    pending: !trusted && hasSettings ? params.settings : undefined,
    appliedCount: 0,
    ignored: params.ignored.length ? params.ignored : undefined,
    rejected: params.rejected.length ? params.rejected : undefined,
  };
  let next: SubscriptionProfile = { ...profile, managed };

  if (trusted) {
    for (const [k, v] of Object.entries(params.settings)) write(k, v);
    managed.appliedCount = Object.keys(params.settings).length;
    if (params.autoUpdate !== undefined) next = { ...next, autoUpdate: params.autoUpdate };
    const migrated = migrateUrl(profile.url, params.newUrl, params.newDomain);
    if (migrated && migrated !== profile.url) next = { ...next, url: migrated };
  }
  return next;
}

/** Разрешить или запретить провайдеру управлять настройками; при разрешении сразу применяет ожидавшие. */
export function trustProfile(profile: SubscriptionProfile, trusted: boolean, write: SettingWriter = writeLocalStorage): SubscriptionProfile {
  const managed: ManagedProfileState = { ...profile.managed, trusted };
  if (trusted && managed.pending) {
    for (const [k, v] of Object.entries(managed.pending)) write(k, v);
    managed.appliedCount = Object.keys(managed.pending).length;
    managed.pending = undefined;
  }
  return { ...profile, managed };
}

const DAY_MS = 86_400_000;

/** User-Agent для запросов подписки: только доверенному профилю и только если провайдер его прислал. */
export function userAgentFor(p: Pick<SubscriptionProfile, 'id' | 'url' | 'managed'>): string | undefined {
  return isTrustedProfile(p) ? p.managed?.userAgent : undefined;
}

/**
 * Текст предупреждения об окончании подписки (за 3 дня и после), если провайдер его включил; иначе null.
 * У Happ это два разных параметра: sub-expire — плашка в приложении (kind 'banner'), notification-subs-expire —
 * push-уведомление раз в сутки (kind 'push').
 */
export function expiryNotice(p: SubscriptionProfile, now = Date.now(), kind: 'banner' | 'push' = 'banner'): string | null {
  const e = p.managed?.expire;
  const expire = p.traffic?.expire;
  if (!e || !(kind === 'banner' ? e.warn : e.notify) || !expire) return null;
  const left = expire * 1000 - now;
  if (left > 3 * DAY_MS) return null;
  if (left <= 0) return `Подписка «${p.name}» закончилась`;
  const days = Math.max(1, Math.ceil(left / DAY_MS));
  return `Подписка «${p.name}» закончится через ${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}`;
}

/**
 * Статус профиля по данным трафика: >95% или ≤1 день — истёк, >80% или ≤7 дней — внимание.
 * Один и тот же расчёт используется и при добавлении профиля, и при каждом обновлении — иначе
 * у свежедобавленной истекающей подписки бейдж остаётся «Активен», а кнопка продления
 * появляется только после первого обновления.
 */
export function statusFromTraffic(t: SubscriptionTraffic | undefined): SubscriptionProfile['status'] {
  if (!t) return 'healthy';
  if ((t.usagePercentage || 0) > 95 || (t.remainingDays !== undefined && t.remainingDays <= 1)) return 'expired';
  if ((t.usagePercentage || 0) > 80 || (t.remainingDays !== undefined && t.remainingDays <= 7)) return 'warning';
  return 'healthy';
}

/**
 * Пересчитывает остаток дней и статус по сроку трафика. Статус профиля —
 * снимок на момент обновления подписки, а часы идут: без этого бейдж
 * «Активен» доживает до следующего обновления, даже когда срок вышел.
 * Статус 'error' (ошибка обновления) трафиком не перетирается.
 */
export function refreshExpiry(profiles: SubscriptionProfile[], now = Date.now()): SubscriptionProfile[] {
  let changed = false;
  const out = profiles.map(p => {
    const tr = p.traffic;
    if (!tr?.expire) return p;
    const days = Math.max(0, Math.ceil((tr.expire * 1000 - now) / DAY_MS));
    const traffic = tr.remainingDays === days ? tr : { ...tr, remainingDays: days };
    if (p.status === 'error') return traffic === tr ? p : (changed = true, { ...p, traffic });
    const status = statusFromTraffic(traffic);
    if (traffic === tr && status === p.status) return p;
    changed = true;
    return { ...p, traffic, status };
  });
  return changed ? out : profiles;
}
