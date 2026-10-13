import { motion } from 'framer-motion';
import { Home, Globe, FolderOpen, Settings } from 'lucide-react';
import { AppScreen } from '../types';
import { useTheme } from '../ThemeContext';
import { useI18n } from '../i18n';
import { sessionMascot } from '../utils/mascotSeason';

// Сезонная картинка Петровича — общий адрес на сессию (см. utils/mascotSeason).
const mascot = sessionMascot();

interface NavProps {
  activeScreen: AppScreen;
  onNavigate: (screen: AppScreen) => void;
}

const navItems: { id: AppScreen; icon: any; tkey: string }[] = [
  { id: 'home', icon: Home, tkey: 'nav.home' },
  { id: 'servers', icon: Globe, tkey: 'nav.servers' },
  { id: 'profiles', icon: FolderOpen, tkey: 'nav.profiles' },
  { id: 'settings', icon: Settings, tkey: 'nav.settings' },
];

/* Mobile bottom navigation — сегмент-контрол в стиле приложения.
   Раскладка внутри сегмента вертикальная (иконка сверху, подпись под ней на всю
   ширину сегмента), чтобы длинные русские подписи не слипались в одну строку. */
export function MobileNav({ activeScreen, onNavigate }: NavProps) {
  const { t } = useI18n();
  return (
    <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50">
      {/* Плавающая «дорожка»-карточка: полной подложки во всю ширину нет — на экранах
          с другим фоном (Серверы: --bg-deep #07071a) она выступала светлой полосой. */}
      <nav className="relative px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))]">
        {/* Дорожка на переменной --nav-track: в тёмной теме это #0d0d20 — на пару тонов
            светлее --bg, чтобы панель читалась карточкой, но не светилась фоном; в светлой
            теме — белая. Граница var(--line). Фон непрозрачный, сквозь панель ничего не видно. */}
        <div className="relative flex rounded-2xl border p-1" style={{ background: 'var(--nav-track)', borderColor: 'var(--line)' }}>
          {navItems.map((item) => {
            const isActive = activeScreen === item.id;
            const Icon = item.icon;
            return (
              <button key={item.id} onClick={() => onNavigate(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative flex flex-1 flex-col items-center justify-center gap-1 py-2 rounded-[13px] transition-colors min-w-0 ${isActive ? 'text-[var(--accent)]' : 'text-gray-400'}`}>
                {/* Скользящий knob — акцентная подложка только активного пункта */}
                {isActive && (
                  <motion.div
                    className="absolute inset-0 rounded-[13px] border bg-[var(--accent)]/10 border-[var(--accent)]/30"
                    layoutId="mobNavKnob"
                    transition={{ type: 'spring', damping: 28, stiffness: 320 }} />
                )}
                <Icon size={18}
                  className="relative z-10 shrink-0 transition-colors" />
                <span className="relative z-10 w-full px-0.5 text-center text-[10px] font-semibold leading-none tracking-tight transition-colors">
                  {t(item.tkey)}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

/* Desktop sidebar navigation */
export function DesktopSidebar({ activeScreen, onNavigate }: NavProps) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  return (
    <div className={`hidden lg:flex flex-col fixed left-0 top-0 bottom-0 w-[220px] xl:w-[260px] z-50 border-r transition-all duration-300 bg-[#0a0a1a] border-[var(--accent-a15)] shadow-[4px_0_24px_rgba(0,0,0,0.3)]`}>
      {/* Subtle Sidebar Glow */}
      {isDark && (
        <div className="absolute right-0 top-0 bottom-0 w-[1px] bg-gradient-to-b from-transparent via-[var(--accent-a22)] to-transparent" />
      )}

      {/* Logo */}
      <div className="flex items-center gap-2.5 px-6 pt-6 pb-8">
        <div className="w-11 h-11 rounded-full overflow-hidden shrink-0 border border-[#e9c46a66] bg-[#0c1030] flex items-center justify-center"
          style={{ boxShadow: '0 0 14px #2f7fe633' }}>
          <img src={mascot} alt="" draggable={false} className="w-[88%] h-[88%] object-contain" />
        </div>
        <div>
          <h1 className="text-[15px] font-extrabold tracking-tight leading-tight">
            <span className="block text-white">Квадрат</span><span className="block text-[var(--accent)]">Петровича</span>
          </h1>
          <p className="text-[11px] text-gray-400">petrovich.party</p>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-3 space-y-1">
        {navItems.map((item) => {
          const isActive = activeScreen === item.id;
          const Icon = item.icon;
          return (
            <button key={item.id} onClick={() => onNavigate(item.id)}
              className={`relative w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-left ${isActive ? 'text-[var(--accent)]' : ('text-gray-300 hover:text-white hover:bg-[#ffffff05]')}`}>
              {isActive && (
                <motion.div className="absolute inset-0 rounded-xl bg-[var(--accent-a08)] border border-[var(--accent-a22)]"
                  layoutId="sidebarBg" transition={{ type: 'spring', damping: 25 }} />
              )}
              <Icon size={18} className="relative z-10"
                style={isActive ? { filter: 'drop-shadow(0 0 6px var(--accent))' } : {}} />
              <span className="relative z-10 text-sm font-medium">{t(item.tkey)}</span>
              {isActive && (
                <motion.div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-r-full bg-[var(--accent)]"
                  style={{ boxShadow: '0 0 8px var(--accent)' }} layoutId="sidebarIndicator" />
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-[#2a2a5a22]">
        <p className={`text-[11px] text-gray-300`}>Xray Core + mihomo</p>
        <p className={`text-[10px] text-gray-400 mt-0.5`}>VLESS · VMess · Trojan · Shadowsocks</p>
      </div>
    </div>
  );
}

/* Default export for backward compat — renders both */
export default function BottomNav({ activeScreen, onNavigate }: NavProps) {
  return <DesktopSidebar activeScreen={activeScreen} onNavigate={onNavigate} />;
}
