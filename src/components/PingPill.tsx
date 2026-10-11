import { withAlpha } from '../utils/color';
import { pingTone } from '../utils/ping';

interface PingPillProps {
  /** undefined — ещё не мерили; отрицательное — нет ответа. */
  ms: number | undefined;
  /** Идёт замер: вместо числа бегущие полоски. */
  pending?: boolean;
  size?: 'sm' | 'md';
}

/**
 * Таблетка с пингом: цветные полоски качества и «831 мс». Цвет по шкале из utils/ping.ts —
 * зелёный до 100 мс, жёлтый до 250, оранжевый до 500, красный дальше.
 */
export default function PingPill({ ms, pending = false, size = 'md' }: PingPillProps) {
  const tone = pending ? { color: 'var(--accent)', level: 0 as const, label: '…' } : pingTone(ms);
  const small = size === 'sm';
  const heights = small ? [5, 8, 11] : [6, 9, 12];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-bold tabular-nums whitespace-nowrap ${small ? 'px-2 py-[3px] text-[11px]' : 'px-2.5 py-1 text-[12px]'}`}
      style={{ color: tone.color, background: withAlpha(tone.color, '1f'), borderColor: withAlpha(tone.color, '55') }}
      aria-label={pending ? 'Проверяю связь' : tone.label}
    >
      <span className="flex items-end gap-[2px]" aria-hidden>
        {heights.map((h, i) => (
          <span
            key={i}
            className={pending ? `sim-blink-${i + 1}` : undefined}
            style={{ width: small ? 2 : 3, height: h, borderRadius: 2, background: pending || i < tone.level ? tone.color : 'rgba(var(--ink-rgb),0.18)' }}
          />
        ))}
      </span>
      <span>{tone.label}</span>
    </span>
  );
}
