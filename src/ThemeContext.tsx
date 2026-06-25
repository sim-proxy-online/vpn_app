import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

type Theme = 'dark' | 'light';

// Альфа-суффиксы (hex), для которых генерируем переменные --accent-aXX.
// Должны совпадать с набором, используемым в стилях.
const ACCENT_ALPHAS = ['08', '10', '11', '12', '15', '20', '22', '33', '40', '44', '66', '88'];

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

function hexToRgbChannels(hex: string): string {
  const h = normalizeHex(hex);
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}

function applyAccent(hex: string) {
  const h = normalizeHex(hex);
  const root = document.documentElement;
  root.style.setProperty('--accent', h);
  root.style.setProperty('--accent-rgb', hexToRgbChannels(h));
  ACCENT_ALPHAS.forEach(a => root.style.setProperty(`--accent-a${a}`, h + a));
}

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  isDark: boolean;
  accent: string;
  setAccent: (hex: string) => void;
  resetAccent: () => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'dark',
  toggleTheme: () => {},
  isDark: true,
  accent: DEFAULT_ACCENT,
  setAccent: () => {},
  resetAccent: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme: Theme = 'dark';
  const isDark = true;

  const [accent, setAccentState] = useState<string>(() => {
    try { return normalizeHex(localStorage.getItem('sim-accent') || DEFAULT_ACCENT); } catch { return DEFAULT_ACCENT; }
  });

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

  const toggleTheme = () => {};
  const setAccent = (hex: string) => setAccentState(normalizeHex(hex));
  const resetAccent = () => setAccentState(DEFAULT_ACCENT);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, isDark, accent, setAccent, resetAccent }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() { return useContext(ThemeContext); }
