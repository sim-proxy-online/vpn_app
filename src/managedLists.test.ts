import { describe, expect, it } from 'vitest';
import { isSafeExcludeRoute, parsePackageList, planExcludeRoutes, planPerApp, splitList } from './utils/managedLists';

describe('package lists', () => {
  it('splits on commas, spaces and newlines; invalid names and the app itself are dropped', () => {
    expect(splitList('a.b, c.d\ne.f;g.h')).toEqual(['a.b', 'c.d', 'e.f', 'g.h']);
    expect(parsePackageList('com.google.chrome, ru.sberbankmobile')).toEqual(['com.google.chrome', 'ru.sberbankmobile']);
    expect(parsePackageList('com.google.chrome, rm -rf, ../etc, party.petrovich.app, com.simproxy.app')).toEqual(['com.google.chrome']);
    expect(parsePackageList('nodots')).toBeUndefined();
    expect(parsePackageList('')).toBeUndefined();
    expect(parsePackageList(Array.from({ length: 300 }, (_, i) => `a.b${i}`).join(','))).toBeUndefined();
  });
});

describe('planPerApp', () => {
  it('nothing to do without parameters, with mode off, or with a mode only', () => {
    expect(planPerApp(undefined)).toBeUndefined();
    expect(planPerApp('off', 'a.b')).toBeUndefined();
    expect(planPerApp('on')).toBeUndefined();
  });

  it('list gives the listed apps the mode; bypass sends them around the VPN', () => {
    expect(planPerApp('bypass', 'a.b, c.d')).toEqual({ mode: 'bypass', list: ['a.b', 'c.d'], replace: false });
    expect(planPerApp('ON', 'a.b')).toEqual({ mode: 'on', list: ['a.b'], replace: false });
  });

  it('invert flips the mode for the listed apps ("everything except these")', () => {
    expect(planPerApp('on', undefined, 'a.b')).toEqual({ mode: 'bypass', list: ['a.b'], replace: false });
    expect(planPerApp('bypass', undefined, 'a.b')).toEqual({ mode: 'on', list: ['a.b'], replace: false });
  });

  it('set replaces the previous marks and wins over list', () => {
    expect(planPerApp('bypass', 'x.y', undefined, 'a.b')).toEqual({ mode: 'bypass', list: ['a.b'], replace: true });
  });

  it('unknown mode or a list with nothing usable is rejected', () => {
    expect(planPerApp('maybe', 'a.b')).toBeNull();
    expect(planPerApp('on', 'not a package')).toBeNull();
  });
});

describe('exclude routes', () => {
  it('accepts addresses and subnets, refuses the ones that would bypass the whole tunnel', () => {
    expect(isSafeExcludeRoute('192.168.1.0/24')).toBe(true);
    expect(isSafeExcludeRoute('10.0.0.0/8')).toBe(true);
    expect(isSafeExcludeRoute('203.0.113.7')).toBe(true);
    expect(isSafeExcludeRoute('2001:db8::/32')).toBe(true);
    expect(isSafeExcludeRoute('0.0.0.0/0')).toBe(false);
    expect(isSafeExcludeRoute('128.0.0.0/1')).toBe(false);
    expect(isSafeExcludeRoute('::/0')).toBe(false);
    expect(isSafeExcludeRoute('300.1.1.1')).toBe(false);
    expect(isSafeExcludeRoute('example.org')).toBe(false);
  });

  it('plans: add, set, clear', () => {
    expect(planExcludeRoutes(undefined, undefined)).toBeUndefined();
    expect(planExcludeRoutes('192.168.1.0/24, 10.0.0.0/8', undefined)).toEqual({ list: ['192.168.1.0/24', '10.0.0.0/8'], replace: false });
    expect(planExcludeRoutes(undefined, '172.16.0.0/12')).toEqual({ list: ['172.16.0.0/12'], replace: true });
    expect(planExcludeRoutes(undefined, '')).toEqual({ list: [], replace: true });
    expect(planExcludeRoutes('', undefined)).toBeUndefined();
  });

  it('good entries survive next to bad ones; only bad ones means rejection', () => {
    expect(planExcludeRoutes('0.0.0.0/0, 192.168.1.0/24', undefined)).toEqual({ list: ['192.168.1.0/24'], replace: false });
    expect(planExcludeRoutes('0.0.0.0/0', undefined)).toBeNull();
  });
});
