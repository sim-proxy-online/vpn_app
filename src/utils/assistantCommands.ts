// ── Петрович-ассистент: распознавание команд пользователя ───────────────────
// Чистая логика: по фразе на человеческом языке определить, что пользователь
// хочет, чтобы Петрович сделал. Без DOM/натива — юнит-тестируется.
//
// Как это работает. Фраза нормализуется, затем КАЖДОЕ намерение набирает очки
// за свои слова-маркеры, побеждает лучшее (при ничьей — приоритет из PRIORITY).
// Так длинные сообщения («привет, слушай, банки опять не пускают, ну сделай
// что-нибудь») распознаются по смыслу, а не по точному совпадению.
//
// ВАЖНО: \b (word boundary) в JS ломается на кириллице (кириллица не входит в
// \w), поэтому маркеры ищем подстрокой через hasAny, а не регулярками с \b.

import { stripLeadingEmoji } from './nodeName';
import type { ServerNode } from '../types';

export type AssistantCommand =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'restart' }
  | { type: 'shield-on' }
  | { type: 'shield-off' }
  | { type: 'diagnose' }
  | { type: 'update-sub' }
  | { type: 'status' }
  | { type: 'help' }
  | { type: 'chat' }
  | { type: 'greet' }
  | { type: 'thanks' }
  | { type: 'switch-node'; query: string }; // '' — unclear target, 'best' — the most lively one

/** Снижает фразу: строчные, ё→е, пунктуация в пробелы, схлопываем пробелы. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,!?;:"'`()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** true если t содержит хоть одно из слов (без \b — кириллица). */
function hasAny(t: string, words: string[]): boolean {
  return words.some(w => t.includes(w));
}

/** Расстояние Левенштейна (слова короткие — полный матричный вариант ок). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Нечёткий hasAny: быстрые подстроки как обычно, плюс слова фразы сравниваются
 * со СЛОВАМИ маркера (len≥5, чистые буквы/цифры) по Левенштейну — «имунитет»,
 * «падписка», «не рабтает», «перазапустить». Короткие слова (<5) не трогаем:
 * «стоп»≈«стол» — ложные срабатывания дороже.
 */
/**
 * Нечёткий hasAny: подстрока как обычно, плюс слово фразы сравнивается с
 * маркером по «окну» (лишние буквы флексий обрезаются) — «праверь»≈«провер»,
 * «имунитет»≈«иммунитет», «перазапусти»≈«перезапусти». Маркеры <6 букв и
 * со словами/дефисами не трогаем: «стоп»≈«стол» — ложные срабатывания дороже.
 */
function hasAnyFuzzy(t: string, words: string[], tokens: string[]): boolean {
  for (const w of words) {
    if (t.includes(w)) return true; // быстрое попадание
    if (w.length < 6 || !/^[а-яa-z0-9]+$/.test(w)) continue;
    const tol = w.length >= 8 ? 2 : 1;
    for (const tok of tokens) {
      if (tok.length < 5 || Math.abs(tok.length - w.length) > 3) continue;
      // сравниваем равные окна: «праверь»[:6]='правер' vs «провер» — расстояние 1
      const n = Math.min(w.length, tok.length);
      if (levenshtein(tok.slice(0, n), w.slice(0, n)) <= tol) return true;
    }
  }
  return false;
}

// ── Тематические слова для «понять по смыслу» ────────────────────────────────
// Если ни один маркер не попал, но фраза явно про сеть/VPN/сервисы — почти
// наверняка жалоба или просьба починить: честнее предложить диагностику.
const NETISH = ['интернет', 'vpn', 'впн', 'туннел', 'сеть', 'сетк', 'инет', 'связ', 'трафик', 'соедин',
  'ютуб', 'youtube', 'гугл', 'google', 'телеграм', 'telegram', 'ватсап', 'whatsapp', 'дискорд', 'discord',
  'нетфликс', 'netflix', 'сайты', 'сайт', 'лагает', 'пинг', 'медленн', 'глюч', 'баг', 'ошибк', 'error',
  'connection', 'dns', 'домен', 'приватн', 'прокси'];
function isNetish(t: string): boolean {
  return hasAny(t, NETISH) || /(^|\s)(ip|айпи)(\s|$)/.test(t);
}

// ── Маркеры намерений ────────────────────────────────────────────────────────
// Короткие «основы» слов — ловят весь выводной веер («подключи/подключить/
// подключись»). Нарочно с запасом: лишнее попадание отсеивает скоринг.
const OFF = ['выключ', 'отключ', 'останов', 'стоп', 'сним', 'гас', 'убер', 'выруб', 'деактив'];
const IMMUNE = ['иммунитет', 'фильтр']; // «щит» проверяется отдельно, по началу слова:
// подстрочное «щит» ловит и «защиту» — «выключи защиту» стало бы «выключи Иммунитет».
const VPNISH = ['vpn', 'впн', 'туннел', 'соедин', 'защит'];
const BANK = ['банк', 'сбер', 'тинькоф', 'альфа', 'втб', 'озон', 'госусл', 'налог'];
const BANK_SEE = ['вид', 'слыш', 'определя', 'блок', 'пуст', 'пуска', 'отказ', 'режет', 'душит', 'лов'];
const CONNECT = ['подключ', 'включ', 'соедин', 'коннект', 'стартуй', 'го vpn', 'давай vpn', 'восстанов'];
const RESTART = ['перезапуст', 'ребут', 'restart', 'рестарт', 'перезагруз'];
const UPDATE = ['обнов', 'свеж', 'перезалей', 'отвежи'];
const SUB = ['подпис', 'профил', 'узл', 'сервер', 'ссылк'];
const DIAG = ['провер', 'диагност', 'почему', 'что не так', 'что случилось', 'не работает', 'не пашет', 'не запуска', 'не включается', 'не открыв', 'не грузит', 'не подним', 'не подкл', 'не коннект', 'отвал', 'сломал', 'лагает', 'тормоз', 'тупит', 'не видно', 'пропал', 'пропала', 'не идет', 'не идёт', 'не держит', 'вылетает',
  // обрывы и «почини» — тоже симптом: чат обязан отреагировать, а не молчать
  'connection reset', 'connection refused', 'обрыва', 'сбрасыва', 'рвет', 'рвёт', 'упал', 'почин'];
const STATUS = ['статус', 'состояни', 'как там', 'жив ли', 'работает ли', 'пашет ли', 'что с'];
const SWITCH_VERBS = ['смени', 'сменить', 'переключ', 'подключись', 'выбери', 'возьми', 'уведи', 'переез'];
const BEST = ['лучш', 'быстр', 'топ', 'свеж', 'живой', 'живее', 'самый'];
const HELP = ['что умеешь', 'че умеешь', 'умеешь', 'что ты можешь', 'чем помогаешь', 'помощь', 'помог', 'справк', 'команды', 'как пользоваться', 'как ты работаешь', 'инструкц', 'что-нибудь', 'что нибудь'];
const SMALL = ['как дела', 'как сам', 'как жизнь', 'ты кто', 'кто ты', 'расскажи о себе', 'что нового', 'как настроение'];
const GREET = ['привет', 'здравств', 'здорово', 'дарова', 'хай', 'приветств', 'добрый день', 'доброе утро', 'добрый вечер', 'салют', 'здаров'];
const THANKS = ['спасибо', 'благодар', 'спс', 'спасиб'];

/** Что НЕ является названием узла («смени на иммунитет» — это про фильтр). */
const NON_NODE_WORDS = ['иммунитет', 'фильтр', 'щит', 'проверк', 'диагност', 'подписк', 'третий', 'пробн', 'узел', 'узла', 'узле', 'узлы', 'узлов', 'сервер', 'сервера', 'vpn', 'впн', 'защит', 'другой', 'самый', 'новый'];

/** Разрешение одинаково не стоит — приоритет при равных очках. */
const PRIORITY: AssistantCommand['type'][] = [
  'shield-off', 'shield-on', 'disconnect', 'restart', 'update-sub',
  'switch-node', 'diagnose', 'status', 'connect', 'help', 'chat', 'greet', 'thanks',
];

/**
 * Мягкое сравнение названия узла и запроса: точное вхождение в любую сторону,
 * а для кириллицы ещё и общий префикс ≥6 букв на уровне СЛОВА — падежи
 * («хочу Финляндию» ≈ «Финляндия», а «сделай быстро финляндию» тоже ловим).
 */
export function looseNameMatch(hay: string, needle: string): boolean {
  const h = normalize(hay);
  const n = normalize(needle);
  if (!h || !n) return false;
  if (h.includes(n) || n.includes(h)) return true;
  if (n.length < 6) return false;
  const pref = n.slice(0, 6);
  if (/[а-я]{6}/.test(n) && h.split(' ').some(w => w.startsWith(pref))) return true;
  // и опечатки: «филандию» ≈ «финляндия» (расстояние ≤2 для длинных названий)
  const tol = n.length >= 8 ? 2 : 1;
  return h.split(' ').some(w => Math.abs(w.length - n.length) <= tol && levenshtein(w, n) <= tol);
}

/** true если в фразе есть приветствие — чат добавит «Привет!» к ответу. */
export function hasGreeting(input: string): boolean {
  return hasAny(normalize(input), GREET);
}

/** Подсказки-названия узлов для распознавания «хочу Финляндию» без глагола. */
export function nodeHints(nodes: ServerNode[]): string[] {
  const set = new Set<string>();
  for (const n of nodes) {
    const src = [stripLeadingEmoji(n.name || ''), n.flag || ''].join(' ');
    for (const tok of normalize(src).split(/[^a-zа-я0-9]+/)) {
      if (tok.length >= 2 && !NON_NODE_WORDS.some(w => tok.includes(w))) set.add(tok);
    }
  }
  return [...set];
}

/**
 * Определяет команду по фразе. nodeHints — названия/флаги узлов (тогда
 * «го германию» понимается без глаголов). Не распознано — null.
 */
export function matchCommand(input: string, nodeHints: string[] = []): AssistantCommand | null {
  const t = normalize(input);
  if (!t) return null;

  const score = new Map<AssistantCommand['type'], { cmd: AssistantCommand; s: number }>();
  const add = (cmd: AssistantCommand, s: number) => {
    const cur = score.get(cmd.type);
    if (!cur || s > cur.s) score.set(cmd.type, { cmd, s });
  };

  // «руб…», «щит» — только как начало слова: иначе «защиту» содержало бы «щит»
  // внутри себя, а «вырубали» попадало бы мимо маркеров.
  const tokens = t.split(' ');
  const F = (words: string[]) => hasAnyFuzzy(t, words, tokens); // нечёткий hasAny
  const off = F(OFF) || tokens.some(w => w.startsWith('руб'));
  const immune = F(IMMUNE) || tokens.some(w => w.startsWith('щит'));
  if (immune) add({ type: off ? 'shield-off' : 'shield-on' }, 5);
  if (F(BANK)) add({ type: 'shield-on' }, hasAny(t, BANK_SEE) ? 5 : 3);
  if (off && !immune && hasAny(t, VPNISH)) add({ type: 'disconnect' }, 4);
  if (hasAny(t, CONNECT)) add({ type: 'connect' }, 2);
  if (F(RESTART)) add({ type: 'restart' }, 3);
  if (F(UPDATE)) add({ type: 'update-sub' }, hasAny(t, SUB) ? 3 : 1.5);
  if (hasAny(t, DIAG) || F(DIAG)) add({ type: 'diagnose' }, 3);
  if (F(STATUS)) add({ type: 'status' }, 3);
  if (hasAny(t, HELP)) add({ type: 'help' }, 3);
  // Вопросы про баланс/айпи — тоже разговор, на них отвечает smallTalk.
  if (/(^|\s)(айпи|ip)(\s|$)/.test(t) || hasAny(t, ['гигабайт', 'гиг', 'трафик', 'лимит', 'остаток'])) add({ type: 'chat' }, 2);
  if (hasAny(t, SMALL)) add({ type: 'chat' }, 2);
  if (F(GREET)) add({ type: 'greet' }, 2);
  if (F(THANKS)) add({ type: 'thanks' }, 2);

  const sw = matchSwitchNode(t, nodeHints);
  if (sw) add(sw.cmd, sw.s);

  // «на самый быстрый» / «самый живой» — без уточнения страны. Вопрос («какой
  // самый быстрый?») — не заявка на переключение.
  if (hasAny(t, BEST) && hasAny(t, ['самый', 'топ', 'луч']) && !hasAny(t, DIAG) && !hasAny(t, ['какой', 'котор', 'что ', 'как '])) {
    add({ type: 'switch-node', query: 'best' }, 3);
  }

  let best: { cmd: AssistantCommand; s: number } | null = null;
  for (const type of PRIORITY) {
    const hit = score.get(type);
    if (hit && (!best || hit.s > best.s)) best = hit;
  }
  if (best) return best.cmd;

  // ── Смысловой fallback: молчать — не вариант ──
  // Ни один маркер не попал, но фраза явно про сеть/VPN/сервисы → почти
  // наверняка жалоба: предлагаем диагностику. Просто вопрос без маркеров →
  // помощь. Настоящий мусор («sdflk jdsf») остаётся null — чат честно
  // переспросит.
  if (isNetish(t)) return { type: 'diagnose' };
  if (/\?/.test(input) || hasAny(t, ['что ', 'как ', 'где ', 'почему', 'какой', 'котор', 'сколько', 'зачем', 'можно л'])) return { type: 'help' };
  return null;
}

/** «да/давай/ок/ага» — подтверждение предложенного действия. */
export function isAffirm(input: string): boolean {
  return /^(да|давай|ага|агу|ок|окей|okay|klar|конечно|разумеется|надо|нужно|го|согласен|поддержива)[\s!.?]*$/.test(normalize(input));
}

/** «нет/не надо/отмена» — отказ от предложенного действия. */
export function isRefusal(input: string): boolean {
  return /^(нет|не|ниа|не надо|не нужно|не хочу|не стоит|не буду|отмена|позже|никак|потом)[\s!.?]*$/.test(normalize(input));
}

interface Scored { cmd: AssistantCommand; s: number }

/** «Смени на X», «переключи», «хочу Финляндию» — с оценкой уверенности. */
function matchSwitchNode(t: string, hints: string[]): Scored | null {
  let bareVerb = false;
  for (const verb of SWITCH_VERBS) {
    if (!t.includes(verb)) continue;
    const re = new RegExp(verb + '\\S*\\s+(?:на\\s+|в\\s+|к\\s+)?(.{1,40})$', 'i');
    const m = t.match(re);
    if (m) {
      const q = m[1].trim();
      if (!q) return { cmd: { type: 'switch-node', query: '' }, s: 3 };
      if (hasAny(q, BEST)) return { cmd: { type: 'switch-node', query: 'best' }, s: 4 };
      if (!NON_NODE_WORDS.some(w => q.includes(w))) {
        return { cmd: { type: 'switch-node', query: q }, s: 4 };
      }
      bareVerb = true; // «смени на иммунитет» — цель не узел, но переключиться хотели
      continue;
    }
    bareVerb = true;
  }

  // Название узла/страны прямо в фразе: «хочу германию», «го NL».
  // Жалоба на узел («финляндия не работает») — не заявка на смену: там диагностика.
  if (!hasAny(t, DIAG)) {
    for (const token of hints) {
      if (token.length < 3) {
        // короткие (NL, DE) — только как отдельное слово, чтобы не ловить «n» в слове
        if (t.split(' ').includes(token)) return { cmd: { type: 'switch-node', query: token }, s: 5 };
      } else if (looseNameMatch(t, token)) {
        return { cmd: { type: 'switch-node', query: token }, s: 5 };
      }
    }
  }

  // Глагол был, цели нет — «переключи»: переспросим, на какой.
  if (bareVerb) return { cmd: { type: 'switch-node', query: '' }, s: 3 };
  return null;
}

/** Короткое подтверждение того, что Петрович понял и делает. */
export function describeCommand(cmd: AssistantCommand): string | null {
  switch (cmd.type) {
    case 'connect': return 'Понял — подключаю. Как встанет, перепроверю.';
    case 'disconnect': return 'Отключаю VPN.';
    case 'restart': return 'Перезапускаю туннель. Дай секунд восемь.';
    case 'shield-on': return 'Включаю Иммунитет — фильтр активен, банки и сервисы уйдут напрямую.';
    case 'shield-off': return 'Выключаю Иммунитет.';
    case 'diagnose': return 'Сейчас проверю всё по порядку.';
    case 'update-sub': return 'Обновляю подписку — забираю свежие узлы.';
    case 'status': return 'Гляну, что с подключением.';
    case 'switch-node': return cmd.query ? `Ищу узел по «${cmd.query}».` : null;
    default: return null; // help/chat/greet/thanks отвечают сами
  }
}
