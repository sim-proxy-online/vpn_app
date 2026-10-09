import { describe, expect, it } from 'vitest';
import { buildXrayConfig, getFragmentSpec, nodeUsesUdp } from './bridge';
import type { ServerNode } from '../types';

// Regression tests for the fragment-interval bug documented in project memory
// (feedback-ping-no-tcp-precheck / feedback-code-style): overriding the user's
// configured fragInterval (e.g. forcing '1-3' instead of '10-20') produced
// impossibly small, fake ping values on DPI networks. getFragmentSpec must
// always pass the user's settings.fragInterval through unchanged.

function makeNode(overrides: Partial<ServerNode> = {}): ServerNode {
  return {
    id: 'n1',
    name: 'test',
    address: '1.2.3.4',
    port: 443,
    protocol: 'vless',
    remark: '',
    rawLink: '',
    ...overrides,
  } as ServerNode;
}

describe('getFragmentSpec', () => {
  it('passes through the user-configured fragInterval unchanged for TLS-like nodes', () => {
    const node = makeNode({ security: 'tls' });
    const settings = { fragPackets: 'tlshello', fragLength: '10-20', fragInterval: '10-20' };
    const spec = getFragmentSpec(node, settings);
    expect(spec.interval).toBe('10-20');
    expect(spec.packets).toBe('tlshello');
  });

  it('does not force interval to 1-3 regardless of configured value', () => {
    const node = makeNode({ security: 'reality' });
    const settings = { fragInterval: '40-60' };
    const spec = getFragmentSpec(node, settings);
    expect(spec.interval).toBe('40-60');
  });

  it('prefers per-node fragment CSV over settings when node.fragment is set', () => {
    const node = makeNode({ security: 'tls', fragment: 'tlshello,5-10,20-30' });
    const settings = { fragInterval: '10-20' };
    const spec = getFragmentSpec(node, settings);
    expect(spec).toEqual({ packets: 'tlshello', length: '5-10', interval: '20-30' });
  });

  it('noises are built only for UDP nodes: on TCP they do nothing in Xray', () => {
    expect(nodeUsesUdp(makeNode({ protocol: 'vless', transport: 'tcp' }))).toBe(false);
    expect(nodeUsesUdp(makeNode({ protocol: 'vless', transport: 'xhttp' }))).toBe(false);
    expect(nodeUsesUdp(makeNode({ protocol: 'vless', transport: 'kcp' }))).toBe(true);
    expect(nodeUsesUdp(makeNode({ protocol: 'wireguard' }))).toBe(true);
    expect(nodeUsesUdp(makeNode({ protocol: 'hysteria2' }))).toBe(true);

    const tcp = makeNode({ security: 'reality', uuid: 'u', sni: 'example.com', publicKey: 'pk', shortId: 'ab', transport: 'tcp' });
    // buildXrayConfig возвращает готовый JSON-конфиг строкой.
    const withNoisesOnly = JSON.parse(buildXrayConfig(tcp, { noisesEnable: true, fragEnable: false }));
    expect(withNoisesOnly.outbounds.some((o: any) => o.tag === 'fragment')).toBe(false);
    expect(JSON.stringify(withNoisesOnly)).not.toContain('noises');

    const withFrag = JSON.parse(buildXrayConfig(tcp, { noisesEnable: true, fragEnable: true }));
    const frag = withFrag.outbounds.find((o: any) => o.tag === 'fragment');
    expect(frag.settings.fragment).toBeDefined();
    expect(frag.settings.noises).toBeUndefined();
  });

  it('a server with its own fragment (from its link, Happ style) fragments even when the global switch is off', () => {
    const base = { security: 'reality', uuid: 'u', sni: 'example.com', publicKey: 'pk', shortId: 'ab', transport: 'tcp' } as const;
    const own = JSON.parse(buildXrayConfig(makeNode({ ...base, fragment: 'tlshello,80-250,10-100' }), { fragEnable: false }));
    const frag = own.outbounds.find((o: any) => o.tag === 'fragment');
    expect(frag.settings.fragment).toEqual({ packets: 'tlshello', length: '80-250', interval: '10-100' });

    const plain = JSON.parse(buildXrayConfig(makeNode({ ...base }), { fragEnable: false }));
    expect(plain.outbounds.some((o: any) => o.tag === 'fragment')).toBe(false);
  });

  it('falls back packets to 1-3 for non-TLS transports where tlshello selector matches nothing', () => {
    const node = makeNode({ protocol: 'vmess', security: undefined });
    const settings = { fragPackets: 'tlshello', fragInterval: '10-20' };
    const spec = getFragmentSpec(node, settings);
    expect(spec.packets).toBe('1-3');
    // interval must still be untouched by the non-TLS fallback
    expect(spec.interval).toBe('10-20');
  });
});
