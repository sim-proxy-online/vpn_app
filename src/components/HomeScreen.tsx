import { useState, type ReactNode } from 'react';
import ConnectMedallion from './ConnectMedallion';
import Flag from './Flag';
import { withAlpha, onTheme } from '../utils/color';
import { isAutoBypassEnabled } from '../utils/autoBypass';
import { ConnectionState, ServerNode, Protocol } from '../types';
import { VpnStats } from '../native/bridge';
import { MapPin, Clock, AlertTriangle, Globe, ChevronLeft, ChevronRight, ShieldOff, ShieldCheck, Sparkles, Sun, Moon } from 'lucide-react';
import { useTheme } from '../ThemeContext';
import PingPill from './PingPill';
import { MascotNote, MascotScene } from './MascotScene';
import { stripLeadingEmoji } from '../utils/nodeName';
import { useOnline } from '../utils/useOnline';
import { usePublicIp } from '../utils/usePublicIp';
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
  // Серверов нет, потому что закончился пробный период: вместо «Добавить подписку» показываем ссылку на подписку.

  vpnError?: string | null;
  onClearVpnError?: () => void;
  stats?: VpnStats | null;
  // Ход автоподбора режима обхода («попытка 2 из 3: …») — показывается под кнопкой подключения.
  bypassHint?: string | null;
  // Провайдер включил hide-settings: протокол и защита сервера не показываются.
  hideServerDetails?: boolean;
  // Режим «Иммунитет» (фильтр) поднят: вместо «Не защищено» показываем значок щита.
  shieldActive?: boolean;
}

const protoColors: Record<Protocol, string> = {
  vless: 'var(--accent)', vmess: '#7b68ee', trojan: '#ff00aa', shadowsocks: '#ffe600',
  hysteria: '#ff6b35', hysteria2: '#00ff88', tuic: '#ff4dc4', wireguard: '#88171a',
  shadowtls: '#a78bfa', anytls: '#34d399', naive: '#f97316', socks: '#94a3b8', http: '#64748b',
  ssh: '#a3e635', brook: '#22d3ee', mtproto: '#818cf8', xhttp: '#fb7185', json: '#94a3b8'
};

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/** Плитка показателя соединения. labelOverride подменяет подпись в шапке, когда значение известно
    (например, вместо «Ваш адрес» — название страны); sub остаётся запасной строкой снизу. */
function Tile({ icon, label, labelOverride, value, color, mono }: { icon: ReactNode; label: string; labelOverride?: string; value: string; color?: string; mono?: boolean }) {
  return (
    <div className="rounded-2xl px-3.5 py-3 border border-white/[0.08] bg-white/[0.035] min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-400">{icon}<span className="truncate">{labelOverride || label}</span></div>
      <p className={`mt-1.5 text-[15px] font-bold text-white truncate ${mono ? 'font-orbitron tabular-nums' : ''}`} style={color ? { color: onTheme(color) } : undefined}>{value}</p>
    </div>
  );
}

/** Круглая кнопка смены темы: на тёмной солнце (переход в светлую), на светлой — луна. */
function ThemeToggleButton() {
  const { isDark, toggleTheme } = useTheme();
  return (
    <button
      onClick={toggleTheme}
      aria-label={isDark ? 'Включить светлую тему' : 'Включить тёмную тему'}
      title={isDark ? 'Светлая тема' : 'Тёмная тема'}
      className="w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-gray-400 hover:text-[var(--accent)] hover:border-[var(--accent-a33)] active:scale-90 transition-all"
    >
      {isDark ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
}

export default function HomeScreen({
  connectionState, onToggle, selectedNode, nodes, onSelectNode,
  onGoToServers, onGoToProfiles, connectedTime, hasNodes,
  vpnError, onClearVpnError, stats, onRestart, onShowLogs, bypassHint, hideServerDetails = false,
  shieldActive = false
}: HomeScreenProps) {
  const isConnected = connectionState === 'connected';
  const online = useOnline();
  // Внешний адрес и страна через туннель (раньше плитка брала их из статистики, где они никогда не заполнялись)
  const publicIp = usePublicIp(isConnected, selectedNode?.id);
  const protoColor = selectedNode ? (protoColors[selectedNode.protocol] || 'var(--accent)') : 'var(--accent)';

  // Рамка карточки сервера повторяет цвет состояния главной кнопки.
  const buttonColor =
    connectionState === 'connected' ? '#00e08a' :
    connectionState === 'verifying' ? '#ffd23f' :
    connectionState === 'reconnecting' ? '#b46bff' :
    connectionState === 'disconnecting' ? '#ff7a3d' :
    'var(--accent)';

  // Направление последнего свайпа — для анимации появления новой карточки.
  const [swipeDir, setSwipeDir] = useState(0);

  // Пинг выбранного сервера: берём кэш из раздела «Серверы» (node.ping), живой замер на главном
  // не запускаем — он поднимал лишнее ядро и мешал работе VPN.
  const pingMs = selectedNode?.ping;

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

  const nodeIndex = selectedNode ? Math.max(0, nodes.findIndex((n) => n.id === selectedNode.id)) : 0;
  const latency = stats?.latency;
  const autoBypass = isAutoBypassEnabled();

  return (
    <div className="flex flex-col items-center justify-between h-full w-full relative py-8 px-4 overflow-x-hidden will-change-transform">
      {/* Фон: сетка и тёплое свечение под медальоном */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute inset-0 grid-bg opacity-20" />
        <div
          className="absolute top-[46%] left-1/2 -translate-x-1/2 -translate-y-1/2 w-[340px] h-[340px] sm:w-[440px] sm:h-[440px] rounded-full blur-[110px] transition-[background] duration-700"
          style={{ background: isConnected ? '#00e08a14' : 'var(--accent-a08)' }}
        />
        <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-[420px] h-[220px] rounded-full blur-[90px] opacity-30" style={{ background: '#2f7fe633' }} />
      </div>

      {/* Верх: название и состояние */}
      <div className="relative z-10 flex flex-col items-center w-full max-w-md pt-3">
        <h1 className="text-[24px] leading-none font-extrabold tracking-tight">
          <span className={'text-white'}>Квадрат </span>
          <span style={{ color: 'var(--accent)' }}>Петровича</span>
        </h1>

        <AnimatePresence mode="wait">
          {isConnected ? (
            <motion.div
              key="status-card"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
              className="w-full mt-5"
            >
              <div className="flex items-center justify-center gap-2 mb-3">
                <ShieldCheck size={15} className="text-[#00e08a]" />
                <span className="text-[12px] font-bold text-[#00e08a]">
                  Защита включена · {selectedNode?.protocol.toUpperCase()}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <Tile icon={<Globe size={12} />} label="Ваш адрес" labelOverride={publicIp.country} value={publicIp.ip ?? (publicIp.failed ? 'не определён' : 'определяю…')} />
                <Tile icon={<Clock size={12} />} label="В сети" value={formatTime(connectedTime)} mono color="#00e08a" />
              </div>
              {/* Нет интернета */}
              {latency !== undefined && latency <= 0 && (
                <div className="flex items-center justify-center gap-1.5 mt-3 text-[12px] text-red-400 font-bold">
                  <ShieldOff size={12} />
                  Нет доступа в интернет
                </div>
              )}
              {/* Смена темы */}
              <div className="flex justify-center mt-3">
                <ThemeToggleButton />
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="status-badge"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="flex flex-wrap items-center justify-center gap-2 mt-5"
            >
              {shieldActive ? (
                <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-semibold border border-[#00e08a44] bg-[#00e08a12] text-[#00e08a]">
                  <ShieldCheck size={13} /> Иммунитет: фильтр активен
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-semibold border border-[#ff9d4d44] bg-[#ff9d4d12] text-[#ffb36b]">
                  <ShieldOff size={13} /> Не защищено
                </span>
              )}
              <span className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-semibold border ${autoBypass ? 'border-[var(--accent-a33)] bg-[var(--accent-a10)] text-[var(--accent)]' : 'border-white/10 bg-white/[0.04] text-gray-400'}`}>
                <Sparkles size={13} /> Умный обход: {autoBypass ? 'вкл' : 'выкл'}
              </span>
              <ThemeToggleButton />
            </motion.div>
          )}
        </AnimatePresence>

        {/* VPN ошибка */}
        {vpnError && (
          <div className="px-4 py-3 rounded-2xl bg-[#ff44440a] border border-[#ff444433] flex items-start gap-3 w-full mt-4">
            <div className="p-2 rounded-lg bg-[#ff444415] shrink-0">
              <AlertTriangle size={18} className="text-[#ff4444]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[#ff4444] text-sm font-bold">Ошибка подключения</p>
              <pre className="text-xs text-gray-300 mt-1 break-words whitespace-pre-wrap max-h-36 overflow-y-auto font-mono">{vpnError}</pre>
              <button
                onClick={() => { try { navigator.clipboard?.writeText(vpnError || ''); } catch {} }}
                className="mt-2 text-xs text-[var(--accent)] opacity-80"
              >
                Скопировать
              </button>
            </div>
            <button onClick={onClearVpnError} aria-label="Закрыть" className="text-sm text-gray-400 ml-1 shrink-0">✕</button>
          </div>
        )}

        {/* VPN запускается */}
        {stats && ((stats.status === 'starting' && !isConnected) || stats.error === 'vpn_starting') && (
          <div className="px-4 py-3 rounded-2xl bg-[var(--accent-a10)] border border-[var(--accent-a33)] flex items-start gap-3 w-full mt-4">
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
          <div className="px-4 py-3 rounded-2xl bg-[#ff44440a] border border-[#ff444433] flex items-start gap-3 w-full mt-4">
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

        {/* Нет сети: пока защита выключена, подключаться некуда — Петрович озадачен */}
        {hasNodes && !online && connectionState === 'disconnected' && (
          <div className="w-full mt-4">
            <MascotNote mood="confused" title="Нет сети" text="Проверьте Wi-Fi или мобильный интернет — подключиться пока нельзя" />
          </div>
        )}
      </div>

      {/* Центр: Петрович в медальоне; без серверов — Петрович с подписью и действием */}
      <div className="relative z-10 flex flex-col items-center justify-center flex-1 py-5 w-full max-w-md px-4">
        {hasNodes ? (
          <ConnectMedallion state={connectionState} onToggle={onToggle} hint={bypassHint} error={!!vpnError} />
        ) : (
          <MascotScene mood="thinking" title="Серверов пока нет" text="Добавьте подписку по ссылке — и Петрович возьмётся за дело">
            <button
              onClick={onGoToProfiles}
              className="px-7 py-3 rounded-2xl text-[14px] font-bold text-black bg-[var(--accent)] shadow-[0_0_28px_rgba(var(--accent-rgb),0.35)] active:scale-95 transition-transform"
            >
              Добавить подписку
            </button>
          </MascotScene>
        )}
      </div>

      {/* Низ: карточка сервера со стрелками смены */}
      <div className="relative z-10 w-full max-w-md pb-2">
        {!hasNodes ? null : selectedNode ? (
          <>
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
              aria-label={`Сервер: ${selectedNode.name}. Открыть список серверов`}
              className="flex items-center gap-5 px-4 py-3.5 rounded-2xl glass-card w-full border transition-colors touch-pan-y cursor-grab active:cursor-grabbing"
              style={{ borderColor: withAlpha(buttonColor, '55'), boxShadow: `0 8px 32px -4px ${withAlpha(buttonColor, '18')}` }}
            >
              <Flag flag={selectedNode.flag} name={selectedNode.name} size={34} className="shrink-0 pointer-events-none" />
              <div className="flex-1 text-left min-w-0 pointer-events-none">
                <p className="text-white text-[15px] font-semibold truncate leading-tight">
                  {stripLeadingEmoji(selectedNode.name)}
                </p>
                {/* Вторая строка: описание от провайдера (serverDescription) вместо протокола (hide-settings прячет защиту,
                    протокол остаётся, как в Happ) и цветная таблетка пинга «831 мс». Пинг здесь, а не справа от названия:
                    справа он отнимал у названия почти треть ширины. */}
                <div className="mt-1.5 flex items-center gap-2 min-w-0">
                  {selectedNode.description ? (
                    <p className="text-[12px] font-medium text-gray-300 truncate min-w-0 flex-1">{selectedNode.description}</p>
                  ) : (
                    <span className="inline-block text-[11px] font-bold px-2 py-0.5 rounded-md bg-white/[0.06] border border-white/10 shrink-0"
                      style={{ color: onTheme(protoColor) }}>
                      {selectedNode.protocol.toUpperCase()}
                      {!hideServerDetails && selectedNode.security && selectedNode.security !== 'none' ? ` · ${selectedNode.security.toUpperCase()}` : ''}
                    </span>
                  )}
                  {pingMs !== undefined && (
                    <span className={`shrink-0 ${selectedNode.description ? '' : 'ml-auto'}`}><PingPill ms={pingMs} pending={false} size="sm" /></span>
                  )}
                </div>
              </div>
            </motion.button>

            {/* Стрелки и точки-индикатор позиции в списке */}
            {nodes.length > 1 && (
              <div className="flex justify-between items-center mt-2.5 px-1">
                <button
                  onClick={() => changeServer(-1)}
                  aria-label="Предыдущий сервер"
                  className="w-9 h-9 rounded-xl flex items-center justify-center border border-white/10 bg-white/[0.04] text-gray-300 hover:text-[var(--accent)] hover:border-[var(--accent-a33)] active:scale-90 transition-all"
                >
                  <ChevronLeft size={16} />
                </button>
                {nodes.length <= 9 ? (
                  <div className="flex items-center gap-1.5" aria-hidden>
                    {nodes.map((n, i) => (
                      <span key={n.id} className="h-1.5 rounded-full transition-all duration-300"
                        style={{ width: i === nodeIndex ? 18 : 6, background: i === nodeIndex ? 'var(--accent)' : 'rgba(var(--ink-rgb),0.2)' }} />
                    ))}
                  </div>
                ) : (
                  <span className="text-[12px] text-gray-400 font-medium tabular-nums">{nodeIndex + 1} / {nodes.length}</span>
                )}
                <button
                  onClick={() => changeServer(1)}
                  aria-label="Следующий сервер"
                  className="w-9 h-9 rounded-xl flex items-center justify-center border border-white/10 bg-white/[0.04] text-gray-300 hover:text-[var(--accent)] hover:border-[var(--accent-a33)] active:scale-90 transition-all"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </>
        ) : (
          <button onClick={onGoToServers}
            className="flex items-center justify-center gap-4 px-8 py-4 rounded-[20px] bg-[#12122a] border border-[#2a2a5a] w-full active:scale-[0.98] transition-all"
          >
            <MapPin size={18} className="text-gray-400" />
            <span className="text-gray-300 font-medium tracking-wide">Выберите сервер</span>
          </button>
        )}
      </div>
    </div>
  );
}
