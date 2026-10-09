/**
 * Как показывать пинг: цвет, число полосок и подпись. Одна шкала для главного экрана, списка серверов и профилей,
 * чтобы одно и то же значение везде выглядело одинаково.
 */
export interface PingTone {
  color: string;
  /** Полосок качества связи из трёх (0 — нет данных или нет ответа). */
  level: 0 | 1 | 2 | 3;
  label: string;
}

export const PING_UNKNOWN_COLOR = '#6b7280';
export const PING_FAIL_COLOR = '#ff3b5c';

/** ms: undefined — ещё не мерили; отрицательное — нет ответа. */
export function pingTone(ms: number | undefined): PingTone {
  if (ms === undefined || Number.isNaN(ms)) return { color: PING_UNKNOWN_COLOR, level: 0, label: '— мс' };
  if (ms < 0) return { color: PING_FAIL_COLOR, level: 0, label: 'нет ответа' };
  const v = Math.round(ms);
  const color = v < 100 ? '#00e08a' : v < 250 ? '#ffd23f' : v < 500 ? '#ff9d3d' : '#ff5a4d';
  const level = v < 100 ? 3 : v < 250 ? 2 : 1;
  return { color, level, label: `${v} мс` };
}
