import { beforeEach, describe, expect, it } from 'vitest';
import {
  BYPASS_STRATEGIES, ConnectVerifyError, MAX_ATTEMPTS, applyAttempt, describeAttempt, getPreferredStrategy,
  isAutoBypassEnabled, ladderApplies, makeNetworkKey, planAttempts, recordSuccess, setAutoBypassEnabled,
  type FragSettings,
} from './utils/autoBypass';

const light: FragSettings = { fragEnable: true, fragPackets: 'tlshello', fragLength: '10-20', fragInterval: '1-5' };
const off: FragSettings = { ...light, fragEnable: false };
const custom: FragSettings = { fragEnable: true, fragPackets: 'tlshello', fragLength: '30-60', fragInterval: '10-20' };
const ids = (a: { id: string }[]) => a.map((x) => x.id);

beforeEach(() => { localStorage.clear(); });

describe('planAttempts', () => {
  it('starts with the user settings and then tries the other modes', () => {
    expect(ids(planAttempts(light, null))).toEqual(['user', 'plain', 'strong']);
    expect(ids(planAttempts(off, null))).toEqual(['user', 'light', 'strong']);
  });

  it('custom user settings are tried first, then the two most different modes', () => {
    expect(ids(planAttempts(custom, null))).toEqual(['user', 'plain', 'strong']);
  });

  it('a mode remembered for the network goes first', () => {
    expect(ids(planAttempts(light, 'strong'))).toEqual(['strong', 'user', 'plain']);
    expect(ids(planAttempts(off, 'light'))).toEqual(['light', 'user', 'strong']);
  });

  it('a remembered mode equal to the user settings is not tried twice', () => {
    expect(ids(planAttempts(light, 'light'))).toEqual(['user', 'plain', 'strong']);
  });

  it('never plans more than the allowed number of attempts', () => {
    for (const cur of [light, off, custom]) for (const p of [null, 'light', 'plain', 'strong'] as const) {
      expect(planAttempts(cur, p).length).toBeLessThanOrEqual(MAX_ATTEMPTS);
    }
  });
});

describe('applyAttempt', () => {
  it('replaces only the fragmentation fields', () => {
    const base = { ...light, socksPort: '10808' };
    const out = applyAttempt(base, { id: 'strong', strategy: BYPASS_STRATEGIES.strong, label: 'x' });
    expect(out).toMatchObject({ fragEnable: true, fragLength: '1-5', fragInterval: '1-3', socksPort: '10808' });
    expect(base.fragLength).toBe('10-20'); // исходный объект не меняется
  });

  it('the user attempt returns the very same settings', () => {
    const base = { ...custom };
    expect(applyAttempt(base, { id: 'user', strategy: null, label: 'x' })).toBe(base);
  });

  it('"plain" switches fragmentation off', () => {
    expect(applyAttempt(light, { id: 'plain', strategy: BYPASS_STRATEGIES.plain, label: 'x' }).fragEnable).toBe(false);
  });
});

describe('ladderApplies', () => {
  it('only TCP link nodes of the Xray protocols', () => {
    expect(ladderApplies({ protocol: 'vless', transport: 'tcp' })).toBe(true);
    expect(ladderApplies({ protocol: 'trojan', transport: 'ws' })).toBe(true);
    expect(ladderApplies({ protocol: 'vless', transport: 'kcp' })).toBe(false);
    expect(ladderApplies({ protocol: 'hysteria2', transport: 'tcp' })).toBe(false);
    expect(ladderApplies({ protocol: 'tuic', transport: undefined })).toBe(false);
    expect(ladderApplies({ protocol: 'json', transport: undefined })).toBe(false);
  });
});

describe('network key and memory', () => {
  it('mobile networks are told apart by operator, Wi-Fi by provider', () => {
    expect(makeNetworkKey('MOBILE', 'MegaFon RUS')).toBe('MOBILE:megafonrus');
    expect(makeNetworkKey('MOBILE', 'МТС')).toBe('MOBILE:мтс');
    expect(makeNetworkKey('WIFI', 'MegaFon', 'Ростелеком')).toBe('WIFI:ростелеком');
    expect(makeNetworkKey('WIFI', 'MegaFon')).toBe('WIFI');
    expect(makeNetworkKey('', '')).toBe('UNKNOWN');
  });

  it('remembers the mode that worked and forgets it when the user settings work again', () => {
    const key = 'MOBILE:megafonrus';
    expect(getPreferredStrategy(key)).toBeNull();
    recordSuccess(key, { id: 'strong', strategy: BYPASS_STRATEGIES.strong, label: 'x' });
    expect(getPreferredStrategy(key)).toBe('strong');
    expect(getPreferredStrategy('WIFI')).toBeNull();
    recordSuccess(key, { id: 'user', strategy: null, label: 'x' });
    expect(getPreferredStrategy(key)).toBeNull();
  });

  it('keeps only the most recent networks', () => {
    for (let i = 0; i < 40; i++) {
      recordSuccess(`WIFI:n${i}`, { id: 'plain', strategy: BYPASS_STRATEGIES.plain, label: 'x' }, 1000 + i);
    }
    const saved = JSON.parse(localStorage.getItem('sim-auto-bypass-pref') || '{}');
    expect(Object.keys(saved)).toHaveLength(24);
    expect(saved['WIFI:n39']).toBeDefined();
    expect(saved['WIFI:n0']).toBeUndefined();
  });

  it('survives garbage in the storage', () => {
    localStorage.setItem('sim-auto-bypass-pref', '{not json');
    expect(getPreferredStrategy('WIFI')).toBeNull();
    localStorage.setItem('sim-auto-bypass-pref', JSON.stringify({ WIFI: { id: 'bogus', ts: 1 } }));
    expect(getPreferredStrategy('WIFI')).toBeNull();
  });
});

describe('switch and helpers', () => {
  it('auto mode is on by default and can be turned off', () => {
    expect(isAutoBypassEnabled()).toBe(true);
    setAutoBypassEnabled(false);
    expect(isAutoBypassEnabled()).toBe(false);
    setAutoBypassEnabled(true);
    expect(isAutoBypassEnabled()).toBe(true);
  });

  it('the verify error is recognisable and the hint reads well', () => {
    const e = new ConnectVerifyError('нет ответа');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ConnectVerifyError');
    expect(describeAttempt(1, 3, { id: 'plain', strategy: BYPASS_STRATEGIES.plain, label: 'без фрагментации' }))
      .toBe('Подбираю обход · попытка 2 из 3: без фрагментации');
  });
});
