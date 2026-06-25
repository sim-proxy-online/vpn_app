import { useState, useCallback, useRef, useEffect } from 'react';
import Flag from './Flag';
import { withAlpha } from '../utils/color';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Globe, Trash2, RefreshCw,
  Settings, Database, Activity, Zap, Check,
  ArrowLeft, Link2, ClipboardPaste, QrCode,
  Calendar, Wifi, Route, ChevronRight, X, Download
} from 'lucide-react';
import {
  SubscriptionProfile,
  ServerNode,
  RoutingProfile,
} from '../types';
import {
  parseSubscription,
  detectPanelType,
  guessSubscriptionName,
  decodeProfileTitle,
  formatBytes,
  parseLink,
  generateId,
  parseSimUrl,
} from '../data';
import type { PanelType } from '../types';
import {
  nativeFetchUrl,
  nativeNotify,
  nativeReadClipboard,
  nativeScanQr,
  nativeOpenUrl,
  nativePingNode,
  nativeWarmupCore,
  type FetchResult,
} from '../native/bridge';

interface ProfilesScreenProps {
  onBack: () => void;
  onSelectNode: (node: ServerNode) => void;
  activeNodeId?: string;
  profiles: SubscriptionProfile[];
  onAddProfile: (profile: SubscriptionProfile) => void;
  onDeleteProfile: (id: string) => void;
  onUpdateProfile: (id: string) => Promise<void>;
  onSaveProfile: (profile: SubscriptionProfile) => void;
  onAddSingleNode: (node: ServerNode) => void;
  activeProfileId: string | null;
  onSetActive: (id: string) => void;
  onImportRouting: (routing: RoutingProfile, activate: boolean) => void;
}

// ── JSON-node display helpers ────────────────────────────────────────────────

function resolveNodeDisplay(node: ServerNode): { proto: string; addr: string; sec?: string; net?: string } {
  if (node.protocol !== 'json' || !node.rawLink) {
    return { proto: node.protocol, addr: node.address, sec: node.security, net: node.transport };
  }
  const raw = node.rawLink.trim();
  // rawLink — прокси-ссылка (vless://, vmess://…), а не JSON.
  // Старые бэкапы могут содержать такие ноды; берём схему как протокол.
  if (!raw.startsWith('{') && !raw.startsWith('[')) {
    const scheme = raw.split('://')[0]?.toLowerCase() || node.protocol;
    const proto = scheme === 'ss' ? 'shadowsocks' : scheme;
    return { proto, addr: node.address, sec: node.security, net: node.transport };
  }
  try {
    const cfg = JSON.parse(raw);
    const outbounds: any[] = Array.isArray(cfg?.outbounds) ? cfg.outbounds : [];
    const skip = new Set(['freedom','blackhole','direct','block','dns','selector','urltest']);
    const skipTags = new Set(['direct','block','dns-out','dns','bypass','reject']);
    for (const ob of outbounds) {
      const t = (ob.protocol || ob.type || '').toLowerCase();
      const tag = (ob.tag || ob.name || '').toLowerCase();
      if (!t || skip.has(t) || skipTags.has(tag)) continue;
      const s = ob.settings || {};
      const addr = ob.server || s.address || s.vnext?.[0]?.address || s.servers?.[0]?.address || '';
      if (addr && addr !== '0.0.0.0' && addr !== '127.0.0.1') {
        const stream = ob.streamSettings || {};
        const sec = stream.security && stream.security !== 'none' ? stream.security : undefined;
        const net = stream.network && stream.network !== 'tcp' ? stream.network : undefined;
        return { proto: t, addr, sec, net };
      }
    }
  } catch { /* ignore */ }
  return { proto: node.protocol, addr: node.address, sec: node.security, net: node.transport };
}

// ── Ping helpers ─────────────────────────────────────────────────────────────
function pingColor(ms: number | undefined): string {
  if (ms === undefined) return '#4b5563';
  if (ms < 0) return '#ef4444';
  if (ms < 100) return '#22c55e';
  if (ms < 200) return '#eab308';
  if (ms < 500) return '#f97316';
  return '#ef4444';
}
function pingLabel(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 0) return 'timeout';
  return `${ms}ms`;
}

export default function ProfilesScreen({
  onBack,
  onSelectNode,
  activeNodeId,
  profiles,
  onAddProfile,
  onDeleteProfile,
  onUpdateProfile,
  onSaveProfile,
  onAddSingleNode,
  onImportRouting,
}: ProfilesScreenProps) {
  const [screen, setScreen] = useState<'list' | 'add-menu' | 'url-input' | 'edit-profile' | 'routing-detail'>('list');
  const [editingProfile, setEditingProfile] = useState<SubscriptionProfile | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState('');
  const [routingTab, setRoutingTab] = useState<'direct' | 'proxy' | 'block'>('direct');
  const [routingNewEntry, setRoutingNewEntry] = useState('');

  // ── Ping state ───────────────────────────────────────────────────────────
  const [pingMap, setPingMap] = useState<Record<string, number>>({});
  const [pingingSet, setPingingSet] = useState<Set<string>>(new Set());
  const pingAbortRef = useRef<Record<string, boolean>>({});

  // Прогреваем ядро заранее, чтобы первый пинг не «думал» на инициализации libxray.
  useEffect(() => { nativeWarmupCore(); }, []);

  const show = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 3000);
  };

  // ── Ping logic ───────────────────────────────────────────────────────────
  const pingNode = useCallback(async (node: ServerNode) => {
    if (pingingSet.has(node.id)) return;
    setPingingSet(prev => new Set(prev).add(node.id));
    try {
      // Unified white-list-aware ping (Proxy GET like Happ by default, or TCP
      // per the Settings choice — see nativePingNode).
      const ms = await nativePingNode(node, 'proxy', false, true);
      setPingMap(prev => ({ ...prev, [node.id]: ms }));
    } catch {
      setPingMap(prev => ({ ...prev, [node.id]: -1 }));
    } finally {
      setPingingSet(prev => { const s = new Set(prev); s.delete(node.id); return s; });
    }
  }, [pingingSet]);

  const pingAll = useCallback(async (nodes: ServerNode[]) => {
    if (nodes.length === 0) return;
    const id = nodes[0].id + '_batch';
    pingAbortRef.current[id] = false;
    const batch = 1;
    for (let i = 0; i < nodes.length; i += batch) {
      if (pingAbortRef.current[id]) break;
      const chunk = nodes.slice(i, i + batch);
      await Promise.all(chunk.map(n => pingNode(n)));
    }
    delete pingAbortRef.current[id];
  }, [pingNode]);

  // ── Add subscription ─────────────────────────────────────────────────────
  const handleAddSubscription = async () => {
    let url = urlInput.trim();
    if (!url) return;
    if (url.endsWith('.onlin')) url += 'e';
    if (!url.startsWith('http')) url = 'https://' + url;

    setIsLoading(true);
    try {
      const result = await nativeFetchUrl(url);
      let content = '';
      let fetchResult: FetchResult | null = null;

      if (typeof result === 'object' && result !== null) {
        if ((result as FetchResult).ok === false)
          throw new Error((result as FetchResult).error || 'Ошибка загрузки');
        fetchResult = result as FetchResult;
        content = fetchResult.body || '';
      } else if (typeof result === 'string') {
        content = result;
      }

      if (!content?.trim()) {
        nativeNotify('Ошибка загрузки', (result as FetchResult)?.error || 'Пустой ответ от сервера');
        return;
      }

      const responseHeaders = fetchResult?.headers;
      const parsed = parseSubscription(content, fetchResult?.userInfo, responseHeaders);
      console.log('[SIM-ADD] nodes=' + parsed.nodes.length + ' protos=' + parsed.nodes.slice(0,5).map((n: any) => n.protocol + ':' + String(n.address).slice(0, 15)).join('|'));
      const badNodes = parsed.nodes.filter(n => n.protocol === 'json' && n.rawLink && !n.rawLink.trim().startsWith('{') && !n.rawLink.trim().startsWith('['));
      if (badNodes.length) console.warn('[SIM-ADD] json nodes with non-JSON rawLink:', badNodes.map(n => n.rawLink?.slice(0, 60)).join(' | '));

      if (parsed.nodes.length === 0) {
        const preview = content.substring(0, 60).replace(/[^\x20-\x7E]/g, '.');
        throw new Error(`Серверов не найдено. Ответ: ${preview}…`);
      }

      const panelType = detectPanelType(url, responseHeaders);

      // Name priority: header (decoded) > body title > URL path > hostname
      // fetchResult.name = raw profile-title HTTP header (may be base64 or "base64:..." prefixed)
      const rawTitle = fetchResult?.name;
      const name =
        parsed.name ||
        (rawTitle ? decodeProfileTitle(rawTitle) : undefined) ||
        guessSubscriptionName(url);

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
        panelType,
        status: 'healthy',
      };
      onAddProfile(newProfile);
      if (parsed.routing) onImportRouting(parsed.routing, true);
      setUrlInput('');
      setScreen('list');
      show(`Добавлено ${parsed.nodes.length} серверов`);
    } catch (e: any) {
      nativeNotify('Ошибка', e.message || 'Проверьте ссылку и интернет');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdate = async (id: string) => {
    setIsLoading(true);
    try {
      await onUpdateProfile(id);
      show('Обновлено');
    } catch (e: any) {
      nativeNotify('Ошибка', e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateAll = async () => {
    if (isLoading) return;
    setIsLoading(true);
    let count = 0;
    for (const p of profiles) {
      if (p.url) { try { await onUpdateProfile(p.id); count++; } catch { /* continue */ } }
    }
    show(`Обновлено ${count} профилей`);
    setIsLoading(false);
  };

  const handlePaste = async () => {
    const text = await nativeReadClipboard();
    if (!text) { nativeNotify('Инфо', 'Буфер обмена пуст'); return; }
    if (text.startsWith('http')) { setUrlInput(text); setScreen('url-input'); return; }
    const node = parseLink(text);
    if (node) {
      onAddSingleNode(node);
      show('Сервер добавлен');
      setScreen('list');
    } else {
      const parsed = parseSubscription(text);
      if (parsed.nodes.length > 0) {
        const newProfile: SubscriptionProfile = {
          id: generateId(),
          name: parsed.name || `Импорт (${parsed.nodes.length})`,
          url: '',
          nodes: parsed.nodes,
          autoUpdate: false,
          updatedAt: new Date().toLocaleString('ru-RU'),
          lastUpdateTimestamp: Date.now(),
          traffic: parsed.traffic,
          status: 'healthy',
        };
        onAddProfile(newProfile);
        show('Профиль импортирован');
        setScreen('list');
      } else {
        nativeNotify('Ошибка', 'Текст не распознан как ссылка или конфиг');
      }
    }
  };

  const handleQrScan = async () => {
    try {
      const result = await nativeScanQr();
      if (result) {
        if (result.startsWith('http')) { setUrlInput(result); setScreen('url-input'); return; }
        const node = parseLink(result);
        if (node) { onAddSingleNode(node); show('Добавлено через QR'); setScreen('list'); }
        else nativeNotify('Ошибка', 'QR-код не содержит валидный конфиг');
      }
    } catch { /* ignore */ }
  };


  // Import routing profile from clipboard or QR into editingProfile
  const handleImportRoutingToProfile = async (source: 'clipboard' | 'qr') => {
    let text = '';
    if (source === 'clipboard') {
      text = (await nativeReadClipboard()) || '';
    } else {
      try { text = (await nativeScanQr()) || ''; } catch { return; }
    }
    if (!text) { nativeNotify('Ошибка', 'Буфер обмена пуст'); return; }
    const parsed = parseSimUrl(text);
    if (parsed?.type === 'routing_add' && parsed.profile) {
      setEditingProfile(prev => prev ? { ...prev, routing: parsed.profile } : prev);
      show(`Маршрутизация импортирована: ${parsed.profile.Name}`);
    } else {
      nativeNotify('Ошибка', 'Ссылка не является профилем маршрутизации sim:// или happ://');
    }
  };

  // Add/remove routing entry for current tab
  const isIpEntry = (v: string) => /^[\d:][.\d:/]+$/.test(v.trim()) || v.startsWith('geoip:');
  const handleAddRoutingEntry = () => {
    const val = routingNewEntry.trim();
    if (!val || !editingProfile?.routing) return;
    const r = editingProfile.routing;
    const isIp = isIpEntry(val);
    let updated = { ...r };
    if (routingTab === 'direct') {
      if (isIp) updated = { ...updated, DirectIp: [...(r.DirectIp || []), val] };
      else updated = { ...updated, DirectSites: [...(r.DirectSites || []), val] };
    } else if (routingTab === 'proxy') {
      if (isIp) updated = { ...updated, ProxyIp: [...(r.ProxyIp || []), val] };
      else updated = { ...updated, ProxySites: [...(r.ProxySites || []), val] };
    } else {
      if (isIp) updated = { ...updated, BlockIp: [...(r.BlockIp || []), val] };
      else updated = { ...updated, BlockSites: [...(r.BlockSites || []), val] };
    }
    setEditingProfile(prev => prev ? { ...prev, routing: updated } : prev);
    setRoutingNewEntry('');
  };
  const handleRemoveRoutingEntry = (list: keyof RoutingProfile, idx: number) => {
    if (!editingProfile?.routing) return;
    const arr = (editingProfile.routing[list] as string[] | undefined) || [];
    const updated = { ...editingProfile.routing, [list]: arr.filter((_: string, i: number) => i !== idx) };
    setEditingProfile(prev => prev ? { ...prev, routing: updated } : prev);
  };

  const formatDate = (ts?: number) => {
    if (!ts) return 'Бессрочно';
    return new Date(ts * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  const PANEL_META: Record<PanelType, { label: string; color: string }> = {
    remnawave: { label: 'Remnawave', color: '#a78bfa' },
    '3x-ui':   { label: '3X-UI',    color: '#f97316' },
    marzban:   { label: 'Marzban',  color: '#22d3ee' },
    hiddify:   { label: 'Hiddify',  color: '#4ade80' },
    xui:       { label: 'X-UI',     color: '#fb923c' },
    unknown:   { label: 'Sub',      color: '#6b7280' },
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0a1a] text-[#e0e0e0] font-sans overflow-hidden">

      {/* Toast */}
      <AnimatePresence>
        {successMsg && (
          <motion.div
            initial={{ opacity: 0, y: -20, x: '-50%' }} animate={{ opacity: 1, y: 0, x: '-50%' }} exit={{ opacity: 0, y: -20, x: '-50%' }}
            className="fixed top-6 left-1/2 z-[200] px-5 py-2.5 rounded-full bg-[var(--accent)]/20 border border-[var(--accent)]/40 text-[var(--accent)] text-[10px] font-black uppercase tracking-widest backdrop-blur-xl flex items-center gap-3 shadow-[0_0_30px_rgba(var(--accent-rgb),0.2)]"
          >
            <Zap size={14} className="animate-pulse" /> {successMsg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="px-4 pt-12 pb-4 shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center border border-white/10 active:scale-90 transition-all">
            <ArrowLeft size={20} className="text-[var(--accent)]" />
          </button>
          <div>
            <h1 className="font-orbitron text-[18px] font-bold tracking-wide text-white">Профили</h1>
            <p className="text-[11px] text-[var(--accent)] font-semibold mt-0.5 opacity-75">{profiles.length} подписок</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={handleUpdateAll} className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center border border-white/10 text-gray-400 active:scale-90 transition-all">
            <RefreshCw size={18} className={isLoading ? 'animate-spin' : ''} />
          </button>
          <button onClick={() => setScreen('add-menu')} className="w-10 h-10 rounded-xl bg-[var(--accent)] flex items-center justify-center text-black shadow-[0_0_20px_rgba(var(--accent-rgb),0.3)] active:scale-95 transition-all">
            <Plus size={22} strokeWidth={3} />
          </button>
        </div>
      </header>

      {/* Get Subscription Button — скрываем, как только добавлена хотя бы одна подписка */}
      {profiles.length === 0 && (
        <div className="px-6 mb-4">
          <button
            onClick={() => nativeOpenUrl('https://sim-proxy.online')}
            className="w-full h-12 rounded-xl bg-gradient-to-r from-[var(--accent)]/10 to-[#0070ff]/10 border border-[var(--accent)]/30 flex items-center justify-center gap-3 active:scale-[0.98] transition-all group overflow-hidden relative"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-[var(--accent)]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <Zap size={16} className="text-[var(--accent)]" />
            <span className="text-[11px] font-black uppercase tracking-[0.1em] text-white">Получить подписку</span>
            <div className="px-2 py-0.5 rounded-md bg-[var(--accent)]/10 text-[var(--accent)] text-[7px] font-black uppercase tracking-widest border border-[var(--accent)]/20 ml-auto mr-1">
              Перейти
            </div>
          </button>
        </div>
      )}


      <div className="flex-1 overflow-y-auto px-6 space-y-3 pb-24 scrollbar-none">
        <AnimatePresence>
          {profiles.length === 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="flex flex-col items-center justify-center py-20 text-center"
            >
              <div className="w-20 h-20 rounded-[32px] bg-white/[0.02] border border-white/5 flex items-center justify-center mb-6">
                <Link2 size={32} className="text-gray-700" />
              </div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-600">Нет активных профилей</p>
              <button onClick={() => setScreen('add-menu')} className="mt-8 px-8 py-3 rounded-xl bg-[var(--accent)]/5 border border-[var(--accent)]/10 text-[var(--accent)] text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all">
                Добавить подписку
              </button>
            </motion.div>
          )}

          {profiles.flatMap((profile, index) => {
            const card = (
            <motion.div key={profile.id}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            >
              {/* Gradient border wrapper */}
              <div className="p-[1px] rounded-[20px] bg-[var(--accent)]/15 shadow-[0_0_14px_rgba(var(--accent-rgb),0.05)]">
              <div className="rounded-[19px] overflow-hidden" style={{ background: 'linear-gradient(135deg, #0e1e30 0%, #080d18 60%)' }}>
              {/* Card Main */}
              <div className="p-5">
                {/* Header */}
                <div
                  className="flex items-center gap-4 mb-5 cursor-pointer"
                  onClick={() => setExpandedProfileId(expandedProfileId === profile.id ? null : profile.id)}
                >
                  <div className="w-[62px] h-[62px] rounded-2xl flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(145deg, #152035, #0c1525)', border: '1px solid rgba(255,255,255,0.07)' }}>
                    {profile.url
                      ? <Globe size={30} strokeWidth={1.4} className="text-[var(--accent)]" style={{ filter: 'drop-shadow(0 0 4px var(--accent-a44))', opacity: 0.85 }} />
                      : <Database size={28} className="text-[var(--accent)]" strokeWidth={1.8} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-[15px] font-bold text-white leading-tight">{profile.name}</h3>
                    <p className="text-[11px] text-gray-500 font-medium mt-0.5 truncate uppercase tracking-wide">
                      {profile.url
                        ? (() => { try { return new URL(profile.url).hostname; } catch { return profile.url; } })()
                        : 'Локальный импорт'}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border" style={{ background: 'rgba(0,0,0,0.4)', borderColor: 'rgba(255,255,255,0.08)' }}>
                      <div className={`w-2 h-2 rounded-full ${
                        profile.status === 'healthy' ? 'bg-[#00e676]' :
                        profile.status === 'expired' ? 'bg-[#ff4444]' : 'bg-[#ffcc00]'
                      }`} />
                      <span className="text-[8px] font-bold uppercase tracking-widest text-gray-300">
                        {profile.status === 'healthy' ? 'Активен' : profile.status === 'expired' ? 'Истек' : 'Внимание'}
                      </span>
                    </div>
                    {profile.routing && (
                      <div className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-[var(--accent)]/30 bg-[var(--accent)]/10">
                        <Route size={8} className="text-[var(--accent)]" />
                        <span className="text-[7px] font-black uppercase tracking-widest text-[var(--accent)]">Routing</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Traffic */}
                {profile.traffic && (() => {
                  const usage = Math.round(profile.traffic.usagePercentage || 0);
                  const isUnlimited = profile.traffic.total === 0;
                  const barPct = isUnlimited && usage === 0 ? 100 : Math.min(100, usage);
                  const barColor = usage > 90 ? 'linear-gradient(to right,#ff4444,#ff2222)' : usage > 70 ? 'linear-gradient(to right,#ffcc00,#ff8800)' : 'linear-gradient(to right,#00c875,#00e676)';
                  return (
                  <div className="mb-5 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-3.5 rounded-2xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <div className="flex items-center gap-1.5 mb-2">
                          <Activity size={11} className="text-gray-500" />
                          <span className="text-[8px] font-bold uppercase tracking-widest text-gray-500">Трафик</span>
                        </div>
                        <p className="text-[14px] font-bold text-white leading-none">
                          {formatBytes(profile.traffic.download + profile.traffic.upload)} / {profile.traffic.total > 0 ? formatBytes(profile.traffic.total) : '∞'}
                        </p>
                      </div>
                      <div className="p-3.5 rounded-2xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <div className="flex items-center gap-1.5 mb-2">
                          <Calendar size={11} className="text-gray-500" />
                          <span className="text-[8px] font-bold uppercase tracking-widest text-gray-500">Истекает</span>
                        </div>
                        <p className="text-[14px] font-bold text-white leading-none">
                          {profile.traffic.expire ? formatDate(profile.traffic.expire) : 'Бессрочно'}
                        </p>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="h-[6px] w-full rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${barPct}%` }}
                          style={{ height: '100%', borderRadius: '9999px', background: barColor }}
                        />
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-[9px] font-bold uppercase tracking-widest text-gray-600">
                          Использовано {usage}%
                        </span>
                        {profile.traffic.remainingDays !== undefined && (
                          <span className={`text-[9px] font-bold uppercase tracking-widest ${profile.traffic.remainingDays <= 3 ? 'text-[#ff4444]' : 'text-gray-500'}`}>
                            Осталось {profile.traffic.remainingDays} дн.
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  );
                })()}

                {/* Footer Actions */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleUpdate(profile.id)}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-2xl text-[var(--accent)] text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all"
                    style={{ background: 'rgba(var(--accent-rgb),0.07)', border: '1px solid rgba(var(--accent-rgb),0.35)' }}
                  >
                    <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} strokeWidth={2.5} /> Обновить
                  </button>
                  <button
                    onClick={() => { setEditingProfile(profile); setScreen('edit-profile'); }}
                    className="p-2.5 rounded-2xl text-gray-400 active:scale-95 transition-all"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
                  >
                    <Settings size={15} />
                  </button>
                  {profile.supportUrl && (
                    <button
                      onClick={() => nativeOpenUrl(profile.supportUrl!)}
                      className="p-2.5 rounded-2xl text-gray-400 active:scale-95 transition-all"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
                    >
                      <Globe size={15} />
                    </button>
                  )}
                  <div className="ml-auto text-right">
                    <p className="text-[8px] font-bold text-gray-600 uppercase tracking-widest mb-0.5">Обновлено</p>
                    <p className="text-[10px] font-mono text-gray-400">{profile.updatedAt.split(',')[0]}</p>
                  </div>
                </div>
              </div>

              {/* Expanded server list with PING */}
              <AnimatePresence>
                {expandedProfileId === profile.id && (
                  <motion.div
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="bg-black/30 border-t border-white/10"
                  >
                    <div className="p-3 space-y-1">
                      {/* List header with Ping All button */}
                      <div className="px-3 py-2 flex items-center justify-between mb-1">
                        <span className="text-[9px] font-black uppercase tracking-widest text-gray-600">
                          Серверов: {profile.nodes.length}
                        </span>
                        <button
                          onClick={e => { e.stopPropagation(); pingAll(profile.nodes); }}
                          disabled={pingingSet.size > 0}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-[var(--accent)] text-[8px] font-black uppercase tracking-widest active:scale-95 transition-all disabled:opacity-40"
                        >
                          <Wifi size={10} className={pingingSet.size > 0 ? 'animate-pulse' : ''} />
                          {pingingSet.size > 0 ? 'Пингую...' : 'Пинг всех'}
                        </button>
                      </div>

                      {profile.nodes.map(node => {
                        const ping = pingMap[node.id];
                        const isPinging = pingingSet.has(node.id);
                        const pColor = pingColor(ping);

                        return (
                          <button
                            key={node.id}
                            onClick={() => onSelectNode(node)}
                            className={`w-full flex items-center justify-between p-3.5 rounded-2xl transition-all duration-200 ${activeNodeId === node.id ? 'bg-[var(--accent)]/10 border border-[var(--accent)]/20' : 'hover:bg-white/[0.04] border border-transparent'}`}
                          >
                            {/* Left: flag + info */}
                            <div className="flex items-center gap-3 overflow-hidden flex-1 min-w-0">
                              <Flag flag={node.protocol === 'json' ? node.name : node.flag} name={node.name} size={20} className="shrink-0 drop-shadow-sm" />
                              <div className="text-left overflow-hidden min-w-0">
                                <p className={`text-xs font-black truncate uppercase tracking-tighter ${activeNodeId === node.id ? 'text-[var(--accent)]' : 'text-gray-200'}`}>
                                  {node.name}
                                </p>
                                <div className="flex items-center gap-2 mt-0.5 opacity-50">
                                  {(() => {
                                    const d = resolveNodeDisplay(node);
                                    const proto = d.proto !== 'json' ? d.proto : (node.serverDescription || 'json');
                                    const addr = d.addr !== node.name ? d.addr : node.address;
                                    return (<>
                                      <span className="text-[8px] uppercase font-black px-1.5 py-0.5 bg-black/40 rounded border border-white/5 text-[var(--accent)] shrink-0">
                                        {proto}
                                        {d.sec && d.sec !== 'none' && ` · ${d.sec}`}
                                        {d.net && d.net !== 'tcp' && d.net !== d.proto && ` · ${d.net}`}
                                      </span>
                                      <span className="text-[8px] font-mono truncate text-gray-500">{addr}</span>
                                    </>);
                                  })()}
                                </div>
                              </div>
                            </div>

                            {/* Right: ping + active indicator */}
                            <div className="flex items-center gap-2 ml-2 shrink-0">
                              {/* Ping badge */}
                              <button
                                onClick={e => { e.stopPropagation(); pingNode(node); }}
                                className="flex items-center gap-1 px-2 py-1 rounded-lg border transition-all active:scale-90"
                                style={{
                                  borderColor: `${withAlpha(pColor, '40')}`,
                                  background: `${withAlpha(pColor, '12')}`,
                                }}
                              >
                                {isPinging ? (
                                  <div className="animate-spin">
                                    <Wifi size={9} style={{ color: 'var(--accent)' }} />
                                  </div>
                                ) : (
                                  <Wifi size={9} style={{ color: pColor }} />
                                )}
                                <span className="text-[8px] font-black font-mono" style={{ color: pColor }}>
                                  {isPinging ? '…' : pingLabel(ping)}
                                </span>
                              </button>

                              {activeNodeId === node.id && (
                                <div className="w-6 h-6 rounded-full bg-[var(--accent)] flex items-center justify-center shadow-[0_0_15px_rgba(var(--accent-rgb),0.5)]">
                                  <Check size={14} className="text-black" strokeWidth={4} />
                                </div>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              </div>{/* rounded inner */}
              </div>{/* gradient border */}
            </motion.div>
            );
            const sep = index > 0 ? (
              <motion.div key={`sep-${profile.id}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="h-px bg-gradient-to-r from-transparent via-white/[0.07] to-transparent mx-2"
              />
            ) : null;
            return sep ? [sep, card] : [card];
          })}
        </AnimatePresence>
      </div>

      {/* Add Menu */}
      <AnimatePresence>
        {screen === 'add-menu' && (
          <div className="fixed inset-0 z-[100] flex items-end justify-center">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setScreen('list')} className="absolute inset-0 bg-black/70 backdrop-blur-md" />
            <motion.div
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="w-full max-w-lg bg-[#0d0d1f] border-t border-white/10 rounded-t-[40px] p-8 pb-12 z-[101] shadow-2xl"
            >
              <div className="w-12 h-1.5 bg-white/10 rounded-full mx-auto mb-10" />
              <h2 className="text-xl font-black text-white mb-8 uppercase italic tracking-tight">Добавить серверы</h2>
              <div className="grid grid-cols-1 gap-4">
                <button onClick={() => setScreen('url-input')} className="w-full flex items-center gap-5 p-6 rounded-[28px] bg-white/[0.03] border border-white/10 active:scale-95 transition-all group">
                  <div className="w-14 h-14 rounded-2xl bg-[var(--accent)]/10 flex items-center justify-center text-[var(--accent)] group-hover:bg-[var(--accent)] group-hover:text-black transition-all">
                    <Link2 size={24} />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-black uppercase tracking-widest text-white">Добавить по ссылке</p>
                    <p className="text-[10px] text-gray-500 font-bold uppercase mt-1">Remnawave · 3X-UI · Marzban · Hiddify</p>
                  </div>
                </button>
                <button onClick={handlePaste} className="w-full flex items-center gap-5 p-6 rounded-[28px] bg-white/[0.03] border border-white/10 active:scale-95 transition-all group">
                  <div className="w-14 h-14 rounded-2xl bg-[var(--accent)]/10 flex items-center justify-center text-[var(--accent)] group-hover:bg-[var(--accent)] group-hover:text-black transition-all">
                    <ClipboardPaste size={24} />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-black uppercase tracking-widest text-white">Импорт из буфера</p>
                    <p className="text-[10px] text-gray-500 font-bold uppercase mt-1">VLESS · VMess · Trojan · Clash YAML</p>
                  </div>
                </button>
                <button onClick={handleQrScan} className="w-full flex items-center gap-5 p-6 rounded-[28px] bg-white/[0.03] border border-white/10 active:scale-95 transition-all group">
                  <div className="w-14 h-14 rounded-2xl bg-[var(--accent)]/10 flex items-center justify-center text-[var(--accent)] group-hover:bg-[var(--accent)] group-hover:text-black transition-all">
                    <QrCode size={24} />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-black uppercase tracking-widest text-white">Сканировать QR</p>
                    <p className="text-[10px] text-gray-500 font-bold uppercase mt-1">Камера телефона</p>
                  </div>
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* URL Input Modal */}
      <AnimatePresence>
        {screen === 'url-input' && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-8">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setScreen('list')} className="absolute inset-0 bg-black/90 backdrop-blur-2xl" />
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              className="w-full max-w-sm bg-[#0d0d1f] border border-white/10 rounded-[36px] p-8 z-[111] shadow-2xl relative"
            >
              <div className="flex items-center gap-4 mb-8">
                <div className="w-12 h-12 rounded-2xl bg-[var(--accent)]/20 flex items-center justify-center text-[var(--accent)]">
                  <Globe size={24} />
                </div>
                <div>
                  <h3 className="text-lg font-black text-white uppercase italic">Новая подписка</h3>
                  <p className="text-[9px] text-gray-500 font-black uppercase tracking-widest">Remnawave · 3X-UI · Marzban · Hiddify</p>
                </div>
              </div>
              <div className="space-y-6">
                <input
                  type="text" autoFocus placeholder="https://panel.example.com/sub/..."
                  className="w-full h-14 bg-white/[0.03] border border-white/10 rounded-2xl px-6 text-xs text-white font-mono outline-none focus:border-[var(--accent)]/40 transition-colors"
                  value={urlInput} onChange={e => setUrlInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddSubscription()}
                />
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={() => setScreen('list')} className="h-14 rounded-2xl bg-white/5 border border-white/10 text-gray-400 font-black uppercase text-[10px] tracking-widest active:scale-95">Отмена</button>
                  <button
                    onClick={handleAddSubscription} disabled={isLoading || !urlInput.trim()}
                    className="h-14 rounded-2xl bg-[var(--accent)] text-black font-black uppercase text-[10px] tracking-widest active:scale-95 transition-all disabled:opacity-30"
                  >
                    {isLoading ? 'Загрузка...' : 'Добавить'}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Routing Detail */}
      <AnimatePresence>
        {screen === 'routing-detail' && editingProfile?.routing && (() => {
          const r = editingProfile.routing!;
          const tabs = [
            { id: 'direct' as const, label: 'Прямой', domains: r.DirectSites || [], ips: r.DirectIp || [], color: '#22c55e', domainKey: 'DirectSites' as keyof RoutingProfile, ipKey: 'DirectIp' as keyof RoutingProfile },
            { id: 'proxy' as const, label: 'Прокси', domains: r.ProxySites || [], ips: r.ProxyIp || [], color: 'var(--accent)', domainKey: 'ProxySites' as keyof RoutingProfile, ipKey: 'ProxyIp' as keyof RoutingProfile },
            { id: 'block' as const, label: 'Блок', domains: r.BlockSites || [], ips: r.BlockIp || [], color: '#ef4444', domainKey: 'BlockSites' as keyof RoutingProfile, ipKey: 'BlockIp' as keyof RoutingProfile },
          ];
          const tab = tabs.find(t => t.id === routingTab)!;
          const allEntries = [...tab.domains.map((v: string) => ({ v, key: tab.domainKey })), ...tab.ips.map((v: string) => ({ v, key: tab.ipKey }))];
          return (
            <motion.div
              initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 30, stiffness: 200 }}
              className="fixed inset-0 z-[160] bg-[#0a0a1a] flex flex-col"
            >
              <header className="px-4 pt-12 pb-4 flex items-center gap-3 border-b border-white/5 shrink-0">
                <button onClick={() => setScreen('edit-profile')} className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center border border-white/10 active:scale-90">
                  <ArrowLeft size={20} className="text-[var(--accent)]" />
                </button>
                <div>
                  <h2 className="font-orbitron text-[16px] font-bold text-white">Правила маршрутизации</h2>
                  <p className="text-[9px] text-[var(--accent)] font-semibold opacity-75">{r.Name}</p>
                </div>
              </header>
              {/* Tabs */}
              <div className="flex gap-2 px-4 py-3 border-b border-white/5 shrink-0">
                {tabs.map(t => (
                  <button key={t.id} onClick={() => setRoutingTab(t.id)}
                    className="flex-1 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all"
                    style={routingTab === t.id
                      ? { background: `${t.color}20`, border: `1px solid ${t.color}40`, color: t.color }
                      : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#6b7280' }}>
                    {t.label} <span className="opacity-60">({t.domains.length + t.ips.length})</span>
                  </button>
                ))}
              </div>
              {/* Add entry */}
              <div className="px-4 py-3 flex gap-2 border-b border-white/5 shrink-0">
                <input
                  value={routingNewEntry} onChange={e => setRoutingNewEntry(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddRoutingEntry()}
                  placeholder="domain.com, 10.0.0.0/8, geosite:ru..."
                  className="flex-1 h-10 bg-white/[0.03] border border-white/10 rounded-xl px-4 text-[11px] text-white font-mono outline-none focus:border-[var(--accent)]/30"
                />
                <button onClick={handleAddRoutingEntry}
                  className="w-10 h-10 rounded-xl bg-[var(--accent)]/15 border border-[var(--accent)]/30 flex items-center justify-center text-[var(--accent)] active:scale-90">
                  <Plus size={16} strokeWidth={3} />
                </button>
              </div>
              {/* Entry list */}
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1 scrollbar-none">
                {allEntries.length === 0 && (
                  <div className="text-center py-12">
                    <p className="text-[9px] font-black uppercase tracking-widest text-gray-700">Нет правил</p>
                  </div>
                )}
                {allEntries.map(({ v, key }, idx) => (
                  <div key={`${key}-${idx}`} className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-white/[0.02] border border-white/5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[7px] font-black uppercase px-1.5 py-0.5 rounded border"
                        style={isIpEntry(v) ? { color: '#f59e0b', borderColor: '#f59e0b40', background: '#f59e0b10' } : { color: '#60a5fa', borderColor: '#60a5fa40', background: '#60a5fa10' }}>
                        {isIpEntry(v) ? 'IP' : 'DOM'}
                      </span>
                      <span className="text-[11px] font-mono text-gray-300 truncate">{v}</span>
                    </div>
                    <button onClick={() => {
                      const list = (r[key] as string[] | undefined) || [];
                      const realIdx = list.indexOf(v);
                      if (realIdx >= 0) handleRemoveRoutingEntry(key, realIdx);
                    }} className="w-7 h-7 rounded-lg bg-red-500/10 flex items-center justify-center text-red-500 border border-red-500/20 shrink-0 active:scale-90 ml-2">
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
              {/* DNS info footer */}
              {(r.RemoteDNSIP || r.DomesticDNSIP) && (
                <div className="px-4 py-3 border-t border-white/5 flex gap-4 shrink-0">
                  {r.RemoteDNSIP && <div><p className="text-[7px] text-gray-600 uppercase font-black">Remote DNS</p><p className="text-[9px] font-mono text-gray-400">{r.RemoteDNSIP}</p></div>}
                  {r.DomesticDNSIP && <div><p className="text-[7px] text-gray-600 uppercase font-black">Domestic DNS</p><p className="text-[9px] font-mono text-gray-400">{r.DomesticDNSIP}</p></div>}
                  {r.DomainStrategy && <div><p className="text-[7px] text-gray-600 uppercase font-black">Strategy</p><p className="text-[9px] font-mono text-gray-400">{r.DomainStrategy}</p></div>}
                </div>
              )}
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* Edit Profile */}
      <AnimatePresence>
        {screen === 'edit-profile' && editingProfile && (
          <motion.div
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 30, stiffness: 200 }}
            className="fixed inset-0 z-[150] bg-[#0a0a1a] flex flex-col"
          >
            <header className="px-4 pt-12 pb-4 flex items-center justify-between border-b border-white/5">
              <div className="flex items-center gap-3">
                <button onClick={() => setScreen('list')} className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center border border-white/10 active:scale-90 transition-all">
                  <ArrowLeft size={20} className="text-[var(--accent)]" />
                </button>
                <div>
                  <h2 className="font-orbitron text-[18px] font-bold text-white tracking-wide leading-none">{editingProfile.name}</h2>
                  <p className="text-[11px] text-[var(--accent)] font-semibold mt-0.5 opacity-75">Настройки профиля</p>
                </div>
              </div>
              <button
                onClick={() => { if (confirm('Удалить этот профиль?')) { onDeleteProfile(editingProfile.id); setScreen('list'); } }}
                className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center text-red-500 border border-red-500/20 active:scale-90 transition-all"
              >
                <Trash2 size={18} />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto p-6 space-y-8">
              <section className="space-y-3">
                <div className="flex items-center gap-3 px-1">
                  <div className="w-1.5 h-4 bg-[var(--accent)] rounded-full shadow-[0_0_5px_var(--accent)]" />
                  <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">Название профиля</h4>
                </div>
                <input
                  type="text" defaultValue={editingProfile.name}
                  className="w-full h-14 bg-white/[0.03] border border-white/10 rounded-2xl px-6 text-sm text-white font-bold outline-none focus:border-[var(--accent)]/30"
                  onBlur={e => { if (e.target.value) setEditingProfile({ ...editingProfile, name: e.target.value }); }}
                />
              </section>

              {editingProfile.panelType && editingProfile.panelType !== 'unknown' && (
                <section className="space-y-3">
                  <div className="flex items-center gap-3 px-1">
                    <div className="w-1.5 h-4 bg-[var(--accent)] rounded-full shadow-[0_0_5px_var(--accent)]" />
                    <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">Тип панели</h4>
                  </div>
                  <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 flex items-center gap-3">
                    <span
                      className="px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border"
                      style={{
                        color: PANEL_META[editingProfile.panelType as PanelType].color,
                        borderColor: `${withAlpha(PANEL_META[editingProfile.panelType as PanelType].color, '40')}`,
                        background: `${withAlpha(PANEL_META[editingProfile.panelType as PanelType].color, '15')}`,
                      }}
                    >{PANEL_META[editingProfile.panelType as PanelType].label}</span>
                    <span className="text-[10px] text-gray-500">{editingProfile.nodes.length} серверов</span>
                  </div>
                </section>
              )}

              <section className="space-y-3">
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-3">
                    <div className="w-1.5 h-4 bg-[var(--accent)] rounded-full shadow-[0_0_5px_var(--accent)]" />
                    <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">Маршрутизация</h4>
                  </div>
                  {!editingProfile.routing && (
                    <div className="flex gap-2">
                      <button onClick={() => handleImportRoutingToProfile('clipboard')}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-[var(--accent)] text-[8px] font-black uppercase tracking-widest active:scale-95 transition-all">
                        <ClipboardPaste size={10} /> Буфер
                      </button>
                      <button onClick={() => handleImportRoutingToProfile('qr')}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-gray-400 text-[8px] font-black uppercase tracking-widest active:scale-95 transition-all">
                        <QrCode size={10} /> QR
                      </button>
                    </div>
                  )}
                </div>
                {editingProfile.routing ? (
                  <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 space-y-4">
                    {/* Name + DNS */}
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-[10px] text-gray-500 uppercase font-black mb-0.5">Профиль</p>
                        <p className="text-sm font-black text-white">{editingProfile.routing.Name}</p>
                      </div>
                      <button onClick={() => setEditingProfile(prev => prev ? { ...prev, routing: undefined } : prev)}
                        className="w-8 h-8 rounded-xl bg-red-500/10 flex items-center justify-center text-red-500 border border-red-500/20 active:scale-90 transition-all">
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {editingProfile.routing.RemoteDNSIP && (
                      <div className="flex justify-between items-center py-2 border-t border-white/5">
                        <span className="text-[9px] text-gray-500 uppercase font-black">Remote DNS</span>
                        <span className="text-[10px] font-mono text-[var(--accent)]">{editingProfile.routing.RemoteDNSIP}</span>
                      </div>
                    )}
                    {/* Rule counts */}
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { label: 'Direct', count: (editingProfile.routing.DirectSites?.length || 0) + (editingProfile.routing.DirectIp?.length || 0), color: '#22c55e' },
                        { label: 'Proxy', count: (editingProfile.routing.ProxySites?.length || 0) + (editingProfile.routing.ProxyIp?.length || 0), color: 'var(--accent)' },
                        { label: 'Block', count: (editingProfile.routing.BlockSites?.length || 0) + (editingProfile.routing.BlockIp?.length || 0), color: '#ef4444' },
                      ].map(({ label, count, color }) => (
                        <div key={label} className="p-2 rounded-xl text-center" style={{ background: `${color}10`, border: `1px solid ${color}25` }}>
                          <p className="text-[16px] font-black" style={{ color }}>{count}</p>
                          <p className="text-[7px] font-black uppercase tracking-widest text-gray-500 mt-0.5">{label}</p>
                        </div>
                      ))}
                    </div>
                    {/* Edit rules button */}
                    <button onClick={() => setScreen('routing-detail')}
                      className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-white/[0.03] border border-white/10 active:scale-[0.98] transition-all">
                      <div className="flex items-center gap-2">
                        <Route size={14} className="text-[var(--accent)]" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-white">Редактировать правила</span>
                      </div>
                      <ChevronRight size={14} className="text-gray-500" />
                    </button>
                    {/* Import another */}
                    <button onClick={() => handleImportRoutingToProfile('clipboard')}
                      className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-white/[0.02] border border-white/5 text-gray-500 text-[8px] font-black uppercase tracking-widest active:scale-95 transition-all">
                      <Download size={10} /> Обновить из буфера
                    </button>
                  </div>
                ) : (
                  <div className="p-6 rounded-2xl bg-white/[0.02] border border-dashed border-white/10 flex flex-col items-center justify-center gap-3 text-center">
                    <Route size={24} className="text-gray-700" />
                    <p className="text-[9px] font-black uppercase tracking-widest text-gray-600">Нет профиля маршрутизации</p>
                    <p className="text-[8px] text-gray-700">Импортируй через sim://routing/add/... или happ://routing/add/...</p>
                  </div>
                )}
              </section>
            </div>
            <footer className="p-6 pb-12">
              <button onClick={() => { if (editingProfile) onSaveProfile(editingProfile); setScreen('list'); }} className="w-full h-16 rounded-2xl bg-[var(--accent)] text-black font-black uppercase text-xs tracking-[0.2em] active:scale-95 transition-all shadow-[0_0_40px_rgba(var(--accent-rgb),0.3)] flex items-center justify-center gap-3">
                <Check size={18} strokeWidth={4} /> Готово
              </button>
            </footer>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}