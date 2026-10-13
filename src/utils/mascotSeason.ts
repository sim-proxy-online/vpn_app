/**
 * Сезонная подмена картинки Петровича: в каждом сезоне два варианта,
 * из которых при старте приложения выбирается один:
 *   зима (дек–фев)  — парка с вязаной шапкой / ушанка со свитером;
 *   весна (мар–май) — венок из цветов / кепка;
 *   лето (июн–авг)  — соломенная шляпа с цветной рубашкой / пляжная рубашка;
 *   осень (сен–ноя) — осенняя куртка с кленовым листом / коричневый свитер.
 * Выбор запоминается на сессию, чтобы навигация, онбординг и медальон на главной
 * показывали одного и того же Петровича.
 * Чистая логика (юнит-тесты); картинку рисуют MascotMood / BottomNav / Onboarding.
 */
import mascotWinter1 from '../assets/mascot-winter-1.png';
import mascotWinter2 from '../assets/mascot-winter-2.png';
import mascotSpring1 from '../assets/mascot-spring-1.png';
import mascotSpring2 from '../assets/mascot-spring-2.png';
import mascotSummer1 from '../assets/mascot-summer-1.png';
import mascotSummer2 from '../assets/mascot-summer-2.png';
import mascotAutumn1 from '../assets/mascot-autumn-1.png';
import mascotAutumn2 from '../assets/mascot-autumn-2.png';
import { currentSeason, type Season } from './idlePhrases';

export const MASCOT_BY_SEASON: Record<Season, readonly string[]> = {
  winter: [mascotWinter1, mascotWinter2],
  spring: [mascotSpring1, mascotSpring2],
  summer: [mascotSummer1, mascotSummer2],
  autumn: [mascotAutumn1, mascotAutumn2],
};

/** Чистый выбор картинки: пул сезона, rnd приходит снаружи (в приложении — Math.random, в тестах — заглушка). */
export function pickMascot(season: Season = currentSeason(), rnd: () => number = Math.random): string {
  const pool = MASCOT_BY_SEASON[season];
  const i = Math.floor(rnd() * pool.length);
  return pool[Math.min(pool.length - 1, Math.max(0, i))];
}

let cached: string | undefined;

/** Выбор на сессию: один раз при первом обращении, дальше тот же адрес у всех потребителей. */
export function sessionMascot(): string {
  return (cached ??= pickMascot());
}
