import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState, ServerNode } from '../types';

vi.mock('../native/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../native/bridge')>();
  return { ...actual, nativePingNode: vi.fn(async () => 123) };
});
// Внешний адрес определяется сетевым запросом — к замеру пинга он отношения не имеет.
vi.mock('../utils/usePublicIp', () => ({ usePublicIp: () => ({ failed: false }) }));

import HomeScreen from './HomeScreen';
import { nativePingNode } from '../native/bridge';

// Пинг выбранного сервера на главном экране. При выключенном VPN замер поднимает временное ядро, поэтому он не
// должен запускаться, пока соединение меняется, и между остановкой и повторным запуском туннеля.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const node = (id: string): ServerNode => ({
  id, name: `Сервер ${id}`, address: `${id}.example`, port: 443, protocol: 'vless', remark: '', rawLink: '',
} as ServerNode);

describe('HomeScreen ping', () => {
  let host: HTMLDivElement;
  let root: Root;
  const nodes = [node('one'), node('two')];

  const render = (connectionState: ConnectionState, selected: ServerNode) => act(() => {
    root.render(
      <HomeScreen
        connectionState={connectionState}
        onToggle={() => {}}
        selectedNode={selected}
        nodes={nodes}
        onSelectNode={() => {}}
        onGoToServers={() => {}}
        onGoToProfiles={() => {}}
        connectedTime={0}
        hasNodes
        isDark
      />
    );
  });
  const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const pinged = () => vi.mocked(nativePingNode).mock.calls.map(c => [c[0].id, c[2]]);

  let testNo = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    // Каждый тест — на десять минут позже предыдущего: свежий замер прошлого теста не должен подменять новый.
    vi.setSystemTime(Date.now() + (++testNo) * 10 * 60_000);
    vi.mocked(nativePingNode).mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    vi.useRealTimers();
  });

  it('waits after opening with the VPN off, then measures once', async () => {
    render('disconnected', nodes[0]);
    await wait(1000);
    expect(pinged()).toEqual([]);
    await wait(600);
    expect(pinged()).toEqual([['one', false]]);
  });

  it('does not measure when a connection starts before the wait is over', async () => {
    render('disconnected', nodes[0]);
    await wait(500);
    render('connecting', nodes[0]);
    await wait(5000);
    render('verifying', nodes[0]);
    await wait(5000);
    expect(pinged()).toEqual([]);
  });

  it('measures through the tunnel once connected', async () => {
    render('connecting', nodes[0]);
    await wait(3000);
    render('connected', nodes[0]);
    await wait(300);
    expect(pinged()).toEqual([['one', true]]);
  });

  it('does not measure between a stop and an automatic reconnect', async () => {
    render('connected', nodes[0]);
    await wait(300);
    vi.mocked(nativePingNode).mockClear();
    render('disconnected', nodes[0]);   // авто-переключение остановило туннель…
    await wait(600);
    render('connecting', nodes[0]);     // …и через 600 мс поднимает его заново
    await wait(5000);
    expect(pinged()).toEqual([]);
  });

  it('measures a newly selected server right away', async () => {
    render('disconnected', nodes[0]);
    await wait(1600);
    vi.mocked(nativePingNode).mockClear();
    render('disconnected', nodes[1]);
    await wait(300);
    expect(pinged()).toEqual([['two', false]]);
  });

  it('reuses a fresh result when the screen is reopened', async () => {
    render('disconnected', nodes[0]);
    await wait(1600);
    expect(pinged()).toEqual([['one', false]]);
    act(() => { root.unmount(); });
    root = createRoot(host);
    render('disconnected', nodes[0]);
    await wait(5000);
    expect(pinged()).toEqual([['one', false]]);
    expect(host.textContent).toContain('123 мс');
  });
});
