import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import HomeScreen from './components/HomeScreen';
import HomeProfilePanel from './components/HomeProfilePanel';
import ServerList from './components/ServerList';
import ProfilesScreen from './components/ProfilesScreen';
import SettingsScreen from './components/SettingsScreen';
import DashboardScreen from './components/DashboardScreen';

import DnsSettingsScreen from './components/DnsSettingsScreen';
import DebugScreen from './components/DebugScreen';
import Onboarding from './components/Onboarding';
import BatteryPermSheet from './components/BatteryPermSheet';
import UpdatePrompt from './components/UpdatePrompt';
import { ErrorBoundary } from './components/ErrorBoundary';
import DeepLinkConfirm, { type DeepLinkAction } from './components/DeepLinkConfirm';
import { DesktopSidebar, MobileNav } from './components/BottomNav';
import { AppScreen, ConnectionState, ServerNode, SubscriptionProfile, RoutingProfile } from './types';
import { generateId, parseSubscription, parseSimUrl, detectPanelType, decodeProfileTitle, guessSubscriptionName, parseLink } from './data';

import { useTheme } from './ThemeContext';
import { buildFallbacks } from './native/failover';
import { buildNodeConfig, resolveCore } from './native/nodeConfig';
import { runIspDetection } from './utils/ispPreset';
import { applyManagement, expiryNotice, refreshExpiry, statusFromTraffic, userAgentFor } from './utils/appManagement';
import {
  clearRenewalPending, fetchPaymentStatus, fetchSubscriptionUrl,
  loadRenewalPending, PENDING_TTL_MS,
} from './utils/cabinetApi';
import { applyManagedNative } from './utils/managedNative';
import { fetchSubscription, friendlyUpdateError } from './utils/subscriptionFetch';
import { pickAutoConnectNode, settingsHidden } from './utils/profileView';
import { currentOperatorProfile, refreshOperatorProfiles } from './utils/operatorProfiles';
import { DEFAULT_FAILOVER, cooldownPassed, deviceNetworkUp, failoverApplies, initialHealth, isBalancerNode, isFastFailoverEnabled, isPriorityNode, nextDelayMs, onProbe, planFailover, recordAction, restartAllowed } from './utils/failover';

import { ConnectVerifyError, applyAttempt, currentNetworkKey, describeAttempt, getPreferredStrategy, isAutoBypassEnabled, ladderApplies, planAttempts, recordSuccess, type BypassAttempt } from './utils/autoBypass';
import { nativeStopVpn, nativeNotify, nativeRequestVpnPermission, nativeFetchUrl, nativeFetchUrlViaProxy, isNative, nativeGetStats, nativeSetStatusBarStyle, nativeStartVpnWithResult, nativeToggleKillSwitch, nativeStartNetworkMonitoring, nativeStopNetworkMonitoring, nativeMinimizeApp, nativeVibrate, VpnStats, nativeGetRoutingRules, nativeRequestAllPermissions, nativeTestProxyDelay, nativeGetPendingDeepLink, nativeTestIpLeak, nativeTestDnsLeak, nativeGetCoreLoadError, nativeGetActiveNodeId, nativeIsShieldMode, buildShieldConfig, type FetchResult, nativeStartAntiFilterBatch, refreshAntiFilterCache, nativePingNode, startPingBatch, getBestCachedPing, nativeClearDnsCache } from './native/bridge';

function load<T>(key: string, fb: T): T { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fb; } catch { return fb; } }
// Кэши, которыми можно пожертвовать при переполнении localStorage: пинги и IP серверов
// пересчитываются, а подписки и настройки — нет.
const DISPOSABLE_CACHE_KEYS = ['sim-ping-result-cache-v2', 'sim-bypass-ping-cache-v4', 'sim-server-ip-cache'];
let storageWarned = false;
// Раньше ошибка записи (QuotaExceededError) глоталась молча, и подписки пропадали после
// перезапуска без единого сообщения. Теперь: освобождаем кэши и пробуем ещё раз, а если
// не вышло — один раз за сессию сообщаем пользователю.
function save(key: string, v: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(v)); return true; }
  catch (e) {
    try {
      DISPOSABLE_CACHE_KEYS.forEach(k => localStorage.removeItem(k));
      localStorage.setItem(key, JSON.stringify(v));
      return true;
    } catch { /* сообщаем ниже */ }
    console.error('[storage] failed to save', key, e);
    if (!storageWarned) {
      storageWarned = true;
      nativeNotify('Квадрат Петровича', 'Не удалось сохранить данные: память приложения переполнена. Последние изменения могут пропасть после перезапуска.');
    }
    return false;
  }
}

let ispDetectionInFlight = false;

async function detectAndApplyIspPreset(attempt = 0) {
  if (!load('sim-isp-auto-preset', true)) return;
  if (ispDetectionInFlight) return;

  // Не перепроверяем чаще раза в 30 минут на той же сети
  const lastRun = load<number>('sim-isp-last-run', 0);
  if (attempt === 0 && Date.now() - lastRun < 30 * 60 * 1000) return;

  ispDetectionInFlight = true;
  try {
    await runIspDetection(true);
    save('sim-isp-last-run', Date.now());
    ispDetectionInFlight = false;
  } catch {
    // retry: через 8с, 30с, 2мин
    // Флаг держим true пока спим между попытками — иначе новые сетевые события
    // запускают параллельную цепочку пока текущая ждёт ретрая.
    const delays = [8000, 30000, 120000];
    if (attempt < delays.length) {
      setTimeout(() => {
        ispDetectionInFlight = false;
        detectAndApplyIspPreset(attempt + 1);
      }, delays[attempt]);
    } else {
      ispDetectionInFlight = false;
    }
  }
}

// Мигрируем fragLength: '50-100' → '10-20'. Старый дефолт был слишком крупным для
// российских DPI с белыми списками — они успевали reassemble ClientHello и блокировали.
(() => { try { if (localStorage.getItem('sim-frag-length') === JSON.stringify('50-100')) localStorage.setItem('sim-frag-length', JSON.stringify('10-20')); } catch {} })();
// Мигрируем fragInterval: '10-20' → '1-5'. Старый интервал добавлял 250-500мс задержки
// на каждое новое TLS-соединение (25 фрагментов × 10-20мс). Для обхода ТСПУ хватает 1-5мс.
(() => { try { if (localStorage.getItem('sim-frag-interval') === JSON.stringify('10-20')) localStorage.setItem('sim-frag-interval', JSON.stringify('1-5')); } catch {} })();

const SCREEN_ORDER: AppScreen[] = ['home', 'servers', 'profiles', 'settings'];

export default function App() {
  const { isDark } = useTheme();
  const [screen, setScreen] = useState<AppScreen>('home');
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => !load('sim-onboarded', false));
  const [showBatterySheet, setShowBatterySheet] = useState(false);
  const [batterySheetTrigger, setBatterySheetTrigger] = useState<'reactive' | 'proactive'>('reactive');
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  // Режим «Иммунитет» (фильтр) поднят нативкой: туннель работает, но весь трафик
  // идёт direct — UI при этом показывает «не подключено» + значок щита.
  const [shieldActive, setShieldActive] = useState(false);
  const [profiles, setProfiles] = useState<SubscriptionProfile[]>(() => {
    const loaded = load('sim-profiles', []);
    const SKIP_OB = new Set(['freedom','blackhole','direct','block','dns','selector','urltest']);
    const SKIP_TAG = new Set(['direct','block','dns-out','dns','bypass','reject']);
    // Возвращает null для нод-плейсхолдеров (0.0.0.0, «Приложение не поддерживается» и т.п.)
    const fixJsonNode = (node: ServerNode): ServerNode | null => {
      if (node.protocol !== 'json' || !node.rawLink) return node;
      const raw = node.rawLink.trim();
      // rawLink — прокси-ссылка (vless://, vmess://…), а не JSON.
      // Бывает у нод из старых бэкапов, где protocol='json' выставлен ошибочно.
      if (!raw.startsWith('{') && !raw.startsWith('[')) {
        const parsed = parseLink(raw);
        if (parsed && parsed.address && parsed.address !== '0.0.0.0' && parsed.address !== 'unknown') {
          return parsed;
        }
        // placeholder / нераспознанная ссылка (напр. vless://0.0.0.0:1#Приложение не поддерживается)
        return null;
      }
      try {
        const cfg = JSON.parse(raw);
        const obs: any[] = Array.isArray(cfg?.outbounds) ? cfg.outbounds : [];
        for (const ob of obs) {
          const t = (ob.protocol || ob.type || '').toLowerCase();
          const tag = (ob.tag || ob.name || '').toLowerCase();
          if (!t || SKIP_OB.has(t) || SKIP_TAG.has(tag)) continue;
          const s = ob.settings || {};
          const a = String(ob.server || s.address || s.vnext?.[0]?.address || s.servers?.[0]?.address || '');
          if (a && a !== '0.0.0.0' && a !== '127.0.0.1') {
            const stream = ob.streamSettings || {};
            return {
              ...node,
              protocol: t as any,
              address: a,
              port: Number(ob.port || s.port || ob.settings?.port || node.port) || node.port,
              security: stream.security && stream.security !== 'none' ? stream.security : undefined,
              transport: stream.network && stream.network !== 'tcp' ? stream.network : undefined,
              sni: stream.tlsSettings?.serverName || stream.realitySettings?.serverName || node.sni,
            };
          }
        }
      } catch { /* ignore */ }
      return node;
    };
    const mapped = (Array.isArray(loaded) ? (loaded as any[]) : []).map((p: any) => ({
      ...p,
      nodes: Array.isArray(p.nodes)
        ? (p.nodes.map(fixJsonNode).filter((n: ServerNode | null): n is ServerNode => n !== null))
        : p.nodes,
      status: p.status || 'healthy',
      lastUpdateTimestamp: p.lastUpdateTimestamp || 0
    } as SubscriptionProfile));
    // Пробный сервер: истёкший срок применяем ещё до первого рендера.
    // Обычным подпискам пересчитываем остаток дней и статус по сроку: снимок
    // статуса сделан при обновлении, а часы идут — без этого истёкшая
    // подписка после перезапуска светилась бы «Активна».
    return refreshExpiry(mapped);
  });
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() => load('sim-active-profile', null));
  const [selectedNode, setSelectedNode] = useState<ServerNode | null>(() => load('sim-selected-node', null));
  const [connectedTime, setConnectedTime] = useState(0);
  const [vpnError, setVpnError] = useState<string | null>(null);
  // Подсказка на кнопке во время автоподбора режима обхода («попытка 2 из 3: …»).
  const [bypassHint, setBypassHint] = useState<string | null>(null);
  // true, пока handleToggle перебирает режимы: опрос состояния не должен сбрасывать UI между попытками.
  const bypassRetryRef = useRef(false);
  const [stats, setStats] = useState<VpnStats | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRef = useRef(false);
  const leakCheckedRef = useRef(false);
  const leakNotifiedAtRef = useRef(0); // когда последний раз показали уведомление об утечке
  // Авто-реконнект при смене сети: ссылки на актуальные значения и защёлки.
  const connStateRef = useRef<ConnectionState>('disconnected');
  const handleToggleRef = useRef<() => void>(() => {});
  // Возвращает false, если обновление не удалось (нет сети, пустой ответ, нет серверов).
  const handleUpdateProfileRef = useRef<(id: string, silent?: boolean) => Promise<boolean | void> | void>(() => {});
  // Последнее обновление подписки пришлось повторить через поднятый туннель (оператор режет напрямую) —
  // чат Петровича сообщает об этом в ответе на «Обнови подписку».
  const updateViaTunnelRef = useRef(false);
  // Присваиваем прямо при рендере (как activeProfileIdRef): синхронизация срабатывает раньше, чем
  // отработал бы эффект, и по пустому значению принял бы существующего пользователя за нового.
  const profilesRef = useRef<typeof profiles>(profiles);
  profilesRef.current = profiles;
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vpnWasActiveRef = useRef(false); // VPN был запущен пользователем и не остановлен вручную
  // sim-autoswitch: до этой правки хранился как голый ключ 'autoSwitch' (без
  // префикса sim-), из-за чего экспорт/импорт настроек и «Полный сброс» в
  // SettingsScreen (фильтруют по startsWith('sim-')) его игнорировали —
  // тоггл не бэкапился и переживал полный сброс данных. Мигрируем старое значение.
  const [autoSwitch, setAutoSwitch] = useState(() =>
    (localStorage.getItem('sim-autoswitch') ?? localStorage.getItem('autoSwitch')) === 'true');
  const autoSwitchRef = useRef(autoSwitch);
  autoSwitchRef.current = autoSwitch;
  const autoSwitchTargetRef = useRef<ServerNode | null>(null);
  const freezeRef = useRef<{ lastDownload: number; lastUpload: number; since: number }>({ lastDownload: -1, lastUpload: 0, since: 0 });
  const isPausedRef = useRef(false);
  const lastDelayTestRef = useRef(0);
  const lastAntiFilterBatchRef = useRef(0);
  const isTogglingRef = useRef(false);
  const isPollingRef = useRef(false);
  const activeProfileIdRef = useRef(activeProfileId);
  activeProfileIdRef.current = activeProfileId;
  const networkChangedRef = useRef<number>(0); // timestamp смены сети, 0 если нет ожидающего восстановления
  const lastNetworkEventRef = useRef<number>(0); // timestamp последнего сетевого события (не очищается watchdog)
  const consecutiveLatencyFailsRef = useRef<number>(0); // счётчик подряд упавших latency-тестов (watchdog)
  const autoSwitchBadPingCountRef = useRef<number>(0); // счётчик подряд плохих пингов для авто-переключения
  // Быстрое переключение при падении сервера (utils/failover.ts).
  const healthRef = useRef(initialHealth());
  const failedAtRef = useRef<Record<string, number>>({}); // id сервера → когда упал
  const failoverChainRef = useRef<ServerNode[]>([]);      // запасные серверы, если новый тоже не поднялся
  const connectedTimeRef = useRef(0);

  const handleAddSingleNode = useCallback((node: ServerNode) => {
    setProfiles(prev => {
      const m = prev.find(p => p.name === 'Ручные серверы');
      if (m) return prev.map(p => p.id === m.id ? { ...p, nodes: [...p.nodes, node], updatedAt: new Date().toLocaleString('ru-RU') } : p);
      return [...prev, {
        id: generateId(),
        name: 'Ручные серверы',
        url: '',
        nodes: [node],
        updatedAt: new Date().toLocaleString('ru-RU'),
        lastUpdateTimestamp: Date.now(),
        autoUpdate: false,
        status: 'healthy' as const
      } as SubscriptionProfile];
    });
    if (!selectedNode) setSelectedNode(node);
  }, [selectedNode]);

  const handleImportRouting = useCallback((r: RoutingProfile, _activate: boolean) => {
    if (activeProfileId) setProfiles(prev => prev.map(p => p.id === activeProfileId ? { ...p, routing: r } : p));
  }, [activeProfileId]);

   const allNodes = useMemo(() => {
     if (Array.isArray(profiles) && profiles.length > 0) {
       return profiles.flatMap(p => Array.isArray(p.nodes) ? p.nodes : []);
     }
     return [];
   }, [profiles]);

   // Актуальные значения для долгоживущих таймеров (см. авто-переключение ниже).
   const selectedNodeRef = useRef<ServerNode | null>(selectedNode);
   selectedNodeRef.current = selectedNode;
   const allNodesRef = useRef<ServerNode[]>(allNodes);
   allNodesRef.current = allNodes;

    useEffect(() => {
      const killSwitchEnabled = load('sim-killswitch', true);
      if (isNative()) {
        nativeToggleKillSwitch(killSwitchEnabled).catch(e => console.error('Failed to set kill switch:', e));
      }
    }, []);

    useEffect(() => {
      if (isNative()) {
        nativeStartNetworkMonitoring().catch(e => console.error('Failed to start network monitoring:', e));
      }
      return () => {
        if (isNative()) {
          nativeStopNetworkMonitoring().catch(e => console.error('Failed to stop network monitoring:', e));
        }
      };
    }, []);

    // Anti-filter: загружаем кэш из нативного SharedPreferences при старте.
    // При событии 'antifilter-update' (batch завершён) — обновляем in-memory кэш.
    useEffect(() => {
      if (!isNative()) return;
      refreshAntiFilterCache();
      const onUpdate = () => refreshAntiFilterCache();
      window.addEventListener('antifilter-update', onUpdate);
      return () => window.removeEventListener('antifilter-update', onUpdate);
    }, []);

    // AntiFilter batch при старте: запускаем когда allNodes готовы (не stale-closure).
    // Отдельный эффект с allNodes в deps — гарантирует актуальный список серверов.
    const antiFilterStartedRef = useRef(false);
    useEffect(() => {
      if (!isNative() || antiFilterStartedRef.current || allNodes.length === 0) return;
      antiFilterStartedRef.current = true;
      setTimeout(() => { lastAntiFilterBatchRef.current = Date.now(); nativeStartAntiFilterBatch(allNodes); }, 3000);
    }, [allNodes]);

    // При запуске приложения восстанавливаем состояние, если VPN уже поднят
    // (приложение свернули/закрыли, а туннель продолжал работать): ставим connected
    // и реальный таймер из connectedSec. Иначе UI стартует с 'disconnected', а таймер —
    // с нуля, хотя соединение давно активно.
    useEffect(() => {
      if (!isNative()) return;
      (async () => {
        try {
          const s = await nativeGetStats();
          const status = (s as any)?.status;
          const running = status === 'connected' || status === 'running' || (s && s.connectedSec > 0);
          if (running && !(s as any)?.error) {
            // Режим «Иммунитет» (фильтр): сервис поднят, но это не подключение к узлу —
            // connectionState оставляем disconnected, а UI показывает значок щита.
            if (await nativeIsShieldMode()) {
              setShieldActive(true);
              return;
            }
            setConnectionState('connected');
            if (s.connectedSec > 0) setConnectedTime(s.connectedSec);
            setStats(s);
            // Фоновый failover мог сменить сервер, пока приложение было закрыто: нативка
            // хранит id активного узла — сверяем выбор UI, иначе список показывает старый.
            const activeId = await nativeGetActiveNodeId();
            if (activeId && selectedNodeRef.current?.id !== activeId) {
              const node = allNodesRef.current.find(n => n.id === activeId);
              if (node) setSelectedNode(node);
            }
          } else if (load('sim-shield', false)) {
            // Фильтр включён, но сервис мёртв (force-stop / перезагрузка без
            // восстановления): поднимаем щит сразу при открытии приложения.
            void startShield();
          }
        } catch { /* ignore */ }
      })();
    }, []);

    // Нативные библиотеки ядра не загрузились (Android): без ядра подключение невозможно,
    // а пользователь раньше видел лишь непонятные сбои. Показываем причину сразу.
    useEffect(() => {
      if (!isNative()) return;
      nativeGetCoreLoadError().then(err => {
        if (err) setVpnError(`Не удалось загрузить сетевое ядро. Переустановите приложение.\n\n${err}`);
      });
    }, []);

    // Держим актуальные значения connectionState в рефе (нужен в других эффектах).
    useEffect(() => {
      connStateRef.current = connectionState;
      if (connectionState === 'connected') vpnWasActiveRef.current = true;
    }, [connectionState]);

    useEffect(() => {
      localStorage.setItem('sim-autoswitch', String(autoSwitch));
      localStorage.removeItem('autoSwitch'); // чистим legacy-ключ после миграции
    }, [autoSwitch]);
    useEffect(() => { isPausedRef.current = isPaused; }, [isPaused]);

    // Запуск реконнекта после авто-переключения (когда VPN остановлен и новый узел уже выбран).
    useEffect(() => {
      if (!autoSwitchTargetRef.current || connectionState !== 'disconnected') return;
      autoSwitchTargetRef.current = null;
      if (!vpnWasActiveRef.current) return; // пользователь вручную отключил — не реконнектим
      nativeClearDnsCache();
      setTimeout(() => handleToggleRef.current(), 600);
    }, [connectionState]);

    // Авто-переключение при плохом пинге (>5000мс или таймаут). Живёт в App.tsx,
    // а не в ServerList, чтобы работало на любом экране пока VPN подключён.
    useEffect(() => {
      if (!autoSwitch || connectionState !== 'connected') return;
      const interval = setInterval(async () => {
        if (!autoSwitchRef.current || connStateRef.current !== 'connected' || isPausedRef.current) return;
        // Актуальные значения берём из refs: раньше selectedNode/allNodes были в deps
        // эффекта, и интервал пересоздавался при каждом обновлении профилей — при частых
        // обновлениях 60-секундный таймер мог вообще ни разу не сработать.
        const selectedNode = selectedNodeRef.current;
        const allNodes = allNodesRef.current;
        if (!selectedNode || !selectedNode.address || !selectedNode.port) return;
        let ping = -1;
        try { const r = await nativePingNode(selectedNode, 'proxy', true, true); ping = typeof r === 'number' ? r : -1; } catch { ping = -1; }
        if (ping >= 0 && ping <= 5000) { autoSwitchBadPingCountRef.current = 0; return; }
        autoSwitchBadPingCountRef.current++;
        // Требуем 2 плохих пинга подряд — один сбой не повод рвать соединение
        if (autoSwitchBadPingCountRef.current < 2) return;
        const DPI_RE = /\b(lte|4g|бс|белые|белый|обход|bypass)\b/i;
        const isDpi = (n: ServerNode) => DPI_RE.test(`${n.name} ${n.remark}`);
        const candidates = allNodes
          .filter(n => n.id !== selectedNode.id && n.address && n.port)
          .sort((a, b) => {
            // DPI-приоритетные серверы — сначала, затем по кэшированному пингу.
            const da = isDpi(a) ? 0 : 1, db = isDpi(b) ? 0 : 1;
            if (da !== db) return da - db;
            const pa = getBestCachedPing(a.id), pb = getBestCachedPing(b.id);
            if (pa > 0 && pb > 0) return pa - pb;
            if (pa > 0) return -1;
            if (pb > 0) return 1;
            return 0;
          });
        if (candidates.length === 0) return;
        // Серверы с хорошим кэшем (< 1500мс) — не перемеряем, берём как есть.
        const res: Record<string, number> = {};
        const toMeasure: ServerNode[] = [];
        for (const n of candidates.slice(0, 15)) {
          const cached = getBestCachedPing(n.id);
          if (cached > 0 && cached < 1500) { res[n.id] = cached; }
          else { toMeasure.push(n); }
        }
        if (toMeasure.length > 0) {
          await new Promise<void>(resolve => {
            startPingBatch(toMeasure.slice(0, 10), (id, ms) => { res[id] = ms; }, () => resolve());
          });
        }
        let bestNode: ServerNode | null = null, bestMs = Infinity;
        for (const n of candidates.slice(0, 15)) {
          const p = res[n.id];
          if (typeof p === 'number' && p > 0 && p < 5000 && p < bestMs) { bestMs = p; bestNode = n; }
        }
        if (!bestNode) return;
        autoSwitchBadPingCountRef.current = 0;
        nativeNotify('Квадрат Петровича', `Авто-переключение → ${bestNode.name}`);
        setSelectedNode(bestNode);
        autoSwitchTargetRef.current = bestNode;
        try { await nativeStopVpn('bad-ping-autoswitch'); } catch {}
        setConnectionState('disconnected');
        setConnectedTime(0);
      }, 60_000);
      return () => clearInterval(interval);
    }, [autoSwitch, connectionState]);

    // Счётчик «подряд плохих пингов» относится к конкретному серверу — при смене сервера обнуляем.
    useEffect(() => { autoSwitchBadPingCountRef.current = 0; }, [selectedNode?.id]);

    useEffect(() => { connectedTimeRef.current = connectedTime; }, [connectedTime]);

    // Быстрое переключение при падении сервера (utils/failover.ts): пока приложение открыто и VPN
    // подключён, раз в несколько секунд идёт лёгкая проверка через прокси. Три провала подряд с паузами —
    // сервер упал: переходим на следующий из профиля или перезапускаем ядро (для сервера-одиночки).
    // Готовые конфиги с балансировщиком не проверяем: балансировщик переключается сам, а перезапуск ядра
    // рвал все соединения (failoverApplies). Старый путь занимал до 80 с, а то и минуты.
    useEffect(() => {
      if (connectionState !== 'connected') return;
      healthRef.current = initialHealth();
      let alive = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Частоту проверок может задать профиль оператора (на жёстких сетях — чаще).
      const profileSec = currentOperatorProfile()?.failoverIntervalSec;
      const cfg = profileSec ? { ...DEFAULT_FAILOVER, healthyIntervalMs: profileSec * 1000 } : DEFAULT_FAILOVER;

      const act = async () => {
        const node = selectedNodeRef.current;
        if (!node) return;
        const now = Date.now();
        if (!cooldownPassed(healthRef.current, now, cfg)) return;
        failedAtRef.current[node.id] = now;
        const candidates = isBalancerNode(node) ? [] : planFailover({
          current: node, nodes: allNodesRef.current, failedAt: failedAtRef.current, now, cfg,
          cachedPing: (id) => getBestCachedPing(id),
          isPriority: isPriorityNode,
        });
        if (candidates.length > 0) {
          const [target, ...rest] = candidates;
          failoverChainRef.current = rest;
          healthRef.current = recordAction(healthRef.current, now, 'switch', cfg);
          nativeNotify('Квадрат Петровича', `Сервер не отвечает — переключаюсь на ${target.name}`);
          setSelectedNode(target);
          autoSwitchTargetRef.current = target;
        } else if (restartAllowed(healthRef.current, now, cfg)) {
          failoverChainRef.current = [];
          healthRef.current = recordAction(healthRef.current, now, 'restart', cfg);
          nativeNotify('Квадрат Петровича', 'Сервер не отвечает — перезапускаю подключение');
          autoSwitchTargetRef.current = node;
        } else {
          return; // слишком много перезапусков подряд — не зацикливаемся, дальше работают прежние проверки
        }
        consecutiveLatencyFailsRef.current = 0;
        try { await nativeStopVpn('fast-failover'); } catch { /* ядро могло уже упасть */ }
        setConnectionState('disconnected');
        setConnectedTime(0);
      };

      const tick = async () => {
        if (!alive) return;
        let delay = cfg.healthyIntervalMs;
        // Не проверяем: приложение свёрнуто, идёт смена сети или автоподбор обхода, соединение совсем свежее.
        const skip = !isFastFailoverEnabled() || !failoverApplies(selectedNodeRef.current) || isPausedRef.current || networkChangedRef.current > 0
          || bypassRetryRef.current || connStateRef.current !== 'connected' || connectedTimeRef.current < cfg.minUptimeSec;
        if (!skip) {
          const ms = await nativeTestProxyDelay().catch(() => -1);
          if (!alive || connStateRef.current !== 'connected') return;
          const r = onProbe(healthRef.current, typeof ms === 'number' && ms > 0, cfg);
          healthRef.current = r.state;
          delay = nextDelayMs(r.verdict, cfg);
          if (r.verdict === 'dead') {
            // Сети нет у самого устройства — это не вина сервера, ничего не переключаем и не частим.
            if (await deviceNetworkUp()) {
              await act();
              if (alive && connStateRef.current === 'connected') timer = setTimeout(tick, cfg.healthyIntervalMs);
              return;
            }
            delay = cfg.healthyIntervalMs;
          }
        }
        if (alive) timer = setTimeout(tick, delay);
      };

      timer = setTimeout(tick, cfg.healthyIntervalMs);
      return () => { alive = false; if (timer) clearTimeout(timer); };
    }, [connectionState]);

    // Профили операторов с сервера: обновляем через несколько секунд после запуска (не чаще раза в 6 ч);
    // без сети остаются кэш и встроенные значения.
    useEffect(() => {
      const t = setTimeout(() => { refreshOperatorProfiles().catch(() => {}); }, 5000);
      return () => clearTimeout(t);
    }, []);

    // Импорт подписки по ссылке из deep link (sim://import/<sub-url>, sim://add/<url>…).
    const importSubscriptionFromUrl = useCallback(async (rawUrl: string) => {
      let url = rawUrl.trim();
      if (!url.startsWith('http')) url = 'https://' + url;
      nativeNotify('Квадрат Петровича', 'Загрузка подписки…');
      try {
        const smart = await fetchSubscription(url);
        const result = smart.res;
        let content = '';
        let fetchResult: FetchResult | null = null;
        if (typeof result === 'object' && result !== null) {
          if ((result as FetchResult).ok === false) throw new Error((result as FetchResult).error || 'Ошибка загрузки');
          fetchResult = result as FetchResult;
          content = fetchResult.body || '';
        } else if (typeof result === 'string') {
          content = result;
        }
        if (!content?.trim()) throw new Error('Пустой ответ от сервера');

        const headers = fetchResult?.headers;
        const parsed = parseSubscription(content, fetchResult?.userInfo, headers);
        if (parsed.nodes.length === 0) throw new Error('Серверов не найдено');

        const rawTitle = fetchResult?.name;
        const name = parsed.name || (rawTitle ? decodeProfileTitle(rawTitle) : undefined) || guessSubscriptionName(url);
        const baseProfile: SubscriptionProfile = {
          id: generateId(),
          name,
          url,
          nodes: parsed.nodes,
          autoUpdate: true,
          updatedAt: new Date().toLocaleString('ru-RU'),
          lastUpdateTimestamp: Date.now(),
          traffic: parsed.traffic,
          updateInterval: parsed.updateInterval ?? fetchResult?.updateInterval,
          webPage: parsed.webPage ?? fetchResult?.webPage,
          supportUrl: parsed.supportUrl ?? fetchResult?.supportUrl,
          panelType: detectPanelType(url, headers),
          fetchUa: smart.preference,
          status: statusFromTraffic(parsed.traffic),
        };
        // Параметры управления от провайдера (стиль Happ): объявление, кнопки, настройки для доверенных.
        const newProfile = applyManagement(baseProfile, parsed.managed);
        // Добавляем профиль напрямую (handleAddProfile объявлен ниже по файлу —
        // не ссылаемся на него отсюда во избежание temporal dead zone).
        setProfiles(prev => [...prev, newProfile]);
        if (!activeProfileId) {
          setActiveProfileId(newProfile.id);
          if (newProfile.nodes.length) setSelectedNode(newProfile.nodes[0]);
        }
        if (parsed.routing) handleImportRouting(parsed.routing, true);
        setScreen('profiles');
        nativeNotify('Квадрат Петровича', `Подписка «${name}»: ${parsed.nodes.length} серверов`);
      } catch (e: any) {
        nativeNotify('Ошибка подписки', e?.message || 'Проверьте ссылку и интернет');
      }
    }, [activeProfileId, handleImportRouting]);

    // Действие из ссылки выполняем только после подтверждения пользователем: ссылку
    // sim:// может открыть любая веб-страница, и без подтверждения она подсунула бы
    // чужую подписку/маршрутизацию или отключила VPN.
    const [pendingDeepLink, setPendingDeepLink] = useState<DeepLinkAction | null>(null);

    const runDeepLinkAction = useCallback((action: DeepLinkAction) => {
      if (action.type === 'import') {
        const node = action.nodes[0];
        if (node) {
          handleAddSingleNode(node);
          setScreen('servers');
          nativeNotify('Квадрат Петровича', `Импортирован сервер: ${node.name}`);
        }
      } else if (action.type === 'subscribe') {
        importSubscriptionFromUrl(action.url);
      } else if (action.type === 'routing_add') {
        handleImportRouting(action.profile, action.activate);
        setScreen('settings');
        nativeNotify('Квадрат Петровича', `Импортирован профиль маршрутизации: ${action.profile.Name}`);
      } else if (action.type === 'vpn_off') {
        if (connStateRef.current === 'connected') handleToggleRef.current();
      }
    }, [handleAddSingleNode, handleImportRouting, importSubscriptionFromUrl]);

    useEffect(() => {
      const processDeepLink = (uri: string) => {
        if (!uri) return;
        const action = parseSimUrl(uri);
        if (!action) return;
        if (action.type === 'vpn_on') {
          // Включение VPN безопасно выполнять сразу.
          if (connStateRef.current === 'disconnected') handleToggleRef.current();
        } else if (action.type === 'import' || action.type === 'subscribe' || action.type === 'routing_add' || action.type === 'vpn_off') {
          setPendingDeepLink(action as DeepLinkAction);
        }
      };

      const handleDeepLink = (e: any) => processDeepLink(e.detail);
      window.addEventListener('deeplink', handleDeepLink);

      // Холодный старт: забираем ссылку, пришедшую до навешивания слушателя.
      nativeGetPendingDeepLink().then(uri => { if (uri) processDeepLink(uri); }).catch(() => {});

      return () => window.removeEventListener('deeplink', handleDeepLink);
    }, []);

    useEffect(() => {
      const handleBack = () => {
        // Дочерние экраны могут зарегистрировать перехватчик (напр. SettingsScreen → сабскрин).
        // Если перехватчик вернул true — он обработал жест, App.tsx ничего не делает.
        const intercepted = (window as any).__simBackInterceptor?.();
        if (intercepted) return;

        if (screen === 'dns') {
          setScreen('settings');
        } else if (screen === 'dashboard') {
          setScreen('home');
        } else if (screen !== 'home') {
          setScreen('home');
        } else {
          if (isNative()) {
            nativeMinimizeApp();
          }
        }
      };

      window.addEventListener('androidback', handleBack);
      return () => window.removeEventListener('androidback', handleBack);
    }, [screen]);

  useEffect(() => { save('sim-profiles', profiles); }, [profiles]);
  useEffect(() => { save('sim-active-profile', activeProfileId); }, [activeProfileId]);
  useEffect(() => { save('sim-selected-node', selectedNode); }, [selectedNode]);

  // Срок подписки проверяем раз в минуту и при возврате в приложение: в фоне
  // WebView замирает, и без этого истёкший сервер дожил бы до следующей минуты.
  useEffect(() => {
    const tick = () => { setProfiles(prev => refreshExpiry(prev)); };
    tick();
    const timer = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, []);

  // Выбранный сервер хранится копией. После обновления подписки берём свежие данные (описание от провайдера,
  // параметры сервера): иначе главный экран и следующее подключение шли бы со старыми. Пинг из сравнения исключён.
  useEffect(() => {
    if (!selectedNode) return;
    const current = allNodes.find(n => n.id === selectedNode.id);
    if (current && JSON.stringify({ ...current, ping: undefined }) !== JSON.stringify({ ...selectedNode, ping: undefined })) {
      setSelectedNode(current);
    }
  }, [allNodes, selectedNode]);

  // Уведомление об истечении подписки: один раз за сессию, если ≤3 дней.
  useEffect(() => {
    if (!isNative()) return;
    if (sessionStorage.getItem('sim-expiry-notified')) return;
    const active = profiles.find(p => p.id === activeProfileId);
    const days = active?.traffic?.remainingDays;
    if (typeof days === 'number' && days <= 3) {
      sessionStorage.setItem('sim-expiry-notified', '1');
      nativeNotify('Квадрат Петровича', days <= 0 ? 'Подписка истекла!' : `Подписка истекает через ${days} дн.`);
    }
  }, [profiles, activeProfileId]);

  // AntiFilter batch: запускаем тест всех серверов когда VPN выключен.
  // Первый запуск — при старте (если VPN не поднят). Повторный — при каждом
  // отключении VPN, чтобы кэш пингов оставался актуальным.
  const prevConnectionStateRef = useRef<ConnectionState>('disconnected');
  useEffect(() => {
    const prev = prevConnectionStateRef.current;
    prevConnectionStateRef.current = connectionState;
    if (!isNative()) return;
    if (connectionState === 'disconnected' && prev !== 'disconnected') {
      // VPN только что отключился: обновляем ISP-пресет (теперь fetch идёт без туннеля)
      save('sim-isp-last-run', 0);
      const tIsp = setTimeout(() => detectAndApplyIspPreset(), 1500);
      // Троттлим: полный ре-скан 87 серверов синхронно строит конфиги на JS-потоке
      // и подвешивает UI на заметное время. При частых дисконнектах/реконнектах
      // (смена сервера, нестабильная сеть) это превращалось в постоянные подвисания.
      if (allNodes.length > 0 && Date.now() - lastAntiFilterBatchRef.current > 5 * 60_000) {
        // и запускаем AntiFilter batch через секунду
        const tBatch = setTimeout(() => { lastAntiFilterBatchRef.current = Date.now(); nativeStartAntiFilterBatch(allNodes); }, 1000);
        return () => { clearTimeout(tIsp); clearTimeout(tBatch); };
      }
      return () => clearTimeout(tIsp);
    }
  }, [connectionState, allNodes]);

  // Смена сети (Wi-Fi ↔ мобильный): реконнект делает НАТИВНАЯ сторона
  // (VpnServiceImpl.networkChangeListener → reconnectOnNetworkChange), как в исходной
  // рабочей версии проекта. JS здесь только обновляет ISP-пресет (для следующего
  // ручного коннекта) и НЕ инициирует stop/reconnect — иначе конфликт с нативным
  // реконнектом (двойные рестарты, паразитные обрывы на стабильном WiFi).
  useEffect(() => {
    if (!isNative()) return;
    const onNetworkChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail as { event: string; type?: string };
      if (detail.event === 'available' || detail.event === 'changed') {
        save('sim-isp-last-run', 0);
        lastNetworkEventRef.current = Date.now();
        setTimeout(() => detectAndApplyIspPreset(), 1500);
      }
    };
    window.addEventListener('network-changed', onNetworkChanged);
    return () => window.removeEventListener('network-changed', onNetworkChanged);
  }, []);

  // Показываем подсказку про батарею когда VPN сам упал в фоне (watchdog).
  // Пользователь уже видит проблему — объяснение приходит вовремя.
  useEffect(() => {
    if (!isNative()) return;
    const onDropped = () => {
      if (!load('sim-battery-perm-done', false)) {
        setBatterySheetTrigger('reactive');
        setShowBatterySheet(true);
      }
    };
    window.addEventListener('vpn-dropped-in-background', onDropped);
    return () => window.removeEventListener('vpn-dropped-in-background', onDropped);
  }, []);

  // Фоновый failover (нативка): событие приходит прямо перед перезапуском процесса —
  // шанс обновить выбор немедленно. Если WebView не успел (процесс убит) — выбор
  // синхронизируется при следующем старте приложения через nativeGetActiveNodeId.
  useEffect(() => {
    if (!isNative()) return;
    const onFailover = (e: Event) => {
      const d = (e as CustomEvent).detail as { id?: string; name?: string } | null;
      const id = d?.id;
      if (!id) return;
      const node = allNodesRef.current.find(n => n.id === id);
      if (node) setSelectedNode(node);
    };
    window.addEventListener('vpn-failover', onFailover);
    return () => window.removeEventListener('vpn-failover', onFailover);
  }, []);

  // Проактивно предлагаем разрешение один раз после ПЕРВОГО успешного подключения —
  // не дожидаясь, пока watchdog поймает реальный обрыв в фоне (который на некоторых
  // устройствах, например с агрессивным OEM-килером, пользователь может вообще не
  // увидеть, если экран был выключен). Показываем только один раз за всё время
  // (sim-battery-perm-prompted), чтобы не докучать при каждом подключении.
  const proactiveBatteryPromptRef = useRef(false);
  useEffect(() => {
    if (!isNative()) return;
    if (connectionState !== 'connected') return;
    if (proactiveBatteryPromptRef.current) return;
    if (load('sim-battery-perm-done', false) || load('sim-battery-perm-prompted', false)) return;
    proactiveBatteryPromptRef.current = true;
    const t = setTimeout(() => {
      save('sim-battery-perm-prompted', true);
      setBatterySheetTrigger('proactive');
      setShowBatterySheet(true);
    }, 2500);
    return () => clearTimeout(t);
  }, [connectionState]);

  useEffect(() => { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); }, []);

  useEffect(() => {
    if (autoRef.current) return; autoRef.current = true;

    // POST_NOTIFICATIONS — тихий системный диалог, не пугает
    if (isNative()) {
      nativeRequestAllPermissions().catch(console.error);
    }

    if (load('sim-autoconnect', false) && selectedNode) {
      // subscription-autoconnect-type от провайдера: какой сервер брать при автоподключении (по умолчанию — последний выбранный).
      const pool = (profiles.find(p => p.id === activeProfileId) ?? profiles.find(p => p.nodes.some(n => n.id === selectedNode.id)))?.nodes ?? [];
      const pings = load<Record<string, number>>('sim-ping-result-cache-v2', {});
      const pick = pickAutoConnectNode(load<string>('sim-autoconnect-type', 'lastused'), pool, selectedNode, n => pings[n.id]);
      const switched = pick.id !== selectedNode.id;
      if (switched) setSelectedNode(pick);
      // Используем ref чтобы избежать stale closure — handleToggleRef всегда
      // указывает на актуальную версию функции на момент вызова. При смене сервера ждём, пока он применится.
      setTimeout(() => handleToggleRef.current?.(), switched ? 900 : 500);
    }

    // ISP auto-preset: определяем оператора по IP/ASN и применяем DPI-пресет
    setTimeout(() => detectAndApplyIspPreset(), 1500);

    // Метку «обновлено» ставим только если хотя бы одна подписка реально обновилась.
    // Раньше она ставилась до результата: без сети следующая попытка была только
    // через сутки. Теперь при неудаче повтор — на ближайшей часовой проверке.
    // Обновляем по очереди, а не всё сразу, и не запускаем второй проход поверх первого.
    let scheduledUpdateRunning = false;
    const runScheduledSubscriptionUpdate = async () => {
      const lastUpdate = load('sim-last-auto-update', 0);
      if (Date.now() - lastUpdate <= 24 * 60 * 60 * 1000) return;
      if (scheduledUpdateRunning) return;
      scheduledUpdateRunning = true;
      try {
        // handleUpdateProfileRef указывает на актуальную версию — profiles уже загружены
        const targets = profilesRef.current.filter(p => p.url && p.autoUpdate);
        if (targets.length === 0) { save('sim-last-auto-update', Date.now()); return; }
        let succeeded = 0;
        for (const p of targets) {
          try {
            if (await handleUpdateProfileRef.current?.(p.id, true) !== false) succeeded++;
          } catch { /* следующая подписка */ }
        }
        if (succeeded > 0) save('sim-last-auto-update', Date.now());
      } finally {
        scheduledUpdateRunning = false;
      }
    };

    // subscription-auto-update-open-enable от провайдера: при открытии приложения обновить все подписки с адресом.
    if (load('sim-update-on-open', false)) {
      setTimeout(async () => {
        let ok = 0;
        for (const p of profilesRef.current.filter(x => x.url)) {
          try { if (await handleUpdateProfileRef.current?.(p.id, true) !== false) ok++; } catch { /* следующая подписка */ }
        }
        if (ok > 0) save('sim-last-auto-update', Date.now());
      }, 3000);
    }

    setTimeout(runScheduledSubscriptionUpdate, 5000);
    // Раз в час перепроверяем условие — иначе если процесс приложения живёт
    // без перезапуска днями (активный VPN держит его в памяти), суточная
    // проверка выше не срабатывает повторно, т.к. раньше выполнялась только
    // один раз при монтировании компонента.
    const autoUpdateIntervalId = setInterval(runScheduledSubscriptionUpdate, 60 * 60 * 1000);
    return () => clearInterval(autoUpdateIntervalId);
  }, []);

   useEffect(() => {
     if (isNative()) {
       nativeSetStatusBarStyle(isDark ? 'dark' : 'light');
     }
   }, [isDark]);

    // Авто-тест утечек IP/DNS после успешного подключения (один раз за сессию).
    // Управляется настройкой sim-auto-leaktest (по умолчанию включено).
    useEffect(() => {
      if (connectionState !== 'connected') { leakCheckedRef.current = false; return; }
      if (leakCheckedRef.current) return;
      if (!isNative()) return;
      if (!load('sim-auto-leaktest', true)) return;
      leakCheckedRef.current = true;

      const t = setTimeout(async () => {
        try {
          const [ip, dns] = await Promise.all([
            nativeTestIpLeak().catch(() => null),
            nativeTestDnsLeak().catch(() => null),
          ]);
          const ipLeak = ip?.hasLeak === true;
          const dnsLeak = dns?.leakDetected === true;
          if (ipLeak || dnsLeak) {
            const what: string[] = [];
            if (ipLeak) what.push('настоящий IP совпадает с адресом через VPN');
            if (dnsLeak) what.push('DNS-запросы идут мимо туннеля');
            // Не чаще раза в 30 минут: при каждом переподключении тест идёт заново, а повтор ничего не добавляет.
            // Раньше уведомление отсылало «проверьте Dashboard», но такого экрана с результатами в приложении нет.
            if (Date.now() - leakNotifiedAtRef.current > 30 * 60_000) {
              leakNotifiedAtRef.current = Date.now();
              nativeNotify('⚠️ Возможная утечка', `Трафик может идти мимо VPN: ${what.join('; ')}.`);
              nativeVibrate(60);
            }
            (window as any).__simLeak = { ip, dns, at: Date.now() };
            window.dispatchEvent(new CustomEvent('leak-detected', { detail: { ip, dns } }));
          } else if (ip?.ipAddress) {
            (window as any).__simLeak = { ip, dns, at: Date.now() };
          }
        } catch (e) {
          console.error('Auto leak test failed:', e);
        }
      }, 4000);

      return () => clearTimeout(t);
    }, [connectionState]);

    useEffect(() => {
      if (connectionState !== 'connected') {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return;
      }

      // Раз в секунду +1 с. Раньше было +1 каждые 3 с: счётчик шёл втрое медленнее
      // и «прыгал» при каждой синхронизации с нативным аптаймом (каждые ~5 с).
      timerRef.current = setInterval(() => {
        setConnectedTime(t => t + 1);
      }, 1000);

      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }, [connectionState]);

    useEffect(() => {
          (window as any).navigateToDns = () => setScreen('dns');
          (window as any).navigateToDashboard = () => setScreen('dashboard');

          const handlePause = () => setIsPaused(true);
          const handleResume = () => setIsPaused(false);

          window.addEventListener('app-paused', handlePause);
          window.addEventListener('app-resumed', handleResume);

          return () => {
            window.removeEventListener('app-paused', handlePause);
            window.removeEventListener('app-resumed', handleResume);
          };
    }, []);

    useEffect(() => {
      if (connectionState === 'disconnected' || !isNative() || isPaused) {
        setStats(null);
        return;
      }

      let connectTimeout: NodeJS.Timeout | null = null;
      if (connectionState === 'connecting') {
        // Только для 'connecting' — если сервис не стартовал за 60с.
        // В состоянии 'verifying' таймаут управляется внутренним 60-итерационным
        // циклом в handleToggle; внешний timeout убивал VPN пока он стартует.
        // 60с нужно для медленных DPI-сетей, где генерация конфига может занять > 25с.
        connectTimeout = setTimeout(() => {
          console.error('VPN Connection Timeout (60s)');
          isTogglingRef.current = false; // разблокируем кнопку если handleToggle ещё висит
          setConnectionState('disconnected');
          setVpnError('Таймаут подключения. Проверьте сеть или настройки сервера.');
          nativeStopVpn('connect-timeout-60s').catch(console.error);
        }, 60000);
      }

       // Авто-реконнект после смерти сервиса/ошибки поля (ветка isCrashed в pollStats).
       // Без условия «смена сети <20с» — сервер падает и при стабильной сети, именно
       // тогда старая версия молча не переподключалась вовсе. Ограничен 3 попытками
       // (2с → 10с → 30с), чтобы при заведомо упавшем сервере не зациклиться.
       // Цепочка сама останавливается: успех переводит connStateRef в connected,
       // ручное отключение пользователя — в vpnWasActiveRef=false.
       const crashReconnect = async (attempt: number): Promise<void> => {
         if (!vpnWasActiveRef.current) return;
         if (attempt >= 3) {
           if (connStateRef.current === 'disconnected') {
             nativeNotify('Квадрат Петровича', 'VPN отключился — не удалось переподключиться. Открой приложение и включи вручную.');
           }
           return;
         }
         await new Promise<void>(r => setTimeout(r, [2_000, 10_000, 30_000][attempt]));
         if (!vpnWasActiveRef.current || connStateRef.current !== 'disconnected') return;
         if (isTogglingRef.current) return;
         try { await handleToggleRef.current(); } catch (e) { console.error('crash reconnect failed:', e); }
         if (connStateRef.current === 'disconnected') await crashReconnect(attempt + 1);
       };

       const pollStats = async () => {
         if (isPollingRef.current) return; // предотвращаем конкурентные вызовы при медленном bridge
         isPollingRef.current = true;
         try {
             const curState = connStateRef.current;
             // Идёт автоподбор режима обхода: за подключением следит handleToggle, а между попытками
             // ядро намеренно останавливается — это не отключение и не ошибка.
             if (bypassRetryRef.current && curState !== 'connected') return;
             if (curState === 'connected' || curState === 'connecting' || curState === 'verifying' || curState === 'reconnecting') {
             const s = await nativeGetStats();
             const status = (s as any)?.status as string | undefined;
             const message = (s as any)?.message as string | undefined;

             if (curState === 'connecting' && status === 'starting') {
                if ((s as any).lastError) {
                   console.error('VPN failed during startup phase:', (s as any).lastError);
                   if (connectTimeout) clearTimeout(connectTimeout);
                   isTogglingRef.current = false; // разблокируем кнопку если handleToggle ещё висит
                   setConnectionState('disconnected');
                   setVpnError((s as any).lastError);
                   return;
                }
             }

             // Check for routing issues - if not_routing, it's a critical failure
             if (((s as any).error === 'vpn_not_routing') || status === 'not_routing') {
               console.warn('VPN routing issue detected:', s);
               if (connectTimeout) clearTimeout(connectTimeout);
               isTogglingRef.current = false;
               setConnectionState('disconnected');
               setConnectedTime(0);
               const errMsg = (s as any).lastError || message || (s as any).error || 'Маршрутизация не работает. Проверьте настройки или переустановите приложение.';
               setVpnError(errMsg);
               return;
             }

             // Намеренное отключение (кнопка «Отключить» в шторке / onRevoke):
             // нативка репортит status:"stopped". Это чистый стоп — просто
             // переводим UI в disconnected без ошибки «Соединение прервано».
             if (status === 'stopped') {
               if (connectTimeout) clearTimeout(connectTimeout);
               isTogglingRef.current = false;
               setConnectionState('disconnected');
               setConnectedTime(0);
               setVpnError(null);
               return;
             }

             // Java-реконнект (смена сети / watchdog): ядро стартует заново пока UI
             // считает что мы connected. Детектируем по status==='starting' и показываем
             // состояние 'reconnecting' вместо ложного 'connected'.
             if (status === 'starting' && curState === 'connected') {
               freezeRef.current = { lastDownload: -1, lastUpload: 0, since: 0 };
               consecutiveLatencyFailsRef.current = 0;
               setConnectionState('reconnecting');
               return;
             }

             // Восстановление после Java-реконнекта: ядро снова поднялось.
             if (curState === 'reconnecting') {
               if (status === 'running' || status === 'connected') {
                 setConnectionState('connected');
                 setVpnError(null);
               } else if (status === 'not_running' || status === 'stopped') {
                 setConnectionState('disconnected');
                 setConnectedTime(0);
                 // Java-реконнект не удался — пробуем заново через 2с
                 if (vpnWasActiveRef.current) {
                   setTimeout(() => {
                     if (connStateRef.current === 'disconnected') handleToggleRef.current();
                   }, 2_000);
                 }
               }
               return;
             }

             const isCrashed = status === 'not_running' && curState === 'connected';
             if ((s && (s as any).error && curState === 'connected') || isCrashed) {
               console.warn('VPN error/crash detected:', (s as any).error || status);
               const errorMsg = (s as any).lastError || (s as any).error || 'Соединение прервано';
               setConnectionState('disconnected');
               setConnectedTime(0);
               if (errorMsg) setVpnError(errorMsg);
               // Сервис уже мёртв (isCrashed) — стоп не на чем, а nativeStopVpn здесь
               // вреден: clearSavedConfig сотрёт сохранённый конфиг и отменит
               // WatchdogReceiver — единственную нативную страховку автозапуска.
               // Живому сервису с ошибкой штатный стоп нужен для сброса состояния.
               if (!isCrashed) nativeStopVpn('js-error-field').catch(console.error);
               // Переподключаемся сразу, без окна «смена сети <20с»: сервер падает и
               // при стабильной сети — раньше это означало «не умеет сам включать».
               crashReconnect(0);
               return;
             }

             setStats(prev => {
               if (!prev || s.download !== prev.download || s.upload !== prev.upload || s.downlinkSpeed !== prev.downlinkSpeed) {
                 return s;
               }
               return prev;
             });

             // Таймер берём из реального аптайма сервиса (connectedSec), а не из
             // JS-счётчика: при сворачивании/закрытии приложения JS-интервал замирает,
             // а нативный VPN-сервис продолжает считать. Синхронизируем каждый поллинг —
             // так таймер показывает истинное время подключения, даже если приложение
             // было в фоне или закрыто.
             if (s.connectedSec > 0 && (curState === 'connected' || status === 'connected' || status === 'running')) {
               setConnectedTime(prev => (prev !== s.connectedSec ? s.connectedSec : prev));
             }

             // Watchdog 1 — latency: 3 подряд -1 от delay-теста → прокси завис, реконнект.
             // Точный сигнал: idle-пользователей не трогает, срабатывает через ~3 мин после зависания прокси.
             if (curState === 'connected' && s.connectedSec > 90 && consecutiveLatencyFailsRef.current >= 3) {
               consecutiveLatencyFailsRef.current = 0;
               freezeRef.current = { lastDownload: -1, lastUpload: 0, since: 0 };
               networkChangedRef.current = 0;
               if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
               nativeNotify('Квадрат Петровича', 'Зависание VPN — переподключение…');
               autoSwitchTargetRef.current = selectedNode;
               try { await nativeStopVpn('latency-dead'); } catch {}
               setConnectionState('disconnected');
               setConnectedTime(0);
             }

             // Watchdog 2 — byte-freeze: резервный на случай если latency-тест тоже завис.
             // Байты не менялись 10 минут при наличии трафика → принудительный реконнект.
             if (curState === 'connected' && s.connectedSec > 60 && (s.download > 0 || s.upload > 0)) {
               const fr = freezeRef.current;
               if (s.download !== fr.lastDownload || (s.upload ?? 0) !== fr.lastUpload) {
                 fr.lastDownload = s.download;
                 fr.lastUpload = s.upload ?? 0;
                 fr.since = Date.now();
               } else if (fr.since > 0 && Date.now() - fr.since > 600_000) {
                 fr.since = 0; fr.lastDownload = -1; fr.lastUpload = 0;
                 networkChangedRef.current = 0;
                 if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
                 nativeNotify('Квадрат Петровича', 'Зависание VPN — переподключение…');
                 autoSwitchTargetRef.current = selectedNode;
                 try { await nativeStopVpn('freeze-detected'); } catch {}
                 setConnectionState('disconnected');
                 setConnectedTime(0);
               }
             }

             // Восстановление после смены сети: трафик пошёл → отменяем fallback-рестарт
             if (curState === 'connected' && networkChangedRef.current > 0) {
               if ((s.downlinkSpeed ?? 0) > 0 || (s.uplinkSpeed ?? 0) > 0) {
                 networkChangedRef.current = 0;
                 if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
               }
             }

             // Замер Proxy Delay раз в 60 секунд — timestamp-based, без пропусков из-за polling granularity.
             // Результат используется watchdog-ом: 3+ подряд -1 → признак зависшего прокси.
             if (curState === 'connected' && s.connectedSec > 30 && Date.now() - lastDelayTestRef.current > 60_000) {
               lastDelayTestRef.current = Date.now();
               nativeTestProxyDelay().then(delay => {
                 if (delay > 0) {
                   consecutiveLatencyFailsRef.current = 0;
                 } else {
                   consecutiveLatencyFailsRef.current++;
                 }
                 setStats(prev => prev ? { ...prev, latency: delay } : null);
               });
             }

             if (curState === 'connecting') {
               if (s && !(s as any).error && (status === 'connected' || status === 'verified' || status === 'running' || s.connectedSec > 0)) {
                 if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
                 setConnectionState('connected');
                 setVpnError(null);
                 nativeVibrate(30);
               } else if (s && (s as any).error && (s as any).error !== 'vpn_starting') {
                 console.error('VPN failure detected during connecting:', (s as any).error);
                 if (connectTimeout) clearTimeout(connectTimeout);
                 setConnectionState('disconnected');

                 // Construct a more readable error if logs are present
                 let displayError = (s as any).lastError || (s as any).error;
                 if ((s as any).startupLogs) {
                   displayError = `${displayError}\n\nПоследние логи:\n${(s as any).startupLogs}`;
                 }
                 setVpnError(displayError);
               }
             }
           }
         } catch (e) {
           console.error('Failed to fetch status/stats:', e);
         } finally {
           isPollingRef.current = false;
         }
       };

      const intervalMs = (connectionState === 'connecting' || connectionState === 'verifying' || connectionState === 'reconnecting') ? 2000 : 5000;
      const statsInterval = setInterval(pollStats, intervalMs);

      // Периодическое обновление трафика профиля (раз в 15 минут, только в foreground)
      const profileInterval = setInterval(() => {
        const pid = activeProfileIdRef.current;
        if (connStateRef.current === 'connected' && pid && !isPausedRef.current) {
          handleUpdateProfile(pid, true).catch(console.error);
        }
      }, 15 * 60 * 1000);

      return () => {
        clearInterval(statsInterval);
        clearInterval(profileInterval);
        if (connectTimeout) clearTimeout(connectTimeout);
      };
    }, [connectionState, isPaused]);

    /**
     * Общая сборка settings для старта VPN: единый источник для обычного
     * подключения (handleToggle, дальше применяет applyAttempt) и режима
     * «Иммунитет» (node = null — у фильтра нет узла, altPorts не нужен).
     */
    const collectVpnSettings = useCallback(async (node: ServerNode | null) => {
      const customRules = await nativeGetRoutingRules();
      const opProfile = currentOperatorProfile();

      const defaultSocksPort = load('sim-socks-port', '10808');
      const dnsAddr = load('sim-dns-address', '1.1.1.1');
      // udpgwAddress пустой по умолчанию — в этом проекте нет отдельного udpgw-демона.
      // tun2socks при пустом адресе использует SOCKS UDP ASSOCIATE (Xray поддерживает udp:true).
      const defaultUdpGwAddress = load('sim-udpgw-address', '');
      const defaultTunAddress = load('sim-tun-address', '172.19.0.1');
      const defaultTunNetmask = load('sim-tun-netmask', '255.255.255.252');

      // Legacy VPN Address setting is obsolete; TUN Address is the single VPN/TUN interface IP.
      localStorage.removeItem('sim-vpn-address');

      return {
        socksPort: defaultSocksPort,
        httpPort: load('sim-http-port', '10809'),
        sniffing: load('sim-sniffing', true),
        sniffRouteOnly: load('sim-sniff-routeonly', false),
        inboundAuth: load('sim-inbound-auth', false),
        inboundUser: load('sim-inbound-user', ''),
        inboundPass: load('sim-inbound-pass', ''),
        logsMode: load('sim-logs-mode', 'warning'),
        domainStrategy: load('sim-domain-strategy', 'IPIfNonMatch'),
        dnsAddress: dnsAddr,
        // Для Java слоя (tun2socks) передаем IP/host, а Xray сам перехватит UDP/53 и переведёт в DoH.
        dns: dnsAddr,
        udpgwAddress: defaultUdpGwAddress,
        udpgwTransparent: load('sim-udpgw-transparent', false),
        tunAddress: defaultTunAddress,
        tunNetmask: defaultTunNetmask,
        fragEnable: load('sim-frag-enable', true),
        fragPackets: load('sim-frag-packets', 'tlshello'),
        fragLength: load('sim-frag-length', '10-20'),
        fragInterval: load('sim-frag-interval', '1-5'),
        fragMaxSplit: load('sim-frag-maxsplit', ''),
        // DNS: дополнительные серверы оператора и параллельный опрос (порядок списка тогда не важен).
        dnsExtra: opProfile?.dns?.extra ?? [],
        dnsParallel: opProfile?.dns?.parallel ?? true,
        noisesEnable: load('sim-noises-enable', false),
        noisesType: load('sim-noises-type', 'rand'),
        noisesDelay: load('sim-noises-delay', '50'),
        noisesRand: load('sim-noises-rand', '1-1024'),
        uTlsFingerprint: load('sim-utls-fingerprint', 'chrome'),
        mtu: load('sim-mtu', '1400'), // как в настройках (SettingsScreen) и нативном коде; 1280 на деле гнал туннель с минимальным MTU
        idleTimeout: load('sim-idle-timeout', '300'),
        dnsServers: load('sim-dns-servers', []),
        dnsHosts: load('sim-dns-hosts', []),
        fakeDns: load('sim-fakedns', false),
        dnsCache: load('sim-dns-cache', true),
        leakProtection: load('sim-leak-protection', true),
        dnsQueryStrategy: load('sim-dns-query-strategy', 'UseIPv4'),
        splitTunnel: load('sim-splittunnel', false),
        routing: load('sim-routing', 'global'),
        routeOrder: load('sim-route-order', 'block-proxy-direct'),
        mux: load('sim-mux-enabled', false) ? { enabled: true, concurrency: Number(load('sim-mux-concurrency', 8)) } : undefined,
        sockopt: load('sim-sockopt-enabled', false) ? {
            mark: 255,
            tcpFastOpen: load('sim-tfo', false),
            tproxy: "tproxy"
        } : undefined,
        ruDirect: load('sim-ru-direct', false),
        adBlock: load('sim-ad-block', false),
        torMode: load('sim-tor-mode', 'off'),
        altPorts: node ? (() => { try { return localStorage.getItem(`sim-altports-${node.address}:${node.port}`) || ''; } catch { return ''; } })() : '',
        routingRules: customRules.filter(r => r.enabled).map(r => {
          const rule: any = { type: 'field', outboundTag: r.action };
          if (r.type === 'domain') {
            rule.domain = r.pattern.split(',').map(d => d.trim());
          } else if (r.type === 'ip') {
            rule.ip = r.pattern.split(',').map(i => {
              const trimmed = i.trim();
              return (trimmed.includes("/") || /^[0-9.]+$/.test(trimmed) || trimmed.includes(":"))
                ? trimmed
                : "geoip:" + trimmed;
            });
          } else if (r.type === 'geoip') {
            rule.ip = r.pattern.split(',').map(i => "geoip:" + i.trim());
          }
          return rule;
        }),
      };
    }, []);

    // ── Режим «Иммунитет» (фильтр) ─────────────────────────────────────────
    // Туннель поднимается даже когда VPN «выключен»: весь трафик идёт direct
    // (IP не меняется), а правила блокировки (реклама/трекеры/утечки) работают.
    // Настройка живёт в localStorage (sim-shield, её держит SettingsScreen),
    // здесь — только оркестрация сервиса.
    const startShield = useCallback(async (): Promise<boolean> => {
      if (isTogglingRef.current) return false;
      isTogglingRef.current = true;
      try {
        const hasPermission = await nativeRequestVpnPermission();
        if (!hasPermission) return false;
        const baseSettings = await collectVpnSettings(null);
        const routingProfile = profiles.find(p => p.id === activeProfileId)?.routing;
        const configJson = buildShieldConfig(baseSettings, routingProfile);
        const settingsJson = JSON.stringify({ ...baseSettings, core: 'xray', nodeName: 'Иммунитет' });
        // fallbacks '' — явно стирает запасные узлы: в режиме фильтра failover не нужен.
        const res = await nativeStartVpnWithResult(configJson, settingsJson, '', true);
        if (!res.ok) {
          setVpnError(res.error || res.message || 'Не удалось запустить режим Иммунитета');
          return false;
        }
        // startVpnWithResult отвечает сразу после передачи интента — дожидаемся,
        // пока нативка реально поднимет ядро (как в Verification Stage).
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            const s: any = await nativeGetStats();
            if (s && !s.error && (s.status === 'connected' || s.status === 'verified' || s.status === 'running' || s.connectedSec > 0)) {
              setShieldActive(true);
              return true;
            }
          } catch { /* статус уточним на следующей итерации */ }
        }
        // Верификация не увидела живое ядро — гасим сервис, чтобы нативка и UI
        // не разъезжались (работающий щит при выключенном тумблере).
        try { await nativeStopVpn('shield-verify-failed'); } catch { /* уже остановлен */ }
        setVpnError('Режим Иммунитета не запустился — попробуйте ещё раз');
        return false;
      } catch (e) {
        setVpnError(e instanceof Error ? e.message : 'Ошибка запуска режима Иммунитета');
        return false;
      } finally {
        isTogglingRef.current = false;
      }
    }, [collectVpnSettings, profiles, activeProfileId]);

    const stopShield = useCallback(async () => {
      try { await nativeStopVpn('shield-off'); } catch { /* сервис уже остановлен */ }
      setShieldActive(false);
    }, []);

    // Переключатель «Иммунитет» в настройках. Возвращает успех — при false
    // SettingsScreen откатывает тумблер (например, нет VPN-разрешения).
    const handleShieldToggle = useCallback(async (on: boolean): Promise<boolean> => {
      let ok: boolean;
      if (on) {
        // Уже подключены к узлу — щит просто запомнится и поднимется при отключении.
        ok = connectionState !== 'disconnected' ? true : await startShield();
      } else {
        if (shieldActive) await stopShield();
        ok = true;
      }
      // Настройку пишем здесь, а не в вызывающем UI: тумблер в Настройках и чат-команда
      // Петровича сохраняют «Иммунитет» одинаково (иначе после команды из чата щит
      // не пережил бы перезапуск).
      if (ok) save('sim-shield', on);
      return ok;
    }, [connectionState, shieldActive, startShield, stopShield]);

    const handleToggle = useCallback(async () => {
      console.log('[AUTOSTOP] handleToggle invoked, state=', connectionState, 'isToggling=', isTogglingRef.current);
      if (connectionState === 'disconnected' && selectedNode) {
        if (isTogglingRef.current) return;
        isTogglingRef.current = true;
        setVpnError(null);

        // Автоподбор режима обхода (utils/autoBypass.ts): если подключение не подтвердилось,
        // пробуем следующий режим и запоминаем рабочий для этой сети. Для узлов, к которым режимы
        // не относятся (UDP-протоколы, готовые JSON-конфиги), попытка одна — поведение прежнее.
        // Профиль оператора (серверный, utils/operatorProfiles.ts): стартовый режим обхода и дополнительные DNS.
        const opProfile = currentOperatorProfile();
        let attempts: BypassAttempt[] = [{ id: 'user', strategy: null, label: 'ваши настройки' }];
        let netKey = '';
        if (isAutoBypassEnabled() && ladderApplies(selectedNode)) {
          netKey = await currentNetworkKey();
          attempts = planAttempts({
            fragEnable: load('sim-frag-enable', true),
            fragPackets: load('sim-frag-packets', 'tlshello'),
            fragLength: load('sim-frag-length', '10-20'),
            fragInterval: load('sim-frag-interval', '1-5'),
          }, getPreferredStrategy(netKey) ?? opProfile?.bypassFirst ?? null);
        }
        bypassRetryRef.current = attempts.length > 1;
        let attemptNo = 0;
        // Флаг успешного подключения к узлу: после цикла щит возвращаем ТОЛЬКО при неудаче.
        let connectSucceeded = false;

        while (true) {
        try {
          const attempt = attempts[attemptNo];
          // 1. Permission Stage (ПЕРВЫМ ДЕЛОМ)
          const hasPermission = await nativeRequestVpnPermission();
          if (!hasPermission) {
              setConnectionState('disconnected');
              bypassRetryRef.current = false;
              setBypassHint(null);
              isTogglingRef.current = false;
              return;
          }

          // Теперь переключаем статус UI
          setConnectionState('connecting');
          // Подключение к узлу перекроет конфиг щита (shield:false в старте) — UI сразу
          // показывает обычный флоу; если попытка не удастся, фильтр вернём ниже.
          setShieldActive(false);

          // 2. Configuration Stage: общая сборка settings (используется и режимом Иммунитета)
          const baseSettings = await collectVpnSettings(selectedNode);
          const settings = applyAttempt(baseSettings, attempt);

          // Find routing profile for the selected node
          const profile = profiles.find(p => p.nodes.some(n => n.id === selectedNode.id));
          const routingProfile = profile?.routing;

          // ── Выбор ядра ──────────────────────────────────────────────────
          // Xray-core (libgojni) умеет vless/vmess/trojan/ss/wireguard/socks/http.
          // hysteria/hysteria2/tuic/anytls/shadowtls — это mihomo (Clash.Meta).
          // YAML (Clash) тоже исполняет mihomo. Иначе — Xray.
          // ── Ядро и конфиг ──────────────────────────────────────────────────
          // Общий путь с фоновым failover: запасные серверы (native/failover.ts)
          // строят конфиг тем же кодом, что и основное подключение.
          const core = resolveCore(selectedNode);
          const configJson = buildNodeConfig(selectedNode, settings, routingProfile);


          // 3. Xray Start Stage
          const extendedSettings = {
            ...settings,
            core,                                // 'xray' | 'mihomo' — какое ядро запускать
            nodeProtocol: selectedNode.protocol,
            nodeName: selectedNode.name,
            nodeFlag: selectedNode.flag || '',
            serverAddress: selectedNode.address, // Передаем адрес сервера для диагностики
            nodeId: selectedNode.id,             // нативка хранит его в prefs — UI сверяет выбор после фонового failover
          };
          const settingsJson = JSON.stringify(extendedSettings);
          // Фоновый failover: нативка получает готовые запасные конфиги и сама переключается
          // на первый отвечающий, когда приложение закрыто (WebView мёртв). Порядок кандидатов —
          // тот же planFailover, что и в открытом приложении (см. native/failover.ts).
          const fallbacksJson = isFastFailoverEnabled()
            ? buildFallbacks({
                current: selectedNode,
                nodes: allNodesRef.current,
                failedAt: failedAtRef.current,
                settings,
                routingProfile,
                altPortsOf: (n) => { try { return localStorage.getItem(`sim-altports-${n.address}:${n.port}`) || ''; } catch { return ''; } },
                cachedPing: getBestCachedPing,
              })
            : '';
          const res = await nativeStartVpnWithResult(configJson, settingsJson, fallbacksJson);
          if (!res.ok) {
             throw new Error(res.error || res.message || 'Ошибка запуска ядра');
          }

           // 4. Verification Stage
           setConnectionState('verifying');
           let verified = false;
           let lastError = '';
           let notRunningCount = 0;
           // Первая проверка через 200мс — ядро часто стартует быстрее 1с.
           // Далее каждые 500мс, максимум 30с (60 итераций); на повторных попытках автоподбора — 15с.
           const maxVerifyIterations = attemptNo === 0 ? 60 : 30;
           for (let i = 0; i < maxVerifyIterations; i++) {
              await new Promise(r => setTimeout(r, i === 0 ? 200 : 500));
              try {
                 const s = await nativeGetStats();

                 const status = (s as any).status;
                 const err = (s as any).lastError || (s as any).message || '';

                 if (status === 'not_running' || status === 'disconnected') {
                    notRunningCount++;
                    const isTransient = err === 'VPN service not available';
                    if (err && !isTransient) { lastError = err; break; }
                    if (notRunningCount >= 8) { break; } // 4с без сервиса — выходим
                 } else {
                    notRunningCount = 0;
                 }

                 if (status === 'connected' || status === 'verified' || status === 'running' || (s.connectedSec > 0)) {
                    verified = true;
                    break;
                 }

                 if (err) lastError = err;
              } catch (e) {
                 lastError = e instanceof Error ? e.message : 'Unknown error';
              }
           }

           if (verified) {
              connectSucceeded = true;
              setConnectionState('connected');
              save('sim-last-config', { node: selectedNode, config: configJson });
              nativeNotify('Квадрат Петровича', `${selectedNode.name} подключен`);
              nativeVibrate(30);
              nativeClearDnsCache();
           } else {
              let stats: any = {};
              try { stats = await nativeGetStats(); } catch { /* диагностика вторична — не перекрываем исходную ошибку */ }
              const logs: string = stats.startupLogs || '';
              const sErr: string = stats.lastError || '';
              const detail = lastError || sErr || 'статус: ' + (stats.status || '?');
              const logLines = logs.split('\n').filter((l: string) => l.trim()).slice(-10).join('\n');
              const errorMsg = detail + (logLines ? '\n\nЛоги:\n' + logLines : '');
              throw new ConnectVerifyError(errorMsg || 'Не удалось подтвердить соединение');
           }

           // Подключились: если помог подменённый режим — запоминаем его для этой сети.
           if (netKey) recordSuccess(netKey, attempt);
           failoverChainRef.current = []; // подключились — запасные серверы больше не нужны
           break;
        } catch (error) {
          console.error('Connection failed:', error);
          // Пользователь мог отменить подключение (кнопка во время запуска сбрасывает isTogglingRef).
          const cancelled = !isTogglingRef.current;
          if (!cancelled && error instanceof ConnectVerifyError && attemptNo + 1 < attempts.length) {
            attemptNo++;
            setBypassHint(describeAttempt(attemptNo, attempts.length, attempts[attemptNo]));
            await nativeStopVpn('auto-bypass-next-mode').catch(() => {});
            continue;
          }
          // Быстрое переключение: новый сервер не поднялся — пробуем следующего запасного.
          if (!cancelled && failoverChainRef.current.length > 0) {
            const next = failoverChainRef.current.shift()!;
            failedAtRef.current[selectedNode.id] = Date.now();
            nativeNotify('Квадрат Петровича', `Не удалось подключиться — пробую ${next.name}`);
            setSelectedNode(next);
            autoSwitchTargetRef.current = next;
            setConnectionState('disconnected');
            await nativeStopVpn('fast-failover-chain').catch(() => {});
            break;
          }
          setConnectionState('disconnected');
          setVpnError(error instanceof Error ? error.message : 'Ошибка подключения');
          await nativeStopVpn('connect-attempt-threw').catch(() => {});
          break;
        }
        }
        bypassRetryRef.current = false;
        setBypassHint(null);
        isTogglingRef.current = false;
        // Иммунитет: подключение к узлу не состоялось (ошибка/отмена) — возвращаем фильтр,
        // если он включён. Fire-and-forget: свой isTogglingRef-гвард у startShield внутри.
        if (!connectSucceeded && load('sim-shield', false)) void startShield();
      } else if (connectionState === 'connecting' || connectionState === 'verifying' || connectionState === 'reconnecting') {
        // Пользователь нажал «Отменить» во время подключения — сбрасываем всё
        failoverChainRef.current = [];
        isTogglingRef.current = false; // разблокируем кнопку для будущего коннекта
        vpnWasActiveRef.current = false;
        freezeRef.current = { lastDownload: -1, lastUpload: 0, since: 0 };
        consecutiveLatencyFailsRef.current = 0;
        setConnectionState('disconnected');
        setConnectedTime(0);
        // Отмена подключения: если включён Иммунитет — после стопа возвращаем фильтр.
        nativeStopVpn('handleToggle-called-again-during-' + connectionState)
          .then(() => { if (load('sim-shield', false)) void startShield(); })
          .catch(() => {});
      } else if (connectionState === 'connected') {
        if (isTogglingRef.current) return; // защита от двойного тапа на disconnect
        isTogglingRef.current = true;
        vpnWasActiveRef.current = false; // пользователь явно нажал «Отключить»
        failoverChainRef.current = [];
        freezeRef.current = { lastDownload: -1, lastUpload: 0, since: 0 };
        consecutiveLatencyFailsRef.current = 0;
        setConnectionState('disconnecting');
        try { await nativeStopVpn('manual-disconnect-button'); } catch (error) { console.error('Disconnect error:', error); }
        setConnectionState('disconnected');
        setConnectedTime(0);
        nativeNotify('Квадрат Петровича', 'Отключено');
        nativeVibrate(15);
        isTogglingRef.current = false;
        // Иммунитет: после отключения узла поднимаем фильтр (если он включён в настройках).
        if (load('sim-shield', false)) void startShield();
      }
    }, [connectionState, selectedNode, profiles, collectVpnSettings, startShield]);

    // Актуальная ссылка на handleToggle для слушателей авто-реконнекта.
    useEffect(() => { handleToggleRef.current = handleToggle; }, [handleToggle]);

  const handleAddProfile = useCallback((p: SubscriptionProfile) => {
    setProfiles(prev => [...prev, p]);
    if (!activeProfileId) { setActiveProfileId(p.id); if (p.nodes.length) setSelectedNode(p.nodes[0]); }
  }, [activeProfileId]);

  const handleSaveProfile = useCallback((p: SubscriptionProfile) => {
    setProfiles(prev => prev.map(x => x.id === p.id ? p : x));
  }, []);

  const handleDeleteProfile = useCallback((id: string) => {
    setProfiles(p => p.filter(x => x.id !== id));
    if (activeProfileId === id) { setActiveProfileId(null); setSelectedNode(null); if (connectionState === 'connected') handleToggle(); }
  }, [activeProfileId, connectionState, handleToggle]);

  const handleDeleteNodes = useCallback((ids: string[]) => {
    setProfiles(prev => prev.map(p => ({
      ...p,
      nodes: p.nodes.filter(n => !ids.includes(n.id))
    })));
    if (selectedNode && ids.includes(selectedNode.id)) setSelectedNode(null);
  }, [selectedNode]);

  // silent=true для фоновых обновлений (периодических/ежедневных) — без системных
  // уведомлений «Обновлено…», чтобы они не сыпались постоянно. Ручное обновление
  // (кнопка в Профилях/на главной) шлёт уведомление как обычно.
  // force — ручное действие (кнопка или чат Петровича): Happ-сравнение перепроверяется сразу,
  // не дожидаясь недельного интервала; фоновые автообновления оставляют память как есть.
  const handleUpdateProfile = useCallback(async (id: string, silent = false, force = !silent) => {
    const profile = profiles.find(p => p.id === id);
    if (!profile?.url) return false;

    try {
      // Обновление подписки идёт напрямую (приложение само мимо VPN — как disallowed).
      // Если провайдер/оператор режет подписку напрямую или она доступна только с exit-IP —
      // молча повторяем запрос через уже поднятый туннель (локальный SOCKS ядра; настройка).
      const viaVpnPort = load('sim-update-via-vpn', true) && connStateRef.current === 'connected'
        ? Number(load('sim-socks-port', '10808')) || 10808
        : undefined;
      updateViaTunnelRef.current = false;
      // Запасной адрес от провайдера (fallback-url): если основной не отвечает — пробуем его, ждём не дольше 9 с.
      const fallbackUrl = profile.managed?.fallbackUrl;
      const userAgent = userAgentFor(profile);
      let res: string | FetchResult = '';
      // Какой User-Agent даёт у этого провайдера больше данных (описания серверов и т.п.) — приложение выясняет само.
      let uaPreference = profile.fetchUa;
      const fetchSmart = async (port?: number) => {
        const smart = await fetchSubscription(profile.url, { userAgent, preference: profile.fetchUa, viaSocksPort: port, force });
        // ok:false — ответ дошёл, но с ошибкой (например, 403 от заблокированного хоста) — считаем неудачей.
        if (typeof smart.res === 'object' && smart.res !== null && smart.res.ok === false) throw new Error(smart.res.error || 'ошибка загрузки');
        res = smart.res;
        uaPreference = smart.preference;
      };
      try {
        await fetchSmart();
      } catch (primaryDirectError) {
        let done = false;
        if (viaVpnPort) {
          try { await fetchSmart(viaVpnPort); updateViaTunnelRef.current = true; done = true; } catch { /* и через туннель не вышло — идём дальше */ }
        }
        if (!done) {
          if (!fallbackUrl) throw primaryDirectError;
          const viaTunnelFallback = async () => {
            res = await Promise.race([
              nativeFetchUrlViaProxy(fallbackUrl, viaVpnPort!, userAgent),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('запасной адрес не ответил')), 9000)),
            ]);
          };
          try {
            res = await Promise.race([
              nativeFetchUrl(fallbackUrl, userAgent),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('запасной адрес не ответил')), 9000)),
            ]);
          } catch (fallbackDirectError) {
            if (!viaVpnPort) throw fallbackDirectError;
            await viaTunnelFallback();
            updateViaTunnelRef.current = true;
          }
        }
      }
      const resObj = (typeof res === 'object' && res !== null && !Array.isArray(res)) ? (res as any) : null;
      const content = resObj ? (resObj.body || '') : String(res);
      const userInfo = resObj?.userInfo;
      const webPage = resObj?.webPage;
      const updateInterval = resObj?.updateInterval;
      const supportUrl = resObj?.supportUrl;
      const responseHeaders: Record<string, string> | undefined = resObj?.headers;

      if (!content || !String(content).trim()) {
        setProfiles(prev => prev.map(p => p.id === id ? { ...p, status: 'error', updateError: 'Пустой ответ от сервера' } : p));
        if (!silent) nativeNotify('Квадрат Петровича', `Подписка ${profile.name} пуста`);
        return false;
      }

      const newUrl = resObj?.newUrl || responseHeaders?.['profile-update-url'];
      const result = parseSubscription(String(content), userInfo, responseHeaders);
      if (result.nodes.length > 0 || result.routing) {
        setProfiles(prev => {
          const updated = prev.map(p => {
            if (p.id !== id) return p;

            const traffic = result.traffic || p.traffic;
            const status = statusFromTraffic(traffic);

            const newName = result.name || p.name;

            return applyManagement({
              ...p,
              name: newName,
              url: (newUrl && newUrl !== p.url) ? newUrl : p.url,
              nodes: result.nodes,
              routing: result.routing || p.routing,
              traffic,
              notices: result.notices || p.notices,
              webPage: webPage || result.webPage || p.webPage,
              updateInterval: updateInterval || result.updateInterval || p.updateInterval,
              supportUrl: supportUrl || result.supportUrl || p.supportUrl,
              fetchUa: uaPreference,
              updatedAt: new Date().toLocaleString('ru-RU'),
              lastUpdateTimestamp: Date.now(),
              status,
              updateError: undefined
            }, result.managed);
          });

          // Selection Healing: if selected node is lost, try to find a match by address/port in the updated profile
          if (selectedNode) {
            const stillExists = updated.some(p => p.nodes.some(n => n.id === selectedNode.id));
            if (!stillExists) {
              // Сначала по названию (у JSON-конфигов несколько серверов могут делить адрес и порт), затем по адресу и порту.
              const matchedNode = result.nodes.find(n => n.name === selectedNode.name)
                ?? result.nodes.find(n => n.address === selectedNode.address && n.port === selectedNode.port);
              if (matchedNode) {
                console.log('Selection healed: found matching node by address', matchedNode.id);
                setSelectedNode(matchedNode);
              }
            }
          }

          // Не вызываем save() здесь — useEffect на profiles уже сохраняет при каждом изменении.
          return updated;
        });
        if (!silent) nativeNotify('Квадрат Петровича', `Обновлено: ${profile.name}`);
        return true;
      } else {
        setProfiles(prev => prev.map(p => p.id === id ? { ...p, status: 'error', updateError: 'Серверы не найдены в подписке' } : p));
        if (!silent) nativeNotify('Квадрат Петровича', `В ${profile.name} не найдено серверов`);
        return false;
      }
    } catch (e) {
      // Сырые сетевые ошибки содержат адреса серверов (x.petrovich.party/193.187.93.181:443) —
      // показываем понятный текст без URL, хостов и портов.
      const reason = friendlyUpdateError(e);
      setProfiles(prev => prev.map(p => p.id === id ? { ...p, status: 'error', updateError: reason } : p));
      if (!silent) nativeNotify('Квадрат Петровича', `Ошибка обновления ${profile.name}`);
      return false;
    }
  }, [profiles]);

  // Обновляем refs ПОСЛЕ объявления функций — избегаем TDZ ReferenceError.
  useEffect(() => { handleUpdateProfileRef.current = handleUpdateProfile; }, [handleUpdateProfile]);

  // Push-уведомление об окончании подписки за 3 дня, если провайдер включил notification-subs-expire
  // (плашка в приложении — отдельный параметр sub-expire): не чаще раза в сутки на профиль.
  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    for (const p of profiles) {
      const text = expiryNotice(p, Date.now(), 'push');
      if (!text) continue;
      const key = `sim-expire-notified-${p.id}`;
      if (load<string>(key, '') === today) continue;
      save(key, today);
      nativeNotify('Квадрат Петровича', text);
    }
  }, [profiles]);
  useEffect(() => { profilesRef.current = profiles; }, [profiles]);

  // Возобновление оплаты после перезапуска: запись о незавершённом платеже лежит в хранилище
  // (см. utils/cabinetApi.ts) — полляем статус фоном: PAID → обновляем профиль и уведомляем
  // (ровно один раз: CAS через clearRenewalPending — модал может поллить тот же платёж),
  // FAILED → сообщаем, по сроку (PENDING_TTL_MS) → снимаем молча. Когда записи нет —
  // просто следим, не появилась ли новая оплата (модал «Открыть ещё раз»/Отмена живут своей жизнью).
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const schedule = (ms: number) => { if (!cancelled) timer = window.setTimeout(tick, ms); };
    async function tick() {
      if (cancelled) return;
      const pending = loadRenewalPending();
      if (!pending) { schedule(15_000); return; }
      const profile = profilesRef.current.find(p => p.id === pending.profileId);
      if (!profile) { clearRenewalPending(pending.paymentId); schedule(15_000); return; }
      if (Date.now() - pending.createdAt > PENDING_TTL_MS) { clearRenewalPending(pending.paymentId); schedule(15_000); return; }
      try {
        const status = await fetchPaymentStatus(profile, pending.paymentId);
        if (status === 'PAID') {
          if (clearRenewalPending(pending.paymentId)) {
            nativeNotify('Квадрат Петровича', 'Подписка продлена');
            try {
              // Покупка нового тарифа может выдать новую ссылку подписки — сохраняем до обновления.
              const newUrl = await fetchSubscriptionUrl(profile);
              if (newUrl && newUrl !== profile.url) {
                setProfiles(prev => prev.map(x => x.id === profile.id ? { ...x, url: newUrl } : x));
                await new Promise(r => setTimeout(r, 250));
              }
            } catch { /* за новой ссылкой — при следующем обновлении профиля */ }
            try { await handleUpdateProfileRef.current?.(profile.id, true); } catch { /* срок обновится вручную */ }
          }
          schedule(15_000); return;
        }
        if (status === 'FAILED') {
          if (clearRenewalPending(pending.paymentId)) nativeNotify('Квадрат Петровича', 'Оплата не прошла — попробуйте ещё раз');
          schedule(15_000); return;
        }
      } catch { /* сеть моргнула — продолжаем поллинг */ }
      schedule(10_000);
    }
    schedule(5_000);
    return () => { cancelled = true; if (timer !== null) clearTimeout(timer); };
  }, []);

  // Приложения и подсети в обход туннеля от доверенного провайдера (per-app-proxy-*, exclude-routes*): планы лежат в
  // localStorage, к устройству применяются один раз после каждого изменения.
  useEffect(() => { void applyManagedNative(); }, [profiles]);

  const handleSetActive = useCallback((id: string) => {
    setActiveProfileId(id);
    const p = profiles.find(x => x.id === id);
    if (p?.nodes.length) setSelectedNode(p.nodes[0]);
    if (connectionState === 'connected') handleToggle();
  }, [profiles, connectionState, handleToggle]);

  const handleSwipe = (direction: 'left' | 'right') => {
    const currentIndex = SCREEN_ORDER.indexOf(screen);
    if (currentIndex === -1) return;

    if (direction === 'left' && currentIndex < SCREEN_ORDER.length - 1) {
      setScreen(SCREEN_ORDER[currentIndex + 1]);
      nativeVibrate(15);
    } else if (direction === 'right' && currentIndex > 0) {
      setScreen(SCREEN_ORDER[currentIndex - 1]);
      nativeVibrate(15);
    }
  };

  const bg = 'bg-[#0a0a1a]';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className={`min-h-screen min-h-[100dvh] w-full max-w-[100vw] overflow-hidden ${bg} flex`}
    >
      {showOnboarding && (
        <Onboarding onDone={() => { save('sim-onboarded', true); setShowOnboarding(false); }} />
      )}

      {!showOnboarding && <UpdatePrompt />}

      {pendingDeepLink && (
        <DeepLinkConfirm
          action={pendingDeepLink}
          onCancel={() => setPendingDeepLink(null)}
          onConfirm={() => { const a = pendingDeepLink; setPendingDeepLink(null); runDeepLinkAction(a); }}
        />
      )}

      {showBatterySheet && !showOnboarding && (
        <BatteryPermSheet
          trigger={batterySheetTrigger}
          onDone={() => { save('sim-battery-perm-done', true); setShowBatterySheet(false); }}
        />
      )}

      <DesktopSidebar activeScreen={screen} onNavigate={setScreen} />

      <main className="flex-1 flex flex-col min-h-screen min-h-[100dvh] w-full max-w-full lg:ml-[220px] xl:ml-[260px] relative overflow-hidden">
        <motion.div
          className="flex-1 flex flex-col min-h-0 w-full"
          drag="x"
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.1}
          onDragEnd={(_, info) => {
            const threshold = 50;
            if (info.offset.x < -threshold) handleSwipe('left');
            else if (info.offset.x > threshold) handleSwipe('right');
          }}
        >
          <div className={`page-wash flex-1 min-h-0 ${bg} pb-[calc(72px+env(safe-area-inset-bottom,0px))] lg:pb-0 relative`}>
            {/* Мгновенное переключение разделов без анимации перехода: на бюджетном
                WebView AnimatePresence mode="popLayout" держал оба экрана и считал
                layout-анимацию → подвисание при переходах. У экранов есть свои анимации. */}
            {/* Предохранитель: ошибка рендера одного экрана не должна сносить всё
                окно (раньше падал весь UI → белый экран и reload-петля на desktop).
                key={screen} сбрасывает границу при переходе, поэтому навигация жива. */}
            <ErrorBoundary
              key={screen}
              fallback={
                <div className="h-full w-full flex flex-col items-center justify-center gap-4 p-8 text-center">
                  <p className="text-white text-base font-semibold">Не удалось открыть этот раздел</p>
                  <p className="text-gray-500 text-xs max-w-xs">Произошла ошибка в интерфейсе. Остальное приложение работает — вернитесь на главную.</p>
                  <button onClick={() => setScreen('home')}
                    className="px-5 py-2.5 rounded-xl bg-[var(--accent)] text-black text-xs font-bold uppercase tracking-widest active:scale-95">
                    На главную
                  </button>
                </div>
              }>
            <div className="h-full w-full">
                {screen === 'home' && (
                  <div className="flex h-full w-full overflow-hidden lg:h-[100dvh] lg:max-h-[100dvh]">
                    {/* Десктоп: профиль + серверы слева сразу на главной (на мобильном скрыто) */}
                    <HomeProfilePanel
                      profiles={profiles}
                      activeProfileId={activeProfileId}
                      activeNodeId={selectedNode?.id}
                      onSelectNode={setSelectedNode}
                      onSetActive={handleSetActive}
                      onUpdateProfile={handleUpdateProfile}
                      onSaveProfile={handleSaveProfile}
                      onGoToProfiles={() => setScreen('profiles')}
                    />
                    {/* Правая часть с кнопкой закреплена и не скроллится — крутится только список серверов слева */}
                    <div className="flex-1 min-w-0 h-full overflow-hidden">
                      <HomeScreen connectionState={connectionState} onToggle={handleToggle} selectedNode={selectedNode} nodes={allNodes} onSelectNode={setSelectedNode} onGoToServers={() => setScreen('servers')} onGoToProfiles={() => setScreen('profiles')} connectedTime={connectedTime} hasNodes={allNodes.length > 0} vpnError={vpnError} onClearVpnError={() => setVpnError(null)} stats={stats} bypassHint={bypassHint} hideServerDetails={!!selectedNode && settingsHidden(profiles.find(p => p.nodes.some(n => n.id === selectedNode.id)))} shieldActive={shieldActive} />
                    </div>
                  </div>
                )}
                {screen === 'servers' && <ServerList nodes={allNodes} profiles={profiles} activeProfileId={activeProfileId} selectedNode={selectedNode} onSelect={setSelectedNode} onBack={() => setScreen('home')} isConnected={connectionState === 'connected'} onDeleteNodes={handleDeleteNodes} connectedTime={connectedTime} autoSwitch={autoSwitch} onAutoSwitchChange={setAutoSwitch} />}
                {screen === 'profiles' && <ProfilesScreen onBack={() => setScreen('home')} profiles={profiles} onAddProfile={handleAddProfile} onDeleteProfile={handleDeleteProfile} onUpdateProfile={handleUpdateProfile} onSaveProfile={handleSaveProfile} onAddSingleNode={handleAddSingleNode} onSelectNode={setSelectedNode} activeNodeId={selectedNode?.id} activeProfileId={activeProfileId} onSetActive={handleSetActive} onImportRouting={handleImportRouting} />}
                {screen === 'settings' && <SettingsScreen onBack={() => setScreen('home')} isConnected={connectionState === 'connected'} onShowLogs={() => setScreen('debug')} onShieldToggle={handleShieldToggle} />}
                {screen === 'dns' && <DnsSettingsScreen onBack={() => setScreen('settings')} />}
                {screen === 'debug' && <DebugScreen onBack={() => setScreen('settings')} />}
                {screen === 'dashboard' && (
                  <DashboardScreen
                    onBack={() => setScreen('home')}
                    isConnected={connectionState === 'connected'}
                    selectedNode={selectedNode}
                    allNodes={allNodes}
                    connectedTime={connectedTime}
                  />
                )}
            </div>
            </ErrorBoundary>
          </div>

          </motion.div>

        <MobileNav activeScreen={screen} onNavigate={setScreen} />
      </main>
    </motion.div>
  );
}
