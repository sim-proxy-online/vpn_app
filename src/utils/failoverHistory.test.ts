import { describe, it, expect } from 'vitest';
import type { FailoverRecord } from '../native/bridge';
import {
  summarizeFailovers, formatTs, petrovichReaction, endpointLabel, DAY_MS,
} from './failoverHistory';

const NOW = 1_000_000_000_000;
const mk = (ts: number, from: string, to: string, name: string): FailoverRecord => ({ ts, from, to, name });

const recs: FailoverRecord[] = [
  mk(NOW - 60_000, 'a:443', 'b:443', 'Бета'),          // минуту назад — today
  mk(NOW - 2 * DAY_MS, 'b:443', 'c:443', 'Гамма'),      // 2 дня — week
  mk(NOW - 5 * DAY_MS, 'c:443', 'd:443', 'Дельта'),     // 5 дней — week
  mk(NOW - 30 * DAY_MS, 'd:443', 'e:443', 'Эпсилон'),   // месяц — только total
];

describe('summarizeFailovers', () => {
  it('считает today/week/total', () => {
    const s = summarizeFailovers(recs, NOW);
    expect(s.total).toBe(4);
    expect(s.today).toBe(1);
    expect(s.week).toBe(3);
    expect(s.latest).toBe(recs[0]); // новые в начале
  });

  it('пустой журнал', () => {
    expect(summarizeFailovers([], NOW)).toEqual({ total: 0, today: 0, week: 0, latest: null });
  });
});

describe('formatTs', () => {
  it('пороговые значения', () => {
    expect(formatTs(NOW - 10_000, NOW)).toBe('только что');
    expect(formatTs(NOW - 5 * 60_000, NOW)).toBe('5 мин назад');
    expect(formatTs(NOW - 3_600_000, NOW)).toBe('час назад');
    expect(formatTs(NOW - 4 * 3_600_000, NOW)).toBe('4 ч назад');
    expect(formatTs(NOW - 2 * DAY_MS, NOW)).toBe('2 дн назад');
  });

  it('вчера в ЧЧ:ММ', () => {
    // n = 23:29, ts на 25 ч раньше → dt в [24,48)ч → ветка «вчера в ЧЧ:ММ».
    const n = new Date(NOW);
    n.setHours(23, 29, 0, 0);
    const ts = n.getTime() - 25 * 3_600_000;
    expect(formatTs(ts, n.getTime())).toBe('вчера в 22:29');
  });

  it('недели', () => {
    expect(formatTs(NOW - 8 * DAY_MS, NOW)).toBe('1 нед назад');
  });
});

describe('petrovichReaction', () => {
  it('единственное свежее переключение', () => {
    const s = summarizeFailovers([mk(NOW - 1000, 'a:443', 'b:443', 'Бета')], NOW);
    expect(petrovichReaction(s, NOW)).toMatch(/Фоном я уже переключал тебя на «Бета»/);
  });

  it('несколько за сутки', () => {
    const s = summarizeFailovers([
      mk(NOW - 1000, 'a:443', 'b:443', 'Бета'),
      mk(NOW - 2000, 'c:443', 'd:443', 'Гамма'),
    ], NOW);
    const r = petrovichReaction(s, NOW);
    expect(r).toMatch(/За сутки сервер уходил в отказ 2 раз/);
    expect(r).toMatch(/«Бета»/);
  });

  it('за неделю, но не за сутки', () => {
    const s = summarizeFailovers([
      mk(NOW - 2 * DAY_MS, 'a:443', 'b:443', 'Бета'),
      mk(NOW - 3 * DAY_MS, 'c:443', 'd:443', 'Гамма'),
    ], NOW);
    expect(petrovichReaction(s, NOW)).toMatch(/На этой неделе было 2 автопереключения/);
  });

  it('старое единственное', () => {
    const s = summarizeFailovers([mk(NOW - 30 * DAY_MS, 'a:443', 'b:443', 'Бета')], NOW);
    expect(petrovichReaction(s, NOW)).toMatch(/Последний раз я менял сервер на «Бета»/);
  });

  it('старое, но в пределах недели', () => {
    const s = summarizeFailovers([mk(NOW - 2 * DAY_MS, 'a:443', 'b:443', 'Бета')], NOW);
    expect(petrovichReaction(s, NOW)).toMatch(/На этой неделе было 1 автопереключение/);
  });

  it('пустой журнал → null', () => {
    expect(petrovichReaction(summarizeFailovers([], NOW), NOW)).toBeNull();
  });
});

describe('endpointLabel', () => {
  it('чистит схему и www', () => {
    expect(endpointLabel('www.alpha.com:443')).toBe('alpha.com:443');
    expect(endpointLabel('wss://beta.com:8443')).toBe('beta.com:8443');
    expect(endpointLabel('')).toBe('?');
  });
});