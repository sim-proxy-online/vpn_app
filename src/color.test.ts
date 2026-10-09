import { describe, expect, it } from 'vitest';
import { ACCENT_ALPHAS, accentVars, withAlpha } from './utils/color';

describe('accentVars', () => {
  it('gives the accent, its rgb channels and every alpha variant the styles use', () => {
    const v = accentVars('#9377ff');
    expect(v['--accent']).toBe('#9377ff');
    expect(v['--accent-rgb']).toBe('147, 119, 255');
    for (const a of ACCENT_ALPHAS) expect(v[`--accent-a${a}`]).toBe('#9377ff' + a);
    expect(Object.keys(v)).toHaveLength(2 + ACCENT_ALPHAS.length);
  });

  it('covers every --accent-aXX variable that index.css defines', () => {
    expect(ACCENT_ALPHAS).toEqual(['08', '10', '11', '12', '15', '20', '22', '33', '40', '44', '66', '88']);
  });
});

describe('withAlpha', () => {
  it('appends the alpha to a hex colour and uses the channel variable for var(--accent)', () => {
    expect(withAlpha('#00ff88', '20')).toBe('#00ff8820');
    expect(withAlpha('var(--accent)', '80')).toBe('rgba(var(--accent-rgb),0.502)');
  });
});
