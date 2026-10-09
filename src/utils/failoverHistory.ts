// ── Петрович-агент: журнал фоновых автопереключений ─────────────────────────
// Чистая логика: агрегация и форматирование истории failover-событий (из нативного
// prefs) для ленты в чате диагностики. Без DOM/натива — юнит-тестируется.

import type { FailoverRecord } from '../native/bridge';

export const DAY_MS = 24 * 3_600_000;

export interface FailoverSummary {
  total: number;      // всего записей в журнале
  today: number;      // за последние сутки
  week: number;       // за последние 7 суток
  latest: FailoverRecord | null;
}

/** Считает сводку по журналу на момент now. */
export function summarizeFailovers(records: FailoverRecord[], now: number): FailoverSummary {
  const today = records.filter(r => now - r.ts <= DAY_MS).length;
  const week = records.filter(r => now - r.ts <= 7 * DAY_MS).length;
  return {
    total: records.length,
    today,
    week,
    latest: records.length > 0 ? records[0] : null, // журнал новые записи кладёт в начало
  };
}

/** Короткая метка времени: «только что», «5 мин назад», «3 ч назад», «вчера 14:05», «2 дн назад». */
export function formatTs(ts: number, now: number): string {
  const dt = now - ts;
  if (dt < 60_000) return 'только что';
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)} мин назад`;
  if (dt < DAY_MS) {
    const h = Math.floor(dt / 3_600_000);
    return h === 1 ? 'час назад' : `${h} ч назад`;
  }
  if (dt < 7 * DAY_MS) {
    const d = Math.floor(dt / DAY_MS);
    if (d === 1) {
      const t = new Date(ts);
      return `вчера в ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    }
    return `${d} дн назад`;
  }
  return `${Math.floor(dt / (7 * DAY_MS))} нед назад`;
}

/** Склонение: 1 переключение, 2 переключения, 5 переключений. */
function pluralFailovers(n: number): string {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return '1 автопереключение';
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return `${n} автопереключения`;
  return `${n} автопереключений`;
}

/** Реплика Петровича по свежести последнего переключения. */
export function petrovichReaction(summary: FailoverSummary, now: number): string | null {
  if (!summary.latest) return null;
  // Сначала — по свежести: несколько за сутки/неделю важнее, чем «было одно».
  if (summary.today > 1) return `За сутки сервер уходил в отказ ${summary.today} раз. Сейчас сидим на «${summary.latest.name}».`;
  if (summary.week > 1) return `На этой неделе было ${pluralFailovers(summary.week)}. Последнее — на «${summary.latest.name}».`;
  if (summary.total === 1 && now - summary.latest.ts < DAY_MS) {
    return `Фоном я уже переключал тебя на «${summary.latest.name}» — прошлый сервер, видимо, лёг.`;
  }
  if (summary.week > 0) return `На этой неделе было ${pluralFailovers(summary.week)}. Последнее — на «${summary.latest.name}».`;
  return `Последний раз я менял сервер на «${summary.latest.name}» ${formatTs(summary.latest.ts, now)}.`;
}

/** Короткое имя эндпоинта для ленты (обрубаем www и схему). */
export function endpointLabel(ep: string): string {
  if (!ep) return '?';
  return ep.replace(/^wss?:\/\//i, '').replace(/^www\./i, '');
}

/** Ключ кэша, чтобы чат не перечитывал журнал при каждом рендере. */
export const FAILOVER_JOURNAL_CACHE_KEY = 'sim-failover-journal-cache';