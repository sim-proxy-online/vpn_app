import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_UA, fetchSubscription, friendlyUpdateError, type FetchDeps, type Fetched } from './utils/subscriptionFetch';

// Мост: viaSocksPort подменяет сетевой слой на запрос через локальный SOCKS туннеля.
const viaProxyMock = vi.hoisted(() => vi.fn());
vi.mock('./native/bridge', () => ({
  nativeFetchUrl: vi.fn(),
  nativeFetchUrlViaProxy: viaProxyMock,
}));

const ok = (body: string): Fetched => ({ ok: true, body, headers: {} });

/** Подставной сетевой слой: запоминает User-Agent каждого запроса. */
function fake(answer: Fetched | Error = ok('vless://x')) {
  const calls: string[] = [];
  const deps: FetchDeps = {
    fetch: async (_url, ua) => {
      calls.push(ua);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { deps, calls };
}

describe('subscription User-Agent', () => {
  it('our own User-Agent is used by default and carries our name, not a third-party one', () => {
    expect(DEFAULT_UA).toMatch(/^SimProxy\/\d+\.\d+\.\d+$/);
    expect(DEFAULT_UA).not.toMatch(/happ|v2ray|clash|hiddify|sing-box/i);
  });

  it('one request per update, with our User-Agent', async () => {
    const { deps, calls } = fake();
    const r = await fetchSubscription('https://sub.example/x', {}, deps);
    expect(calls).toEqual([DEFAULT_UA]);
    expect(r.usedUa).toBe(DEFAULT_UA);
  });

  it('the User-Agent the provider set for its trusted profile still wins', async () => {
    const { deps, calls } = fake();
    const r = await fetchSubscription('https://sub.example/x', { userAgent: 'Provider/9' }, deps);
    expect(calls).toEqual(['Provider/9']);
    expect(r.usedUa).toBe('Provider/9');
  });

  it('a stale stored "happ" preference is ignored and cleared', async () => {
    const { deps, calls } = fake();
    const r = await fetchSubscription('https://sub.example/x', { preference: { mode: 'happ', checkedAt: 1 }, force: true }, deps);
    expect(calls).toEqual([DEFAULT_UA]);
    expect(r.preference).toBeUndefined();
  });

  it('network errors are passed through as before', async () => {
    const { deps } = fake(new Error('network down'));
    await expect(fetchSubscription('https://sub.example/x', {}, deps)).rejects.toThrow('network down');
  });
});

describe('fetchSubscription: update through the raised tunnel', () => {
  afterEach(() => { viaProxyMock.mockReset(); });

  it('with viaSocksPort the request goes to the local SOCKS port of the core, not directly', async () => {
    const { deps } = fake();
    viaProxyMock.mockResolvedValue(ok('vless://x'));
    await fetchSubscription('https://sub.example/x', { viaSocksPort: 10808 }, deps);
    expect(viaProxyMock).toHaveBeenCalledWith('https://sub.example/x', 10808, DEFAULT_UA);
  });

  it('without viaSocksPort (or 0) the usual direct request is kept', async () => {
    const { deps, calls } = fake();
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
