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
import { DesktopSidebar, MobileNav } from './components/BottomNav';
import { AppScreen, ConnectionState, ServerNode, SubscriptionProfile, RoutingProfile } from './types';
import { generateId, parseSubscription, parseSimUrl, detectPanelType, decodeProfileTitle, guessSubscriptionName, parseLink } from './data';
import { useTheme } from './ThemeContext';
import { buildMihomoConfig, shouldUseMihomo } from './native/mihomoConfig';
import { runIspDetection } from './utils/ispPreset';
import { nativeStopVpn, nativeNotify, nativeRequestVpnPermission, nativeFetchUrl, buildXrayConfig, isProtocolSupportedByCore, isNative, nativeGetStats, nativeSetStatusBarStyle, nativeStartVpnWithResult, nativeToggleKillSwitch, nativeStartNetworkMonitoring, nativeStopNetworkMonitoring, nativeMinimizeApp, nativeVibrate, VpnStats, nativeGetRoutingRules, nativeRequestAllPermissions, nativeTestProxyDelay, nativeGetPendingDeepLink, nativeTestIpLeak, nativeTestDnsLeak, type FetchResult, nativeStartAntiFilterBatch, refreshAntiFilterCache, nativePingNode, startPingBatch, getBestCachedPing, nativeClearDnsCache } from './native/bridge';

function load<T>(key: string, fb: T): T { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fb; } catch { return fb; } }
function save(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

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
  console.log('App component rendered');
  const { isDark } = useTheme();
  const [screen, setScreen] = useState<AppScreen>('home');
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => !load('sim-onboarded', false));
  const [showBatterySheet, setShowBatterySheet] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
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
          console.log('[SIM-MIGRATE] json→' + parsed.protocol + ' ' + parsed.address);
          return parsed;
        }
        // placeholder / нераспознанная ссылка (напр. vless://0.0.0.0:1#Приложение не поддерживается)
        console.log('[SIM-MIGRATE] drop placeholder node: ' + raw.slice(0, 60));
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
    console.log('[SIM-BOOT] profiles=' + mapped.length + ' nodes=' + (mapped[0]?.nodes?.slice(0,3).map((n:any)=>n.protocol+':'+String(n.address).slice(0,12)).join('|')||'empty'));
    return mapped;
  });
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() => load('sim-active-profile', null));
  const [selectedNode, setSelectedNode] = useState<ServerNode | null>(() => load('sim-selected-node', null));
  const [connectedTime, setConnectedTime] = useState(0);
  const [vpnError, setVpnError] = useState<string | null>(null);
  const [stats, setStats] = useState<VpnStats | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRef = useRef(false);
  const leakCheckedRef = useRef(false);
  // Авто-реконнект при смене сети: ссылки на актуальные значения и защёлки.
  const connStateRef = useRef<ConnectionState>('disconnected');
  const handleToggleRef = useRef<() => void>(() => {});
  const handleUpdateProfileRef = useRef<(id: string, silent?: boolean) => void>(() => {});
  const profilesRef = useRef<typeof profiles>([]);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vpnWasActiveRef = useRef(false); // VPN был запущен пользователем и не остановлен вручную
  const [autoSwitch, setAutoSwitch] = useState(() => localStorage.getItem('autoSwitch') === 'true');
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
            setConnectionState('connected');
            if (s.connectedSec > 0) setConnectedTime(s.connectedSec);
            setStats(s);
          }
        } catch { /* ignore */ }
      })();
    }, []);

    // Держим актуальные значения connectionState в рефе (нужен в других эффектах).
    useEffect(() => {
      connStateRef.current = connectionState;
      if (connectionState === 'connected') vpnWasActiveRef.current = true;
    }, [connectionState]);

    useEffect(() => { localStorage.setItem('autoSwitch', String(autoSwitch)); }, [autoSwitch]);
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
      if (!autoSwitch || connectionState !== 'connected' || !selectedNode) return;
      const interval = setInterval(async () => {
        if (!autoSwitchRef.current || connStateRef.current !== 'connected' || isPausedRef.current) return;
        if (!selectedNode.address || !selectedNode.port) return;
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
        nativeNotify('Sim Proxy', `Авто-переключение → ${bestNode.name}`);
        setSelectedNode(bestNode);
        autoSwitchTargetRef.current = bestNode;
        try { await nativeStopVpn('bad-ping-autoswitch'); } catch {}
        setConnectionState('disconnected');
        setConnectedTime(0);
      }, 60_000);
      return () => clearInterval(interval);
    }, [autoSwitch, connectionState, selectedNode, allNodes]);

    // Импорт подписки по ссылке из deep link (sim://import/<sub-url>, sim://add/<url>…).
    const importSubscriptionFromUrl = useCallback(async (rawUrl: string) => {
      let url = rawUrl.trim();
      if (!url.startsWith('http')) url = 'https://' + url;
      nativeNotify('Sim Proxy', 'Загрузка подписки…');
      try {
        const result = await nativeFetchUrl(url);
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
        const newProfile: SubscriptionProfile = {
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
          status: 'healthy',
        };
        // Добавляем профиль напрямую (handleAddProfile объявлен ниже по файлу —
        // не ссылаемся на него отсюда во избежание temporal dead zone).
        setProfiles(prev => [...prev, newProfile]);
        if (!activeProfileId) {
          setActiveProfileId(newProfile.id);
          if (newProfile.nodes.length) setSelectedNode(newProfile.nodes[0]);
        }
        if (parsed.routing) handleImportRouting(parsed.routing, true);
        setScreen('profiles');
        nativeNotify('Sim Proxy', `Подписка «${name}»: ${parsed.nodes.length} серверов`);
      } catch (e: any) {
        nativeNotify('Ошибка подписки', e?.message || 'Проверьте ссылку и интернет');
      }
    }, [activeProfileId, handleImportRouting]);

    useEffect(() => {
      const processDeepLink = (uri: string) => {
        if (!uri) return;
        console.log('Deep link received:', uri);
        const action = parseSimUrl(uri);
        if (!action) return;
        if (action.type === 'import') {
          const node = action.nodes[0];
          if (node) {
            handleAddSingleNode(node);
            setScreen('servers');
            nativeNotify('Sim Proxy', `Импортирован сервер: ${node.name}`);
          }
        } else if (action.type === 'subscribe') {
          importSubscriptionFromUrl(action.url);
        } else if (action.type === 'routing_add') {
          handleImportRouting(action.profile, action.activate);
          setScreen('settings');
          nativeNotify('Sim Proxy', `Импортирован профиль маршрутизации: ${action.profile.Name}`);
        } else if (action.type === 'vpn_on') {
          if (connStateRef.current === 'disconnected') handleToggleRef.current();
        } else if (action.type === 'vpn_off') {
          if (connStateRef.current === 'connected') handleToggleRef.current();
        }
      };

      const handleDeepLink = (e: any) => processDeepLink(e.detail);
      window.addEventListener('deeplink', handleDeepLink);

      // Холодный старт: забираем ссылку, пришедшую до навешивания слушателя.
      nativeGetPendingDeepLink().then(uri => { if (uri) processDeepLink(uri); }).catch(() => {});

      return () => window.removeEventListener('deeplink', handleDeepLink);
    }, [handleAddSingleNode, handleImportRouting, importSubscriptionFromUrl]);

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

  // Уведомление об истечении подписки: один раз за сессию, если ≤3 дней.
  useEffect(() => {
    if (!isNative()) return;
    if (sessionStorage.getItem('sim-expiry-notified')) return;
    const active = profiles.find(p => p.id === activeProfileId);
    const days = active?.traffic?.remainingDays;
    if (typeof days === 'number' && days <= 3) {
      sessionStorage.setItem('sim-expiry-notified', '1');
      nativeNotify('Sim Proxy', days <= 0 ? 'Подписка истекла!' : `Подписка истекает через ${days} дн.`);
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

  // Показываем подсказку про батарею только когда VPN сам упал в фоне (watchdog).
  // Пользователь уже видит проблему — объяснение приходит вовремя.
  useEffect(() => {
    if (!isNative()) return;
    const onDropped = () => {
      if (!load('sim-battery-perm-done', false)) setShowBatterySheet(true);
    };
    window.addEventListener('vpn-dropped-in-background', onDropped);
    return () => window.removeEventListener('vpn-dropped-in-background', onDropped);
  }, []);

  useEffect(() => { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); }, []);

  useEffect(() => {
    if (autoRef.current) return; autoRef.current = true;

    // POST_NOTIFICATIONS — тихий системный диалог, не пугает
    if (isNative()) {
      nativeRequestAllPermissions().catch(console.error);
    }

    if (load('sim-autoconnect', false) && selectedNode) {
      // Используем ref чтобы избежать stale closure — handleToggleRef всегда
      // указывает на актуальную версию функции на момент вызова.
      setTimeout(() => handleToggleRef.current?.(), 500);
    }

    // ISP auto-preset: определяем оператора по IP/ASN и применяем DPI-пресет
    setTimeout(() => detectAndApplyIspPreset(), 1500);

    const lastUpdate = load('sim-last-auto-update', 0);
    const now = Date.now();
    if (now - lastUpdate > 24 * 60 * 60 * 1000) {
      setTimeout(() => {
        console.log('Running scheduled auto-update for subscriptions...');
        // handleUpdateProfileRef указывает на актуальную версию — profiles уже загружены
        profilesRef.current.forEach(p => {
          if (p.url && p.autoUpdate) handleUpdateProfileRef.current?.(p.id, true);
        });
        save('sim-last-auto-update', Date.now());
      }, 5000);
    }
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
            const parts: string[] = [];
            if (ipLeak) parts.push('IP');
            if (dnsLeak) parts.push('DNS');
            nativeNotify('⚠️ Обнаружена утечка', `Возможная утечка ${parts.join(' и ')}. Проверьте Dashboard.`);
            nativeVibrate(60);
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

      timerRef.current = setInterval(() => {
        setConnectedTime(t => t + 1);
      }, 3000);

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

       const pollStats = async () => {
         if (isPollingRef.current) return; // предотвращаем конкурентные вызовы при медленном bridge
         isPollingRef.current = true;
         try {
             const curState = connStateRef.current;
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
               nativeStopVpn(isCrashed ? 'isCrashed-not_running' : 'js-error-field').catch(console.error);
               // VPN упал — переподключаемся только если смена сети была недавно (< 20с).
               // lastNetworkEventRef не очищается watchdog, поэтому работает даже после
               // того как трафик пошёл и networkChangedRef был сброшен в 0.
               const msSinceNetEvent = Date.now() - lastNetworkEventRef.current;
               if (vpnWasActiveRef.current && msSinceNetEvent < 20_000) {
                 setTimeout(() => {
                   if (connStateRef.current === 'disconnected') handleToggleRef.current();
                 }, 2_000);
               }
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
               nativeNotify('Sim Proxy', 'Зависание VPN — переподключение…');
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
                 nativeNotify('Sim Proxy', 'Зависание VPN — переподключение…');
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

    const handleToggle = useCallback(async () => {
      console.log('[AUTOSTOP] handleToggle invoked, state=', connectionState, 'isToggling=', isTogglingRef.current);
      if (connectionState === 'disconnected' && selectedNode) {
        if (isTogglingRef.current) return;
        isTogglingRef.current = true;
        setVpnError(null);

        try {
          // 1. Permission Stage (ПЕРВЫМ ДЕЛОМ)
          const hasPermission = await nativeRequestVpnPermission();
          if (!hasPermission) {
              setConnectionState('disconnected');
              return;
          }

          // Теперь переключаем статус UI
          setConnectionState('connecting');

          // 2. Configuration Stage
          const customRules = await nativeGetRoutingRules();

          const defaultSocksPort = load('sim-socks-port', '10808');
          const dnsAddr = load('sim-dns-address', '1.1.1.1');
          // udpgwAddress пустой по умолчанию — в этом проекте нет отдельного udpgw-демона.
          // tun2socks при пустом адресе использует SOCKS UDP ASSOCIATE (Xray поддерживает udp:true).
          const defaultUdpGwAddress = load('sim-udpgw-address', '');
          const defaultTunAddress = load('sim-tun-address', '172.19.0.1');
          const defaultTunNetmask = load('sim-tun-netmask', '255.255.255.252');

          // Legacy VPN Address setting is obsolete; TUN Address is the single VPN/TUN interface IP.
          localStorage.removeItem('sim-vpn-address');

          const settings = {
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
            noisesEnable: load('sim-noises-enable', false),
            noisesType: load('sim-noises-type', 'rand'),
            noisesDelay: load('sim-noises-delay', '50'),
            noisesRand: load('sim-noises-rand', '1-1024'),
            uTlsFingerprint: load('sim-utls-fingerprint', 'chrome'),
            mtu: load('sim-mtu', '1280'),
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
            altPorts: (() => { try { return localStorage.getItem(`sim-altports-${selectedNode.address}:${selectedNode.port}`) || ''; } catch { return ''; } })(),
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

          // Find routing profile for the selected node
          const profile = profiles.find(p => p.nodes.some(n => n.id === selectedNode.id));
          const routingProfile = profile?.routing;

          // ── Выбор ядра ──────────────────────────────────────────────────
          // Xray-core (libgojni) умеет vless/vmess/trojan/ss/wireguard/socks/http.
          // hysteria/hysteria2/tuic/anytls/shadowtls — это mihomo (Clash.Meta).
          // YAML (Clash) тоже исполняет mihomo. Иначе — Xray.
          const rawTrim = selectedNode.rawLink.trim();
          const isClashYaml = rawTrim.includes('proxies:') || rawTrim.includes('proxy-groups:');
          const useMihomo = isClashYaml || shouldUseMihomo(selectedNode.protocol);
          // Протоколы, которые НЕ умеет ни одно из подключённых ядер.
          if (!useMihomo && !isProtocolSupportedByCore(selectedNode.protocol)
              && selectedNode.protocol !== 'json'
              && !rawTrim.startsWith('{') && !rawTrim.startsWith('[')) {
            throw new Error(
              `Протокол ${selectedNode.protocol.toUpperCase()} не поддерживается. ` +
              `Выберите сервер с VLESS/VMess/Trojan/Shadowsocks/WireGuard/Hysteria2/TUIC.`
            );
          }

          const core: 'xray' | 'mihomo' = useMihomo ? 'mihomo' : 'xray';
          let configJson: string;

          // Прямой путь mihomo для share-link нод hysteria2/tuic/anytls и т.п.:
          // генерируем mihomo-конфиг из ноды (TUN fd подставит Java-сторона).
          if (useMihomo && !isClashYaml) {
            configJson = buildMihomoConfig(selectedNode, settings);
          } else
          try {
            // ДЕТЕКЦИЯ YAML (MIHOMO/CLASH)
            let rawLinkTrimmed = selectedNode.rawLink.trim();
            const isYaml = rawLinkTrimmed.includes('proxies:') || rawLinkTrimmed.includes('proxy-groups:');

            if (isYaml) {
               // АДАПТАЦИЯ MIHOMO YAML: подменяем SOCKS порт на системный
               const sPort = Number(settings.socksPort);
               if (rawLinkTrimmed.includes('socks-port:')) {
                   rawLinkTrimmed = rawLinkTrimmed.replace(/socks-port:\s*\d+/g, `socks-port: ${sPort}`);
               } else if (rawLinkTrimmed.includes('mixed-port:')) {
                   rawLinkTrimmed = rawLinkTrimmed.replace(/mixed-port:\s*\d+/g, `socks-port: ${sPort}`);
               } else {
                   rawLinkTrimmed = `socks-port: ${sPort}\n${rawLinkTrimmed}`;
               }
               configJson = rawLinkTrimmed;
            } else if (selectedNode.protocol === 'json' || (rawLinkTrimmed.startsWith('{') && rawLinkTrimmed.endsWith('}')) || rawLinkTrimmed.startsWith('[')) {
              let finalConfig: any;
              try {
                const parsedRaw = JSON.parse(rawLinkTrimmed);
                finalConfig = Array.isArray(parsedRaw) ? parsedRaw[0] : parsedRaw;
              } catch (e) {
                console.error("Failed to parse JSON config", e);
                throw new Error("Ошибка формата JSON конфига");
              }

              if (finalConfig && typeof finalConfig === 'object') {
                const sPort = Number(settings.socksPort) || 10808;

                // ВАЖНО: используем конфиг пользователя КАК ЕСТЬ (как Happ).
                // Сохраняем outbounds, balancers, routing, dns, observatory, policy — там
                // маршрутизация по сервисам (Telegram->balancer, Instagram->cand-02,
                // РФ-госсайты->direct и т.д.), которая и заставляет всё работать.
                // Меняем ТОЛЬКО inbounds (под TUN fd) и чистим Android-несовместимый sockopt.

                // Системные секции десктоп-клиента, требующие отдельных inbound'ов, — убираем.
                // (observatory и routing.balancers НЕ трогаем — они нужны балансировщику.)
                delete finalConfig.test;
                delete finalConfig.api;
                delete finalConfig.stats;
                // КРИТИЧНО: убираем metrics (Prometheus-endpoint серверного мониторинга).
                // Если в конфиге есть и metrics, и stats — xray-core паникует при старте:
                // "panic: Reuse of exported var name: stats" (SIGABRT в треде XrayCore,
                // приложение вылетает на Android; «ошибка ядра» на Windows).
                delete finalConfig.metrics;

                // Инбаунды: наш SOCKS (для readiness-пробы) + TUN (fd из coreRunLoopWithTun).
                // НЕ ставить "dns" в destOverride — это невалидный протокол сниффинга.
                finalConfig.inbounds = [
                    {
                        tag: "socks-in",
                        port: sPort,
                        listen: "127.0.0.1",
                        protocol: "socks",
                        settings: { udp: true, auth: "noauth", userLevel: 8 },
                        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], routeOnly: false }
                    },
                    {
                        tag: "tun",
                        protocol: "tun",
                        settings: { mtu: 1280, stack: "gvisor" },
                        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] }
                    }
                ];

                // Чистим только Android-несовместимые sockopt-поля (interface/mark).
                // mux, dialerProxy, reality, congestion, flow и пр. — СОХРАНЯЕМ.
                if (!Array.isArray(finalConfig.outbounds)) finalConfig.outbounds = [];
                finalConfig.outbounds.forEach((ob: any) => {
                    if (ob?.streamSettings?.sockopt) {
                        delete ob.streamSettings.sockopt.interface;
                        delete ob.streamSettings.sockopt.mark;
                    }
                    // mux несовместим с xtls-rprx-vision и через этот форк ломает ВСЕ
                    // соединения (gstatic тоже падал). Выключаем mux на всех аутбаундах.
                    if (ob && ob.mux) ob.mux = { enabled: false };

                    // XHTTP extra: только `uplinkDataPlacement` РОНЯЕТ ядро (access
                    // violation при старте xhttp-дайлера в xray 26.5.9).
                    // ВСЕ ОСТАЛЬНЫЕ поля (uplinkHTTPMethod, xPaddingMethod, xPaddingObfsMode,
                    // xPaddingPlacement и др.) — это легитимные поля Happ/форк-ядра:
                    // они определяют CDN-обфускацию WL-аутбаундов (xmux, tokenish-padding).
                    // Удаление этих полей ломает WL CDN-транспорт на сетях с DPI-фильтрацией.
                    const extra = ob?.streamSettings?.xhttpSettings?.extra;
                    if (extra && typeof extra === 'object') {
                        delete extra['uplinkDataPlacement'];
                    }
                });

                // КРИТИЧНО: Xray отклоняет ВЕСЬ конфиг, если два outbound'а имеют
                // одинаковый tag ("app/proxyman/outbound: existing tag found: <tag>" →
                // ядро не стартует, статус not_running). Пользовательские конфиги и
                // подписки иногда содержат дубль (напр. вендорский и свой сервер оба с
                // тегом "proxy"). Оставляем ПЕРВЫЙ outbound каждого тега, последующие
                // дубли отбрасываем — конфиг становится валидным, маршрутизация по тегам цела.
                {
                    const seenTags = new Set<string>();
                    const before = finalConfig.outbounds.length;
                    finalConfig.outbounds = finalConfig.outbounds.filter((ob: any) => {
                        const tag = ob && typeof ob.tag === 'string' ? ob.tag : '';
                        if (!tag) return true;                 // без тега — оставляем
                        if (seenTags.has(tag)) return false;   // дубликат — выкидываем
                        seenTags.add(tag);
                        return true;
                    });
                    if (finalConfig.outbounds.length !== before) {
                        console.warn(`Удалены дубликаты outbound-тегов: ${before} → ${finalConfig.outbounds.length}`);
                    }
                }

                // Гарантируем системные аутбаунды, если routing на них ссылается, а их нет.
                const ensureOutbound = (tag: string, protocol: string) => {
                    if (!finalConfig.outbounds.some((o: any) => o.tag === tag)) {
                        finalConfig.outbounds.push({ tag, protocol });
                    }
                };
                ensureOutbound("direct", "freedom");
                ensureOutbound("block", "blackhole");
                // dns-out добавляем только для конфигов без балансера (см. логику dns-out ниже).
                // Для конфигов с балансером dns-out добавляется условно после проверки hasBalancerRoute.
                ensureOutbound("dns-out", "dns");

                // DNS: сохраняем пользовательский (умный: DoH + РФ-госдомены). Если нет — дефолт.
                if (!finalConfig.dns || typeof finalConfig.dns !== 'object') {
                    finalConfig.dns = { servers: ["1.1.1.1", "8.8.8.8"], queryStrategy: "UseIPv4" };
                }

                // КРИТИЧНО: домены САМИХ серверов (proxy/cand-*) резолвим напрямую через
                // системный DNS (localhost). Иначе DoH из конфига их не резолвит: чтобы сделать
                // DoH-запрос, надо подключиться к серверу, а чтобы подключиться — резолвить его
                // домен = дедлок, всё таймаутит (хотя ядро работает). Приложение исключено из VPN,
                // поэтому системный резолвер сервера ходит напрямую (минуя туннель).
                try {
                    const serverDomains: string[] = [];
                    (finalConfig.outbounds || []).forEach((ob: any) => {
                        (ob?.settings?.vnext || []).forEach((v: any) => { if (v?.address) serverDomains.push(v.address); });
                        (ob?.settings?.servers || []).forEach((s: any) => { if (s?.address) serverDomains.push(s.address); });
                    });
                    const sdRules = serverDomains
                        .filter((a) => a && !/^[0-9.]+$/.test(a) && a.indexOf(':') === -1)
                        .map((a) => `full:${a}`);
                    if (sdRules.length && finalConfig.dns && Array.isArray(finalConfig.dns.servers)) {
                        finalConfig.dns.servers.unshift({ address: "localhost", domains: sdRules, skipFallback: true });
                    }
                } catch { /* ignore */ }

                // Routing: сохраняем ЦЕЛИКОМ (маршрутизация по сервисам). Гарантируем перехват
                // DNS (port 53 -> dns-out) первым правилом — это критично для конфигов с
                // балансером: без него UDP DNS идёт через балансер как сырые UDP-пакеты,
                // которые xhttp/WS/REALITY аутбаунды не форвардят (нет UDP-поддержки без mux).
                // dns-out обрабатывает DNS внутри xray и резолвит через DoH/прокси правильно.
                if (!finalConfig.routing || !Array.isArray(finalConfig.routing.rules)) {
                    finalConfig.routing = {
                        rules: [
                            { type: "field", port: 53, outboundTag: "dns-out" },
                            { type: "field", network: "tcp,udp", outboundTag: "proxy" }
                        ]
                    };
                } else {
                    const hasDns = finalConfig.routing.rules.some((r: any) => r && r.outboundTag === "dns-out");
                    if (!hasDns) {
                        finalConfig.routing.rules.unshift({ type: "field", port: 53, outboundTag: "dns-out" });
                    }
                }

                // КРИТИЧНО: снимаем inboundTag со всех правил. Исходный конфиг привязывает
                // catch-all (и маршрут на балансировщик) к inboundTag:["socks","http"] — своим
                // старым инбаундам. Наш трафик идёт из "tun"/"socks-in" → правило НЕ матчится,
                // трафик не маршрутизируется = таймаут ВСЕГО. Снятие привязки чинит это.
                if (finalConfig.routing && Array.isArray(finalConfig.routing.rules)) {
                    finalConfig.routing.rules.forEach((r: any) => { if (r && r.inboundTag) delete r.inboundTag; });

                    // КРИТИЧНО: после снятия inboundTag некоторые правила остаются БЕЗ
                    // единого условия сопоставления. Классика — metrics-роут подписок
                    // { inboundTag:["metrics_out"], outboundTag:"metrics_out" }: он матчился
                    // только по inboundTag, а теперь это пустышка { outboundTag:"metrics_out" }.
                    // Xray-core 26.x отвергает ВЕСЬ конфиг на старте:
                    // "app/router: this rule has no effective fields" → ядро не стартует
                    // (на Windows-десктопе виден как «ошибка запуска ядра»/not_running).
                    // Старое ядро на Android такие правила молча игнорирует — поэтому баг
                    // проявлялся только на Windows. Выкидываем правила без матчеров.
                    const RULE_MATCHERS = ['domain', 'ip', 'port', 'sourcePort', 'network',
                        'protocol', 'inboundTag', 'source', 'user', 'attrs'];
                    finalConfig.routing.rules = finalConfig.routing.rules.filter((r: any) => {
                        if (!r || typeof r !== 'object') return false;
                        return RULE_MATCHERS.some((k) => {
                            const v = r[k];
                            return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
                        });
                    });
                }

                // КРИТИЧНО: в Xray-core 26.x ЛЮБОЙ балансер требует фичу Observatory.
                // Если конфиг содержит routing.balancers, но ни observatory, ни
                // burstObservatory не заданы, ядро падает на старте с
                // "core: not all dependencies are resolved" (статус циклит Running→Closed,
                // SOCKS-порт не открывается → not_running). Поднимаем burstObservatory для
                // всех тегов, на которые ссылаются селекторы балансеров, чтобы зависимость
                // резолвилась и health-пинги питали leastLoad/leastPing-стратегии.
                try {
                    const balancers = finalConfig.routing?.balancers;
                    if (Array.isArray(balancers) && balancers.length &&
                        !finalConfig.observatory && !finalConfig.burstObservatory) {
                        const selectors = Array.from(new Set(
                            balancers.flatMap((b: any) => Array.isArray(b?.selector) ? b.selector : [])
                        )).filter((s: any) => typeof s === 'string' && s.length);
                        finalConfig.burstObservatory = {
                            subjectSelector: selectors.length ? selectors : ['proxy'],
                            pingConfig: {
                                destination: 'http://www.google.com/gen_204',
                                interval: '5m',
                                sampling: 2,
                                timeout: '5s'
                            }
                        };
                    }
                } catch { /* ignore — без балансера observatory не нужна */ }

                finalConfig.log = { loglevel: "info" };
                delete finalConfig.remarks;
                configJson = JSON.stringify(finalConfig);
              } else {
                throw new Error("JSON config must be an object");
              }
            } else {
              configJson = buildXrayConfig(selectedNode, settings, routingProfile);
            }
          } catch (e) {
            // YAML/JSON-разбор упал — строим конфиг напрямую из selectedNode
            configJson = buildXrayConfig(selectedNode, settings, routingProfile);
          }


          // 3. Xray Start Stage
          const extendedSettings = {
            ...settings,
            core,                                // 'xray' | 'mihomo' — какое ядро запускать
            nodeProtocol: selectedNode.protocol,
            nodeName: selectedNode.name,
            nodeFlag: selectedNode.flag || '',
            serverAddress: selectedNode.address, // Передаем адрес сервера для диагностики
          };
          const settingsJson = JSON.stringify(extendedSettings);
          const res = await nativeStartVpnWithResult(configJson, settingsJson);
          if (!res.ok) {
             throw new Error(res.error || res.message || 'Ошибка запуска ядра');
          }

           // 4. Verification Stage
           setConnectionState('verifying');
           let verified = false;
           let lastError = '';
           let notRunningCount = 0;
           // Первая проверка через 200мс — ядро часто стартует быстрее 1с.
           // Далее каждые 500мс, максимум 30с (60 итераций).
           for (let i = 0; i < 60; i++) {
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
              setConnectionState('connected');
              save('sim-last-config', { node: selectedNode, config: configJson });
              nativeNotify('Sim Proxy', `${selectedNode.name} подключен`);
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
              throw new Error(errorMsg || 'Не удалось подтвердить соединение');
           }

        } catch (error) {
          console.error('Connection failed:', error);
          setConnectionState('disconnected');
          setVpnError(error instanceof Error ? error.message : 'Ошибка подключения');
          await nativeStopVpn('connect-attempt-threw').catch(() => {});
        } finally {
          isTogglingRef.current = false;
        }
      } else if (connectionState === 'connecting' || connectionState === 'verifying' || connectionState === 'reconnecting') {
        // Пользователь нажал «Отменить» во время подключения — сбрасываем всё
        isTogglingRef.current = false; // разблокируем кнопку для будущего коннекта
        vpnWasActiveRef.current = false;
        freezeRef.current = { lastDownload: -1, lastUpload: 0, since: 0 };
        consecutiveLatencyFailsRef.current = 0;
        setConnectionState('disconnected');
        setConnectedTime(0);
        nativeStopVpn('handleToggle-called-again-during-' + connectionState).catch(() => {});
      } else if (connectionState === 'connected') {
        if (isTogglingRef.current) return; // защита от двойного тапа на disconnect
        isTogglingRef.current = true;
        vpnWasActiveRef.current = false; // пользователь явно нажал «Отключить»
        freezeRef.current = { lastDownload: -1, lastUpload: 0, since: 0 };
        consecutiveLatencyFailsRef.current = 0;
        setConnectionState('disconnecting');
        try { await nativeStopVpn('manual-disconnect-button'); } catch (error) { console.error('Disconnect error:', error); }
        setConnectionState('disconnected');
        setConnectedTime(0);
        nativeNotify('Sim Proxy', 'Отключено');
        nativeVibrate(15);
        isTogglingRef.current = false;
      }
    }, [connectionState, selectedNode, profiles]);

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
  const handleUpdateProfile = useCallback(async (id: string, silent = false) => {
    const profile = profiles.find(p => p.id === id);
    if (!profile?.url) return;

    try {
      const res = await nativeFetchUrl(profile.url);
      const resObj = (typeof res === 'object' && res !== null && !Array.isArray(res)) ? (res as any) : null;
      const content = resObj ? (resObj.body || '') : String(res);
      const userInfo = resObj?.userInfo;
      const webPage = resObj?.webPage;
      const updateInterval = resObj?.updateInterval;
      const supportUrl = resObj?.supportUrl;
      const responseHeaders: Record<string, string> | undefined = resObj?.headers;

      if (!content || !String(content).trim()) {
        setProfiles(prev => prev.map(p => p.id === id ? { ...p, status: 'error' } : p));
        if (!silent) nativeNotify('Sim Proxy', `Подписка ${profile.name} пуста`);
        return;
      }

      const result = parseSubscription(String(content), userInfo, responseHeaders);
      console.log('[SIM-RES] total=' + result.nodes.length + ' sample=' + result.nodes.slice(0,3).map((n: any) => n.protocol + ':' + (n.address||'').slice(0,15)).join('|'));
      if (result.nodes.length > 0 || result.routing) {
        setProfiles(prev => {
          const updated = prev.map(p => {
            if (p.id !== id) return p;

            const traffic = result.traffic || p.traffic;
            let status: SubscriptionProfile['status'] = 'healthy';
            if (traffic) {
               if ((traffic.usagePercentage || 0) > 95 || (traffic.remainingDays !== undefined && traffic.remainingDays <= 1)) status = 'expired';
               else if ((traffic.usagePercentage || 0) > 80 || (traffic.remainingDays !== undefined && traffic.remainingDays <= 7)) status = 'warning';
            }

            const newName = result.name || p.name;

            return {
              ...p,
              name: newName,
              nodes: result.nodes,
              routing: result.routing || p.routing,
              traffic,
              notices: result.notices || p.notices,
              webPage: webPage || result.webPage || p.webPage,
              updateInterval: updateInterval || result.updateInterval || p.updateInterval,
              supportUrl: supportUrl || result.supportUrl || p.supportUrl,
              updatedAt: new Date().toLocaleString('ru-RU'),
              lastUpdateTimestamp: Date.now(),
              status
            };
          });

          // Selection Healing: if selected node is lost, try to find a match by address/port in the updated profile
          if (selectedNode) {
            const stillExists = updated.some(p => p.nodes.some(n => n.id === selectedNode.id));
            if (!stillExists) {
              const matchedNode = result.nodes.find(n => n.address === selectedNode.address && n.port === selectedNode.port);
              if (matchedNode) {
                console.log('Selection healed: found matching node by address', matchedNode.id);
                setSelectedNode(matchedNode);
              }
            }
          }

          // Не вызываем save() здесь — useEffect на profiles уже сохраняет при каждом изменении.
          return updated;
        });
        if (!silent) nativeNotify('Sim Proxy', `Обновлено: ${profile.name}`);
      } else {
        setProfiles(prev => prev.map(p => p.id === id ? { ...p, status: 'error' } : p));
        if (!silent) nativeNotify('Sim Proxy', `В ${profile.name} не найдено серверов`);
      }
    } catch (e) {
      setProfiles(prev => prev.map(p => p.id === id ? { ...p, status: 'error' } : p));
      if (!silent) nativeNotify('Sim Proxy', `Ошибка обновления ${profile.name}`);
    }
  }, [profiles]);

  // Обновляем refs ПОСЛЕ объявления функций — избегаем TDZ ReferenceError.
  useEffect(() => { handleUpdateProfileRef.current = handleUpdateProfile; }, [handleUpdateProfile]);
  useEffect(() => { profilesRef.current = profiles; }, [profiles]);

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

  const bg = isDark ? 'bg-[#0a0a1a]' : 'bg-[#f0f2f5]';

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

      {showBatterySheet && !showOnboarding && (
        <BatteryPermSheet onDone={() => { save('sim-battery-perm-done', true); setShowBatterySheet(false); }} />
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
          <div className={`flex-1 min-h-0 ${bg} pb-[calc(72px+env(safe-area-inset-bottom,0px))] lg:pb-0 relative`}>
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
                      isConnected={connectionState === 'connected'}
                      onSelectNode={setSelectedNode}
                      onSetActive={handleSetActive}
                      onUpdateProfile={handleUpdateProfile}
                      onGoToProfiles={() => setScreen('profiles')}
                    />
                    {/* Правая часть с кнопкой закреплена и не скроллится — крутится только список серверов слева */}
                    <div className="flex-1 min-w-0 h-full overflow-hidden">
                      <HomeScreen connectionState={connectionState} onToggle={handleToggle} selectedNode={selectedNode} nodes={allNodes} onSelectNode={setSelectedNode} onGoToServers={() => setScreen('servers')} onGoToProfiles={() => setScreen('profiles')} connectedTime={connectedTime} hasNodes={allNodes.length > 0} isDark={isDark} vpnError={vpnError} onClearVpnError={() => setVpnError(null)} stats={stats} />
                    </div>
                  </div>
                )}
                {screen === 'servers' && <ServerList nodes={allNodes} profiles={profiles} activeProfileId={activeProfileId} selectedNode={selectedNode} onSelect={setSelectedNode} onBack={() => setScreen('home')} isConnected={connectionState === 'connected'} onDeleteNodes={handleDeleteNodes} connectedTime={connectedTime} autoSwitch={autoSwitch} onAutoSwitchChange={setAutoSwitch} />}
                {screen === 'profiles' && <ProfilesScreen onBack={() => setScreen('home')} profiles={profiles} onAddProfile={handleAddProfile} onDeleteProfile={handleDeleteProfile} onUpdateProfile={handleUpdateProfile} onSaveProfile={handleSaveProfile} onAddSingleNode={handleAddSingleNode} onSelectNode={setSelectedNode} activeNodeId={selectedNode?.id} activeProfileId={activeProfileId} onSetActive={handleSetActive} onImportRouting={handleImportRouting} />}
                {screen === 'settings' && <SettingsScreen onBack={() => setScreen('home')} isConnected={connectionState === 'connected'} onShowLogs={() => setScreen('debug')} />}
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
