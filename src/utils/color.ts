// Безопасное добавление альфы к цвету.
// Обычный hex-цвет («#00ff88») просто дополняется суффиксом («#00ff8820»).
// Акцент задан как CSS-переменная var(--accent) — к ней нельзя дописать hex,
// поэтому возвращаем rgba(var(--accent-rgb),a), используя канальную переменную.
export function withAlpha(color: string, hex2: string): string {
  if (typeof color === 'string' && color.includes('var(--accent')) {
    const a = (Number.parseInt(hex2, 16) / 255).toFixed(3);
    return `rgba(var(--accent-rgb),${a})`;
  }
  return `${color}${hex2}`;
}
