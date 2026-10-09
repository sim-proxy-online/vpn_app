/**
 * Применяет к устройству то, что провайдер подписки попросил через параметры управления (Happ) и что уже
 * прошло проверку и проверку доверия в appManagement.ts: приложения в обход/через VPN (per-app-proxy-*)
 * и подсети мимо туннеля (exclude-routes*). Планы лежат в localStorage под sim-managed-* (их записывает
 * applyManagement/trustProfile); здесь они один раз превращаются в действия моста.
 *
 * Идемпотентно: подпись уже применённых планов хранится в sim-managed-native-applied, повторные вызовы
 * ничего не делают. Приложения применяются при следующем подключении (VPN-интерфейс собирается при запуске).
 */
import {
  isNative, nativeAddRoutingRule, nativeGetRoutingRules, nativeGetSplitTunnelApps, nativeRemoveRoutingRule,
  nativeSetSplitTunnelApp, nativeUpdateRoutingRule, syncXrayRoutingRulesCache, type RoutingRule,
} from '../native/bridge';
import type { ExcludePlan, PerAppPlan } from './managedLists';

export const PER_APP_KEY = 'sim-managed-per-app';
export const EXCLUDE_KEY = 'sim-managed-exclude-routes';
const APPLIED_KEY = 'sim-managed-native-applied';
/** Идентификатор правила маршрутизации, которым приложение держит исключения от провайдера. */
export const MANAGED_RULE_ID = 'managed-exclude-routes';

/** Значение, записанное как JSON-строка с JSON внутри (applyManagement пишет любые значения через JSON.stringify). */
function readPlan<T>(key: string): T | null {
  try {
    const outer = localStorage.getItem(key);
    if (!outer) return null;
    const inner = JSON.parse(outer);
    return typeof inner === 'string' ? (JSON.parse(inner) as T) : null;
  } catch { return null; }
}

async function applyPerApp(plan: PerAppPlan): Promise<void> {
  const apps = await nativeGetSplitTunnelApps();
  const installed = new Set(apps.map((a) => a.id));
  const target = plan.mode === 'on' ? 'always' : 'never';
  const wanted = plan.list.filter((id) => installed.has(id));
  if (plan.replace) {
    for (const a of apps) if (a.mode === target && !wanted.includes(a.id)) await nativeSetSplitTunnelApp(a.id, 'smart');
  }
  // Пустой «белый список» оставил бы VPN без единого приложения — не создаём его.
  if (plan.mode === 'on' && wanted.length === 0) return;
  for (const id of wanted) await nativeSetSplitTunnelApp(id, target);
}

async function applyExclude(plan: ExcludePlan): Promise<void> {
  const rules = await nativeGetRoutingRules();
  const existing = rules.find((r) => r.id === MANAGED_RULE_ID);
  const prev = existing ? existing.pattern.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const list = plan.replace ? plan.list : Array.from(new Set([...prev, ...plan.list]));
  if (list.length === 0) {
    if (existing) await nativeRemoveRoutingRule(MANAGED_RULE_ID);
  } else {
    const rule: RoutingRule = {
      id: MANAGED_RULE_ID, type: 'ip', pattern: list.join(','), action: 'direct',
      description: 'Исключения маршрутов от провайдера подписки', enabled: true, createdAt: existing?.createdAt ?? Date.now(),
    };
    if (existing) await nativeUpdateRoutingRule(rule); else await nativeAddRoutingRule(rule);
  }
  await syncXrayRoutingRulesCache();
}

/** Применяет ожидающие планы, если они изменились с прошлого раза. Ошибки не пробрасываются: повтор будет при следующем вызове. */
export async function applyManagedNative(): Promise<void> {
  if (!isNative()) return;
  let perAppRaw = '', excludeRaw = '';
  try { perAppRaw = localStorage.getItem(PER_APP_KEY) ?? ''; excludeRaw = localStorage.getItem(EXCLUDE_KEY) ?? ''; } catch { return; }
  if (!perAppRaw && !excludeRaw) return;
  const signature = `${perAppRaw}|${excludeRaw}`;
  try {
    if (localStorage.getItem(APPLIED_KEY) === signature) return;
    const perApp = readPlan<PerAppPlan>(PER_APP_KEY);
    const exclude = readPlan<ExcludePlan>(EXCLUDE_KEY);
    if (perApp) await applyPerApp(perApp);
    if (exclude) await applyExclude(exclude);
    localStorage.setItem(APPLIED_KEY, signature);
  } catch (e) {
    console.warn('[managed] не удалось применить настройки провайдера:', e);
  }
}
