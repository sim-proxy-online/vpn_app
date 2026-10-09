import { describe, expect, it } from 'vitest';
import { formatBytes, parseLink, parseSubscription, parseUserInfo, rebindInboundTags } from './data';
import { compareVersions } from './utils/UpdateChecker';
import { buildMihomoConfig, shouldUseMihomo } from './native/mihomoConfig';

const UUID = '11111111-1111-1111-1111-111111111111';
const b64 = (s: string) => btoa(s);

describe('parseLink', () => {
  it('parses a VLESS+REALITY link with all transport fields', () => {
    const n = parseLink(
      `vless://${UUID}@example.com:443?security=reality&sni=www.example.com&pbk=PUBKEY&sid=abcd&flow=xtls-rprx-vision&fp=chrome&type=tcp#My%20Node`,
    );
    expect(n).toMatchObject({
      protocol: 'vless', address: 'example.com', port: 443, uuid: UUID,
      security: 'reality', sni: 'www.example.com', publicKey: 'PUBKEY', shortId: 'abcd',
      flow: 'xtls-rprx-vision', fingerprint: 'chrome', transport: 'tcp', name: 'My Node',
    });
  });

  it('parses a VMess link (base64 JSON)', () => {
    const cfg = { v: '2', ps: 'VM', add: 'vm.example.com', port: '8443', id: UUID, aid: '0', net: 'ws', type: 'none', host: 'h.example.com', path: '/ws', tls: 'tls' };
    const n = parseLink('vmess://' + b64(JSON.stringify(cfg)));
    expect(n).toMatchObject({
      protocol: 'vmess', address: 'vm.example.com', port: 8443, uuid: UUID,
      transport: 'ws', path: '/ws', security: 'tls', name: 'VM',
    });
  });

  it('parses Shadowsocks SIP002 (base64 userinfo) and the legacy whole-URL form', () => {
    const sip = parseLink(`ss://${b64('aes-256-gcm:secret')}@1.2.3.4:8388#SS%20node`);
    expect(sip).toMatchObject({ protocol: 'shadowsocks', address: '1.2.3.4', port: 8388, method: 'aes-256-gcm', password: 'secret', name: 'SS node' });

    const legacy = parseLink(`ss://${b64('chacha20-ietf-poly1305:pw@5.6.7.8:443')}#old`);
    expect(legacy).toMatchObject({ protocol: 'shadowsocks', address: '5.6.7.8', port: 443, method: 'chacha20-ietf-poly1305', password: 'pw' });
  });

  it('parses Trojan, Hysteria2 (both schemes) and TUIC', () => {
    expect(parseLink('trojan://pass@t.example.com:443?sni=t.example.com#T'))
      .toMatchObject({ protocol: 'trojan', address: 't.example.com', port: 443, password: 'pass', sni: 't.example.com' });
    expect(parseLink('hysteria2://secret@h.example.com:8443?sni=h.example.com&obfs=salamander&obfs-password=x#H2'))
      .toMatchObject({ protocol: 'hysteria2', address: 'h.example.com', port: 8443, password: 'secret', obfs: 'salamander:x' });
    expect(parseLink('hy2://secret@h.example.com:8443#H2b')).toMatchObject({ protocol: 'hysteria2' });
    expect(parseLink(`tuic://${UUID}:pw@tu.example.com:443?sni=tu.example.com#TU`))
      .toMatchObject({ protocol: 'tuic', address: 'tu.example.com', uuid: UUID, password: 'pw' });
  });

  it('treats hysteria:// with a UUID auth as Hysteria2 (Remnawave quirk) and other auth as v1', () => {
    expect(parseLink(`hysteria://${UUID}@r.example.com:443#R`)).toMatchObject({ protocol: 'hysteria2', allowInsecure: true });
    expect(parseLink('hysteria://plain-auth@r.example.com:443#R')).toMatchObject({ protocol: 'hysteria' });
  });

  it('returns null for things that are not proxy links', () => {
    expect(parseLink('')).toBeNull();
    expect(parseLink('just some text')).toBeNull();
    expect(parseLink(null)).toBeNull();
  });

  it('gives the same node the same id (selection survives a subscription refresh)', () => {
    const l = `vless://${UUID}@example.com:443?security=tls&sni=example.com#A`;
    expect(parseLink(l)!.id).toBe(parseLink(l)!.id);
    expect(parseLink(l)!.id).not.toBe(parseLink(l.replace('example.com:443', 'example.org:443'))!.id);
  });
});

describe('parseSubscription', () => {
  const links = [
    `vless://${UUID}@a.example.com:443?security=tls&sni=a.example.com#A`,
    `trojan://pass@b.example.com:443?sni=b.example.com#B`,
  ];

  it('parses a plain newline-separated list', () => {
    const r = parseSubscription(links.join('\n'));
    expect(r.nodes.map((n) => n.name)).toEqual(['A', 'B']);
  });

  it('parses a base64-encoded list', () => {
    const r = parseSubscription(b64(links.join('\n')));
    expect(r.nodes.map((n) => n.address)).toEqual(['a.example.com', 'b.example.com']);
  });

  it('drops duplicate nodes', () => {
    const r = parseSubscription([links[0], links[0], links[1]].join('\n'));
    expect(r.nodes).toHaveLength(2);
  });

  it('picks up name and traffic from response headers', () => {
    const r = parseSubscription(links.join('\n'), undefined, {
      'Profile-Title': 'My Sub',
      'Subscription-Userinfo': 'upload=100; download=200; total=1000',
      'Profile-Update-Interval': '12',
    });
    expect(r.name).toBe('My Sub');
    expect(r.traffic).toMatchObject({ upload: 100, download: 200, total: 1000 });
    expect(r.updateInterval).toBe(12);
  });

  it('returns no nodes for garbage instead of throwing', () => {
    expect(parseSubscription('<html>502 Bad Gateway</html>').nodes).toEqual([]);
    expect(parseSubscription('').nodes).toEqual([]);
  });
});

describe('parseUserInfo / formatBytes', () => {
  it('computes usage percentage and clamps remaining days at 0 for expired subscriptions', () => {
    const t = parseUserInfo('upload=100; download=200; total=1000; expire=1');
    expect(t.usagePercentage).toBeCloseTo(30);
    expect(t.remainingDays).toBe(0);
  });

  it('counts remaining days for unlimited traffic too (total=0)', () => {
    // ровно 2 дня до истечения — истёкшая «безлимитная» подписка не должна выглядеть активной
    const soon = Math.floor((Date.now() + 2 * 86400000) / 1000);
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(parseUserInfo(`upload=1; download=1; total=0; expire=${soon}`).remainingDays).toBe(2);
    expect(parseUserInfo(`upload=1; download=1; total=0; expire=${past}`).remainingDays).toBe(0);
    expect(parseUserInfo('upload=1; download=1; total=0; expire=0').remainingDays).toBeUndefined(); // бессрочно
  });

  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });
});

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
    expect(compareVersions('2.5.1', '2.5.2')).toBe(-1);
    expect(compareVersions('v3.0.0', '2.99.99')).toBe(1);
  });

  it('treats missing segments and build metadata as equal', () => {
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
    expect(compareVersions('2.0.4+build.7', '2.0.4')).toBe(0);
    expect(compareVersions('2.5.1', '2.5.1')).toBe(0);
  });
});

describe('rebindInboundTags', () => {
  const loop = (tag: string, inboundTag: string) => ({ tag, protocol: 'loopback', settings: { inboundTag } });
  const vless = (tag: string) => ({ tag, protocol: 'vless', settings: {} });

  it('unbinds rules from the author inbounds so they apply to our traffic', () => {
    const rules = [
      { type: 'field', inboundTag: ['socks', 'http'], network: 'tcp,udp', balancerTag: 'main' },
      { type: 'field', domain: ['domain:ya.ru'], outboundTag: 'direct' },
    ];
    expect(rebindInboundTags(rules, [vless('proxy')])).toEqual([
      { type: 'field', network: 'tcp,udp', balancerTag: 'main' },
      { type: 'field', domain: ['domain:ya.ru'], outboundTag: 'direct' },
    ]);
  });

  it('keeps the loopback chain: every fallback balancer stays reachable', () => {
    const outbounds = [vless('proxy-0'), loop('loop_to_new', 'new-fallback'), loop('loop_to_vx', 'vx-fallback')];
    const rules = [
      { type: 'field', port: '53', outboundTag: 'dns-out' },
      { type: 'field', inboundTag: ['new-fallback'], balancerTag: 'BALANCER-P1' },
      { type: 'field', inboundTag: ['vx-fallback'], balancerTag: 'vx_balancer' },
      { type: 'field', network: 'tcp,udp', balancerTag: 'auto_balancer' },
    ];
    const out = rebindInboundTags(rules, outbounds);
    expect(out).toHaveLength(4);
    for (const tag of ['new-fallback', 'vx-fallback']) {
      expect(out.filter((r) => r.inboundTag?.includes(tag))).toHaveLength(1);
    }
    expect(out.find((r) => r.balancerTag === 'auto_balancer')).not.toHaveProperty('inboundTag');
  });

  it('puts loopback rules ahead of a catch-all that was bound to the author inbounds', () => {
    const out = rebindInboundTags(
      [
        { type: 'field', inboundTag: ['socks'], network: 'tcp,udp', balancerTag: 'main' },
        { type: 'field', inboundTag: ['lte-fallback'], balancerTag: 'lte' },
      ],
      [loop('loop_to_lte', 'lte-fallback')],
    );
    expect(out).toEqual([
      { type: 'field', inboundTag: ['lte-fallback'], balancerTag: 'lte' },
      { type: 'field', network: 'tcp,udp', balancerTag: 'main' },
    ]);
  });

  it('splits a rule that mixes an author inbound with a loopback tag', () => {
    const out = rebindInboundTags(
      [{ type: 'field', inboundTag: ['socks', 'lte-fallback'], network: 'tcp', balancerTag: 'lte' }],
      [loop('loop_to_lte', 'lte-fallback')],
    );
    expect(out).toEqual([
      { type: 'field', network: 'tcp', balancerTag: 'lte', inboundTag: ['lte-fallback'] },
      { type: 'field', network: 'tcp', balancerTag: 'lte' },
    ]);
  });

  it('does not change the rules it was given', () => {
    const rules = [{ type: 'field', inboundTag: ['socks'], network: 'tcp', outboundTag: 'proxy' }];
    rebindInboundTags(rules, []);
    expect(rules[0].inboundTag).toEqual(['socks']);
  });
});

describe('core selection and mihomo config', () => {
  it('routes Xray-unsupported protocols to mihomo and the rest to xray', () => {
    for (const p of ['hysteria2', 'tuic', 'anytls', 'shadowtls']) expect(shouldUseMihomo(p)).toBe(true);
    for (const p of ['vless', 'vmess', 'trojan', 'shadowsocks']) expect(shouldUseMihomo(p)).toBe(false);
  });

  it('builds a valid JSON mihomo config with the node as the only proxy', () => {
    const node = parseLink('hysteria2://secret@h.example.com:8443?sni=h.example.com#H2')!;
    const cfg = JSON.parse(buildMihomoConfig(node, {}));
    expect(Array.isArray(cfg.proxies)).toBe(true);
    expect(cfg.proxies).toHaveLength(1);
    expect(cfg.proxies[0]).toMatchObject({ type: 'hysteria2', server: 'h.example.com', port: 8443 });
  });
});
