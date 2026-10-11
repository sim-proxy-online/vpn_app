// Безопасное добавление альфы к цвету.
// Обычный hex-цвет («#00ff88») просто дополняется суффиксом («#00ff8820»).
// Акцент задан как CSS-переменная var(--accent) — к ней нельзя дописать hex,
// поэтому возвращаем rgba(var(--accent-rgb),a), используя канальную переменную.
// Альфа-суффиксы (hex), для которых есть переменные --accent-aXX. Должны совпадать с набором, используемым в стилях.
export const ACCENT_ALPHAS = ['08', '10', '11', '12', '15', '20', '22', '33', '40', '44', '66', '88'];

/**
 * CSS-переменные акцента для цвета #rrggbb: подходят и для корня страницы (тема, ThemeContext), и для одного блока
 * (фирменный цвет провайдера на карточке подписки) — всё внутри блока, что использует var(--accent), перекрашивается.
 * Цвет должен быть уже проверенным (см. providerColor.ts).
 */
export function accentVars(hex: string): Record<string, string> {
  const n = parseInt(hex.slice(1), 16);
  const vars: Record<string, string> = { '--accent': hex, '--accent-rgb': `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}` };
  for (const a of ACCENT_ALPHAS) vars[`--accent-a${a}`] = lightTheme && parseInt(a, 16) <= TINT_MAX_ALPHA ? pastel(hex, a) : hex + a;
  return vars;
}

// Слабые варианты акцента (до a22) — это подложки выбранных пунктов и значков. В светлой теме они непрозрачные:
// цвет, смешанный с белым. Полупрозрачная плашка на светлом фоне выглядит грязно-серой, и под ней просвечивает тень.
const TINT_MAX_ALPHA = 0x22;

/** Пастель: цвет #rrggbb поверх белого с силой, заданной альфой hex2 (слегка усиленной, чтобы оттенок был виден). */
function pastel(hex: string, hex2: string): string {
  const n = parseInt(hex.slice(1), 16);
  const a = Math.min(0.24, Math.max(0.07, (parseInt(hex2, 16) / 255) * 1.6));
  const mix = (v: number) => Math.round(v * a + 255 * (1 - a)).toString(16).padStart(2, '0');
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}

// ── Динамический акцент по времени суток ────────────────────────────────────
// Выбранный пользователем цвет остаётся «тем же», но настройка сдвигается в
// HSL в зависимости от часа: днём нейтрально, вечером теплее (в сторону
// красного), ночью темнее и приглушённее, утром холоднее (в сторону синего).
// Так «Квадрат» дышит вместе с сутками, не ломая ручной выбор цвета.
export interface DayPart { key: 'day' | 'evening' | 'night' | 'morning'; label: string; icon: string }

/** Часть суток по локальному часу. */
export function dayPart(h = new Date().getHours()): DayPart {
  if (h >= 17 && h < 22) return { key: 'evening', label: 'Вечер', icon: '🌇' };
  if (h >= 22 || h < 6)  return { key: 'night',   label: 'Ночь',  icon: '🌙' };
  if (h < 11)            return { key: 'morning', label: 'Утро',  icon: '🌅' };
  return { key: 'day', label: 'День', icon: '☀️' };
}

/** Сдвиг акцента по части суток: [дельта hue, дельта насыщенности, дельта яркости] в HSL. */
const PART_SHIFT: Record<DayPart['key'], [number, number, number]> = {
  morning: [ 18,  0,  6], // холоднее (в сторону голубого) + чуть ярче
  day:     [  0,  0,  0],
  evening: [-28,  4,  8], // теплее (в сторону красного)
  night:   [ 10, -8, -14], // приглушённее и темнее
};

function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let h = 0, s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)); l = Math.max(0, Math.min(100, l));
  const c = (1 - Math.abs(2 * l / 100 - 1)) * (s / 100);
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l / 100 - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * Эффективный акцент с учётом времени суток. part привязан к часу (если не
 * передан — текущий). Шаг между сутками мягкий: 1 час — не сдвигает, чтобы
 * не было заметного «тика» в течение часа.
 */
export function accentAtHour(hex: string, hour = new Date().getHours()): string {
  const [dH, dS, dL] = PART_SHIFT[dayPart(hour).key];
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h + dH, s + dS, l + dL);
}

// ── Светлая тема ─────────────────────────────────────────────────────────────
// Цвета интерфейса подобраны под тёмный фон: неоновый зелёный, жёлтый, циан на светлом фоне не читаются.
// В светлой теме тот же тон затемняется до читаемого контраста.

/** Фон светлой темы. Должен совпадать с --bg для [data-theme="light"] в index.css. */
export const LIGHT_BG = '#f2f4f8';

function linearChannel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Относительная яркость цвета #rrggbb по WCAG: 0 — чёрный, 1 — белый. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * linearChannel((n >> 16) & 255) + 0.7152 * linearChannel((n >> 8) & 255) + 0.0722 * linearChannel(n & 255);
}

/** Контраст двух цветов #rrggbb по WCAG: от 1 (одинаковые) до 21 (чёрный на белом). */
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Тот же тон и насыщенность, но достаточно тёмный, чтобы читаться на светлом фоне (контраст не ниже min). */
export function readableOnLight(hex: string, min = 4.5): string {
  if (contrast(hex, LIGHT_BG) >= min) return hex;
  const [h, s, l] = hexToHsl(hex);
  for (let light = Math.floor(l); light >= 0; light--) {
    const candidate = hslToHex(h, s, light);
    if (contrast(candidate, LIGHT_BG) >= min) return candidate;
  }
  return '#000000';
}

let lightTheme = false;
const readableCache = new Map<string, string>();

/** Сообщает утилитам цвета, какая тема включена. Вызывает ThemeContext до отрисовки интерфейса. */
export function setLightTheme(on: boolean): void { lightTheme = on; }

/**
 * Цвет для текста, значков и тонких линий поверх фона темы: в тёмной теме — как есть, в светлой — затемнённый до
 * читаемого. Понимает только #rrggbb; всё остальное (var(--accent), rgba(…)) возвращает без изменений — акцент
 * ThemeContext затемняет сам. Результат остаётся #rrggbb, к нему можно дописывать альфу (withAlpha).
 * min — нужный контраст: 4.5 для текста; для колец, значков и полос хватает GRAPHIC_CONTRAST — цвет остаётся ярче.
 */
export function onTheme(color: string, min = 4.5): string {
  if (!lightTheme || !/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  const key = `${color}/${min}`;
  let mapped = readableCache.get(key);
  if (!mapped) { mapped = readableOnLight(color, min); readableCache.set(key, mapped); }
  return mapped;
}

/** Контраст для графики (кольцо медальона, значки, полосы): по WCAG достаточно 3, текстовые 4.5 делают цвет тусклым. */
export const GRAPHIC_CONTRAST = 3;

export function withAlpha(color: string, hex2: string): string {
  if (typeof color === 'string' && color.includes('var(--accent')) {
    const a = (Number.parseInt(hex2, 16) / 255).toFixed(3);
    return `rgba(var(--accent-rgb),${a})`;
  }
  return `${color}${hex2}`;
}
