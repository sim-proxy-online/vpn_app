import { useState } from 'react';
import { Power, Check, Loader2 } from 'lucide-react';
import { withAlpha } from '../utils/color';
import { ConnectionState } from '../types';
import { MOOD_COLOR, moodFor, type Mood } from '../utils/mood';
import { MascotDisc, MoodAccessories } from './MascotMood';

interface ConnectMedallionProps {
  state: ConnectionState;
  onToggle: () => void;
  /** Подсказка под заголовком, например ход автоподбора обхода («попытка 2 из 3: …»). */
  hint?: string | null;
  /** Последняя попытка подключения не удалась: Петрович озадачен, кольцо красное, медальон вздрагивает. */
  error?: boolean;
}

const BRAND_GOLD = '#e9c46a';
const BRAND_BLUE = '#2f7fe6';

/** Цвет состояния: кольцо, свечение и значок кнопки. */
function stateColor(state: ConnectionState, mood: Mood): string {
  if (mood === 'confused') return MOOD_COLOR.confused;
  switch (state) {
    case 'connected': return '#00e08a';
    case 'verifying': return '#ffd23f';
    case 'reconnecting': return '#b46bff';
    case 'disconnecting': return '#ff7a3d';
    default: return 'var(--accent)';
  }
}

const TEXT: Record<ConnectionState, { title: string; sub: string }> = {
  disconnected:  { title: 'Подключить',  sub: 'Нажмите на Петровича, чтобы включить защиту' },
  connecting:    { title: 'Запуск…',     sub: 'Поднимаю защищённое соединение' },
  verifying:     { title: 'Проверка…',   sub: 'Проверяю, что связь работает' },
  reconnecting:  { title: 'Повтор…',     sub: 'Восстанавливаю соединение' },
  disconnecting: { title: 'Остановка…',  sub: 'Отключаю защиту' },
  connected:     { title: 'Защищено',    sub: 'Весь трафик идёт через VPN' },
};

const TEXT_ERROR = { title: 'Не получилось', sub: 'Нажмите ещё раз или выберите другой сервер' };

// Кольцо толщиной в 4 px из градиента: маска вырезает середину. Префикс -webkit- нужен старым WebView.
const RING_MASK = 'radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px))';

/**
 * Главная кнопка: Петрович в медальоне. Его настроение зависит от состояния (см. utils/mood.ts): не защищено — мёрзнет,
 * идёт запуск — задумался и вокруг расходится радар, защищено — большой палец вверх, кольцо и свечение медленно дышат,
 * ошибка — озадачен, кольцо красное, медальон вздрагивает.
 */
export default function ConnectMedallion({ state, onToggle, hint, error = false }: ConnectMedallionProps) {
  const [clickDisabled, setClickDisabled] = useState(false);
  const isConnected = state === 'connected';
  const isProcessing = state === 'connecting' || state === 'verifying' || state === 'disconnecting' || state === 'reconnecting';
  const mood = moodFor(state, error);
  const isConfused = mood === 'confused';
  const color = stateColor(state, mood);
  const text = isConfused ? TEXT_ERROR : TEXT[state];

  const handleClick = () => {
    if (clickDisabled || (isProcessing && state !== 'reconnecting')) return;
    setClickDisabled(true);
    onToggle();
    // Защита от быстрых повторных нажатий, пока состояние ещё не обновилось.
    setTimeout(() => setClickDisabled(false), 800);
  };

  const ringBackground = isConnected || isProcessing || isConfused
    ? `conic-gradient(from 0deg, ${color}, ${withAlpha(color, isConfused ? '66' : '22')} 35%, ${color} 70%, ${withAlpha(color, isConfused ? '66' : '22')} 100%)`
    : `conic-gradient(from 210deg, ${BRAND_GOLD}, ${BRAND_BLUE}, var(--accent), ${BRAND_GOLD})`;

  return (
    <div className="flex flex-col items-center gap-7">
      {/* key меняется при появлении ошибки: медальон вздрагивает один раз */}
      <div key={isConfused ? 'error' : 'ok'} className={`relative ${isConfused ? 'sim-shake' : ''}`}>
        {/* Мягкое свечение цвета состояния; у защищённого дышит */}
        <div
          className={`absolute -inset-10 rounded-full blur-3xl pointer-events-none transition-opacity duration-500 ${isConnected ? 'sim-breathe' : ''}`}
          style={{ background: `radial-gradient(circle, ${withAlpha(color, '55')}, transparent 65%)`, opacity: isConnected || isProcessing || isConfused ? 0.55 : 0.22 }}
        />

        {/* Радар: пока идёт запуск, от медальона расходятся кольца */}
        {isProcessing && (
          <>
            <span aria-hidden className="absolute inset-0 rounded-full border-2 pointer-events-none sim-radar" style={{ borderColor: withAlpha(color, '99') }} />
            <span aria-hidden className="absolute inset-0 rounded-full border-2 pointer-events-none sim-radar" style={{ borderColor: withAlpha(color, '99'), animationDelay: '1.2s' }} />
          </>
        )}

        <button
          onClick={handleClick}
          disabled={(isProcessing && state !== 'reconnecting') || clickDisabled}
          aria-label={isConnected ? 'Отключить VPN' : 'Подключить VPN'}
          aria-pressed={isConnected}
          className="relative z-10 block w-[216px] h-[216px] sm:w-[240px] sm:h-[240px] rounded-full select-none cursor-pointer disabled:cursor-wait transition-transform duration-150 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)]"
        >
          {/* Кольцо: вращается во время запуска, у подключённого дышит */}
          <span
            className={`absolute inset-0 rounded-full ${isProcessing ? 'animate-[spin_2.4s_linear_infinite] motion-reduce:animate-none' : isConnected ? 'sim-pulse-opacity motion-reduce:animate-none' : ''}`}
            style={{ background: ringBackground, WebkitMask: RING_MASK, mask: RING_MASK }}
          />

          {/* Медальон */}
          <span
            className="absolute inset-[9px] rounded-full overflow-hidden flex items-center justify-center"
            style={{
              background: `radial-gradient(circle at 50% 35%, #1b2250 0%, #0c1030 70%)`,
              boxShadow: mood === 'cold'
                ? 'inset 0 0 42px rgba(140,200,255,0.30), 0 14px 40px -10px #000000aa'
                : `inset 0 0 36px ${withAlpha(color, isConnected || isConfused ? '40' : '18')}, 0 14px 40px -10px #000000aa`,
            }}
          >
            <MascotDisc mood={mood} color={color} />
          </span>

          {/* Приметы настроения за пределами круга: облачко мысли, вопрос с каплей, «брр» */}
          <MoodAccessories mood={mood} color={mood === 'thinking' ? color : MOOD_COLOR[mood]} />

          {/* Кнопка-значок на нижнем крае кольца */}
          <span
            className="absolute left-1/2 -bottom-4 -translate-x-1/2 w-[58px] h-[58px] rounded-full flex items-center justify-center border-[3px]"
            style={{
              background: '#0a0a1a',
              borderColor: color,
              color,
              boxShadow: `0 0 22px ${withAlpha(color, '66')}, 0 6px 16px #000000aa`,
            }}
          >
            {isProcessing ? <Loader2 size={24} className="animate-spin" /> : isConnected ? <Check size={26} strokeWidth={3} /> : <Power size={25} strokeWidth={2.4} />}
          </span>
        </button>
      </div>

      <div className="text-center z-10 max-w-[300px] min-h-[64px] pt-2">
        <p className="text-[26px] leading-none font-extrabold tracking-tight" style={{ color }}>
          {text.title}
        </p>
        <p className="mt-2 text-[13px] leading-snug text-gray-300">
          {hint && isProcessing ? hint : text.sub}
        </p>
      </div>
    </div>
  );
}
