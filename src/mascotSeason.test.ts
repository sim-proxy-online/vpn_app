import { describe, expect, it } from 'vitest';
import { MASCOT_BY_SEASON, pickMascot, sessionMascot } from './utils/mascotSeason';
import type { Season } from './utils/idlePhrases';

// Сезонная подмена картинки Петровича: в каждом сезоне два варианта, выбор рандомный на сессию.

const SEASONS: Season[] = ['winter', 'spring', 'summer', 'autumn'];

describe('MASCOT_BY_SEASON', () => {
  it('в каждом сезоне ровно два разных варианта', () => {
    for (const season of SEASONS) {
      expect(MASCOT_BY_SEASON[season], season).toHaveLength(2);
      expect(MASCOT_BY_SEASON[season][0], season).not.toBe(MASCOT_BY_SEASON[season][1]);
    }
  });

  it('все восемь сезонных картинок различны (нет копипасты между сезонами)', () => {
    const all = SEASONS.flatMap((s) => MASCOT_BY_SEASON[s]);
    expect(new Set(all).size).toBe(8);
  });
});

describe('pickMascot', () => {
  it('всегда возвращает картинку из пула своего сезона', () => {
    for (const season of SEASONS) {
      const pool = MASCOT_BY_SEASON[season];
      expect(pool, season).toContain(pickMascot(season, () => 0));
      expect(pool, season).toContain(pickMascot(season, () => 0.5));
      expect(pool, season).toContain(pickMascot(season, () => 0.9999));
    }
  });

  it('детерминируется rnd: границы пула отработаны', () => {
    const pool = MASCOT_BY_SEASON.winter;
    expect(pickMascot('winter', () => 0)).toBe(pool[0]);
    expect(pickMascot('winter', () => 0.5)).toBe(pool[1]);
    expect(pickMascot('winter', () => 0.9999)).toBe(pool[1]);
  });

  it('кривой rnd не выходит за пределы пула', () => {
    for (const season of SEASONS) {
      expect(() => pickMascot(season, () => 5), season).not.toThrow();
      expect(() => pickMascot(season, () => -1), season).not.toThrow();
      expect(MASCOT_BY_SEASON[season], season).toContain(pickMascot(season, () => 5));
      expect(MASCOT_BY_SEASON[season], season).toContain(pickMascot(season, () => -1));
    }
  });
});

describe('sessionMascot', () => {
  it('на протяжении сессии возвращает одну и ту же картинку', () => {
    expect(sessionMascot()).toBe(sessionMascot());
  });

  it('возвращает одну из восьми сезонных картинок', () => {
    const all = SEASONS.flatMap((s) => MASCOT_BY_SEASON[s]);
    expect(all).toContain(sessionMascot());
  });
});
