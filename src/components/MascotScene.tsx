import type { ReactNode } from 'react';
import { withAlpha, onTheme, GRAPHIC_CONTRAST } from '../utils/color';
import { MOOD_COLOR, type Mood } from '../utils/mood';
import { MascotDisc, MoodAccessories } from './MascotMood';

const RING_MASK = 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))';

/** Круглый портрет Петровича с настроением (то же, что на главной кнопке, но без кнопки). */
export function Portrait({ mood, size, accessories = true }: { mood: Mood; size: number; accessories?: boolean }) {
  const color = onTheme(MOOD_COLOR[mood], GRAPHIC_CONTRAST);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <span
        aria-hidden
        className="absolute inset-0 rounded-full"
        style={{ background: `conic-gradient(from 210deg, ${color}, ${withAlpha(color, '33')} 45%, ${color} 100%)`, WebkitMask: RING_MASK, mask: RING_MASK }}
      />
      <span
        className="absolute inset-[5px] rounded-full overflow-hidden flex items-center justify-center"
        style={{ background: 'var(--medal)', boxShadow: `inset 0 0 28px ${withAlpha(color, '30')}, var(--medal-drop)` }}
      >
        <MascotDisc mood={mood} color={color} />
      </span>
      {accessories && <MoodAccessories mood={mood} color={color} />}
    </div>
  );
}

/**
 * Пустое состояние с Петровичем и короткой подписью: нет подписок, закончился пробный период, пустой список.
 * Внутрь (children) кладутся действия — кнопка или ссылка.
 */
export function MascotScene({ mood, title, text, children, size = 150 }: { mood: Mood; title: string; text?: string; children?: ReactNode; size?: number }) {
  return (
    <div className="flex flex-col items-center text-center px-6 py-6 w-full">
      <Portrait mood={mood} size={size} />
      <p className="mt-6 text-[19px] leading-tight font-extrabold text-white">{title}</p>
      {text && <p className="mt-2 text-[13px] leading-snug text-gray-300 max-w-[290px]">{text}</p>}
      {children && <div className="mt-5 w-full flex flex-col items-center">{children}</div>}
    </div>
  );
}

/** Короткая заметка с маленьким Петровичем — для предупреждений над основным содержимым («нет сети»). */
export function MascotNote({ mood, title, text }: { mood: Mood; title: string; text?: string }) {
  const color = MOOD_COLOR[mood];
  return (
    <div
      className="flex items-center gap-3.5 rounded-2xl px-3.5 py-3 w-full border"
      style={{ background: withAlpha(color, '12'), borderColor: withAlpha(color, '44') }}
      role="status"
    >
      <Portrait mood={mood} size={52} accessories={false} />
      <div className="min-w-0 text-left">
        <p className="text-[14px] font-bold leading-tight" style={{ color: onTheme(color) }}>{title}</p>
        {text && <p className="mt-1 text-[12px] leading-snug text-gray-300">{text}</p>}
      </div>
    </div>
  );
}
