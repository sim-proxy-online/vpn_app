// Генерирует два слоя оформления поверх интерфейса, нарисованного утилитами Tailwind под тёмный фон:
//   src/theme-light.css — светлая тема;
//   src/theme-depth.css — глубина карточек и кнопок, общая для обеих тем.
//
//   node scripts/gen-light-theme.mjs      (или npm run theme:light)
//
// Экраны красятся утилитами Tailwind, подобранными под тёмный фон (text-white, bg-white/5, text-gray-400,
// bg-[#12122a] …). Чтобы светлая тема меняла весь интерфейс, а не только элементы с классами t-*, слой делает две вещи:
//
//   1. «Зеркалит» палитру Tailwind под [data-theme="light"]: светлые оттенки становятся тёмными и наоборот
//      (text-gray-300 → тёмно-серый, bg-green-900/20 → бледно-зелёный), белый становится цветом чернил.
//      Поэтому в компонентах НЕ нужны развилки isDark ? … : … — пишется один вариант, под тёмную тему.
//   2. Для цветов, заданных в классах напрямую (bg-[#12122a], border-[#2a2a5a44], text-[#00ff88] …), выводит замену:
//      тёмные подложки → светлые поверхности, тёмные рамки → линии цвета чернил, неоновый текст → тот же тон темнее,
//      цветные полупрозрачные плашки → непрозрачная пастель.
//   3. Подложку карточки на скруглённом элементе делает белой поверхностью.
//
// Слой глубины (theme-depth.css) тем же элементам — карточкам и кнопкам — даёт тень и лёгкий цветной перелив.
// Он не привязан к теме: сами значения (--lift, --lift-xs, --card-wash, --chip-wash) заданы для каждой темы
// в src/index.css.
//
// Файлы пересобираются этим скриптом; тест src/themeLight.test.tsx падает, если они устарели (появился новый цвет).
// Цвета во встроенных стилях (style={{…}}) сюда не попадают: там используются переменные --bg, --surface,
// --ink-rgb из src/index.css и функция onTheme() из src/utils/color.ts.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_LIGHT = path.join(ROOT, 'src', 'theme-light.css');
const OUT_DEPTH = path.join(ROOT, 'src', 'theme-depth.css');

// Палитра светлой темы. Должна совпадать с токенами [data-theme="light"] в src/index.css.
const INK = [15, 23, 42];
const BG = '#f2f4f8';       // фон экрана
const SURFACE = '#ffffff';  // карточки, поля
const SUNKEN = '#e7ebf2';   // утопленные поля и вложенные панели
const TRACK = '#cbd2de';    // дорожки переключателей, заметные разделители

// ── Палитра Tailwind ─────────────────────────────────────────────────────────
const NEUTRALS = ['gray', 'slate'];
const HUES = ['red', 'orange', 'amber', 'yellow', 'green', 'emerald', 'cyan', 'blue', 'purple', 'pink'];
// Нейтральные: чистое зеркало. Цветные: светлые оттенки (ими на тёмном фоне пишут текст) уходят чуть темнее зеркала,
// чтобы текст читался; 500 → 600 по той же причине.
const MIRROR_NEUTRAL = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 600, 500: 500, 600: 400, 700: 300, 800: 200, 900: 100, 950: 50 };
const MIRROR_HUE = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 700, 500: 600, 600: 400, 700: 300, 800: 200, 900: 100, 950: 50 };

function tailwindPalette() {
  const themeCss = fs.readFileSync(createRequire(import.meta.url).resolve('tailwindcss/theme.css'), 'utf8');
  const palette = {};
  for (const m of themeCss.matchAll(/--color-([a-z]+)-(\d+):\s*([^;]+);/g)) palette[`${m[1]}-${m[2]}`] = m[3].trim();
  return palette;
}

function paletteMirror() {
  const palette = tailwindPalette();
  const lines = [`  --color-white: rgb(${INK.join(' ')});`];
  for (const [names, mirror] of [[NEUTRALS, MIRROR_NEUTRAL], [HUES, MIRROR_HUE]]) {
    for (const name of names) {
      for (const [shade, target] of Object.entries(mirror)) {
        const value = palette[`${name}-${target}`];
        if (!value) throw new Error(`в палитре Tailwind нет ${name}-${target}`);
        lines.push(`  --color-${name}-${shade}: ${value};`);
      }
    }
  }
  return lines;
}

// ── Цвет ─────────────────────────────────────────────────────────────────────
function parseHex(hex) {
  let h = hex;
  if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
}

function toHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn, l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6;
    else if (mx === G) h = ((B - R) / d + 2) / 6;
    else h = ((R - G) / d + 4) / 6;
  }
  return { h: h * 360, s, l };
}

function fromHsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

const lin = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const BG_RGB = parseHex(BG.slice(1));

/** Тот же тон, но достаточно тёмный для светлого фона. */
function darkenTo(color, min) {
  if (contrast(color, BG_RGB) >= min) return color;
  const { h, s, l } = toHsl(color);
  for (let light = Math.floor(l * 100); light >= 0; light--) {
    const c = fromHsl(h, s, light / 100);
    if (contrast(c, BG_RGB) >= min) return c;
  }
  return { r: 0, g: 0, b: 0 };
}

const round = (v, digits = 3) => Number(v.toFixed(digits));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const css = ({ r, g, b }, a = 1) => (a >= 0.995 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${round(a)})`);
const ink = a => `rgb(${INK.join(' ')} / ${round(a)})`;
const hexCss = (hex, a = 1) => css(parseHex(hex.slice(1)), a);

const isWhitish = c => c.r > 235 && c.g > 235 && c.b > 235;
/** Чёрный, тёмно-серый и тёмно-синий «ночной» фон интерфейса. */
function isDarkNeutral(c) {
  const { h, s } = toHsl(c);
  return luminance(c) < 0.05 && (s < 0.35 || (h >= 205 && h <= 280));
}

/** Цвет поверх белого: непрозрачная пастель вместо полупрозрачной плашки (под ней не просвечивают ни фон, ни тень). */
const overWhite = (c, a) => ({ r: Math.round(c.r * a + 255 * (1 - a)), g: Math.round(c.g * a + 255 * (1 - a)), b: Math.round(c.b * a + 255 * (1 - a)) });

/**
 * Подложка поверхности: слабая нейтральная (bg-white/5, bg-[#1a1a3a33]) или сплошной цвет карточки (bg-[#12122a]).
 * На тёмном фоне так рисуются карточки и кнопки; в светлой теме это белая приподнятая поверхность.
 */
function isSurfaceTone(c, alpha) {
  if (isWhitish(c)) return alpha < 0.3;
  if (!isDarkNeutral(c)) return false;
  const { l } = toHsl(c);
  return alpha < 0.6 || (alpha > 0.99 && l >= 0.088 && l < 0.14);
}

/** Подложка: bg- и ступени градиента from-, to-, via-. Возвращает CSS-цвет или null (оставить как есть). */
function mapBackground(c, alpha, kind = 'bg') {
  const stop = kind !== 'bg';
  if (isWhitish(c)) return alpha < 0.995 ? ink(clamp(alpha * 1.6, 0.02, 0.14)) : null;
  if (isDarkNeutral(c)) {
    const { l } = toHsl(c);
    // Слабая тёмная подложка — лёгкая серая поверх светлого фона; плотная (панели с размытием) — сама поверхность.
    if (alpha < 0.6) return ink(clamp(alpha * 0.12, 0.02, 0.1));
    // Градиент из двух тёмно-синих — карточка: в светлой теме она белая, без серого перелива.
    if (stop) return hexCss(l < 0.088 ? BG : l < 0.2 ? SURFACE : SUNKEN, alpha);
    const solid = l < 0.088 ? BG : l < 0.14 ? SURFACE : l < 0.2 ? SUNKEN : TRACK;
    // Почти непрозрачная панель (окно поверх экрана) в светлой теме непрозрачна: сквозь белое просвечивает всё тёмное.
    return hexCss(solid, alpha >= 0.9 ? 1 : alpha);
  }
  // Тёмный оттенок цвета (тёмно-зелёная, тёмно-красная плашка) — очень светлый оттенок того же тона.
  if (luminance(c) < 0.05) { const { h } = toHsl(c); return css(fromHsl(h, 0.55, 0.94), alpha); }
  // Цветная полупрозрачная плашка (значок состояния, предупреждение) — чистая пастель того же тона.
  if (alpha < 0.4) return css(overWhite(c, clamp(alpha * 1.6, 0.07, 0.24)));
  // Неон сплошной заливкой на светлом теряется: точки и полосы — чуть темнее, концы градиентов на кнопках
  // (на них белый текст) — заметно темнее.
  if (alpha >= 0.9 && luminance(c) > 0.5) return css(darkenTo(c, stop ? 3 : 1.7), alpha);
  return null;
}

/** Чёрная подложка Tailwind (bg-black/40): до половины — утопленное поле, плотнее — затемнение под окном. */
function mapBlackOverlay(percent) {
  return percent <= 50 ? ink(clamp(percent * 0.0015, 0.03, 0.075)) : ink(clamp(percent * 0.0055, 0.3, 0.48));
}

/** Рамка и разделитель: border-, divide-, ring-, outline-. */
function mapBorder(c, alpha) {
  if (isWhitish(c)) return ink(clamp(alpha * 1.6, 0.06, 0.16));
  if (isDarkNeutral(c)) return ink(alpha >= 0.9 ? 0.14 : clamp(alpha * 0.45, 0.06, 0.14));
  // Светлый неон (зелёный, жёлтый) рамкой на светлом фоне не виден — берём тот же тон темнее.
  if (luminance(c) > 0.45) return css(darkenTo(c, 2.2), clamp(alpha * 1.4, 0, 1));
  return null;
}

/** Текст и значки: text-, fill-, stroke-. */
function mapText(c, alpha) {
  const { s, l } = toHsl(c);
  if (l > 0.85) return ink(alpha);                                 // почти белый → чернила
  if (s < 0.3 && l > 0.5) return hexCss('#475569', alpha);         // светло-серый вторичный текст
  if (contrast(c, BG_RGB) >= 4.5) return null;                     // уже читается
  return css(darkenTo(c, 4.5), alpha);
}

// ── Классы с цветом в исходниках ─────────────────────────────────────────────
const VARIANTS = { hover: ':hover', focus: ':focus', active: ':active', 'focus-within': ':focus-within', disabled: ':disabled' };
const CLASS_RE = /(?<![\w:-])((?:(?:hover|focus|active|focus-within|disabled|group-hover):)*)(bg|text|border|from|to|via|divide|ring|outline|fill|stroke)-\[#([0-9a-fA-F]{3,8})\](?:\/(\d{1,3}))?/g;
const PROPERTY = {
  bg: 'background-color', text: 'color', border: 'border-color', divide: 'border-color', ring: '--tw-ring-color',
  outline: 'outline-color', fill: 'fill', stroke: 'stroke',
  from: '--tw-gradient-from', to: '--tw-gradient-to', via: '--tw-gradient-via',
};

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const escapeClass = cls => cls.replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);

// Подложки Tailwind без своего цвета в классе: bg-white/5, bg-white/[0.04], bg-black/40.
const TW_ALPHA_RE = /(?<![\w:-])bg-(white|black)\/(?:\[([\d.]+)\]|(\d{1,3}))(?![\w.\]])/g;
// Скругления, по которым карточка отличается от мелкой плашки.
const RADIUS_RE = /(?<![\w:-])rounded-(xl|2xl|3xl|\[(\d+)px\])(?![\w-])/g;

function scanSources() {
  const overrides = new Map();   // класс → правило замены цвета
  const faint = new Set();       // подложки поверхностей: на скруглённом элементе это карточка или кнопка
  const cardRadius = new Set();  // rounded-2xl и крупнее
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(CLASS_RE)) {
      const [token, variants, kind, hex, opacity] = m;
      if (overrides.has(token)) continue;
      const color = parseHex(hex);
      const alpha = color.a * (opacity ? Number(opacity) / 100 : 1);
      if (kind === 'bg' && !variants && isSurfaceTone(color, alpha)) faint.add(token);
      const mapped = ['bg', 'from', 'to', 'via'].includes(kind) ? mapBackground(color, alpha, kind)
        : ['border', 'divide', 'ring', 'outline'].includes(kind) ? mapBorder(color, alpha)
        : mapText(color, alpha);
      if (!mapped) continue;
      let selector = `.${escapeClass(token)}`;
      let scope = '[data-theme="light"] ';
      for (const v of variants.split(':').filter(Boolean)) {
        if (v === 'group-hover') scope += '.group:hover ';
        else selector += VARIANTS[v];
      }
      if (kind === 'divide') selector += ' > :not(:last-child)';
      overrides.set(token, `${scope}${selector} { ${PROPERTY[kind]}: ${mapped}; }`);
    }
    for (const m of text.matchAll(TW_ALPHA_RE)) {
      const [token, name, fraction, percent] = m;
      const value = fraction !== undefined ? Number(fraction) * 100 : Number(percent);
      if (name === 'white') { if (value < 30) faint.add(token); continue; }
      if (!overrides.has(token)) overrides.set(token, `[data-theme="light"] .${escapeClass(token)} { background-color: ${mapBlackOverlay(value)}; }`);
    }
    for (const m of text.matchAll(RADIUS_RE)) {
      if (m[1] === '2xl' || m[1] === '3xl' || (Number(m[2]) >= 14 && Number(m[2]) < 100)) cardRadius.add(m[0]);
    }
  }
  return { overrides, faint, cardRadius };
}

const classList = set => [...set].sort().map(cls => `.${escapeClass(cls)}`).join(', ');

/**
 * Поверхности. Карточки и кнопки рисуются слабой подложкой (bg-white/5, bg-[#1a1a3a33]) или цветом карточки
 * (bg-[#12122a]) на скруглённом элементе. Элемент со своей тенью (окно, выпадающее меню) в счёт не идёт:
 * он оставляет свою тень себе.
 */
function surfaceSelectors({ faint, cardRadius }) {
  const surface = `:is(${classList(faint)}):not([class*="shadow-"])`;
  return {
    card: `:is(${classList(cardRadius)})${surface}`,
    button: `.rounded-xl${surface}`,
    pill: `.rounded-full.border${surface}`,
  };
}

/** Светлая тема: поверхность белая (зеркало палитры превращало слабую подложку в серую плашку). */
function lightSurfaces(scan) {
  const { card, button, pill } = surfaceSelectors(scan);
  return [`[data-theme="light"] :is(${card}, ${button}, ${pill}) { background-color: #ffffff; }`];
}

export function buildDepthCss() {
  const { card, button, pill } = surfaceSelectors(scanSources());
  return [
    '/* Сгенерировано scripts/gen-light-theme.mjs — не править вручную (npm run theme:light). */',
    '',
    '/* Глубина поверхностей, обе темы. Значения переменных для каждой темы — в index.css. */',
    `${card} { background-image: var(--card-wash); box-shadow: var(--lift); }`,
    `${button} { background-image: var(--chip-wash); box-shadow: var(--lift-xs); }`,
    `${pill} { background-image: var(--chip-wash); box-shadow: var(--lift-xs); }`,
    '',
  ].join('\n');
}
export function buildLightThemeCss() {
  const scan = scanSources();
  return [
    '/* Сгенерировано scripts/gen-light-theme.mjs — не править вручную (npm run theme:light). */',
    '',
    '/* Зеркало палитры Tailwind: оттенки, подобранные под тёмный фон, читаются на светлом. */',
    '[data-theme="light"] {',
    ...paletteMirror(),
    '}',
    '',
    '/* Цвета, заданные в классах напрямую. */',
    ...[...scan.overrides.keys()].sort().map(token => scan.overrides.get(token)),
    '',
    '/* Поверхности: подложка карточки на скруглённом элементе — белая (тень и перелив даёт theme-depth.css). */',
    ...lightSurfaces(scan),
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [out, build] of [[OUT_LIGHT, buildLightThemeCss], [OUT_DEPTH, buildDepthCss]]) {
    const next = build();
    fs.writeFileSync(out, next);
    console.log(`${path.relative(ROOT, out)}: ${next.split('\n').length} строк`);
  }
}
