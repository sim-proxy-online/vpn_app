import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UA, HAPP_MODE_KEY, HAPP_UA, REPROBE_AFTER_MS, fetchSubscription, friendlyUpdateError, isHappModeEnabled, richness,
  type FetchDeps, type Fetched,
} from './utils/subscriptionFetch';
import { parseSubscription } from './data';

// Мост: viaSocksPort подменяет сетевой слой на запрос через локальный SOCKS туннеля.
const viaProxyMock = vi.hoisted(() => vi.fn());
vi.mock('./native/bridge', () => ({
  nativeFetchUrl: vi.fn(),
  nativeFetchUrlViaProxy: viaProxyMock,
}));

const UUID = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;

/** Тело подписки из n серверов; с описанием (как отдаёт Happ-клиентам) или без. */
const links = (n: number, withDescription: boolean) => Array.from({ length: n }, (_, i) =>
  `vless://${UUID}@h${i}.example:443?security=tls#Узел${i}${withDescription ? `?serverDescription=${encodeURIComponent('Описание ' + i)}` : ''}`).join('\n');
const ok = (body: string): Fetched => ({ ok: true, body, headers: {} });

/** Подставной сетевой слой: что вернуть для каждого User-Agent, и сколько было запросов. */
function fake(answers: Record<string, Fetched | Error>, over: Partial<FetchDeps> = {}) {
  const calls: string[] = [];
  const deps: FetchDeps = {
    fetch: async (_url, ua) => {
      calls.push(ua);
      const a = answers[ua];
      if (a instanceof Error) throw a;
      if (a === undefined) throw new Error('no answer for ' + ua);
      return a;
    },
    parse: parseSubscription,
    enabled: () => true,
    now: () => NOW,
    ...over,
  };
  return { deps, calls };
}

describe('fetchSubscription: first contact with a provider', () => {
  it('adopts the Happ request when it brings descriptions, and remembers that', async () => {
    const { deps, calls } = fake({ [DEFAULT_UA]: ok(links(2, false)), [HAPP_UA]: ok(links(2, true)) });
    const r = await fetchSubscription('https://sub.example/x', {}, deps);
    expect(parseSubscription((r.res as any).body).nodes.map((n) => n.description)).toEqual(['Описание 0', 'Описание 1']);
    expect(r.preference).toEqual({ mode: 'happ', checkedAt: NOW });
    expect(r.usedUa).toBe(HAPP_UA);
    expect(calls).toEqual([DEFAULT_UA, HAPP_UA]);
  });

  it('keeps the usual request when Happ gives nothing extra — such providers are left alone', async () => {
    const { deps } = fake({ [DEFAULT_UA]: ok(links(2, false)), [HAPP_UA]: ok(links(2, false)) });
    const r = await fetchSubscription('https://sub.example/x', {}, deps);
    expect(r.usedUa).toBe(DEFAULT_UA);
    expect(r.preference).toEqual({ mode: 'default', checkedAt: NOW });
  });

  it('keeps the usual request when the Happ one arrives but gives nothing extra', async () => {
    for (const happ of [{ ok: false, error: 'HTTP 403', body: '' } as Fetched, ok(''), ok('<html>blocked</html>')]) {
      const { deps } = fake({ [DEFAULT_UA]: ok(links(2, false)), [HAPP_UA]: happ });
      const r = await fetchSubscription('https://sub.example/x', {}, deps);
      expect(r.usedUa).toBe(DEFAULT_UA);
      expect(r.preference?.mode).toBe('default');
    }
  });

  it('a network failure of the Happ probe is no verdict — nothing is remembered for the next time', async () => {
    for (const happ of [new Error('timeout'), { ok: false, error: 'Unable to resolve host', body: '' } as Fetched]) {
      const { deps } = fake({ [DEFAULT_UA]: ok(links(2, false)), [HAPP_UA]: happ });
      const r = await fetchSubscription('https://sub.example/x', {}, deps);
      expect(r.usedUa).toBe(DEFAULT_UA);
      expect(r.preference).toBeUndefined();
    }
  });

  it('a stub for "other clients" (one server) loses to the real list the Happ request returns', async () => {
    const { deps } = fake({ [DEFAULT_UA]: ok(links(1, false)), [HAPP_UA]: ok(links(3, false)) });
    const r = await fetchSubscription('https://sub.example/x', {}, deps);
    expect(r.usedUa).toBe(HAPP_UA);
  });

  it('fewer servers is never accepted, even with descriptions', async () => {
    const { deps } = fake({ [DEFAULT_UA]: ok(links(3, false)), [HAPP_UA]: ok(links(2, true)) });
    expect((await fetchSubscription('https://sub.example/x', {}, deps)).usedUa).toBe(DEFAULT_UA);
  });

  it('an error of the usual request is raised as before, with no probing', async () => {
    const { deps, calls } = fake({ [DEFAULT_UA]: new Error('network down') });
    await expect(fetchSubscription('https://sub.example/x', {}, deps)).rejects.toThrow('network down');
    expect(calls).toEqual([DEFAULT_UA]);
  });

  it('a failed answer of the usual request is returned for the caller to report, with no probing', async () => {
    const failed: Fetched = { ok: false, error: 'HTTP 500', body: '' };
    const { deps, calls } = fake({ [DEFAULT_UA]: failed });
    const r = await fetchSubscription('https://sub.example/x', {}, deps);
    expect(r.res).toBe(failed);
    expect(calls).toEqual([DEFAULT_UA]);
  });
});

describe('fetchSubscription: what is remembered', () => {
  it('a provider that needs the Happ request gets it straight away (one request)', async () => {
    const { deps, calls } = fake({ [HAPP_UA]: ok(links(2, true)) });
    const r = await fetchSubscription('https://sub.example/x', { preference: { mode: 'happ', checkedAt: NOW - 1000 } }, deps);
    expect(r.usedUa).toBe(HAPP_UA);
    expect(r.preference).toEqual({ mode: 'happ', checkedAt: NOW - 1000 });
    expect(calls).toEqual([HAPP_UA]);
  });

  it('when the Happ request stops giving servers, the usual one takes over and the comparison is repeated later', async () => {
    const { deps, calls } = fake({ [HAPP_UA]: ok('<html>no</html>'), [DEFAULT_UA]: ok(links(2, false)) });
    const r = await fetchSubscription('https://sub.example/x', { preference: { mode: 'happ', checkedAt: 1 } }, deps);
    expect(r.usedUa).toBe(DEFAULT_UA);
    expect(r.preference).toEqual({ mode: 'default', checkedAt: NOW });
    expect(calls).toEqual([HAPP_UA, DEFAULT_UA]);
  });

  it('a network failure of the Happ request keeps the remembered happ mode for the next time', async () => {
    const { deps, calls } = fake({ [HAPP_UA]: new Error('timeout'), [DEFAULT_UA]: ok(links(2, false)) });
    const r = await fetchSubscription('https://sub.example/x', { preference: { mode: 'happ', checkedAt: NOW - 1000 } }, deps);
    expect(r.usedUa).toBe(DEFAULT_UA);
    // Память не тронута: следующее обновление снова попробует Happ.
    expect(r.preference).toEqual({ mode: 'happ', checkedAt: NOW - 1000 });
    expect(calls).toEqual([HAPP_UA, DEFAULT_UA]);
  });

  it('a manual update (force) re-checks Happ at once, even within the week', async () => {
    const { deps, calls } = fake({ [DEFAULT_UA]: ok(links(2, false)), [HAPP_UA]: ok(links(2, true)) });
    const r = await fetchSubscription('https://sub.example/x', { preference: { mode: 'default', checkedAt: NOW - 1000 }, force: true }, deps);
    expect(calls).toEqual([DEFAULT_UA, HAPP_UA]);
    expect(r.usedUa).toBe(HAPP_UA);
    expect(r.preference).toEqual({ mode: 'happ', checkedAt: NOW });
  });

  it('a provider that did not need Happ is checked again only after a week', async () => {
    const fresh = fake({ [DEFAULT_UA]: ok(links(2, false)) });
    await fetchSubscription('https://sub.example/x', { preference: { mode: 'default', checkedAt: NOW - REPROBE_AFTER_MS + 60_000 } }, fresh.deps);
    expect(fresh.calls).toEqual([DEFAULT_UA]);

    const stale = fake({ [DEFAULT_UA]: ok(links(2, false)), [HAPP_UA]: ok(links(2, true)) });
    const r = await fetchSubscription('https://sub.example/x', { preference: { mode: 'default', checkedAt: NOW - REPROBE_AFTER_MS - 60_000 } }, stale.deps);
    expect(stale.calls).toEqual([DEFAULT_UA, HAPP_UA]);
    expect(r.preference).toEqual({ mode: 'happ', checkedAt: NOW });
  });
});

describe('fetchSubscription: who decides the user agent', () => {
  it('a user agent set by the provider (change-user-agent) is used as is, with no comparison', async () => {
    const { deps, calls } = fake({ 'Custom/1': ok(links(2, true)) });
    const r = await fetchSubscription('https://sub.example/x', { userAgent: 'Custom/1', preference: { mode: 'default', checkedAt: 1 } }, deps);
    expect(calls).toEqual(['Custom/1']);
    expect(r.usedUa).toBe('Custom/1');
    expect(r.preference).toEqual({ mode: 'default', checkedAt: 1 });
  });

  it('with the mode switched off only the usual request is made and nothing is remembered', async () => {
    const { deps, calls } = fake({ [DEFAULT_UA]: ok(links(2, false)) }, { enabled: () => false });
    const r = await fetchSubscription('https://sub.example/x', {}, deps);
    expect(calls).toEqual([DEFAULT_UA]);
    expect(r.preference).toBeUndefined();
  });
});

describe('richness and the setting', () => {
  it('counts server descriptions and provider parameters', () => {
    expect(richness(parseSubscription(links(2, false)))).toBe(0);
    expect(richness(parseSubscription(links(2, true)))).toBe(2);
    expect(richness(parseSubscription(links(2, false), undefined, { announce: 'Привет', 'sub-info-text': 'Скидка' }))).toBe(2);
  });

  afterEach(() => { try { localStorage.removeItem(HAPP_MODE_KEY); } catch { /* ignore */ } });

  it('the mode is on by default and switches off from Settings', () => {
    expect(isHappModeEnabled()).toBe(true);
    localStorage.setItem(HAPP_MODE_KEY, 'false');
    expect(isHappModeEnabled()).toBe(false);
    localStorage.setItem(HAPP_MODE_KEY, 'true');
    expect(isHappModeEnabled()).toBe(true);
  });
});

describe('fetchSubscription: update through the raised tunnel', () => {
  afterEach(() => { viaProxyMock.mockReset(); });

  it('with viaSocksPort the request goes to the local SOCKS port of the core, not directly', async () => {
    const { deps } = fake({}, { enabled: () => false });
    viaProxyMock.mockResolvedValue(ok(links(2, false)));
    const r = await fetchSubscription('https://sub.example/x', { viaSocksPort: 10808 }, deps);
    expect(viaProxyMock).toHaveBeenCalledWith('https://sub.example/x', 10808, DEFAULT_UA);
    expect(parseSubscription((r.res as any).body).nodes).toHaveLength(2);
  });

  it('without viaSocksPort (or 0) the usual direct request is kept', async () => {
    const { deps, calls } = fake({ [DEFAULT_UA]: ok(links(2, false)) }, { enabled: () => false });
    await fetchSubscription('https://sub.example/x', { viaSocksPort: 0 }, deps);
    expect(calls).toEqual([DEFAULT_UA]);
    expect(viaProxyMock).not.toHaveBeenCalled();
  });
});

describe('friendlyUpdateError: no addresses in user-facing errors', () => {
  it('turns raw network errors into a plain sentence without host, IP or port', () => {
    expect(friendlyUpdateError(new Error('Unable to resolve host "x.petrovich.party/193.187.93.181:443": No address associated with hostname')))
      .toBe('Не удалось разрешить адрес сервера подписки');
    expect(friendlyUpdateError(new Error('failed to connect to /193.187.93.181 (port 443) after 10000ms')))
      .toBe('Сервер подписки не отвечает на соединение');
    expect(friendlyUpdateError(new Error('connect timed out'))).toBe('Сервер подписки не ответил вовремя');
    expect(friendlyUpdateError(new Error('SSL handshake aborted: sslstack.ssl_engine_failure'))).toBe('Ошибка шифрования соединения с сервером');
    expect(friendlyUpdateError(new Error('HTTP 403'))).toBe('Сервер подписки вернул ошибку HTTP 403');
  });

  it('keeps the sentence but strips urls and hosts for anything unrecognised', () => {
    expect(friendlyUpdateError(new Error('что-то странное на https://x.petrovich.party/193.187.93.181:443/пути')))
      .toBe('что-то странное на');
    expect(friendlyUpdateError(new Error('просто переполнение буфера'))).toBe('просто переполнение буфера');
    expect(friendlyUpdateError(new Error(''))).toBe('Нет связи с сервером подписки');
    expect(friendlyUpdateError(undefined)).toBe('Нет связи с сервером подписки');
  });
});
