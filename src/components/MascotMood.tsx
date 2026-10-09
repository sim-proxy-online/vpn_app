import mascot from '../assets/mascot.png';
import { withAlpha } from '../utils/color';
import { MOOD_COLOR, type Mood } from '../utils/mood';

/**
 * Петрович с настроением. Картинка одна (маскот бренда), настроение даёт то, что нарисовано вокруг и поверх него:
 * иней и снег, мысль-облачко, искры радости, знак вопроса и капля пота. Ничего не перерисовывается, поэтому герой
 * всегда узнаваем. Все движения отключаются при системной настройке «уменьшить движение» (см. index.css).
 *
 * MascotDisc лежит внутри круга-медальона (родитель обрезает по кругу и центрирует), MoodAccessories — снаружи
 * него, в углах контейнера: родитель должен быть position:relative и не обрезать содержимое.
 */

const FILTER: Record<Mood, string> = {
  cold: 'grayscale(0.3) saturate(0.85) brightness(0.84) contrast(0.96)',
  thinking: 'saturate(0.95) brightness(0.97)',
  happy: 'saturate(1.1)',
  confused: 'saturate(0.85) brightness(0.9)',
};

const MOTION: Record<Mood, string> = {
  cold: 'sim-shiver',
  thinking: 'sim-sway',
  happy: 'sim-breathe',
  confused: '',
};

// Тонировка только по силуэту Петровича: маска — сама картинка.
const TINT: Partial<Record<Mood, string>> = {
  cold: 'linear-gradient(180deg, rgba(150,208,255,0.55), rgba(80,140,235,0.32))',
  confused: 'linear-gradient(180deg, rgba(255,95,110,0.26), rgba(255,95,110,0.10))',
};

const SNOW = [
  { left: 8, size: 5, dur: 4.6, delay: 0, drift: 10 }, { left: 17, size: 3, dur: 3.8, delay: 1.1, drift: -8 },
  { left: 27, size: 6, dur: 5.2, delay: 2.2, drift: 12 }, { left: 38, size: 3, dur: 4.1, delay: 0.5, drift: -10 },
  { left: 48, size: 5, dur: 4.9, delay: 1.7, drift: 9 }, { left: 58, size: 4, dur: 4.4, delay: 3.1, drift: -9 },
  { left: 68, size: 6, dur: 5.4, delay: 2.9, drift: -12 }, { left: 78, size: 3, dur: 4.0, delay: 0.9, drift: 8 },
  { left: 88, size: 5, dur: 4.7, delay: 2.4, drift: -9 }, { left: 95, size: 3, dur: 4.3, delay: 1.4, drift: 7 },
];

/** Сосульки по верхнему краю медальона: холод виден сразу, даже когда снежинки не в кадре. */
function Icicles() {
  return (
    <svg aria-hidden viewBox="0 0 100 20" preserveAspectRatio="none" className="absolute left-0 top-0 w-full pointer-events-none" style={{ height: '17%' }}>
      <defs>
        <linearGradient id="sim-ice" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#9fd6ff" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      <path
        d="M0 0 H100 V3 L96.5 13 L93 3 L88 17 L82.5 3 L77 11 L71.5 3 L65 19 L59 3 L53 12 L47 3 L41 16 L35 3 L29 10 L23 3 L17 14 L11 3 L6 12 L2.5 3 L0 6 Z"
        fill="url(#sim-ice)"
      />
    </svg>
  );
}

function Snow() {
  return (
    <span aria-hidden className="absolute inset-0 overflow-hidden pointer-events-none">
      <Icicles />
      {SNOW.map((f, i) => (
        <span
          key={i}
          className="absolute rounded-full sim-snow"
          style={{
            left: `${f.left}%`, top: 0, width: f.size, height: f.size, background: '#eaf6ff', opacity: 0,
            animationDuration: `${f.dur}s`, animationDelay: `${f.delay}s`, ['--drift' as string]: `${f.drift}px`,
          }}
        />
      ))}
    </span>
  );
}

function Star({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} style={style}>
      <path d="M12 0 L14.6 9.4 L24 12 L14.6 14.6 L12 24 L9.4 14.6 L0 12 L9.4 9.4 Z" fill="currentColor" />
    </svg>
  );
}

const TWINKLES = [
  { top: '14%', left: '17%', size: 15, delay: 0 }, { top: '22%', right: '13%', size: 11, delay: 0.8 },
  { top: '56%', left: '9%', size: 9, delay: 1.5 }, { top: '9%', right: '34%', size: 8, delay: 2.0 },
];

function Twinkles() {
  return (
    <span aria-hidden className="absolute inset-0 pointer-events-none" style={{ color: '#fff1a8' }}>
      {TWINKLES.map((t, i) => (
        <Star
          key={i}
          className="absolute sim-twinkle"
          style={{ top: t.top, left: t.left, right: t.right, width: t.size, height: t.size, animationDelay: `${t.delay}s`, filter: 'drop-shadow(0 0 4px #ffe27a)' }}
        />
      ))}
    </span>
  );
}

/** Радарный луч: тонкий вращающийся сектор поверх медальона. */
function Sweep({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="absolute inset-0 rounded-full pointer-events-none sim-sweep"
      style={{ background: `conic-gradient(from 0deg, transparent 0deg 300deg, ${withAlpha(color, '22')} 340deg, ${withAlpha(color, '77')} 360deg)`, mixBlendMode: 'screen' }}
    />
  );
}

/** Сам Петрович и эффекты внутри круга. */
export function MascotDisc({ mood, color = MOOD_COLOR[mood] }: { mood: Mood; color?: string }) {
  const tint = TINT[mood];
  return (
    <>
      <span className={`block relative w-[86%] h-[86%] ${MOTION[mood]}`}>
        <img
          src={mascot}
          alt=""
          draggable={false}
          className="w-full h-full object-contain pointer-events-none"
          style={{ filter: mood === 'happy' ? `${FILTER.happy} drop-shadow(0 6px 14px ${withAlpha(color, '55')})` : FILTER[mood] }}
        />
        {tint && (
          <span
            aria-hidden
            className="absolute inset-0 pointer-events-none"
            style={{
              background: tint, mixBlendMode: 'screen',
              WebkitMaskImage: `url(${mascot})`, maskImage: `url(${mascot})`,
              WebkitMaskSize: 'contain', maskSize: 'contain', WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
              WebkitMaskPosition: 'center', maskPosition: 'center',
            }}
          />
        )}
      </span>
      {mood === 'cold' && <Snow />}
      {mood === 'thinking' && <Sweep color={color} />}
      {mood === 'happy' && <Twinkles />}
    </>
  );
}

/** Облачко мысли с бегущими точками: три кружка тянутся к голове. */
function ThoughtBubble({ color }: { color: string }) {
  return (
    <span aria-hidden className="absolute pointer-events-none" style={{ top: '-7%', right: '-7%', width: '44%', height: '34%' }}>
      <span className="absolute rounded-full" style={{ left: '6%', bottom: '2%', width: '9%', aspectRatio: '1', background: withAlpha(color, 'cc') }} />
      <span className="absolute rounded-full" style={{ left: '17%', bottom: '17%', width: '13%', aspectRatio: '1', background: withAlpha(color, 'cc') }} />
      <span
        className="absolute rounded-[999px] flex items-center justify-center gap-[7%]"
        style={{ right: 0, top: 0, width: '84%', height: '66%', background: '#10143a', border: `2px solid ${withAlpha(color, 'cc')}`, boxShadow: `0 4px 14px #000000aa, 0 0 14px ${withAlpha(color, '44')}` }}
      >
        {[0, 1, 2].map((i) => (
          <span key={i} className="rounded-full sim-dots" style={{ width: '12%', aspectRatio: '1', background: color, animationDelay: `${i * 0.18}s` }} />
        ))}
      </span>
    </span>
  );
}

/** Знак вопроса над головой и капля пота на лбу. */
function ConfusedMarks({ color }: { color: string }) {
  return (
    <>
      <span
        aria-hidden
        className="absolute pointer-events-none flex items-center justify-center sim-wobble"
        style={{
          top: '-8%', right: '-4%', width: '34%', aspectRatio: '1', borderRadius: '50%',
          background: '#10143a', border: `2px solid ${withAlpha(color, 'cc')}`, boxShadow: `0 4px 14px #000000aa, 0 0 14px ${withAlpha(color, '44')}`,
        }}
      >
        <svg viewBox="0 0 24 24" style={{ width: '62%', height: '62%' }} fill="none" stroke={color} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8.6 8.9a3.5 3.5 0 0 1 6.8 1.1c0 2.4-3.4 3.2-3.4 5.2" />
          <path d="M12 19.6h.01" />
        </svg>
      </span>
      <svg
        aria-hidden viewBox="0 0 24 32"
        className="absolute pointer-events-none sim-drop"
        style={{ top: '19%', left: '24%', width: '8%', filter: 'drop-shadow(0 0 4px #7cc4ff88)' }}
      >
        <path d="M12 1 C12 1 3 13 3 20 a9 9 0 0 0 18 0 C21 13 12 1 12 1 Z" fill="#9fd6ff" />
      </svg>
    </>
  );
}

/** Приметы настроения снаружи круга: облачко мысли, вопрос с каплей, «брр» от холода. */
export function MoodAccessories({ mood, color = MOOD_COLOR[mood] }: { mood: Mood; color?: string }) {
  if (mood === 'thinking') return <ThoughtBubble color={color} />;
  if (mood === 'confused') return <ConfusedMarks color={color} />;
  if (mood === 'cold') {
    return (
      <span
        aria-hidden
        className="absolute pointer-events-none sim-shiver text-[11px] font-bold italic px-2.5 py-1 rounded-full"
        style={{ top: '2%', left: '-6%', color: '#cfe8ff', background: '#10143acc', border: `1px solid ${withAlpha(color, '77')}`, boxShadow: `0 0 12px ${withAlpha(color, '33')}` }}
      >
        брр…
      </span>
    );
  }
  return null;
}
