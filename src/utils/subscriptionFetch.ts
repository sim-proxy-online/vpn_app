/**
 * Загрузка подписки.
 *
 * Все запросы идут с нашим User-Agent (SimProxy/<версия>). Единственное исключение — User-Agent,
 * который провайдер сам задал для своего доверенного профиля (параметр change-user-agent, см.
 * appManagement.ts: userAgentFor) — его подставляет вызывающий через opts.userAgent.
 */
import { nativeFetchUrl, nativeFetchUrlViaProxy, type FetchResult } from '../native/bridge';
import type { UaPreference } from '../types';

import { APP_USER_AGENT } from './userAgent';

/** Наш User-Agent для запросов подписки. */
export const DEFAULT_UA = APP_USER_AGENT;

export type Fetched = string | FetchResult;

export interface FetchDeps {
  fetch(url: string, userAgent: string): Promise<Fetched>;
}

const realDeps: FetchDeps = {
  fetch: (url, userAgent) => nativeFetchUrl(url, userAgent),
};

export interface SmartFetch {
  res: Fetched;
  /** Что запомнить в профиле. Раньше хранилось решение «как Happ» — теперь всегда очищается. */
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
  // Обновление через уже поднятый туннель: приложение само идёт мимо VPN (disallowed),
  // поэтому при заблокированном провайдере или доступе подписки только с exit-IP запрос
  // направляем в локальный SOCKS-порт ядра — через туннель.
  if (opts.viaSocksPort && opts.viaSocksPort > 0) {
    const port = opts.viaSocksPort;
    deps = { ...deps, fetch: (u, ua) => nativeFetchUrlViaProxy(u, port, ua) };
  }
  const ua = opts.userAgent || DEFAULT_UA;
  return { res: await deps.fetch(url, ua), preference: undefined, usedUa: ua };
}
