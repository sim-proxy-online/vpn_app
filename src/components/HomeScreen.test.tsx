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

// Пинг выбранного сервера на главном экране: берётся кэш node.ping из раздела «Серверы».
// Живой замер здесь не запускается — он поднимал лишнее ядро и мешал работе VPN.

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

  it('показывает кэш пинга сервера, живой замер не запускает', async () => {
    render('disconnected', { ...nodes[0], ping: 77 });
    await wait(3000);
    expect(host.textContent).toContain('77 мс');
    expect(pinged()).toEqual([]);
  });

  it('не запускает замер и при подключённом VPN', async () => {
    render('connected', { ...nodes[0], ping: 40 });
    await wait(3000);
    expect(host.textContent).toContain('40 мс');
    expect(pinged()).toEqual([]);
  });

  it('при смене сервера показывает его кэш', async () => {
    render('disconnected', { ...nodes[0], ping: 77 });
    await wait(100);
    render('disconnected', { ...nodes[1], ping: 15 });
    await wait(100);
    expect(host.textContent).toContain('15 мс');
    expect(pinged()).toEqual([]);
  });

  it('без кэша пинга пилюля не показывается', async () => {
    render('disconnected', nodes[0]);
    await wait(3000);
    expect(pinged()).toEqual([]);
  });
});
