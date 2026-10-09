import { describe, it, expect } from 'vitest';
import { accentVars, withAlpha, accentAtHour, dayPart } from './color';

describe('accentVars', () => {
  it('builds the accent variable set incl. rgba channels', () => {
    const v = accentVars('#00f0ff');
    expect(v['--accent']).toBe('#00f0ff');
    expect(v['--accent-rgb']).toBe('0, 240, 255');
    expect(v['--accent-a33']).toBe('#00f0ff33');
  });
});

describe('withAlpha', () => {
  it('appends alpha to a plain hex', () => {
    expect(withAlpha('#00ff88', '20')).toBe('#00ff8820');
  });
  it('switches to rgba when the color is the accent variable', () => {
    expect(withAlpha('var(--accent)', '20')).toBe('rgba(var(--accent-rgb),0.125)');
  });
});

describe('dayPart', () => {
  it('buckets the hour into morning / day / evening / night', () => {
    expect(dayPart(3).key).toBe('night');
    expect(dayPart(8).key).toBe('morning');
    expect(dayPart(13).key).toBe('day');
    expect(dayPart(19).key).toBe('evening');
    expect(dayPart(23).key).toBe('night');
  });
});

describe('accentAtHour', () => {
  it('is a no-op for the daytime (base color unchanged)', () => {
    expect(accentAtHour('#00f0ff', 13)).toBe('#00f0ff');
  });

  it('shifts toward warmer in the evening (hue moves away from cyan)', () => {
    const evening = accentAtHour('#00f0ff', 19);
    // cyan H≈180 → evening shift -28 → ~152 (green/teal), distinctly different
    expect(evening).not.toBe('#00f0ff');
    expect(evening).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('darkens at night', () => {
    const night = accentAtHour('#00f0ff', 23);
    expect(night).not.toBe('#00f0ff');
  });

  it('returns a valid hex for any hour', () => {
    for (let h = 0; h < 24; h++) expect(accentAtHour('#ff3b5c', h)).toMatch(/^#[0-9a-f]{6}$/);
  });
});