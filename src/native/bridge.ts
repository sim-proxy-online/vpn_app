import { RoutingProfile, ServerNode } from '../types';

export interface VpnStats {
  upload: number;
  download: number;
  uplinkSpeed: number;
  downlinkSpeed: number;
  connectedSec: number;
  packetLoss?: number;
  latency?: number;
  error?: string;
  lastError?: string;
  status?: 'starting' | 'not_routing' | 'not_running' | 'running';
  message?: string;
  publicIp?: string;
  country?: string;
}

export interface SpeedTestResult {
  download: number;
  upload: number;
  ping: number;
  timestamp: number;
}

export interface SplitTunnelApp {
  id: string;
  name: string;
  icon?: string;
  mode: 'always' | 'never' | 'smart';
  system?: boolean;
}

export interface LeakTestResult {
  ipAddress: string;
  country: string;
  hasLeak: boolean;
  timestamp: number;
}

export interface DnsProvider {
  id: string;
  name: string;
  address: string;
  type: 'doh' | 'dot' | 'standard';
}

export interface CoreVersion {
  xray: string;
  singbox: string;
  mihomo: string;
}

export interface SystemInfo {
  osVersion: string;
  apiLevel: number;
  model: string;
  manufacturer: string;
  totalMemory: number;
  freeMemory: number;
  maxMemory: number;
}

export interface ConnectionQuality {
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  packetLoss: number;
  quality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'DISCONNECTED' | 'UNKNOWN';
  score: number;
  stableTime: number;
  measureTime: number;
}

export interface RoutingRule {
  id: string;
  type: 'domain' | 'ip' | 'geoip' | 'custom';
  pattern: string;
  action: 'proxy' | 'direct' | 'block';
  description?: string;
  enabled: boolean;
  createdAt: number;
}

type NativeBridge = {
  startVpn(configJson: string): Promise<boolean>;
  stopVpn(): Promise<boolean>;
  getVpnStatus(): Promise<'connected' | 'disconnected' | 'connecting'>;
  getStats(): Promise<VpnStats>;
  pingServer(address: string, port: number, timeout: number): Promise<number>;
  pingProxyServer(outboundJson: string): Promise<number>;
  resolveHostViaProxy(domain: string): Promise<string>;
  measureDelay(configJson: string, url: string): Promise<number>;
  fetchUrl(url: string, userAgent: string): Promise<string>;
  getCoreVersions(): Promise<CoreVersion>;
  updateCore(coreId: string): Promise<boolean>;
  startCore(coreId: string): Promise<boolean>;
  stopCore(coreId: string): Promise<boolean>;
  requestVpnPermission(): Promise<boolean>;
  showNotification(title: string, body: string): void;
  setStatusBarColor(color: string, darkText: boolean): void;
  setStatusBarStyle(style: 'light' | 'dark'): void;
  copyToClipboard(text: string): Promise<void>;
  readClipboard(): Promise<string>;
  scanQrCode(): Promise<string>;
  getInstalledApps(): Promise<{ id: string; name: string; icon: string }[]>;
  getSystemInfo(): Promise<SystemInfo>;
  getLastError(): Promise<string>;
  getLogs(): Promise<string>;
  hasPermission(permission: string): boolean;
  testProxyDelay(): Promise<number>;
  toggleKillSwitch(enabled: boolean): Promise<boolean>;
  isKillSwitchEnabled(): Promise<boolean>;
  getSplitTunnelApps(): Promise<SplitTunnelApp[]>;
  setSplitTunnelApp(appId: string, mode: 'always' | 'never' | 'smart'): Promise<boolean>;
  startSpeedTest(): Promise<SpeedTestResult>;
  testIpLeak(): Promise<LeakTestResult>;
  testDnsLeak(): Promise<{ leakDetected: boolean; dnsServers: string[] }>;
  changeDns(dnsAddress: string): Promise<boolean>;
  getDetailedStats(): Promise<Record<string, unknown>>;
  setAutoConnect(enabled: boolean): Promise<boolean>;
  openUrl(url: string): void;
};

const w = window as any;

export function isNative(): boolean {
  return !!(w.SimNativeV2 || w.SimProxyBridge || w.AndroidBridge);
}

function getNative(): NativeBridge | null {
  return (w.SimNativeV2 || w.SimProxyBridge || w.AndroidBridge) as NativeBridge || null;
}

const pendingTasks = new Map<string, (val: any) => void>();

(window as any).onNativeTaskComplete = (taskId: string, result: any) => {
  const resolve = pendingTasks.get(taskId);
  if (resolve) {
    resolve(result);
    pendingTasks.delete(taskId);
  }
};

const NATIVE_ASYNC_TIMEOUT_MS = 30_000;

function callNativeAsync<T>(methodName: string, ...args: any[]): Promise<T> {
  const taskId = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingTasks.has(taskId)) {
        pendingTasks.delete(taskId);
        reject(new Error(`Native call timeout: ${methodName}`));
      }
    }, NATIVE_ASYNC_TIMEOUT_MS);

    pendingTasks.set(taskId, (val: any) => {
      clearTimeout(timer);
      resolve(val);
    });

    const n = getNative() as any;
    if (n && n[methodName]) {
      try {
        n[methodName](...args, taskId);
      } catch (e) {
        clearTimeout(timer);
        console.error(`Error calling ${methodName}:`, e);
        pendingTasks.delete(taskId);
        resolve({ ok: false, error: 'exception' } as any);
      }
    } else {
      clearTimeout(timer);
      pendingTasks.delete(taskId);
      resolve({ ok: false, error: 'not_native' } as any);
    }
  });
}

export async function nativeStartVpn(configJson: string): Promise<boolean> {
  const res = await nativeStartVpnWithResult(configJson);
  return res.ok;
}

export async function nativeStartVpnWithResult(configJson: string, settingsJson?: string): Promise<{ ok: boolean; error?: string; message?: string }> {
  if (isNative()) {
    const payload = JSON.stringify({
      config: configJson,
      settings: settingsJson || '{}'
    });
    return callNativeAsync<{ ok: boolean; error?: string; message?: string }>('startVpnWithResult', payload);
  }
  await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
  return { ok: true };
}

export async function nativeStopVpn(reason: string = 'unknown'): Promise<boolean> {
  const n = getNative() as any;
  if (n) return n['stopVpn'] ? n['stopVpn'](reason) : true;
  await new Promise(r => setTimeout(r, 800));
  return true;
}

export async function nativeGetStatus(): Promise<'connected' | 'disconnected' | 'connecting'> {
  const n = getNative() as any;
  if (n) return n['getVpnStatus'] ? n['getVpnStatus']() : 'disconnected';
  return 'disconnected';
}

export async function nativeGetCoreVersions(): Promise<CoreVersion | null> {
  const n = getNative() as any;
  if (n && n.getCoreVersions) {
    try {
      const result = n.getCoreVersions();
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      return {
        xray: parsed.xray || '25.1.1',
        singbox: parsed.singbox || '1.11.8',
        mihomo: parsed.mihomo || '1.19.3'
      };
    } catch (e) {
      console.error('Failed to get core versions:', e);
    }
  }
  return { xray: '26.5.9', singbox: '1.11.8', mihomo: '1.19.3' };
}

export async function nativePing(address: string, port: number, timeout: number): Promise<number> {
  if (isNative()) {
    return callNativeAsync<number>('pingServer', address, port, timeout);
  }
  await new Promise(r => setTimeout(r, 200 + Math.random() * 500));
  if (Math.random() < 0.05) return -1;
  return Math.floor(20 + Math.random() * 250);
}

// Direct ping without VPN — checks server accessibility directly
export async function nativePingDirect(address: string, port: number = 443): Promise<number> {
  if (isNative()) {
    return callNativeAsync<number>('pingServerDirect', address, port);
  }
  // Browser fallback — attempt direct fetch (may fail due to CORS)
  await new Promise(r => setTimeout(r, 300 + Math.random() * 700));
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`https://${address}:${port}`, {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (Math.random() < 0.1) return -1;
    return Math.floor(50 + Math.random() * 300);
  } catch {
    return -1;
  }
}

// Забирает deep link (sim://...), пришедший при холодном старте, до того как
// навесился слушатель события 'deeplink'. Пусто — если ссылки не было.
export async function nativeGetPendingDeepLink(): Promise<string> {
  if (isNative()) {
    try { return await callNativeAsync<string>('getPendingDeepLink'); } catch { return ''; }
  }
  return '';
}

export async function nativePingProxy(configJson: string, mode: string = 'proxy'): Promise<number> {
  if (isNative()) {
    return callNativeAsync<number>('pingProxyServer', configJson, mode);
  }
  await new Promise(r => setTimeout(r, 400 + Math.random() * 800));
  if (Math.random() < 0.08) return -1;
  return Math.floor(100 + Math.random() * 500);
}

// Серверы с этими метками в имени/ремарке пингуются первыми — они лучше
// справляются с DPI и белыми списками в РФ.
const DPI_PRIORITY_RE = /\b(lte|4g|бс|белые|белый|обход|bypass)\b/i;
function isDpiPriority(node: ServerNode): boolean {
  return DPI_PRIORITY_RE.test(`${node.name} ${node.remark}`);
}

// Пингует все серверы из nodes последовательно в одном Java-вызове.
// onItem вызывается после каждого сервера, onDone — по завершении.
// Возвращает функцию отмены.
export function startPingBatch(
  nodes: ServerNode[],
  onItem: (id: string, ms: number) => void,
  onDone: () => void
): () => void {
  const bridge = getNative() as any;
  if (!bridge?.nativePingBatch) { onDone(); return () => {}; }

  // Приоритетные серверы (LTE/4G/БС/Белые/Обход) идут первыми в очереди.
  const sorted = [...nodes].sort((a, b) => (isDpiPriority(b) ? 1 : 0) - (isDpiPriority(a) ? 1 : 0));

  const settings = readPingSettings();
  const servers: Array<{ id: string; config: string }> = [];
  for (const node of sorted) {
    try {
      const cfg = buildMeasureConfig(node, settings);
      servers.push({ id: node.id, config: JSON.stringify(cfg) });
    } catch (e: any) {
      // Сервер не поддерживается (неверный rawLink и т.п.) — сразу -1,
      // чтобы не оставлять его в состоянии "pinging" вечно.
      console.warn('[SIM-PING] buildMeasureConfig threw for', node.protocol, node.address, ':', e?.message);
      onItem(node.id, -1);
    }
  }
  if (servers.length === 0) { onDone(); return () => {}; }

  const taskId = Math.random().toString(36).slice(2);
  let done = false;

  const handleItem = (e: Event) => {
    const d = (e as CustomEvent).detail;
    // Всегда требуем совпадение taskId: без этого при параллельных batch-пингах
    // события из одной сессии попадают в обработчики другой → неверные данные пинга.
    if (!d?.taskId || d.taskId !== taskId) return;
    const ms: number = d.ms;
    onItem(d.id, ms);
  };
  const handleDone = (e: Event) => {
    if ((e as CustomEvent).detail?.taskId !== taskId) return;
    if (done) return;
    done = true;
    cleanup();
    onDone();
  };
  const cleanup = () => {
    window.removeEventListener('ping-batch-item', handleItem);
    window.removeEventListener('ping-batch-done', handleDone);
  };

  window.addEventListener('ping-batch-item', handleItem);
  window.addEventListener('ping-batch-done', handleDone);

  try {
    bridge.nativePingBatch(JSON.stringify(servers), taskId);
  } catch (e) {
    console.warn('[SIM-PING] nativePingBatch error:', e);
    cleanup();
    onDone();
    return () => {};
  }

  return () => {
    if (done) return;
    done = true;
    try { bridge.cancelPingBatch?.(); } catch {}
    cleanup();
  };
}

// Pre-boot the libxray core in the background so the FIRST ping doesn't pay for
// core init. Idempotent and safe to call repeatedly (boot is cached per
// process). Fire-and-forget — failures are non-fatal.
let warmupStarted = false;
export async function nativeWarmupCore(): Promise<void> {
  if (warmupStarted) return;
  warmupStarted = true;
  if (!isNative()) return;
  try { await callNativeAsync<string>('warmupCore'); } catch { /* non-fatal */ }
}

export interface FetchResult {
  ok?: boolean;
  error?: string;
  body: string;
  name?: string;
  userInfo?: string;
  updateInterval?: number;
  webPage?: string;
  supportUrl?: string;
  headers?: Record<string, string>;
}

export async function nativeFetchUrl(url: string): Promise<string | FetchResult> {
  if (isNative()) {
    return callNativeAsync<FetchResult>('fetchUrl', url, 'v2rayNG/1.8.19');
  }
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'v2rayNG/1.8.19' },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const body = await resp.text();
  // В браузере собираем заголовки которые доступны
  const headers: Record<string, string> = {};
  const wantedHdrs = ['subscription-userinfo', 'profile-title', 'profile-update-interval', 'profile-web-page-url', 'support-url', 'hiddify-app-info', 'content-disposition'];
  wantedHdrs.forEach(h => { const v = resp.headers.get(h); if (v) headers[h] = v; });
  return {
    body,
    name: resp.headers.get('profile-title') || undefined,
    userInfo: resp.headers.get('subscription-userinfo') || undefined,
    headers: Object.keys(headers).length ? headers : undefined,
  };
}

export async function nativeUpdateCore(coreId: string): Promise<boolean> {
  const n = getNative() as any;
  if (n && n['updateCore']) return n['updateCore'](coreId);
  await new Promise(r => setTimeout(r, 3000));
  return true;
}

export async function nativeStartCore(coreId: string): Promise<boolean> {
  const n = getNative() as any;
  if (n && n['startCore']) return n['startCore'](coreId);
  return true;
}

export async function nativeStopCore(coreId: string): Promise<boolean> {
  const n = getNative() as any;
  if (n && n['stopCore']) return n['stopCore'](coreId);
  return true;
}

export async function nativeRequestVpnPermission(): Promise<boolean> {
  if (isNative()) {
    return callNativeAsync<boolean>('requestVpnPermission');
  }
  return true;
}


export async function nativeRequestAllPermissions(): Promise<void> {
  if (isNative()) {
    return callNativeAsync<void>('requestAllPermissions');
  }
}

export async function nativeRequestBatteryExemption(): Promise<void> {
  const n = getNative() as any;
  if (n && n['requestBatteryOptimizationExemption']) {
    n['requestBatteryOptimizationExemption']();
  }
}

export interface BatteryStatus { doze: boolean; manufacturer: string; }
export async function nativeGetBatteryStatus(): Promise<BatteryStatus> {
  if (isNative()) return callNativeAsync<BatteryStatus>('getBatteryStatus');
  return { doze: true, manufacturer: '' };
}
export async function nativeRequestDozeExemption(): Promise<void> {
  if (isNative()) return callNativeAsync<void>('requestDozeExemption');
}
export async function nativeRequestOemBatterySettings(): Promise<void> {
  if (isNative()) return callNativeAsync<void>('requestOemBatterySettings');
}

export function nativeNotify(title: string, body: string) {
  const n = getNative();
  if (n) { n.showNotification(title, body); return; }
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

export function nativeSetStatusBar(color: string, darkText: boolean) {
  const n = getNative();
  if (n) n.setStatusBarColor(color, darkText);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}

export async function nativeReadClipboard(): Promise<string> {
  const n = getNative();
  if (n) return n.readClipboard();
  return navigator.clipboard.readText();
}

export async function nativeScanQr(): Promise<string> {
  if (isNative()) {
    return callNativeAsync<string>('scanQrCode');
  }
  throw new Error('QR scanner only available in native app');
}

export async function nativeGetApps(): Promise<{ id: string; name: string; icon: string }[]> {
  const n = getNative() as any;
  if (n && n.getInstalledApps) {
    try {
      const result = n.getInstalledApps();
      if (typeof result === 'string') return JSON.parse(result);
      return result || [];
    } catch (e) {
      console.error('Error parsing apps:', e);
      return [];
    }
  }
  return [];
}

export async function nativeGetSystemInfo(): Promise<SystemInfo | null> {
  const n = getNative();
  if (!n) return null;
  try {
    const result = (n as any).getSystemInfo?.();
    if (typeof result === 'string') return JSON.parse(result);
    return result;
  } catch (e) {
    console.error('Failed to get system info:', e);
    return null;
  }
}

export function nativeHasPermission(permission: string): boolean {
  const n = getNative();
  if (n && (n as any).hasPermission) return (n as any).hasPermission(permission);
  return false;
}

export async function nativeGetLastError(): Promise<string> {
  const n = getNative();
  if (n) return (n as any).getLastError?.() || '';
  return '';
}

export async function nativeGetLogs(): Promise<string> {
  const n = getNative();
  if (n) return (n as any).getLogs?.() || '';
  return 'Logs not available in browser mode';
}

export function nativeSetStatusBarStyle(style: 'light' | 'dark'): void {
  const n = getNative();
  if (n && (n as any).setStatusBarStyle) (n as any).setStatusBarStyle(style);
}

export async function nativeGetStats(): Promise<VpnStats> {
  const n = getNative();
  if (n) {
    try {
      const result = (n as any).getStats?.();
      if (!result) return { upload: 0, download: 0, uplinkSpeed: 0, downlinkSpeed: 0, connectedSec: 0 };
      const stats = typeof result === 'string' ? JSON.parse(result) : result;
      if (stats.error) {
        return {
          upload: 0, download: 0, uplinkSpeed: 0, downlinkSpeed: 0, connectedSec: 0,
          error: stats.error, lastError: stats.lastError, status: (stats as any).status, message: (stats as any).message
        } as any;
      }
      return stats;
    } catch (e) {
      console.error('Error parsing stats:', e);
      return { upload: 0, download: 0, uplinkSpeed: 0, downlinkSpeed: 0, connectedSec: 0 };
    }
  }
  return { upload: 0, download: 0, uplinkSpeed: 0, downlinkSpeed: 0, connectedSec: 0 };
}

export async function nativeCheckTorPort(): Promise<{ available: boolean }> {
  const n = getNative();
  if (!n) return { available: false };
  return callNativeAsync<{ available: boolean }>('checkTorPort', '');
}

export async function nativeOpenOrbotInstall(): Promise<void> {
  const n = getNative();
  if (n) await callNativeAsync<boolean>('openOrbotInstall', '');
}

export async function nativeToggleKillSwitch(enabled: boolean): Promise<boolean> {
  const n = getNative();
  if (n) return (n as any).toggleKillSwitch?.(enabled) ?? true;
  return true;
}

export async function nativeIsKillSwitchEnabled(): Promise<boolean> {
  const n = getNative();
  if (n) return (n as any).isKillSwitchEnabled?.() ?? false;
  return localStorage.getItem('sim-killswitch') === 'true';
}

export async function nativeTestProxyDelay(): Promise<number> {
  if (isNative()) {
    return callNativeAsync<number>('testProxyDelay');
  }
  return new Promise(resolve => setTimeout(() => resolve(150 + Math.random() * 100), 1000));
}

export async function nativeGetSplitTunnelApps(): Promise<SplitTunnelApp[]> {
  const n = getNative() as any;
  if (n && n.getSplitTunnelApps) {
    try {
      // На desktop мост — Proxy: метод всегда «есть» и возвращает Promise (IPC),
      // который резолвится в null (нет per-app split tunnel). Поэтому ждём результат
      // и ВСЕГДА отдаём массив — иначе apps станет null и .filter уронит UI.
      const result = await n.getSplitTunnelApps();
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error('Error parsing split tunnel apps:', e);
      return [];
    }
  }
  return [];
}

export async function nativeSetSplitTunnelApp(appId: string, mode: 'always' | 'never' | 'smart'): Promise<boolean> {
  const n = getNative();
  if (n) return (n as any).setSplitTunnelApp?.(appId, mode) ?? true;
  return true;
}

export async function nativeStartSpeedTest(): Promise<SpeedTestResult> {
  if (isNative()) {
    return callNativeAsync<SpeedTestResult>('startSpeedTest');
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ download: 50 + Math.random() * 150, upload: 20 + Math.random() * 80, ping: 10 + Math.random() * 40, timestamp: Date.now() });
    }, 3000);
  });
}

export async function nativeTestIpLeak(): Promise<LeakTestResult> {
  if (isNative()) {
    return callNativeAsync<LeakTestResult>('testIpLeak');
  }
  return { ipAddress: '127.0.0.1', country: 'XX', hasLeak: false, timestamp: Date.now() };
}

export async function nativeTestDnsLeak(): Promise<{ leakDetected: boolean; dnsServers: string[] }> {
  const n = getNative() as any;
  if (n && n.testDnsLeak) {
    const result = n.testDnsLeak();
    if (typeof result === 'string') return JSON.parse(result);
    return result;
  }
  return { leakDetected: false, dnsServers: [] };
}

export async function nativeChangeDns(dnsAddress: string): Promise<boolean> {
  const n = getNative();
  if (n) return (n as any).changeDns?.(dnsAddress) ?? true;
  localStorage.setItem('sim-dns-address', dnsAddress);
  return true;
}

export async function nativeGetDetailedStats(): Promise<Record<string, unknown>> {
  const n = getNative();
  if (n) {
    const result = (n as any).getDetailedStats?.();
    if (typeof result === 'string') return JSON.parse(result);
    return result || {};
  }
  return {};
}

export async function nativeSetAutoConnect(enabled: boolean): Promise<boolean> {
  const n = getNative();
  if (n) return (n as any).setAutoConnect?.(enabled) ?? true;
  localStorage.setItem('sim-autoconnect', String(enabled));
  return true;
}

// ── ROUTING RULES MANAGEMENT ──
export async function nativeGetRoutingRules(): Promise<RoutingRule[]> {
  const n = getNative() as any;
  if (n) {
    try {
      const result = n['getRoutingRules'] ? n['getRoutingRules']() : null;
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      return parsed?.rules || [];
    } catch (e) {
      console.error('Error parsing routing rules:', e);
      return [];
    }
  }
  return [];
}

export async function nativeAddRoutingRule(rule: RoutingRule): Promise<boolean> {
  const n = getNative() as any;
  if (n && n['addRoutingRule']) return n['addRoutingRule'](JSON.stringify(rule)) ?? true;
  return true;
}

export async function nativeRemoveRoutingRule(ruleId: string): Promise<boolean> {
  const n = getNative() as any;
  if (n && n['removeRoutingRule']) return n['removeRoutingRule'](ruleId) ?? true;
  return true;
}

export async function nativeUpdateRoutingRule(rule: RoutingRule): Promise<boolean> {
  const n = getNative() as any;
  if (n && n['updateRoutingRule']) return n['updateRoutingRule'](JSON.stringify(rule)) ?? true;
  return true;
}

export async function nativeExportRoutingRules(): Promise<string> {
  const n = getNative() as any;
  if (n && n['exportRoutingRules']) return n['exportRoutingRules']() ?? '{}';
  return '{}';
}

export async function nativeImportRoutingRules(jsonData: string): Promise<boolean> {
  const n = getNative() as any;
  if (n && n['importRoutingRules']) return n['importRoutingRules'](jsonData) ?? true;
  return true;
}

export async function nativeGetConnectionQuality(): Promise<ConnectionQuality> {
  const n = getNative() as any;
  if (n && n['getConnectionQuality']) {
    const result = await n['getConnectionQuality']();
    return typeof result === 'string' ? JSON.parse(result) : result;
  }
  return { avgLatency: 0, minLatency: 0, maxLatency: 0, packetLoss: 0, quality: 'UNKNOWN', score: 0, stableTime: 0, measureTime: Date.now() };
}

export async function nativeMeasurePing(server: string, port: number): Promise<number> {
  return nativePing(server, port, 5000);
}

// ── NETWORK MONITORING ──
export async function nativeStartNetworkMonitoring(): Promise<void> {
  const n = getNative() as any;
  if (n && n['startNetworkMonitoring']) n['startNetworkMonitoring']();
}

export async function nativeStopNetworkMonitoring(): Promise<void> {
  const n = getNative() as any;
  if (n && n['stopNetworkMonitoring']) n['stopNetworkMonitoring']();
}

export async function nativeGetCurrentNetwork(): Promise<string> {
  const n = getNative() as any;
  if (n && n['getCurrentNetwork']) return n['getCurrentNetwork']() ?? 'NONE';
  return 'NONE';
}

export async function nativeIsNetworkAvailable(): Promise<boolean> {
  const n = getNative() as any;
  if (n && n['isNetworkAvailable']) return n['isNetworkAvailable']() ?? false;
  return false;
}

export async function nativeGetNetworkInfo(): Promise<string> {
  const n = getNative() as any;
  if (n && n['getNetworkInfo']) return n['getNetworkInfo']() ?? 'Unknown';
  return 'Unknown';
}

/** Returns mobile carrier name directly from TelephonyManager — works on DPI networks, no HTTP needed. */
export function nativeGetNetworkCarrier(): string {
  const n = getNative() as any;
  if (n && n['getNetworkCarrier']) return (n['getNetworkCarrier']() as string) ?? '';
  return '';
}


export function nativeMinimizeApp(): void {
  const n = getNative() as any;
  if (n && n['minimizeApp']) n['minimizeApp']();
}

export function nativeClearDnsCache(): void {
  const n = getNative() as any;
  if (n && n['clearDnsCache']) n['clearDnsCache']();
}

export function nativeOpenUrl(url: string): void {
  const n = getNative() as any;
  if (n && n['openUrl']) n['openUrl'](url);
  else window.open(url, '_blank');
}

// ── In-app самообновление APK ──────────────────────────────────────────────
export interface InstallResult {
  ok: boolean;
  status?: 'installing' | 'need_permission' | 'browser' | 'not_native' | 'downloaded';
  error?: string;
}

// true только если нативный слой умеет качать+ставить APK (есть метод).
export function canInstallApk(): boolean {
  const n = getNative() as any;
  return !!(n && n['downloadAndInstallApk']);
}

export async function nativeGetAppVersion(): Promise<{ versionName: string; versionCode: number } | null> {
  const n = getNative() as any;
  if (n && n.getAppVersion) {
    try { const r = n.getAppVersion(); return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; }
  }
  return null;
}

// Качает APK (с прогрессом через событие 'update-progress') и запускает установку.
// В браузере деградирует до открытия ссылки.
export async function nativeDownloadAndInstallApk(url: string): Promise<InstallResult> {
  if (canInstallApk()) {
    return callNativeAsync<InstallResult>('downloadAndInstallApk', url);
  }
  nativeOpenUrl(url);
  return { ok: true, status: 'browser' };
}

// Ставит уже скачанный APK без повторной загрузки (после выдачи разрешения).
export async function nativeInstallDownloadedApk(): Promise<InstallResult> {
  const n = getNative() as any;
  if (n && n['installDownloadedApk']) return callNativeAsync<InstallResult>('installDownloadedApk');
  return { ok: false, status: 'not_native' };
}

// Android: фоновая докачка APK обновления БЕЗ установки (для бесшовного апдейта).
export async function nativeDownloadUpdateApk(url: string): Promise<InstallResult> {
  const n = getNative() as any;
  if (n && n['downloadUpdateApk']) return callNativeAsync<InstallResult>('downloadUpdateApk', url);
  return { ok: false, status: 'not_native' };
}

// Android: активная сеть безлимитна (Wi-Fi/Ethernet)? Чтобы не качать на мобильном.
export async function nativeIsUnmeteredNetwork(): Promise<boolean> {
  const n = getNative() as any;
  if (n && n['isUnmeteredNetwork']) {
    try { return await callNativeAsync<boolean>('isUnmeteredNetwork'); } catch { return false; }
  }
  return false;
}

// ── Desktop (electron-updater) — фоновое обновление ─────────────────────────
export function isDesktopPlatform(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__SIM_DESKTOP__;
}

export interface DesktopUpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'latest' | 'error' | 'dev';
  version: string | null;
  progress: number;
  error?: string | null;
}

// Ручная проверка обновления на desktop (electron-updater качает в фоне сам).
export async function nativeCheckForUpdatesNow(): Promise<{ ok: boolean; status?: string; version?: string | null } | null> {
  const n = getNative() as any;
  if (n && n['checkForUpdatesNow']) { try { return await n['checkForUpdatesNow'](); } catch { return null; } }
  return null;
}

export async function nativeGetDesktopUpdateState(): Promise<DesktopUpdateState | null> {
  const n = getNative() as any;
  if (n && n['getDesktopUpdateState']) { try { return await n['getDesktopUpdateState'](); } catch { return null; } }
  return null;
}

// Немедленно поставить уже скачанное обновление и перезапуститься (desktop).
export async function nativeQuitAndInstallUpdate(): Promise<{ ok: boolean; error?: string } | null> {
  const n = getNative() as any;
  if (n && n['quitAndInstallUpdate']) { try { return await n['quitAndInstallUpdate'](); } catch { return null; } }
  return null;
}

export function nativeVibrate(duration: number = 20): void {
  const n = getNative() as any;
  if (n && n['vibrate']) n['vibrate'](duration);
}

function buildDnsServers(settings: Record<string, unknown>): string[] {
  const custom = String((settings as any).dnsAddress || (settings as any).dns || '').trim();
  // DoH (port 443) идёт первым: на ТСПУ-сетях (МТС, Мегафон, Теле2) UDP/53 к зарубежным IP
  // блокируется, поэтому plain DNS от Xray-процесса не работает. DoH к IP-адресам 8.8.8.8/1.1.1.1
  // не требует предварительного DNS-резолва и доступен по HTTPS даже при заблокированном UDP/53.
  const doh   = ['https://8.8.8.8/dns-query', 'https://1.1.1.1/dns-query'];
  const plain = ['8.8.8.8', '1.1.1.1'];
  if (custom && custom !== '8.8.8.8' && custom !== '1.1.1.1') {
    return [custom, ...doh, ...plain];
  }
  return [...doh, ...plain];
}

// Fragment spec for the freedom dialer. Per-node override ("packets,length,interval")
// takes priority over the global settings, falling back to sane RU-bypass defaults.
//
// `packets` selection by transport:
//   • TLS / Reality  → "tlshello" slices the TLS ClientHello so DPI can't read SNI.
//   • everything else (Shadowsocks, raw VMess/VLESS without TLS) has NO TLS
//     handshake, so "tlshello" would never fire — we fragment the first stream
//     segments instead ("1-3"), which still defeats first-packet DPI matching.
export function getFragmentSpec(node: ServerNode, settings: Record<string, unknown>) {
  const isTlsLike = node.security === 'tls' || node.security === 'reality'
    || (node.protocol === 'trojan' && !node.security);

  let packets: string;
  let length: string;
  let interval: string;

  if (typeof node.fragment === 'string' && node.fragment.includes(',')) {
    const parts = node.fragment.split(',');
    packets = (parts[0] || 'tlshello').trim();
    length = (parts[1] || '10-20').trim();
    interval = (parts[2] || '10-20').trim();
  } else {
    packets = String((settings as any).fragPackets || 'tlshello');
    length = String((settings as any).fragLength || '10-20');
    interval = String((settings as any).fragInterval || '10-20');
  }

  // For non-TLS transports a "tlshello" selector matches nothing — fall back to
  // fragmenting the first stream segments so the bypass works for every protocol.
  if (!isTlsLike && packets.trim().toLowerCase() === 'tlshello') {
    packets = '1-3';
  }

  return { packets, length, interval };
}

// Noise spec (junk packets) for the freedom dialer. Accepts an array from
// settings, a "type,packet,delay" string (multiple separated by "&") from the
// node, or a default random noise.
export function getNoisesSpec(node: ServerNode, settings: Record<string, unknown>) {
  const fromSettings = (settings as any).noises;
  if (Array.isArray(fromSettings) && fromSettings.length > 0) {
    return fromSettings;
  }
  if (typeof node.noises === 'string' && node.noises.trim()) {
    return node.noises.split('&').filter(Boolean).map((s) => {
      const [type, packet, delay] = s.split(',');
      return {
        type: (type || 'rand').trim(),
        packet: (packet || '50-100').trim(),
        delay: (delay || '10-20').trim(),
      };
    });
  }
  // Из настроек («Шумы»): Тип / Диапазон(packet) / Задержка.
  const nType = (settings as any).noisesType;
  if (nType) {
    return [{
      type: String(nType),
      packet: String((settings as any).noisesRand || '50-100'),
      delay: String((settings as any).noisesDelay || '10-20'),
    }];
  }
  return [{ type: 'rand', packet: '50-100', delay: '10-20' }];
}

// Правила маршрутизации для выбранной стратегии (раздел «Управление трафиком»).
// Добавляются последними (catch-all), после кастомных правил и правил профиля.
function getStrategyRules(strategy: string): any[] {
  const proxyAll = { type: 'field', outboundTag: 'proxy', network: 'tcp,udp' };
  const directAll = { type: 'field', outboundTag: 'direct', network: 'tcp,udp' };
  switch (strategy) {
    case 'bypass-ru':
      // РФ-сайты и RU-IP напрямую, остальное — через прокси.
      return [
        { type: 'field', outboundTag: 'direct', domain: ['geosite:category-ru'] },
        { type: 'field', outboundTag: 'direct', ip: ['geoip:ru'] },
        proxyAll,
      ];
    case 'only-blocked':
      // Через прокси — только типично заблокированные сервисы, остальное напрямую.
      return [
        { type: 'field', outboundTag: 'proxy', domain: [
          'geosite:google', 'geosite:youtube', 'geosite:telegram', 'geosite:twitter',
          'geosite:facebook', 'geosite:instagram', 'geosite:openai',
        ] },
        directAll,
      ];
    case 'global':
    case 'bypass-local':
    default:
      // Весь трафик через прокси (локальные/приватные сети уже идут direct выше).
      return [proxyAll];
  }
}

// Российские банки и госпорталы, которые блокируют иностранные IP → пускаем напрямую.
// Активируется настройкой ruDirect. Используем `domain:` — покрывает все поддомены.
const RU_DIRECT_DOMAINS = [
  'domain:gosuslugi.ru', 'domain:esia.gosuslugi.ru', 'domain:goskey.ru',
  'domain:mos.ru', 'domain:nalog.ru', 'domain:nalog.gov.ru',
  'domain:sfr.gov.ru', 'domain:pfr.gov.ru', 'domain:cbr.ru',
  'domain:sberbank.ru', 'domain:sber.ru', 'domain:sbbol.ru',
  'domain:tinkoff.ru', 'domain:t-bank.ru',
  'domain:vtb.ru',
  'domain:alfabank.ru',
  'domain:raiffeisen.ru', 'domain:raiffeisenbank.ru',
  'domain:gazprombank.ru', 'domain:gpb.ru',
  'domain:rshb.ru',
  'domain:psbank.ru',
  'domain:pochtabank.ru',
  'domain:sovcombank.ru',
  'domain:otkritie.ru',
  'domain:uralsib.ru',
  'domain:mkb.ru',
  'domain:akbars.ru',
  'domain:nspk.ru', 'domain:mirpay.ru', 'domain:sbp.ru',
];

export function buildXrayConfig(node: ServerNode, settings: Record<string, unknown>, _routingProfile?: RoutingProfile): string {
  const socksPort = Number(settings.socksPort) || 10808;
  const dnsServers = buildDnsServers(settings);

  // ── Настройки из раздела «Сетевой движок» ──
  const validLogLevels = ['none', 'error', 'warning', 'info', 'debug'];
  const rawLog = String((settings as any).logsMode || 'warning').toLowerCase();
  const logLevel = validLogLevels.includes(rawLog) ? rawLog : 'warning';
  const sniffEnabled = (settings as any).sniffing !== false; // по умолчанию вкл
  const connIdle = Number((settings as any).idleTimeout) || 300;
  const tunMtu = Number((settings as any).mtu) || 1400;
  const strategy = String((settings as any).routing || 'global');

  // ── White-list / DPI bypass (RU mobile shutdowns) ──
  // When fragmentation and/or noises are enabled, route the real handshake
  // through a `freedom` dialer that slices the outgoing TCP stream (fragment)
  // and/or injects junk packets (noises). This hides the SNI / first-packet
  // signature from ISP DPI — exactly why these servers return "no ping / no
  // internet" on filtered mobile networks while still working in Happ.
  //
  // Fragmentation now applies to EVERY Xray transport (VLESS/VMess/Trojan/
  // Shadowsocks): TLS-like uses "tlshello", others fragment the first segments
  // (see getFragmentSpec). It operates on the TCP byte stream, so it is safe for
  // any TCP-based protocol — the peer reassembles transparently.
  const fragEnabled = !!(settings as any).fragEnable;
  const noisesEnabled = !!(settings as any).noisesEnable;
  const useBypassChain = fragEnabled || noisesEnabled;

  const outbound = buildOutboundConfig(node, useBypassChain ? { fragmentTag: 'fragment' } : undefined);

  const bypassOutbound: any = useBypassChain
    ? { tag: 'fragment', protocol: 'freedom', settings: { domainStrategy: 'AsIs' } }
    : null;
  if (bypassOutbound && fragEnabled) {
    bypassOutbound.settings.fragment = getFragmentSpec(node, settings);
  }
  if (bypassOutbound && noisesEnabled) {
    bypassOutbound.settings.noises = getNoisesSpec(node, settings);
  }

  const config = {
    log: { loglevel: logLevel },
    dns: {
      servers: dnsServers,
      queryStrategy: "UseIPv4",
      ...((settings as any).dnsCache === false ? { disableCache: true } : {}),
      // Пинуем cp.cloudflare.com через live SOCKS — разрешение без внешнего DNS
      // (на белых списках UDP/53 к 8.8.8.8 может не работать).
      hosts: {
        "cp.cloudflare.com": "1.1.1.1",
        "connectivitycheck.android.com": "142.251.33.67",
        "connectivitycheck.gstatic.com": "142.251.33.67",
        "www.gstatic.com": "142.251.33.67"
      }
    },
    policy: {
      levels: {
        "8": {
          handshake: 4,
          connIdle: connIdle,
          uplinkOnly: 1,
          downlinkOnly: 1
        }
      },
      system: {
        statsOutboundUplink: true,
        statsOutboundDownlink: true
      }
    },
    // ВАЖНО: только SOCKS inbound на localhost. НЕ добавлять inbound с
    // protocol:"tun" — Xray-core (26.x) такой протокол не поддерживает и
    // падает на парсинге конфига. TUN fd обрабатывает нативный обработчик
    // внутри libxray (coreRunLoopWithTun), который мостит трафик в этот SOCKS.
    inbounds: [
      {
        tag: "socks-in",
        port: socksPort,
        listen: "127.0.0.1",
        protocol: "socks",
        settings: {
          udp: true,
          auth: "noauth",
          userLevel: 8
        },
        sniffing: { enabled: sniffEnabled, destOverride: ["http", "tls", "quic"], routeOnly: false }
      },
      {
        // TUN-инбаунд: форк libxray поддерживает protocol:"tun" и привязывает к нему
        // TUN fd из coreRunLoopWithTun(config, fd). НЕ ставить "dns" в destOverride.
        tag: "tun",
        protocol: "tun",
        settings: { mtu: tunMtu, stack: "gvisor" },
        sniffing: { enabled: sniffEnabled, destOverride: ["http", "tls", "quic"], routeOnly: true }
      }
    ],
    outbounds: [
      outbound,
      ...(bypassOutbound ? [bypassOutbound] : []),
      { protocol: "dns", tag: "dns-out" },
      { protocol: "freedom", tag: "direct" },
      { protocol: "blackhole", tag: "block" }
    ],
    routing: {
      domainStrategy: settings.domainStrategy || "IPIfNonMatch",
      rules: [
        // Intercept DNS queries from the system
        {
          type: "field",
          port: 53,
          outboundTag: "dns-out"
        },
        // Пускаем ICMP (ping) напрямую, так как большинство прокси-протоколов
        // (VLESS/VMess/Trojan) его не поддерживают. Это чинит работу утилиты ping
        // и системные проверки связности без нагрузки на ядро.
        {
          type: "field",
          protocol: ["icmp"],
          outboundTag: "direct"
        },
        {
          type: "field",
          domain: ["geosite:private"],
          outboundTag: "direct"
        },
        {
          type: "field",
          ip: [
            "geoip:private",
            "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
            "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16",
            "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32"
          ],
          outboundTag: "direct"
        },
        // Route proxy address to direct to avoid loops.
        // Xray ip-rule требует CIDR: IPv6 → /128, IPv4 → /32 (иначе отвергает весь конфиг).
        {
          type: "field",
          [node.address.includes(':') || /^[0-9.]+$/.test(node.address) ? 'ip' : 'domain']: [
            (() => {
              const a = node.address;
              if (a.includes('/')) return a;           // уже CIDR
              if (a.includes(':')) return a + '/128';  // IPv6
              if (/^[0-9.]+$/.test(a)) return a + '/32'; // IPv4
              return `domain:${a}`;
            })()
          ],
          outboundTag: "direct"
        }
      ]
    }
  };

  // Российские банки/госпорталы — напрямую, чтобы не ломались при включённом VPN
  if ((settings as any).ruDirect) {
    config.routing.rules.push({ type: 'field', domain: RU_DIRECT_DOMAINS, outboundTag: 'direct' });
  }

  // Блокировка рекламы: рекламные/трекерные домены → blackhole (через geosite Xray)
  if ((settings as any).adBlock) {
    config.routing.rules.push({ type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'block' });
  }

  // Защита от утечек: IPv6-адреса блокируются — Android уже маршрутизирует ::/0 в TUN,
  // но это правило не даёт ядру открыть IPv6-соединение напрямую в обход прокси.
  if ((settings as any).leakProtection !== false) {
    config.routing.rules.push({ type: 'field', ip: ['::/0'], outboundTag: 'block' });
  }

  // Add custom routing rules from settings
  if (Array.isArray((settings as any).routingRules)) {
    config.routing.rules.push(...(settings as any).routingRules);
  }

  // Add routing profile rules if present (MERGED from parent profile)
  if (_routingProfile) {
    if (Array.isArray(_routingProfile.DirectSites) && _routingProfile.DirectSites.length > 0) {
      config.routing.rules.push({ type: "field", domain: _routingProfile.DirectSites.map(d => d.startsWith('domain:') || d.startsWith('geosite:') || d.startsWith('regexp:') ? d : `domain:${d}`), outboundTag: "direct" });
    }
    if (Array.isArray(_routingProfile.DirectIp) && _routingProfile.DirectIp.length > 0) {
      config.routing.rules.push({ type: "field", ip: _routingProfile.DirectIp, outboundTag: "direct" });
    }
    if (Array.isArray(_routingProfile.ProxySites) && _routingProfile.ProxySites.length > 0) {
      config.routing.rules.push({ type: "field", domain: _routingProfile.ProxySites.map(d => d.startsWith('domain:') || d.startsWith('geosite:') || d.startsWith('regexp:') ? d : `domain:${d}`), outboundTag: "proxy" });
    }
    if (Array.isArray(_routingProfile.ProxyIp) && _routingProfile.ProxyIp.length > 0) {
      config.routing.rules.push({ type: "field", ip: _routingProfile.ProxyIp, outboundTag: "proxy" });
    }
    if (Array.isArray(_routingProfile.BlockSites) && _routingProfile.BlockSites.length > 0) {
      config.routing.rules.push({ type: "field", domain: _routingProfile.BlockSites.map(d => d.startsWith('domain:') || d.startsWith('geosite:') || d.startsWith('regexp:') ? d : `domain:${d}`), outboundTag: "block" });
    }
    if (Array.isArray(_routingProfile.BlockIp) && _routingProfile.BlockIp.length > 0) {
      config.routing.rules.push({ type: "field", ip: _routingProfile.BlockIp, outboundTag: "block" });
    }
  }

  // Tor over VPN: трафик через локальный SOCKS5 Orbot (127.0.0.1:9050 → Tor сеть).
  // Orbot исключён из VPN-туннеля в VpnServiceImpl, поэтому его трафик идёт напрямую к Tor-узлам.
  const torMode = String((settings as any).torMode || 'off');
  if (torMode !== 'off') {
    (config as any).outbounds.push({
      protocol: "socks",
      tag: "tor",
      settings: { servers: [{ address: "127.0.0.1", port: 9050, udp: false }] }
    });
    if (torMode === 'onion') {
      // .onion домены → Tor, всё остальное → обычный прокси
      config.routing.rules.splice(2, 0, {
        type: "field",
        domain: ["regexp:\\.onion$"],
        outboundTag: "tor"
      });
    } else if (torMode === 'all') {
      // Весь трафик → Tor (максимальная анонимность); VPN-сервер не используется
      config.routing.rules.push({
        type: "field",
        network: "tcp,udp",
        outboundTag: "tor"
      });
      return JSON.stringify(config, null, 2);
    }
  }

  // Правила выбранной стратегии маршрутизации + catch-all (добавляются последними,
  // чтобы кастомные правила и правила профиля имели приоритет).
  config.routing.rules.push(...getStrategyRules(strategy));

  return JSON.stringify(config, null, 2);
}

// Protocols that the bundled Xray-core (libgojni) can actually run as an
// outbound. hysteria/hysteria2/tuic/shadowtls/anytls/naive/brook/mtproto are
// sing-box / mihomo protocols — Xray rejects them at config-parse time, so a
// node using them cannot tunnel through this core. We still parse & list them
// (so the user sees them), but the connect path reports a clear error instead
// of a silent "no internet".
export const XRAY_SUPPORTED_PROTOCOLS = new Set<string>([
  'vless', 'vmess', 'trojan', 'shadowsocks', 'ss', 'socks', 'http', 'wireguard', 'json',
]);

export function isProtocolSupportedByCore(protocol: string): boolean {
  return XRAY_SUPPORTED_PROTOCOLS.has((protocol || '').toLowerCase());
}

// Normalise transport aliases to the network name Xray-core expects.
function normalizeNetwork(transport?: string): string {
  const t = (transport || 'tcp').toLowerCase();
  if (t === 'h2' || t === 'h3') return 'http';
  if (t === 'splithttp') return 'xhttp';   // splithttp was renamed to xhttp
  if (t === 'raw') return 'tcp';            // Xray renamed tcp→raw; tcp still valid
  if (!t || t === 'none' || t === 'original') return 'tcp';
  return t;
}

// Build streamSettings.<transport>Settings for every transport Xray supports.
function buildTransportSettings(outbound: any, node: ServerNode, network: string): void {
  const host = node.host || node.sni || node.address;
  const path = node.path || '/';

  switch (network) {
    case 'tcp':
      // TCP with HTTP camouflage header (headerType=http). Plain tcp needs nothing.
      if ((node.headerType || '').toLowerCase() === 'http') {
        outbound.streamSettings.tcpSettings = {
          header: {
            type: 'http',
            request: {
              path: [node.path || '/'],
              headers: host ? { Host: [host] } : {},
            },
          },
        };
      }
      break;
    case 'ws':
      outbound.streamSettings.wsSettings = {
        path,
        headers: host ? { Host: host } : {},
      };
      break;
    case 'grpc':
      outbound.streamSettings.grpcSettings = {
        serviceName: node.path || '',
        multiMode: (node.headerType || '').toLowerCase() === 'multi',
      };
      break;
    case 'http':
      outbound.streamSettings.httpSettings = {
        path,
        host: host ? [host] : [],
      };
      break;
    case 'xhttp':
      outbound.streamSettings.xhttpSettings = {
        path,
        host: host || '',
        mode: node.headerType || 'auto',
      };
      break;
    case 'httpupgrade':
      outbound.streamSettings.httpupgradeSettings = {
        path,
        host: host || '',
      };
      break;
    case 'kcp':
    case 'mkcp':
      outbound.streamSettings.network = 'kcp';
      outbound.streamSettings.kcpSettings = {
        seed: node.path || undefined,
        header: { type: node.headerType || 'none' },
      };
      break;
    case 'quic':
      outbound.streamSettings.quicSettings = {
        security: 'none',
        key: '',
        header: { type: node.headerType || 'none' },
      };
      break;
  }
}

export function buildOutboundConfig(node: ServerNode, opts?: { fragmentTag?: string }): any {
  // ── WireGuard: Xray outbound has no streamSettings/transport ──
  if (node.protocol === 'wireguard') {
    const wg: any = {
      protocol: 'wireguard',
      tag: 'proxy',
      settings: {
        secretKey: node.privateKey || node.password || '',
        address: (node.localAddress || '172.16.0.2/32').split(',').map(s => s.trim()).filter(Boolean),
        peers: [{
          publicKey: node.publicKey || '',
          endpoint: `${node.address}:${node.port}`,
          preSharedKey: node.preSharedKey || '',
          allowedIPs: ['0.0.0.0/0', '::/0'],
        }],
        mtu: node.mtu ? Number(node.mtu) : 1420,
      },
    };
    if (opts?.fragmentTag) wg.streamSettings = { sockopt: { dialerProxy: opts.fragmentTag, tcpNoDelay: true } };
    return wg;
  }

  // Рандомизация порта: если заданы альтернативные порты — выбираем случайный
  const effectivePort = (() => {
    // altPorts хранится в localStorage per-server; settings недоступен в этой функции
    const stored = (() => { try { return localStorage.getItem(`sim-altports-${node.address}:${node.port}`) || ''; } catch { return ''; } })();
    const raw = stored || node.altPorts || '';
    if (!raw) return node.port;
    const ports = raw.split(',').map((p: string) => {
      const t = p.trim();
      if (t.includes('-')) {
        const [a, b] = t.split('-').map(Number);
        return isNaN(a) || isNaN(b) ? null : Math.floor(Math.random() * (b - a + 1)) + a;
      }
      const n = Number(t);
      return isNaN(n) ? null : n;
    }).filter((p: number | null): p is number => p !== null && p > 0 && p < 65536);
    if (!ports.length) return node.port;
    return ports[Math.floor(Math.random() * ports.length)];
  })();

  const network = normalizeNetwork(node.transport);
  const protocol = node.protocol;
  // trojan всегда TLS; для остальных — явное значение или none
  const effectiveSecurity = node.security || (protocol === 'trojan' ? 'tls' : 'none');
  const outbound: any = {
    protocol,
    tag: "proxy",
    settings: {},
    streamSettings: {
      network,
      security: effectiveSecurity
    }
  };

  if (protocol === 'vless') {
    outbound.settings.vnext = [{
      address: node.address,
      port: effectivePort,
      users: [{
        id: node.uuid,
        encryption: "none",
        // xtls-rprx-vision flow is only valid over raw TCP; drop it for ws/grpc/xhttp/etc.
        flow: network === 'tcp' ? (node.flow || "") : "",
        level: 8
      }]
    }];
  } else if (protocol === 'vmess') {
    outbound.settings.vnext = [{
      address: node.address,
      port: effectivePort,
      users: [{
        id: node.uuid,
        alterId: node.alterId || 0,
        security: "auto",
        level: 8
      }]
    }];
  } else if (protocol === 'trojan') {
    outbound.settings.servers = [{
      address: node.address,
      port: effectivePort,
      password: node.password,
      level: 8
    }];
  } else if (protocol === 'shadowsocks') {
    outbound.settings.servers = [{
      address: node.address,
      port: effectivePort,
      method: node.method || 'aes-256-gcm',
      password: node.password,
      level: 8
    }];
  } else if (protocol === 'socks' || protocol === 'http') {
    outbound.settings.servers = [{
      address: node.address,
      port: effectivePort,
      ...(node.username || node.uuid || node.password ? {
        users: [{ user: node.username || node.uuid || '', pass: node.password || '' }],
      } : {}),
    }];
  }

  if (effectiveSecurity === 'tls') {
    const _storedFp = (() => { try { return JSON.parse(localStorage.getItem('sim-utls-fingerprint') || '"chrome"'); } catch { return 'chrome'; } })();
    const fp = node.fingerprint || _storedFp || 'chrome';
    outbound.streamSettings.tlsSettings = {
      serverName: node.sni || node.host || node.address,
      fingerprint: fp,
      allowInsecure: !!node.allowInsecure,
      ...(node.alpn ? { alpn: node.alpn.split(',').map(s => s.trim()).filter(Boolean) } : {}),
    };
  } else if (node.security === 'reality') {
    const _storedFp = (() => { try { return JSON.parse(localStorage.getItem('sim-utls-fingerprint') || '"chrome"'); } catch { return 'chrome'; } })();
    const fp = node.fingerprint || _storedFp || 'chrome';
    outbound.streamSettings.realitySettings = {
      show: false,
      fingerprint: fp,
      serverName: node.sni || node.address,
      publicKey: node.publicKey || '',   // undefined → JSON.stringify дропает поле → Xray отказывает
      shortId: node.shortId || "",
      spiderX: ""
    };
  }

  buildTransportSettings(outbound, node, network);

  // Chain the real connection through the fragmentation/noise dialer so the
  // outgoing TLS ClientHello is sliced — this is what lets the server pass ISP
  // "white list" DPI (no ping / no internet) the same way Happ does.
  if (opts?.fragmentTag) {
    outbound.streamSettings.sockopt = {
      ...(outbound.streamSettings.sockopt || {}),
      dialerProxy: opts.fragmentTag,
      tcpNoDelay: true,
    };
  }

  return outbound;
}

export function readPingSettings(): Record<string, any> {
  return readSimSettings();
}

// Read all persisted `sim-*` settings from localStorage into a plain object
// (keys without the `sim-` prefix). Used to build the same fragmentation /
// noise spec for pinging as for the real connection.
export function readSimSettings(): Record<string, any> {
  const settings: Record<string, any> = {};
  if (typeof localStorage === 'undefined') return settings;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('sim-')) {
      try { settings[k.substring(4)] = JSON.parse(localStorage.getItem(k) || ''); } catch { /* skip */ }
    }
  }
  return settings;
}

// Selected ping method from settings (Settings → «Метод проверки пинга»).
// 'proxy' = Ping via Proxy GET (real HTTP GET through the proxy, like Happ —
// works on white-list mobile networks where the raw server IP is unreachable),
// 'tcp' = plain TCP connect to the server IP.
export type PingMode = 'proxy' | 'tcp';
export function getPingMode(): PingMode {
  if (typeof localStorage === 'undefined') return 'proxy';
  const raw = localStorage.getItem('sim-ping-mode')?.replace(/"/g, '');
  return raw === 'tcp' ? 'tcp' : 'proxy';
}

// DoH-резолв A-записи через HTTPS к ГОЛОМУ IP резолвера. На белых списках РФ
// системный DNS не отдаёт домен сервера, а UDP/53 к публичным резолверам прижат —
// поэтому ходим по HTTPS (443) к 8.8.8.8//1.1.1.1, чьи сертификаты содержат
// собственный IP в SAN (TLS валиден без DNS). Возвращает IPv4-строку или null.
async function dohResolveA(domain: string): Promise<string | null> {
  const endpoints = [
    `https://8.8.8.8/resolve?name=${encodeURIComponent(domain)}&type=A`,
    `https://1.1.1.1/dns-query?name=${encodeURIComponent(domain)}&type=A&ct=application/dns-json`,
  ];
  for (const url of endpoints) {
    try {
      const res = await nativeFetchUrl(url);
      const body = typeof res === 'string' ? res : (res as any)?.body;
      if (!body) continue;
      const json = JSON.parse(body);
      const answers = Array.isArray(json?.Answer) ? json.Answer : [];
      for (const a of answers) {
        // type 1 = A-запись; data — IPv4.
        if (a && a.type === 1 && typeof a.data === 'string' && /^[0-9.]+$/.test(a.data)) {
          return a.data;
        }
      }
    } catch { /* пробуем следующий эндпоинт */ }
  }
  return null;
}

// Кэш «nodeId → последний пинг через ЖИВОЙ SOCKS» (VPN-ON, активный сервер).
// v2: пишем ТОЛЬКО из live SOCKS. VPN-OFF тесты сюда не пишут — иначе значения
// с незаблокированных сетей загрязняют кэш и показываются на DPI-сетях.
// На stateful DPI (РФ белые списки) все новые соединения RST-инжектируются,
// поэтому единственный надёжный источник — живое соединение активного VPN.
const PING_RESULT_CACHE_KEY = 'sim-ping-result-cache-v2';
function getCachedPingResult(nodeId: string): number | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const m = JSON.parse(localStorage.getItem(PING_RESULT_CACHE_KEY) || '{}');
    return typeof m[nodeId] === 'number' ? m[nodeId] : null;
  } catch { return null; }
}
function setCachedPingResult(nodeId: string, ms: number): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const m = JSON.parse(localStorage.getItem(PING_RESULT_CACHE_KEY) || '{}');
    m[nodeId] = ms;
    const keys = Object.keys(m);
    if (keys.length > 500) { delete m[keys[0]]; }
    localStorage.setItem(PING_RESULT_CACHE_KEY, JSON.stringify(m));
  } catch { /* ignore */ }
}

// Отдельный кэш BYPASS-пингов — только значения измеренные через bypass-цепочку
// (pingViaFullCore / live SOCKS). TCP-пинги сюда НЕ записываются.
// Используется при VPN-ON: показывает только серверы, реально обходящие DPI.
// Записи хранятся в формате {ms, ts} и имеют TTL; при VPN-ON TTL не применяется
// (обновить не можем — второе ядро недоступно).
const BYPASS_PING_CACHE_KEY = 'sim-bypass-ping-cache-v4'; // v4: ТОЛЬКО live-SOCKS (VPN-ON активный сервер)
const BYPASS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 минут

// respectTtl=true (по умолчанию): при VPN-OFF, чтобы не показывать устаревший кэш.
// respectTtl=false: при VPN-ON, когда обновить невозможно — показываем любое значение.
function getCachedBypassPing(nodeId: string, respectTtl = true): number | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const m = JSON.parse(localStorage.getItem(BYPASS_PING_CACHE_KEY) || '{}');
    const raw = m[nodeId];
    if (raw === undefined || raw === null) return null;
    // Старый формат (plain number) — возраст неизвестен, считаем устаревшим.
    if (typeof raw === 'number') return respectTtl ? null : raw;
    if (typeof raw === 'object' && typeof raw.ms === 'number') {
      if (respectTtl && Date.now() - (raw.ts || 0) > BYPASS_CACHE_TTL_MS) return null;
      return raw.ms;
    }
    return null;
  } catch { return null; }
}
function setCachedBypassPing(nodeId: string, ms: number): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const m = JSON.parse(localStorage.getItem(BYPASS_PING_CACHE_KEY) || '{}');
    m[nodeId] = { ms, ts: Date.now() };
    const keys = Object.keys(m);
    if (keys.length > 500) { delete m[keys[0]]; }
    localStorage.setItem(BYPASS_PING_CACHE_KEY, JSON.stringify(m));
  } catch { /* ignore */ }
}
function clearCachedBypassPing(nodeId: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const m = JSON.parse(localStorage.getItem(BYPASS_PING_CACHE_KEY) || '{}');
    delete m[nodeId];
    localStorage.setItem(BYPASS_PING_CACHE_KEY, JSON.stringify(m));
  } catch { /* ignore */ }
}

// Возвращает лучший известный пинг для ноды из любого кэша (-1 если нет).
// Используется авто-переключением для сортировки кандидатов без лишних замеров.
export function getBestCachedPing(nodeId: string): number {
  const bypass = getCachedBypassPing(nodeId, false); // TTL игнорируем — нужна любая оценка
  const regular = getCachedPingResult(nodeId);
  const best = Math.min(bypass ?? Infinity, regular ?? Infinity);
  return isFinite(best) && best > 0 ? best : -1;
}

// Anti-filter кэш: результаты фонового batch-теста серверов (AntiFilter batch).
// Тест идёт через measureOutboundDelay (libxray static, без подъёма ядра через VPN).
// REALITY-серверы без fragment проходят белый список РФ — получаем реальный пинг.
// Кэш сбрасывается только при новом batch-тесте (событие 'antifilter-update').
let antiFilterMemCache: Map<string, { ms: number; ts: number }> = new Map();
const ANTIFILTER_TTL_MS = 30 * 60 * 1000; // 30 минут

export function refreshAntiFilterCache(): void {
  const bridge = getNative() as any;
  if (!bridge?.getAntiFilterPings) return;
  try {
    const raw: string = bridge.getAntiFilterPings();
    const data = JSON.parse(raw) as Record<string, { ms: number; ts: number }>;
    antiFilterMemCache.clear();
    for (const [id, val] of Object.entries(data)) {
      if (val && typeof val.ms === 'number') {
        antiFilterMemCache.set(id, val);
      }
    }
    console.log('[SIM-AF] cache loaded:', antiFilterMemCache.size, 'entries');
  } catch (e) {
    console.warn('[SIM-AF] refreshAntiFilterCache error:', e);
  }
}

export function nativeStartAntiFilterBatch(nodes: ServerNode[]): void {
  const bridge = getNative() as any;
  if (!bridge?.startAntiFilterBatch) return;
  const settings = readPingSettings();
  const servers: Array<{ id: string; config: string }> = [];
  for (const node of nodes) {
    try {
      const cfg = buildMeasureConfig(node, settings);
      servers.push({ id: node.id, config: JSON.stringify(cfg) });
    } catch { /* skip unconfigurable nodes */ }
  }
  if (servers.length === 0) return;
  console.log('[SIM-AF] starting batch for', servers.length, 'servers');
  // Очищаем in-memory кэш сразу: stale данные не показываем пока batch не завершится
  antiFilterMemCache.clear();
  try {
    bridge.startAntiFilterBatch(JSON.stringify(servers));
  } catch (e) {
    console.warn('[SIM-AF] startAntiFilterBatch error:', e);
  }
}

// Кэш «домен сервера → последний удачно отрезолвленный IP». На белом списке РФ
// и системный DNS, и DoH к 8.8.8.8/1.1.1.1 прижаты, но сам IP сервера достижим
// (через него же идёт туннель). IP кэшируется на нормальной сети / сквозь поднятый
// туннель и переиспользуется для TCP-замера при выключенном VPN, где резолв невозможен.
const SERVER_IP_CACHE_KEY = 'sim-server-ip-cache';
function getCachedServerIp(domain: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const m = JSON.parse(localStorage.getItem(SERVER_IP_CACHE_KEY) || '{}');
    return typeof m[domain] === 'string' ? m[domain] : null;
  } catch { return null; }
}
function setCachedServerIp(domain: string, ip: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const m = JSON.parse(localStorage.getItem(SERVER_IP_CACHE_KEY) || '{}');
    m[domain] = ip;
    localStorage.setItem(SERVER_IP_CACHE_KEY, JSON.stringify(m));
  } catch { /* ignore */ }
}


// Эндпоинт сервера для TCP-замера. Для обычной ноды — node.address/port; для raw-
// JSON — первый server-домен из outbounds (vnext/servers), предпочтительно тег "proxy".
function serverEndpointOf(node: ServerNode): { addr: string; port: number } {
  if (node.protocol !== 'json') return { addr: node.address || '', port: node.port || 443 };
  try {
    const parsed = JSON.parse((node.rawLink || '').trim());
    const cfg: any = Array.isArray(parsed) ? parsed[0] : parsed;
    const obs: any[] = Array.isArray(cfg?.outbounds) ? cfg.outbounds : [];
    const pick = obs.find((o) => o?.tag === 'proxy' && (o?.settings?.vnext || o?.settings?.servers))
              || obs.find((o) => o?.settings?.vnext || o?.settings?.servers);
    const srv = pick?.settings?.vnext?.[0] || pick?.settings?.servers?.[0];
    if (srv?.address) return { addr: srv.address, port: Number(srv.port) || node.port || 443 };
  } catch { /* ignore */ }
  return { addr: node.address || '', port: node.port || 443 };
}

// Резолвит домен сервера ЧЕРЕЗ живой SOCKS-прокси (туннель доходит до 1.1.1.1).
// КРИТИЧНО: приложение исключено из VPN, поэтому ПРЯМОЙ DoH из него на белом списке
// прижат даже при поднятом туннеле (проверено: connect к 8.8.8.8/1.1.1.1 таймаутит
// 20с). А DoH сквозь SOCKS идёт по туннелю и резолвит. Возвращает IPv4 или ''.
async function nativeResolveViaProxy(domain: string): Promise<string> {
  if (!isNative()) return '';
  try { return await callNativeAsync<string>('resolveHostViaProxy', domain); } catch { return ''; }
}

// Опортунистически кэширует IP сервера, пока туннель поднят (резолв идёт СКВОЗЬ
// SOCKS — единственный рабочий путь на белом списке). После отключения на той же
// сети резолв уже не пройдёт, а TCP к закэшированному IP — да. Fire-and-forget.
function cacheServerIpInBackground(node: ServerNode): void {
  const { addr } = serverEndpointOf(node);
  if (!addr || /^[0-9.]+$/.test(addr) || addr.includes(':') || getCachedServerIp(addr)) return;
  nativeResolveViaProxy(addr).then((ip) => { if (ip) setCachedServerIp(addr, ip); }).catch(() => { /* ignore */ });
}

// TCP-замер до сервера. На белом списке РФ единственный рабочий путь — TCP к
// КЭШИРОВАННОМУ IP (DNS и DoH там прижаты, но IP сервера достижим). На обычной
// сети резолвим системно/через DoH и попутно наполняем кэш на будущее.
async function tcpPingResolved(node: ServerNode): Promise<number> {
  const { addr, port } = serverEndpointOf(node);
  if (!addr) return -1;
  const isIp = /^[0-9.]+$/.test(addr) || addr.includes(':');
  if (isIp) return nativePing(addr, port, 3000);

  // 1) Кэшированный IP — единственный путь на строгом белом списке.
  const cached = getCachedServerIp(addr);
  if (cached) {
    const t = await nativePing(cached, port, 3000);
    if (t > 0) return t;
  }

  // 2) Обычная сеть: прямой TCP по домену (Android резолвит DNS).
  const direct = await nativePing(addr, port, 3000);
  if (direct > 0) {
    if (!cached) dohResolveA(addr).then((ip) => { if (ip) setCachedServerIp(addr, ip); }).catch(() => { /* ignore */ });
    return direct;
  }

  // 3) Прямой DNS не прошёл — DoH и кэшируем.
  const ip = await dohResolveA(addr);
  if (ip) {
    setCachedServerIp(addr, ip);
    return nativePing(ip, port, 3000);
  }
  return -1;
}

// Строит ping-конфиг (ТОЛЬКО SOCKS-вход, без TUN) из raw-JSON ноды. Это зеркало
// инлайнового билдера боевого конфига в src/App.tsx (handleToggle, ветка
// protocol==='json'): та же трансформация (inboundTag снят, mux off, sockopt
// почищен, server-домены → localhost-DNS), но без TUN-инбаунда — для замера
// прокси-GET. ВАЖНО: держать в синхроне с App.tsx; при правке трансформации
// боевого конфига править ОБА места.
function buildJsonPingConfig(node: ServerNode): any {
  const raw = (node.rawLink || '').trim();
  const parsed = JSON.parse(raw);
  const cfg: any = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!cfg || typeof cfg !== 'object') throw new Error('json config must be an object');

  // Системные секции десктоп-клиента, требующие своих inbound'ов, — убираем.
  delete cfg.test;
  delete cfg.api;
  delete cfg.stats;
  // metrics вызывает "panic: Reuse of exported var name: stats" → SIGABRT → краш.
  delete cfg.metrics;
  // Упрощаем балансеры → прямые outbound-теги, затем удаляем их и observatory.
  // Xray 26.x требует observatory при наличии balancers (иначе "not all dependencies resolved"
  // → ядро не стартует). Для замера одной ноды балансировка не нужна — берём первый outbound.
  if (Array.isArray(cfg.routing?.balancers) && cfg.routing.balancers.length > 0) {
    const balMap: Record<string, string> = {};
    for (const b of cfg.routing.balancers) {
      if (b?.tag && Array.isArray(b.selector) && b.selector.length > 0) {
        balMap[b.tag] = b.selector[0];
      }
    }
    cfg.routing.rules = (cfg.routing.rules || []).map((r: any) => {
      if (r?.balancerTag && balMap[r.balancerTag]) {
        const { balancerTag: _drop, ...rest } = r;
        return { ...rest, outboundTag: balMap[r.balancerTag] };
      }
      return r;
    });
    delete cfg.routing.balancers;
  }
  delete cfg.observatory;
  delete cfg.burstObservatory;

  // Только SOCKS-вход для измерительного GET (TUN не нужен — fd нет). Порт —
  // заглушка: нативный слой подменит на свободный (под параллельные пинги списка).
  cfg.inbounds = [
    {
      tag: "socks-in",
      port: 21080,
      listen: "127.0.0.1",
      protocol: "socks",
      settings: { udp: false, auth: "noauth", userLevel: 8 },
      sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], routeOnly: false }
    }
  ];

  // Чистим Android-несовместимый sockopt и выключаем mux (как в App.tsx).
  if (!Array.isArray(cfg.outbounds)) cfg.outbounds = [];
  cfg.outbounds.forEach((ob: any) => {
    if (ob?.streamSettings?.sockopt) {
      delete ob.streamSettings.sockopt.interface;
      delete ob.streamSettings.sockopt.mark;
    }
    if (ob && ob.mux) ob.mux = { enabled: false };
  });

  const ensureOutbound = (tag: string, protocol: string) => {
    if (!cfg.outbounds.some((o: any) => o.tag === tag)) cfg.outbounds.push({ tag, protocol });
  };
  ensureOutbound("direct", "freedom");
  ensureOutbound("block", "blackhole");
  ensureOutbound("dns-out", "dns");

  if (!cfg.dns || typeof cfg.dns !== 'object') {
    cfg.dns = { servers: ["1.1.1.1", "8.8.8.8"], queryStrategy: "UseIPv4" };
  }

  // Домены САМИХ серверов резолвим напрямую (localhost), иначе DoH-дедлок (чтобы
  // сделать DoH-запрос, надо подключиться к серверу, а чтобы подключиться —
  // резолвить его домен). Приложение исключено из VPN → системный резолвер ходит
  // напрямую — ровно так же, как при боевом подключении (проверено на белом списке).
  try {
    const serverDomains: string[] = [];
    (cfg.outbounds || []).forEach((ob: any) => {
      (ob?.settings?.vnext || []).forEach((v: any) => { if (v?.address) serverDomains.push(v.address); });
      (ob?.settings?.servers || []).forEach((s: any) => { if (s?.address) serverDomains.push(s.address); });
    });
    const sdRules = serverDomains
      .filter((a) => a && !/^[0-9.]+$/.test(a) && a.indexOf(':') === -1)
      .map((a) => `full:${a}`);
    if (sdRules.length && Array.isArray(cfg.dns.servers)) {
      cfg.dns.servers.unshift({ address: "localhost", domains: sdRules, skipFallback: true });
    }
  } catch { /* ignore */ }

  // Для пинга НЕ сохраняем провайдерский routing — он может направить тестовый домен
  // (cp.cloudflare.com) в direct (Cloudflare часто в direct-правилах → Connection reset).
  // Вместо этого: минимальный routing, всё через главный proxy-outbound.
  // Fragment/dialerProxy-цепочка работает через stream settings outbound'а, не routing.
  const mainProxyOb = (cfg.outbounds || []).find((o: any) =>
    o && typeof o.protocol === 'string' &&
    !['freedom', 'blackhole', 'dns', 'loopback'].includes(o.protocol)
  );
  const mainProxyTag = mainProxyOb?.tag || 'proxy';
  cfg.routing = {
    domainStrategy: 'AsIs',
    rules: [
      { type: 'field', network: 'tcp,udp', outboundTag: mainProxyTag }
    ]
  };

  cfg.log = { loglevel: "warning" };
  delete cfg.remarks;
  return cfg;
}

// Unified, white-list-aware ping used by both the server list and profiles
// screens. When the VPN is CONNECTED, measures a real HTTP GET through the live
// tunnel (accurate), caches the result AND the server IP for later. When NOT
// connected, measures the Happ way — libxray measureOutboundDelay brings up the
// outbound (REALITY+fragment) internally and hits gstatic, which passes RF white
// lists. Fallbacks: TCP to the cached server IP, then the last live ping (so the
// list shows a number, not a dash, when direct measurement is impossible).
// vpnConnected = true когда VPN активен. При включённом VPN только подключённый
// сервер получает live-замер через живой SOCKS; для всех остальных TCP-фоллбек
// скипается (он даёт ложный результат через VPN-тоннель) и сразу идёт кэш.
// forceRefresh=true: пропускает bypass fast-path кэш (используется при явном «Проверить скорость»).
export async function nativePingNode(node: ServerNode, mode: PingMode = getPingMode(), vpnConnected = false, forceRefresh = false): Promise<number> {
  return measurePingNode(node, mode, vpnConnected, forceRefresh);
}

// Минимальный ping-конфиг по образцу Happ (xray_config.json из APK Happ).
// Только outbound ноды + stats:{} + policy + пустой routing/dns.
// НЕ добавляем fragment — для REALITY не нужен, для обычных серверов опционально.
// Ping-конфиг по образцу Happ. Включает fragment/noise из settings — без них временное
// ядро не проходит DPI белого списка и пинг всегда падает в -1 (КРИТИЧНО для РФ).
function buildNodePingConfig(node: ServerNode, settings: Record<string, unknown> = {}): any {
  if (node.protocol === 'json') return buildJsonPingConfig(node);

  const fragEnabled = !!(settings as any).fragEnable;
  const noisesEnabled = !!(settings as any).noisesEnable;
  const useBypassChain = fragEnabled || noisesEnabled;

  const outbound = buildOutboundConfig(node, useBypassChain ? { fragmentTag: 'fragment' } : undefined);
  outbound.mux = { enabled: false };

  const bypassOutbound: any = useBypassChain
    ? { tag: 'fragment', protocol: 'freedom', settings: { domainStrategy: 'AsIs' } }
    : null;
  if (bypassOutbound && fragEnabled) {
    bypassOutbound.settings.fragment = getFragmentSpec(node, settings);
  }
  if (bypassOutbound && noisesEnabled) {
    bypassOutbound.settings.noises = getNoisesSpec(node, settings);
  }

  return {
    stats: {},
    log: { loglevel: "none" },
    policy: {
      levels: { "8": { handshake: 4, connIdle: 300, uplinkOnly: 1, downlinkOnly: 1 } },
      system: { statsOutboundUplink: true, statsOutboundDownlink: true }
    },
    // КРИТИЧНО для Happ-style ping: убираем inbounds.
    // Метод measureOutboundDelay сам поднимает нужный outbound.
    inbounds: [],
    outbounds: [
      outbound,
      ...(bypassOutbound ? [bypassOutbound] : []),
      { protocol: "freedom", tag: "direct" },
      { protocol: "blackhole", tag: "block" }
    ],
    routing: {
      domainStrategy: "IPIfNonMatch",
      rules: [
        // Гарантируем, что трафик к gstatic/IP пойдет через прокси
        { type: "field", outboundTag: "proxy", port: "80,443" }
      ]
    },
    dns: {
      // Используем localhost для резолва домена прокси-сервера
      servers: ["localhost", "1.1.1.1"],
      queryStrategy: "UseIPv4"
    }
  };
}

// Строит конфиг для measureOutboundDelayWithType (Happ-way).
// Использует полный VPN-конфиг как Happ: те же outbounds, DNS hosts (включая
// www.gstatic.com → 142.251.33.67), fragment-цепочку и т.д. — только убираем
// inbounds (measureOutboundDelayWithType сам диалит через первый outbound,
// inbounds для замера не нужны и конфликтуют с уже запущенным VPN-сокетом).
function buildMeasureConfig(node: ServerNode, settings: Record<string, unknown> = {}): any {
  const _raw = node.rawLink || '';
  if (node.protocol === 'json' || (_raw.length > 300 && _raw[0] === '{')) {
    const cfg = buildJsonPingConfig(node);
    cfg.inbounds = [];
    cfg.log = { loglevel: 'none' };
    let proxyTag = 'proxy';
    if (Array.isArray(cfg.outbounds)) {
      const proxyOb = cfg.outbounds.find((o: any) =>
        o && typeof o.protocol === 'string' &&
        !['freedom', 'blackhole', 'dns', 'loopback'].includes(o.protocol)
      );
      if (proxyOb) {
        proxyTag = proxyOb.tag || proxyTag;
        cfg.outbounds = [proxyOb, ...cfg.outbounds.filter((o: any) => o !== proxyOb)];
        const sockopt = proxyOb?.streamSettings?.sockopt;
        const hasDialerProxy = sockopt?.dialerProxy;
        const fragEnabled = !!(settings as any).fragEnable;
        const noisesEnabled = !!(settings as any).noisesEnable;
        const useBypassChain = fragEnabled || noisesEnabled;
        if (!hasDialerProxy && useBypassChain) {
          const fragTag = 'ping-fragment';
          if (!proxyOb.streamSettings) proxyOb.streamSettings = {};
          if (!proxyOb.streamSettings.sockopt) proxyOb.streamSettings.sockopt = {};
          proxyOb.streamSettings.sockopt.dialerProxy = fragTag;
          const fragOutbound: any = { tag: fragTag, protocol: 'freedom', settings: { domainStrategy: 'AsIs' } };
          if (fragEnabled) fragOutbound.settings.fragment = getFragmentSpec(node, settings);
          if (noisesEnabled) fragOutbound.settings.noises = getNoisesSpec(node, settings);
          cfg.outbounds.push(fragOutbound);
        }
      }
    }
    // Перезаписываем routing так же как для обычных нод: оригинальный routing JSON-конфига
    // может отправлять msftncsi.com:80 через direct (→ DPI блокирует) или через неверный
    // outbound. domainStrategy=AsIs исключает DNS-резолв при роутинге (не нужен на DPI).
    cfg.routing = {
      domainStrategy: 'AsIs',
      rules: [{ type: 'field', port: '80,443', outboundTag: proxyTag }]
    };
    // На белых списках UDP/53 к внешним DNS блокируется → таймаут DNS до ping-цели.
    // Хардкодим IP пинг-доменов так же как buildXrayConfig делает для обычных нод.
    if (!cfg.dns || typeof cfg.dns !== 'object') cfg.dns = {};
    if (!cfg.dns.hosts) cfg.dns.hosts = {};
    Object.assign(cfg.dns.hosts, {
      'cp.cloudflare.com': '1.1.1.1',
      'connectivitycheck.gstatic.com': '142.251.33.67',
      'connectivitycheck.android.com': '142.251.33.67',
      'www.gstatic.com': '142.251.33.67',
    });
    return cfg;
  }

  // Обычные ноды: полный VPN-конфиг как основа (outbound + dns.hosts),
  // routing перезаписываем — для замера пинга нужен чистый путь через прокси.
  const cfg = JSON.parse(buildXrayConfig(node, settings));
  cfg.inbounds = [];
  cfg.log = { loglevel: 'none' };
  cfg.routing = {
    domainStrategy: 'AsIs',
    rules: [{ type: 'field', port: '80,443', outboundTag: 'proxy' }]
  };

  return cfg;
}

// measureOutboundDelay — НЕ ИСПОЛЬЗОВАТЬ для bypass-теста на DPI-сетях:
// в этом форке libxray падает с "closed pipe" при dialerProxy в конфиге.
// bypass-тест идёт через nativePingProxy (pingViaFullCore — полный temp-core).
async function nativeMeasureDelay(configJson: string, url: string): Promise<number> {
  if (!isNative()) return -1;
  try { return await callNativeAsync<number>('measureDelay', configJson, url); } catch { return -1; }
}

function getAntiFilterCached(nodeId: string): number {
  const af = antiFilterMemCache.get(nodeId);
  return (af && Date.now() - af.ts < ANTIFILTER_TTL_MS) ? af.ms : -1;
}

// Протоколы, которые Xray-core не поддерживает — для них нельзя строить Xray-конфиг.
// Используем прямой TCP-пинг: он показывает доступность сервера, но не реальный DPI-bypass.
const MIHOMO_TCP_ONLY = new Set(['hysteria', 'hysteria2', 'tuic', 'anytls', 'shadowtls', 'naive']);

async function measurePingNode(node: ServerNode, _mode: PingMode, vpnConnected = false, forceRefresh = false): Promise<number> {
  const settings = readPingSettings();
  const t0 = Date.now();
  console.log('[SIM-PING] start', node.address, 'proto=', node.protocol, 'vpn=', vpnConnected, 'force=', forceRefresh);

  // ── Mihomo-only протоколы: Xray их не знает → TCP-пинг ──────────────────────
  if (MIHOMO_TCP_ONLY.has(node.protocol)) {
    const cached = getAntiFilterCached(node.id) || getCachedPingResult(node.id) || 0;
    if (!forceRefresh && cached > 0) {
      console.log('[SIM-PING] mihomo TCP cache', node.address, cached, 'ms');
      return cached;
    }
    const tcp = await nativePing(node.address, node.port, 5000);
    console.log('[SIM-PING] mihomo TCP ping', node.address, '->', tcp, 'ms, took', Date.now() - t0, 'ms');
    if (tcp > 0) setCachedPingResult(node.id, tcp);
    return tcp;
  }

  // ── VPN включён ─────────────────────────────────────────────────────────────
  if (vpnConnected) {
    let pingConfig: any;
    try { pingConfig = buildMeasureConfig(node, settings); } catch (e: any) {
      console.log('[SIM-PING] buildConfig THREW (vpn=ON):', e?.message);
      return getAntiFilterCached(node.id) || getCachedPingResult(node.id) || -1;
    }
    const liveResult = await nativePingProxy(JSON.stringify(pingConfig), 'proxy');
    console.log('[SIM-PING] vpn=ON', node.address, '->', liveResult, 'ms, took', Date.now()-t0, 'ms');
    if (liveResult > 0) {
      // Live SOCKS — единственный надёжный источник. Сохраняем.
      setCachedPingResult(node.id, liveResult);
      return liveResult;
    }
    // Не-активный сервер: антифильтр-кэш → live-SOCKS кэш → -1
    return getAntiFilterCached(node.id) || getCachedPingResult(node.id) || -1;
  }

  // ── VPN выключен ─────────────────────────────────────────────────────────────
  // Happ-style: только результат measureOutboundDelayWithType — никаких кэш-фоллбэков.
  // Кэши показывали бы старые значения с нефильтрованных сетей для серверов,
  // которые не обходят DPI на текущей сети (поведение не как у Happ).
  let measureConfig: any;
  try { measureConfig = buildMeasureConfig(node, settings); } catch (e: any) {
    console.log('[SIM-PING] buildConfig THREW (vpn=OFF):', e?.message);
    return -1;
  }
  const bypassResult = await nativePingProxy(JSON.stringify(measureConfig), 'proxy');
  console.log('[SIM-PING] vpn=OFF', node.address, '->', bypassResult, 'ms, took', Date.now()-t0, 'ms');
  return bypassResult;
}

export const DPI_PROBE_PRESETS = [
  { fragEnable: false, fragPackets: 'tlshello', fragLength: '10-20', fragInterval: '10-20', noisesEnable: false, noisesType: 'rand', noisesDelay: '50', noisesRand: '1-1024' },
  { fragEnable: true,  fragPackets: 'tlshello', fragLength: '10-20', fragInterval: '10-20', noisesEnable: false, noisesType: 'rand', noisesDelay: '50', noisesRand: '1-1024' },
  { fragEnable: true,  fragPackets: 'tlshello', fragLength: '1-5',   fragInterval: '3-7',   noisesEnable: false, noisesType: 'rand', noisesDelay: '50', noisesRand: '1-1024' },
  { fragEnable: true,  fragPackets: 'tlshello', fragLength: '5-10',  fragInterval: '5-10',  noisesEnable: true,  noisesType: 'rand', noisesDelay: '50', noisesRand: '1-1024' },
] as const;

export type DpiProbeResult = typeof DPI_PROBE_PRESETS[number];
