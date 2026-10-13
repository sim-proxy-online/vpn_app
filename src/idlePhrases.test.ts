import { describe, expect, it } from 'vitest';
import { currentSeason, IDLE_PHRASES, pickIdlePhrase, seasonForMonth, type Season } from './utils/idlePhrases';

// Сезонная логика фраз Петровича для «не защищено»: месяц → сезон, выбор фразы из пула сезона.

describe('seasonForMonth', () => {
  it('маппит все 12 месяцев на сезоны', () => {
    expect(seasonForMonth(11)).toBe('winter'); // декабрь
    expect(seasonForMonth(0)).toBe('winter');  // январь
    expect(seasonForMonth(1)).toBe('winter');  // февраль
    expect(seasonForMonth(2)).toBe('spring');  // март
    expect(seasonForMonth(4)).toBe('spring');  // май
    expect(seasonForMonth(5)).toBe('summer');  // июнь
    expect(seasonForMonth(7)).toBe('summer');  // август
    expect(seasonForMonth(8)).toBe('autumn');  // сентябрь
    expect(seasonForMonth(10)).toBe('autumn'); // ноябрь
  });

  it('отбрасывает значения вне диапазона (лучше базовый зимний вид)', () => {
    expect(seasonForMonth(12)).toBe('winter');
    expect(seasonForMonth(-1)).toBe('winter');
    expect(seasonForMonth(2.5)).toBe('winter');
  });
});

describe('currentSeason', () => {
  it('совпадает с месяцем переданной даты', () => {
    expect(currentSeason(new Date('2026-10-13T12:00:00Z'))).toBe('autumn');
    expect(currentSeason(new Date('2026-01-15T12:00:00Z'))).toBe('winter');
  });
});

describe('pickIdlePhrase', () => {
  it('возвращает фразу из пула своего сезона', () => {
    for (const season of Object.keys(IDLE_PHRASES) as Season[]) {
      expect(IDLE_PHRASES[season]).toContain(pickIdlePhrase(season, () => 0.5));
    }
  });

  it('детерминируется rnd: границы пула отработаны', () => {
    const pool = IDLE_PHRASES.summer;
    expect(pickIdlePhrase('summer', () => 0)).toBe(pool[0]);
    expect(pickIdlePhrase('summer', () => 0.9999)).toBe(pool[pool.length - 1]);
  });

  it('кривой rnd не выходит за пределы пула', () => {
    expect(() => pickIdlePhrase('winter', () => 5)).not.toThrow();
    expect(() => pickIdlePhrase('winter', () => -1)).not.toThrow();
  });

  it('в каждом сезоне есть хотя бы две разные фразы (смысл ротации)', () => {
    for (const season of Object.keys(IDLE_PHRASES) as Season[]) {
      expect(new Set(IDLE_PHRASES[season]).size).toBeGreaterThanOrEqual(2);
    }
  });
});
