import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeContext';
import { accentVars, contrast, GRAPHIC_CONTRAST, LIGHT_BG, onTheme, readableOnLight, setLightTheme } from './utils/color';
// @ts-expect-error — скрипт сборки слоя светлой темы, без типов
import { buildDepthCss, buildLightThemeCss } from '../scripts/gen-light-theme.mjs';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('цвета для светлой темы', () => {
  afterEach(() => { setLightTheme(false); });

  it('readableOnLight затемняет неон до читаемого контраста и сохраняет тон', () => {
    for (const neon of ['#00f0ff', '#00ff88', '#ffe600', '#ffd23f', '#ff9d3d']) {
      const dark = readableOnLight(neon);
      expect(contrast(dark, LIGHT_BG)).toBeGreaterThanOrEqual(4.5);
      expect(dark).not.toBe(neon);
    }
  });

  it('readableOnLight не трогает цвет, который уже читается', () => {
    expect(readableOnLight('#0f172a')).toBe('#0f172a');
    expect(readableOnLight('#1d4ed8')).toBe('#1d4ed8');
  });

  it('onTheme меняет цвет только в светлой теме и только для #rrggbb', () => {
    expect(onTheme('#00ff88')).toBe('#00ff88');
    setLightTheme(true);
    expect(onTheme('#00ff88')).toBe(readableOnLight('#00ff88'));
    expect(onTheme('var(--accent)')).toBe('var(--accent)');
    expect(onTheme('rgba(0,0,0,0.4)')).toBe('rgba(0,0,0,0.4)');
  });

  it('для графики onTheme оставляет цвет ярче, чем для текста, но видимым на светлом фоне', () => {
    setLightTheme(true);
    const paint = onTheme('#ffd23f', GRAPHIC_CONTRAST);
    expect(contrast(paint, LIGHT_BG)).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST);
    expect(contrast(paint, LIGHT_BG)).toBeLessThan(contrast(onTheme('#ffd23f'), LIGHT_BG));
  });

  it('слабые варианты акцента в светлой теме непрозрачные, сильные остаются с альфой', () => {
    expect(accentVars('#007880')['--accent-a10']).toBe('#00788010');
    setLightTheme(true);
    const vars = accentVars('#007880');
    expect(vars['--accent-a10']).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(vars['--accent-a10'], '#ffffff')).toBeLessThan(1.3); // пастель, почти белая
    expect(vars['--accent-a44']).toBe('#00788044');
    expect(vars['--accent']).toBe('#007880');
  });
});

describe('ThemeProvider', () => {
  let host: HTMLDivElement;
  let root: Root;
  let api: ReturnType<typeof useTheme>;

  function Probe() { api = useTheme(); return null; }
  const mount = () => act(() => { root.render(<ThemeProvider><Probe /></ThemeProvider>); });
  const accentVar = () => document.documentElement.style.getPropertyValue('--accent');

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    setLightTheme(false);
  });

  it('по умолчанию тёмная тема', () => {
    mount();
    expect(api.theme).toBe('dark');
    expect(api.isDark).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(accentVar()).toBe('#00f0ff');
  });

  it('переключает тему, запоминает её и затемняет акцент в светлой', () => {
    mount();
    act(() => { api.setTheme('light'); });
    expect(api.isDark).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('sim-theme')).toBe('light');
    expect(accentVar()).toBe(readableOnLight('#00f0ff'));
    expect(onTheme('#00ff88')).toBe(readableOnLight('#00ff88'));

    act(() => { api.toggleTheme(); });
    expect(api.theme).toBe('dark');
    expect(localStorage.getItem('sim-theme')).toBe('dark');
    expect(accentVar()).toBe('#00f0ff');
    expect(onTheme('#00ff88')).toBe('#00ff88');
  });

  it('восстанавливает сохранённую светлую тему при запуске', () => {
    localStorage.setItem('sim-theme', 'light');
    mount();
    expect(api.theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('любое другое сохранённое значение — тёмная тема', () => {
    localStorage.setItem('sim-theme', 'sepia');
    mount();
    expect(api.theme).toBe('dark');
  });
});

describe('src/theme-light.css', () => {
  const normalize = (s: string) => s.replace(/\r\n/g, '\n');

  it('соответствует исходникам (иначе: npm run theme:light)', () => {
    const onDisk = fs.readFileSync(path.resolve(__dirname, 'theme-light.css'), 'utf8');
    expect(normalize(onDisk)).toBe(normalize(buildLightThemeCss()));
  });

  it('перекрашивает основные тёмные поверхности и неоновый текст', () => {
    const cssText = buildLightThemeCss() as string;
    expect(cssText).toContain('--color-white: rgb(15 23 42);');
    expect(cssText).toMatch(/\.bg-\\\[\\#12122a\\\] \{ background-color: rgb\(255 255 255\); \}/);
    expect(cssText).toMatch(/\.bg-\\\[\\#0a0a1a\\\] \{ background-color: rgb\(242 244 248\); \}/);
    expect(cssText).toMatch(/\.text-\\\[\\#00ff88\\\] \{ color: rgb\(/);
    expect(cssText).toMatch(/\.border-\\\[\\#2a2a5a\\\] \{ border-color: rgb\(15 23 42 \/ 0\.14\); \}/);
  });

  it('подложки карточек и кнопок делает белыми поверхностями', () => {
    const cssText = buildLightThemeCss() as string;
    const surfaces = cssText.split('\n').filter(line => line.endsWith('{ background-color: #ffffff; }'));
    expect(surfaces).toHaveLength(1);
    for (const cls of [String.raw`.bg-white\/5`, String.raw`.bg-\[\#1a1a3a33\]`, String.raw`.bg-\[\#12122a\]`, '.rounded-2xl', '.rounded-xl', '.rounded-full.border']) {
      expect(surfaces[0]).toContain(cls);
    }
    expect(cssText).not.toContain('box-shadow'); // тени — в theme-depth.css, общем для обеих тем
  });

  it('цветные плашки делает непрозрачной пастелью, чёрные подложки — полем или затемнением', () => {
    const cssText = buildLightThemeCss() as string;
    expect(cssText).toContain(String.raw`.bg-\[\#ff9d4d12\] { background-color: rgb(255 244 235); }`);
    expect(cssText).toContain(String.raw`.bg-black\/40 { background-color: rgb(15 23 42 / 0.06); }`);
    expect(cssText).toContain(String.raw`.bg-black\/80 { background-color: rgb(15 23 42 / 0.44); }`);
    expect(cssText).toContain(String.raw`.bg-\[\#0b0e24\]\/95 { background-color: rgb(255 255 255); }`);
  });
});

describe('src/theme-depth.css', () => {
  const normalize = (s: string) => s.replace(/\r\n/g, '\n');
  const rules = () => (buildDepthCss() as string).split('\n').filter(line => line.includes('box-shadow: var(--lift'));

  it('соответствует исходникам (иначе: npm run theme:light)', () => {
    const onDisk = fs.readFileSync(path.resolve(__dirname, 'theme-depth.css'), 'utf8');
    expect(normalize(onDisk)).toBe(normalize(buildDepthCss()));
  });

  it('даёт глубину карточкам, кнопкам и «пилюлям» в обеих темах', () => {
    const [card, button, pill] = rules();
    expect(rules()).toHaveLength(3);
    for (const rule of [card, button, pill]) expect(rule).not.toContain('data-theme'); // значения темы — в переменных
    for (const cls of [String.raw`.bg-white\/5`, String.raw`.bg-\[\#1a1a3a33\]`, String.raw`.bg-\[\#12122a\]`]) expect(card).toContain(cls);
    expect(card).toContain('.rounded-2xl');
    expect(card).toContain('var(--card-wash)');
    expect(button.startsWith('.rounded-xl:is(')).toBe(true);
    expect(pill.startsWith('.rounded-full.border:is(')).toBe(true);
  });

  it('не трогает «пилюли» без рамки, чёрные подложки и элементы со своей тенью', () => {
    const [card] = rules();
    expect(card).not.toContain('999px');     // «пилюля» — не карточка
    expect(card).not.toContain('.bg-black'); // чёрная подложка — утопленное поле, а не поверхность
    expect(card).toContain(':not([class*="shadow-"])');
  });
});
