/**
 * Фоновый failover: запасные конфиги для нативной стороны.
 *
 * Пока приложение открыто, падение сервера ловит JS-цикл проверок (utils/failover.ts).
 * Когда приложение закрыто — WebView заморожен, этот цикл не работает, и нативная
 * сторона (VpnServiceImpl.tryRecoverTunnel) при недоступном сервере только ждала
 * выздоровления: «Сервер недоступен — ждём восстановления…» бесконечно. Теперь при
 * подключении JS отдаёт нативке упорядоченный список запасных серверов с готовыми
 * конфигами: нативка сама проверяет их TCP-доступность (прямое соединение мимо VPN —
 * uid приложения вне tun) и при недоступности текущего переключается сама, без
 * участия WebView — с выключенным экраном и убитым процессом UI.
 *
 * Порядок кандидатов — тот же planFailover, что и в открытом приложении: приоритетные
 * (обход DPI) серверы, затем известный небольшой пинг, потом остальные; недавно
 * упавшие (nodeCooldown) и готовые балансировщики исключаются.
 *
 * Каждая запись несёт явный `endpoint` («addr:port»), чтобы нативка не парсила
 * разные форматы конфигов (Xray-JSON, mihomo-JSON) — она проверяет адрес, указанный
 * здесь, и пропускает недоступные кандидаты, не трогая очередь.
 */
import type { RoutingProfile, ServerNode } from '../types';
import { isProtocolSupportedByCore } from './bridge';
import { shouldUseMihomo } from './mihomoConfig';
import { buildNodeConfig, resolveCore } from './nodeConfig';
import { isPriorityNode, planFailover } from '../utils/failover';

export interface FallbackEntry {
  id: string;
  name: string;
  /** «addr:port» — нативка проверяет доступность этого адреса напрямую, минуя VPN. */
  endpoint: string;
  config: string;
  settings: string;
}

export interface BuildFallbacksOptions {
  current: ServerNode;
  nodes: ServerNode[];
  /** id → когда сервер упал (мс); недавно упавшие не даём запасными. */
  failedAt: Record<string, number>;
  /** Настройки подключения текущего запуска (уже с applyAttempt) — общий базис конфигов. */
  settings: Record<string, unknown>;
  /** Роутинг профиля, которому принадлежит текущий узел. */
  routingProfile?: RoutingProfile;
  /** altPorts конкретного узла (хранилище `sim-altports-addr:port`). */
  altPortsOf: (n: ServerNode) => string;
  /** Кэшированный пинг сервера, мс; ≤ 0 — неизвестен. */
  cachedPing: (id: string) => number;
  now?: number;
  limit?: number;
}

/**
 * Нода, для которой можно собрать самостоятельный конфиг запасного сервера.
 * YAML-блоки и полные JSON-конфиги пользователей buildNodeConfig понимает так же,
 * как основной путь, — несборными остаются только протоколы, которых не умеет
 * ни одно ядро (там конфиг не собрать вообще).
 */
function isBuildableFallback(n: ServerNode): boolean {
  return shouldUseMihomo(n.protocol) || isProtocolSupportedByCore(n.protocol);
}

/** JSON-массив запасных серверов для nativeStartVpnWithResult; '' — нечего передавать. */
export function buildFallbacks(o: BuildFallbacksOptions): string {
  try {
    const buildable = o.nodes.filter(isBuildableFallback);
    const candidates = planFailover({
      current: o.current,
      nodes: buildable,
      failedAt: o.failedAt,
      cachedPing: o.cachedPing,
      now: o.now ?? Date.now(),
      limit: o.limit ?? 3,
      isPriority: isPriorityNode,
    });
    if (candidates.length === 0) return '';
    const out: FallbackEntry[] = [];
    for (const n of candidates) {
      try {
        // Конфиг — тем же кодом, что и основное подключение (nodeConfig.ts).
        const config = buildNodeConfig(n, o.settings, o.routingProfile);
        // Настройки текущего запуска с полями узла, которые должны указывать на
        // запасного: ядро, имя (уведомление), адрес (диагностика) и id (ссылка UI).
        const settings = {
          ...o.settings,
          core: resolveCore(n),
          nodeProtocol: n.protocol,
          nodeName: n.name,
          nodeFlag: n.flag || '',
          serverAddress: n.address,
          nodeId: n.id,
          altPorts: o.altPortsOf(n),
        };
        out.push({
          id: n.id,
          name: n.name,
          endpoint: `${n.address}:${n.port}`,
          config,
          settings: JSON.stringify(settings),
        });
      } catch {
        /* узел не собрался — список просто станет короче */
      }
    }
    return out.length > 0 ? JSON.stringify(out) : '';
  } catch {
    return '';
  }
}
