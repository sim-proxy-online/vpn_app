import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { X, Loader2, CheckCircle2, AlertTriangle, XCircle, MinusCircle } from 'lucide-react';
import { Portrait } from './MascotScene';
import type { Mood } from '../utils/mood';
import { withAlpha } from '../utils/color';
import { summarizeFailovers, petrovichReaction, formatTs, endpointLabel, type FailoverSummary } from '../utils/failoverHistory';
import type { FailoverRecord } from '../native/bridge';
import { stripLeadingEmoji } from '../utils/nodeName';
import { formatBytes } from '../data';
import { matchCommand, describeCommand, nodeHints, hasGreeting, looseNameMatch, isAffirm, isRefusal } from '../utils/assistantCommands';
import { countryName } from '../utils/publicIp';
import {
  analyze, selectBestAlternative, NODE_OK_MS, NODE_SLOW_MS,
  type CheckId, type CheckOutcome, type CheckStatus, type Diagnosis, type Fix,
} from '../utils/diagnostics';
import {
  getBestCachedPing, nativeGetBatteryStatus, nativeGetPublicIp, nativeHasInternet,
  nativePingNode, nativeTestProxyDelay, startPingBatch, nativeGetFailoverHistory,
} from '../native/bridge';
import type { ConnectionState, ServerNode, SubscriptionProfile } from '../types';

/**
 * «Петрович чатом» — диагностический чат.
 *
 * Петрович сам прогоняет чек-лист (сеть → подписка → защита → узел → туннель →
 * внешний адрес → живость альтернатив → батарея), показывает каждую проверку
 * отдельной строкой и в конце выдаёт вердикт с кнопками-действиями. Действия
 * подключают/переключают/перезапускают теми же механизмами, что и авто-переключение
 * в App.tsx (autoSwitchTargetRef), а через несколько секунд диагностика
 * перепроверяется сама — пользователь не обязан нажимать «ещё раз» руками.
 *
 * Вся логика вердиктов — в utils/diagnostics.ts (покрыта тестами); здесь только
 * сбор проверок и отрисовка.
 */

export interface DiagnosticsChatProps {
  onClose: () => void;
  connectionState: ConnectionState;
  selectedNode: ServerNode | null;
  nodes: ServerNode[];
  /** Активный профиль (или профиль выбранного узла) — состояние подписки. */
  profile: SubscriptionProfile | null;
  onConnect: () => void;
  onSwitchNode: (node: ServerNode) => void;
  onRestart: () => void;
  /** Включить/выключить режим «Иммунитет» (фильтр). true/false — целевое состояние. */
  onShieldToggle: (on: boolean) => Promise<boolean>;
  /** Обновить подписку активного профиля. ok — успех, viaTunnel — пришлось повторить через туннель. */
  onUpdateProfile: () => Promise<{ ok: boolean; viaTunnel?: boolean }>;
  /** Фильтр «Иммунитет» поднят (туннель может быть выключен) — для честного статуса. */
  shieldActive?: boolean;
}

type ChatItem =
  | { key: number; kind: 'petrovich'; text: string }
  | { key: number; kind: 'user'; text: string }
  | { key: number; kind: 'check'; id: CheckId; status: 'pending' | CheckStatus; text: string }
  | { key: number; kind: 'diagnosis'; diagnosis: Diagnosis; applied: boolean }
  | { key: number; kind: 'journal'; total: number; today: number; week: number; latest: FailoverRecord | null };

const GREETING = 'Привет! Я Петрович. Сейчас проверю всё по порядку — где собака зарыта.';

// Быстрые команды-чипы: отправляются в поле ввода как обычный текст,
// распознаются тем же matchCommand — одна логика, без второго пути.
const QUICK_COMMANDS = ['Проверь всё', 'Включи иммунитет', 'Обнови подписку', 'Перезапусти'];

// ── Хелперы ассистента: ответы на светские и «справочные» реплики ──
function pickOne(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}

/** Cached ping if present and positive, else null (not «-1» / undefined). */
function nodePingMs(n: ServerNode): number | null {
  return typeof n.ping === 'number' && n.ping > 0 ? n.ping : null;
}

/** «Финляндия, Нидерланды, Германия» — первые N уникальных стран списка узлов. */
function countryNames(nodes: ServerNode[], limit: number): string {
  const seen: string[] = [];
  for (const n of nodes) {
    const name = stripLeadingEmoji((n.name || '').split(/[-–—·|]/)[0]).trim();
    if (name && !seen.includes(name)) seen.push(name);
    if (seen.length >= limit) break;
  }
  return seen.length ? seen.join(', ') : 'узлы из подписки';
}

interface SmallTalkCtx {
  connectionState: ConnectionState;
  selectedNode: ServerNode | null;
  profile: SubscriptionProfile | null;
  nodes: ServerNode[];
}

/**
 * Ответ на не-командное сообщение: вопрос про айпи/трафик/версию, «кто ты»,
 * «как дела». run — какое действие чата запустить следом (например, прогон
 * проверок покажет внешний адрес).
 */
function smallTalk(text: string, ctx: SmallTalkCtx): { text: string; mood?: Mood; run?: 'diagnose' } {
  const t = text.toLowerCase();
  const say = (s: string, mood?: Mood) => ({ text: s, mood });
  if (/айпи|ip-адрес|ip адрес|какой (у меня )?(внешн|наруж)|какой я снаружи/.test(t)) {
    return { text: 'Сейчас проверю — в конце скажу, каким тебя видит сеть.', mood: 'thinking', run: 'diagnose' };
  }
  if (/трафик|гига|лимит|остаток|сколько осталось|сколько скачано/.test(t)) {
    const tr = ctx.profile?.traffic;
    if (tr) {
      const left = Math.max(0, (tr.total || 0) - (tr.upload || 0) - (tr.download || 0));
      const parts: string[] = [];
      if (tr.total) parts.push(`осталось ${formatBytes(left)} из ${formatBytes(tr.total)}`);
      if (typeof tr.remainingDays === 'number') parts.push(`дней: ${tr.remainingDays}`);
      return say(parts.length ? `По подписке ${parts.join(', ')}.` : 'По подписке счётчики трафика пустые — могу обновить подписку.');
    }
    return say('Трафик смотрю в Профиле — там же полоска остатка. Могу обновить подписку, если данные устарели.');
  }
  if (/верси|обновлен|что нового|апдейт/.test(t)) {
    return say('Версия и список изменений — в Настройках, блок «О приложении». А свежие узлы могу подтянуть — скажи «обнови подписку».');
  }
  if (/ты кто|кто ты|что ты такое/.test(t)) {
    return say('Я Петрович — домашний механик этого VPN. Включаю, выключаю, переключаю узлы и чиню, что отвалилось. Пиши как говоришь.');
  }
  if (/как дела|как сам|как жизнь|как настроение/.test(t)) {
    const s = ctx.connectionState === 'connected'
      ? 'У меня тепло — туннель поднят. Как у тебя?'
      : 'Простаиваю, скучновато. Включим защиту?';
    return say(s);
  }
  return say('Не понял задумку. Напиши «помощь» — покажу, что умею.');
}

const PENDING: Record<CheckId, string> = {
  net: 'Смотрю, есть ли интернет на устройстве…',
  profile: 'Читаю состояние подписки…',
  vpn: 'Проверяю состояние защиты…',
  node: 'Пингую выбранный узел…',
  tunnel: 'Пробую интернет через туннель…',
  exit: 'Спрашиваю у сети, какой я снаружи…',
  alive: 'Меряю живость других узлов…',
  battery: 'Заглядываю в настройки батареи…',
};

const FAILED: Record<CheckId, string> = {
  net: 'Интернет устройства: проверить не удалось',
  profile: 'Подписка: данные недоступны',
  vpn: 'Состояние защиты: проверить не удалось',
  node: 'Узел: проверить не удалось',
  tunnel: 'Интернет через VPN: проверить не удалось',
  exit: 'Внешний адрес: проверить не удалось',
  alive: 'Другие узлы: проверить не удалось',
  battery: 'Энергосбережение: проверить не удалось',
};

const ABORT = new Error('diagnostics-aborted');
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Omit по объединению должен распределяться по каждому варианту — иначе остаются только общие ключи. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ChatItemInput = DistributiveOmit<ChatItem, 'key'>;

/** Состояние подписки одной строкой для чата. */
function profileOutcome(profile: SubscriptionProfile | null): CheckOutcome {
  if (!profile) return { id: 'profile', status: 'skip', text: 'Профиль не выбран — проверяю напрямую' };
  const days = profile.traffic?.remainingDays;
  if (typeof days === 'number') {
    if (days <= 0) return { id: 'profile', status: 'fail', text: 'Подписка истекла — узлы провайдера неактивны' };
    if (days <= 3) return { id: 'profile', status: 'warn', text: `Подписка истекает через ${days} дн.` };
    return { id: 'profile', status: 'ok', text: `Подписка активна — ещё ${days} дн.` };
  }
  if (profile.status === 'expired') return { id: 'profile', status: 'fail', text: 'Подписка истекла — узлы провайдера неактивны' };
  if (profile.status === 'warning') return { id: 'profile', status: 'warn', text: 'Подписка: провайдер сообщает о замечаниях' };
  if (profile.status === 'error') return { id: 'profile', status: 'warn', text: 'Подписка: провайдер сообщает об ошибке' };
  return { id: 'profile', status: 'ok', text: 'Подписка активна' };
}

export default function DiagnosticsChat(props: DiagnosticsChatProps) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [running, setRunning] = useState(false);
  const [mood, setMood] = useState<Mood>('thinking');
  const [input, setInput] = useState('');

  // Ссылы на актуальные пропсы: прогон читает их на каждом шаге, а не при старте —
  // состояние VPN меняется прямо во время диагностики (мы сами его и перезапускаем).
  const propsRef = useRef(props);
  propsRef.current = props;

  const keyRef = useRef(0);
  const runRef = useRef(0);            // номер прогона: старший прогон считается прерванным
  const runningRef = useRef(false);
  const closedRef = useRef(false);
  const hasRunRef = useRef(false);     // первый прогон — со стартовым приветствием
  const rerunTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishBatchRef = useRef<(() => void) | null>(null);
  const diagnosisKeyRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Контекст диалога: какой вопрос Петрович задал последним (ждёт «да/нет»
  // или название узла)
  const questionRef = useRef<'switch-target' | 'connect-offer' | null>(null);

  const push = (item: ChatItemInput): number => {
    const key = ++keyRef.current;
    setItems(prev => [...prev, { ...item, key } as ChatItem]);
    return key;
  };

  const patchCheck = (key: number, status: CheckStatus, text: string) => {
    setItems(prev => prev.map(it => (it.key === key && it.kind === 'check' ? { ...it, status, text } : it)));
  };

  /** Замер живости альтернатив: кэш пингов берём как есть, недомеренное — batch-ом (как в App). */
  const scanAlternatives = async (current: ServerNode | null, currentMs: number) => {
    const { nodes } = propsRef.current;
    const others = nodes.filter(n => n.id !== current?.id && n.address && n.port).slice(0, 15);
    const res: Record<string, number> = {};
    const toMeasure: ServerNode[] = [];
    for (const n of others) {
      const cached = getBestCachedPing(n.id);
      if (cached > 0 && cached < 1500) res[n.id] = cached;
      else toMeasure.push(n);
    }
    if (toMeasure.length > 0) {
      await new Promise<void>(resolve => {
        const finish = () => {
          cancel?.();
          finishBatchRef.current = null;
          resolve();
        };
        finishBatchRef.current = finish;
        const cancel = startPingBatch(
          toMeasure.slice(0, 10),
          (id, ms) => { res[id] = ms; },
          finish
        );
      });
    }
    const measured = others.map(n => ({
      id: n.id,
      name: stripLeadingEmoji(n.name),
      ms: typeof res[n.id] === 'number' ? res[n.id] : -1,
    }));
    const best = selectBestAlternative(current ? { id: current.id, ms: currentMs } : null, measured);
    const alive = measured.filter(x => x.ms > 0 && x.ms <= NODE_SLOW_MS).length;
    return { best, alive, total: measured.length };
  };

  const runChecks = async () => {
    if (closedRef.current || runningRef.current) return;
    runningRef.current = true;
    const myRun = ++runRef.current;
    const alive = () => !closedRef.current && runRef.current === myRun;
    const guard = () => { if (!alive()) throw ABORT; };
    setRunning(true);
    setMood('thinking');
    push({ kind: 'petrovich', text: hasRunRef.current ? 'Смотрю заново — держи чек-лист.' : GREETING });
    hasRunRef.current = true;

    const outcomes: CheckOutcome[] = [];

    const check = async (id: CheckId, fn: () => Promise<CheckOutcome>) => {
      guard();
      const key = push({ kind: 'check', id, status: 'pending', text: PENDING[id] });
      await sleep(140);
      guard();
      let o: CheckOutcome;
      try { o = await fn(); } catch { o = { id, status: 'warn', text: FAILED[id] }; }
      guard();
      outcomes.push(o);
      patchCheck(key, o.status, o.text);
      await sleep(110);
      guard();
    };

    try {
      const { connectionState, selectedNode, profile } = propsRef.current;

      await check('net', async () => {
        const ok = navigator.onLine !== false && nativeHasInternet();
        return { id: 'net', status: ok ? 'ok' : 'fail', text: ok ? 'Интернет на устройстве: есть' : 'Интернет на устройстве: нет' };
      });

      await check('profile', async () => profileOutcome(profile));

      const connected = connectionState === 'connected';
      const transient = connectionState !== 'connected' && connectionState !== 'disconnected';
      await check('vpn', async () => ({
        id: 'vpn',
        status: connected ? 'ok' : transient ? 'warn' : 'fail',
        text: connected ? 'Защита: включена' : transient ? 'Подключение устанавливается…' : 'Защита: выключена',
      }));

      // Узел пингуем всегда: measure-замер работает и без поднятого VPN.
      let nodeMs = -1;
      await check('node', async () => {
        if (!selectedNode) return { id: 'node', status: 'skip', text: 'Узел не выбран' };
        const name = stripLeadingEmoji(selectedNode.name).slice(0, 30);
        const ms = await nativePingNode(selectedNode, 'proxy', connected, true);
        nodeMs = typeof ms === 'number' ? ms : -1;
        if (nodeMs > 0 && nodeMs <= NODE_OK_MS) return { id: 'node', status: 'ok', text: `Узел «${name}»: ${nodeMs} мс` };
        if (nodeMs > 0 && nodeMs <= NODE_SLOW_MS) return { id: 'node', status: 'warn', text: `Узел «${name}»: ${nodeMs} мс — медленно` };
        return { id: 'node', status: 'fail', text: nodeMs > 0 ? `Узел «${name}»: ${nodeMs} мс — слишком медленно` : `Узел «${name}»: не отвечает` };
      });

      // Туннель и внешний адрес меряются только через поднятый SOCKS.
      if (connected) {
        await check('tunnel', async () => {
          const ms = await nativeTestProxyDelay();
          return ms > 0
            ? { id: 'tunnel', status: 'ok', text: `Интернет через VPN: есть (${ms} мс)` }
            : { id: 'tunnel', status: 'fail', text: 'Интернет через VPN: не идёт' };
        });
        await check('exit', async () => {
          const ip = await nativeGetPublicIp();
          return ip?.ip
            ? { id: 'exit', status: 'ok', text: `Ваш адрес через VPN: ${ip.ip}${ip.country ? ` · ${countryName(ip.country)}` : ''}` }
            : { id: 'exit', status: 'warn', text: 'Внешний адрес определить не удалось' };
        });
      }

      // Скан альтернатив — только когда есть подозрение (узел мёртв/медленный или туннель лег):
      // без причины чужие узлы не перемеряем, чтобы не держать чат минутами.
      let best: { id: string; name: string; ms: number } | null = null;
      const suspicious = outcomes.some(o => (o.id === 'node' || o.id === 'tunnel') && (o.status === 'warn' || o.status === 'fail'));
      if (!suspicious) {
        push({ kind: 'check', id: 'alive', status: 'skip', text: 'Другие узлы: не мерял — всё работает' });
      } else {
        const aliveKey = push({ kind: 'check', id: 'alive', status: 'pending', text: PENDING.alive });
        await sleep(120);
        guard();
        const scan = await scanAlternatives(selectedNode, nodeMs);
        guard();
        best = scan.best;
        const bestName = scan.best ? stripLeadingEmoji(scan.best.name) : '';
        patchCheck(aliveKey, scan.total === 0 ? 'skip' : scan.alive > 0 ? 'ok' : 'fail',
          scan.total === 0 ? 'Другие узлы: других в подписке нет'
            : scan.best ? `Другие узлы: ${scan.alive} из ${scan.total} живых — лучший «${bestName}» ${scan.best.ms} мс`
            : scan.alive > 0 ? `Другие узлы: ${scan.alive} из ${scan.total} живых, но лучше текущего нет`
            : 'Другие узлы: живых не нашлось');
        await sleep(110);
        guard();
      }

      await check('battery', async () => {
        const b = await nativeGetBatteryStatus();
        return b.doze
          ? { id: 'battery', status: 'ok', text: 'Энергосбережение: не мешает' }
          : { id: 'battery', status: 'warn', text: 'Энергосбережение может усыпить VPN в фоне' };
      });

      // ── Петрович-агент: журнал фоновых автопереключений ──
      // Нативка пишет его при каждом фоновом failover (переживает смерть WebView).
      // Показываем сводку + реплику Петровича — что творилось «за спиной», пока
      // пользователь не смотрел в приложение.
      let failoverSummary: FailoverSummary = { total: 0, today: 0, week: 0, latest: null };
      try {
        const records = await nativeGetFailoverHistory();
        guard();
        failoverSummary = summarizeFailovers(records, Date.now());
        // Блок «Журнал Петровича» показываем всегда — даже пустой, чтобы пользователь
        // знал, что агент следит за фоновыми переключениями.
        push({ kind: 'journal', ...failoverSummary });
        await sleep(90);
        guard();
        const reaction = petrovichReaction(failoverSummary, Date.now());
        if (reaction) {
          push({ kind: 'petrovich', text: reaction });
          await sleep(100);
          guard();
        }
      } catch {
        if (!alive()) throw ABORT; // прерванный прогон — выходим, а не маскируем
      }

      const diagnosis = analyze({ outcomes, best, updateError: profile?.updateError });
      diagnosisKeyRef.current = push({ kind: 'diagnosis', diagnosis, applied: false });
      setMood(diagnosis.tone === 'good' ? 'happy' : 'confused');
    } catch (e) {
      if (e !== ABORT) {
        push({ kind: 'petrovich', text: 'Что-то пошло не так прямо во время проверки. Попробуй ещё разок.' });
        setMood('confused');
      }
    } finally {
      runningRef.current = false;
      if (alive()) setRunning(false);
    }
  };

  const scheduleRerun = (ms: number) => {
    if (rerunTimerRef.current) clearTimeout(rerunTimerRef.current);
    rerunTimerRef.current = setTimeout(() => {
      rerunTimerRef.current = null;
      if (closedRef.current) return;
      push({ kind: 'user', text: 'Проверяю ещё раз…' });
      void runChecks();
    }, ms);
  };

  const applyFix = (fix: Fix) => {
    if (runningRef.current) return;
    const key = diagnosisKeyRef.current;
    if (key !== null) {
      setItems(prev => prev.map(it => (it.key === key && it.kind === 'diagnosis' ? { ...it, applied: true } : it)));
    }
    push({ kind: 'user', text: fix.label });
    setMood('thinking');
    if (fix.kind === 'connect') {
      propsRef.current.onConnect();
      push({ kind: 'petrovich', text: 'Отлично, подключаю. Как встанет — сразу перепроверю.' });
      scheduleRerun(7000);
      return;
    }
    if (fix.kind === 'switch-node') {
      const node = propsRef.current.nodes.find(n => n.id === fix.nodeId);
      if (!node) {
        push({ kind: 'petrovich', text: 'Узел, кажется, исчез из списка — обнови подписку и зови меня снова.' });
        setMood('confused');
        return;
      }
      propsRef.current.onSwitchNode(node);
      push({ kind: 'petrovich', text: `Переключаюсь на «${stripLeadingEmoji(node.name)}» и переподключаюсь — дай секунд семь.` });
      scheduleRerun(8000);
      return;
    }
    propsRef.current.onRestart();
    push({ kind: 'petrovich', text: 'Перезапускаю туннель. Проверю через секунд восемь.' });
    scheduleRerun(8000);
  };

  /** Самый живой узел (минимальный пинг из известных), null если список пуст. */
  const pickBestNode = (): ServerNode | null => {
    const nodes = propsRef.current.nodes;
    const current = propsRef.current.selectedNode;
    const pool = nodes.filter(n => n.id !== current?.id);
    return pool.reduce<ServerNode | null>((acc, n) => {
      const ms = nodePingMs(n);
      if (ms === null || ms <= 0) return acc;
      if (!acc) return n;
      return ms < (nodePingMs(acc) ?? Infinity) ? n : acc;
    }, null) ?? pool[0] ?? null;
  };

  /** Команда «переключись»: сменить узел + переподключение. */
  const doSwitch = (node: ServerNode) => {
    propsRef.current.onSwitchNode(node);
    push({ kind: 'petrovich', text: `Переключаюсь на «${stripLeadingEmoji(node.name)}» и переподключаюсь — дай секунд семь.` });
    scheduleRerun(8000);
  };

  // ── Петрович-ассистент: обработка любых сообщений пользователя ──
  // Пиши как говоришь: «банки не пускают через впн», «смени на финляндию»,
  // «что ты умеешь», «привет» — распознаватель (utils/assistantCommands)
  // набирает очки по смыслу всей фразы, не распознаёт вчистую — понимает по
  // теме («про сеть» → диагностика, «вопрос» → помощь). А если Петрович
  // что-то предлагал, понимают «да/нет/повтори» и голое название узла.
  const handleUserCommand = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setInput('');
    // Пока прогон идёт — не молчим, а честно говорим, что заняты (команды
    // железно не дублируем: прогон трогать нельзя).
    if (runningRef.current) {
      push({ kind: 'user', text });
      push({ kind: 'petrovich', text: 'Да я уже в процессе — проверяю всё по порядку. Секунд десять, и отчитаюсь.' });
      return;
    }
    push({ kind: 'user', text });

    const cmd = matchCommand(text, nodeHints(propsRef.current.nodes));

    // ── Контекст: «да/нет» на предложение, голое название узла после переспроса ──
    const offered = questionRef.current;
    questionRef.current = null;
    if (offered && (!cmd || cmd.type === 'greet' || cmd.type === 'chat' || cmd.type === 'thanks')) {
      if (isRefusal(text)) {
        push({ kind: 'petrovich', text: 'Ладно, как скажешь.' });
        return;
      }
      if (isAffirm(text)) {
        if (offered === 'switch-target') {
          // «да» на «куда переключить?» — ставим самого живого
          const target = pickBestNode();
          if (target) doSwitch(target);
          else push({ kind: 'petrovich', text: 'Да нечего выбирать — список узлов пуст.' });
        } else {
          setMood('thinking');
          propsRef.current.onConnect();
          scheduleRerun(7000);
        }
        return;
      }
    }
    // «ну переключи» повторно после переспроса — не злить вторым вопросом, сам выберем
    if (offered === 'switch-target' && cmd?.type === 'switch-node' && !cmd.query) cmd.query = 'best';

    // Вежливость: если поздоровались и попросили дело — сначала отвечаем на приветствие.
    if (cmd && cmd.type !== 'greet' && cmd.type !== 'chat' && cmd.type !== 'thanks' && hasGreeting(text)) {
      push({ kind: 'petrovich', text: 'Привет!' });
    }

    if (!cmd) {
      if (isAffirm(text)) {
        push({ kind: 'petrovich', text: 'Ага. Только скажи — что именно: включить VPN, поднять Иммунитет, сменить узел или проверить всё?' });
        return;
      }
      if (isRefusal(text)) {
        push({ kind: 'petrovich', text: 'Ладно. Я рядом, если что.' });
        return;
      }
      push({ kind: 'petrovich', text: 'Не понял задумку. Я умею: включать и выключать VPN, поднимать Иммунитет (чтобы банки и госуслуги не видели VPN), менять узел («смени на Финляндию», «на самый быстрый»), обновлять подписку, чинить Connection reset и проверять всё целиком. Спрашивай своими словами.' });
      setMood('confused');
      return;
    }

    const reaction = describeCommand(cmd);
    if (reaction) push({ kind: 'petrovich', text: reaction });

    switch (cmd.type) {
      case 'connect': setMood('thinking'); propsRef.current.onConnect(); scheduleRerun(7000); break;
      case 'disconnect': propsRef.current.onConnect(); break; // handleToggle переключает VPN
      case 'restart': setMood('thinking'); propsRef.current.onRestart(); scheduleRerun(8000); break;
      case 'shield-on': await propsRef.current.onShieldToggle(true).catch(() => false); break;
      case 'shield-off': await propsRef.current.onShieldToggle(false).catch(() => false); break;
      case 'update-sub': {
        const r = await propsRef.current.onUpdateProfile().catch(() => ({ ok: false, viaTunnel: false }));
        push({
          kind: 'petrovich',
          text: r.ok
            ? (r.viaTunnel
              ? 'Подписка обновлена — напрямую её режут, поэтому зашёл через туннель. Свежие узлы на месте.'
              : 'Подписка обновлена — забрал свежие узлы.')
            : 'Не смог обновить подписку — проверь соединение или ссылку в Профилях.',
        });
        break;
      }
      case 'diagnose': setMood('thinking'); void runChecks(); break;
      case 'status': {
        const st = propsRef.current.connectionState;
        const node = propsRef.current.selectedNode;
        const shield = propsRef.current.shieldActive;
        const name = node ? stripLeadingEmoji(node.name) : 'не выбран';
        const s = st === 'connected' ? 'подключено' : st === 'connecting' ? 'подключаюсь…' : st === 'disconnecting' ? 'отключаюсь…' : shield ? 'туннель выключен, но Иммунитет работает' : 'выключено';
        push({ kind: 'petrovich', text: `Сейчас: ${s}. Узел: «${name}». Могу проверить всё или переключить узел.` });
        break;
      }
      case 'help':
        push({ kind: 'petrovich', text: 'Говори как есть — я пойму. Примеры: «включи впн», «выключи vpn», «сделай чтобы банки не видели впн» (это Иммунитет), «перезапусти», «смени на Финляндию», «поставь самый быстрый», «обнови подписку», «чинить connection reset», «почему ютуб не грузится», «какой у меня айпи», «какой у меня трафик», «что нового в этой версии».' });
        break;
      case 'chat': {
        const answer = smallTalk(text, {
          connectionState: propsRef.current.connectionState,
          selectedNode: propsRef.current.selectedNode,
          profile: propsRef.current.profile,
          nodes: propsRef.current.nodes,
        });
        setMood(answer.mood ?? 'happy');
        push({ kind: 'petrovich', text: answer.text });
        if (answer.run === 'diagnose') { setMood('thinking'); void runChecks(); }
        break;
      }
      case 'greet':
        questionRef.current = 'connect-offer';
        push({ kind: 'petrovich', text: 'Привет! Я на связи. Что подкрутить — включить VPN, поднять Иммунитет или проверить всё?' });
        break;
      case 'thanks':
        push({ kind: 'petrovich', text: pickOne(['Пожалуйста, обращайся.', 'Не за что — я для того и тут.', 'Обращайся, если что — я рядом.']) });
        break;
      case 'switch-node': {
        const nodes = propsRef.current.nodes;
        const current = propsRef.current.selectedNode;
        let node: ServerNode | null = null;
        if (cmd.query === 'best') {
          node = pickBestNode();
        } else if (cmd.query) {
          const q = cmd.query.toLowerCase();
          node = nodes.find(n => looseNameMatch(stripLeadingEmoji(n.name), q) || looseNameMatch(n.flag || '', q) || n.id.toLowerCase().includes(q)) ?? null;
        }
        if (!node) {
          const countries = countryNames(nodes, 3);
          questionRef.current = 'switch-target';
          push({ kind: 'petrovich', text: cmd.query
            ? `Узел по «${cmd.query}» не нашёлся. Есть, например: ${countries}. Скажи страну или имя.`
            : `Куда переключить? Есть ${countries} — или скажи «на самый быстрый».` });
          setMood('confused');
          break;
        }
        if (node.id === current?.id) {
          push({ kind: 'petrovich', text: `Сам «${stripLeadingEmoji(node.name)}» уже стоит — он активен.` });
          break;
        }
        propsRef.current.onSwitchNode(node);
        push({ kind: 'petrovich', text: `Переключаюсь на «${stripLeadingEmoji(node.name)}» и переподключаюсь — дай секунд семь.` });
        scheduleRerun(8000);
        break;
      }
    }
  }, [runningRef, setInput, push]); // eslint-disable-line react-hooks/exhaustive-deps

  // Старт и уборка. Сброс истории перед прогоном нужен для dev-StrictMode: эффект
  // выполняется там дважды, и без сброса в чате остался бы прерванный полупрогон.
  useEffect(() => {
    closedRef.current = false;
    hasRunRef.current = false;
    setItems([]);
    keyRef.current = 0;
    void runChecks();
    return () => {
      closedRef.current = true;
      runRef.current++;                 // текущий прогон прерван (guard бросит ABORT)
      finishBatchRef.current?.();       // и batch-пинг не останется висеть
      if (rerunTimerRef.current) { clearTimeout(rerunTimerRef.current); rerunTimerRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Автопрокрутка ленты к последнему сообщению.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items]);

  return createPortal(
    <motion.div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-3"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      onClick={e => { if (e.target === e.currentTarget) props.onClose(); }}
    >
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Диагностика Петровича"
        className="w-full max-w-md h-[min(86dvh,700px)] rounded-3xl border border-white/10 bg-[#0b0e24]/95 overflow-hidden flex flex-col shadow-[0_24px_80px_-12px_rgba(0,0,0,0.7)]"
      >
        {/* Шапка: Петрович с настроением — думает/доволен/смущён по итогу прогона */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10 bg-white/[0.03]">
          <div className="relative shrink-0" style={{ width: 44, height: 44 }}>
            <Portrait mood={mood} size={44} accessories={false} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-extrabold text-white leading-tight">Петрович</p>
            <p className="text-[11.5px] text-gray-400 truncate">
              {running ? 'сейчас проверяю…' : 'диагност · скажу, что не так'}
            </p>
          </div>
          <button
            onClick={props.onClose}
            aria-label="Закрыть"
            className="w-9 h-9 rounded-xl flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/[0.06] active:scale-90 transition-all"
          >
            <X size={18} />
          </button>
        </div>

        {/* Лента чата */}
        <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-2.5 overscroll-contain">
          {items.map(it => {
            if (it.kind === 'petrovich') {
              return (
                <div key={it.key} className="max-w-[85%] self-start rounded-2xl rounded-tl-md bg-white/[0.05] border border-white/10 px-3.5 py-2.5 text-[13px] leading-snug text-gray-200">
                  {it.text}
                </div>
              );
            }
            if (it.kind === 'user') {
              return (
                <div key={it.key} className="max-w-[85%] self-end rounded-2xl rounded-tr-md px-3.5 py-2.5 text-[13px] leading-snug text-white bg-[var(--accent-a10)] border border-[var(--accent-a33)]">
                  {it.text}
                </div>
              );
            }
            if (it.kind === 'check') {
              const icon =
                it.status === 'pending' ? <Loader2 size={14} className="animate-spin shrink-0" style={{ color: 'var(--accent)' }} /> :
                it.status === 'ok' ? <CheckCircle2 size={14} className="text-[#00e08a] shrink-0" /> :
                it.status === 'warn' ? <AlertTriangle size={14} className="text-[#ffb36b] shrink-0" /> :
                it.status === 'fail' ? <XCircle size={14} className="text-[#ff5c5c] shrink-0" /> :
                <MinusCircle size={14} className="text-gray-600 shrink-0" />;
              return (
                <div key={it.key} className={`flex items-start gap-2 text-[12.5px] leading-snug pl-1 ${it.status === 'pending' ? 'text-gray-500' : 'text-gray-300'}`}>
                  <span className="mt-[1px]">{icon}</span>
                  <span>{it.text}</span>
                </div>
              );
            }
            // Журнал фоновых автопереключений («Петрович-агент»).
            if (it.kind === 'journal') {
              const has = it.total > 0;
              return (
                <div key={it.key} className="rounded-2xl border p-3.5" style={{ borderColor: 'rgba(160,180,255,0.28)', background: 'rgba(120,140,255,0.07)' }}>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span style={{ fontSize: 11 }}>🛰️</span>
                    <span className="text-[10px] font-bold uppercase tracking-widest text-[#a8b8ff]">Журнал Петровича</span>
                    {has && <span className="ml-auto text-[11px] font-mono text-gray-400">{it.total}</span>}
                  </div>
                  {!has ? (
                    <p className="text-[12.5px] leading-snug text-gray-400">Фоновых переключений не было — я ни разу не трогал сервер сам.</p>
                  ) : (
                    <div className="space-y-1">
                      <p className="text-[12px] text-gray-300">
                        За сутки: <span className="text-white font-semibold">{it.today}</span> · за неделю:{' '}
                        <span className="text-white font-semibold">{it.week}</span>
                      </p>
                      {it.latest && (
                        <p className="text-[12.5px] leading-snug text-white">
                          Последнее — на «{it.latest.name}» ({endpointLabel(it.latest.to)}){' '}
                          <span className="text-gray-400">{formatTs(it.latest.ts, Date.now())}</span>
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            }
            // Вердикт: тон задаёт цвет, кнопки-actions исчезают после нажатия.
            const color = it.diagnosis.tone === 'good' ? '#00e08a' : '#ff9d4d';
            return (
              <div key={it.key} className="rounded-2xl border p-3.5" style={{ borderColor: withAlpha(color, '44'), background: withAlpha(color, '10') }}>
                <div className="flex items-center gap-1.5 mb-1.5">
                  {it.diagnosis.tone === 'good'
                    ? <CheckCircle2 size={13} style={{ color }} />
                    : <AlertTriangle size={13} style={{ color }} />}
                  <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color }}>Вердикт</span>
                </div>
                <p className="text-[13.5px] leading-snug text-white">{it.diagnosis.summary}</p>
                {it.diagnosis.advice.length > 0 && (
                  <ul className="mt-2.5 space-y-1">
                    {it.diagnosis.advice.map((a, i) => (
                      <li key={i} className="text-[12px] leading-snug text-gray-400">— {a}</li>
                    ))}
                  </ul>
                )}
                {it.diagnosis.fixes.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {it.diagnosis.fixes.map((f, i) => (
                      <button
                        key={`${f.kind}-${i}`}
                        disabled={it.applied || running}
                        onClick={() => applyFix(f)}
                        className={`px-3.5 py-2 rounded-xl text-[12.5px] font-bold active:scale-95 transition-transform disabled:opacity-40 ${
                          i === 0 ? 'bg-[var(--accent)] text-black' : 'bg-white/[0.07] border border-white/10 text-gray-200'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                    {it.applied && <span className="text-[12px] text-gray-400">✓ сделал — скоро перепроверю</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Подвал: быстрые команды + поле ввода « Петровичу» */}
        <div className="px-4 pt-3 pb-4 border-t border-white/10">
          <div className="flex flex-wrap gap-2 mb-2.5">
            {QUICK_COMMANDS.map(chip => (
              <button
                key={chip}
                onClick={() => void handleUserCommand(chip)}
                disabled={running}
                className="px-3 py-1.5 rounded-full text-[12px] font-semibold border border-white/10 bg-white/[0.06] text-gray-300 active:scale-95 transition-transform disabled:opacity-40"
              >
                {chip}
              </button>
            ))}
          </div>
          <form
            onSubmit={e => { e.preventDefault(); void handleUserCommand(input); }}
            className="flex gap-2"
          >
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Напиши, что нужно: «включи иммунитет», «смени на Финляндию»…"
              className="flex-1 min-w-0 px-3.5 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-[13px] text-gray-100 placeholder:text-gray-500 outline-none focus:border-white/25"
            />
            <button
              type="submit"
              disabled={!input.trim() || running}
              className="px-4 py-2.5 rounded-xl bg-[var(--accent)] text-black text-[13px] font-bold disabled:opacity-40 active:scale-95 transition-transform"
            >
              Отправить
            </button>
          </form>
          <p className="mt-2 text-center text-[10.5px] text-gray-600">
            Все проверки идут на устройстве — ничего никуда не отправляется
          </p>
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
}
