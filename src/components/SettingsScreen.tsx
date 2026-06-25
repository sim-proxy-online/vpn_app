import { motion, AnimatePresence } from 'framer-motion';
import { withAlpha } from '../utils/color';
import {
  ArrowLeft, Wifi, Globe, Smartphone, Info, ChevronDown,
  Route, Lock, Eye, Map, Download,
  Database, Upload, Trash2, Activity, Zap,
  Monitor, Hash, Clock, Layers, FileText, Settings2, Network, Terminal, Cpu, Check, Palette, Link, ChevronRight as ChevronRightIcon, Building2, ShieldOff, Shield
} from 'lucide-react';
import { useState, ReactNode, useEffect } from 'react';
import { useTheme, ACCENT_PRESETS, DEFAULT_ACCENT } from '../ThemeContext';
import { useI18n, LANGUAGES } from '../i18n';
import KillSwitchToggle from './KillSwitchToggle';
import SplitTunnelSettings from './SplitTunnelSettings';
import RoutingRulesSettings from './RoutingRulesSettings';
import BackupRestorePanel from './BackupRestorePanel';
import ScenarioPresetsPanel from './ScenarioPresetsPanel';
import Flag from './Flag';
import { checkForUpdate, RELEASES_PAGE, APP_VERSION, getCurrentVersion } from '../utils/UpdateChecker';
import {
  nativeGetSystemInfo,
  nativeGetCoreVersions, nativeOpenUrl, nativeRequestBatteryExemption, CoreVersion, nativeSetAutoConnect,
  isDesktopPlatform, nativeCheckForUpdatesNow, nativeCheckTorPort, nativeOpenOrbotInstall
} from '../native/bridge';
import { runIspDetection, getStoredDetectionResult, type IspDetectionResult } from '../utils/ispPreset';

interface SettingsScreenProps {
  onBack: () => void;
  isConnected: boolean;
  onShowLogs?: () => void;
}

function usePersist<T>(key: string, init: T): [T, (v: T | ((p: T) => T)) => void] {
  const [val, setVal] = useState<T>(() => { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : init; } catch { return init; } });
  const set = (v: T | ((p: T) => T)) => { setVal(p => { const n = typeof v === 'function' ? (v as (p: T) => T)(p) : v; try { localStorage.setItem(key, JSON.stringify(n)); } catch {} return n; }); };
  return [val, set];
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={`relative w-[44px] h-[26px] rounded-full transition-all duration-300 shrink-0 ${on ? '' : 'bg-[#2a2a5a]'}`}
      style={on ? { background: 'linear-gradient(135deg, var(--accent), #00c4d6)', boxShadow: '0 0 12px var(--accent-a44), 0 2px 8px #00000033' } : {}}>
      <motion.div className="absolute top-[3px] w-5 h-5 rounded-full bg-white shadow-md"
        animate={{ left: on ? 21 : 3 }} transition={{ type: 'spring', damping: 22, stiffness: 400 }} />
    </button>
  );
}

function Row({ icon, iconColor, label, desc, right }: { icon: ReactNode; iconColor?: string; label: string; desc?: string; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5 hover:bg-[#ffffff03] transition-colors">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: withAlpha(iconColor || 'var(--accent)', '10'), color: iconColor || 'var(--accent)' }}>{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-white text-[13px] font-medium leading-tight">{label}</p>
        {desc && <p className="text-gray-500 text-[10px] mt-0.5 leading-tight">{desc}</p>}
      </div>
      {right}
    </div>
  );
}

function NumInput({ value, onChange, w = 'w-16' }: { value: string; onChange: (v: string) => void; w?: string }) {
  return <input type="number" value={value} onChange={e => onChange(e.target.value)}
    className={`${w} text-xs text-right text-gray-300 bg-[#1a1a3a] rounded-lg px-2 py-1.5 border border-[#2a2a5a44] focus:border-[var(--accent-a44)] focus:outline-none font-mono`} />;
}

function TextInput({ value, onChange, placeholder, w = 'w-32' }: { value: string; onChange: (v: string) => void; placeholder?: string; w?: string }) {
  return <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
    className={`${w} text-xs text-right text-gray-300 bg-[#1a1a3a] rounded-lg px-2 py-1.5 border border-[#2a2a5a44] focus:border-[var(--accent-a44)] focus:outline-none font-mono placeholder-gray-700`} />;
}

function SelectInput({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[] }) {
  return <select value={value} onChange={e => onChange(e.target.value)}
    className="text-xs bg-[#1a1a3a] text-gray-300 rounded-lg px-2 py-1.5 border border-[#2a2a5a44] focus:border-[var(--accent-a44)] focus:outline-none font-mono appearance-none pr-6"
    style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center' }}>
    {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
  </select>;
}

const DPI_PRESETS = [
  {
    id: 'aggressive',
    icon: '⚡',
    label: 'МТС · Мегафон · Теле2',
    desc: 'Билайн · Yota · Тинькофф · ТСПУ',
    color: '#ffe600',
    frag: true, packets: 'tlshello', length: '1-5', interval: '1-3',
    noises: false,
  },
  {
    id: 'standard',
    icon: '🛡',
    label: 'Ростелеком · Дом.ру',
    desc: 'ТТК · МГТС · Региональные ISP',
    color: '#00aaff',
    frag: true, packets: 'tlshello', length: '10-20', interval: '1-2',
    noises: false,
  },
  {
    id: 'youtube',
    icon: '📺',
    label: 'YouTube / Instagram',
    desc: 'Замедление видео',
    color: '#ff6b35',
    frag: true, packets: 'tlshello', length: '10-20', interval: '1-2',
    noises: false,
  },
  {
    id: 'max',
    icon: '🔥',
    label: 'Максимум',
    desc: 'Фрагменты + шумы',
    color: '#ff00aa',
    frag: true, packets: 'tlshello', length: '1-5', interval: '1-3',
    noises: true,
  },
] as const;

const ROUTES = [
  { id: 'global', n: 'Глобальный прокси', d: 'Весь трафик через VPN', c: 'var(--accent)', i: <Globe size={15} />, r: ['MATCH → Proxy'] },
  { id: 'bypass-local', n: 'Обход локальных', d: 'LAN напрямую', c: '#00ff88', i: <Wifi size={15} />, r: ['PRIVATE → Direct', 'MATCH → Proxy'] },
  { id: 'bypass-ru', n: 'Обход RU', d: 'RU сайты напрямую', c: '#b000ff', i: <Map size={15} />, r: ['GEOIP RU → Direct', 'MATCH → Proxy'] },
  { id: 'only-blocked', n: 'Только заблокированные', d: 'VPN для заблокированных', c: '#ffe600', i: <Lock size={15} />, r: ['Blocked → Proxy', 'MATCH → Direct'] },
];

// ── Навигационная строка-раздел ──────────────────────────────────────────────
function NavRow({
  icon, iconColor, title, subtitle, badge, badgeColor, onClick,
}: {
  icon: ReactNode; iconColor: string; title: string; subtitle: string;
  badge?: string; badgeColor?: string; onClick: () => void;
}) {
  const bc = badgeColor || '#00ff88';
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-2xl glass-card border border-[#2a2a5a22] hover:border-[#2a2a5a44] hover:bg-[#12122a88] transition-all duration-200 active:scale-[0.985]">
      <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
        style={{
          background: `linear-gradient(135deg, ${withAlpha(iconColor, '25')}, ${withAlpha(iconColor, '10')})`,
          border: `1px solid ${withAlpha(iconColor, '35')}`,
          color: iconColor,
          boxShadow: `0 2px 12px ${withAlpha(iconColor, '18')}`,
        }}>
        {icon}
      </div>
      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-2">
          <p className="text-white text-[14px] font-semibold leading-tight">{title}</p>
          {badge && (
            <span className="flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full"
              style={{ background: withAlpha(bc, '18'), color: bc, border: `1px solid ${withAlpha(bc, '30')}` }}>
              <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: bc }} />
              {badge}
            </span>
          )}
        </div>
        <p className="text-gray-500 text-[11px] mt-0.5 leading-tight">{subtitle}</p>
      </div>
      <ChevronRightIcon size={16} className="text-gray-600 shrink-0" />
    </button>
  );
}

// ── Обёртка сабскрина ────────────────────────────────────────────────────────
function SubScreen({ title, icon, iconColor, onBack, children }: {
  title: string; icon: ReactNode; iconColor: string; onBack: () => void; children: ReactNode;
}) {
  return (
    <motion.div className="absolute inset-0 flex flex-col bg-[#07071a] z-10"
      initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
      transition={{ type: 'spring', damping: 28, stiffness: 300 }}>
      {/* Sub-header */}
      <div className="flex items-center gap-3 px-4 pt-12 pb-4 shrink-0 border-b border-white/5">
        <button onClick={onBack}
          className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-[var(--accent)] active:scale-90 transition-all">
          <ArrowLeft size={20} />
        </button>
        <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: withAlpha(iconColor, '20'), color: iconColor }}>
          {icon}
        </div>
        <h2 className="font-orbitron text-[18px] font-bold text-white tracking-wide">{title}</h2>
      </div>
      <div className="flex-1 overflow-y-auto pb-20 divide-y divide-[#1a1a3a66]">
        {children}
      </div>
    </motion.div>
  );
}

export default function SettingsScreen({ onBack, isConnected, onShowLogs }: SettingsScreenProps) {
  const { accent, setAccent, resetAccent } = useTheme();
  const { lang, setLang } = useI18n();
  const [sysInfo, setSysInfo] = useState<any>(null);
  const [coreVersions, setCoreVersions] = useState<CoreVersion | null>(null);
  const [appVersion, setAppVersion] = useState(APP_VERSION);
  const [schemesOpen, setSchemesOpen] = useState(false);
  const [page, setPage] = useState<string | null>(null);

  // Перехватываем androidback / жест назад когда открыт сабскрин.
  // App.tsx проверяет __simBackInterceptor перед своей обработкой.
  useEffect(() => {
    if (page !== null) {
      (window as any).__simBackInterceptor = () => { setPage(null); return true; };
    } else {
      delete (window as any).__simBackInterceptor;
    }
    return () => { delete (window as any).__simBackInterceptor; };
  }, [page]);

  useEffect(() => {
    nativeGetSystemInfo().then(setSysInfo);
    nativeGetCoreVersions().then(setCoreVersions);
    getCurrentVersion().then(setAppVersion);
  }, []);

  // Обновляем DPI-состояние когда ISP-детект применил пресет
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as IspDetectionResult;
      setIspDetection(detail);
      const get = (k: string, fb: unknown) => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : fb; } catch { return fb; } };
      setFragEnable(get('sim-frag-enable', true) as boolean);
      setFragPackets(get('sim-frag-packets', 'tlshello') as string);
      setFragLength(get('sim-frag-length', '10-20') as string);
      setFragInterval(get('sim-frag-interval', '1-5') as string);
      setNoisesEnable(get('sim-noises-enable', false) as boolean);
    };
    window.addEventListener('isp-preset-applied', handler);
    return () => window.removeEventListener('isp-preset-applied', handler);
  }, []);

  // Core settings
  const [killSwitch, setKillSwitch] = usePersist('sim-killswitch', true);
  const [autoConnect, setAutoConnect] = usePersist('sim-autoconnect', false);
  const [autoLeakTest, setAutoLeakTest] = usePersist('sim-auto-leaktest', true);
  const [autoReconnect, setAutoReconnect] = usePersist('sim-autoreconnect', true);
  const [autoUpdateCheck, setAutoUpdateCheck] = usePersist('sim-autoupdate-check', true);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'latest' | 'available'>('idle');

  const handleCheckUpdate = async () => {
    setUpdateStatus('checking');
    if (isDesktopPlatform()) {
      try {
        const r = await nativeCheckForUpdatesNow();
        setUpdateStatus(r && (r.status === 'downloading' || r.status === 'downloaded') ? 'available' : 'latest');
      } catch { setUpdateStatus('idle'); }
      setTimeout(() => setUpdateStatus('idle'), 3000);
      return;
    }
    try {
      const u = await checkForUpdate();
      if (u.hasUpdate) {
        setUpdateStatus('available');
        window.dispatchEvent(new CustomEvent('sim-show-update', { detail: u }));
      } else {
        setUpdateStatus('latest');
        setTimeout(() => setUpdateStatus('idle'), 3000);
      }
    } catch {
      setUpdateStatus('idle');
      nativeOpenUrl(RELEASES_PAGE);
    }
  };

  // Connection & Traffic
  const [splitTunnel, setSplitTunnel] = usePersist('sim-splittunnel', false);
  const [ruDirect, setRuDirect] = usePersist('sim-ru-direct', false);
  const [adBlock, setAdBlock] = usePersist('sim-ad-block', false);
  const [torMode, setTorMode] = usePersist<'off' | 'onion' | 'all'>('sim-tor-mode', 'off');
  const [torAvailable, setTorAvailable] = useState<boolean | null>(null);
  const [routing, setRouting] = usePersist('sim-routing', 'global');

  // ISP auto-preset
  const [ispAutoPreset, setIspAutoPreset] = usePersist('sim-isp-auto-preset', true);
  const [ispDetection, setIspDetection] = useState<IspDetectionResult | null>(getStoredDetectionResult);
  const [ispDetecting, setIspDetecting] = useState(false);

  const triggerIspDetection = async () => {
    setIspDetecting(true);
    try { const r = await runIspDetection(true); setIspDetection(r); } catch { setIspDetection(null); }
    setIspDetecting(false);
  };

  // При открытии экрана: если авто-пресет включён и нет кешированного результата — запускаем
  useEffect(() => {
    if (ispAutoPreset && !getStoredDetectionResult()) triggerIspDetection();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // DPI Bypass
  const [fragEnable, setFragEnable] = usePersist('sim-frag-enable', true);
  const [fragPackets, setFragPackets] = usePersist('sim-frag-packets', 'tlshello');
  const [fragLength, setFragLength] = usePersist('sim-frag-length', '10-20');
  const [fragInterval, setFragInterval] = usePersist('sim-frag-interval', '1-5');
  const [noisesEnable, setNoisesEnable] = usePersist('sim-noises-enable', false);
  const [noisesType, setNoisesType] = usePersist('sim-noises-type', 'rand');
  const [noisesDelay, setNoisesDelay] = usePersist('sim-noises-delay', '50');
  const [noisesRand, setNoisesRand] = usePersist('sim-noises-rand', '1-1024');
  const [uTlsFingerprint, setUTlsFingerprint] = usePersist('sim-utls-fingerprint', 'chrome');
  // Advanced / Core
  const [socksPort, setSocksPort] = usePersist('sim-socks-port', '10808');
  const [dnsAddress, setDnsAddress] = usePersist('sim-dns-address', '1.1.1.1');
  const [dnsCache, setDnsCache] = usePersist('sim-dns-cache', true);
  const [leakProtection, setLeakProtection] = usePersist('sim-leak-protection', true);
  const [mtu, setMtu] = usePersist('sim-mtu', '1400');
  const [sniffing, setSniffing] = usePersist('sim-sniffing', true);
  const [idleTimeout, setIdleTimeout] = usePersist('sim-idle-timeout', '300');
  const [logsMode, setLogsMode] = usePersist('sim-logs-mode', 'warning');

  // ── Контент сабскринов ─────────────────────────────────────────────────────

  const BasicContent = (
    <>
      <div className="px-4 py-3">
        <KillSwitchToggle enabled={killSwitch} onToggle={setKillSwitch} />
      </div>
      <Row icon={<Wifi size={15} />} iconColor="#00ff88" label="Авто-подключение" desc="Подключаться при запуске приложения" right={<Toggle on={autoConnect} onToggle={() => { const next = !autoConnect; setAutoConnect(next); nativeSetAutoConnect(next).catch(console.error); }} />} />
      <Row icon={<Eye size={15} />} iconColor="#ff00aa" label="Авто-проверка утечек" desc="Тест IP/DNS после подключения + предупреждение" right={<Toggle on={autoLeakTest} onToggle={() => setAutoLeakTest(!autoLeakTest)} />} />
      <Row icon={<Network size={15} />} iconColor="#2d7dff" label="Авто-реконнект" desc="Переподключаться при смене сети (Wi-Fi ↔ моб.)" right={<Toggle on={autoReconnect} onToggle={() => setAutoReconnect(!autoReconnect)} />} />
    </>
  );

  const DesignContent = (
    <>
      <div className="px-4 py-3.5">
        <p className="text-white text-[13px] font-medium mb-2.5">Язык · Language</p>
        <div className="flex gap-2">
          {LANGUAGES.map(l => (
            <button key={l.code} onClick={() => setLang(l.code)}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border text-[12px] font-bold transition-all active:scale-95 ${
                lang === l.code
                  ? 'bg-[var(--accent-a12)] border-[var(--accent-a44)] text-[var(--accent)]'
                  : 'bg-[#12122a] border-[#2a2a5a44] text-gray-400'
              }`}>
              <Flag flag={l.flag} size={16} /> {l.label}
            </button>
          ))}
        </div>
      </div>
      <div className="px-4 py-4 border-t border-[#1a1a3a66]">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-white text-[13px] font-medium">Цвет акцента</p>
            <p className="text-gray-500 text-[10px] mt-0.5">Перекрашивает весь интерфейс</p>
          </div>
          {accent.toLowerCase() !== DEFAULT_ACCENT && (
            <button onClick={resetAccent} className="text-[9px] font-black uppercase tracking-widest text-gray-500 hover:text-white transition-colors px-2 py-1 rounded-lg border border-white/10">
              Сброс
            </button>
          )}
        </div>
        <div className="grid grid-cols-8 gap-2 mb-3">
          {ACCENT_PRESETS.map(p => {
            const active = accent.toLowerCase() === p.value.toLowerCase();
            return (
              <button key={p.value} onClick={() => setAccent(p.value)} title={p.name}
                className="relative aspect-square rounded-xl transition-all active:scale-90"
                style={{
                  backgroundColor: p.value,
                  boxShadow: active ? `0 0 14px ${withAlpha(p.value, 'aa')}` : `0 0 6px ${withAlpha(p.value, '55')}`,
                  outline: active ? '2px solid #ffffff' : '2px solid transparent',
                  outlineOffset: '2px',
                }}>
                {active && <Check size={14} className="absolute inset-0 m-auto text-black/80" strokeWidth={3} />}
              </button>
            );
          })}
        </div>
        <label className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-[#0a0a1a55] border border-white/10 cursor-pointer">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg border border-white/15" style={{ backgroundColor: accent, boxShadow: `0 0 10px ${withAlpha(accent, '66')}` }} />
            <div>
              <p className="text-[12px] text-white font-medium">Свой цвет</p>
              <p className="text-[10px] text-gray-500 font-mono uppercase">{accent}</p>
            </div>
          </div>
          <span className="text-[9px] font-black uppercase tracking-widest text-[var(--accent)]">Выбрать</span>
          <input type="color" value={accent} onChange={e => setAccent(e.target.value)} className="sr-only" />
        </label>
      </div>
    </>
  );

  const TrafficContent = (
    <>
      <div className="px-4 py-3 space-y-4">
        <div className="bg-[#1a1a3a33] rounded-xl border border-[#2a2a5a22] overflow-hidden">
          <Row icon={<Building2 size={15} />} iconColor="#ff6a00" label="Банки и госпорталы напрямую" desc="Госуслуги, Сбер, Тинькофф, ВТБ, ФНС и др. без VPN" right={<Toggle on={ruDirect} onToggle={() => setRuDirect(!ruDirect)} />} />
          <Row icon={<ShieldOff size={15} />} iconColor="#cc00ff" label="Блокировка рекламы" desc="Рекламные и трекерные домены → заблокировать" right={<Toggle on={adBlock} onToggle={() => setAdBlock(!adBlock)} />} />
          <Row
            icon={<span style={{ fontSize: 14 }}>🧅</span>}
            iconColor="#7f5af0"
            label="Tor over VPN"
            desc={torMode === 'off' ? 'Маршрутизация через сеть Tor' : torMode === 'onion' ? 'Только .onion сайты через Tor' : 'Весь трафик через Tor'}
            right={
              <select
                value={torMode}
                onChange={async e => {
                  const m = e.target.value as 'off' | 'onion' | 'all';
                  setTorMode(m);
                  if (m !== 'off') {
                    const res = await nativeCheckTorPort();
                    setTorAvailable(res.available);
                  } else {
                    setTorAvailable(null);
                  }
                }}
                className="bg-transparent text-[11px] text-gray-300 outline-none cursor-pointer"
                style={{ WebkitAppearance: 'none' }}
              >
                <option value="off" className="bg-[#111]">Выкл</option>
                <option value="onion" className="bg-[#111]">.onion</option>
                <option value="all" className="bg-[#111]">Все</option>
              </select>
            }
          />
          <AnimatePresence>
            {torMode !== 'off' && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="mx-2 mb-2 p-3 rounded-xl" style={{ background: torAvailable === false ? '#2a110a' : '#0a1a0a', border: `1px solid ${torAvailable === false ? '#5a1a0a' : '#0a3a1a'}` }}>
                  {torAvailable === null ? (
                    <p className="text-[11px] text-gray-400">Требуется приложение Orbot (Tor для Android)</p>
                  ) : torAvailable ? (
                    <p className="text-[11px] text-green-400">✓ Orbot запущен — Tor активен</p>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-[11px] text-orange-400">Orbot не обнаружен на порту 9050</p>
                      <p className="text-[10px] text-gray-500">Установите и запустите Orbot, затем включите Tor в его настройках</p>
                      <button
                        onClick={() => nativeOpenOrbotInstall()}
                        className="text-[11px] font-semibold px-3 py-1.5 rounded-lg"
                        style={{ background: '#7f5af0', color: '#fff' }}
                      >
                        Установить Orbot
                      </button>
                      <button
                        onClick={async () => { const r = await nativeCheckTorPort(); setTorAvailable(r.available); }}
                        className="ml-2 text-[11px] text-gray-400 underline"
                      >
                        Проверить снова
                      </button>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <Row icon={<Smartphone size={15} />} iconColor="#b000ff" label="Раздельное туннелирование" desc="Приложения, работающие через VPN" right={<Toggle on={splitTunnel} onToggle={() => setSplitTunnel(!splitTunnel)} />} />
          <AnimatePresence>
            {splitTunnel && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="px-2 pb-3 overflow-hidden">
                <SplitTunnelSettings />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="space-y-2">
          <p className="px-2 text-[10px] font-bold text-gray-500 uppercase tracking-widest">Стратегия маршрутизации</p>
          <div className="grid grid-cols-1 gap-2">
            {ROUTES.map(r => (
              <button key={r.id} onClick={() => setRouting(r.id)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all text-left ${routing === r.id ? 'bg-[var(--accent-a11)] border-[var(--accent-a33)]' : 'bg-[#0a0a1a55] border-transparent hover:border-[#2a2a5a44]'}`}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: withAlpha(r.c, '15'), color: r.c }}>{r.i}</div>
                <div className="flex-1 min-w-0">
                  <p className={`text-[12px] font-semibold ${routing === r.id ? 'text-white' : 'text-gray-400'}`}>{r.n}</p>
                  <p className="text-gray-600 text-[9px] mt-0.5 leading-tight">{r.d}</p>
                </div>
                {routing === r.id && <Check size={14} className="text-[var(--accent)] shrink-0" />}
              </button>
            ))}
          </div>
        </div>
        <div className="border-t border-[#2a2a5a22] pt-2">
          <RoutingRulesSettings />
        </div>
      </div>
    </>
  );

  const EngineContent = (
    <>
      <button onClick={() => (window as any).navigateToDns?.()}
        className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-[#ffffff03] transition-colors">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-[var(--accent-a10)] text-[var(--accent)]">
            <Globe size={15} />
          </div>
          <div className="text-left">
            <p className="text-white text-[13px] font-medium leading-tight">Настройки DNS</p>
            <p className="text-gray-500 text-[10px] mt-0.5 leading-tight">Провайдеры, Fake DNS, Стратегия разрешения</p>
          </div>
        </div>
        <ChevronRightIcon size={14} className="text-gray-600" />
      </button>
      <div className="bg-[#1a1a3a22]">
        <Row icon={<Hash size={15} />} label="SOCKS Порт" desc="Локальный порт ядра Xray" right={<NumInput value={socksPort} onChange={setSocksPort} />} />
        <Row icon={<Globe size={15} />} label="DNS Resolver" desc="Внешний DNS-сервер" right={<TextInput value={dnsAddress} onChange={setDnsAddress} placeholder="1.1.1.1" w="w-44" />} />
        <Row icon={<Database size={15} />} label="DNS-кэш" desc="Повторные запросы к известным доменам — без обращения к серверу" right={<Toggle on={dnsCache} onToggle={() => setDnsCache(!dnsCache)} />} />
        <Row icon={<Shield size={15} />} iconColor="#00bfff" label="Защита от утечек" desc="Блокирует DNS-утечки и IPv6-трафик в обход туннеля" right={<Toggle on={leakProtection} onToggle={() => setLeakProtection(!leakProtection)} />} />
      </div>
      <Row icon={<Smartphone size={15} />} label="MTU" desc="Максимальный размер пакета (576–1500)" right={<NumInput value={mtu} onChange={setMtu} />} />
      <Row icon={<Eye size={15} />} label="Sniffing" desc="Определение типа трафика (домен из TLS/HTTP)" right={<Toggle on={sniffing} onToggle={() => setSniffing(!sniffing)} />} />
      <Row icon={<Clock size={15} />} label="Idle Timeout" desc="Таймаут простоя соединения (сек)" right={<NumInput value={idleTimeout} onChange={setIdleTimeout} />} />
    </>
  );

  const activePresetId = (() => {
    if (!fragEnable && !noisesEnable) return 'off';
    return DPI_PRESETS.find(p =>
      p.frag === fragEnable &&
      p.packets === fragPackets &&
      p.length === fragLength &&
      p.interval === fragInterval &&
      p.noises === noisesEnable
    )?.id ?? null;
  })();

  const applyPreset = (p: typeof DPI_PRESETS[number]) => {
    setFragEnable(p.frag);
    setFragPackets(p.packets);
    setFragLength(p.length);
    setFragInterval(p.interval);
    setNoisesEnable(p.noises);
    if (p.noises) { setNoisesType('rand'); setNoisesDelay('50'); setNoisesRand('1-1024'); }
  };

  const DpiContent = (
    <>
      <ScenarioPresetsPanel isConnected={isConnected} />
      <div className="px-4 py-3 border-b border-[#1a1a3a66]">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: 'rgba(0,196,214,0.10)', color: '#00c4d6' }}>
              <Network size={15} />
            </div>
            <div>
              <p className="text-white text-[13px] font-medium leading-tight">Авто-пресет по сети</p>
              <p className="text-gray-500 text-[10px] mt-0.5 leading-tight">
                Определяет оператора по IP и применяет подходящий пресет
              </p>
            </div>
          </div>
          <Toggle on={ispAutoPreset} onToggle={() => {
            const next = !ispAutoPreset;
            setIspAutoPreset(next);
            if (next) triggerIspDetection();
          }} />
        </div>

        {ispAutoPreset && (
          <div className="flex items-center gap-2 mt-2 px-1">
            {ispDetecting ? (
              <p className="text-[11px] text-gray-400 flex-1">Определяем оператора...</p>
            ) : ispDetection ? (
              <>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] font-bold text-white">{ispDetection.ispName}</span>
                    <span className="text-gray-600 text-[10px]">→</span>
                    {ispDetection.presetId ? (
                      <span className="text-[10px] font-bold" style={{ color: '#00c4d6' }}>{ispDetection.presetLabel}</span>
                    ) : (
                      <span className="text-[10px] text-gray-500">не в базе</span>
                    )}
                  </div>
                  {ispDetection.ispRaw && (
                    <p className="text-[9px] text-gray-600 mt-0.5 font-mono truncate">{ispDetection.ispRaw}</p>
                  )}
                </div>
                <button onClick={triggerIspDetection}
                  className="shrink-0 text-[9px] font-bold px-2 py-1 rounded-lg active:scale-90 transition-all"
                  style={{ background: 'rgba(0,196,214,0.12)', color: '#00c4d6' }}>
                  ↺
                </button>
              </>
            ) : (
              <>
                <p className="text-[11px] text-gray-500 flex-1">Оператор не определён</p>
                <button onClick={triggerIspDetection}
                  className="text-[9px] font-bold px-2 py-1 rounded-lg active:scale-90 transition-all"
                  style={{ background: 'rgba(0,196,214,0.12)', color: '#00c4d6' }}>
                  Определить
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="px-4 pt-3 pb-2 space-y-2.5">
        <p className="text-[10px] text-gray-600 uppercase tracking-widest font-semibold px-0.5">Пресеты DPI</p>
        <div className="grid grid-cols-2 gap-2">
          {DPI_PRESETS.map(p => {
            const active = activePresetId === p.id;
            return (
              <button key={p.id} onClick={() => applyPreset(p)}
                className="relative flex flex-col gap-1 px-3 py-2.5 rounded-2xl border transition-all duration-200 active:scale-[0.97] text-left"
                style={{
                  background: active ? `linear-gradient(135deg, ${p.color}20, ${p.color}0a)` : 'rgba(255,255,255,0.02)',
                  borderColor: active ? `${p.color}55` : 'rgba(255,255,255,0.07)',
                  boxShadow: active ? `0 0 14px ${p.color}22` : 'none',
                }}>
                {ispAutoPreset && ispDetection?.presetId === p.id && (
                  <span className="absolute top-1.5 right-2 text-[8px] font-black px-1.5 py-0.5 rounded-full"
                    style={{ background: `${p.color}25`, color: p.color }}>авто</span>
                )}
                {active && !ispDetection?.presetId && (
                  <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full"
                    style={{ background: p.color, boxShadow: `0 0 5px ${p.color}` }} />
                )}
                <span className="text-base leading-none">{p.icon}</span>
                <span className="text-[12px] font-bold text-white leading-tight">{p.label}</span>
                <span className="text-[10px] text-gray-500 leading-tight">{p.desc}</span>
                <span className="text-[9px] font-mono mt-0.5 leading-tight" style={{ color: `${p.color}bb` }}>
                  {p.packets} · {p.length} · {p.interval}ms{p.noises ? ' · noise' : ''}
                </span>
              </button>
            );
          })}
        </div>
        <button
          onClick={() => { setFragEnable(false); setNoisesEnable(false); }}
          className="w-full py-2 rounded-xl border transition-all duration-200 text-[10px] font-bold uppercase tracking-widest"
          style={{
            background: activePresetId === 'off' ? 'rgba(255,255,255,0.05)' : 'transparent',
            borderColor: activePresetId === 'off' ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.07)',
            color: activePresetId === 'off' ? '#fff' : '#555',
          }}>
          ✕ Отключить всё
        </button>
      </div>
      <Row icon={<Layers size={15} />} iconColor="#ff6b35" label="Фрагментация" desc="Обход белых списков РФ для всех протоколов" right={<Toggle on={fragEnable} onToggle={() => setFragEnable(!fragEnable)} />} />
      {fragEnable && (
        <div className="px-4 py-3 bg-[#0a0a1a55] space-y-3">
          <Row icon={<FileText size={14} />} label="Packets" right={<TextInput value={fragPackets} onChange={setFragPackets} placeholder="tlshello" w="w-24" />} />
          <Row icon={<Hash size={14} />} label="Length" right={<TextInput value={fragLength} onChange={setFragLength} placeholder="50-100" w="w-20" />} />
          <Row icon={<Clock size={14} />} label="Interval (мс)" right={<TextInput value={fragInterval} onChange={setFragInterval} placeholder="10-20" w="w-20" />} />
        </div>
      )}
      <Row icon={<Activity size={15} />} iconColor="#ff00aa" label="Шумы (Noises)" desc="Добавление фейкового трафика" right={<Toggle on={noisesEnable} onToggle={() => setNoisesEnable(!noisesEnable)} />} />
      {noisesEnable && (
        <div className="px-4 py-3 bg-[#0a0a1a55] space-y-3">
          <Row icon={<Settings2 size={14} />} label="Тип" right={<SelectInput value={noisesType} onChange={setNoisesType} options={[{v:'rand',l:'Random'},{v:'hex',l:'Hex'},{v:'base64',l:'Base64'}]} />} />
          <Row icon={<Clock size={14} />} label="Задержка (мс)" right={<NumInput value={noisesDelay} onChange={setNoisesDelay} />} />
          <Row icon={<Hash size={14} />} label="Диапазон" right={<TextInput value={noisesRand} onChange={setNoisesRand} placeholder="1-1024" w="w-20" />} />
        </div>
      )}
      <Row
        icon={<Shield size={15} />} iconColor="#00cfff"
        label="uTLS Fingerprint"
        desc="TLS-отпечаток браузера для маскировки трафика"
        right={
          <SelectInput
            value={uTlsFingerprint}
            onChange={setUTlsFingerprint}
            options={[
              {v:'chrome',  l:'Chrome'},
              {v:'firefox', l:'Firefox'},
              {v:'safari',  l:'Safari'},
              {v:'ios',     l:'iOS'},
              {v:'android', l:'Android'},
              {v:'edge',    l:'Edge'},
              {v:'random',  l:'Random'},
              {v:'none',    l:'None'},
            ]}
          />
        }
      />
    </>
  );

  const SystemContent = (
    <>
      <Row icon={<FileText size={15} />} label="Уровень логов" right={<SelectInput value={logsMode} onChange={setLogsMode} options={[{v:'none',l:'None'},{v:'error',l:'Error'},{v:'warning',l:'Warning'},{v:'info',l:'Info'},{v:'debug',l:'Debug'}]} />} />
      <BackupRestorePanel />
      <button onClick={() => {
        const data: Record<string, string | null> = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k?.startsWith('sim-')) data[k] = localStorage.getItem(k);
        }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `sim-proxy-backup-${new Date().toISOString().slice(0,10)}.json`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      }} className="w-full text-left">
        <Row icon={<Download size={15} />} iconColor="var(--accent)" label="Экспорт настроек" desc="Сохранить в JSON файл" />
      </button>
      <button onClick={() => {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
        inp.onchange = e => {
          const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
          const r = new FileReader();
          r.onload = ev => { try { const d = JSON.parse(ev.target?.result as string); Object.entries(d).forEach(([k, v]) => { if (k.startsWith('sim-')) localStorage.setItem(k, v as string); }); alert('Настройки импортированы'); window.location.reload(); } catch { alert('Ошибка импорта'); } };
          r.readAsText(f);
        };
        inp.click();
      }} className="w-full text-left">
        <Row icon={<Upload size={15} />} iconColor="#00ff88" label="Импорт настроек" desc="Восстановить из файла" />
      </button>
      <button onClick={() => { if (confirm('Удалить ВСЕ данные?')) { Object.keys(localStorage).filter(k => k.startsWith('sim-')).forEach(k => localStorage.removeItem(k)); window.location.reload(); } }} className="w-full text-left">
        <Row icon={<Trash2 size={15} />} iconColor="#ff0066" label="Полный сброс" desc="Очистить все профили и настройки" />
      </button>
    </>
  );

  const InfoContent = (
    <>
      {onShowLogs && (
        <button onClick={onShowLogs} className="w-full text-left">
          <Row icon={<FileText size={15} />} iconColor="#94a3b8" label="Логи / Диагностика" desc="Журнал ядра и последние ошибки" right={<ChevronRightIcon size={14} className="text-gray-600" />} />
        </button>
      )}
      <Row icon={<Cpu size={15} />} label="Версия" right={<span className="text-[11px] text-[var(--accent)] font-mono font-bold">{appVersion}</span>} />
      <button onClick={handleCheckUpdate} disabled={updateStatus === 'checking'} className="w-full text-left">
        <Row icon={<Download size={15} />} iconColor="var(--accent)" label="Проверить обновления"
          desc={updateStatus === 'checking' ? 'Проверка…' : updateStatus === 'latest' ? 'У вас последняя версия' : updateStatus === 'available' ? 'Доступно обновление' : 'GitHub Releases'} />
      </button>
      <Row icon={<Activity size={15} />} iconColor="#00ff88" label="Авто-проверка обновлений" desc="Раз в сутки при запуске" right={<Toggle on={autoUpdateCheck} onToggle={() => setAutoUpdateCheck(!autoUpdateCheck)} />} />
      <div className="bg-[#ffffff03]">
        <button onClick={() => setSchemesOpen(o => !o)} className="w-full flex items-center gap-3 px-4 py-3 active:bg-white/5 transition-colors">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: withAlpha('var(--accent)', '15'), color: 'var(--accent)' }}>
            <Link size={15} />
          </div>
          <p className="text-white text-[13px] font-semibold flex-1 text-left">Схемы url-адресов</p>
          <ChevronDown size={16} className={`text-gray-500 transition-transform ${schemesOpen ? 'rotate-180' : ''}`} />
        </button>
        <AnimatePresence initial={false}>
          {schemesOpen && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
              <div className="px-4 pb-3">
                <p className="ml-11 text-[10px] text-gray-500 mb-1.5 font-medium">Открываются из браузера (<span className="text-[var(--accent)] font-mono">sim://</span> и <span className="text-[var(--accent)] font-mono">happ://</span>):</p>
                <ul className="space-y-1.5 ml-11 text-[10px] text-gray-500 list-disc font-medium leading-relaxed">
                  <li><span className="text-[var(--accent)] font-mono">sim://import/&lt;ссылка&gt;</span> — подписка или сервер</li>
                  <li><span className="text-[var(--accent)] font-mono">sim://add/&lt;url&gt;</span>, <span className="text-[var(--accent)] font-mono">sim://subscribe/&lt;url&gt;</span></li>
                  <li><span className="text-[var(--accent)] font-mono">sim://routing/add/&lt;base64&gt;</span> — профиль маршрутизации</li>
                </ul>
                <p className="ml-11 mt-2.5 mb-1.5 text-[10px] text-gray-500 font-medium">Конфиги из буфера:</p>
                <ul className="space-y-1.5 ml-11 text-[10px] text-gray-500 list-disc font-medium leading-relaxed">
                  <li><span className="text-gray-300 font-mono">vless:// · vmess:// · trojan:// · ss://</span></li>
                  <li><span className="text-gray-300 font-mono">hysteria2:// · tuic:// · wireguard://</span></li>
                </ul>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {coreVersions && <Row icon={<Terminal size={15} />} label="Ядро Xray" right={<span className="text-[11px] text-[#00ff88] font-mono">{coreVersions.xray}</span>} />}
      {sysInfo && <>
        <Row icon={<Smartphone size={15} />} label="Устройство" right={<span className="text-[11px] text-gray-400">{sysInfo.model} ({sysInfo.manufacturer})</span>} />
        <Row icon={<Monitor size={15} />} label="Android" right={<span className="text-[11px] text-gray-400">v{sysInfo.osVersion} (API {sysInfo.apiLevel})</span>} />
      </>}
      <Row icon={<Globe size={15} />} label="Сайт" right={
        <button onClick={() => nativeOpenUrl('https://sim-proxy.online')} className="text-[11px] text-[var(--accent)] hover:underline cursor-pointer">sim-proxy.online</button>
      } />
      <div className="px-4 pb-4 pt-3">
        <button onClick={() => nativeRequestBatteryExemption()}
          className="w-full py-3 rounded-xl bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-[var(--accent)] text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all">
          Разрешить работу в фоне
        </button>
        <p className="text-[9px] text-gray-600 mt-2 text-center uppercase font-bold tracking-tighter leading-tight">Отключите оптимизацию батареи для стабильной работы VPN в фоне</p>
      </div>
    </>
  );

  const SECTIONS = [
    { id: 'basic',   title: 'Основные',            subtitle: 'Автозапуск, уведомления, прокси',   icon: <Settings2 size={20} />, iconColor: 'var(--accent)',  content: BasicContent },
    { id: 'design',  title: 'Оформление',           subtitle: 'Тема, язык, акцентные цвета',       icon: <Palette size={20} />,   iconColor: '#a855f7',       content: DesignContent },
    { id: 'traffic', title: 'Маршрутизация',          subtitle: 'Куда направлять трафик: VPN, direct, блок', icon: <Route size={20} />, iconColor: '#00ff88', content: TrafficContent, badge: splitTunnel ? 'Вкл.' : undefined, badgeColor: '#00ff88' },
    { id: 'engine',  title: 'Сетевой движок',        subtitle: 'DNS · Порт · Параметры ядра',       icon: <Terminal size={20} />,  iconColor: '#38bdf8',       content: EngineContent },
    { id: 'dpi',     title: 'Обход блокировок',      subtitle: 'Сценарии · Fragment · Noises · DPI', icon: <Zap size={20} />,       iconColor: '#ff6b35',       content: DpiContent, badge: fragEnable ? 'Вкл.' : undefined, badgeColor: '#ff6b35' },
    { id: 'system',  title: 'Система и Данные',     subtitle: 'Кэш, бэкап, логи, сброс',          icon: <Database size={20} />,  iconColor: '#34d399',       content: SystemContent },
    { id: 'info',    title: 'Инфо',                 subtitle: 'Версия, поддержка, лицензия',       icon: <Info size={20} />,      iconColor: '#94a3b8',       content: InfoContent },
  ];

  const activeSection = page ? SECTIONS.find(s => s.id === page) : null;

  return (
    <motion.div className="flex flex-col h-full w-full overflow-hidden relative" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>

      {/* ── Главный список ──────────────────────────────────────────────────── */}
      <div className="flex flex-col h-full w-full">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 pt-12 pb-4 shrink-0">
          <button onClick={onBack} className="lg:hidden w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-[var(--accent)] active:scale-90 transition-all">
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1">
            <h2 className="font-orbitron text-[18px] font-bold text-white tracking-wide">Настройки</h2>
          </div>
        </div>

        {/* Status bar */}
        <div className="flex gap-2 px-4 pb-3 shrink-0">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#0d1a0d] border border-[#00ff8822]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#00ff88]" />
            <span className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">Прокси</span>
            <span className={`text-[10px] font-bold ${isConnected ? 'text-[#00ff88]' : 'text-gray-500'}`}>{isConnected ? 'Работает' : 'Выкл'}</span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#0d0d1a] border border-[#2a2a5a33]">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: fragEnable ? '#ff6b35' : '#444' }} />
            <span className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">DPI</span>
            <span className={`text-[10px] font-bold ${fragEnable ? 'text-[#ff6b35]' : 'text-gray-500'}`}>{fragEnable ? 'Обход' : 'Выкл'}</span>
          </div>
        </div>

        {/* Nav list */}
        <div className="flex-1 overflow-y-auto px-4 pb-20 lg:max-w-2xl lg:mx-auto lg:w-full">
          <div className="flex flex-col gap-2">
            {SECTIONS.map(s => (
              <NavRow key={s.id} icon={s.icon} iconColor={s.iconColor} title={s.title} subtitle={s.subtitle}
                badge={s.badge} badgeColor={s.badgeColor} onClick={() => setPage(s.id)} />
            ))}
          </div>
        </div>
      </div>

      {/* ── Сабскрины ───────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {activeSection && (
          <SubScreen key={activeSection.id} title={activeSection.title}
            icon={activeSection.icon} iconColor={activeSection.iconColor}
            onBack={() => setPage(null)}>
            {activeSection.content}
          </SubScreen>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
