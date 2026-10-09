import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_PROFILES, REFRESH_EVERY_MS, activeProfiles, isAllowedDnsServer, mergeDocs, parseAsn, refreshOperatorProfiles,
  resolveOperatorProfile, sanitizeDoc, type OperatorProfilesDoc,
} from './utils/operatorProfiles';
import { applyIspPresetToStorage } from './utils/ispPreset';
import { planAttempts } from './utils/autoBypass';
import { buildXrayConfig } from './native/bridge';
import type { ServerNode } from './types';

beforeEach(() => { localStorage.clear(); });

describe('isAllowedDnsServer', () => {
  it('accepts well-known resolvers (plain and DoH) only', () => {
    expect(isAllowedDnsServer('77.88.8.8')).toBe(true);
    expect(isAllowedDnsServer('https://cloudflare-dns.com/dns-query')).toBe(true);
    expect(isAllowedDnsServer('https://dns.google/dns-query')).toBe(true);
    expect(isAllowedDnsServer('6.6.6.6')).toBe(false);
    expect(isAllowedDnsServer('http://dns.google/dns-query')).toBe(false);
    expect(isAllowedDnsServer('https://evil.example/dns-query')).toBe(false);
    expect(isAllowedDnsServer('https://user:pw@dns.google/dns-query')).toBe(false);
    expect(isAllowedDnsServer('localhost')).toBe(false);
    expect(isAllowedDnsServer(123)).toBe(false);
  });
});

describe('sanitizeDoc', () => {
  const raw = (profiles: unknown[], rev: unknown = 5) => ({ rev, profiles });

  it('keeps valid fields and clamps numbers', () => {
    const d = sanitizeDoc(raw([{
      id: 'megafon', title: 'Мегафон', match: { names: ['MegaFon'], asns: [31133, -1, 1.5, 'x'] },
      frag: { enable: true, packets: 'tlshello', length: '0-99999', interval: '3-1' },
      bypassFirst: 'strong', dns: { extra: ['77.88.8.8', '6.6.6.6'], parallel: true }, failoverIntervalSec: 1, note: 'жёстко',
    }]))!;
    expect(d.rev).toBe(5);
    expect(d.profiles[0]).toEqual({
      id: 'megafon', title: 'Мегафон', match: { names: ['megafon'], asns: [31133] },
      frag: { enable: true, packets: 'tlshello', length: '1-2000', interval: '1-3' },
      bypassFirst: 'strong', dns: { extra: ['77.88.8.8'], parallel: true }, failoverIntervalSec: 4, note: 'жёстко',
    });
  });

  it('drops profiles with a bad id or no title, duplicates, and unknown fields', () => {
    const d = sanitizeDoc(raw([
      { id: 'Bad ID', title: 'x' }, { id: 'ok', title: '' }, { id: 'a', title: 'A', evil: '<script>', match: {} },
      { id: 'a', title: 'A again' }, null, 'str',
    ]))!;
    expect(d.profiles.map((p) => p.id)).toEqual(['a']);
    expect(d.profiles[0]).not.toHaveProperty('evil');
    expect(d.profiles[0].title).toBe('A');
  });

  it('rejects things that are not a profiles document', () => {
    expect(sanitizeDoc(null)).toBeNull();
    expect(sanitizeDoc({ rev: 'x', profiles: [] })).toBeNull();
    expect(sanitizeDoc({ rev: 1, profiles: 'nope' })).toBeNull();
  });

  it('ignores an unsupported bypassFirst and an out-of-range failover interval is clamped', () => {
    const d = sanitizeDoc(raw([{ id: 'a', title: 'A', bypassFirst: 'hack', failoverIntervalSec: 999 }]))!;
    expect(d.profiles[0].bypassFirst).toBeUndefined();
    expect(d.profiles[0].failoverIntervalSec).toBe(30);
  });
});

describe('resolveOperatorProfile', () => {
  const doc = BUNDLED_PROFILES;
  const id = (ctx: Parameters<typeof resolveOperatorProfile>[0]) => resolveOperatorProfile(ctx, doc)?.id;

  it('finds the operator by ASN, by SIM carrier name and by provider name', () => {
    expect(id({ ispRaw: 'AS31133 PJSC MegaFon' })).toBe('megafon');
    expect(id({ asn: 8359 })).toBe('mts');
    expect(id({ carrier: 'MegaFon RUS' })).toBe('megafon');
    expect(id({ carrier: 'MTS RUS' })).toBe('mts');
    expect(id({ carrier: 'TELE2' })).toBe('tele2');
    expect(id({ ispName: 'Ростелеком' })).toBe('rostelecom');
    expect(id({ carrier: 'Beeline' })).toBe('beeline');
  });

  it('short names must be whole words: no false match inside another word', () => {
    expect(id({ carrier: 'smtsys networks' })).toBe('default');
    expect(id({ carrier: 'attt' })).toBe('default');
  });

  it('an unknown network gets the default profile', () => {
    expect(id({ carrier: 'Some Telecom' })).toBe('default');
    expect(id({})).toBe('default');
    expect(resolveOperatorProfile({ carrier: 'x' }, { rev: 1, profiles: [] })).toBeNull();
  });

  it('parses the ASN from an org string', () => {
    expect(parseAsn('AS8359 PJSC MTS')).toBe(8359);
    expect(parseAsn('PJSC MTS')).toBeUndefined();
  });
});

describe('mergeDocs and the active set', () => {
  it('server profiles replace bundled ones with the same id, other bundled ones stay', () => {
    const remote: OperatorProfilesDoc = { rev: 7, profiles: [{ id: 'megafon', title: 'Мегафон (сервер)', match: { names: ['megafon'] } }, { id: 'newop', title: 'Новый', match: { names: ['newop'] } }] };
    const m = mergeDocs(BUNDLED_PROFILES, remote);
    expect(m.rev).toBe(7);
    expect(m.profiles.find((p) => p.id === 'megafon')?.title).toBe('Мегафон (сервер)');
    expect(m.profiles.some((p) => p.id === 'mts')).toBe(true);
    expect(m.profiles.some((p) => p.id === 'newop')).toBe(true);
    expect(mergeDocs(BUNDLED_PROFILES, null)).toBe(BUNDLED_PROFILES);
  });

  it('with nothing stored the bundled profiles are used', () => {
    expect(activeProfiles()).toEqual(BUNDLED_PROFILES);
  });
});

describe('refreshOperatorProfiles', () => {
  const doc = (rev: number, title = 'Мегафон') => ({ rev, profiles: [{ id: 'megafon', title, match: { names: ['megafon'] } }] });
  const NOW = 1_800_000_000_000;

  it('stores a good answer and uses it afterwards', async () => {
    expect(await refreshOperatorProfiles({ fetcher: async () => doc(3, 'С сервера'), now: NOW })).toBe(true);
    expect(activeProfiles().profiles.find((p) => p.id === 'megafon')?.title).toBe('С сервера');
  });

  it('does not ask the server again within six hours unless forced', async () => {
    await refreshOperatorProfiles({ fetcher: async () => doc(3), now: NOW });
    let calls = 0;
    const f = async () => { calls++; return doc(4); };
    expect(await refreshOperatorProfiles({ fetcher: f, now: NOW + REFRESH_EVERY_MS - 1 })).toBe(false);
    expect(calls).toBe(0);
    expect(await refreshOperatorProfiles({ fetcher: f, now: NOW + REFRESH_EVERY_MS })).toBe(true);
    expect(await refreshOperatorProfiles({ fetcher: f, now: NOW + REFRESH_EVERY_MS + 5, force: true })).toBe(true);
    expect(calls).toBe(2);
  });

  it('a network failure, garbage or an older version leaves the stored profiles alone', async () => {
    await refreshOperatorProfiles({ fetcher: async () => doc(5, 'Кэш'), now: NOW });
    const keep = () => activeProfiles().profiles.find((p) => p.id === 'megafon')?.title;
    expect(await refreshOperatorProfiles({ fetcher: async () => { throw new Error('offline'); }, force: true })).toBe(false);
    expect(await refreshOperatorProfiles({ fetcher: async () => ({ nonsense: true }), force: true })).toBe(false);
    expect(await refreshOperatorProfiles({ fetcher: async () => ({ rev: 1, profiles: [] }), force: true })).toBe(false);
    expect(await refreshOperatorProfiles({ fetcher: async () => doc(2, 'Старее'), force: true })).toBe(false);
    expect(keep()).toBe('Кэш');
  });
});

describe('use in the app', () => {
  it('an operator profile refines the built-in DPI preset field by field', () => {
    applyIspPresetToStorage('aggressive', { id: 'x', title: 'X', match: {}, frag: { length: '1-3', interval: '5-10' } });
    expect(JSON.parse(localStorage.getItem('sim-frag-length')!)).toBe('1-3');
    expect(JSON.parse(localStorage.getItem('sim-frag-interval')!)).toBe('5-10');
    expect(JSON.parse(localStorage.getItem('sim-frag-packets')!)).toBe('tlshello'); // не задано профилем — осталось от пресета
    applyIspPresetToStorage('aggressive');
    expect(JSON.parse(localStorage.getItem('sim-frag-length')!)).toBe('1-5');
  });

  it('the operator hint decides where the auto-bypass ladder starts', () => {
    const custom = { fragEnable: true, fragPackets: 'tlshello', fragLength: '30-60', fragInterval: '10-20' };
    expect(planAttempts(custom, 'strong')[0].id).toBe('strong');
    expect(planAttempts(custom, null)[0].id).toBe('user');
  });

  const node = { id: 'n', name: 'n', address: '203.0.113.5', port: 443, protocol: 'vless', remark: '', rawLink: '', security: 'reality', uuid: 'u', sni: 'example.com', publicKey: 'pk', shortId: 'ab', transport: 'tcp' } as ServerNode;
  const dnsOf = (settings: Record<string, unknown>) => JSON.parse(buildXrayConfig(node, settings)).dns;

  it('DNS: all servers are queried in parallel by default, and the operator can add resolvers', () => {
    const d = dnsOf({ dnsExtra: ['77.88.8.8', '8.8.8.8'] });
    expect(d.enableParallelQuery).toBe(true);
    expect(d.servers).toContain('77.88.8.8');
    expect(d.servers.filter((s: string) => s === '8.8.8.8')).toHaveLength(1); // дубликат не добавлен
    expect(d.servers[0]).toBe('https://8.8.8.8/dns-query');                    // порядок прежних серверов не менялся
  });

  it('DNS: parallel query can be switched off by the profile', () => {
    expect(dnsOf({ dnsParallel: false }).enableParallelQuery).toBeUndefined();
  });
});
