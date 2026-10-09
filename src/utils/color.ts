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
  for (const a of ACCENT_ALPHAS) vars[`--accent-a${a}`] = hex + a;
  return vars;
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

export function withAlpha(color: string, hex2: string): string {
  if (typeof color === 'string' && color.includes('var(--accent')) {
    const a = (Number.parseInt(hex2, 16) / 255).toFixed(3);
    return `rgba(var(--accent-rgb),${a})`;
  }
  return `${color}${hex2}`;
}
