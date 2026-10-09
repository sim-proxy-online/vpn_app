/**
 * «Петрович чатом» — диагностический движок.
 *
 * Здесь только чистая логика: сырые результаты проверок превращаются в вердикт
 * Петровича — реплику, второстепенные замечания и предлагаемые действия («подключить»,
 * «переключить узел», «перезапустить туннель»). Самы запросы к ядру и сети живут
 * в DiagnosticsChat, поэтому вердикты здесь покрываются тестами без устройства.
 */

export type CheckId = 'net' | 'profile' | 'vpn' | 'node' | 'tunnel' | 'exit' | 'alive' | 'battery';
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckOutcome {
  id: CheckId;
  status: CheckStatus;
  /** Строка для чата с уже подставленными числами («Узел «Амстердам»: 84 мс»). */
  text: string;
}

export type FixKind = 'connect' | 'switch-node' | 'restart';

export interface Fix {
  kind: FixKind;
  label: string;
  /** Для switch-node: цель переключения. */
  nodeId?: string;
  nodeName?: string;
}

export interface Diagnosis {
  tone: 'good' | 'problem';
  /** Основная реплика: что показалось и что с этим делать. */
  summary: string;
  fixes: Fix[];
  /** Второстепенное: батарея, адрес, здоровье подписки — на вердикт не влияет. */
  advice: string[];
}

export interface AnalyzeInput {
  outcomes: CheckOutcome[];
  /** Лучший альтернативный узел из скана; null — не меряли или заметно живых нет. */
  best: { id: string; name: string; ms: number } | null;
  /** Последняя ошибка обновления подписки (updateError профиля). */
  updateError?: string;
}

/**
 * Пороги живости узла — те же, что у авто-переключения в App.tsx (autoSwitch):
 * до 2000 мс норма, до 5000 мс медленно, дальше и таймаут — «лег».
 */
export const NODE_OK_MS = 2000;
export const NODE_SLOW_MS = 5000;

const get = (outcomes: CheckOutcome[], id: CheckId): CheckOutcome | undefined =>
  outcomes.find(o => o.id === id);

/** «Узел …» → «узел …»: реплики собираются из строк проверок, там нужен строчный начертон. */
const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Собирает вердикт из результатов проверок.
 *
 * Порядок рассуждений: сначала причины, которые не про VPN вообще (нет сети на
 * устройстве), потом состояние (выключено/устанавливается), потом живость узла,
 * потом здоровье туннеля. Если всё зелёное — вердикт «good» с подсказкой про
 * конкретные сайты (бывает, что режут именно узел, а не весь туннель).
 */
export function analyze({ outcomes, best, updateError }: AnalyzeInput): Diagnosis {
  const net = get(outcomes, 'net');
  const profile = get(outcomes, 'profile');
  const vpn = get(outcomes, 'vpn');
  const node = get(outcomes, 'node');
  const tunnel = get(outcomes, 'tunnel');
  const exit = get(outcomes, 'exit');
  const battery = get(outcomes, 'battery');

  // Второстепенное собираем заранее: оно не меняет диагноз, но Петрович обязан сказать.
  const minor: string[] = [];
  if (battery?.status === 'warn') {
    minor.push('Энергосбережение может ронять VPN в фоне — исключи приложение из оптимизации батареи.');
  }
  if (exit?.status === 'warn') {
    minor.push('Внешний адрес через VPN определить не удалось — неприятно, но не критично.');
  }
  if (updateError) {
    minor.push(`Последнее обновление подписки не удалось: ${updateError}`);
  }
  // Истекшая/проблемная подписка — когда VPN выключен, это и есть главная причина
  // (ветка ниже), и подмешивать её в советы не нужно — будет дубль.
  if (profile && profile.status !== 'fail' && (profile.status === 'warn')) {
    minor.push(`${profile.text}.`);
  }

  const advice = (includeProfileFail = true): string[] => {
    const extra = includeProfileFail && profile?.status === 'fail'
      ? [...minor, `${profile.text} — узлы провайдера отключены.`]
      : minor;
    return extra;
  };

  if (net?.status === 'fail') {
    return {
      tone: 'problem',
      summary: 'Само устройство без интернета — VPN тут ни при чём. Проверь Wi-Fi или мобильные данные и запусти меня снова.',
      fixes: [],
      advice: [],
    };
  }

  if (vpn?.status === 'warn') {
    return {
      tone: 'problem',
      summary: 'Подключение ещё устанавливается. Дай ему пару секунд и нажми «Проверить ещё раз».',
      fixes: [],
      advice: advice(),
    };
  }

  // VPN выключен: главный и достаточный ответ — включить.
  if (vpn?.status === 'fail') {
    if (profile?.status === 'fail') {
      return {
        tone: 'problem',
        summary: `${profile.text}. Пока подписка неактивна, подключаться некуда.`,
        fixes: [],
        advice: advice(false),
      };
    }
    return {
      tone: 'problem',
      summary: node?.status === 'fail'
        ? `VPN выключен, и ${lower(node.text)} — после включения разберусь с ним сам.`
        : 'VPN выключен. Включи — и я сразу проверю туннель.',
      fixes: [{ kind: 'connect', label: 'Подключить' }],
      advice: advice(),
    };
  }

  // Дальше — когда VPN поднят; сначала то, без чего проверять нечего.
  // Отсутствие исхода и skip — одно и то же для диагноза: узел не выбран.
  if (!node || node.status === 'skip') {
    return {
      tone: 'problem',
      summary: 'Сервер не выбран — открой список узлов, ткни в любой и зови меня снова.',
      fixes: [],
      advice: advice(),
    };
  }

  if (node?.status === 'fail') {
    if (best) {
      return {
        tone: 'problem',
        summary: `${node.text} — узел лёг. Живой есть: «${best.name}», ${best.ms} мс.`,
        fixes: [
          { kind: 'switch-node', label: `Переключить на ${best.name}`, nodeId: best.id, nodeName: best.name },
          { kind: 'restart', label: 'Перезапустить туннель' },
        ],
        advice: advice(),
      };
    }
    return {
      tone: 'problem',
      summary: `${node.text}, и живых альтернатив не нашлось. Попробуй перезапустить туннель — не поможет, обнови подписку в профилях.`,
      fixes: [{ kind: 'restart', label: 'Перезапустить туннель' }],
      advice: advice(),
    };
  }

  if (tunnel?.status === 'fail') {
    const fixes: Fix[] = [{ kind: 'restart', label: 'Перезапустить туннель' }];
    if (best) fixes.push({ kind: 'switch-node', label: `Переключить на ${best.name}`, nodeId: best.id, nodeName: best.name });
    return {
      tone: 'problem',
      summary: 'Пинг до узла есть, но туннель мёртвый — интернет через VPN не идёт.',
      fixes,
      advice: [...advice(), 'Перезапуск обычно лечит; если нет — поможет смена узла.'],
    };
  }

  if (node?.status === 'warn' && best) {
    return {
      tone: 'problem',
      summary: `Узел живой, но ${lower(node.text)}. Быстрее — «${best.name}», ${best.ms} мс.`,
      fixes: [{ kind: 'switch-node', label: `Переключить на ${best.name}`, nodeId: best.id, nodeName: best.name }],
      advice: advice(),
    };
  }

  // Всё зелёное.
  const parts = [lower(node.text)];
  if (tunnel) parts.push('интернет через VPN есть');
  if (exit?.status === 'ok') parts.push(lower(exit.text));
  return {
    tone: 'good',
    summary: `Всё зелёное: ${parts.join('; ')}. Если конкретный сайт всё равно не открывается — попробуй сменить узел: бывают узлы, которые режет только DPI.`,
    fixes: [],
    advice: advice(),
  };
}

/**
 * Лучший альтернативный узел из замеров: живые (0 < ms ≤ NODE_SLOW_MS), кроме текущего.
 * Предлагаем только если текущий мёртв, либо альтернатива хотя бы на 500 мс быстрее —
 * иначе переключение ради переключения (тот же принцип, что у авто-переключения в App).
 */
export function selectBestAlternative(
  current: { id: string; ms: number } | null,
  measured: Array<{ id: string; name: string; ms: number }>
): { id: string; name: string; ms: number } | null {
  const alive = measured.filter(m => m.id !== current?.id && m.ms > 0 && m.ms <= NODE_SLOW_MS);
  if (alive.length === 0) return null;
  const best = alive.reduce((a, b) => (b.ms < a.ms ? b : a));
  const currentDead = !current || current.ms <= 0 || current.ms > NODE_SLOW_MS;
  if (currentDead) return best;
  return best.ms + 500 <= current.ms ? best : null;
}
