/**
 * Клиент API кабинета (petrovich.party) — продление подписки прямо из приложения.
 *
 * Сессия: POST /api/client/auth/by-subscription {subscriptionUrl} → клиентский JWT.
 * Ключ входа — сама ссылка-подписки (её знает только владелец; бэкенд резолвит её
 * в клиента через Remnawave). Токен живёт 7 дней, храним по профилю и переиздаём при 401.
 *
 * Адрес панели берётся из заголовка подписки x-cabinet-url (managed.cabinetUrl); если
 * заголовка нет — из нашего хоста (только *.petrovich.party): продление есть только у наших.
 *
 * CORS: ответы API отдают Access-Control-Allow-Origin * (nginx кабинета), поэтому
 * запросы идут обычным fetch из WebView; редиректы и оплата открываются в браузере.
 */
import type { SubscriptionProfile } from '../types';
import { safeHttpsUrl } from './appManagement';

/** Запасной адрес панели, когда заголовок x-cabinet-url ещё не приходит. */
const FALLBACK_ORIGIN = 'https://petrovich.party';
const SESSIONS_KEY = 'sim-cabinet-sessions';
/** JWT живёт 7 дней — переиздаём чуть раньше, чтобы не ловить 401. */
const SESSION_MAX_AGE_MS = 6 * 86_400_000;

export class CabinetError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'CabinetError';
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/** Адрес панели для профила: заголовок x-cabinet-url или наш хост; иначе null (продление недоступно). */
export function cabinetOrigin(p: Pick<SubscriptionProfile, 'url' | 'managed'>): string | null {
  const fromHeader = safeHttpsUrl(p.managed?.cabinetUrl);
  if (fromHeader) return fromHeader.replace(/\/+$/, '');
  if (p.url) {
    const host = hostOf(p.url);
    if (host === 'petrovich.party' || host.endsWith('.petrovich.party')) return FALLBACK_ORIGIN;
  }
  return null;
}

/** Продление доступно только для подписок с адресом, у которого известна панель. */
export function isRenewableProfile(p: SubscriptionProfile): boolean {
  return !!p.url && cabinetOrigin(p) !== null;
}

/** Кнопка «Продлить» показывается, когда подписка истекает (осталось ≤7 дней / >80%) или уже истекла. */
export function renewEligible(p: SubscriptionProfile): boolean {
  return isRenewableProfile(p) && (p.status === 'expired' || p.status === 'warning');
}

// ── Типы ответов API ──────────────────────────────────────────────────────────

export interface TariffPriceOption {
  id: string;
  durationDays: number;
  price: number;
  sortOrder: number;
}

export interface CabinetTariff {
  id: string;
  name: string;
  description?: string | null;
  durationDays?: number | null;
  price: number;
  currency: string;
  priceOptions: TariffPriceOption[];
}

export interface CabinetCategory {
  id: string;
  name: string;
  emoji?: string;
  /** «Одна подписка на категорию» — покупка того же тарифа продлевает существующую подписку. */
  singleSubscriptionMode?: boolean;
  tariffs: CabinetTariff[];
}

export interface PublicConfig {
  plategaMethods?: { id: number; label: string }[];
  paymentProviders?: { id: string; label: string; sortOrder: number }[];
  defaultCurrency?: string;
  [key: string]: unknown;
}

export interface CabinetClient {
  id: string;
  balance: number;
  currentTariffId?: string | null;
  currentTariff?: { id: string; name: string; categoryId: string | null } | null;
  isBlocked?: boolean;
}

export interface PaymentSelection {
  tariffId: string;
  tariffPriceOptionId?: string;
  promoCode?: string;
}

// ── Хранилище сессий ──────────────────────────────────────────────────────────

interface StoredSession { token: string; savedAt: number; }

function readSessions(): Record<string, StoredSession> {
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}') as Record<string, StoredSession>; }
  catch { return {}; }
}

function writeSessions(map: Record<string, StoredSession>): void {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(map)); } catch { /* хранилище недоступно */ }
}

export function clearCabinetSession(profileId: string): void {
  const map = readSessions();
  delete map[profileId];
  writeSessions(map);
}

// ── Незавершённая оплата (возобновление после перезапуска) ────────────────────

export interface PendingRenewal {
  profileId: string;
  paymentId: string;
  /** Ссылка на страницу оплаты — кнопка «Открыть ещё раз» после перезапуска. */
  payUrl: string;
  createdAt: number;
}

const PENDING_KEY = 'sim-renewal-pending';
/** Незавершённая оплата живёт 40 минут: страницы оплаты обычно закрываются примерно через 30. */
export const PENDING_TTL_MS = 40 * 60_000;

/** Запомнить незавершённую оплату: перезапуск приложения не должен обрывать поллинг. */
export function saveRenewalPending(rec: PendingRenewal): void {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(rec)); } catch { /* хранилище недоступно */ }
}

/** Прочитать незавершённую оплату; просроченная запись удаляется при чтении. */
export function loadRenewalPending(): PendingRenewal | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as PendingRenewal;
    if (!rec || typeof rec.paymentId !== 'string' || typeof rec.createdAt !== 'number') return null;
    if (Date.now() - rec.createdAt > PENDING_TTL_MS) { localStorage.removeItem(PENDING_KEY); return null; }
    return rec;
  } catch { return null; }
}

/**
 * Снять оплату с поллинга. Возвращает true, если вызывающий может считать себя единственным
 * обработчиком: запись снимается только один раз (модал и фоновое возобновление поллят один
 * и тот же платёж — профиль должен обновиться и уведомление уйти ровно один раз).
 */
export function clearRenewalPending(paymentId?: string): boolean {
  const cur = loadRenewalPending();
  if (!cur) return false;                       // уже снято — нас опередили
  if (paymentId && cur.paymentId !== paymentId) return true; // это запись другого платежа — не трогаем
  try { localStorage.removeItem(PENDING_KEY); } catch { /* хранилище недоступно */ }
  return true;
}

// ── Низкоуровневый запрос ─────────────────────────────────────────────────────

async function doFetch(url: string, method: 'GET' | 'POST', body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    return await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new CabinetError(0, 'Нет связи с кабинетом');
  }
}

async function errorFrom(res: Response): Promise<CabinetError> {
  let message = `HTTP ${res.status}`;
  try {
    const data = await res.json() as { message?: string };
    if (data?.message) message = data.message;
  } catch { /* тело не JSON */ }
  return new CabinetError(res.status, message);
}

// ── Сессия ────────────────────────────────────────────────────────────────────

const inflightSessions = new Map<string, Promise<string>>();

async function loginBySubscription(profile: SubscriptionProfile): Promise<string> {
  const origin = cabinetOrigin(profile);
  if (!origin) throw new CabinetError(0, 'Для этой подписки продление недоступно');
  if (!profile.url) throw new CabinetError(0, 'У профиля нет ссылки подписки');
  const res = await doFetch(`${origin}/api/client/auth/by-subscription`, 'POST', { subscriptionUrl: profile.url });
  if (!res.ok) throw await errorFrom(res);
  const data = await res.json() as { token?: string };
  if (!data.token) throw new CabinetError(0, 'Кабинет не выдал сессию');
  const map = readSessions();
  map[profile.id] = { token: data.token, savedAt: Date.now() };
  writeSessions(map);
  return data.token;
}

/** Клиентский JWT профиля: из хранилища либо заново по ссылке-подписке. Параллельные вызовы дедуплицируются. */
export function ensureCabinetSession(profile: SubscriptionProfile, force = false): Promise<string> {
  if (!force) {
    const saved = readSessions()[profile.id];
    if (saved && Date.now() - saved.savedAt < SESSION_MAX_AGE_MS) return Promise.resolve(saved.token);
  }
  const existing = inflightSessions.get(profile.id);
  if (existing) return existing;
  const pending = loginBySubscription(profile).finally(() => inflightSessions.delete(profile.id));
  inflightSessions.set(profile.id, pending);
  return pending;
}

/** Запрос к API: сессия, авторизация, один повтор после переиздания токена при 401. */
async function request<T>(profile: SubscriptionProfile, path: string, opts: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const origin = cabinetOrigin(profile);
  if (!origin) throw new CabinetError(0, 'Для этой подписки продление недоступно');
  const method = opts.method ?? 'GET';
  let token = await ensureCabinetSession(profile);
  let res = await doFetch(`${origin}/api${path}`, method, opts.body, token);
  if (res.status === 401) {
    clearCabinetSession(profile.id);
    token = await ensureCabinetSession(profile, true);
    res = await doFetch(`${origin}/api${path}`, method, opts.body, token);
  }
  if (!res.ok) throw await errorFrom(res);
  return await res.json() as T;
}

// ── Эндпоинты ─────────────────────────────────────────────────────────────────

/** Публичная конфигурация: способы оплаты (plategaMethods, paymentProviders) и валюта. */
export function fetchPublicConfig(profile: SubscriptionProfile): Promise<PublicConfig> {
  return request<PublicConfig>(profile, '/public/config');
}

/** Категории и тарифы публичной витрины. */
export async function fetchTariffs(profile: SubscriptionProfile): Promise<CabinetCategory[]> {
  const data = await request<{ items?: CabinetCategory[] }>(profile, '/public/tariffs');
  return data.items ?? [];
}

/** Текущий клиент: баланс и текущий тариф (для фильтра «продление»). */
export function fetchMe(profile: SubscriptionProfile): Promise<CabinetClient> {
  return request<CabinetClient>(profile, '/client/auth/me');
}

/** Статус платежа: PAID | FAILED | … (кабинет поллит каждые 3–5 секунд). */
export async function fetchPaymentStatus(profile: SubscriptionProfile, paymentId: string): Promise<string> {
  const data = await request<{ status?: string }>(profile, `/client/payments/${encodeURIComponent(paymentId)}/status`);
  return (data.status ?? '').toUpperCase();
}

/** Ссылка-подписка владельца: при покупке НОВОГО тарифа она может отличаться от текущей. */
export async function fetchSubscriptionUrl(profile: SubscriptionProfile): Promise<string | null> {
  const data = await request<{ subscription?: { response?: { subscriptionUrl?: string } } }>(profile, '/client/subscription');
  return data.subscription?.response?.subscriptionUrl ?? null;
}

/** Платёжные эндпоинты провайдеров и поле с ссылкой на оплату в ответе. */
const PROVIDER_ENDPOINTS: Record<string, { path: string; urlFields: string[] }> = {
  platega: { path: '/client/payments/platega', urlFields: ['paymentUrl'] },
  cryptopay: { path: '/client/cryptopay/create-payment', urlFields: ['payUrl', 'paymentUrl'] },
  heleket: { path: '/client/heleket/create-payment', urlFields: ['payUrl', 'paymentUrl'] },
  rollypay: { path: '/client/rollypay/create-payment', urlFields: ['payUrl', 'paymentUrl'] },
  lava: { path: '/client/lava/create-payment', urlFields: ['payUrl', 'paymentUrl'] },
  lavatop: { path: '/client/lavatop/create-payment', urlFields: ['payUrl', 'paymentUrl'] },
  overpay: { path: '/client/overpay/create-payment', urlFields: ['payUrl', 'paymentUrl'] },
  yookassa: { path: '/client/yookassa/create-payment', urlFields: ['confirmationUrl', 'payUrl'] },
  yoomoney: { path: '/client/yoomoney/create-form-payment', urlFields: ['paymentUrl', 'payUrl'] },
};

/** Внешние провайдеры, включённые в конфиге (сейчас в проде работают platega и баланс). */
export function enabledExternalProviders(cfg: PublicConfig): { id: string; label: string }[] {
  const labels = new Map((cfg.paymentProviders ?? []).map(p => [p.id, p.label]));
  return Object.keys(PROVIDER_ENDPOINTS)
    .filter(id => id !== 'platega' && cfg[`${id}Enabled`] === true)
    .map(id => ({ id, label: labels.get(id) ?? id }));
}

export interface CreatedPayment { payUrl: string; paymentId?: string; }

/** Создать платёж у провайдера; возвращает ссылку на оплату (открывается в браузере) и id для поллинга. */
export async function createPayment(
  profile: SubscriptionProfile,
  providerId: string,
  selection: PaymentSelection & { paymentMethod?: number },
): Promise<CreatedPayment> {
  const endpoint = PROVIDER_ENDPOINTS[providerId];
  if (!endpoint) throw new CabinetError(0, `Неизвестный способ оплаты: ${providerId}`);
  const data = await request<Record<string, unknown>>(profile, endpoint.path, { method: 'POST', body: selection });
  let payUrl: string | undefined;
  for (const f of endpoint.urlFields) {
    const v = data[f];
    if (typeof v === 'string' && v) { payUrl = v; break; }
  }
  if (!payUrl) throw new CabinetError(0, 'Кабинет не вернул ссылку на оплату');
  const paymentId = typeof data.paymentId === 'string' ? data.paymentId
    : typeof data.id === 'string' ? data.id
    : typeof data.orderId === 'string' ? data.orderId : undefined;
  return { payUrl, paymentId };
}

/** Оплата с баланса клиента: проходит сразу, без редиректа в браузер. */
export async function payFromBalance(profile: SubscriptionProfile, selection: PaymentSelection & { amount?: number; currency?: string }): Promise<void> {
  await request(profile, '/client/payments/balance', { method: 'POST', body: selection });
}
