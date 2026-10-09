import { beforeEach, describe, expect, it } from 'vitest';
import { getBestCachedPing, readSimSettings } from './bridge';

describe('getBestCachedPing', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns -1 when nothing is cached', () => {
    expect(getBestCachedPing('missing-node')).toBe(-1);
  });

  it('returns the regular ping cache value when only that is set', () => {
    localStorage.setItem('sim-ping-result-cache-v2', JSON.stringify({ n1: 120 }));
    expect(getBestCachedPing('n1')).toBe(120);
  });

  it('prefers the lower of bypass vs regular cache (best known estimate)', () => {
    localStorage.setItem('sim-ping-result-cache-v2', JSON.stringify({ n1: 300 }));
    localStorage.setItem('sim-bypass-ping-cache-v4', JSON.stringify({ n1: { ms: 90, ts: Date.now() } }));
    expect(getBestCachedPing('n1')).toBe(90);
  });

  it('ignores non-positive cached values', () => {
    localStorage.setItem('sim-ping-result-cache-v2', JSON.stringify({ n1: 0 }));
    expect(getBestCachedPing('n1')).toBe(-1);
  });
});

describe('readSimSettings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('strips the sim- prefix and JSON-parses each value', () => {
    localStorage.setItem('sim-fragInterval', JSON.stringify('10-20'));
    localStorage.setItem('sim-socksPort', JSON.stringify(10808));
    localStorage.setItem('unrelated-key', JSON.stringify('ignored'));
    const settings = readSimSettings();
    expect(settings.fragInterval).toBe('10-20');
    expect(settings.socksPort).toBe(10808);
    expect(settings['unrelated-key']).toBeUndefined();
  });

  it('skips keys whose value is not valid JSON instead of throwing', () => {
    localStorage.setItem('sim-broken', 'not-json{');
    localStorage.setItem('sim-ok', JSON.stringify(true));
    const settings = readSimSettings();
    expect(settings.broken).toBeUndefined();
    expect(settings.ok).toBe(true);
  });
});
