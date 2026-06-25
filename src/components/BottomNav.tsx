import { motion } from 'framer-motion';
import { Home, Globe, FolderOpen, Settings } from 'lucide-react';
import { AppScreen } from '../types';
import { useTheme } from '../ThemeContext';
import { useI18n } from '../i18n';

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

/* Mobile bottom navigation */
export function MobileNav({ activeScreen, onNavigate }: NavProps) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  return (
    <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50">
      {/* Background with glassmorphism and subtle border */}
      <div className={`absolute inset-0 backdrop-blur-2xl border-t ${isDark ? 'bg-[#0a0a1a]/80 border-[var(--accent-a15)]' : 'bg-white/80 border-gray-200/50'}`} />

      {/* Glow effect for the active area */}
      {isDark && (
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-1/2 h-[1px] bg-gradient-to-r from-transparent via-[var(--accent-a44)] to-transparent shadow-[0_0_15px_rgba(var(--accent-rgb),0.3)]" />
      )}

      <nav className="relative flex items-center justify-around px-2 py-2 pb-[calc(8px+env(safe-area-inset-bottom,0px))]">
        {navItems.map((item) => {
          const isActive = activeScreen === item.id;
          const Icon = item.icon;
          return (
            <button key={item.id} onClick={() => onNavigate(item.id)}
              className="relative flex flex-col items-center gap-1 px-3 sm:px-4 py-2 rounded-xl transition-all min-w-[56px] sm:min-w-[64px]">
              {isActive && (
                <motion.div className="absolute inset-0 rounded-xl"
                  style={{ background: 'linear-gradient(135deg, var(--accent-a08), #b000ff08)', border: '1px solid var(--accent-a22)' }}
                  layoutId="mobNavBg" transition={{ type: 'spring', damping: 25 }} />
              )}
              <Icon size={20}
                className={`relative z-10 transition-colors ${isActive ? 'text-[var(--accent)]' : 'text-gray-600'}`}
                style={isActive ? { filter: 'drop-shadow(0 0 6px var(--accent))' } : {}} />
              <span className={`relative z-10 text-[9px] sm:text-[10px] font-medium transition-colors ${isActive ? 'text-[var(--accent)]' : (isDark ? 'text-gray-300' : 'text-gray-600')}`}>
                {t(item.tkey)}
              </span>
              {isActive && (
                <motion.div className="absolute -top-px left-1/2 -translate-x-1/2 w-6 h-0.5 rounded-full bg-[var(--accent)]"
                  style={{ boxShadow: '0 0 8px var(--accent)' }} layoutId="mobNavIndicator" />
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/* Desktop sidebar navigation */
export function DesktopSidebar({ activeScreen, onNavigate }: NavProps) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  return (
    <div className={`hidden lg:flex flex-col fixed left-0 top-0 bottom-0 w-[220px] xl:w-[260px] z-50 border-r transition-all duration-300 ${isDark ? 'bg-[#0a0a1a] border-[var(--accent-a15)] shadow-[4px_0_24px_rgba(0,0,0,0.3)]' : 'bg-white border-gray-100 shadow-[4px_0_12px_rgba(0,0,0,0.05)]'}`}>
      {/* Subtle Sidebar Glow */}
      {isDark && (
        <div className="absolute right-0 top-0 bottom-0 w-[1px] bg-gradient-to-b from-transparent via-[var(--accent-a22)] to-transparent" />
      )}

      {/* Logo */}
      <div className="flex items-center gap-2.5 px-6 pt-6 pb-8">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[var(--accent-a22)] to-[#b000ff22] border border-[var(--accent-a33)] flex items-center justify-center">
          <span className="text-[var(--accent)] font-orbitron text-sm font-bold">S</span>
        </div>
        <div>
          <h1 className="font-orbitron text-sm font-bold tracking-wider">
            <span className="text-[var(--accent)]">SIM</span><span className="text-white"> PROXY</span>
          </h1>
          <p className="text-[9px] text-gray-600">sim-proxy.online</p>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-3 space-y-1">
        {navItems.map((item) => {
          const isActive = activeScreen === item.id;
          const Icon = item.icon;
          return (
            <button key={item.id} onClick={() => onNavigate(item.id)}
              className={`relative w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-left ${isActive ? 'text-[var(--accent)]' : (isDark ? 'text-gray-300 hover:text-white hover:bg-[#ffffff05]' : 'text-gray-500 hover:text-gray-700 hover:bg-[#ffffff05]')}`}>
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
        <p className={`text-[10px] ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Xray Core + sing-box</p>
        <p className={`text-[9px] ${isDark ? 'text-gray-400' : 'text-gray-800'} mt-0.5`}>13 протоколов</p>
      </div>
    </div>
  );
}

/* Default export for backward compat — renders both */
export default function BottomNav({ activeScreen, onNavigate }: NavProps) {
  return <DesktopSidebar activeScreen={activeScreen} onNavigate={onNavigate} />;
}
