import { ServerNode, Protocol, RoutingProfile, SubscriptionTraffic, PanelType } from './types';

export function generateId(node?: Partial<ServerNode>): string {
  if (node && node.address && node.port && node.protocol) {
    // Create a deterministic ID based on unique server properties to preserve selection after updates
    const raw = node.rawLink || '';
    // For full Xray/sing-box configs (large JSON), also hash the raw config so that
    // configs sharing the same first proxy outbound (same address:port:uuid) but with
    // different routing rules get distinct IDs and aren't deduplicated.
    let rawSuffix = '';
    if (raw.length > 300 && raw[0] === '{') {
      let h = 0;
      for (let i = 0; i < raw.length; i++) { h = ((h << 5) - h) + raw.charCodeAt(i); h |= 0; }
      rawSuffix = ':' + Math.abs(h).toString(36);
    }
    const identity = `${node.protocol}:${node.address}:${node.port}:${node.uuid || node.password || node.username || ''}:${node.path || ''}:${node.host || node.sni || ''}${rawSuffix}`;
    let hash = 0;
    for (let i = 0; i < identity.length; i++) {
      const char = identity.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return 'sim-' + Math.abs(hash).toString(36);
  }
  // Fallback for non-node entities like profiles
  return 'id-' + Math.random().toString(36).substring(2, 10);
}

function universalDecode(str: string): string {
  if (!str) return '';
  let b64 = str.trim().replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  try {
    const raw = window.atob(b64);
    try {
      return decodeURIComponent(Array.prototype.map.call(raw, (c: string) =>
        '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
      ).join(''));
    } catch { return raw; }
  } catch { return str; }
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function detectFlag(name: string): string {
  const l = (name || '').toLowerCase();
  // Short codes (≤3 chars) require word boundary to avoid false positives
  // e.g. "pl" must not match "wlplay", "nl" must not match "online"
  const hasWord = (str: string, kw: string): boolean => {
    if (kw.length > 3) return str.includes(kw);
    return new RegExp(`(?:^|[\\s\\-_#0-9/])${kw}(?:[\\s\\-_#0-9/]|$)`).test(str);
  };
  const map: [string[], string][] = [
    [['🇷🇺','ru','россия','moscow','москва','russia','spb','питер','saint','российск'], '🇷🇺'],
    [['🇩🇪','de','german','frankfurt','berlin','munich','nuremberg','düsseldorf','германи','германия'], '🇩🇪'],
    [['🇳🇱','nl','nether','amsterdam','holland','нидерланды','нидерланд'], '🇳🇱'],
    [['🇯🇵','jp','japan','tokyo','osaka','япони'], '🇯🇵'],
    [['🇺🇸','us','usa','new york','los angeles','america','dallas','chicago','miami','seattle','washington','san jose','atlanta','virginia','ohio','oregon','сша','америк'], '🇺🇸'],
    [['🇬🇧','united kingdom','great britain','london','brit','england','британи','великобритан'], '🇬🇧'],
    [['🇸🇬','sg','singap','сингапур'], '🇸🇬'],
    [['🇫🇷','fr','france','paris','lyon','франци'], '🇫🇷'],
    [['🇹🇷','tr','turk','istanbul','ankara','турци'], '🇹🇷'],
    [['🇨🇦','ca','canada','toronto','vancouver','montreal','канад'], '🇨🇦'],
    [['🇦🇺','au','australia','sydney','melbourne','brisbane','австрали'], '🇦🇺'],
    [['🇰🇷','kr','korea','seoul','коре'], '🇰🇷'],
    [['🇭🇰','hk','hong kong','hongkong','гонконг'], '🇭🇰'],
    [['🇹🇼','tw','taiwan','taipei','тайван'], '🇹🇼'],
    [['🇮🇳','in','india','mumbai','delhi','bangalore','инди'], '🇮🇳'],
    [['🇧🇷','br','brazil','brasil','sao paulo','бразили'], '🇧🇷'],
    [['🇵🇱','pl','poland','warsaw','польш','польша'], '🇵🇱'],
    [['🇺🇦','ua','ukraine','kyiv','kiev','украин'], '🇺🇦'],
    [['🇫🇮','fi','finland','helsinki','финлянд','финляндия'], '🇫🇮'],
    [['🇸🇪','se','sweden','stockholm','швеци'], '🇸🇪'],
    [['🇨🇭','ch','swiss','zurich','geneva','швейцар'], '🇨🇭'],
    [['🇦🇹','at','austria','vienna','австри'], '🇦🇹'],
    [['🇧🇪','be','belgium','brussels','бельги'], '🇧🇪'],
    [['🇮🇱','il','israel','tel aviv','израил'], '🇮🇱'],
    [['🇮🇷','ir','iran','tehran','иран'], '🇮🇷'],
    [['🇨🇿','cz','czech','prague','czechia','чехи'], '🇨🇿'],
    [['🇭🇺','hu','hungary','budapest','венгри'], '🇭🇺'],
    [['🇷🇴','ro','romania','bucharest','румын'], '🇷🇴'],
    [['🇧🇬','bg','bulgaria','sofia','болгар'], '🇧🇬'],
    [['🇬🇷','gr','greece','athens','греци'], '🇬🇷'],
    [['🇵🇹','pt','portugal','lisbon','португал'], '🇵🇹'],
    [['🇪🇸','es','spain','madrid','barcelona','испани','испания'], '🇪🇸'],
    [['🇮🇹','it','italy','milan','rome','итали'], '🇮🇹'],
    [['🇩🇰','dk','denmark','copenhagen','дании','дания'], '🇩🇰'],
    [['🇳🇴','no','norway','oslo','норвег'], '🇳🇴'],
    [['🇲🇾','my','malaysia','kuala','малайзи'], '🇲🇾'],
    [['🇮🇩','id','indonesia','jakarta','индонези'], '🇮🇩'],
    [['🇹🇭','th','thailand','bangkok','таиланд'], '🇹🇭'],
    [['🇻🇳','vn','vietnam','hanoi','ho chi','вьетнам'], '🇻🇳'],
    [['🇵🇭','ph','philippines','manila','филиппин'], '🇵🇭'],
    [['🇿🇦','za','south africa','johannesburg','cape town'], '🇿🇦'],
    [['🇸🇦','sa','saudi','riyadh','саудов'], '🇸🇦'],
    [['🇦🇪','ae','uae','dubai','abu dhabi','эмират'], '🇦🇪'],
    [['🇲🇩','md','moldova','chisinau','молдов'], '🇲🇩'],
    [['🇱🇻','lv','latvia','riga','латви','латвия'], '🇱🇻'],
    [['🇱🇹','lt','lithuania','vilnius','литв'], '🇱🇹'],
    [['🇪🇪','ee','estonia','tallinn','эстони'], '🇪🇪'],
    [['🇦🇲','am','armenia','yerevan','армени'], '🇦🇲'],
    [['🇬🇪','ge','georgia','tbilisi','грузи'], '🇬🇪'],
    [['🇰🇿','kz','kazakhstan','almaty','казахст'], '🇰🇿'],
    [['🇺🇿','uz','uzbekistan','tashkent','узбекист'], '🇺🇿'],
  ];
  for (const [keys, flag] of map) { for (const k of keys) { if (hasWord(l, k)) return flag; } }
  return '🌐';
}

function makeNode(
  name: string, address: string, port: number, protocol: Protocol,
  raw: string, extra?: Partial<ServerNode>,
): ServerNode | null {
  if (!address || address === 'unknown' || address === '0.0.0.0') return null;
  const nm = (name || `${protocol.toUpperCase()} ${address}`).trim();
  const nodeBase = { address, port, protocol, rawLink: raw, ...extra };
  return {
    id: generateId(nodeBase), name: nm, address, port, protocol,
    remark: nm, flag: detectFlag(nm), rawLink: raw, ...extra,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isFullConfig(j: any): boolean {
  return !!(j && typeof j === 'object' && (j.outbounds || j.routing || j.dns || j.route || j.log));
}

// Tags that identify routing/utility outbounds to skip during proxy search.
// Do NOT add 'proxy'/'PROXY' here — those are valid main-proxy tags in Xray configs.
// Selector/urltest types are already filtered by SKIP_OUTBOUND_TYPES.
const SKIP_OUTBOUND_TAGS = new Set([
  'direct', 'block', 'dns-out', 'dns', 'dns_out', 'freedom', 'blackhole',
  'bypass', 'BYPASS', 'reject', 'REJECT',
  'loop_to_lte', 'loop_to_smart',
]);

// Tags that look like generic labels and should not be used as the node display name.
const GENERIC_TAGS = new Set([
  'proxy', 'PROXY', 'outbound', 'global', 'auto', 'Auto',
  'Selector', 'selector', 'Manual', 'Best Latency', 'BestPing', 'RELAY',
]);

const SKIP_OUTBOUND_TYPES = new Set([
  'freedom', 'blackhole', 'direct', 'block', 'dns',
  'selector', 'urltest', 'loadbalance', 'grpc',
]);


function extractSingBoxTLS(tls: any): Partial<ServerNode> {
  if (!tls) return {};
  const out: Partial<ServerNode> = {};
  if (!tls.enabled && !tls.reality?.enabled) return out;
  out.sni = tls.server_name || tls.serverName || undefined;
  if (tls.reality?.enabled) {
    out.security = 'reality';
    out.publicKey = tls.reality.public_key || tls.reality.publicKey || undefined;
    out.shortId = tls.reality.short_id || tls.reality.shortId || undefined;
  } else {
    out.security = 'tls';
  }
  out.fingerprint = tls.utls?.fingerprint || tls.fingerprint || undefined;
  return out;
}

function extractSingBoxTransport(tr: any): Partial<ServerNode> {
  if (!tr || !tr.type) return {};
  const out: Partial<ServerNode> = { transport: tr.type };
  if (tr.type === 'ws') {
    out.path = tr.path || undefined;
    const h = tr.headers?.Host || tr.headers?.host || tr.host;
    out.host = Array.isArray(h) ? h[0] : h || undefined;
  } else if (tr.type === 'grpc') {
    out.path = tr.service_name || tr.serviceName || undefined;
  } else if (tr.type === 'h2' || tr.type === 'http') {
    out.path = tr.path || undefined;
    const h = tr.host;
    out.host = Array.isArray(h) ? h[0] : h || undefined;
  } else if (tr.type === 'httpupgrade') {
    out.path = tr.path || undefined;
    out.host = tr.host || undefined;
  } else if (tr.type === 'xhttp' || tr.type === 'splithttp') {
    out.path = tr.path || undefined;
    const h = tr.host || tr.headers?.Host;
    out.host = Array.isArray(h) ? h[0] : h || undefined;
  }
  return out;
}


// ── Extract individual nodes from a full Xray or sing-box config ─────────────
export function extractNodesFromFullConfig(j: any, _depth = 0): ServerNode[] {
  if (!j) return [];

  // 1. Если это массив (напр. подписка Remnawave), обрабатываем каждый элемент рекурсивно.
  // Лимит глубины 4 защищает от патологически вложенных структур в malformed-подписках.
  if (Array.isArray(j)) {
    if (_depth > 4) return [];
    const all: ServerNode[] = [];
    j.forEach(item => { all.push(...extractNodesFromFullConfig(item, _depth + 1)); });
    return all;
  }

  // 2. Одиночный полный конфиг — ищем первый настоящий прокси-аутбаунд
  const outbounds = Array.isArray(j.outbounds) ? j.outbounds : [];
  let targetOb: any = null;

  // Pass 1: protocols with non-standard address location (hysteria uses settings.address directly)
  for (const ob of outbounds) {
    const type = (ob.protocol || ob.type || '').toLowerCase();
    if (type !== 'hysteria' && type !== 'hy2' && type !== 'hysteria2') continue;
    const tag = (ob.tag || ob.name || '').toLowerCase();
    if (SKIP_OUTBOUND_TAGS.has(tag)) continue;
    const s = ob.settings || {};
    const a = String(s.address || ob.server || '');
    if (a && a !== '0.0.0.0' && a !== '127.0.0.1') { targetOb = ob; break; }
  }

  // Pass 2: standard outbound detection for all protocols
  if (!targetOb) {
    for (const ob of outbounds) {
      const type = (ob.protocol || ob.type || '').toLowerCase();
      const tag = (ob.tag || ob.name || '').trim();
      if (!type || SKIP_OUTBOUND_TYPES.has(type)) continue;
      if (tag && (tag.toLowerCase().includes('loop') || tag.toLowerCase().includes('internal') || SKIP_OUTBOUND_TAGS.has(tag))) continue;
      const settings = ob.settings || {};
      const addr = ob.server || settings.address || settings.vnext?.[0]?.address || settings.servers?.[0]?.address || ob.proxySettings?.address;
      if (addr && addr !== '127.0.0.1' && addr !== 'localhost' && addr !== '0.0.0.0' && !addr.startsWith('198.18')) {
        targetOb = ob;
        break;
      }
    }
  }

  const rawJson = JSON.stringify(j);

  if (!targetOb) {
    const cfgName = j.remarks || j.name || j.ps || 'Full Config';
    // Extract real proto/addr from any non-system outbound for display
    let fbProto: Protocol = 'vless'; let fbAddr = cfgName;
    for (const ob of outbounds) {
      const t = (ob.protocol || ob.type || '').toLowerCase();
      if (!t || SKIP_OUTBOUND_TYPES.has(t)) continue;
      const s = ob.settings || {};
      const a = String(ob.server || s.address || s.vnext?.[0]?.address || s.servers?.[0]?.address || '');
      if (a && a !== '0.0.0.0' && a !== '127.0.0.1') { fbProto = t as Protocol; fbAddr = a; break; }
    }
    const node = makeNode(cfgName, fbAddr, 443, fbProto, rawJson, {
      serverDescription: fbProto.toUpperCase(),
    });
    return node ? [node] : [];
  }

  // Извлекаем адрес, порт, протокол
  const proto = (targetOb.protocol || targetOb.type || 'vless').toLowerCase() as Protocol;
  const obSettings = targetOb.settings || {};
  const addr = String(
    targetOb.server ||
    obSettings.address ||
    obSettings.vnext?.[0]?.address ||
    obSettings.servers?.[0]?.address ||
    targetOb.proxySettings?.address || 'unknown'
  );
  const port = Number(
    targetOb.port || targetOb.server_port ||
    obSettings.port ||
    obSettings.vnext?.[0]?.port ||
    obSettings.servers?.[0]?.port || 443
  );

  // Sing-box хранит TLS и transport прямо в outbound (не в streamSettings)
  const sbTls  = targetOb.tls       || {};
  const sbTr   = targetOb.transport || {};

  // Пользователь (VLESS/VMess — Xray: settings.vnext, sing-box: поля верхнего уровня)
  const user = obSettings.vnext?.[0]?.users?.[0] || {};
  const uuid = user.id || user.uuid || targetOb.uuid || targetOb.id || undefined;
  const flow = user.flow || targetOb.flow || undefined;

  // Пароль (Trojan/SS — Xray: settings.servers, sing-box: поля верхнего уровня; Hysteria — streamSettings.hysteriaSettings.auth)
  const hysteriaAuth = (targetOb.streamSettings?.hysteriaSettings?.auth) || obSettings.auth || undefined;
  const password = hysteriaAuth || obSettings.servers?.[0]?.password || obSettings.password || targetOb.password || undefined;
  const method   = obSettings.servers?.[0]?.method   || obSettings.method   || undefined;

  // streamSettings (Xray) или transport (sing-box)
  const stream    = targetOb.streamSettings || {};
  const transport = (stream.network || stream.type || sbTr.type || 'tcp').toLowerCase();

  // security: Xray → stream.security, sing-box → tls.enabled + tls.reality.enabled
  let security = (stream.security || 'none').toLowerCase();
  if (security === 'none' && sbTls.enabled) {
    security = sbTls.reality?.enabled ? 'reality' : 'tls';
  }

  // Reality settings (Xray: stream.realitySettings, sing-box: tls.reality)
  const rs       = stream.realitySettings || {};
  const sbReality = (sbTls.reality?.enabled ? sbTls.reality : {}) as Record<string, any>;
  const publicKey   = rs.publicKey   || rs.public_key   || sbReality.public_key   || sbReality.publicKey   || undefined;
  const shortId     = (Array.isArray(rs.shortIds) ? rs.shortIds[0] : rs.shortId || rs.short_id)
                      || sbReality.short_id || sbReality.shortId || undefined;
  const sniReality  = rs.serverName  || rs.server_name  || rs.sni
                      || sbTls.server_name || sbTls.serverName || undefined;
  const fpReality   = rs.fingerprint || rs.fp || sbTls.utls?.fingerprint || undefined;

  // TLS settings (Xray: stream.tlsSettings)
  const ts     = stream.tlsSettings || {};
  const sniTls = ts.serverName || ts.server_name || ts.sni || undefined;
  const fpTls  = ts.fingerprint || ts.fp || undefined;

  const sni         = sniReality || sniTls || undefined;
  const fingerprint = fpReality  || fpTls  || undefined;

  // Транспортные настройки (Xray: stream.*Settings, sing-box: transport.*)
  let path: string | undefined;
  let host: string | undefined;
  if (transport === 'ws') {
    const ws = stream.wsSettings || {};
    path = ws.path || sbTr.path || undefined;
    const h = ws.headers?.Host || ws.headers?.host || ws.host || sbTr.headers?.Host;
    host = Array.isArray(h) ? h[0] : h || undefined;
  } else if (transport === 'grpc') {
    path = (stream.grpcSettings || {}).serviceName || (stream.grpcSettings || {}).service_name
           || sbTr.service_name || sbTr.serviceName || undefined;
  } else if (transport === 'h2' || transport === 'http') {
    const h2 = stream.httpSettings || {};
    path = h2.path || sbTr.path || undefined;
    const h = h2.host || sbTr.host;
    host = Array.isArray(h) ? h[0] : h || undefined;
  } else if (transport === 'xhttp' || transport === 'splithttp' || transport === 'httpupgrade') {
    const xh = stream.xhttpSettings || stream.splithttpSettings || stream.httpupgradeSettings || {};
    path = xh.path || sbTr.path || undefined;
    host = xh.host || sbTr.host || undefined;
  }

  // Имя: из метаданных конфига, или тег (если не generic), или адрес сервера
  const tag  = (targetOb.tag || targetOb.name || '').trim();
  const name = String(j.remarks || j.name || j.ps ||
    (tag && !GENERIC_TAGS.has(tag) ? tag : '') || addr);

  // Подпись протокола для serverDescription
  const parts = [proto.toUpperCase()];
  if (transport && transport !== 'tcp') parts.push(transport.toUpperCase());
  if (security && security !== 'none') parts.push(security.toUpperCase());

  const node = makeNode(name, addr, port, proto, rawJson, {
    uuid,
    password,
    method,
    flow,
    security: security !== 'none' ? security : undefined,
    transport: transport !== 'tcp' ? transport : undefined,
    sni,
    path,
    host,
    publicKey,
    shortId,
    fingerprint,
    serverDescription: parts.join(' • '),
    username: tag || undefined,
  });

  return node ? [node] : [];
}

// ── Clash / Mihomo YAML parser ───────────────────────────────────────────────
function parseClashYaml(raw: string): ServerNode[] {
  if (!raw.includes('proxies:')) return [];
  const nodes: ServerNode[] = [];
  // Match 'proxies:' only at the start of a line (avoid 'proxies:' inside proxy-groups)
  const topMatch = raw.match(/^proxies:/m);
  if (!topMatch || topMatch.index == null) return [];
  const start = topMatch.index;
  let section = raw.slice(start + 8);
  // Stop at the next top-level section key (proxy-groups, rules, script, etc.)
  const nextSection = section.match(/^[a-z][a-z-]*:/m);
  if (nextSection?.index != null) section = section.slice(0, nextSection.index);
  // Split on list items at the TOP indentation level only (same depth as the first entry).
  // This avoids splitting on nested lists like alpn, headers, proxies inside proxy-groups.
  const firstItemMatch = section.match(/^([ \t]*)-[ \t]/m);
  const itemIndent = firstItemMatch ? firstItemMatch[1].length : 0;
  const splitRe = new RegExp(`\\n(?=[ \\t]{${itemIndent}}-[ \\t])`);
  const blocks = section.split(splitRe);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    let p: Record<string, any> = {};

    // Inline JSON-like: - {name: "x", type: vless, ...}
    const inlineM = trimmed.match(/^-\s*\{([\s\S]+?)\}\s*$/);
    if (inlineM) {
      try {
        const normalized = '{' + inlineM[1]
          .replace(/([{,]\s*)([a-zA-Z_][\w-]*)(\s*:)/g, '$1"$2"$3')
          .replace(/:\s*'([^']*)'/g, ': "$1"') + '}';
        p = JSON.parse(normalized);
      } catch { /* fall through */ }
    }

    // Block format
    if (!p.type || !p.server) {
      const lines = block.split('\n');
      let inWsOpts = false, inRealityOpts = false, inGrpcOpts = false;
      let inH2Opts = false, inHttpOpts = false, inHysteria = false;

      for (const line of lines) {
        const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
        const kv = line.match(/^(\s*)([a-zA-Z][\w-]*):\s*(.*)?$/);
        if (!kv) continue;
        const [, , key, val] = kv;
        const v = (val || '').trim().replace(/^['"]|['"]$/g, '');

        const isNested = ['ws-opts','grpc-opts','reality-opts','h2-opts','http-opts',
          'obfs-opts','hysteria2','up','down'].includes(key);
        if (indent <= 4 && !isNested) {
          inWsOpts = false; inRealityOpts = false; inGrpcOpts = false;
          inH2Opts = false; inHttpOpts = false; inHysteria = false;
        }
        if (key === 'ws-opts') { inWsOpts = true; continue; }
        if (key === 'reality-opts') { inRealityOpts = true; continue; }
        if (key === 'grpc-opts') { inGrpcOpts = true; continue; }
        if (key === 'h2-opts') { inH2Opts = true; continue; }
        if (key === 'http-opts') { inHttpOpts = true; continue; }

        if (inWsOpts) {
          if (key === 'path') p.path = v;
          if (key === 'Host' || key === 'host') p.host = v;
          if (key === 'headers') { /* handled inline or via Host line */ }
        } else if (inRealityOpts) {
          if (key === 'public-key') p['public-key'] = v;
          if (key === 'short-id') p['short-id'] = v;
        } else if (inGrpcOpts) {
          if (key === 'grpc-service-name') p.path = v;
        } else if (inH2Opts || inHttpOpts) {
          if (key === 'path') p.path = v;
          if (key === 'host') p.host = v;
        } else if (v) {
          p[key] = v;
        }
      }
    }

    const server = String(p.server || '').trim();
    const type = String(p.type || '').toLowerCase().trim();
    if (!server || !type) continue;

    const port = parseInt(String(p.port || '443')) || 443;
    const name = String(p.name || server);

    const hasTls = p.tls === 'true' || p.tls === true;
    const hasReality = !!(p['public-key'] || block.includes('reality-opts'));
    const security = hasReality ? 'reality' : (hasTls ? 'tls' : 'none');
    const transport = String(p.network || p.net || 'tcp').toLowerCase();

    // VMess: username field contains base64-encoded config in some clash formats
    let uuid = String(p.uuid || p.password || '');
    if (type === 'vmess' && !uuid && p.username) {
      // Try decoding Clash vmess username
      try { const d = universalDecode(p.username); if (d.includes('{')) { const j = JSON.parse(d); uuid = j.id || ''; } }
      catch { uuid = p.username; }
    }

    // SS cipher / password handling
    let method = p.cipher || p.method || p.encrypt || undefined;
    let password = p.password || p.uuid || '';

    // Hysteria: Remna publishes hysteria2 nodes as type:hysteria in Clash YAML.
    // Detect by UUID auth + no speed params — same heuristic as the URL parser.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let effectiveType = type;
    let hyPassword = '';
    if (type === 'hysteria2' || type === 'hy2') {
      hyPassword = p.password || p.auth || '';
    } else if (type === 'hysteria') {
      const authStr = p['auth-str'] || p.auth_str || p.auth || p.password || '';
      // UUID auth = remna hysteria2 node mis-typed as v1. Speed params (up/down) are
      // present in both v1 and remna's v2 YAML, so we rely only on UUID detection.
      if (uuidRe.test(authStr)) {
        effectiveType = 'hysteria2';
        hyPassword = authStr;
      }
    }

    // TUIC specific
    let tuicCongestion = p['congestion-controller'] || p.congestion_control || 'bbr';

    const remnaH2 = effectiveType === 'hysteria2' && type === 'hysteria'; // was mis-typed as v1
    const node = makeNode(name, server, port, effectiveType as Protocol, block.trim(), {
      uuid,
      password: effectiveType === 'hysteria2' || effectiveType === 'hy2' ? hyPassword : password,
      security,
      transport,
      sni: String(p.sni || p.servername || p['server-name'] || ''),
      path: p.path || undefined,
      host: p.host || undefined,
      publicKey: p['public-key'] || undefined,
      shortId: p['short-id'] || undefined,
      flow: p.flow || undefined,
      alterId: parseInt(String(p.alterId || p['alter-id'] || '0')) || 0,
      method: method ? String(method) : undefined,
      obfs: p.obfs || p['obfs-param'] || undefined,
      fingerprint: p.fingerprint || p.fp || undefined,
      allowInsecure: remnaH2 || p['skip-cert-verify'] === 'true' || p['skip-cert-verify'] === true || undefined,
      serverDescription: type === 'tuic' ? `TUIC • ${tuicCongestion}` : undefined,
    });
    if (node) nodes.push(node);
  }
  return nodes;
}

// ── Single proxy link parser ──────────────────────────────────────────────────
export function parseLink(link: string | any): ServerNode | null {
  if (!link) return null;
  try {
    // JSON object — either full config or single proxy
    if (typeof link === 'object' || (typeof link === 'string' && String(link).trimStart().startsWith('{'))) {
      const j = typeof link === 'object' ? link : JSON.parse(link as string);
      if (isFullConfig(j)) {
        // For full configs in parseLink, return single node (caller uses extractNodesFromFullConfig for arrays)
        const extracted = extractNodesFromFullConfig(j);
        return extracted[0] ?? null;
      }

      // Single proxy object (Clash JSON, v2rayN JSON, etc.)
      const proto = (j.protocol || j.type || j.proto || j.net || 'vless').toLowerCase() as Protocol;
      const addr = j.server || j.address || j.add || j.host || j.remote_addr;
      const port = parseInt(j.port || j.server_port || j.remote_port || 443) || 443;
      const name = j.remarks || j.remark || j.name || j.ps || j.tag || `${addr}:${port}`;

      const extra: Partial<ServerNode> = {
        uuid: j.uuid || j.id || undefined,
        password: j.password || j.pass || undefined,
        security: j.security || j.tls || undefined,
        transport: j.transport || j.network || j.net || j.type_transport || 'tcp',
        sni: j.sni || j.host || j.servername || j.server_name || j.peer || undefined,
        path: j.path || j.ws_path || j['ws-path'] || j.service_name || undefined,
        publicKey: j.publicKey || j.pbk || j.public_key || undefined,
        shortId: j.shortId || j.sid || j.short_id || undefined,
        flow: j.flow || j.xtls || undefined,
        fingerprint: j.fingerprint || j.fp || j.utls || undefined,
        fragment: j.fragment || j.frag || undefined,
        method: j.method || j.cipher || undefined,
        alterId: parseInt(j.alterId || j['alter-id'] || j.aid || 0) || 0,
      };

      // Handle sing-box TLS wrapper
      if (j.tls && typeof j.tls === 'object') {
        Object.assign(extra, extractSingBoxTLS(j.tls));
      }
      if (j.transport && typeof j.transport === 'object') {
        Object.assign(extra, extractSingBoxTransport(j.transport));
      }

      return makeNode(String(name), String(addr || ''), port, proto, JSON.stringify(j), extra);
    }

    // String link
    const t = String(link).trim();
    const lower = t.toLowerCase();
    if (!lower.includes('://')) return null;

    const scheme = lower.split('://')[0] as string;
    const proto = (scheme === 'ss' ? 'shadowsocks' : scheme) as Protocol;

    // VMess: base64-encoded JSON config
    if (scheme === 'vmess') {
      const parts = t.split('://')[1].split('#');
      const config = JSON.parse(universalDecode(parts[0]));
      // Accept non-standard address field names (some panels use "server" instead of "add")
      const vmessAddr = String(config.add || config.server || config.addr || config.address || '');
      if (!vmessAddr) return null;
      const vmessName = config.ps || config.remark || (parts[1] ? safeDecode(parts[1]) : '') || vmessAddr || 'VMess';
      return makeNode(
        vmessName,
        vmessAddr, Number(config.port) || 443, 'vmess', t, {
          uuid: config.id,
          security: config.tls || 'none',
          transport: config.net || 'tcp',
          headerType: config.type || undefined,
          sni: config.sni || config.host,
          path: config.path,
          host: config.host,
          alpn: config.alpn || undefined,
          alterId: +(config.aid || 0),
          fingerprint: config.fp,
        });
    }

    // Shadowsocks: may have base64-encoded userinfo
    if (scheme === 'ss' || scheme === 'shadowsocks') {
      try {
        const urlStr = t.replace(/^ss:\/\//i, 'http://');
        const u = new URL(urlStr);
        const name = u.hash ? safeDecode(u.hash.slice(1)) : u.hostname;
        // SIP002: userinfo is base64(method:pass) or plain method:pass
        let method = '', password = '';
        const userRaw = u.username;
        if (userRaw) {
          const decoded = (() => {
            try { return atob(userRaw.replace(/-/g,'+').replace(/_/g,'/')); } catch { return decodeURIComponent(userRaw); }
          })();
          const colonIdx = decoded.indexOf(':');
          if (colonIdx > 0) {
            method = decoded.slice(0, colonIdx);
            password = decoded.slice(colonIdx + 1);
          } else {
            // method:pass separate from URL password
            method = decoded;
            password = u.password ? decodeURIComponent(u.password) : '';
          }
        }
        const params = new URLSearchParams(u.search);
        return makeNode(name, u.hostname, Number(u.port) || 8388, 'shadowsocks', t, {
          method: method || params.get('method') || undefined,
          password: password || undefined,
          obfs: params.get('plugin') || params.get('obfs') || undefined,
        });
      } catch {
        // Old format: ss://BASE64(method:pass@host:port)#name
        try {
          const parts = t.replace(/^ss:\/\//i, '').split('#');
          const decoded = universalDecode(parts[0].split('?')[0]);
          const name = parts[1] ? safeDecode(parts[1]) : '';
          const atIdx = decoded.lastIndexOf('@');
          if (atIdx > 0) {
            const userInfo = decoded.slice(0, atIdx);
            const hostPart = decoded.slice(atIdx + 1);
            const colonIdx = userInfo.indexOf(':');
            const method = colonIdx >= 0 ? userInfo.slice(0, colonIdx) : '';
            const password = colonIdx >= 0 ? userInfo.slice(colonIdx + 1) : userInfo;
            const lastColon = hostPart.lastIndexOf(':');
            const host = hostPart.slice(0, lastColon);
            const port = parseInt(hostPart.slice(lastColon + 1)) || 8388;
            return makeNode(name || host, host, port, 'shadowsocks', t, { method, password });
          }
        } catch { /* ignore */ }
      }
    }

    // ShadowTLS — формат: shadowtls://password@server:port?sni=www.apple.com&version=3#name
    if (scheme === 'shadowtls' || scheme === 'shadow-tls') {
      try {
        const u = new URL(t.replace(/^shadowtls:\/\//i, 'http://'));
        const name = u.hash ? safeDecode(u.hash.slice(1)) : u.hostname;
        const params = new URLSearchParams(u.search);
        const ver = Number(params.get('version') || params.get('v') || '3');
        return makeNode(name, u.hostname, Number(u.port) || 443, 'shadowtls', t, {
          password: decodeURIComponent(u.username) || undefined,
          sni: params.get('sni') || params.get('host') || undefined,
          fingerprint: params.get('fp') || params.get('fingerprint') || undefined,
          version: ver >= 1 && ver <= 3 ? ver : 3,
        });
      } catch { /* ignore */ }
    }

    // Hysteria2
    if (scheme === 'hysteria2' || scheme === 'hy2') {
      try {
        const u = new URL(t.replace(/^(hysteria2|hy2):\/\//i, 'http://'));
        const name = u.hash ? safeDecode(u.hash.slice(1)) : u.hostname;
        const params = new URLSearchParams(u.search);
        return makeNode(name, u.hostname, Number(u.port) || 443, 'hysteria2', t, {
          password: decodeURIComponent(u.username) || undefined,
          sni: params.get('sni') || params.get('peer') || undefined,
          obfs: params.get('obfs') ? `${params.get('obfs')}:${params.get('obfs-password') || ''}` : undefined,
          fingerprint: params.get('insecure') === '1' ? 'skip-cert-verify' : undefined,
        });
      } catch { /* ignore */ }
    }

    // hysteria:// — could be v1 OR hysteria2 with wrong scheme (remna does this).
    // Remna publishes hysteria2 nodes as hysteria:// with UUID auth (userinfo OR ?auth= param).
    // Genuine v1 uses speed params (upmbps/downmbps) or non-UUID auth strings.
    if (scheme === 'hysteria') {
      try {
        const u = new URL(t.replace(/^hysteria:\/\//i, 'http://'));
        const name = u.hash ? safeDecode(u.hash.slice(1)) : u.hostname;
        const params = new URLSearchParams(u.search);
        const insecure = params.get('insecure') === '1' || params.get('allowInsecure') === '1'
                      || params.get('skip-cert-verify') === '1';

        // Collect auth string from wherever it appears
        const authStr = decodeURIComponent(u.username)
          || params.get('auth') || params.get('auth_str') || params.get('auth-str') || '';

        // UUID auth = remna hysteria2 node published under wrong scheme
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(authStr);

        if (isUuid) {
          return makeNode(name, u.hostname, Number(u.port) || 443, 'hysteria2', t, {
            password: authStr || undefined,
            sni: params.get('sni') || params.get('peer') || undefined,
            obfs: params.get('obfs') ? `${params.get('obfs')}:${params.get('obfs-password') || ''}` : undefined,
            allowInsecure: true,  // remna uses self-signed certs
            alpn: params.get('alpn') || undefined,
          });
        }
        // Genuine hysteria v1
        return makeNode(name, u.hostname, Number(u.port) || 443, 'hysteria', t, {
          password: authStr || undefined,
          obfs: params.get('obfs') || undefined,
          sni: params.get('peer') || params.get('sni') || undefined,
          alpn: params.get('alpn') || undefined,
          allowInsecure: insecure || undefined,
        });
      } catch { /* ignore */ }
    }

    // TUIC (v4 and v5)
    if (scheme === 'tuic') {
      try {
        const u = new URL(t.replace(/^tuic:\/\//i, 'http://'));
        const name = u.hash ? safeDecode(u.hash.slice(1)) : u.hostname;
        const params = new URLSearchParams(u.search);
        return makeNode(name, u.hostname, Number(u.port) || 443, 'tuic', t, {
          uuid: decodeURIComponent(u.username) || undefined,
          password: u.password ? decodeURIComponent(u.password) : undefined,
          sni: params.get('sni') || undefined,
          security: 'tls',
        });
      } catch { /* ignore */ }
    }

    // WireGuard
    if (scheme === 'wireguard' || scheme === 'wg') {
      try {
        const u = new URL(t.replace(/^(wireguard|wg):\/\//i, 'http://'));
        const name = u.hash ? safeDecode(u.hash.slice(1)) : u.hostname;
        const params = new URLSearchParams(u.search);
        return makeNode(name, u.hostname, Number(u.port) || 51820, 'wireguard', t, {
          privateKey: decodeURIComponent(u.username) || undefined,
          publicKey: params.get('publickey') || params.get('public_key') || undefined,
          preSharedKey: params.get('presharedkey') || undefined,
          localAddress: params.get('address') || params.get('ip') || undefined,
          mtu: params.get('mtu') || undefined,
        });
      } catch { /* ignore */ }
    }

    // Generic URL-based protocols (VLESS, Trojan, SOCKS5, HTTP, XHTTP, etc.)
    try {
      const safeUrl = t.replace(new RegExp(`^${scheme}://`, 'i'), 'http://');
      const u = new URL(safeUrl);
      const name = u.hash ? safeDecode(u.hash.slice(1)) : u.hostname;
      const params = new URLSearchParams(u.search);

      const uuid = u.username ? decodeURIComponent(u.username) : undefined;
      const password = u.password ? decodeURIComponent(u.password) : uuid;

      return makeNode(name, u.hostname, Number(u.port) || 443, proto, t, {
        uuid,
        password,
        security: params.get('security') || params.get('encryption') || undefined,
        transport: params.get('type') || params.get('net') || undefined,
        headerType: params.get('headerType') || undefined,
        sni: params.get('sni') || params.get('host') || params.get('peer') || undefined,
        path: params.get('path') || params.get('serviceName') || params.get('servicename') || undefined,
        host: params.get('host') || undefined,
        alpn: params.get('alpn') || undefined,
        allowInsecure: params.get('allowInsecure') === '1' || params.get('insecure') === '1' || undefined,
        publicKey: params.get('pbk') || params.get('public-key') || undefined,
        shortId: params.get('sid') || params.get('short-id') || undefined,
        flow: params.get('flow') || undefined,
        fingerprint: params.get('fp') || params.get('fingerprint') || undefined,
      });
    } catch {
      const host = t.split('@').pop()?.split('#')[0].split(':')[0];
      if (host) return makeNode(scheme.toUpperCase(), host, 443, proto, t);
    }
  } catch { /* ignore */ }
  return null;
}

// ── Panel detection ──────────────────────────────────────────────────────────
export function detectPanelType(url: string, headers?: Record<string, string>): PanelType {
  const h: Record<string, string> = {};
  if (headers) Object.entries(headers).forEach(([k, v]) => { h[k.toLowerCase()] = v; });

  // Hiddify: unique header
  if (h['hiddify-app-info'] || h['hiddify-client-id']) return 'hiddify';

  const urlLow = (url || '').toLowerCase();
  const powered = (h['x-powered-by'] || '').toLowerCase();
  const server = (h['server'] || '').toLowerCase();

  // Remnawave
  if (urlLow.includes('remnawave') || urlLow.includes('remna') || powered.includes('remnawave') || server.includes('remnawave')) return 'remnawave';

  // 3X-UI / SanaeiPanel: subscription-userinfo present, no profile-title (OR content-disposition with .txt)
  const hasUserInfo = !!(h['subscription-userinfo']);
  const hasProfileTitle = !!(h['profile-title']);
  const hasCD = !!(h['content-disposition']);

  if (hasCD && (h['content-disposition'].includes('.txt') || h['content-disposition'].includes('attachment'))) {
    return '3x-ui';
  }
  if (hasUserInfo && !hasProfileTitle) return '3x-ui';

  // Marzban / Marzneshin: profile-title (possibly base64:) + userinfo or update-interval
  if (hasProfileTitle && (hasUserInfo || h['profile-update-interval'] || h['profile-web-page-url'])) {
    // Try to distinguish Marzban variants — all treated as marzban
    return 'marzban';
  }

  // Hiddify (fallback via URL pattern)
  if (urlLow.includes('hiddify') || urlLow.includes('/sub/') && urlLow.includes('hiddify')) return 'hiddify';

  // Generic XUI (URL pattern)
  if (urlLow.match(/\/(sub|subscription)\/[a-z0-9_-]{8,}/i)) return 'xui';

  // Only profile-title but no userinfo (Remnawave sometimes)
  if (hasProfileTitle) return 'unknown';

  return 'unknown';
}

// ── Name helpers ─────────────────────────────────────────────────────────────
export function decodeProfileTitle(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();

  // Explicit "base64:" prefix (Marzban, Hiddify)
  const b64prefix = trimmed.match(/^base64:(.+)$/i);
  if (b64prefix) {
    try {
      const dec = universalDecode(b64prefix[1].trim());
      if (dec && dec.length > 0 && dec.length <= 200 && !/[\x00-\x08\x0E-\x1F\x7F]/.test(dec)) {
        return dec.trim();
      }
    } catch { /* ignore */ }
    return b64prefix[1].trim();
  }

  // URL-encoded
  if (trimmed.includes('%')) {
    try { return decodeURIComponent(trimmed); } catch { /* ignore */ }
  }

  // Plain base64 (Hiddify / Remnawave)
  try {
    const decoded = universalDecode(trimmed);
    if (decoded && decoded !== trimmed && decoded.length > 0 && decoded.length <= 200) {
      if (!/[\x00-\x08\x0E-\x1F\x7F]/.test(decoded) && decoded.trim().length > 0) {
        return decoded.trim();
      }
    }
  } catch { /* ignore */ }
  return trimmed;
}

function parseContentDispositionName(header: string): string | undefined {
  const m = header.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
  if (!m) return undefined;
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')).replace(/\.[^.]+$/, '').trim(); }
  catch { return m[1].trim(); }
}

export function guessSubscriptionName(url: string): string {
  if (!url) return 'VPN';
  if (!url.includes('://') && !url.includes('.')) {
    return decodeProfileTitle(url) || 'VPN';
  }
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(s => s.length > 0);
    const skipWords = new Set([
      'sub', 'api', 'v1', 'v2', 'v3', 'v4', 'subscription', 'link', 'clash',
      'sing-box', 'json', 'shadowsocks', 'base64', 'info', 'get', 'user', 'config',
      'xray', 'hiddify', 'mihomo', 'raw', 'download', 'profile',
    ]);
    for (const seg of [...segments].reverse()) {
      if (
        seg.length >= 3 &&
        seg.length <= 40 &&
        !skipWords.has(seg.toLowerCase()) &&
        !seg.match(/^[0-9a-f]{8}-[0-9a-f]{4}/i) &&
        !seg.match(/^[0-9a-f]{16,}$/i) &&
        !seg.match(/^[A-Za-z0-9]{20,}$/) &&
        !(seg.length > 10 && /\d/.test(seg) && /^[A-Za-z0-9]+$/.test(seg))
      ) {
        try { return decodeURIComponent(seg).replace(/[-_]/g, ' ').trim(); }
        catch { return seg; }
      }
    }
    return u.hostname.replace(/^(www|sub|api|x|vpn|proxy|panel|cdn)\./i, '') || 'VPN';
  } catch { return 'VPN'; }
}

// ── Parse Hiddify/generic body comments (#key: value) ────────────────────────
function parseBodyComments(raw: string): {
  name?: string; userInfo?: string; updateInterval?: number;
  supportUrl?: string; webPage?: string;
} {
  const result: { name?: string; userInfo?: string; updateInterval?: number; supportUrl?: string; webPage?: string } = {};
  const lines = raw.split('\n').slice(0, 30); // Only check first 30 lines
  for (const line of lines) {
    const m = line.match(/^#\s*([a-z0-9_-]+):\s*(.+)/i);
    if (!m) continue;
    const [, key, val] = m;
    const k = key.toLowerCase().replace(/-/g, '_');
    if (k === 'profile_title') result.name = decodeProfileTitle(val.trim());
    else if (k === 'subscription_userinfo') result.userInfo = val.trim();
    else if (k === 'profile_update_interval') result.updateInterval = parseInt(val) || undefined;
    else if (k === 'support_url') result.supportUrl = val.trim();
    else if (k === 'profile_web_page_url') result.webPage = val.trim();
  }
  return result;
}

// ── Main subscription parser ──────────────────────────────────────────────────
export function parseSubscription(
  content: string,
  userInfoHeader?: string,
  headers?: Record<string, string>,
): SubscriptionParseResult {
  const nodes: ServerNode[] = [];
  let subName: string | undefined;
  let raw = content.trim();

  // 1. Try base64 decode of entire body
  console.log('[SIM-SUB] len=' + raw.length + ' start=' + raw.substring(0, 30).replace(/\n/g, '\\n'));
  const decoded = universalDecode(raw);
  if (decoded && decoded !== raw && (decoded.includes('://') || decoded.startsWith('{') || decoded.includes('proxies:'))) {
    raw = decoded;
  }

  // 2. Parse body comment metadata (Hiddify, generic)
  const bodyMeta = parseBodyComments(raw);
  if (bodyMeta.name) subName = bodyMeta.name;

  // 3. Try JSON
  let jsonParsed = false;
  try {
    const json = JSON.parse(raw);
    jsonParsed = true;

    if (Array.isArray(json)) {
      // Array of proxy objects or full configs (Remnawave sends arrays of full configs)
      for (const item of json) {
        if (isFullConfig(item)) {
          const extracted = extractNodesFromFullConfig(item);
          for (const n of extracted) nodes.push(n);
          if (!subName && (item.remarks || item.name)) subName = item.remarks || item.name;
        } else {
          const node = parseLink(item);
          if (node) nodes.push(node);
        }
      }
    } else if (json && typeof json === 'object') {
      if (isFullConfig(json)) {
        // Full Xray/sing-box config — extract individual nodes
        const extracted = extractNodesFromFullConfig(json);
        for (const n of extracted) nodes.push(n);
        if (!subName && (json.remarks || json.name)) subName = json.remarks || json.name;
      } else {
        // Clash-like JSON with proxies/nodes array, or single proxy object
        const list = json.proxies || json.nodes || [json];
        for (const item of list) {
          const node = parseLink(item);
          if (node) nodes.push(node);
        }
      }
    }
  } catch { /* not JSON */ }

  // 4. Clash YAML
  if (!jsonParsed && raw.includes('proxies:')) {
    const clashNodes = parseClashYaml(raw);
    for (const n of clashNodes) nodes.push(n);
    // Extract name from YAML comments or 'profile-title' field
    const yamlName = raw.match(/^profile:\s*(.+)/im)?.[1]?.trim();
    if (yamlName && !subName) subName = yamlName;
  }

  // 5. Extract proxy links via regex (handles mixed content / newline-separated links)
  if (nodes.length === 0) {
    const linkRegex = /(?:vless|vmess|trojan|ss|shadowsocks|shadowtls|hysteria2?|hy2|tuic|wireguard|wg|socks5?|http|xhttp|anytls):\/\/[^\s"'`<>\r\n]+/gi;
    const matches = raw.match(linkRegex) || [];
    for (const link of matches) {
      const node = parseLink(link);
      if (node) nodes.push(node);
    }
  }

  // ── Parse response headers ────────────────────────────────────────────────
  const h: Record<string, string> = {};
  if (headers) Object.entries(headers).forEach(([k, v]) => { h[k.toLowerCase()] = v; });

  // Name from headers (wins over body title)
  const rawTitle = h['profile-title'];
  if (rawTitle) {
    const decoded2 = decodeProfileTitle(rawTitle);
    if (decoded2) subName = decoded2;
  }

  // Content-Disposition fallback for 3X-UI
  const cd = h['content-disposition'];
  if (cd && !subName) {
    const cdName = parseContentDispositionName(cd);
    if (cdName) subName = cdName;
  }

  // Hiddify app info
  const hiddifyInfo = h['hiddify-app-info'];
  if (hiddifyInfo && !subName) {
    // Format: "name=Panel Name;version=2.0.0" or JSON
    try {
      const info = JSON.parse(hiddifyInfo);
      if (info.name && !subName) subName = info.name;
    } catch {
      const nm = hiddifyInfo.match(/(?:^|[;,]\s*)name\s*=\s*([^;,\n]+)/i)?.[1]?.trim();
      if (nm && !subName) subName = nm;
    }
  }

  // Traffic
  const uiRaw = h['subscription-userinfo'] || bodyMeta.userInfo || userInfoHeader;
  const traffic = uiRaw ? parseUserInfo(uiRaw) : undefined;

  // Meta
  const updateIntervalRaw = h['profile-update-interval'];
  const updateInterval = updateIntervalRaw
    ? (parseInt(updateIntervalRaw) || undefined)
    : bodyMeta.updateInterval;

  const webPage = h['profile-web-page-url'] || bodyMeta.webPage || undefined;
  const supportUrl = h['support-url'] || bodyMeta.supportUrl || undefined;

  // Deduplicate by ID (handles duplicate configs in subscription)
  const seenIds = new Set<string>();
  const uniqueNodes = nodes.filter(n => { if (seenIds.has(n.id)) return false; seenIds.add(n.id); return true; });

  return { nodes: uniqueNodes, name: subName, traffic, updateInterval, webPage, supportUrl };
}

export function parseUserInfo(header: string): SubscriptionTraffic {
  const res: SubscriptionTraffic = { upload: 0, download: 0, total: 0 };
  header.split(';').forEach(p => {
    const eq = p.indexOf('=');
    if (eq < 0) return;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    const n = Number(v);
    if (k === 'u' || k === 'upload') res.upload = n || 0;
    else if (k === 'd' || k === 'download') res.download = n || 0;
    else if (k === 'total') res.total = n || 0;
    else if (k === 'expire') res.expire = isNaN(n) ? 0 : Math.floor(n);
  });
  if (res.total > 0) {
    res.usagePercentage = ((res.upload + res.download) / res.total) * 100;
    if (res.expire != null) {
      const days = Math.ceil((res.expire * 1000 - Date.now()) / 86400000);
      res.remainingDays = Math.max(0, days);
    }
  }
  return res;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const SIZES = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(SIZES.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + SIZES[i];
}

export interface SubscriptionParseResult {
  nodes: ServerNode[];
  name?: string;
  traffic?: SubscriptionTraffic;
  routing?: RoutingProfile;
  notices?: string[];
  webPage?: string;
  updateInterval?: number;
  supportUrl?: string;
  panelType?: PanelType;
}

export function parseRoutingJson(json: any): RoutingProfile | undefined { return json as RoutingProfile; }

// Нормализует ссылку подписки из deep link: снимает percent-кодирование и
// возможную base64-обёртку (Happ часто кодирует URL). Возвращает http(s)-URL
// либо null, если это не ссылка подписки.
function normalizeSubUrl(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (s.includes('%')) { try { s = decodeURIComponent(s); } catch { /* keep as is */ } }
  if (!/^https?:\/\//i.test(s)) {
    try {
      const dec = universalDecode(s).trim();
      if (/^https?:\/\//i.test(dec)) s = dec;
    } catch { /* не base64 */ }
  }
  return /^https?:\/\//i.test(s) ? s : null;
}

export function parseSimUrl(url: string): any {
  if (!url) return null;
  const decodedUrl = url.trim();

  // Поддержка обеих схем: sim:// и happ://
  if (!decodedUrl.toLowerCase().startsWith('sim://') && !decodedUrl.toLowerCase().startsWith('happ://')) {
    return null;
  }

  try {
    // Удаляем префикс схемы
    const path = decodedUrl.substring(decodedUrl.indexOf('://') + 3);

    // 0. Быстрые действия через App Shortcuts / Google Assistant
    if (path === 'vpn/on') return { type: 'vpn_on' };
    if (path === 'vpn/off') return { type: 'vpn_off' };

    // 1. Импорт: sim://import/<...>. ВАЖНО: подписку (http/https) проверяем
    // ПЕРВОЙ — иначе parseLink ловит любую ссылку с "://" своим общим
    // обработчиком и возвращает фиктивный одиночный узел с протоколом "https".
    if (path.startsWith('import/')) {
      const link = path.substring(7);
      const sub = normalizeSubUrl(link);
      if (sub) return { type: 'subscribe', url: sub };
      const node = parseLink(link);
      if (node) {
        return { type: 'import', nodes: [node] };
      }
    }

    // 1b. Подписка: sim://add/<url>, sim://subscribe/<url>, happ://add/<url>
    if (path.startsWith('add/') || path.startsWith('subscribe/')) {
      const sub = normalizeSubUrl(path.substring(path.indexOf('/') + 1));
      if (sub) return { type: 'subscribe', url: sub };
    }

    // 2. Добавление профиля маршрутизации: sim://routing/add/JSON_BASE64
    if (path.startsWith('routing/add/')) {
      const base64Data = path.substring(12);
      try {
        const jsonStr = universalDecode(base64Data);
        const profile = JSON.parse(jsonStr);
        if (profile && profile.Name) {
          return { type: 'routing_add', profile: profile, activate: true };
        }
      } catch (e) {
        console.error("Failed to parse routing JSON from URL", e);
      }
    }

    // 3. Подписка в любом другом виде: sim://https://sub..., sim://<urlencoded>,
    // sim://<base64-of-url>. Проверяем ДО direct-парсинга, иначе общий обработчик
    // parseLink снова поймает http-ссылку как фиктивный узел.
    const subAny = normalizeSubUrl(path);
    if (subAny) return { type: 'subscribe', url: subAny };

    // 4. Прямой импорт одиночной ссылки-конфига (как в v2rayNG)
    const node = parseLink(decodedUrl);
    if (node) {
       return { type: 'import', nodes: [node] };
    }
  } catch (e) {
    console.error("Error parsing Sim/Happ URL:", e);
  }

  return null;
}
