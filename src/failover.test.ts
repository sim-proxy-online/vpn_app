import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FAILOVER, cooldownPassed, failoverApplies, initialHealth, isBalancerNode, isFastFailoverEnabled, isPriorityNode, nextDelayMs, onProbe,
  planFailover, recordAction, restartAllowed, setFastFailoverEnabled, type HealthState,
} from './utils/failover';
import type { ServerNode } from './types';

const node = (id: string, over: Partial<ServerNode> = {}): ServerNode =>
  ({ id, name: id, address: `${id}.example.net`, port: 443, protocol: 'vless', remark: '', rawLink: '', ...over } as ServerNode);
const run = (results: boolean[], start: HealthState = initialHealth()) => {
  let s = start; let verdict = 'ok';
  for (const ok of results) { const r = onProbe(s, ok); s = r.state; verdict = r.verdict; }
  return { s, verdict };
};

beforeEach(() => { localStorage.clear(); });

describe('onProbe', () => {
  it('three failures in a row after a good probe mean the server is dead; two are only a suspicion', () => {
    expect(run([true, false]).verdict).toBe('suspect');
    expect(run([true, false, false]).verdict).toBe('suspect');
    expect(run([true, false, false, false]).verdict).toBe('dead');
  });

  it('a single failure followed by a success resets the counter', () => {
    const r = run([true, false, true, false]);
    expect(r.verdict).toBe('suspect');
    expect(r.s.consecutiveFails).toBe(1);
  });

  it('never declares death before the first successful probe (unsupported platform / slow start)', () => {
    expect(run([false, false, false, false]).verdict).toBe('suspect');
  });

  it('waits a few seconds before re-checking (a short outage must not count as several failures) and relaxes when healthy', () => {
    expect(nextDelayMs('suspect')).toBe(DEFAULT_FAILOVER.retryDelayMs);
    expect(nextDelayMs('dead')).toBe(DEFAULT_FAILOVER.retryDelayMs);
    expect(DEFAULT_FAILOVER.retryDelayMs).toBeGreaterThanOrEqual(3_000);
    expect(nextDelayMs('ok')).toBe(DEFAULT_FAILOVER.healthyIntervalMs);
  });

  it('worst-case detection is patient but stays well below the old 80 seconds', () => {
    // интервал между проверками + три провала по двум целям проверки (5 с + 4 с) + паузы между ними
    const worst = DEFAULT_FAILOVER.healthyIntervalMs + DEFAULT_FAILOVER.failThreshold * 9_000
      + (DEFAULT_FAILOVER.failThreshold - 1) * DEFAULT_FAILOVER.retryDelayMs;
    expect(worst).toBeGreaterThan(30_000);
    expect(worst).toBeLessThan(60_000);
  });
});

describe('cooldown and restart limits', () => {
  it('waits between actions', () => {
    const s = recordAction(initialHealth(), 1_000, 'switch');
    expect(cooldownPassed(s, 1_000 + DEFAULT_FAILOVER.cooldownMs - 1)).toBe(false);
    expect(cooldownPassed(s, 1_000 + DEFAULT_FAILOVER.cooldownMs)).toBe(true);
  });

  it('allows only a couple of restarts per window, and forgets old ones', () => {
    let s = initialHealth();
    for (const t of [0, 60_000]) s = recordAction(s, t, 'restart');
    expect(restartAllowed(s, 100_000)).toBe(false);
    expect(restartAllowed(s, DEFAULT_FAILOVER.restartWindowMs + 1)).toBe(true); // первый перезапуск вышел из окна
    expect(restartAllowed(recordAction(initialHealth(), 0, 'switch'), 1)).toBe(true); // переключения не считаются
  });
});

describe('planFailover', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d'), node('cfg', { protocol: 'json' }), node('noaddr', { address: '' })];
  const ping = (m: Record<string, number>) => (id: string) => m[id] ?? 0;

  it('skips the current server, balancer configs and servers without an address', () => {
    const out = planFailover({ current: node('a'), nodes, failedAt: {}, cachedPing: ping({}), now: 0 });
    expect(out.map((n) => n.id)).toEqual(['b', 'c', 'd']);
  });

  it('prefers priority servers, then known fast ones, then the rest in list order', () => {
    const out = planFailover({
      current: node('a'), nodes, failedAt: {}, now: 0, limit: 5,
      cachedPing: ping({ b: 0, c: 120, d: 60 }),
      isPriority: (n) => n.id === 'b',
    });
    expect(out.map((n) => n.id)).toEqual(['b', 'd', 'c']);
  });

  it('does not pick a server that failed recently, but may after the cool-down', () => {
    const failedAt = { b: 1_000 };
    const soon = planFailover({ current: node('a'), nodes, failedAt, cachedPing: ping({}), now: 2_000 });
    expect(soon.map((n) => n.id)).not.toContain('b');
    const later = planFailover({ current: node('a'), nodes, failedAt, cachedPing: ping({}), now: 1_000 + DEFAULT_FAILOVER.nodeCooldownMs });
    expect(later.map((n) => n.id)).toContain('b');
  });

  it('a profile with one server has no candidates (the caller restarts instead)', () => {
    expect(planFailover({ current: node('a'), nodes: [node('a')], failedAt: {}, cachedPing: ping({}), now: 0 })).toEqual([]);
  });

  it('recognises balancer configs', () => {
    expect(isBalancerNode({ protocol: 'json' })).toBe(true);
    expect(isBalancerNode({ protocol: 'vless' })).toBe(false);
  });

  it('does not watch ready-made balancer configs at all (the balancer switches by itself), only plain servers', () => {
    expect(failoverApplies({ protocol: 'json' })).toBe(false);
    expect(failoverApplies({ protocol: 'vless' })).toBe(true);
    expect(failoverApplies({ protocol: 'hysteria2' })).toBe(true);
    expect(failoverApplies(null)).toBe(false);
    expect(failoverApplies(undefined)).toBe(false);
  });
});

describe('switch', () => {
  it('is on by default and can be turned off', () => {
    expect(isFastFailoverEnabled()).toBe(true);
    setFastFailoverEnabled(false);
    expect(isFastFailoverEnabled()).toBe(false);
  });
});

describe('isPriorityNode', () => {
  it('marks DPI-bypass servers for mobile networks, plain names are not priority', () => {
    expect(isPriorityNode({ name: '4G обход', remark: '' })).toBe(true);
    expect(isPriorityNode({ name: 'NL', remark: 'lte backup' })).toBe(true);
    expect(isPriorityNode({ name: 'Франкфурт 1', remark: '' })).toBe(false);
  });
});
