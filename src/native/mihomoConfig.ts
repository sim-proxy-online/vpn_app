import { ServerNode } from '../types';

// ── mihomo (Clash.Meta) config builder ──────────────────────────────────────
// mihomo covers the protocols Xray-core cannot run: hysteria, hysteria2, tuic,
// anytls — plus all the usual vless/vmess/trojan/ss/wireguard. It reads YAML;
// since JSON is a valid YAML subset we emit JSON (no YAML dependency needed).
//
// The TUN device is bound to the VpnService fd via `device: "fd://<fd>"`. JS
// cannot know the fd (created in Java), so we leave the literal placeholder
// `__SIM_TUN_FD__` and the Java MihomoManager substitutes the real fd before
// writing the file. socksPort/mixed-port is used only as a readiness probe.

const TUN_FD_PLACEHOLDER = '__SIM_TUN_FD__';
export { TUN_FD_PLACEHOLDER };

// Protocols that should be routed to the mihomo core instead of Xray.
export const MIHOMO_ONLY_PROTOCOLS = new Set<string>([
  'hysteria', 'hysteria2', 'tuic', 'anytls', 'shadowtls', 'naive',
]);

export function shouldUseMihomo(protocol: string): boolean {
  return MIHOMO_ONLY_PROTOCOLS.has((protocol || '').toLowerCase());
}

function networkOpts(node: ServerNode, proxy: Record<string, any>): void {
  const net = (node.transport || 'tcp').toLowerCase();
  const host = node.host || node.sni || node.address;
  if (net === 'ws') {
    proxy.network = 'ws';
    proxy['ws-opts'] = { path: node.path || '/', headers: host ? { Host: host } : {} };
  } else if (net === 'grpc') {
    proxy.network = 'grpc';
    proxy['grpc-opts'] = { 'grpc-service-name': node.path || '' };
  } else if (net === 'h2' || net === 'http') {
    proxy.network = 'h2';
    proxy['h2-opts'] = { path: node.path || '/', host: host ? [host] : [] };
  } else if (net === 'http-upgrade' || net === 'httpupgrade') {
    proxy.network = 'ws';
    proxy['ws-opts'] = { path: node.path || '/', 'v2ray-http-upgrade': true, headers: host ? { Host: host } : {} };
  }
  // tcp/raw/xhttp → default, no network block
}

function tlsOpts(node: ServerNode, proxy: Record<string, any>): void {
  const sec = (node.security || '').toLowerCase();
  const isTrojan = (node.protocol || '').toLowerCase() === 'trojan';
  if (sec === 'tls' || sec === 'reality' || node.sni || isTrojan) {
    proxy.tls = true;
    if (node.sni) proxy.servername = node.sni;
    if (node.allowInsecure) proxy['skip-cert-verify'] = true;
    if (node.fingerprint) proxy['client-fingerprint'] = node.fingerprint;
    if (node.alpn) proxy.alpn = node.alpn.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (sec === 'reality') {
    proxy.tls = true;
    proxy['reality-opts'] = {
      'public-key': node.publicKey || '',
      'short-id': node.shortId || '',
    };
    proxy['client-fingerprint'] = node.fingerprint || 'chrome';
  }
}

// Convert a single ServerNode into a mihomo proxy object.
export function nodeToMihomoProxy(node: ServerNode, settings?: Record<string, unknown>): Record<string, any> {
  const name = node.name || `${node.protocol}-${node.address}`;
  const base: Record<string, any> = { name, server: node.address, port: Number(node.port), udp: true };
  const p = (node.protocol || '').toLowerCase();

  switch (p) {
    case 'vless': {
      const proxy = { ...base, type: 'vless', uuid: node.uuid, ...(node.flow ? { flow: node.flow } : {}) };
      networkOpts(node, proxy); tlsOpts(node, proxy);
      return proxy;
    }
    case 'vmess': {
      const proxy = { ...base, type: 'vmess', uuid: node.uuid, alterId: node.alterId || 0, cipher: 'auto' };
      networkOpts(node, proxy); tlsOpts(node, proxy);
      return proxy;
    }
    case 'trojan': {
      const proxy = { ...base, type: 'trojan', password: node.password, sni: node.sni || undefined };
      networkOpts(node, proxy);
      tlsOpts(node, proxy); // fingerprint, alpn, skip-cert-verify
      return proxy;
    }
    case 'shadowsocks':
    case 'ss':
      return { ...base, type: 'ss', cipher: node.method || 'aes-256-gcm', password: node.password };
    case 'hysteria2':
    case 'hy2': {
      const obfsParts = (node.obfs || '').split(':');
      return {
        ...base, type: 'hysteria2', password: node.password || '',
        sni: node.sni || undefined,
        'skip-cert-verify': !!node.allowInsecure || node.fingerprint === 'skip-cert-verify',
        ...(obfsParts[0] ? { obfs: obfsParts[0], 'obfs-password': obfsParts[1] || '' } : {}),
        ...(node.alpn ? { alpn: node.alpn.split(',').map(s => s.trim()) } : {}),
      };
    }
    case 'hysteria': {
      // Remna publishes hysteria2 nodes under the old hysteria:// scheme with UUID passwords.
      // Detect here as a last-resort so the mihomo config is always correct.
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (node.password && uuidPattern.test(node.password)) {
        const obfsParts = (node.obfs || '').split(':');
        return {
          ...base, type: 'hysteria2', password: node.password || '',
          sni: node.sni || undefined,
          'skip-cert-verify': true,
          ...(obfsParts[0] ? { obfs: obfsParts[0], 'obfs-password': obfsParts[1] || '' } : {}),
          ...(node.alpn ? { alpn: node.alpn.split(',').map(s => s.trim()) } : {}),
        };
      }
      return {
        ...base, type: 'hysteria', 'auth-str': node.password || undefined,
        obfs: node.obfs || undefined, sni: node.sni || undefined,
        'skip-cert-verify': !!node.allowInsecure,
        up: '50 Mbps', down: '100 Mbps',
        ...(node.alpn ? { alpn: node.alpn.split(',').map(s => s.trim()) } : {}),
      };
    }
    case 'tuic': {
      return {
        ...base, type: 'tuic',
        ...(node.uuid ? { uuid: node.uuid } : {}),
        ...(node.password ? { password: node.password } : {}),
        sni: node.sni || undefined,
        'skip-cert-verify': !!node.allowInsecure,
        'congestion-controller': 'bbr',
        'udp-relay-mode': 'native',
        ...(node.alpn ? { alpn: node.alpn.split(',').map(s => s.trim()) } : { alpn: ['h3'] }),
      };
    }
    case 'anytls': {
      const proxy = { ...base, type: 'anytls', password: node.password, sni: node.sni || undefined, 'skip-cert-verify': !!node.allowInsecure };
      return proxy;
    }
    case 'shadowtls': {
      // ShadowTLS v3: маскирует трафик под TLS-рукопожатие реального сайта (sni).
      // version=3 обязателен — v1/v2 уязвимы к replay-атакам и детектируются DPI.
      // client-fingerprint берём из настроек uTLS если не задан в ссылке.
      const fp = node.fingerprint || (settings as any)?.uTlsFingerprint || (settings as any)?.fingerprint || 'chrome';
      return {
        ...base,
        type: 'shadowtls',
        password: node.password || '',
        version: node.version ?? 3,
        sni: node.sni || 'www.apple.com',
        'client-fingerprint': fp === 'none' ? 'chrome' : fp,
      };
    }
    case 'wireguard': {
      return {
        ...base, type: 'wireguard',
        'private-key': node.privateKey || '',
        'public-key': node.publicKey || '',
        ...(node.preSharedKey ? { 'pre-shared-key': node.preSharedKey } : {}),
        ip: (node.localAddress || '172.16.0.2/32').split(',')[0].trim().split('/')[0],
        mtu: node.mtu ? Number(node.mtu) : 1420,
      };
    }
    default:
      // Best effort: pass through as-is, mihomo may still understand it.
      return { ...base, type: p, password: node.password, uuid: node.uuid };
  }
}

// Strip undefined values so the emitted YAML/JSON stays clean.
function clean<T extends Record<string, any>>(obj: T): T {
  Object.keys(obj).forEach(k => { if (obj[k] === undefined) delete obj[k]; });
  return obj;
}

export function buildMihomoConfig(node: ServerNode, settings: Record<string, unknown>): string {
  const socksPort = Number((settings as any).socksPort) || 10808;
  const proxy = clean(nodeToMihomoProxy(node, settings));
  const proxyName = proxy.name as string;

  const userDns = String((settings as any).dnsAddress || '').trim();
  const nameservers = [userDns, '1.1.1.1', '8.8.8.8', 'https://1.1.1.1/dns-query']
    .filter((v, i, a) => v && a.indexOf(v) === i);

  const uTlsFp = String((settings as any).uTlsFingerprint || 'chrome');
  // Mihomo принимает те же значения fingerprint что и Xray (chrome/firefox/safari/ios/android/edge/random/none)
  const mihomoFp = uTlsFp === 'none' ? '' : uTlsFp;

  const config = {
    'mixed-port': socksPort,
    'allow-lan': false,
    mode: 'rule',
    'log-level': (() => { const m: Record<string,string> = { none: 'silent', warning: 'warning', info: 'info', debug: 'debug', error: 'error' }; return m[String((settings as any).logsMode)] || 'info'; })(),
    ...(mihomoFp ? { 'global-ua': `Mozilla/5.0 (compatible; ${mihomoFp})`, 'tls-fingerprint': mihomoFp } : {}),
    ipv6: false,
    dns: {
      enable: true,
      listen: '127.0.0.1:1053',
      ipv6: false,
      // No fake-ip: mihomo runs as SOCKS5 proxy (tun2socks bridges TUN→SOCKS5).
      // Fake-ip only works in mihomo TUN mode; here DNS arrives as raw SOCKS5 UDP.
      'enhanced-mode': 'normal',
      'default-nameserver': ['1.1.1.1', '8.8.8.8'],
      nameserver: nameservers,
    },
    proxies: [proxy],
    'proxy-groups': [
      { name: 'PROXY', type: 'select', proxies: [proxyName] },
    ],
    rules: [
      'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
      'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
      // DNS bypasses the proxy: many Hysteria servers drop UDP/53 responses.
      // Our app process is excluded from VPN (blacklist/default mode) so DIRECT
      // here means mihomo sends DNS directly to the internet — fast and reliable.
      'DST-PORT,53,DIRECT',
      'MATCH,PROXY',
    ],
  };

  return JSON.stringify(config, null, 2);
}
