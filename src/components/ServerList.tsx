import { motion, AnimatePresence } from 'framer-motion';
import { ServerNode, SubscriptionProfile } from '../types';
import {
  ArrowLeft, RefreshCw, MoreVertical, Trash2,
  XCircle, Zap, Eye, EyeOff, ArrowLeftRight,
} from 'lucide-react';
import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { nativeWarmupCore, startPingBatch } from '../native/bridge';
import { settingsHidden } from '../utils/profileView';
import { stripLeadingEmoji } from '../utils/nodeName';
import { accentVars, onTheme } from '../utils/color';
import Flag from './Flag';
import PingPill from './PingPill';
import { MascotScene } from './MascotScene';

interface ServerListProps {
  nodes: ServerNode[];
  profiles?: SubscriptionProfile[];
  activeProfileId?: string | null;
  selectedNode: ServerNode | null;
  onSelect: (node: ServerNode) => void;
  onBack: () => void;
  isConnected: boolean;
  onDeleteNodes?: (ids: string[]) => void;
  connectedTime?: number;
  autoSwitch?: boolean;
  onAutoSwitchChange?: (v: boolean) => void;
}

type PingState = { status: 'idle' | 'ok' | 'fail'; ms: number };

// Полоса строится только по измеренному пингу. Раньше без измерения она рисовалась псевдослучайным
// значением из хеша id сервера и выглядела как настоящая нагрузка; теперь остаётся пустой.
function getLoadPercent(ping: number): number {
  if (ping > 0) return Math.min(88, Math.max(5, Math.round(ping * 0.65 + 8)));
  return 0;
}

function loadBarColor(pct: number): string {
  if (pct < 35) return '#00e87a';
  if (pct < 60) return '#ffe600';
  return '#ff8c00';
}

function securityBadgeStyle(sec: string): { bg: string; color: string; border: string } {
  switch (sec.toLowerCase()) {
    case 'reality': return { bg: '#00ff8818', color: onTheme('#00d974'), border: '#00ff8840' };
    case 'tls':     return { bg: '#2d7dff18', color: onTheme('#5599ff'), border: '#2d7dff40' };
    case 'xtls':    return { bg: '#b000ff18', color: onTheme('#c84fff'), border: '#b000ff40' };
    default:        return { bg: 'rgba(var(--ink-rgb),0.063)', color: onTheme('#888888'), border: 'rgba(var(--ink-rgb),0.125)' };
  }
}

type SortMode = 'latency' | 'name' | 'protocol';

export default function ServerList({
  nodes, profiles, activeProfileId, selectedNode, onSelect, onBack, isConnected, onDeleteNodes,
  autoSwitch = false, onAutoSwitchChange,
}: ServerListProps) {
  const [search] = useState('');
  const [showBatchMenu, setShowBatchMenu] = useState(false);
  const [localProfileId, setLocalProfileId] = useState<string | null>(
    () => activeProfileId ?? profiles?.[0]?.id ?? null
  );

  useEffect(() => {
    if (activeProfileId != null) setLocalProfileId(activeProfileId);
  }, [activeProfileId]);

  const displayNodes = useMemo(() => {
    if (profiles && profiles.length > 0 && localProfileId) {
      return profiles.find(p => p.id === localProfileId)?.nodes ?? nodes;
    }
    return nodes;
  }, [profiles, localProfileId, nodes]);

  const showProfileTabs = profiles && profiles.length > 1;
  // Параметры провайдера для показываемой подписки: порядок серверов (subscriptions-sort-type) и hide-settings.
  const listProfile = profiles?.find(p => p.id === localProfileId);
  const providerSort = listProfile?.managed?.sortType;
  const hideDetails = settingsHidden(listProfile);
  const [sortMode] = useState<SortMode>('latency');
  const [pingResults, setPingResults] = useState<Record<string, number>>({});
  const [pingingIds, setPingingIds] = useState<Set<string>>(new Set());
  const [isPingAll, setIsPingAll] = useState(false);
  const [showOnlyWorking, setShowOnlyWorking] = useState(false);
  const [autoPicking, setAutoPicking] = useState(false);
  const abortRef = useRef(false);
  const cancelBatchRef = useRef<(() => void) | null>(null);

  useEffect(() => { nativeWarmupCore(); }, []);

  useEffect(() => {
    if (showOnlyWorking && Object.keys(pingResults).length === 0 && !isPingAll) pingAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showOnlyWorking]);


  const pingAll = useCallback(() => {
    if (isPingAll) return;
    abortRef.current = false;
    setIsPingAll(true);
    setPingResults({});
    setPingingIds(new Set(displayNodes.map(n => n.id)));
    cancelBatchRef.current = startPingBatch(
      displayNodes,
      (id, ms) => {
        setPingResults(prev => ({ ...prev, [id]: ms }));
        setPingingIds(prev => { const s = new Set(prev); s.delete(id); return s; });
      },
      () => { cancelBatchRef.current = null; setPingingIds(new Set()); setIsPingAll(false); }
    );
  }, [displayNodes, isPingAll]);

  const pingAllRef = useRef(pingAll);
  useEffect(() => { pingAllRef.current = pingAll; }, [pingAll]);

  const stopPing = useCallback(() => {
    abortRef.current = true;
    if (cancelBatchRef.current) { cancelBatchRef.current(); cancelBatchRef.current = null; }
    setIsPingAll(false);
    setPingingIds(new Set());
  }, []);

  const selectFastest = useCallback(async () => {
    if (displayNodes.length === 0 || autoPicking) return;
    setAutoPicking(true); abortRef.current = false;
    try {
      const results: Record<string, number> = { ...pingResults };
      const toPing = displayNodes.filter(n => results[n.id] === undefined);
      if (toPing.length > 0) {
        setIsPingAll(true);
        setPingingIds(new Set(toPing.map(n => n.id)));
        await new Promise<void>(resolve => {
          cancelBatchRef.current = startPingBatch(
            toPing,
            (id, ms) => {
              results[id] = ms;
              setPingResults(prev => ({ ...prev, [id]: ms }));
              setPingingIds(prev => { const s = new Set(prev); s.delete(id); return s; });
            },
            () => { cancelBatchRef.current = null; setPingingIds(new Set()); setIsPingAll(false); resolve(); }
          );
        });
      }
      if (!abortRef.current) {
        let best: ServerNode | null = null, bestPing = Infinity;
        for (const n of displayNodes) { const p = results[n.id]; if (typeof p === 'number' && p > 0 && p < bestPing) { bestPing = p; best = n; } }
        if (best) { onSelect(best); if (!isConnected) onBack(); }
      }
    } finally { setAutoPicking(false); }
  }, [displayNodes, autoPicking, pingResults, onSelect, isConnected, onBack]);

  const getPing = (node: ServerNode) => pingResults[node.id] !== undefined ? pingResults[node.id] : (node.ping ?? -1);

  const getPingState = (node: ServerNode): PingState => {
    const r = pingResults[node.id];
    if (r !== undefined) return r < 0 ? { status: 'fail', ms: r } : { status: 'ok', ms: r };
    if (typeof node.ping === 'number' && node.ping >= 0) return { status: 'ok', ms: node.ping };
    return { status: 'idle', ms: -1 };
  };

  const filtered = useMemo(() => {
    let list = Array.isArray(displayNodes) ? displayNodes : [];
    if (search.trim()) { const q = search.toLowerCase(); list = list.filter(n => (n?.name || '').toLowerCase().includes(q) || (n?.address || '').toLowerCase().includes(q) || (n?.protocol || '').toLowerCase().includes(q)); }
    if (showOnlyWorking) list = list.filter(n => getPing(n) > 0);
    if (providerSort === 'without') list = [...list];
    else if (providerSort === 'alphabet') list = [...list].sort((a, b) => (a?.name || '').localeCompare(b?.name || '', 'ru'));
    else if (sortMode === 'latency') list = [...list].sort((a, b) => { const pa = getPing(a), pb = getPing(b); if (pa === pb) return 0; if (pa < 0) return 1; if (pb < 0) return -1; return pa - pb; });
    else if (sortMode === 'protocol') list = [...list].sort((a, b) => (a.protocol || '').localeCompare(b.protocol || ''));
    else list = [...list].sort((a, b) => (a?.name || '').localeCompare(b?.name || ''));
    return list;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayNodes, search, sortMode, providerSort, pingResults, showOnlyWorking]);

  const bestServer = useMemo(() => {
    const r = displayNodes.filter(n => getPing(n) > 0);
    return r.length === 0 ? null : r.reduce((p, c) => getPing(p) < getPing(c) ? p : c, r[0]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayNodes, pingResults]);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden" style={{ background: 'var(--bg-deep)' }}>

      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-12 pb-4 shrink-0">
        <button onClick={onBack} className="lg:hidden w-10 h-10 rounded-xl flex items-center justify-center border border-white/10 text-[var(--accent)] active:scale-90 transition-all shrink-0"
          style={{ background: 'rgba(var(--ink-rgb),0.05)' }}>
          <ArrowLeft size={20} />
        </button>
        <h2 className="font-orbitron text-white text-[18px] font-bold tracking-wide flex-1">Серверы</h2>
        <div className="relative">
          <button onClick={() => setShowBatchMenu(!showBatchMenu)}
            className="w-10 h-10 rounded-xl flex items-center justify-center border border-white/10 text-gray-400 active:scale-90 transition-all"
            style={{ background: 'rgba(var(--ink-rgb),0.05)' }}>
            <MoreVertical size={17} />
          </button>
          <AnimatePresence>
            {showBatchMenu && (
              <motion.div initial={{ opacity: 0, scale: 0.9, y: 5 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 5 }}
                className="absolute right-0 top-11 w-52 rounded-2xl p-1.5 z-[60] shadow-2xl"
                style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)' }}>
                <button onClick={() => { setShowOnlyWorking(!showOnlyWorking); setShowBatchMenu(false); }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 text-xs transition-colors"
                  style={{ color: showOnlyWorking ? 'var(--accent)' : onTheme('#cdd5e0') }}>
                  {showOnlyWorking ? <Eye size={14} /> : <EyeOff size={14} />}
                  {showOnlyWorking ? 'Все серверы' : 'Только рабочие'}
                </button>
                <div className="h-px my-1 mx-2 bg-[#2a2a5a44]" />
                <button onClick={() => { if (onDeleteNodes) onDeleteNodes(displayNodes.filter(n => getPing(n) < 0).map(n => n.id)); setShowBatchMenu(false); }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-red-500/10 text-xs text-red-400 transition-colors">
                  <XCircle size={14} /> Удалить мертвые
                </button>
                <button onClick={() => { if (onDeleteNodes) onDeleteNodes(displayNodes.map(n => n.id)); setShowBatchMenu(false); }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-red-600/20 text-xs text-red-500 font-bold transition-colors">
                  <Trash2 size={14} /> Очистить список
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Action buttons */}
      <div className="px-4 pb-3 grid grid-cols-2 gap-2.5 shrink-0">
        <button onClick={selectFastest} disabled={autoPicking}
          className="flex items-center gap-2.5 px-3 py-3 rounded-2xl transition-all active:scale-[0.97]"
          style={{ background: 'var(--tile-green)', border: '1px solid rgba(0,232,122,0.2)' }}>
          <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'rgba(0,232,122,0.15)', border: '1px solid rgba(0,232,122,0.25)' }}>
            <Zap size={16} fill="currentColor" className={`text-[#00e87a] ${autoPicking ? 'animate-pulse' : ''}`} />
          </div>
          <div className="text-left min-w-0">
            <p className="text-[#00e87a] text-[13px] font-bold leading-tight">
              {autoPicking ? 'Подбор...' : 'Быстрейший'}
            </p>
            <p className="text-[#00e87a] text-[10px] opacity-55 leading-tight mt-0.5">Авто-подбор</p>
          </div>
        </button>
        <button onClick={isPingAll ? stopPing : pingAll}
          className="flex items-center gap-2.5 px-3 py-3 rounded-2xl transition-all active:scale-[0.97]"
          style={{ background: 'var(--tile-accent)', border: '1px solid rgba(var(--accent-rgb),0.2)' }}>
          <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'rgba(var(--accent-rgb),0.12)', border: '1px solid rgba(var(--accent-rgb),0.25)' }}>
            <RefreshCw size={16} className={`text-[var(--accent)] ${isPingAll ? 'animate-spin' : ''}`} />
          </div>
          <div className="text-left min-w-0">
            <p className="text-[var(--accent)] text-[13px] font-bold leading-tight">
              {isPingAll ? 'Стоп' : 'Скорость'}
            </p>
            <p className="text-[var(--accent)] text-[10px] opacity-55 leading-tight mt-0.5">
              {isPingAll ? `${Object.keys(pingResults).length}/${displayNodes.length}` : 'Проверить'}
            </p>
          </div>
        </button>
      </div>

      {/* Auto-switch toggle */}
      <div className="px-4 pb-3 shrink-0">
        <div className="flex items-center justify-between px-4 py-3 rounded-2xl"
          style={{ background: 'rgba(var(--ink-rgb),0.03)', border: '1px solid rgba(var(--ink-rgb),0.07)' }}>
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: autoSwitch ? 'rgba(var(--accent-rgb),0.15)' : 'rgba(var(--ink-rgb),0.06)' }}>
              <ArrowLeftRight size={14} className={autoSwitch ? 'text-[var(--accent)]' : 'text-gray-500'} />
            </div>
            <div>
              <p className="text-[12px] font-semibold text-white leading-tight">Авто-переключение</p>
              <p className="text-[10px] text-gray-500 leading-tight mt-0.5">Пинг &gt;5000мс или нет ответа</p>
            </div>
          </div>
          <button onClick={() => onAutoSwitchChange?.(!autoSwitch)}
            className="w-11 h-6 rounded-full relative flex items-center px-0.5 transition-all shrink-0"
            style={{ background: autoSwitch ? 'var(--accent)' : 'var(--track)' }}>
            <div className="absolute transition-all duration-200 w-5 h-5 bg-white rounded-full shadow-sm"
              style={{ left: autoSwitch ? 'calc(100% - 22px)' : '2px' }} />
          </button>
        </div>
      </div>

      {/* Profile selector */}
      {showProfileTabs ? (
        <div className="px-4 mb-3 overflow-x-auto scrollbar-hide shrink-0">
          <div className="flex gap-2 pb-0.5">
            {profiles!.map(p => (
              <button
                key={p.id}
                onClick={() => setLocalProfileId(p.id)}
                className={`shrink-0 max-w-[180px] truncate px-3.5 py-2 rounded-xl text-[11px] font-bold border transition-all active:scale-95 whitespace-nowrap ${
                  p.id === localProfileId
                    ? 'bg-[var(--accent)]/12 border-[var(--accent)]/35 text-[var(--accent)]'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
                style={{
                  // Фирменный цвет провайдера (color-profile) красит выбранную вкладку его подписки
                  ...(p.managed?.accent ? accentVars(onTheme(p.managed.accent)) : {}),
                  ...(p.id !== localProfileId ? { background: 'rgba(var(--ink-rgb),0.04)', borderColor: 'rgba(var(--ink-rgb),0.1)' } : {}),
                } as React.CSSProperties}
              >
                {p.name}
                <span className="ml-1.5 opacity-50 text-[9px]">{p.nodes.length}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 pb-6 scrollbar-hide">
        {filtered.length === 0 ? (
          displayNodes.length === 0 ? (
            <MascotScene mood="thinking" title="Список пуст" text="Серверы появятся, когда вы добавите подписку на вкладке «Профили»" size={130} />
          ) : (
            <MascotScene mood="confused" title="Рабочих серверов не нашлось" text="Проверьте связь или выключите фильтр «только рабочие»" size={130} />
          )
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map(node => {
              const isSelected = selectedNode?.id === node.id;
              const isActive = isConnected && isSelected;
              const pingState = getPingState(node);
              const isPinging = pingingIds.has(node.id);
              const isBest = bestServer?.id === node.id;
              const ping = getPing(node);
              const loadPct = getLoadPercent(ping);
              const lc = loadBarColor(loadPct);
              const protocolLabel = (node.protocol === 'json' && node.method) ? node.method.toUpperCase() : node.protocol.toUpperCase();
              const securityLabel = (node.security && node.security !== 'none') ? node.security.toUpperCase() : '';
              const secStyle = securityLabel ? securityBadgeStyle(node.security || '') : null;
              const isPremium = /премиум|premium/i.test(node.name);

              return (
                <div
                  key={node.id}
                  className="server-card rounded-2xl overflow-hidden"
                  style={{
                    background: isActive
                      ? 'linear-gradient(135deg, rgba(var(--accent-rgb),0.08), rgba(var(--surface-rgb),0.9))'
                      : isSelected
                      ? 'linear-gradient(135deg, rgba(var(--accent-rgb),0.05), rgba(var(--surface-rgb),0.8))'
                      : 'rgba(var(--ink-rgb),0.03)',
                    border: `1px solid ${
                      isActive
                        ? 'rgba(var(--accent-rgb),0.35)'
                        : pingState.status === 'ok'
                        ? 'var(--ok-line)'
                        : pingState.status === 'fail'
                        ? 'var(--bad-line)'
                        : isSelected
                        ? 'rgba(var(--accent-rgb),0.18)'
                        : 'rgba(var(--ink-rgb),0.07)'
                    }`,
                  }}
                  onClick={() => { onSelect(node); if (!isConnected) onBack(); }}
                >
                  <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">

                    {/* Значок страны: флаг один раз и крупно (в названии флаг-эмодзи убран, код страны не нужен) */}
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0"
                      style={{
                        background: isActive
                          ? 'rgba(var(--accent-rgb),0.12)'
                          : 'rgba(var(--ink-rgb),0.06)',
                      }}>
                      <Flag flag={node.flag} name={node.name} size={30} />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      {/* Row 1: name + badges */}
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="text-[14px] font-bold leading-tight truncate"
                          style={{ color: isActive ? 'var(--accent)' : 'rgb(var(--ink-rgb))' }}>
                          {stripLeadingEmoji(node.name)}
                        </p>
                        {isPremium && (
                          <span className="shrink-0 text-[9px] font-black px-1.5 py-[2px] rounded-md"
                            style={{ background: 'rgba(176,0,255,0.2)', color: onTheme('#d06aff'), border: '1px solid rgba(176,0,255,0.4)' }}>
                            + PRO
                          </span>
                        )}
                        {isBest && !isPremium && (
                          <span className="shrink-0 flex items-center gap-1 text-[9px] font-black px-1.5 py-[2px] rounded-md"
                            style={{ background: 'rgba(255,140,0,0.18)', color: onTheme('#ffb340'), border: '1px solid rgba(255,140,0,0.35)' }}>
                            ⚡ HOT
                          </span>
                        )}
                      </div>

                      {/* Row 2: описание от провайдера (serverDescription) вместо протокола; hide-settings прячет защиту, протокол остаётся (как в Happ) */}
                      <p className="text-[12px] mt-[3px] font-medium truncate" style={{ color: onTheme(node.description ? '#b6c7de' : '#8fa6c4') }}>
                        {node.description || protocolLabel}
                      </p>

                      {/* Row 3: значок защиты, цветная таблетка с пингом («831 мс») и полоса нагрузки.
                          Пинг здесь, а не справа: справа он отнимал у названия почти треть ширины. Не мерили — строки нет. */}
                      {((secStyle && !hideDetails) || isPinging || pingState.status !== 'idle') && (
                        <div className="flex items-center gap-2 mt-2 min-h-[24px]">
                          {secStyle && !hideDetails && (
                            <span className="text-[10px] font-bold px-2 py-[3px] rounded-md shrink-0 uppercase tracking-wide"
                              style={{ background: secStyle.bg, color: secStyle.color, border: `1px solid ${secStyle.border}` }}>
                              {securityLabel}
                            </span>
                          )}
                          {(isPinging || pingState.status !== 'idle') && (
                            <PingPill ms={pingState.status === 'idle' ? undefined : pingState.status === 'fail' ? -1 : pingState.ms} pending={isPinging} size="sm" />
                          )}
                          {/* Load bar: только по измеренному пингу */}
                          {loadPct > 0 && (
                            <div className="flex-1 h-[4px] rounded-full overflow-hidden" style={{ background: 'rgba(var(--ink-rgb),0.07)' }}>
                              <div className="h-full rounded-full transition-all duration-700"
                                style={{ width: `${loadPct}%`, background: lc, boxShadow: `0 0 6px ${lc}66` }} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
