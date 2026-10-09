/**
 * Фирменный цвет провайдера из параметра color-profile (Happ, см. appManagement.ts).
 *
 * У Happ это тема интерфейса целиком: JSON с десятками цветов (#RRGGBBAA), обычный или в base64, либо «resetcolors».
 * Нам нужен один цвет — акцент: им подсвечивается карточка подписки и её значок. Берётся основной цвет кнопок
 * (buttonColor), а если его нет — первый пригодный из запасных ключей. Остальная тема не применяется: интерфейс
 * приложения остаётся нашим. Подписки без цвета выглядят как раньше.
 *
 * Цвет проверяется: только hex, прозрачность отбрасывается (почти прозрачные цвета не берутся), а слишком тёмный
 * осветляется — на нашем тёмном фоне он иначе не читался бы.
 */

const PRIORITY_KEYS = ['buttonColor', 'subsHeaderColor', 'selectedServerRowColor', 'profileWebPageIconColor'];
const ARRAY_KEYS = ['backgroundColors', 'elipseColors'];
const MAX_JSON_LENGTH = 16_384;
/** Минимальная яркость акцента на тёмном фоне (по шкале относительной яркости 0–1). */
const MIN_LUMINANCE = 0.2;
/** Цвета прозрачнее этого (альфа из #RRGGBBAA) не берутся. */
const MIN_ALPHA = 0x40;

interface Rgb { r: number; g: number; b: number }

function parseHex(v: unknown): { rgb: Rgb; alpha: number } | null {
  if (typeof v !== 'string') return null;
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { rgb: { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }, alpha: m[2] ? parseInt(m[2], 16) : 255 };
}

function toHex({ r, g, b }: Rgb): string {
  const h = (x: number) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Относительная яркость по WCAG: 0 — чёрный, 1 — белый. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Осветляет слишком тёмный цвет, подмешивая белый, пока он не станет читаемым на тёмном фоне. */
export function readableAccent(hex: string): string {
  const p = parseHex(hex);
  if (!p) return hex;
  let rgb = p.rgb;
  for (let i = 0; i < 20 && relativeLuminance(rgb) < MIN_LUMINANCE; i++) {
    rgb = { r: rgb.r + (255 - rgb.r) * 0.1, g: rgb.g + (255 - rgb.g) * 0.1, b: rgb.b + (255 - rgb.b) * 0.1 };
  }
  return toHex(rgb);
}

function decodeBase64Text(v: string): string | null {
  const s = v.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    const core = s.replace(/=+$/, '');
    const bin = atob(core + '='.repeat((4 - (core.length % 4)) % 4));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { return null; }
}

function firstColor(candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    const p = parseHex(c);
    if (p && p.alpha >= MIN_ALPHA) return readableAccent(toHex(p.rgb));
  }
  return undefined;
}

/**
 * Значение параметра color-profile. Возвращает { accent } (accent нет у «resetcolors» — цвет сбрасывается) или null,
 * если значение непригодно и его нужно отклонить.
 */
export function parseColorProfile(raw: string | undefined): { accent?: string } | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (/^resetcolors$/i.test(s)) return {};
  let text = s;
  if (/^base64:/i.test(text)) text = decodeBase64Text(text.slice(7)) ?? '';
  else if (!text.startsWith('{')) text = decodeBase64Text(text) ?? '';
  if (!text || text.length > MAX_JSON_LENGTH) return null;
  let theme: unknown;
  try { theme = JSON.parse(text); } catch { return null; }
  if (!theme || typeof theme !== 'object' || Array.isArray(theme)) return null;
  const t = theme as Record<string, unknown>;
  const candidates: unknown[] = PRIORITY_KEYS.map((k) => t[k]);
  for (const k of ARRAY_KEYS) if (Array.isArray(t[k])) candidates.push(...(t[k] as unknown[]));
  const accent = firstColor(candidates);
  return accent ? { accent } : null;
}
