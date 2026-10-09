/**
 * Серверные профили операторов.
 *
 * Как обходить блокировки, зависит от оператора: у Мегафона, МТС, Теле2 и домашних провайдеров
 * разные фильтры. Чтобы подстраиваться под них без выпуска новой версии, приложение берёт профили
 * с нашего сервера (Supabase, RPC get_operator_profiles), кэширует их на устройстве и работает по
 * кэшу или по встроенным значениям, если сервер недоступен (на «белых списках» он как раз недоступен).
 *
 * Что может задать профиль (и только это — остальные поля отбрасываются):
 *  • frag     — параметры фрагментации TLS для этого оператора;
 *  • bypassFirst — с какого режима начинать автоподбор (utils/autoBypass.ts);
 *  • dns      — дополнительные DNS-серверы (только из белого списка известных резолверов, чтобы
 *               взлом сервера профилей не позволил подменить DNS всем клиентам) и параллельный опрос;
 *  • failoverIntervalSec — как часто проверять связь для быстрого переключения (utils/failover.ts).
 */
import { normRange } from './appManagement';
import { SUPABASE_RPC_URL, SUPABASE_API_KEY } from './constants';
import type { BypassStrategyId } from './autoBypass';

export interface OperatorProfile {
  id: string;
  title: string;
  match: { names?: string[]; asns?: number[] };
  frag?: { enable?: boolean; packets?: string; length?: string; interval?: string };
  bypassFirst?: BypassStrategyId;
  dns?: { extra?: string[]; parallel?: boolean };
  failoverIntervalSec?: number;
  note?: string;
}

export interface OperatorProfilesDoc { rev: number; profiles: OperatorProfile[] }

const STORAGE_KEY = 'sim-operator-profiles';
export const REFRESH_EVERY_MS = 6 * 3_600_000;

const AGGRESSIVE_FRAG = { enable: true, packets: 'tlshello', length: '1-5', interval: '1-3' };
const STANDARD_FRAG = { enable: true, packets: 'tlshello', length: '10-20', interval: '1-2' };
// Яндекс DNS (77.88.8.8) по замерам и спискам сообщества проходит и там, где закрыты зарубежные DoH.
const STRICT_DNS = { extra: ['77.88.8.8'], parallel: true };

/** Встроенные значения: то, что приложение делало и раньше, плюс параллельный опрос DNS. */
export const BUNDLED_PROFILES: OperatorProfilesDoc = {
  rev: 1,
  profiles: [
    { id: 'megafon', title: 'Мегафон', match: { names: ['megafon', 'мегафон'], asns: [31133, 25159, 25478, 50340] }, frag: AGGRESSIVE_FRAG, bypassFirst: 'strong', dns: STRICT_DNS, note: 'Жёсткий режим: фильтр по IP и по имени сайта (SNI)' },
    { id: 'yota', title: 'Yota', match: { names: ['yota'], asns: [35807] }, frag: AGGRESSIVE_FRAG, bypassFirst: 'strong', dns: STRICT_DNS },
    { id: 'mts', title: 'МТС', match: { names: ['mts', 'мтс'], asns: [8359, 30922, 8732, 57363] }, frag: AGGRESSIVE_FRAG, bypassFirst: 'strong', dns: STRICT_DNS },
    { id: 'tele2', title: 'Теле2', match: { names: ['tele2', 'теле2'], asns: [39374, 41330, 51570, 57629] }, frag: AGGRESSIVE_FRAG, bypassFirst: 'strong', dns: STRICT_DNS },
    { id: 'beeline', title: 'Билайн', match: { names: ['beeline', 'билайн', 'vimpelcom', 'veon'], asns: [3216, 8402, 42387] }, frag: AGGRESSIVE_FRAG, bypassFirst: 'strong', dns: STRICT_DNS },
    { id: 'tinkoff', title: 'Тинькофф Мобайл', match: { names: ['tinkoff', 'тинькофф'], asns: [205638] }, frag: AGGRESSIVE_FRAG, bypassFirst: 'strong', dns: STRICT_DNS },
    { id: 'sbermobile', title: 'СберМобайл', match: { names: ['sbermobile', 'сбермобайл'], asns: [60727] }, frag: AGGRESSIVE_FRAG, bypassFirst: 'strong', dns: STRICT_DNS },
    { id: 'rostelecom', title: 'Ростелеком', match: { names: ['rostelecom', 'ростелеком'], asns: [12389, 42481, 51813, 2848] }, frag: STANDARD_FRAG, bypassFirst: 'light', dns: { parallel: true } },
    { id: 'domru', title: 'Дом.ру', match: { names: ['dom.ru', 'domru', 'er-telecom', 'эр-телеком'], asns: [9049, 31200] }, frag: STANDARD_FRAG, bypassFirst: 'light', dns: { parallel: true } },
    { id: 'ttk', title: 'ТТК', match: { names: ['ttk', 'транстелеком'], asns: [20485, 31514] }, frag: STANDARD_FRAG, bypassFirst: 'light', dns: { parallel: true } },
    { id: 'mgts', title: 'МГТС', match: { names: ['mgts', 'мгтс'], asns: [47395] }, frag: STANDARD_FRAG, bypassFirst: 'light', dns: { parallel: true } },
    { id: 'default', title: 'Остальные сети', match: {}, dns: { parallel: true } },
  ],
};

// ── Проверка данных с сервера ───────────────────────────────────────────────

/** Резолверы, которые сервер профилей может добавить: публичные и известные. */
const ALLOWED_DNS = new Set([
  '77.88.8.8', '77.88.8.1', '77.88.8.88', '1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112', '94.140.14.14', '94.140.15.15',
]);
const ALLOWED_DOH_HOSTS = new Set([
  'common.dns.yandex.net', 'cloudflare-dns.com', 'dns.google', 'dns.quad9.net', 'dns.adguard-dns.com',
  '77.88.8.8', '77.88.8.1', '1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '94.140.14.14',
]);

export function isAllowedDnsServer(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 120) return false;
  if (ALLOWED_DNS.has(v)) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && ALLOWED_DOH_HOSTS.has(u.hostname) && (u.pathname === '/dns-query' || u.pathname === '/');
  } catch { return false; }
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

function sanitizeProfile(raw: unknown): OperatorProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  const id = typeof r.id === 'string' && /^[a-z0-9_-]{1,32}$/.test(r.id) ? r.id : null;
  const title = str(r.title, 40);
  if (!id || !title) return null;
  const p: OperatorProfile = { id, title, match: {} };

  const names = Array.isArray(r.match?.names) ? r.match.names.map((n: unknown) => str(n, 40)?.toLowerCase()).filter(Boolean).slice(0, 12) as string[] : [];
  const asns = Array.isArray(r.match?.asns) ? r.match.asns.filter((n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) < 4_300_000_000).slice(0, 30) as number[] : [];
  if (names.length) p.match.names = names;
  if (asns.length) p.match.asns = asns;

  if (r.frag && typeof r.frag === 'object') {
    const f: NonNullable<OperatorProfile['frag']> = {};
    if (typeof r.frag.enable === 'boolean') f.enable = r.frag.enable;
    const pk = typeof r.frag.packets === 'string' ? r.frag.packets.trim().toLowerCase() : '';
    if (pk === 'tlshello' || /^\d{1,2}(-\d{1,2})?$/.test(pk)) f.packets = pk;
    const len = normRange(String(r.frag.length ?? ''), 1, 2000);
    if (len) f.length = len;
    const iv = normRange(String(r.frag.interval ?? ''), 0, 500);
    if (iv) f.interval = iv;
    if (Object.keys(f).length) p.frag = f;
  }
  if (r.bypassFirst === 'light' || r.bypassFirst === 'plain' || r.bypassFirst === 'strong') p.bypassFirst = r.bypassFirst;
  if (r.dns && typeof r.dns === 'object') {
    const d: NonNullable<OperatorProfile['dns']> = {};
    if (Array.isArray(r.dns.extra)) d.extra = r.dns.extra.filter(isAllowedDnsServer).slice(0, 4);
    if (typeof r.dns.parallel === 'boolean') d.parallel = r.dns.parallel;
    if ((d.extra && d.extra.length) || d.parallel !== undefined) p.dns = d;
  }
  if (Number.isFinite(r.failoverIntervalSec)) p.failoverIntervalSec = Math.min(30, Math.max(4, Math.round(r.failoverIntervalSec)));
  const note = str(r.note, 200);
  if (note) p.note = note;
  return p;
}

/** Приводит ответ сервера к безопасному виду; null, если это не документ профилей. */
export function sanitizeDoc(raw: unknown): OperatorProfilesDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  if (!Number.isFinite(r.rev) || !Array.isArray(r.profiles)) return null;
  const seen = new Set<string>();
  const profiles: OperatorProfile[] = [];
  for (const item of r.profiles.slice(0, 64)) {
    const p = sanitizeProfile(item);
    if (p && !seen.has(p.id)) { seen.add(p.id); profiles.push(p); }
  }
  return { rev: Math.max(0, Math.floor(r.rev)), profiles };
}

/** Серверные профили поверх встроенных: одинаковый id заменяется, остальные встроенные остаются. */
export function mergeDocs(base: OperatorProfilesDoc, remote: OperatorProfilesDoc | null): OperatorProfilesDoc {
  if (!remote) return base;
  const byId = new Map(base.profiles.map((p) => [p.id, p]));
  for (const p of remote.profiles) byId.set(p.id, p);
  return { rev: Math.max(base.rev, remote.rev), profiles: [...byId.values()] };
}

// ── Поиск профиля ──────────────────────────────────────────────────────────

function nameMatches(text: string, name: string): boolean {
  if (name.length > 4) return text.includes(name);
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-zа-яё0-9])${esc}([^a-zа-яё0-9]|$)`, 'i').test(text);
}

export interface OperatorContext { carrier?: string; ispName?: string; ispRaw?: string; asn?: number }

/** «AS8359 PJSC MTS» → 8359. */
export function parseAsn(org?: string): number | undefined {
  const m = /^AS(\d+)/i.exec((org ?? '').trim());
  return m ? Number(m[1]) : undefined;
}

/** Профиль оператора по названию сети и ASN; если никто не подошёл — профиль «default», если он есть. */
export function resolveOperatorProfile(ctx: OperatorContext, doc: OperatorProfilesDoc): OperatorProfile | null {
  const asn = ctx.asn ?? parseAsn(ctx.ispRaw);
  const text = [ctx.carrier, ctx.ispName, ctx.ispRaw].filter(Boolean).join(' ').toLowerCase();
  const specific = doc.profiles.filter((p) => p.id !== 'default');
  for (const p of specific) if (asn !== undefined && p.match.asns?.includes(asn)) return p;
  for (const p of specific) if (text && p.match.names?.some((n) => nameMatches(text, n))) return p;
  return doc.profiles.find((p) => p.id === 'default') ?? null;
}

// ── Хранилище и обновление ─────────────────────────────────────────────────

interface Stored { doc: OperatorProfilesDoc; fetchedAt: number }

function readStored(): Stored | null {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    const doc = sanitizeDoc(s?.doc);
    return doc && Number.isFinite(s?.fetchedAt) ? { doc, fetchedAt: s.fetchedAt } : null;
  } catch { return null; }
}

/** Действующий набор профилей: встроенные + последний полученный с сервера. */
export function activeProfiles(): OperatorProfilesDoc {
  return mergeDocs(BUNDLED_PROFILES, readStored()?.doc ?? null);
}

export function profilesFetchedAt(): number | null {
  return readStored()?.fetchedAt ?? null;
}

/** Контекст текущей сети без обращений в интернет: оператор SIM из нативного слоя и прошлое определение. */
export function operatorContextNow(): OperatorContext {
  const ctx: OperatorContext = {};
  try {
    const w = window as any;
    const n = w.SimNativeV2 || w.SimProxyBridge || w.AndroidBridge;
    if (n?.getNetworkCarrier) ctx.carrier = String(n.getNetworkCarrier() || '');
  } catch { /* вне Android оператора по SIM нет */ }
  try {
    const d = JSON.parse(localStorage.getItem('sim-isp-detection') || 'null');
    if (d) { ctx.ispName = d.ispName; ctx.ispRaw = d.ispRaw; }
  } catch { /* нет прошлого определения */ }
  return ctx;
}

export function currentOperatorProfile(): OperatorProfile | null {
  return resolveOperatorProfile(operatorContextNow(), activeProfiles());
}

export type ProfilesFetcher = () => Promise<unknown>;

async function fetchFromServer(): Promise<unknown> {
  const url = SUPABASE_RPC_URL.replace(/start_trial$/, 'get_operator_profiles');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8_000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { apikey: SUPABASE_API_KEY, 'Content-Type': 'application/json' }, body: '{}', signal: ctl.signal });
    if (!res.ok) throw new Error(`profiles server: HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/**
 * Обновляет профили с сервера не чаще раза в 6 часов (force — сразу). Тихо возвращает false при любой
 * неудаче: без сети остаются кэш и встроенные значения.
 */
export async function refreshOperatorProfiles(opts: { force?: boolean; fetcher?: ProfilesFetcher; now?: number } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const stored = readStored();
  if (!opts.force && stored && now - stored.fetchedAt < REFRESH_EVERY_MS) return false;
  try {
    const doc = sanitizeDoc(await (opts.fetcher ?? fetchFromServer)());
    if (!doc || doc.profiles.length === 0) return false;
    // Сервер не должен «откатывать» версию назад: старый ответ (кэш прокси и т. п.) игнорируем.
    if (stored && doc.rev < stored.doc.rev) return false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ doc, fetchedAt: now }));
    return true;
  } catch { return false; }
}
