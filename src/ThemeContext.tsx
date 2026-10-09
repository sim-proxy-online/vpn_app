import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { accentVars, accentAtHour, dayPart, type DayPart } from './utils/color';

type Theme = 'dark' | 'light';

export const DEFAULT_ACCENT = '#00f0ff';

// Готовые пресеты цвета для раздела «Оформление».
export const ACCENT_PRESETS: { name: string; value: string }[] = [
  { name: 'Циан',     value: '#00f0ff' },
  { name: 'Фиолет',   value: '#b000ff' },
  { name: 'Изумруд',  value: '#00ff88' },
  { name: 'Маджента', value: '#ff2d95' },
  { name: 'Оранж',    value: '#ff6b35' },
  { name: 'Синий',    value: '#2d7dff' },
  { name: 'Алый',     value: '#ff3b5c' },
  { name: 'Золото',   value: '#ffc400' },
];

function normalizeHex(hex: string): string {
  let h = (hex || '').trim();
  if (!h.startsWith('#')) h = '#' + h;
  // #rgb -> #rrggbb
  if (/^#[0-9a-fA-F]{3}$/.test(h)) {
    h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  }
  return /^#[0-9a-fA-F]{6}$/.test(h) ? h.toLowerCase() : DEFAULT_ACCENT;
}

function applyAccent(hex: string) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(accentVars(normalizeHex(hex)))) root.style.setProperty(name, value);
}

/** Эффективный (с учётом времени суток) акцент — то, что реально применяется. */
function effectiveAccent(base: string, auto: boolean, hour = new Date().getHours()): string {
  return auto ? accentAtHour(base, hour) : base;
}

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  isDark: boolean;
  accent: string;
  setAccent: (hex: string) => void;
  resetAccent: () => void;
  /** Автоподстройка акцента под время суток. */
  accentAuto: boolean;
  setAccentAuto: (on: boolean) => void;
  /** Часть суток сейчас (для индикации в «Оформлении»). */
  dayPart: DayPart;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'dark',
  toggleTheme: () => {},
  isDark: true,
  accent: DEFAULT_ACCENT,
  setAccent: () => {},
  resetAccent: () => {},
  accentAuto: false,
  setAccentAuto: () => {},
  dayPart: { key: 'day', label: 'День', icon: '☀️' },
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme: Theme = 'dark';
  const isDark = true;

  const [accent, setAccentState] = useState<string>(() => {
    try { return normalizeHex(localStorage.getItem('sim-accent') || DEFAULT_ACCENT); } catch { return DEFAULT_ACCENT; }
  });
  const [accentAuto, setAccentAutoState] = useState<boolean>(() => {
    try { return (localStorage.getItem('sim-accent-auto') || '') === '1'; } catch { return false; }
  });
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.body.style.background = '#0a0a1a';
    document.body.style.colorScheme = 'dark';

    const metaTheme = document.querySelector('meta[name="theme-color"]');
    const metaBarStyle = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (metaTheme) metaTheme.setAttribute('content', '#0a0a1a');
    if (metaBarStyle) metaBarStyle.setAttribute('content', 'black-translucent');

    try { localStorage.setItem('sim-theme', 'dark'); } catch {}
  }, []);

  useEffect(() => {
    applyAccent(accent);
    try { localStorage.setItem('sim-accent', accent); } catch {}
  }, [accent]);

  // Авто-акцент по времени суток: применяем эффективный цвет и раз в минуту
  // проверяем, не сменился ли час (на границе суток цвет плавно меняется).
  useEffect(() => {
    if (!accentAuto) { applyAccent(accent); return; }
    applyAccent(effectiveAccent(accent, true, new Date(now).getHours()));
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [accentAuto, accent, now]);

  useEffect(() => {
    try { localStorage.setItem('sim-accent-auto', accentAuto ? '1' : '0'); } catch {}
  }, [accentAuto]);

  const toggleTheme = () => {};
  const setAccent = (hex: string) => setAccentState(normalizeHex(hex));
  const resetAccent = () => setAccentState(DEFAULT_ACCENT);
  const setAccentAuto = (on: boolean) => setAccentAutoState(on);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, isDark, accent, setAccent, resetAccent, accentAuto, setAccentAuto, dayPart: dayPart(new Date(now).getHours()) }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() { return useContext(ThemeContext); }
