/**
 * Как показывать подписки и серверы с учётом параметров провайдера (Happ, см. appManagement.ts):
 * закрепление подписки, порядок серверов, подпись под именем сервера и скрытие технических деталей.
 * Чистые функции — без обращения к хранилищу и нативному мосту.
 */
import type { ServerNode, SubscriptionProfile } from '../types';

type WithManaged = Pick<SubscriptionProfile, 'managed'>;

/** subscription-pin: закреплённые подписки идут первыми, остальной порядок сохраняется. */
export function orderProfiles<T extends WithManaged>(profiles: T[]): T[] {
  const pinned = profiles.filter((p) => p.managed?.pinned === true);
  return pinned.length === 0 || pinned.length === profiles.length ? profiles : [...pinned, ...profiles.filter((p) => p.managed?.pinned !== true)];
}

/**
 * subscriptions-sort-type: without — как отдал провайдер, ping — по задержке (без замера в конец),
 * alphabet — по названию. Исходный массив не меняется.
 */
export function sortNodes(nodes: ServerNode[], sortType: 'without' | 'ping' | 'alphabet' | undefined, pingOf: (n: ServerNode) => number | undefined): ServerNode[] {
  if (sortType === 'alphabet') return [...nodes].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
  if (sortType === 'ping') {
    const key = (n: ServerNode) => { const p = pingOf(n); return typeof p === 'number' && p > 0 ? p : Number.POSITIVE_INFINITY; };
    return [...nodes].sort((a, b) => key(a) - key(b));
  }
  return nodes;
}

/**
 * subscription-autoconnect-type: какой сервер выбрать при автоподключении при запуске.
 * lastused — тот, что выбран сейчас; random — случайный из подписки; lowestdelay — с лучшим из уже
 * известных замеров (замеров нет — остаётся текущий).
 */
export function pickAutoConnectNode(
  type: string, nodes: ServerNode[], current: ServerNode,
  pingOf: (n: ServerNode) => number | undefined, random: () => number = Math.random,
): ServerNode {
  if (nodes.length === 0) return current;
  if (type === 'random') return nodes[Math.min(nodes.length - 1, Math.floor(random() * nodes.length))];
  if (type === 'lowestdelay') {
    const measured = nodes.filter((n) => (pingOf(n) ?? 0) > 0);
    if (measured.length === 0) return current;
    return measured.reduce((best, n) => ((pingOf(n) as number) < (pingOf(best) as number) ? n : best));
  }
  return current;
}

/**
 * hide-settings: провайдер запретил показывать конфигурацию серверов. Как у Happ, подпись с протоколом
 * (или описанием от провайдера) остаётся, а адрес, защита и транспорт сервера не показываются.
 */
export function settingsHidden(p: WithManaged | undefined | null): boolean {
  return p?.managed?.hideSettings === true;
}
