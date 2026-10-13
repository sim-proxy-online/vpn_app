/**
 * Фразы Петровича, когда он не подключён: состояние одно — «не защищено», но фраза в облачке
 * зависит от времени года (по календарю устройства) и меняется при каждом входе на главный экран.
 * Чистая логика (юнит-тесты); рисует их MoodAccessories по переданному тексту.
 */

export type Season = 'winter' | 'spring' | 'summer' | 'autumn';

/** Месяц из Date.getMonth(): 0 = январь … 11 = декабрь. Значения вне диапазона отбрасываются к зиме. */
export function seasonForMonth(month: number): Season {
  if (!Number.isInteger(month) || month < 0 || month > 11) return 'winter';
  if (month === 11 || month <= 1) return 'winter';
  if (month <= 4) return 'spring';
  if (month <= 7) return 'summer';
  return 'autumn';
}

/** Текущий сезон. */
export function currentSeason(now: Date = new Date()): Season {
  return seasonForMonth(now.getMonth());
}

/** Фразы по сезонам; зима продолжает традицию «брр…». Короткие — облачко узкое. */
export const IDLE_PHRASES: Record<Season, readonly string[]> = {
  winter: ['брр…', 'стужа…', 'мёрзнуть', 'сугробы…'],
  spring: ['кап…', 'оттепель', 'подтаяло', 'капель…'],
  summer: ['жарко…', 'фух…', 'испаряюсь', 'зной…'],
  autumn: ['слякоть…', 'ветер…', 'хлюп…', 'листья…'],
};

/** Выбор фразы для сезона. rnd детерминируется извне (в приложении — Math.random, в тестах — заглушка). */
export function pickIdlePhrase(season: Season = currentSeason(), rnd: () => number = Math.random): string {
  const pool = IDLE_PHRASES[season];
  const i = Math.floor(rnd() * pool.length);
  return pool[Math.min(pool.length - 1, Math.max(0, i))];
}
