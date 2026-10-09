import { describe, expect, it } from 'vitest';
import { PING_FAIL_COLOR, PING_UNKNOWN_COLOR, pingTone } from './utils/ping';

describe('pingTone', () => {
  it('shows milliseconds with the unit', () => {
    expect(pingTone(831).label).toBe('831 мс');
    expect(pingTone(42).label).toBe('42 мс');
    expect(pingTone(41.6).label).toBe('42 мс');
  });

  it('colour and bars follow the scale: green, yellow, orange, red', () => {
    expect(pingTone(40)).toMatchObject({ color: '#00e08a', level: 3 });
    expect(pingTone(180)).toMatchObject({ color: '#ffd23f', level: 2 });
    expect(pingTone(400)).toMatchObject({ color: '#ff9d3d', level: 1 });
    expect(pingTone(831)).toMatchObject({ color: '#ff5a4d', level: 1 });
  });

  it('the thresholds are exact', () => {
    expect(pingTone(99).level).toBe(3);
    expect(pingTone(100).level).toBe(2);
    expect(pingTone(249).level).toBe(2);
    expect(pingTone(250).level).toBe(1);
    expect(pingTone(499).color).toBe('#ff9d3d');
    expect(pingTone(500).color).toBe('#ff5a4d');
  });

  it('no answer is red, not measured yet is grey', () => {
    expect(pingTone(-1)).toEqual({ color: PING_FAIL_COLOR, level: 0, label: 'нет ответа' });
    expect(pingTone(undefined)).toEqual({ color: PING_UNKNOWN_COLOR, level: 0, label: '— мс' });
    expect(pingTone(Number.NaN).label).toBe('— мс');
  });
});
