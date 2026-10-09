import { describe, expect, it } from 'vitest';
import { applyLinkMeta, decodeDescription, normalizeHappFragment, splitLinkMeta } from './utils/linkMeta';
import { extractNodesFromFullConfig, parseLink, parseSubscription } from './data';

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const UUID = '11111111-1111-4111-8111-111111111111';

describe('decodeDescription', () => {
  it('decodes base64 (the Happ example) and keeps plain text as is', () => {
    expect(decodeDescription('SGFwcCB0aGUgYmVzdA==')).toBe('Happ the best');
    expect(decodeDescription(b64('Быстрый узел'))).toBe('Быстрый узел');
    expect(decodeDescription('Moscow')).toBe('Moscow');
    expect(decodeDescription('Быстрый узел')).toBe('Быстрый узел');
    expect(decodeDescription(encodeURIComponent('Быстрый узел'))).toBe('Быстрый узел');
  });

  it('url-safe base64 without padding and the base64: prefix work', () => {
    expect(decodeDescription('SGFwcCB0aGUgYmVzdA')).toBe('Happ the best');
    expect(decodeDescription('base64:SGFwcCB0aGUgYmVzdA==')).toBe('Happ the best');
  });

  it('is capped at 30 characters and cleaned of control characters', () => {
    expect(decodeDescription(b64('x'.repeat(100)))).toHaveLength(30);
    expect(decodeDescription('a\u0000b\nc')).toBe('a b c');
    expect(decodeDescription('   ')).toBeUndefined();
    expect(decodeDescription(undefined)).toBeUndefined();
    expect(decodeDescription(42)).toBeUndefined();
  });
});

describe('normalizeHappFragment', () => {
  it('turns Happ order (length,interval,packets) into ours (packets,length,interval)', () => {
    expect(normalizeHappFragment('80-250,10-100,tlshello')).toBe('tlshello,80-250,10-100');
    expect(normalizeHappFragment('80-250,10-100')).toBe('tlshello,80-250,10-100');
    expect(normalizeHappFragment('50-100,10-20,1-3')).toBe('1-3,50-100,10-20');
  });

  it('accepts tlshello first as well, and rejects junk', () => {
    expect(normalizeHappFragment('tlshello,5-10,1-3')).toBe('tlshello,5-10,1-3');
    expect(normalizeHappFragment('many,few')).toBeUndefined();
    expect(normalizeHappFragment('80-250')).toBeUndefined();
    expect(normalizeHappFragment('1,2,3,4')).toBeUndefined();
  });
});

describe('splitLinkMeta', () => {
  it('cuts serverDescription out of the fragment so the name stays clean', () => {
    const r = splitLinkMeta(`vless://${UUID}@h.example:443?type=tcp#Берлин?serverDescription=SGFwcCB0aGUgYmVzdA==`);
    expect(r.link).toBe(`vless://${UUID}@h.example:443?type=tcp#Берлин`);
    expect(r.meta.description).toBe('Happ the best');
  });

  it('cuts it out of the query, even in front of the vmess base64 body', () => {
    const r = splitLinkMeta(`vmess://${b64('{"add":"h.example"}')}?serverDescription=SGFwcCB0aGUgYmVzdA==#Имя`);
    expect(r.link).toBe(`vmess://${b64('{"add":"h.example"}')}#Имя`);
    expect(r.meta.description).toBe('Happ the best');
  });

  it('keeps the other query parameters of the link untouched', () => {
    const r = splitLinkMeta(`vless://${UUID}@h.example:443?security=tls&serverDescription=SGk=&sni=a.example#n`);
    expect(r.link).toBe(`vless://${UUID}@h.example:443?security=tls&sni=a.example#n`);
    expect(r.meta.description).toBe('Hi');
  });

  it('reads fragment, resolve-address, host and insecure from the fragment query', () => {
    const r = splitLinkMeta('vless://u@visa.com:443#MyVPN?fragment=80-250,10-100,tlshello&resolve-address=visa.com&host=mydomain.com&insecure=1');
    expect(r.link).toBe('vless://u@visa.com:443#MyVPN');
    expect(r.meta).toEqual({ fragment: 'tlshello,80-250,10-100', resolveAddress: 'visa.com', host: 'mydomain.com', insecure: true });
  });

  it('host and insecure in the ordinary query are the link\'s own parameters and stay', () => {
    const r = splitLinkMeta('vless://u@h.example:443?type=ws&host=ws.example&insecure=1#n');
    expect(r.link).toBe('vless://u@h.example:443?type=ws&host=ws.example&insecure=1#n');
    expect(r.meta).toEqual({});
  });

  it('a fragment encoded as a whole (the "?" is %3F) is understood too', () => {
    const r = splitLinkMeta(`vless://${UUID}@h.example:443#${encodeURIComponent('Берлин?serverDescription=SGk=')}`);
    expect(r.meta.description).toBe('Hi');
    expect(decodeURIComponent(r.link.split('#')[1])).toBe('Берлин');
  });

  it('a "?" in a name without any known key is left alone', () => {
    const r = splitLinkMeta('vless://u@h.example:443#Что?Где');
    expect(r.link).toBe('vless://u@h.example:443#Что?Где');
  });

  it('rejects an address with junk instead of using it', () => {
    expect(splitLinkMeta('vless://u@h.example:443#n?resolve-address=a%20b/c').meta.resolveAddress).toBeUndefined();
  });
});

describe('applyLinkMeta', () => {
  const node = (over = {}) => ({ id: 'n', name: 'n', address: 'front.example', port: 443, protocol: 'vless', remark: 'n', rawLink: 'x', ...over }) as any;

  it('resolve-address is where we connect; the link address stays as the TLS name', () => {
    const out = applyLinkMeta(node(), { resolveAddress: '203.0.113.7', host: 'site.example' });
    expect(out.address).toBe('203.0.113.7');
    expect(out.sni).toBe('front.example');
    expect(out.host).toBe('site.example');
  });

  it('an explicit sni of the link is not overwritten', () => {
    expect(applyLinkMeta(node({ sni: 'real.example' }), { resolveAddress: '203.0.113.7' }).sni).toBe('real.example');
  });

  it('insecure and fragment land on the node', () => {
    const out = applyLinkMeta(node(), { insecure: true, fragment: 'tlshello,5-10,1-3', description: 'Узел' });
    expect(out).toMatchObject({ allowInsecure: true, fragment: 'tlshello,5-10,1-3', description: 'Узел' });
  });
});

describe('parseLink with Happ server parameters', () => {
  it('vless: description from the fragment, name without the tail', () => {
    const n = parseLink(`vless://${UUID}@h.example:443?security=tls&type=tcp#Берлин?serverDescription=${b64('Быстрый узел')}`)!;
    expect(n.name).toBe('Берлин');
    expect(n.description).toBe('Быстрый узел');
    expect(n.rawLink).toContain('serverDescription=');
  });

  it('vmess: the base64 body still decodes when the parameter follows it', () => {
    const body = b64(JSON.stringify({ add: 'vm.example', port: '443', id: UUID, net: 'ws', tls: 'tls', ps: 'VM' }));
    const n = parseLink(`vmess://${body}?serverDescription=SGFwcCB0aGUgYmVzdA==`)!;
    expect(n.address).toBe('vm.example');
    expect(n.name).toBe('VM');
    expect(n.description).toBe('Happ the best');
  });

  it.each([
    ['trojan', `trojan://pass@t.example:443?security=tls#T?serverDescription=SGk=`],
    ['socks', `socks://user:pass@s.example:1080#S?serverDescription=SGk=`],
    ['ss', `ss://${b64('aes-256-gcm:secret')}@ss.example:8388#SS?serverDescription=SGk=`],
    ['wireguard', `wireguard://priv@w.example:51820?publickey=pub#W?serverDescription=SGk=`],
  ])('%s: description is read and the name stays clean', (_p, link) => {
    const n = parseLink(link)!;
    expect(n.description).toBe('Hi');
    expect(n.name).not.toContain('serverDescription');
    expect(n.name).not.toContain('?');
  });

  it('a link without any parameters is untouched (same node as before)', () => {
    const n = parseLink(`vless://${UUID}@h.example:443?security=tls#Имя`)!;
    expect(n.name).toBe('Имя');
    expect(n.description).toBeUndefined();
    expect(n.rawLink).toBe(`vless://${UUID}@h.example:443?security=tls#Имя`);
  });

  it('per-server fragment from the link wins over the global one in node.fragment', () => {
    const n = parseLink(`vless://${UUID}@h.example:443?security=tls#n?fragment=80-250,10-100,tlshello`)!;
    expect(n.fragment).toBe('tlshello,80-250,10-100');
  });
});

describe('subscriptions carry per-server descriptions', () => {
  it('each line gets its own description', () => {
    const body = [
      `vless://${UUID}@a.example:443?security=tls#Один?serverDescription=${b64('Первый')}`,
      `vless://${UUID}@b.example:443?security=tls#Два?serverDescription=${b64('Второй')}`,
      `vless://${UUID}@c.example:443?security=tls#Три`,
    ].join('\n');
    const r = parseSubscription(body);
    expect(r.nodes.map((n) => [n.name, n.description])).toEqual([['Один', 'Первый'], ['Два', 'Второй'], ['Три', undefined]]);
  });

  it('works for a base64-encoded subscription body too', () => {
    const body = `vless://${UUID}@a.example:443?security=tls#Один?serverDescription=${b64('Первый')}`;
    const r = parseSubscription(b64(body));
    expect(r.nodes[0]?.description).toBe('Первый');
    expect(r.nodes[0]?.name).toBe('Один');
  });
});

describe('JSON configs: meta.serverDescription', () => {
  const cfg = (extra: any = {}) => ({
    remarks: 'DE', ...extra,
    outbounds: [{ tag: 'proxy', protocol: 'vless', settings: { vnext: [{ address: 'de.example', port: 443, users: [{ id: UUID, encryption: 'none' }] }] }, streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'de.example' } } }],
  });

  it('a single config', () => {
    const [n] = extractNodesFromFullConfig(cfg({ meta: { serverDescription: b64('Франкфурт') } }));
    expect(n.description).toBe('Франкфурт');
  });

  it('an array of configs (Remnawave style): each node gets its own description', () => {
    const nodes = extractNodesFromFullConfig([
      cfg({ remarks: 'A', meta: { serverDescription: 'Первый' } }),
      cfg({ remarks: 'B', meta: { serverDescription: 'Второй' } }),
    ]);
    expect(nodes.map((n) => n.description)).toEqual(['Первый', 'Второй']);
  });

  it('through parseSubscription', () => {
    const r = parseSubscription(JSON.stringify([cfg({ meta: { serverDescription: 'Узел' } })]));
    expect(r.nodes[0]?.description).toBe('Узел');
  });

  it('server ids do not change when the panel starts sending meta (the selected server survives the switch)', () => {
    // Реальные конфиги большие (идентификатор учитывает хеш всего конфига только от 300 символов) — делаем такие же.
    const big = (remarks: string, extra: any = {}) => cfg({ remarks, routing: { rules: [{ pad: remarks.repeat(400) }] }, ...extra });
    const without = extractNodesFromFullConfig([big('A'), big('B')]);
    const withMeta = extractNodesFromFullConfig([big('A', { meta: { serverDescription: 'Первый' } }), big('B', { meta: { serverDescription: 'Второй' } })]);
    expect(withMeta.map((n) => n.id)).toEqual(without.map((n) => n.id));
    expect(new Set(withMeta.map((n) => n.id)).size).toBe(2);
    expect(withMeta.map((n) => n.rawLink)).toEqual(without.map((n) => n.rawLink));
  });

  it('also accepted at the root of the config, in case a panel puts it there', () => {
    const [n] = extractNodesFromFullConfig(cfg({ serverDescription: 'Корневой' }));
    expect(n.description).toBe('Корневой');
  });

  it('no meta, no description; the protocol label stays where it was', () => {
    const [n] = extractNodesFromFullConfig(cfg());
    expect(n.description).toBeUndefined();
    expect(n.serverDescription).toContain('VLESS');
  });
});
