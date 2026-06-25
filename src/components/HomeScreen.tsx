import { useState, useEffect } from 'react';
import NeonButton from './NeonButton';
import Flag from './Flag';
import { withAlpha } from '../utils/color';
import { ConnectionState, ServerNode, Protocol } from '../types';
import { VpnStats, nativePingNode } from '../native/bridge';
import { MapPin, Shield, Clock, AlertTriangle, Globe, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface HomeScreenProps {
  connectionState: ConnectionState;
  onToggle: () => void;
  selectedNode: ServerNode | null;
  nodes: ServerNode[];
  onSelectNode: (node: ServerNode) => void;
  onGoToServers: () => void;
  onGoToProfiles: () => void;
  onRestart?: () => void;
  onShowLogs?: () => void;
  connectedTime: number;
  hasNodes: boolean;
  isDark: boolean;
  vpnError?: string | null;
  onClearVpnError?: () => void;
  stats?: VpnStats | null;
}

const protoColors: Record<Protocol, string> = {
  vless: 'var(--accent)', vmess: '#7b68ee', trojan: '#ff00aa', shadowsocks: '#ffe600',
  hysteria: '#ff6b35', hysteria2: '#00ff88', tuic: '#ff4dc4', wireguard: '#88171a',
  shadowtls: '#a78bfa', anytls: '#34d399', naive: '#f97316', socks: '#94a3b8', http: '#64748b',
  ssh: '#a3e635', brook: '#22d3ee', mtproto: '#818cf8', xhttp: '#fb7185', json: '#94a3b8'
};

function pingColor(ms: number): string {
  if (ms < 0) return '#ef4444';
  if (ms < 100) return '#00ff88';
  if (ms < 200) return '#ffe600';
  return '#f97316';
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export default function HomeScreen({
  connectionState, onToggle, selectedNode, nodes, onSelectNode,
  onGoToServers, onGoToProfiles, connectedTime, hasNodes,
  isDark, vpnError, onClearVpnError, stats, onRestart, onShowLogs
}: HomeScreenProps) {
  const isConnected = connectionState === 'connected';
  const protoColor = selectedNode ? (protoColors[selectedNode.protocol] || 'var(--accent)') : 'var(--accent)';

  // Цвет под большую кнопку (NeonButton.getColor): рамка карточки сервера повторяет
  // её состояние — выключено/запуск var(--accent), подключено зелёный и т.д.
  const buttonColor =
    connectionState === 'connected' ? '#00ff88' :
    connectionState === 'verifying' ? '#ffe600' :
    connectionState === 'reconnecting' ? '#b000ff' :
    connectionState === 'disconnecting' ? '#ff6600' :
    'var(--accent)';

  // Направление последнего свайпа — для анимации появления новой карточки.
  const [swipeDir, setSwipeDir] = useState(0);

  // Живой пинг выбранного сервера: меряем сразу при смене (в т.ч. со свайпа).
  const [pingMs, setPingMs] = useState<number | undefined>(selectedNode?.ping);
  const [pinging, setPinging] = useState(false);
  useEffect(() => {
    if (!selectedNode) { setPingMs(undefined); setPinging(false); return; }
    const node = selectedNode;
    let cancelled = false;
    setPingMs(node.ping);   // показываем прошлое значение, пока идёт замер
    setPinging(true);
    // Дебаунс: быстрые свайпы отменяют предыдущий замер, ядро не плодим.
    const t = setTimeout(() => {
      nativePingNode(node, 'proxy', isConnected, true)
        .then((ms) => { if (!cancelled) setPingMs(ms); })
        .catch(() => { if (!cancelled) setPingMs(-1); })
        .finally(() => { if (!cancelled) setPinging(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [selectedNode?.id, isConnected]);

  // Смена сервера свайпом: листаем по кругу список allNodes относительно текущего.
  const changeServer = (delta: number) => {
    if (nodes.length < 2 || !selectedNode) return;
    const idx = nodes.findIndex((n) => n.id === selectedNode.id);
    const base = idx < 0 ? 0 : idx;
    const next = (base + delta + nodes.length) % nodes.length;
    if (nodes[next] && nodes[next].id !== selectedNode.id) {
      setSwipeDir(delta);
      onSelectNode(nodes[next]);
    }
  };

  // Stats are now passed as props from App.tsx to avoid multiple polling intervals

  return (
    <div className="flex flex-col items-center justify-between h-full w-full relative py-8 px-4 overflow-x-hidden will-change-transform">
      {/* Background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute inset-0 grid-bg opacity-20" />
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] sm:w-[400px] sm:h-[400px] rounded-full blur-[100px]"
          style={{
            background: isConnected ? '#00ff8810' : 'var(--accent-a08)',
            transition: 'background 0.5s ease-out'
          }}
        />
      </div>

      {/* Top Section */}
      <div className="relative z-10 flex flex-col items-center w-full max-w-md pt-4">

        {/* Logo */}
        <div className="flex items-center gap-3 mb-5">
          <Shield size={22} style={{ color: isConnected ? protoColor : (isDark ? '#ffffff' : '#0f172a'), filter: isConnected ? `drop-shadow(0 0 10px ${protoColor})` : undefined }} />
          <h1 className="font-orbitron text-2xl font-bold tracking-[0.2em] uppercase">
            <span className="neon-text-white-cyan">SIM</span>
            <span className="neon-text-cyan ml-3">PROXY</span>
          </h1>
        </div>

        {/* Status: единая карточка при подключении, простой бейдж при отключении */}
        <AnimatePresence mode="wait">
          {isConnected ? (
            <motion.div
              key="status-card"
              initial={{ opacity: 0, y: -8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.97 }}
              transition={{ duration: 0.25 }}
              className="w-full rounded-2xl px-4 py-3 mb-4 border"
              style={{
                background: `linear-gradient(135deg, ${withAlpha(protoColor, '0a')}, ${withAlpha(protoColor, '04')})`,
                borderColor: withAlpha(protoColor, '33'),
                boxShadow: `0 0 24px ${withAlpha(protoColor, '08')}`,
              }}
            >
              {/* Строка 1: протокол + таймер */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#00ff88] shrink-0" style={{ boxShadow: '0 0 6px #00ff8888' }} />
                  <span className="text-[11px] font-orbitron font-bold uppercase tracking-widest" style={{ color: protoColor }}>
                    {selectedNode?.protocol.toUpperCase()} · Активен
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Clock size={11} className="text-[#00ff88]" />
                  <span className="font-orbitron text-sm font-bold text-[#00ff88]" style={{ textShadow: '0 0 8px #00ff8855' }}>
                    {formatTime(connectedTime)}
                  </span>
                </div>
              </div>

              {/* Строка 2: IP + страна */}
              {stats?.publicIp && (
                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[#ffffff08]">
                  <Globe size={11} className="text-gray-600 shrink-0" />
                  <span className="text-[11px] font-mono text-gray-400">{stats.publicIp}</span>
                  <span className="text-[11px] font-bold ml-auto" style={{ color: protoColor }}>{stats.country}</span>
                </div>
              )}

              {/* Нет интернета */}
              {stats?.latency !== undefined && stats.latency <= 0 && (
                <div className="flex items-center gap-1.5 mt-2 text-[10px] text-red-400 font-bold uppercase tracking-wider">
                  <Shield size={9} />
                  Нет доступа в интернет
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="status-badge"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="px-6 py-2 rounded-full text-[10px] font-orbitron font-bold uppercase tracking-[0.15em] mb-4 bg-[#ff660011] border border-[#ff660044]"
              style={{ color: isDark ? '#ffffff' : '#0f172a', boxShadow: '0 0 20px #ff660011' }}
            >
              ○ Незащищённое соединение
            </motion.div>
          )}
        </AnimatePresence>

        {/* VPN ошибка */}
        {vpnError && (
          <div className="px-4 py-3 rounded-2xl bg-[#ff44440a] border border-[#ff444433] flex items-start gap-3 w-full mb-4">
            <div className="p-2 rounded-lg bg-[#ff444415] shrink-0">
              <AlertTriangle size={18} className="text-[#ff4444]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[#ff4444] text-sm font-bold">Ошибка подключения</p>
              <pre className="text-xs text-gray-300 mt-1 break-words whitespace-pre-wrap max-h-36 overflow-y-auto font-mono">{vpnError}</pre>
              <button
                onClick={() => { try { navigator.clipboard?.writeText(vpnError || ''); } catch {} }}
                className="mt-2 text-xs text-[var(--accent)] opacity-70"
              >
                Скопировать
              </button>
            </div>
            <button onClick={onClearVpnError} className="text-sm text-gray-400 ml-1 shrink-0">✕</button>
          </div>
        )}

        {/* VPN запускается */}
        {stats && ((stats.status === 'starting' && !isConnected) || stats.error === 'vpn_starting') && (
          <div className="px-4 py-3 rounded-2xl bg-[var(--accent-a10)] border border-[var(--accent-a33)] flex items-start gap-3 w-full mb-4">
            <div className="p-2 rounded-lg bg-[var(--accent-a10)]">
              <Clock size={18} className="text-[var(--accent)]" />
            </div>
            <div className="flex-1">
              <p className="text-[var(--accent)] text-sm font-bold">VPN запускается</p>
              <p className="text-sm text-gray-300 mt-1">{stats.message || 'Пожалуйста, подождите, идёт инициализация...'}</p>
            </div>
          </div>
        )}

        {/* Проблема маршрутизации */}
        {stats && ((stats.status === 'not_routing') || stats.error === 'vpn_not_routing') && (
          <div className="px-4 py-3 rounded-2xl bg-[#ff44440a] border border-[#ff444433] flex items-start gap-3 w-full mb-4">
            <div className="p-2 rounded-lg bg-[#ff444415]">
              <AlertTriangle size={18} className="text-[#ff4444]" />
            </div>
            <div className="flex-1">
              <p className="text-[#ff4444] text-sm font-bold">Проблема маршрутизации</p>
              <p className="text-sm text-gray-300 mt-1">{stats.lastError || stats.message || 'Маршрутизация VPN не активна'}</p>
              <div className="mt-2 flex gap-2">
                <button onClick={() => onRestart?.()} className="text-sm bg-[#ffffff08] px-3 py-1 rounded text-[var(--accent)] font-medium">Перезапустить VPN</button>
                <button onClick={() => { onShowLogs ? onShowLogs() : (window as any).navigateToDebug?.(); }} className="text-sm text-[var(--accent)] font-medium">Открыть диагностику →</button>
              </div>
            </div>
          </div>
        )}

        {/* Нет серверов */}
        {!hasNodes && (
          <div className="px-6 py-4 rounded-2xl bg-[#ff66000a] border border-[#ff660033] flex items-center gap-4 w-full backdrop-blur-md mb-6">
            <div className="p-2 rounded-lg bg-[#ff660015]">
              <AlertTriangle size={18} className="text-[#ff6600]" />
            </div>
            <div>
              <p className="text-[#ff6600] text-sm font-bold tracking-wide">Нет серверов</p>
              <button onClick={onGoToProfiles} className="text-[11px] text-[var(--accent)] font-medium hover:underline underline-offset-4 decoration-[var(--accent-a44)]">Добавить подписку →</button>
            </div>
          </div>
        )}
      </div>

       {/* Center Section — Connect button */}
       <div className="relative z-10 flex flex-col items-center justify-center flex-1 pb-4 w-full max-w-md px-4 gap-6">
         <NeonButton state={connectionState} onToggle={hasNodes ? onToggle : onGoToProfiles} />
       </div>

      {/* Bottom Section — server card with explicit swipe arrows */}
      <div className="relative z-10 w-full max-w-md pb-2">
        {selectedNode ? (
          <>
            {/* Карточка + стрелки под ней */}
            <div>
              <motion.button
                key={selectedNode.id}
                drag={nodes.length > 1 ? 'x' : false}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.45}
                dragMomentum={false}
                onDragEnd={(_e, info) => {
                  const T = 60;
                  if (info.offset.x <= -T) changeServer(1);
                  else if (info.offset.x >= T) changeServer(-1);
                }}
                initial={{ opacity: 0, x: swipeDir >= 0 ? 48 : -48 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                whileTap={{ scale: 0.98 }}
                onClick={onGoToServers}
                className="flex items-center gap-3 px-4 py-4 rounded-2xl glass-card w-full border transition-colors touch-pan-y cursor-grab active:cursor-grabbing"
                style={{ borderColor: withAlpha(buttonColor, '55'), boxShadow: `0 8px 32px -4px ${withAlpha(buttonColor, '15')}` }}
              >
                <Flag flag={selectedNode.flag} name={selectedNode.name} size={32} className="shrink-0 pointer-events-none" />
                <div className="flex-1 text-left min-w-0 pointer-events-none">
                  <p className="text-white text-sm font-semibold truncate leading-tight">
                    {selectedNode.name.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*/u, '')}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1">
                    <MapPin size={10} className="text-gray-500 shrink-0" />
                    <span className="text-gray-400 text-[11px] font-mono truncate tracking-tight">{selectedNode.address}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#ffffff0a] border border-[#ffffff15]"
                      style={{ color: protoColor }}>
                      {selectedNode.protocol.toUpperCase()}
                    </span>
                    {selectedNode.security && selectedNode.security !== 'none' && (
                      <span className="text-[9px] font-mono text-gray-500 px-2 py-0.5 rounded bg-[#ffffff05] border border-[#ffffff10]">
                        {selectedNode.security.toUpperCase()}
                      </span>
                    )}
                  </div>
                </div>
                {/* Пинг — фиксированная ширина, не двигает карточку */}
                <div className="shrink-0 w-[52px] flex items-center justify-end pointer-events-none">
                  {pinging ? (
                    <Loader2 size={12} className="animate-spin text-gray-400" />
                  ) : pingMs !== undefined ? (
                    <div className="flex items-center gap-1">
                      <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: pingColor(pingMs) }} />
                      <span className="text-[11px] font-mono font-bold" style={{ color: pingColor(pingMs) }}>
                        {pingMs < 0 ? 'timeout' : `${pingMs}ms`}
                      </span>
                    </div>
                  ) : null}
                </div>
              </motion.button>

              {/* Стрелки под карточкой с подсказкой */}
              {nodes.length > 1 && (
                <div className="flex justify-between items-center mt-2 px-1">
                  <button
                    onClick={() => changeServer(-1)}
                    className="w-7 h-7 rounded-lg flex items-center justify-center border border-[#ffffff10] bg-[#ffffff05] text-gray-500 hover:text-[var(--accent)] hover:border-[var(--accent-a33)] active:scale-90 transition-all"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span className="text-[10px] text-gray-600 uppercase tracking-[0.2em] font-medium select-none">
                    свайп для смены
                  </span>
                  <button
                    onClick={() => changeServer(1)}
                    className="w-7 h-7 rounded-lg flex items-center justify-center border border-[#ffffff10] bg-[#ffffff05] text-gray-500 hover:text-[var(--accent)] hover:border-[var(--accent-a33)] active:scale-90 transition-all"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              )}
            </div>

          </>
        ) : (
          <button onClick={onGoToServers}
            className="flex items-center justify-center gap-4 px-8 py-4 rounded-[20px] bg-[#12122a] border border-[#2a2a5a] w-full active:scale-[0.98] transition-all"
          >
            <MapPin size={18} className="text-gray-500" />
            <span className="text-gray-400 font-medium tracking-wide">Выберите сервер</span>
          </button>
        )}
      </div>
    </div>
  );
}