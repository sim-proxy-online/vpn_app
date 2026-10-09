import { describe, expect, it } from 'vitest';
import { buildFallbacks, type BuildFallbacksOptions, type FallbackEntry } from './failover';
import type { ServerNode } from '../types';

const node = (id: string, over: Partial<ServerNode> = {}): ServerNode => ({
  id,
  name: id,
  address: `${id}.example.net`,
  port: 443,
  protocol: 'vless',
  remark: '',
  rawLink: `vless://uuid@${id}.example.net:443#ref`,
  uuid: 'uuid',
  ...over,
} as ServerNode);

const opts = (
  current: ServerNode,
  nodes: ServerNode[],
  over: Partial<BuildFallbacksOptions> = {},
): BuildFallbacksOptions => ({
  current,
  nodes,
  failedAt: {},
  settings: { socksPort: 10808 },
  altPortsOf: () => '',
  cachedPing: () => -1,
  ...over,
});

const entries = (o: BuildFallbacksOptions): FallbackEntry[] => {
  const json = buildFallbacks(o);
  return json ? (JSON.parse(json) as FallbackEntry[]) : [];
};

describe('buildFallbacks (фоновый failover)', () => {
  const cur = node('cur');

  it('нечего передавать: только текущий узел — пустая строка', () => {
    expect(buildFallbacks(opts(cur, [cur]))).toBe('');
  });

  it('исключает текущий узел, готовые балансировщики и протоколы без ядра; YAML-блоки и JSON-конфиги — собирает', () => {
    const out = entries(opts(cur, [
      cur,                                     // текущий — не запасной
      node('balancer', { protocol: 'json' }),  // балансировщик переключается сам (planFailover)
      node('yaml', { rawLink: 'proxies:\n- name: x\n  type: vless' }),
      node('rawjson', { rawLink: '{"outbounds":[]}' }),
      node('mtproto', { protocol: 'mtproto' as ServerNode['protocol'] }), // не умеет ни одно ядро
      node('ok'),
    ]));
    expect(out.map(e => e.id)).toEqual(['yaml', 'rawjson', 'ok']);
  });

  it('не даёт запасным сервер, который только что упал (nodeCooldown)', () => {
    const now = 1_000_000_000_000;
    const out = entries(opts(cur, [node('recently-failed'), node('healthy')], {
      failedAt: { 'recently-failed': now - 60_000 }, // минуту назад — ещё в кулдауне
      now,
    }));
    expect(out.map(e => e.id)).toEqual(['healthy']);
  });

  it('приоритетные (обход DPI) серверы идут первыми, затем известный небольшой пинг', () => {
    const out = entries(opts(cur, [
      node('slow-known', { name: 'NL slow' }),
      node('dpi-first', { name: '4G обход' }),
      node('fast', { name: 'DE fast' }),
      node('unknown-ping', { name: 'US ?' }),
    ], { cachedPing: (id) => (id === 'slow-known' ? 200 : id === 'fast' ? 900 : -1), limit: 4 }));
    expect(out.map(e => e.id)).toEqual(['dpi-first', 'slow-known', 'fast', 'unknown-ping']);
  });

  it('кладёт явный endpoint и пер-узловые настройки (ядро, имя, id, altPorts)', () => {
    const [e] = entries(opts(cur, [node('b', { name: 'Backup', flag: '🇩🇪' })], {
      settings: { socksPort: 10808, nodeName: 'Cur', nodeId: 'cur', altPorts: 'cur-ports' },
      altPortsOf: (n) => `${n.id}-ports`,
    }));
    expect(e.id).toBe('b');
    expect(e.name).toBe('Backup');
    expect(e.endpoint).toBe('b.example.net:443');
    const st = JSON.parse(e.settings);
    expect(st.core).toBe('xray');
    expect(st.nodeName).toBe('Backup');
    expect(st.nodeFlag).toBe('🇩🇪');
    expect(st.serverAddress).toBe('b.example.net');
    expect(st.nodeId).toBe('b');   // UI сверяет выбор по этому id
    expect(st.altPorts).toBe('b-ports'); // а не altPorts текущего узла
    expect(st.socksPort).toBe(10808);    // общие настройки сохранены
    // Конфиг — валидный Xray-JSON, который нативка запустит после рестарта процесса.
    expect(JSON.parse(e.config).outbounds.length).toBeGreaterThan(0);
  });

  it('узел на mihomo получает ядро mihomo и его конфиг', () => {
    const [e] = entries(opts(cur, [node('hy', { protocol: 'hysteria2', rawLink: 'hysteria2://pw@hy.example.net:443', password: 'pw' })]));
    expect(JSON.parse(e.settings).core).toBe('mihomo');
    expect(JSON.parse(e.config).proxies.length).toBeGreaterThan(0);
  });

  it('лимит кандидатов по умолчанию — 3 (проверка каждого стоит до 4с на нативной стороне)', () => {
    const out = entries(opts(cur, [node('a'), node('b'), node('c'), node('d')]));
    expect(out).toHaveLength(3);
    expect(out.map(e => e.id)).toEqual(['a', 'b', 'c']);
  });
});
