/**
 * Автоподбор режима обхода DPI.
 *
 * Статичные пресеты («МТС/Мегафон», «Ростелеком»…) угадывают режим по оператору, но один и тот же
 * оператор в разных городах фильтрует по-разному. Поэтому, если подключение не подтвердилось,
 * приложение само пробует следующий режим и запоминает тот, что сработал, отдельно для каждой сети
 * (тип сети + оператор). В следующий раз начинает сразу с него.
 *
 * Порядок попыток: запомненный для этой сети → «ваши настройки» (как в приложении сейчас) →
 * остальные режимы. Всего не больше трёх попыток, чтобы не заставлять ждать при неработающем сервере.
 */
import type { ServerNode } from '../types';

export type BypassStrategyId = 'light' | 'plain' | 'strong';

export interface BypassStrategy {
  id: BypassStrategyId;
  label: string;
  fragEnable: boolean;
  fragPackets: string;
  fragLength: string;
  fragInterval: string;
}

export const BYPASS_STRATEGIES: Record<BypassStrategyId, BypassStrategy> = {
  light:  { id: 'light',  label: 'лёгкая фрагментация',    fragEnable: true,  fragPackets: 'tlshello', fragLength: '10-20', fragInterval: '1-5' },
  plain:  { id: 'plain',  label: 'без фрагментации',       fragEnable: false, fragPackets: 'tlshello', fragLength: '10-20', fragInterval: '1-5' },
  strong: { id: 'strong', label: 'усиленная фрагментация', fragEnable: true,  fragPackets: 'tlshello', fragLength: '1-5',   fragInterval: '1-3' },
};

/** Параметры фрагментации, как их собирает App из настроек пользователя. */
export interface FragSettings {
  fragEnable: boolean;
  fragPackets: string;
  fragLength: string;
  fragInterval: string;
}

export interface BypassAttempt {
  /** 'user' — настройки пользователя без подмены. */
  id: BypassStrategyId | 'user';
  /** null — ничего не подменять. */
  strategy: BypassStrategy | null;
  label: string;
}

/** Подтверждение соединения не удалось (а не ядро не запустилось): имеет смысл менять режим. */
export class ConnectVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectVerifyError';
  }
}

export const MAX_ATTEMPTS = 3;
const AUTO_KEY = 'sim-auto-bypass';
const PREF_KEY = 'sim-auto-bypass-pref';
const MAX_PREFS = 24;

const FRAGMENT_PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks']);
const UDP_TRANSPORTS = new Set(['quic', 'kcp', 'mkcp']);

export function isAutoBypassEnabled(): boolean {
  try {
    const v = localStorage.getItem(AUTO_KEY);
    return v === null ? true : JSON.parse(v) !== false;
  } catch { return true; }
}

export function setAutoBypassEnabled(on: boolean): void {
  try { localStorage.setItem(AUTO_KEY, JSON.stringify(on)); } catch { /* хранилище недоступно */ }
}

/**
 * Режимы меняют фрагментацию TCP-потока в клиентском конфиге Xray, поэтому подбор имеет смысл
 * только для узлов-ссылок поверх TCP. Готовые JSON-конфиги и UDP-протоколы идут как есть.
 */
export function ladderApplies(node: Pick<ServerNode, 'protocol' | 'transport'>): boolean {
  if (!FRAGMENT_PROTOCOLS.has(node.protocol)) return false;
  return !UDP_TRANSPORTS.has(String(node.transport || '').toLowerCase());
}

function sameAsUser(s: BypassStrategy, cur: FragSettings): boolean {
  if (s.fragEnable !== cur.fragEnable) return false;
  if (!s.fragEnable) return true;
  return s.fragPackets === cur.fragPackets && s.fragLength === cur.fragLength && s.fragInterval === cur.fragInterval;
}

/** Список попыток в порядке выполнения (первая — без подмены, если для сети ничего не запомнено). */
export function planAttempts(cur: FragSettings, preferred: BypassStrategyId | null): BypassAttempt[] {
  const user: BypassAttempt = { id: 'user', strategy: null, label: 'ваши настройки' };
  const fallbackIds: BypassStrategyId[] = cur.fragEnable ? ['plain', 'strong', 'light'] : ['light', 'strong', 'plain'];
  const rest: BypassAttempt[] = fallbackIds
    .map((id) => BYPASS_STRATEGIES[id])
    .filter((s) => !sameAsUser(s, cur))
    .map((s) => ({ id: s.id, strategy: s, label: s.label }));

  const order: BypassAttempt[] = [];
  const pref = preferred ? rest.find((a) => a.id === preferred) : undefined;
  if (pref) order.push(pref);
  order.push(user);
  for (const a of rest) if (a !== pref) order.push(a);
  return order.slice(0, MAX_ATTEMPTS);
}

/** Применяет режим к параметрам подключения; без режима возвращает настройки как есть. */
export function applyAttempt<T extends FragSettings>(settings: T, attempt: BypassAttempt): T {
  const s = attempt.strategy;
  if (!s) return settings;
  return { ...settings, fragEnable: s.fragEnable, fragPackets: s.fragPackets, fragLength: s.fragLength, fragInterval: s.fragInterval };
}

export function describeAttempt(index: number, total: number, attempt: BypassAttempt): string {
  return `Подбираю обход · попытка ${index + 1} из ${total}: ${attempt.label}`;
}

/** Ключ сети для запоминания режима: тип сети + оператор (для Wi-Fi — провайдер, если известен). */
export function makeNetworkKey(type: string, carrier: string, ispName?: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-zа-яё0-9]+/g, '').slice(0, 24);
  const t = (type || 'unknown').toUpperCase();
  const who = t === 'MOBILE' ? norm(carrier || '') : norm(ispName || '');
  return who ? `${t}:${who}` : t;
}

type PrefMap = Record<string, { id: BypassStrategyId; ts: number }>;

function readPrefs(): PrefMap {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

function writePrefs(m: PrefMap): void {
  const entries = Object.entries(m).sort((a, b) => b[1].ts - a[1].ts).slice(0, MAX_PREFS);
  try { localStorage.setItem(PREF_KEY, JSON.stringify(Object.fromEntries(entries))); } catch { /* хранилище недоступно */ }
}

export function getPreferredStrategy(networkKey: string): BypassStrategyId | null {
  const p = readPrefs()[networkKey];
  return p && p.id in BYPASS_STRATEGIES ? p.id : null;
}

/** Забыть запомненный режим для сети (кнопка «Сбросить» в настройках). */
export function forgetStrategy(networkKey: string): void {
  const prefs = readPrefs();
  delete prefs[networkKey];
  writePrefs(prefs);
}

/**
 * Итог успешного подключения: подмена сработала — запоминаем её для сети; сработали настройки
 * пользователя — забываем прежнюю запись (она уже не помогала).
 */
export function recordSuccess(networkKey: string, attempt: BypassAttempt, now = Date.now()): void {
  const prefs = readPrefs();
  if (attempt.strategy) prefs[networkKey] = { id: attempt.strategy.id, ts: now };
  else delete prefs[networkKey];
  writePrefs(prefs);
}

/** Ключ текущей сети из нативного слоя (на ПК и в вебе тип неизвестен → общий ключ). */
export async function currentNetworkKey(): Promise<string> {
  try {
    const { nativeGetCurrentNetwork, nativeGetNetworkCarrier } = await import('../native/bridge');
    const type = await nativeGetCurrentNetwork();
    let isp = '';
    try { isp = JSON.parse(localStorage.getItem('sim-isp-detection') || 'null')?.ispName || ''; } catch { /* нет записи */ }
    return makeNetworkKey(type, nativeGetNetworkCarrier(), isp);
  } catch {
    return makeNetworkKey('unknown', '');
  }
}
