import { SUBSCRIPTION_USER_AGENT } from '../utils/userAgent';
/**
 * iOS-мост: ставит window.SimNativeV2 поверх Capacitor-плагина SimNativeV2 (Swift,
 * ios/App/App/SimNativeV2.swift + PacketTunnel). Без этого моста bridge.ts на iOS
 * считал бы платформу «браузером» и показывал бы симуляции вместо реального VPN.
 *
 * Ставим ТОЛЬКО когда платформа iOS и мост ещё не установлен (на Android мост
 * навешивает NativeBridge.java как addJavascriptInterface — наша установка ничего
 * бы не сломала, но и не нужна).
 *
 * Два стиля вызова, как в bridge.ts:
 *  - «задача»: вызов выглядит как fn(...args, taskId), результат придёт в
 *    window.onNativeTaskComplete(taskId, value) — оборачиваем промис плагина;
 *  - «прямой»: fn(...) → Promise, bridge.ts теперь ждёт его (await добавлен).
 * Плюс синхронные-на-вид методы (hasInternetNow/getNetworkCarrier): держим кэш,
 * который обновляется из событий плагина, и отдаём его синхронно.
 */

const w = window as any;

function isIosPlatform(): boolean {
  try {
    const cap = w.Capacitor;
    return !!(cap && typeof cap.getPlatform === 'function' && cap.getPlatform() === 'ios');
  } catch {
    return false;
  }
}

let pluginProxy: any = null;

/**
 * Возвращает прокси нативного плагина, регистрируя его при необходимости.
 *
 * ВАЖНО: `Capacitor.Plugins.SimNativeV2` сам по себе НЕ существует — объект
 * Plugins заполняется только внутри `registerPlugin()` (см. @capacitor/core:
 * `Plugins[pluginName] = proxy`). Нативная сторона инжектит лишь
 * `Capacitor.PluginHeaders` (iOS: JSExport.swift:101), по которому registerPlugin
 * понимает, что плагин есть на устройстве, и подключает вызовы к мосту.
 * Без этой регистрации прокси никогда не создаётся и мост не ставится.
 */
function getPlugin(): any {
  if (pluginProxy) return pluginProxy;
  try {
    const cap = w.Capacitor;
    if (!cap) return null;
    // Уже зарегистрирован (нами ранее или другим модулем).
    if (cap.Plugins && cap.Plugins.SimNativeV2) {
      pluginProxy = cap.Plugins.SimNativeV2;
      return pluginProxy;
    }
    const headers = cap.PluginHeaders;
    const hasNative =
      Array.isArray(headers) && headers.some((h: any) => h && h.name === 'SimNativeV2');
    if (!hasNative || typeof cap.registerPlugin !== 'function') return null;
    pluginProxy = cap.registerPlugin('SimNativeV2');
    return pluginProxy;
  } catch (e) {
    console.warn('[SIM-IOS] registerPlugin(SimNativeV2) failed:', e);
    return null;
  }
}

// ── Кэш синхронных значений ─────────────────────────────────────────────────
// hasInternetNow() и getNetworkCarrier() bridge.ts зовёт СИНХРОННО (без await),
// поэтому отдаём последнее известное значение, обновляемое событиями плагина.
let cachedHasInternet = true;
let cachedCarrier = '';

/**
 * Вызывает метод плагина с одним объектом именованных аргументов (Capacitor-конвенция:
 * Swift читает call.getString("...")/call.getInt("...")). При отсутствии метода/плагина — reject.
 */
function callPlugin(method: string, opts: Record<string, any> = {}): Promise<any> {
  const p = getPlugin();
  if (!p) return Promise.reject(new Error('SimNativeV2 plugin not available'));
  if (typeof p[method] !== 'function') return Promise.reject(new Error(`SimNativeV2.${method} not implemented`));
  return Promise.resolve(p[method](opts));
}

/**
 * Оборачивает промис плагина в семантику «задачи»: fn(...positional, taskId).
 * Позиционные аргументы превращаются в именованные через buildOpts; taskId
 * вырезается из хвоста вызова bridge.ts и уходит в resolve через onNativeTaskComplete.
 * При ошибке доводим задачу фоллбэком нужной формы, чтобы промис bridge.ts не завис.
 */
function task(method: string, buildOpts: (positional: any[]) => Record<string, any>, fallback: (err: string) => any) {
  return (...callArgs: any[]) => {
    const taskId = String(callArgs.pop() ?? '');
    const complete = (value: any) => {
      if (w.onNativeTaskComplete) w.onNativeTaskComplete(taskId, value);
    };
    callPlugin(method, buildOpts(callArgs)).then(complete).catch((e: any) => {
      console.warn(`[SIM-IOS] ${method} failed:`, e);
      complete(fallback(String(e?.message ?? e)));
    });
  };
}

// Фоллбэки ошибок — по форме результата каждого метода (см. bridge.ts).
const asNumber = () => -1;
const asString = () => '';
const asFalse = () => false;
const asVoidOk = () => ({ ok: true } as any);
const asFetchError = (err: string) => ({ ok: false, error: err, body: '' } as any);
const asProbeError = (err: string) => ({ ok: false, stage: 'tcp', error: err } as any);
const asStartError = (err: string) => ({ ok: false, error: err } as any);

// ── Правила маршрутизации (хранилище — localStorage; аналог RoutingRulesManager) ─
const RULES_KEY = 'sim-ios-routing-rules';

function readRulesRaw(): any[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RULES_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRulesRaw(rules: any[]): void {
  try { localStorage.setItem(RULES_KEY, JSON.stringify(rules)); } catch { /* приватный режим */ }
}

function isValidIpv4(ip: string): boolean {
  return /^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip);
}

/** Конвертация правила → Xray {type:'field', domain/ip, outboundTag}. Зеркало RoutingRulesManager.java:224-270. */
function ruleToXray(rule: any): any | null {
  const xrayRule: any = { type: 'field' };
  if (rule.type === 'domain') {
    const domains: string[] = [];
    for (const part of String(rule.pattern || '').split(',')) {
      let d = part.trim();
      if (!d) continue;
      // Xray не понимает "*.ru": бессуфиксный домен и так матчит поддомены.
      if (d.startsWith('*.')) d = d.slice(2);
      domains.push(d);
    }
    xrayRule.domain = domains;
  } else if (rule.type === 'ip') {
    const ips: string[] = [];
    for (const part of String(rule.pattern || '').split(',')) {
      const t = part.trim();
      if (!t) continue;
      ips.push((t.includes('/') || isValidIpv4(t) || t.includes(':')) ? t : `geoip:${t}`);
    }
    xrayRule.ip = ips;
  } else if (rule.type === 'geoip') {
    xrayRule.ip = String(rule.pattern || '').split(',').map((c: string) => `geoip:${c.trim()}`).filter((s: string) => s.length > 'geoip:'.length);
  }
  // 'custom' — в Java ветки нет: правило содержит только outboundTag (матчит всё).
  xrayRule.outboundTag = rule.action;
  return xrayRule;
}

function toXrayRules(): any[] {
  return readRulesRaw().filter((r) => r && r.enabled !== false).map(ruleToXray).filter(Boolean);
}

// ── Пересылка событий плагина в window CustomEvent ───────────────────────────
// Swift шлёт notifyListeners(...); Capacitor доставляет их в addListener.
// bridge.ts ждёт window-события (ping-batch-item и т.п.) — пробрасываем.
const FORWARDED_EVENTS = ['ping-batch-item', 'ping-batch-done', 'network-changed', 'deeplink', 'antifilter-update', 'update-progress'];

function forwardEvents(plugin: any): void {
  if (typeof plugin.addListener !== 'function') return;
  for (const name of FORWARDED_EVENTS) {
    try {
      plugin.addListener(name, (detail: any) => {
        if (name === 'network-changed') {
          const d = detail || {};
          // Синхронный кэш: событие — единственный источник актуальности для
          // nativeHasInternet()/nativeGetNetworkCarrier(), которые зовутся без await.
          cachedHasInternet = d.event !== 'unavailable';
          if (typeof d.carrier === 'string') cachedCarrier = d.carrier;
        }
        w.dispatchEvent(new CustomEvent(name, { detail }));
      });
    } catch (e) {
      console.warn('[SIM-IOS] addListener failed for', name, e);
    }
  }
}

// ── Установка моста ──────────────────────────────────────────────────────────
let eventsForwarded = false;
let installAttempts = 0;

export function installIosShim(): void {
  if (w.SimNativeV2 || w.SimProxyBridge || w.AndroidBridge) return; // мост уже есть
  if (!isIosPlatform()) return;
  if (!w.Capacitor) {
    // Модуль Capacitor ещё не выполнился — повторим после загрузки страницы.
    if (installAttempts++ < 50) setTimeout(() => installIosShim(), 100);
    return;
  }
  const plugin = getPlugin();
  if (!plugin) {
    // Заголовка нативного плагина нет (сборка без PacketTunnel) — работаем как
    // браузер. Немного повторяем на случай гонки инжекта скрипта.
    if (installAttempts++ < 50) {
      setTimeout(() => installIosShim(), 100);
      return;
    }
    console.warn('[SIM-IOS] Capacitor plugin SimNativeV2 not registered, staying in web mode');
    return;
  }

  // Начальное значение кэша носителя: плагин пришлёт событие при первом мониторинге.
  try {
    callPlugin('getCarrier').then((r: any) => {
      const v = typeof r === 'string' ? r : r?.result;
      if (typeof v === 'string' && v) cachedCarrier = v;
    }).catch(() => {});
  } catch { /* необязательно */ }

  if (!eventsForwarded) {
    eventsForwarded = true;
    forwardEvents(plugin);
  }

  const bridge: any = {
    // ── VPN ────────────────────────────────────────────────────────────────
    // nativeStartVpnWithResult шлёт ОДИН JSON-payload (config/settings/fallbacks/shield).
    startVpnWithResult: task('startVpnWithResult', (a) => ({ payload: String(a[0] ?? '{}') }), asStartError),
    stopVpn: (reason: string) => callPlugin('stopVpn', { reason: reason || 'unknown' }).then((r: any) => r?.result !== false).catch(() => true),
    getVpnStatus: () => callPlugin('getVpnStatus').then((r: any) => (r?.result as string) || 'disconnected').catch(() => 'disconnected'),
    getStats: () => callPlugin('getStats').then((r: any) => r?.result ?? null).catch(() => null),
    getDetailedStats: () => callPlugin('getDetailedStats').then((r: any) => r?.result ?? {}).catch(() => ({})),
    isShieldMode: () => callPlugin('isShieldMode').then((r: any) => !!r?.result).catch(() => false),
    getActiveNodeId: () => callPlugin('getActiveNodeId').then((r: any) => (typeof r?.result === 'string' ? r.result : '')).catch(() => ''),

    // ── Пробы и пинги ──────────────────────────────────────────────────────
    pingServer: task('pingServer', (a) => ({ address: String(a[0] ?? ''), port: Number(a[1] ?? 0), timeout: Number(a[2] ?? 5000) }), asNumber),
    pingServerDirect: task('pingServerDirect', (a) => ({ address: String(a[0] ?? ''), port: Number(a[1] ?? 0) }), asNumber),
    probeTcp: task('probeTcp', (a) => ({ host: String(a[0] ?? ''), port: Number(a[1] ?? 0), timeoutMs: Number(a[2] ?? 5000) }), asProbeError),
    probeTcpViaTunnel: task('probeTcpViaTunnel', (a) => ({ host: String(a[0] ?? ''), port: Number(a[1] ?? 0), timeoutMs: Number(a[2] ?? 5000) }), asProbeError),
    // Режим: 'proxy' — через живой SOCKS; 'direct' — мимо туннеля (на iOS app всегда
    // идёт через туннель, поэтому Swift отдаёт тот же TCP-тайминг, что и direct).
    pingProxyServer: task('pingProxyServer', (a) => ({ configJson: String(a[0] ?? '{}'), mode: String(a[1] ?? 'direct') }), asNumber),
    testProxyDelay: task('testProxyDelay', () => ({}), asNumber),
    warmupCore: task('warmupCore', () => ({}), asString),
    fetchPublicIp: task('fetchPublicIp', () => ({}), () => null),
    startSpeedTest: task('startSpeedTest', () => ({}), () => ({ download: 0, upload: 0, ping: 0, timestamp: Date.now() })),
    testIpLeak: task('testIpLeak', () => ({}), (err: string) => ({ ipAddress: '', country: '', hasLeak: false, inconclusive: true, error: err, timestamp: Date.now() })),

    // ── Сеть/разрешения/устройство ─────────────────────────────────────────
    requestVpnPermission: task('requestVpnPermission', () => ({}), asFalse),
    requestAllPermissions: task('requestAllPermissions', () => ({}), asVoidOk),
    getBatteryStatus: task('getBatteryStatus', () => ({}), () => ({ doze: false, manufacturer: 'Apple' })),
    requestDozeExemption: task('requestDozeExemption', () => ({}), asVoidOk),
    requestOemBatterySettings: task('requestOemBatterySettings', () => ({}), asVoidOk),
    scanQrCode: task('scanQrCode', () => ({}), asString),
    checkTorPort: task('checkTorPort', () => ({}), () => ({ available: false })),
    openOrbotInstall: task('openOrbotInstall', () => ({}), asFalse),
    fetchUrl: task('fetchUrl', (a) => ({ url: String(a[0] ?? ''), userAgent: String(a[1] ?? SUBSCRIPTION_USER_AGENT) }), asFetchError),
    fetchUrlViaProxy: task('fetchUrlViaProxy', (a) => ({ url: String(a[0] ?? ''), userAgent: String(a[1] ?? SUBSCRIPTION_USER_AGENT), socksPort: Number(a[2] ?? 10808) }), asFetchError),
    getPendingDeepLink: task('getPendingDeepLink', () => ({}), asString),

    // ── Прямые (await-ятся в bridge.ts) ────────────────────────────────────
    getCoreVersions: () => callPlugin('getCoreVersions').then((r: any) => r?.result ?? null).catch(() => null),
    getSystemInfo: () => callPlugin('getSystemInfo').then((r: any) => r?.result ?? null).catch(() => null),
    getAppVersion: () => callPlugin('getAppVersion').then((r: any) => r?.result ?? null).catch(() => null),
    getDeviceId: () => callPlugin('getDeviceId').then((r: any) => r?.result ?? null).catch(() => null),
    getLastError: () => callPlugin('getLastError').then((r: any) => (typeof r?.result === 'string' ? r.result : '')).catch(() => ''),
    getLogs: () => callPlugin('getLogs').then((r: any) => (typeof r?.result === 'string' ? r.result : '')).catch(() => ''),
    readClipboard: () => callPlugin('readClipboard').then((r: any) => (typeof r?.result === 'string' ? r.result : '')).catch(() => ''),
    getCurrentNetwork: () => callPlugin('getCurrentNetwork').then((r: any) => (typeof r?.result === 'string' ? r.result : 'NONE')).catch(() => 'NONE'),
    isNetworkAvailable: () => callPlugin('isNetworkAvailable').then((r: any) => r?.result !== false).catch(() => true),
    getNetworkInfo: () => callPlugin('getNetworkInfo').then((r: any) => (typeof r?.result === 'string' ? r.result : '')).catch(() => ''),
    startNetworkMonitoring: () => { callPlugin('startNetworkMonitoring').catch(() => {}); },
    stopNetworkMonitoring: () => { callPlugin('stopNetworkMonitoring').catch(() => {}); },

    // ── Уведомления/статус-бар/утилиты (вызываются без проверки наличия) ───
    showNotification: (title: string, body: string) => { callPlugin('showNotification', { title: String(title ?? ''), body: String(body ?? '') }).catch(() => {}); },
    setStatusBarColor: (color: string, darkText: boolean) => { callPlugin('setStatusBarColor', { color: String(color ?? '#000000'), darkText: !!darkText }).catch(() => {}); },
    setStatusBarStyle: (style: string) => { callPlugin('setStatusBarStyle', { style: String(style ?? 'dark') }).catch(() => {}); },
    minimizeApp: () => { callPlugin('minimizeApp').catch(() => {}); },
    clearDnsCache: () => { callPlugin('clearDnsCache').catch(() => {}); },
    openUrl: (url: string) => { callPlugin('openUrl', { url: String(url ?? '') }).catch(() => { w.open(url, '_blank'); }); },
    vibrate: (duration: number) => { callPlugin('vibrate', { duration: Number(duration ?? 20) }).catch(() => {}); },

    // ── Синхронные (bridge.ts зовёт без await) ──────────────────────────────
    hasInternetNow: () => cachedHasInternet,
    getNetworkCarrier: () => cachedCarrier,

    // ── Настройки, которые на Android пишутся в prefs; здесь — localStorage ──
    // Важно: bridge.ts при наличии нативного метода НЕ пишет localStorage сам,
    // поэтому сохранение обязаны сделать здесь, иначе настройка теряется.
    toggleKillSwitch: (enabled: boolean) => {
      try { localStorage.setItem('sim-killswitch', String(!!enabled)); } catch { /* ignore */ }
      return Promise.resolve(true);
    },
    isKillSwitchEnabled: () => Promise.resolve(localStorage.getItem('sim-killswitch') === 'true'),
    changeDns: (dnsAddress: string) => {
      try { localStorage.setItem('sim-dns-address', String(dnsAddress ?? '')); } catch { /* ignore */ }
      return Promise.resolve(true);
    },
    setAutoConnect: (enabled: boolean) => {
      try { localStorage.setItem('sim-autoconnect', String(!!enabled)); } catch { /* ignore */ }
      return Promise.resolve(true);
    },
    // Split tunnel на iOS не поддерживается (PacketTunnel не умеет per-app):
    // молча принимаем и отдаём успех, чтобы UI не ломался.
    setSplitTunnelApp: () => Promise.resolve(true),

    // ── Правила маршрутизации (аналог RoutingRulesManager на localStorage) ──
    getRoutingRules: () => Promise.resolve({ rules: readRulesRaw() }),
    addRoutingRule: (ruleJson: string) => {
      try {
        const rule = JSON.parse(ruleJson);
        if (!rule || typeof rule !== 'object') return Promise.resolve(false);
        if (!rule.id) rule.id = `rule_${Date.now()}`;
        if (!rule.createdAt) rule.createdAt = Date.now();
        const rules = readRulesRaw();
        rules.push(rule);
        writeRulesRaw(rules);
        return Promise.resolve(true);
      } catch { return Promise.resolve(false); }
    },
    removeRoutingRule: (ruleId: string) => {
      writeRulesRaw(readRulesRaw().filter((r) => r.id !== ruleId));
      return Promise.resolve(true);
    },
    updateRoutingRule: (ruleJson: string) => {
      try {
        const rule = JSON.parse(ruleJson);
        if (!rule || !rule.id) return Promise.resolve(false);
        const rules = readRulesRaw().filter((r) => r.id !== rule.id);
        rules.push(rule);
        writeRulesRaw(rules);
        return Promise.resolve(true);
      } catch { return Promise.resolve(false); }
    },
    exportRoutingRules: () => Promise.resolve(JSON.stringify({ version: 1, exportedAt: Date.now(), rules: readRulesRaw() })),
    importRoutingRules: (jsonData: string) => {
      try {
        const data = JSON.parse(jsonData);
        const rules = Array.isArray(data?.rules) ? data.rules : null;
        if (!rules) return Promise.resolve(false);
        writeRulesRaw(rules);
        return Promise.resolve(true);
      } catch { return Promise.resolve(false); }
    },
    getXrayRoutingRules: () => Promise.resolve(toXrayRules()),

    // ── Batch-пинг (событиями ping-batch-item / ping-batch-done) ───────────
    nativePingBatch: (serversJson: string, taskId: string) => {
      callPlugin('pingBatch', { servers: String(serversJson ?? '[]'), taskId: String(taskId ?? '') }).catch((e: any) => {
        console.warn('[SIM-IOS] pingBatch failed:', e);
        w.dispatchEvent(new CustomEvent('ping-batch-done', { detail: { taskId } }));
      });
    },
    cancelPingBatch: () => { callPlugin('cancelPingBatch').catch(() => {}); },
  };

  w.SimNativeV2 = bridge;
  console.log('[SIM-IOS] SimNativeV2 bridge installed');
}

// Устанавливаем сразу при загрузке модуля (до первого вызова bridge.ts).
try { installIosShim(); } catch (e) { console.warn('[SIM-IOS] install failed:', e); }
