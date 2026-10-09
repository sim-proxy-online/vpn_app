/**
 * Настроение Петровича по состоянию подключения (MascotMood.tsx, ConnectMedallion.tsx):
 *  • cold     — не защищено: мёрзнет;
 *  • thinking — идёт запуск, проверка, повтор или остановка: задумался;
 *  • happy    — защищено: большой палец вверх;
 *  • confused — подключиться не получилось: озадачен.
 */
import type { ConnectionState } from '../types';

export type Mood = 'cold' | 'thinking' | 'happy' | 'confused';

export function moodFor(state: ConnectionState, hasError: boolean): Mood {
  if (state === 'connected') return 'happy';
  if (state === 'connecting' || state === 'verifying' || state === 'reconnecting' || state === 'disconnecting') return 'thinking';
  return hasError ? 'confused' : 'cold';
}

/** Цвет настроения: кольцо, свечение, подпись. */
export const MOOD_COLOR: Record<Mood, string> = {
  cold: '#6cb6ff',
  thinking: '#ffd23f',
  happy: '#00e08a',
  confused: '#ff5a6a',
};
