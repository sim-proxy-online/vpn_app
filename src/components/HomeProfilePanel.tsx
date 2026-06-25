import { useState, useCallback, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  Globe, Database, RefreshCw, Settings, Activity,
  Calendar, Wifi, Check, Link2,
} from 'lucide-react';
import Flag from './Flag';
import { withAlpha } from '../utils/color';
import { SubscriptionProfile, ServerNode, PanelType } from '../types';
import { formatBytes } from '../data';
import { nativePingNode, nativeWarmupCore, nativeOpenUrl } from '../native/bridge';

interface HomeProfilePanelProps {
  profiles: SubscriptionProfile[];
  activeProfileId: string | null;
  activeNodeId?: string;
  isConnected?: boolean;
  onSelectNode: (node: ServerNode) => void;
  onSetActive: (id: string) => void;
  onUpdateProfile: (id: string) => Promise<void>;
  onGoToProfiles: () => void;
}

// ── Ping helpers (mirror ProfilesScreen) ─────────────────────────────────────

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

const PANEL_META: Record<PanelType, { label: string; color: string }> = {
  remnawave: { label: 'Remnawave', color: '#a78bfa' },
  '3x-ui':   { label: '3X-UI',    color: '#f97316' },
  marzban:   { label: 'Marzban',  color: '#22d3ee' },
  hiddify:   { label: 'Hiddify',  color: '#4ade80' },
  xui:       { label: 'X-UI',     color: '#fb923c' },
  unknown:   { label: 'Sub',      color: '#6b7280' },
};

function formatDate(ts?: number): string {
  if (!ts) return 'Бессрочно';
  return new Date(ts * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Desktop-only panel for the Home screen: shows the active subscription
 * profile (traffic, status, actions) together with its server list and
 * inline ping — so the user lands on servers immediately at launch without
 * navigating to the Profiles tab. Hidden on mobile via the parent's `lg:` gate.
 */
export default function HomeProfilePanel({
  profiles, activeProfileId, activeNodeId, isConnected = false,
  onSelectNode, onSetActive, onUpdateProfile, onGoToProfiles,
}: HomeProfilePanelProps) {
  const profile = profiles.find(p => p.id === activeProfileId) ?? profiles[0] ?? null;

  const [isUpdating, setIsUpdating] = useState(false);
  const [pingMap, setPingMap] = useState<Record<string, number>>({});
  const [pingingSet, setPingingSet] = useState<Set<string>>(new Set());
  const pingAbortRef = useRef<Record<string, boolean>>({});
  const autoPingedRef = useRef<string | null>(null);

  // Прогреваем ядро заранее, чтобы первый пинг не «думал» на инициализации libxray.
  useEffect(() => { nativeWarmupCore(); }, []);

  const pingNode = useCallback(async (node: ServerNode) => {
    if (pingingSet.has(node.id)) return;
    setPingingSet(prev => new Set(prev).add(node.id));
    try {
      const ms = await nativePingNode(node, 'proxy', isConnected, true);
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
    for (let i = 0; i < nodes.length; i += 1) {
      if (pingAbortRef.current[id]) break;
      await pingNode(nodes[i]);
    }
    delete pingAbortRef.current[id];
  }, [pingNode]);

  // Авто-пинг всех серверов при старте (и при смене активного профиля) — один
  // раз на профиль. Небольшая задержка даёт ядру прогреться (nativeWarmupCore),
  // чтобы первый замер не «думал» на инициализации libxray.
  useEffect(() => {
    if (!profile || profile.nodes.length === 0) return;
    if (autoPingedRef.current === profile.id) return;
    autoPingedRef.current = profile.id;
    const nodes = profile.nodes;
    const t = setTimeout(() => { pingAll(nodes); }, 1000);
    return () => clearTimeout(t);
  }, [profile, pingAll]);

  const handleUpdate = useCallback(async () => {
    if (!profile || isUpdating) return;
    setIsUpdating(true);
    try { await onUpdateProfile(profile.id); } catch { /* notified upstream */ }
    finally { setIsUpdating(false); }
  }, [profile, isUpdating, onUpdateProfile]);

  // Пустое состояние — нет ни одного профиля.
  if (!profile) {
    return (
      <div className="hidden lg:flex flex-col items-center justify-center w-[400px] shrink-0 h-full border-r border-[var(--accent-a15)] bg-[#0a0a1a]/40 px-8 text-center">
        <div className="w-20 h-20 rounded-[32px] bg-white/[0.02] border border-white/5 flex items-center justify-center mb-6">
          <Link2 size={32} className="text-gray-700" />
        </div>
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-600">Нет активных профилей</p>
        <button
          onClick={onGoToProfiles}
          className="mt-8 px-8 py-3 rounded-xl bg-[var(--accent)]/5 border border-[var(--accent)]/10 text-[var(--accent)] text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all"
        >
          Добавить подписку
        </button>
      </div>
    );
  }

  const panelMeta = profile.panelType ? PANEL_META[profile.panelType as PanelType] : undefined;
  const isActiveProfile = profile.id === activeProfileId;

  return (
    <div className="hidden lg:flex flex-col w-[400px] shrink-0 h-full border-r border-[var(--accent-a15)] bg-[#0a0a1a]/40">
      {/* Закреплённая шапка: переключатель профилей + карточка + заголовок списка — не скроллится */}
      <div className="shrink-0 p-5 pb-2">
        {/* Переключатель профилей — клик меняет активный профиль */}
        {profiles.length > 1 && (
          <div className="flex gap-2 overflow-x-auto scrollbar-none mb-4 pb-0.5">
            {profiles.map(p => (
              <button
                key={p.id}
                onClick={() => onSetActive(p.id)}
                title={p.name}
                className={`shrink-0 max-w-[150px] truncate px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-all ${
                  p.id === profile.id
                    ? 'bg-[var(--accent)]/15 border-[var(--accent)]/40 text-[var(--accent)]'
                    : 'bg-white/[0.03] border-white/10 text-gray-400 hover:text-white hover:border-white/20'
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}

        {/* Profile card */}
        <div className="relative overflow-hidden rounded-[28px] border border-[var(--accent)]/20 bg-white/[0.03] ring-1 ring-[var(--accent)]/10 mb-5">
          <div className="p-5">
            <div className="flex items-center gap-4 mb-5">
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0"
                style={profile.url
                  ? { background: 'linear-gradient(145deg, #152035, #0c1525)', border: '1px solid rgba(255,255,255,0.07)' }
                  : { backgroundColor: 'var(--accent)' }}
              >
                {profile.url
                  ? <Globe size={28} strokeWidth={1.4} className="text-[var(--accent)]" style={{ filter: 'drop-shadow(0 0 4px var(--accent-a44))', opacity: 0.85 }} />
                  : <Database size={26} strokeWidth={2.5} className="text-black" />}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-white leading-tight break-words">{profile.name}</h3>
                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mt-0.5 opacity-60 truncate">
                  {profile.url ? (() => { try { return new URL(profile.url).hostname; } catch { return profile.url; } })() : 'Локальный импорт'}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/40 border border-white/10">
                  <div className={`w-1.5 h-1.5 rounded-full ${
                    profile.status === 'healthy' ? 'bg-[#00ff88]' :
                    profile.status === 'expired' ? 'bg-[#ff4444]' : 'bg-[#ffcc00]'
                  } shadow-[0_0_5px_currentColor]`} />
                  <span className="text-[7px] font-black uppercase tracking-widest text-gray-400">
                    {profile.status === 'healthy' ? 'Активен' : profile.status === 'expired' ? 'Истек' : 'Внимание'}
                  </span>
                </div>
              </div>
            </div>

            {/* Traffic */}
            {profile.traffic && (
              <div className="space-y-4 mb-5">
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/5">
                    <div className="flex items-center gap-2 text-gray-500 mb-1">
                      <Activity size={12} />
                      <span className="text-[8px] font-black uppercase tracking-widest">Трафик</span>
                    </div>
                    <p className="text-xs font-black text-white">
                      {formatBytes(profile.traffic.download + profile.traffic.upload)} / {profile.traffic.total > 0 ? formatBytes(profile.traffic.total) : '∞'}
                    </p>
                  </div>
                  <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/5">
                    <div className="flex items-center gap-2 text-gray-500 mb-1">
                      <Calendar size={12} />
                      <span className="text-[8px] font-black uppercase tracking-widest">Истекает</span>
                    </div>
                    <p className="text-xs font-black text-white">
                      {profile.traffic.expire ? formatDate(profile.traffic.expire) : 'Бессрочно'}
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="h-2 w-full bg-white/[0.03] rounded-full overflow-hidden border border-white/5">
                    <motion.div
                      initial={{ width: 0 }} animate={{ width: `${Math.min(100, profile.traffic.usagePercentage || 0)}%` }}
                      className={`h-full shadow-[0_0_15px_rgba(var(--accent-rgb),0.4)] ${(profile.traffic.usagePercentage || 0) > 90 ? 'bg-gradient-to-r from-[#ff4444] to-[#ff0000]' : (profile.traffic.usagePercentage || 0) > 70 ? 'bg-gradient-to-r from-[#ffcc00] to-[#ff8800]' : 'bg-gradient-to-r from-[var(--accent)] to-[#0070ff]'}`}
                    />
                  </div>
                  <div className="flex justify-between items-center text-[9px] font-black uppercase tracking-widest">
                    <span className="text-gray-600">Использовано {Math.round(profile.traffic.usagePercentage || 0)}%</span>
                    {profile.traffic.remainingDays !== undefined && (
                      <span className={profile.traffic.remainingDays <= 3 ? 'text-[#ff4444]' : 'text-gray-400'}>
                        Осталось {profile.traffic.remainingDays} дн.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Footer actions */}
            <div className="flex items-center justify-between pt-4 border-t border-white/5">
              <div className="flex gap-2">
                <button onClick={handleUpdate}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--accent)]/5 border border-[var(--accent)]/10 text-[var(--accent)] text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all"
                >
                  <RefreshCw size={12} className={isUpdating ? 'animate-spin' : ''} /> Обновить
                </button>
                <button onClick={onGoToProfiles}
                  className="p-2 rounded-xl bg-white/5 border border-white/10 text-gray-400 active:scale-95 transition-all"
                  title="Настройки профиля"
                >
                  <Settings size={14} />
                </button>
                {profile.supportUrl && (
                  <button onClick={() => nativeOpenUrl(profile.supportUrl!)}
                    className="p-2 rounded-xl bg-white/5 border border-white/10 text-gray-400 active:scale-95 transition-all"
                  >
                    <Globe size={14} />
                  </button>
                )}
              </div>
              <div className="text-right">
                <p className="text-[8px] font-black text-gray-600 uppercase tracking-widest mb-0.5">Обновлено</p>
                <p className="text-[9px] font-mono text-gray-500">{profile.updatedAt.split(',')[0]}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Server list header */}
        <div className="px-1 py-2 flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
            Серверов: {profile.nodes.length}
          </span>
          <button
            onClick={() => pingAll(profile.nodes)}
            disabled={pingingSet.size > 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-[var(--accent)] text-[10px] font-bold uppercase tracking-wider active:scale-95 transition-all disabled:opacity-40"
          >
            <Wifi size={11} className={pingingSet.size > 0 ? 'animate-pulse' : ''} />
            {pingingSet.size > 0 ? 'Пингую...' : 'Пинг всех'}
          </button>
        </div>
      </div>

      {/* Скроллится только список серверов */}
      <div className="flex-1 overflow-y-auto scrollbar-none px-5 pb-5 space-y-1.5">
        {profile.nodes.map(node => {
            const ping = pingMap[node.id];
            const isPinging = pingingSet.has(node.id);
            const pColor = pingColor(ping);
            return (
              <button
                key={node.id}
                onClick={() => { onSelectNode(node); if (!isActiveProfile) onSetActive(profile.id); }}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-2xl transition-all duration-200 ${activeNodeId === node.id ? 'bg-[var(--accent)]/10 border border-[var(--accent)]/20' : 'hover:bg-white/[0.04] border border-transparent'}`}
              >
                <div className="flex items-center gap-3 overflow-hidden flex-1 min-w-0">
                  <Flag flag={node.flag} name={node.name} size={22} className="shrink-0 drop-shadow-sm" />
                  <div className="text-left overflow-hidden min-w-0">
                    <p className={`text-[13px] font-semibold truncate leading-tight ${activeNodeId === node.id ? 'text-[var(--accent)]' : 'text-gray-100'}`}>
                      {node.name}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[9px] uppercase font-bold tracking-wide px-1.5 py-0.5 bg-black/40 rounded border border-white/5 text-[var(--accent)] shrink-0">
                        {node.protocol}
                        {node.security && node.security !== 'none' && ` · ${node.security}`}
                        {node.transport && node.transport !== 'tcp' && ` · ${node.transport}`}
                      </span>
                      <span className="text-[10px] font-mono truncate text-gray-500">{node.address}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    onClick={e => { e.stopPropagation(); pingNode(node); }}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border transition-all active:scale-90 cursor-pointer"
                    style={{ borderColor: withAlpha(pColor, '40'), background: withAlpha(pColor, '12') }}
                  >
                    {isPinging ? (
                      <div className="sim-spin" style={{ display: 'flex' }}>
                        <Wifi size={11} style={{ color: 'var(--accent)' }} />
                      </div>
                    ) : (
                      <Wifi size={11} style={{ color: pColor }} />
                    )}
                    <span className="text-[10px] font-bold font-mono" style={{ color: pColor }}>
                      {isPinging ? '…' : pingLabel(ping)}
                    </span>
                  </span>
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
    </div>
  );
}
