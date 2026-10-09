/**
 * Загрузка подписки с выбором User-Agent.
 *
 * Провайдеры отдают расширенные данные (описания серверов в meta, подсказки и пр., см. appManagement.ts и
 * linkMeta.ts) по User-Agent, и чаще всего — только Happ. Чтобы это работало с подписками любых провайдеров,
 * приложение само проверяет, какой запрос даёт больше, и запоминает результат в профиле (SubscriptionProfile.fetchUa):
 *
 *  1. Обычный запрос с нашим User-Agent (SimProxy/<версия>). Ошибка этого запроса пробрасывается, как и раньше.
 *  2. Один раз, а потом раз в неделю — пробный запрос как у Happ. Он принимается, только если серверов не меньше,
 *     а данных строго больше (описания, параметры управления) или серверов больше (у провайдера для «чужих»
 *     клиентов могла лежать заглушка). Иначе всё остаётся как было — у провайдеров, которым Happ-запрос не нужен,
 *     ничего не меняется.
 *  3. Если Happ-запрос принят, следующие обновления идут им сразу (один запрос); если он перестал давать серверы,
 *     возвращаемся к обычному.
 *
 * User-Agent, который провайдер задал сам (change-user-agent), важнее всего. Режим можно выключить в настройках.
 */
import { nativeFetchUrl, nativeFetchUrlViaProxy, type FetchResult } from '../native/bridge';
import { parseSubscription, type SubscriptionParseResult } from '../data';
import type { UaPreference } from '../types';
import { APP_USER_AGENT } from './userAgent';

/** Наш User-Agent: SimProxy/<версия>. Им идут все обычные запросы подписки. */
export const DEFAULT_UA = APP_USER_AGENT;
/**
 * Режим Happ (настройка «Режим Happ для подписок», включена по умолчанию): пробный запрос с этим
 * User-Agent — единственный способ получить у ряда провайдеров расширенные данные (описания
 * серверов, объявления, параметры управления). Используется только для пробы и только пока
 * режим включён.
 */
export const HAPP_UA = 'Happ/2.7.0';
/** Как часто повторять сравнение у провайдера, для которого Happ-запрос пока не нужен. */
export const REPROBE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const HAPP_MODE_KEY = 'sim-happ-ua';

export type Fetched = string | FetchResult;

export interface FetchDeps {
  fetch(url: string, userAgent: string): Promise<Fetched>;
  parse(body: string, userInfo?: string, headers?: Record<string, string>): SubscriptionParseResult;
  enabled(): boolean;
  now(): number;
}

/** Режим включён по умолчанию; выключается в Настройках. */
export function isHappModeEnabled(): boolean {
  try { return JSON.parse(localStorage.getItem(HAPP_MODE_KEY) ?? 'true') !== false; } catch { return true; }
}

const realDeps: FetchDeps = {
  fetch: (url, userAgent) => nativeFetchUrl(url, userAgent),
  parse: parseSubscription,
  enabled: isHappModeEnabled,
  now: () => Date.now(),
};

function bodyOf(r: Fetched): string {
  return typeof r === 'string' ? r : (r?.body ?? '');
}

function usable(r: Fetched): boolean {
  if (typeof r === 'object' && r !== null && r.ok === false) return false;
  return bodyOf(r).trim().length > 0;
}

function parsedOf(deps: FetchDeps, r: Fetched): SubscriptionParseResult {
  const o = typeof r === 'object' && r !== null ? r : null;
  return deps.parse(bodyOf(r), o?.userInfo, o?.headers);
}

/** Сколько полезного провайдер дал сверх серверов: описания серверов и параметры управления. */
export function richness(p: SubscriptionParseResult): number {
  let score = p.nodes.filter((n) => !!n.description).length;
  const m = p.managed;
  if (m) score += Object.keys(m.settings).length + (m.announce ? 1 : 0) + (m.info ? 1 : 0) + (m.expire ? 1 : 0);
  return score;
}

/** Ответ «HTTP 403» — определённый вердикт сервера: с этим User-Agent ему работать не надо. */
function isHttpRejection(r: Fetched): boolean {
  const o = typeof r === 'object' && r !== null ? (r as any) : null;
  return !!o && o.ok === false && /^HTTP\s\d+/i.test(String(o.error || '').trim());
}

/**
 * Пробный запрос: null — сервер ответил, но servers нет/пусто (такое запоминаем как «не помог»).
 * Сбой сети (exception, таймаут, DNS) пробрасывается — это не вердикт о Happ, см. ниже у вызывающих.
 */
async function attempt(deps: FetchDeps, url: string, userAgent: string): Promise<{ res: Fetched; parsed: SubscriptionParseResult } | null> {
  const res = await deps.fetch(url, userAgent);
  if (typeof res === 'object' && res !== null && res.ok === false && !isHttpRejection(res)) {
    throw new Error(String((res as any).error || 'сбой сети'));
  }
  if (!usable(res)) return null;
  const parsed = parsedOf(deps, res);
  return parsed.nodes.length > 0 ? { res, parsed } : null;
}

export interface SmartFetch {
  res: Fetched;
  /** Что запомнить в профиле (может совпадать с переданным). */
  preference: UaPreference | undefined;
  usedUa: string;
}

/**
 * Ошибки сети из натива приходят сырыми и с адресами («Unable to resolve host
 * "x.petrovich.party/193.187.93.181:443"», «failed to connect to /193.187.93.181 (port 443)»).
 * Пользователю адрес и порт не нужны — остаётся только понятный текст.
 */
export function friendlyUpdateError(e: unknown): string {
  const raw = e instanceof Error && e.message ? e.message : '';
  if (!raw) return 'Нет связи с сервером подписки';

  if (/timed?\s*out|timeout|превышено|не ответил/i.test(raw)) return 'Сервер подписки не ответил вовремя';
  if (/unable to resolve|unknown host|no address associated|getaddrinfo/i.test(raw)) return 'Не удалось разрешить адрес сервера подписки';
  if (/connection refused|failed to connect|connection reset|broken pipe|network is unreachable|no route to host|econnrefused|econnreset/i.test(raw)) return 'Сервер подписки не отвечает на соединение';
  if (/ssl|handshake|certificat|trust anchor/i.test(raw)) return 'Ошибка шифрования соединения с сервером';
  const http = raw.match(/http\s(\d{3})/i);
  if (http) return `Сервер подписки вернул ошибку HTTP ${http[1]}`;

  // Прочее: выбрасываем из текста URL, хосты, IP и порты — адрес в ошибке не нужен.
  const clean = raw
    .replace(/https?:\/\/[^\s)"']+/gi, '')
    .replace(/(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?/gi, '')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '')
    .replace(/\(\s*(?:port\s*)?\d+\s*\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s:,;–—-]+$/i, '')
    .trim();
  return clean || 'Нет связи с сервером подписки';
}

export async function fetchSubscription(
  url: string,
  opts: { userAgent?: string; preference?: UaPreference; viaSocksPort?: number; force?: boolean } = {},
  deps: FetchDeps = realDeps,
): Promise<SmartFetch> {
  const { userAgent, preference } = opts;

  // Обновление через уже поднятый туннель: приложение само идёт мимо VPN (disallowed),
  // поэтому при заблокированном провайдере или доступе подписки только с exit-IP запрос
  // направляем в локальный SOCKS-порт ядра — через туннель.
  if (opts.viaSocksPort && opts.viaSocksPort > 0) {
    const port = opts.viaSocksPort;
    deps = { ...deps, fetch: (u, ua) => nativeFetchUrlViaProxy(u, port, ua) };
  }
  const now = deps.now();

  // Провайдер сам сказал, каким User-Agent к нему ходить — подчиняемся.
  if (userAgent) return { res: await deps.fetch(url, userAgent), preference, usedUa: userAgent };
  if (!deps.enabled()) return { res: await deps.fetch(url, DEFAULT_UA), preference, usedUa: DEFAULT_UA };

  if (preference?.mode === 'happ') {
    let happ: { res: Fetched; parsed: SubscriptionParseResult } | null = null;
    let netFail = false;
    try { happ = await attempt(deps, url, HAPP_UA); } catch { netFail = true; }
    if (happ) return { res: happ.res, preference, usedUa: HAPP_UA };
    const base = await deps.fetch(url, DEFAULT_UA);
    // Сбой сети Happ-пробы — не вердикт: режим сохраняем, просто берём обычный ответ.
    if (netFail) return { res: base, preference, usedUa: DEFAULT_UA };
    // Happ-запрос дошёл, но больше не даёт серверов — обычный запрос, сравнение повторим позже.
    return { res: base, preference: { mode: 'default', checkedAt: now }, usedUa: DEFAULT_UA };
  }

  // force — ручное обновление: сверяемся с Happ сразу, не дожидаясь недельного интервала.
  if (preference && !opts.force && now - preference.checkedAt < REPROBE_AFTER_MS) {
    return { res: await deps.fetch(url, DEFAULT_UA), preference, usedUa: DEFAULT_UA };
  }

  // Первый раз, давно не сравнивали или обновление вручную: обычный запрос, затем пробный как у Happ.
  const base = await deps.fetch(url, DEFAULT_UA);
  if (!usable(base)) return { res: base, preference, usedUa: DEFAULT_UA };
  const baseParsed = parsedOf(deps, base);
  let happ: { res: Fetched; parsed: SubscriptionParseResult } | null = null;
  let netFail = false;
  try { happ = await attempt(deps, url, HAPP_UA); } catch { netFail = true; }
  const happIsBetter = !!happ && (
    happ.parsed.nodes.length > baseParsed.nodes.length
    || (happ.parsed.nodes.length === baseParsed.nodes.length && richness(happ.parsed) > richness(baseParsed))
  );
  if (happ && happIsBetter) return { res: happ.res, preference: { mode: 'happ', checkedAt: now }, usedUa: HAPP_UA };
  // Сбой сети пробного запроса ничего не доказывает — решение не запоминаем, проверим в следующий раз.
  if (netFail) return { res: base, preference, usedUa: DEFAULT_UA };
  return { res: base, preference: { mode: 'default', checkedAt: now }, usedUa: DEFAULT_UA };
}
