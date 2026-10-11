import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startPingBatch } from './bridge';
import type { ServerNode } from '../types';

// Пакетный замер на десктопе. Мост там — Proxy: nativePingBatch «существует», но событий ping-batch-item /
// ping-batch-done основной процесс не шлёт. Раньше список серверов на главной из-за этого навсегда оставался в
// состоянии «Пингую…»; теперь очередь ведёт сам рендерер поштучными замерами.

function makeNode(id: string, overrides: Partial<ServerNode> = {}): ServerNode {
  return {
    id,
    name: id,
    address: `${id}.example`,
    port: 443,
    protocol: 'vless',
    remark: '',
    rawLink: '',
    uuid: '00000000-0000-4000-8000-000000000000',
    security: 'tls',
    ...overrides,
  } as ServerNode;
}

interface FakeDesktop {
  proxyCalls: string[];
  tcpCalls: string[];
  maxInFlight: number;
  batchCalls: number;
  /** Завершить все ожидающие замеры (каждому — свой ответ по адресу сервера). */
  flush: () => void;
}

function installDesktopBridge(answer: (address: string) => unknown): FakeDesktop {
  const w = window as any;
  const pending: Array<() => void> = [];
  let inFlight = 0;
  const state: FakeDesktop = { proxyCalls: [], tcpCalls: [], maxInFlight: 0, batchCalls: 0, flush: () => { pending.splice(0).forEach(fn => fn()); } };
  const defer = (taskId: string, address: string) => {
    inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, inFlight);
    pending.push(() => { inFlight--; w.onNativeTaskComplete(taskId, answer(address)); });
  };
  w.__SIM_DESKTOP__ = true;
  w.SimNativeV2 = {
    nativePingBatch: () => { state.batchCalls++; },
    pingProxyServer: (configJson: string, _mode: string, taskId: string) => {
      const address = JSON.parse(configJson).outbounds[0].settings.vnext[0].address as string;
      state.proxyCalls.push(address);
      defer(taskId, address);
    },
    pingServer: (address: string, _port: number, _timeout: number, taskId: string) => {
      state.tcpCalls.push(address);
      defer(taskId, address);
    },
  };
  return state;
}

/** Дать отработать микрозадачам между шагами очереди. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('startPingBatch on desktop', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => {
    const w = window as any;
    delete w.__SIM_DESKTOP__;
    delete w.SimNativeV2;
  });

  it('measures every server itself, at most three at a time, and reports completion', async () => {
    const desk = installDesktopBridge(address => (address === 'n2.example' ? -1 : 120));
    const nodes = ['n1', 'n2', 'n3', 'n4', 'n5'].map(id => makeNode(id));
    const items: Record<string, number> = {};
    let done = 0;
    startPingBatch(nodes, (id, ms) => { items[id] = ms; }, () => { done++; });

    for (let i = 0; i < 6 && done === 0; i++) { await settle(); desk.flush(); await settle(); }

    expect(desk.batchCalls).toBe(0);
    expect(desk.proxyCalls.sort()).toEqual(['n1.example', 'n2.example', 'n3.example', 'n4.example', 'n5.example']);
    expect(desk.maxInFlight).toBe(3);
    expect(items).toEqual({ n1: 120, n2: -1, n3: 120, n4: 120, n5: 120 });
    expect(done).toBe(1);
  });

  it('stops after cancel: no further servers, no completion callback', async () => {
    const desk = installDesktopBridge(() => 90);
    const nodes = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'].map(id => makeNode(id));
    const items: string[] = [];
    let done = 0;
    const cancel = startPingBatch(nodes, id => { items.push(id); }, () => { done++; });

    await settle();
    expect(desk.proxyCalls.length).toBe(3);
    cancel();
    desk.flush();
    await settle();
    desk.flush();
    await settle();

    expect(desk.proxyCalls.length).toBe(3);
    expect(items).toEqual([]);
    expect(done).toBe(0);
  });

  it('uses a plain TCP check for protocols the measuring core cannot run', async () => {
    const desk = installDesktopBridge(() => 45);
    const items: Record<string, number> = {};
    let done = 0;
    startPingBatch([makeNode('h1', { protocol: 'hysteria2' })], (id, ms) => { items[id] = ms; }, () => { done++; });

    await settle(); desk.flush(); await settle();

    expect(desk.tcpCalls).toEqual(['h1.example']);
    expect(desk.proxyCalls).toEqual([]);
    expect(items).toEqual({ h1: 45 });
    expect(done).toBe(1);
  });

  it('treats a non-numeric answer from the main process as no response', async () => {
    const desk = installDesktopBridge(() => ({ ok: false, error: 'ipc failed' }));
    const items: Record<string, number> = {};
    let done = 0;
    startPingBatch([makeNode('n1')], (id, ms) => { items[id] = ms; }, () => { done++; });

    await settle(); desk.flush(); await settle();

    expect(items).toEqual({ n1: -1 });
    expect(done).toBe(1);
  });
});
