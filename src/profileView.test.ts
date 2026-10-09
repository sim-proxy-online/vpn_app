import { describe, expect, it } from 'vitest';
import { orderProfiles, pickAutoConnectNode, settingsHidden, sortNodes } from './utils/profileView';
import type { ServerNode } from './types';

const n = (id: string, name = id, over: Partial<ServerNode> = {}) => ({ id, name, address: id + '.example', port: 443, protocol: 'vless', remark: name, rawLink: id, ...over }) as ServerNode;
const p = (id: string, pinned?: boolean) => ({ id, managed: pinned === undefined ? undefined : { pinned } });

describe('orderProfiles', () => {
  it('pinned subscriptions go first, the rest keep their order', () => {
    expect(orderProfiles([p('a'), p('b', true), p('c'), p('d', true)]).map((x) => x.id)).toEqual(['b', 'd', 'a', 'c']);
  });
  it('returns the same array when nothing or everything is pinned', () => {
    const none = [p('a'), p('b')];
    expect(orderProfiles(none)).toBe(none);
    const all = [p('a', true), p('b', true)];
    expect(orderProfiles(all)).toBe(all);
  });
});

describe('sortNodes', () => {
  const nodes = [n('c', 'Берлин'), n('a', 'Амстердам'), n('b', 'Вена')];
  const pings: Record<string, number> = { a: 80, b: -1 };

  it('without: provider order, same array', () => {
    expect(sortNodes(nodes, 'without', () => undefined)).toBe(nodes);
    expect(sortNodes(nodes, undefined, () => undefined)).toBe(nodes);
  });
  it('alphabet: by name', () => {
    expect(sortNodes(nodes, 'alphabet', () => undefined).map((x) => x.name)).toEqual(['Амстердам', 'Берлин', 'Вена']);
  });
  it('ping: fastest first, unmeasured and failed last, source untouched', () => {
    const out = sortNodes(nodes, 'ping', (x) => pings[x.id]);
    expect(out.map((x) => x.id)).toEqual(['a', 'c', 'b']);
    expect(nodes.map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('hidden settings', () => {
  it('settingsHidden reads the managed flag', () => {
    expect(settingsHidden({ managed: { hideSettings: true } })).toBe(true);
    expect(settingsHidden({ managed: {} })).toBe(false);
    expect(settingsHidden(undefined)).toBe(false);
  });
});

describe('pickAutoConnectNode', () => {
  const nodes = [n('a'), n('b'), n('c')];
  const pings: Record<string, number> = { a: 120, b: 40, c: -1 };
  const pingOf = (x: ServerNode) => pings[x.id];

  it('lastused keeps the current server', () => {
    expect(pickAutoConnectNode('lastused', nodes, nodes[2], pingOf)).toBe(nodes[2]);
    expect(pickAutoConnectNode('anything', nodes, nodes[0], pingOf)).toBe(nodes[0]);
  });
  it('lowestdelay picks the best known ping, or stays when nothing was measured', () => {
    expect(pickAutoConnectNode('lowestdelay', nodes, nodes[0], pingOf).id).toBe('b');
    expect(pickAutoConnectNode('lowestdelay', nodes, nodes[0], () => undefined)).toBe(nodes[0]);
  });
  it('random picks from the subscription', () => {
    expect(pickAutoConnectNode('random', nodes, nodes[0], pingOf, () => 0).id).toBe('a');
    expect(pickAutoConnectNode('random', nodes, nodes[0], pingOf, () => 0.99).id).toBe('c');
    expect(pickAutoConnectNode('random', nodes, nodes[0], pingOf, () => 1).id).toBe('c');
  });
  it('an empty subscription keeps the current server', () => {
    expect(pickAutoConnectNode('random', [], nodes[1], pingOf)).toBe(nodes[1]);
  });
});
