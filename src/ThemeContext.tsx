import { createContext, useContext, useState, useEffect, useLayoutEffect, ReactNode } from 'react';
import { accentVars, accentAtHour, dayPart, readableOnLight, setLightTheme, LIGHT_BG, type DayPart } from './utils/color';

export type Theme = 'dark' | 'light';

const THEME_KEY = 'sim-theme';
const DARK_BG = '#0a0a1a';

/** Сохранённая тема; по умолчанию и при любом другом значении — тёмная. */
function storedTheme(): Theme {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}

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

/**
 * Акцент подобран под тёмный фон (неоновый циан, жёлтый…). В светлой теме берётся тот же тон темнее, чтобы им можно
 * было писать текст на светлом фоне; чёрный текст на заливке этим цветом тоже остаётся читаемым.
 */
function applyAccent(hex: string, theme: Theme) {
  const root = document.documentElement;
  const color = theme === 'light' ? readableOnLight(normalizeHex(hex)) : normalizeHex(hex);
  for (const [name, value] of Object.entries(accentVars(color))) root.style.setProperty(name, value);
}

/** Эффективный (с учётом времени суток) акцент — то, что реально применяется. */
function effectiveAccent(base: string, auto: boolean, hour = new Date().getHours()): string {
  return auto ? accentAtHour(base, hour) : base;
}

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
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
  setTheme: () => {},
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
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const isDark = theme === 'dark';
  // До отрисовки потомков: цвета, которые компоненты считают сами (onTheme), должны сразу соответствовать теме.
  setLightTheme(!isDark);

  const [accent, setAccentState] = useState<string>(() => {
    try { return normalizeHex(localStorage.getItem('sim-accent') || DEFAULT_ACCENT); } catch { return DEFAULT_ACCENT; }
  });
  const [accentAuto, setAccentAutoState] = useState<boolean>(() => {
    try { return (localStorage.getItem('sim-accent-auto') || '') === '1'; } catch { return false; }
  });
  const [now, setNow] = useState<number>(() => Date.now());

  // Тему применяем до отрисовки кадра, чтобы интерфейс не мигал прежней.
  useLayoutEffect(() => {
    const background = isDark ? DARK_BG : LIGHT_BG;
    document.documentElement.setAttribute('data-theme', theme);
    document.body.style.background = background;
    document.body.style.colorScheme = theme;

    const metaTheme = document.querySelector('meta[name="theme-color"]');
    const metaBarStyle = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (metaTheme) metaTheme.setAttribute('content', background);
    if (metaBarStyle) metaBarStyle.setAttribute('content', isDark ? 'black-translucent' : 'default');

    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme, isDark]);

  useEffect(() => {
    try { localStorage.setItem('sim-accent', accent); } catch {}
  }, [accent]);

  // Акцент зависит от темы (в светлой он темнее) и, если включено, от времени суток: применяем эффективный цвет
  // и раз в минуту проверяем, не сменился ли час (на границе суток цвет плавно меняется).
  useLayoutEffect(() => {
    if (!accentAuto) { applyAccent(accent, theme); return; }
    applyAccent(effectiveAccent(accent, true, new Date(now).getHours()), theme);
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [accentAuto, accent, now, theme]);

  useEffect(() => {
    try { localStorage.setItem('sim-accent-auto', accentAuto ? '1' : '0'); } catch {}
  }, [accentAuto]);

  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  const setAccent = (hex: string) => setAccentState(normalizeHex(hex));
  const resetAccent = () => setAccentState(DEFAULT_ACCENT);
  const setAccentAuto = (on: boolean) => setAccentAutoState(on);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, isDark, accent, setAccent, resetAccent, accentAuto, setAccentAuto, dayPart: dayPart(new Date(now).getHours()) }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() { return useContext(ThemeContext); }
