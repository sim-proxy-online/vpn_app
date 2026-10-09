/**
 * Быстрое переключение при падении сервера.
 *
 * Раньше мёртвый сервер замечали медленно: проверка связи шла раз в 60 секунд и требовала три
 * провала подряд (около 3 минут), а автопереключение ещё и замеряло пинг десяти серверов через
 * уже мёртвый туннель. Теперь, пока приложение открыто и VPN подключён, раз в несколько секунд
 * идёт лёгкая проверка через прокси (две цели: хватает ответа любой); три провала подряд с паузой
 * в несколько секунд — сервер считается упавшим, и приложение переходит на следующий (или
 * перезапускает ядро, если сервер один).
 *
 * Готовые конфиги с балансировщиком (protocol 'json') здесь не проверяются вовсе: балансировщик с
 * observatory сам выбирает рабочий выход, а перезапуск ядра обрывает все открытые соединения. Из-за
 * него подписка с балансировщиками и медленными поставщиками «теряла соединение» там, где Happ с
 * теми же настройками работает спокойно (см. failoverApplies).
 *
 * Защита от ложных срабатываний:
 *  • «упал» только если проверка в этом подключении хотя бы раз проходила (на платформе без
 *    проверки или при медленном старте переключений не будет);
 *  • не действуем в первые секунды после подключения, при смене сети и при отсутствии сети у
 *    самого устройства;
 *  • между действиями пауза, число перезапусков за 2 минуты ограничено, недавно упавший сервер
 *    не выбирается снова.
 */
import type { ServerNode } from '../types';

export interface FailoverConfig {
  /** Пауза между проверками, пока всё хорошо. */
  healthyIntervalMs: number;
  /** Сколько провалов подряд считать падением. */
  failThreshold: number;
  /** Пауза до повторной проверки после провала: даёт кратковременному сбою пройти, прежде чем его считать. */
  retryDelayMs: number;
  /** Не действовать, пока соединение живёт меньше этого времени (сек). */
  minUptimeSec: number;
  /** Минимальная пауза между переключениями/перезапусками. */
  cooldownMs: number;
  maxRestarts: number;
  restartWindowMs: number;
  /** Столько не выбираем сервер, который только что упал. */
  nodeCooldownMs: number;
}

export const DEFAULT_FAILOVER: FailoverConfig = {
  healthyIntervalMs: 8_000,
  failThreshold: 3,
  retryDelayMs: 4_000,
  minUptimeSec: 20,
  cooldownMs: 60_000,
  maxRestarts: 2,
  restartWindowMs: 300_000,
  nodeCooldownMs: 300_000,
};

const KEY = 'sim-fast-failover';

export function isFastFailoverEnabled(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? true : JSON.parse(v) !== false;
  } catch { return true; }
}

export function setFastFailoverEnabled(on: boolean): void {
  try { localStorage.setItem(KEY, JSON.stringify(on)); } catch { /* хранилище недоступно */ }
}

export interface HealthState {
  consecutiveFails: number;
  /** Проверка в этом подключении хотя бы раз прошла. */
  seenOk: boolean;
  lastActionAt: number;
  recentRestarts: number[];
}

export const initialHealth = (): HealthState => ({ consecutiveFails: 0, seenOk: false, lastActionAt: 0, recentRestarts: [] });

export type Verdict = 'ok' | 'suspect' | 'dead';

/** Учитывает результат проверки и говорит, что делать дальше. */
export function onProbe(state: HealthState, ok: boolean, cfg: FailoverConfig = DEFAULT_FAILOVER): { state: HealthState; verdict: Verdict } {
  if (ok) return { state: { ...state, consecutiveFails: 0, seenOk: true }, verdict: 'ok' };
  const fails = state.consecutiveFails + 1;
  const next = { ...state, consecutiveFails: fails };
  return { state: next, verdict: fails >= cfg.failThreshold && state.seenOk ? 'dead' : 'suspect' };
}

/**
 * Через сколько мс делать следующую проверку. После провала — через несколько секунд, а не сразу: повтор
 * через полсекунды попадал в тот же самый сбой (поставщику нужно 1–5 с на установку соединения), и два
 * «провала» подряд означали один сбой, а не падение сервера.
 */
export function nextDelayMs(verdict: Verdict, cfg: FailoverConfig = DEFAULT_FAILOVER): number {
  return verdict === 'ok' ? cfg.healthyIntervalMs : cfg.retryDelayMs;
}

export function cooldownPassed(state: HealthState, now: number, cfg: FailoverConfig = DEFAULT_FAILOVER): boolean {
  return now - state.lastActionAt >= cfg.cooldownMs;
}

export function restartAllowed(state: HealthState, now: number, cfg: FailoverConfig = DEFAULT_FAILOVER): boolean {
  return state.recentRestarts.filter((t) => now - t < cfg.restartWindowMs).length < cfg.maxRestarts;
}

export function recordAction(state: HealthState, now: number, kind: 'switch' | 'restart', cfg: FailoverConfig = DEFAULT_FAILOVER): HealthState {
  const recent = state.recentRestarts.filter((t) => now - t < cfg.restartWindowMs);
  return { ...state, consecutiveFails: 0, lastActionAt: now, recentRestarts: kind === 'restart' ? [...recent, now] : recent };
}

/** Готовый конфиг с балансировщиком внутри: переключаться на другой узел профиля бессмысленно. */
export function isBalancerNode(node: Pick<ServerNode, 'protocol'>): boolean {
  return node.protocol === 'json';
}

/**
 * Следит ли быстрое переключение за этим сервером. Готовые конфиги с балансировщиком — нет: выбор рабочего
 * выхода и переключение между ними делает сам балансировщик, а приложение при провале проверки перезапускало
 * ядро и рвало все соединения. Возможный полный сбой таких конфигов по-прежнему ловят старые проверки
 * (зависание прокси несколько минут подряд), они редкие и терпеливые.
 */
export function failoverApplies(node: Pick<ServerNode, 'protocol'> | null | undefined): boolean {
  return !!node && !isBalancerNode(node);
}

export interface PlanOptions {
  current: Pick<ServerNode, 'id'>;
  nodes: ServerNode[];
  /** id → когда сервер упал (мс). */
  failedAt: Record<string, number>;
  /** Кэшированный пинг сервера, мс; ≤ 0 — неизвестен. */
  cachedPing: (id: string) => number;
  now: number;
  cfg?: FailoverConfig;
  /** Приоритетные серверы (например, помеченные как для мобильного обхода). */
  isPriority?: (n: ServerNode) => boolean;
  limit?: number;
}

/**
 * Кандидаты на переключение по порядку: без текущего, без недавно упавших и без готовых конфигов;
 * сначала приоритетные, затем с известным небольшим пингом, потом остальные.
 */
export function planFailover(o: PlanOptions): ServerNode[] {
  const cfg = o.cfg ?? DEFAULT_FAILOVER;
  const pri = o.isPriority ?? (() => false);
  return o.nodes
    .filter((n) => n.id !== o.current.id && n.address && n.port && !isBalancerNode(n)
      && !(o.failedAt[n.id] && o.now - o.failedAt[n.id] < cfg.nodeCooldownMs))
    .map((n, i) => ({ n, i, p: o.cachedPing(n.id), pr: pri(n) ? 0 : 1 }))
    .sort((a, b) => {
      if (a.pr !== b.pr) return a.pr - b.pr;
      const ka = a.p > 0 && a.p < 3000, kb = b.p > 0 && b.p < 3000;
      if (ka && kb) return a.p - b.p;
      if (ka !== kb) return ka ? -1 : 1;
      return a.i - b.i;
    })
    .slice(0, o.limit ?? 3)
    .map((x) => x.n);
}

/** Приоритетный сервер (помечен как обход DPI для мобильных сетей) — его пробуют первым. */
export function isPriorityNode(n: Pick<ServerNode, 'name' | 'remark'>): boolean {
  return /\b(lte|4g|бс|белые|белый|обход|bypass)\b/i.test(`${n.name} ${n.remark}`);
}

/** Есть ли сеть у самого устройства: без неё «упавшим» сервер считать нельзя. */
export async function deviceNetworkUp(): Promise<boolean> {
  try {
    const w = window as any;
    const n = w.SimNativeV2 || w.SimProxyBridge || w.AndroidBridge;
    if (n && n.isNetworkAvailable) {
      const { nativeIsNetworkAvailable } = await import('../native/bridge');
      return !!(await nativeIsNetworkAvailable());
    }
  } catch { /* дальше — запасной признак */ }
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}
