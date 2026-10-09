import { describe, expect, it } from 'vitest';
import { analyze, selectBestAlternative, type CheckOutcome } from './diagnostics';

/** Собирает набор проверок поверх дефолтов — в тестах важны только ветвящиеся поля. */
function make(partial: Partial<Record<CheckOutcome['id'], Pick<CheckOutcome, 'status' | 'text'>>>): CheckOutcome[] {
  const base: CheckOutcome[] = [
    { id: 'net', status: 'ok', text: 'Интернет на устройстве: есть' },
    { id: 'profile', status: 'ok', text: 'Подписка активна' },
    { id: 'vpn', status: 'ok', text: 'Защита: включена' },
    { id: 'node', status: 'ok', text: 'Узел «Амстердам»: 84 мс' },
    { id: 'tunnel', status: 'ok', text: 'Интернет через VPN: есть (61 мс)' },
    { id: 'exit', status: 'ok', text: 'Ваш адрес через VPN: 185.2.3.4 · Нидерланды' },
    { id: 'battery', status: 'ok', text: 'Энергосбережение: не мешает' },
  ];
  return base.map(o => (partial[o.id] ? { ...o, ...partial[o.id] } : o));
}

describe('analyze', () => {
  it('нет интернета на устройстве — VPN не виноват, действий не предлагаем', () => {
    const d = analyze({ outcomes: make({ net: { status: 'fail', text: 'Интернет на устройстве: нет' } }), best: null });
    expect(d.tone).toBe('problem');
    expect(d.fixes).toHaveLength(0);
    expect(d.summary).toContain('устройств');
  });

  it('VPN выключен — предлагаем подключить', () => {
    const d = analyze({ outcomes: make({ vpn: { status: 'fail', text: 'Защита: выключена' } }), best: null });
    expect(d.fixes).toEqual([{ kind: 'connect', label: 'Подключить' }]);
    expect(d.summary).toContain('VPN выключен');
  });

  it('выключено + подписка истекла — виновата подписка, кнопки «Подключить» нет', () => {
    const d = analyze({
      outcomes: make({
        vpn: { status: 'fail', text: 'Защита: выключена' },
        profile: { status: 'fail', text: 'Подписка истекла — узлы провайдера неактивны' },
      }),
      best: null,
    });
    expect(d.fixes).toHaveLength(0);
    expect(d.summary).toContain('Подписка истекла');
    expect(d.advice.join(' ')).not.toContain('Подписка истекла'); // дубля под summary нет
  });

  it('подключение устанавливается — действий не предлагаем', () => {
    const d = analyze({ outcomes: make({ vpn: { status: 'warn', text: 'Подключение устанавливается…' } }), best: null });
    expect(d.fixes).toHaveLength(0);
    expect(d.summary).toContain('Подключение ещё устанавливается');
  });

  it('узел лег + есть живая альтернатива — предлагаем переключение и перезапуск', () => {
    const best = { id: 'n2', name: 'Амстердам', ms: 90 };
    const d = analyze({
      outcomes: make({ node: { status: 'fail', text: 'Узел «Франкфурт»: не отвечает' } }),
      best,
    });
    expect(d.tone).toBe('problem');
    expect(d.fixes[0]).toMatchObject({ kind: 'switch-node', nodeId: 'n2', nodeName: 'Амстердам' });
    expect(d.fixes[1].kind).toBe('restart');
    expect(d.summary).toContain('узел лёг');
  });

  it('узел лег, живых нет — только перезапуск', () => {
    const d = analyze({ outcomes: make({ node: { status: 'fail', text: 'Узел «Франкфурт»: не отвечает' } }), best: null });
    expect(d.fixes.map(f => f.kind)).toEqual(['restart']);
    expect(d.summary).toContain('альтернатив не нашлось');
  });

  it('пинг есть, туннель мёртв — перезапуск первым пунктом', () => {
    const d = analyze({
      outcomes: make({ tunnel: { status: 'fail', text: 'Интернет через VPN: не идёт' } }),
      best: { id: 'n3', name: 'Париж', ms: 120 },
    });
    expect(d.fixes[0].kind).toBe('restart');
    expect(d.fixes[1].kind).toBe('switch-node');
    expect(d.summary).toContain('туннель мёртвый');
  });

  it('медленный узел + заметно быстрее — предлагаем переключение, но не перезапуск', () => {
    const d = analyze({
      outcomes: make({ node: { status: 'warn', text: 'Узел «Франкфурт»: 3400 мс — медленно' } }),
      best: { id: 'n2', name: 'Амстердам', ms: 80 },
    });
    expect(d.fixes.map(f => f.kind)).toEqual(['switch-node']);
    expect(d.summary).toContain('3400 мс');
  });

  it('всё зелёное — good, действий нет, в совете остаётся смена узла', () => {
    const d = analyze({ outcomes: make({}), best: null });
    expect(d.tone).toBe('good');
    expect(d.fixes).toHaveLength(0);
    expect(d.summary).toContain('Всё зелёное');
    expect(d.summary).toContain('84 мс');
    expect(d.summary).toContain('185.2.3.4');
  });

  it('неиспользованные узлы: сервер не выбран — лечить нечем, кроме совета', () => {
    const d = analyze({ outcomes: make({ node: { status: 'skip', text: 'Узел не выбран' } }), best: null });
    expect(d.fixes).toHaveLength(0);
    expect(d.summary).toContain('Сервер не выбран');
  });

  it('второстепенное не меняет вердикт, но попадает в advice', () => {
    const d = analyze({
      outcomes: make({ battery: { status: 'warn', text: 'Энергосбережение может усыпить VPN в фоне' } }),
      best: null,
      updateError: 'Пустой ответ от сервера',
    });
    expect(d.tone).toBe('good');
    expect(d.advice.some(a => a.includes('Энергосбережение'))).toBe(true);
    expect(d.advice.some(a => a.includes('Пустой ответ от сервера'))).toBe(true);
  });

  it('истекающая подписка (≤3 дней) уходит в advice, а не в вердикт', () => {
    const d = analyze({
      outcomes: make({ profile: { status: 'warn', text: 'Подписка истекает через 2 дн.' } }),
      best: null,
    });
    expect(d.tone).toBe('good');
    expect(d.advice.some(a => a.includes('истекает через 2 дн.'))).toBe(true);
  });
});

describe('selectBestAlternative', () => {
  const m = (id: string, ms: number, name = id) => ({ id, name, ms });

  it('текущий мёртв — берём самый быстрый живой, кроме текущего', () => {
    const best = selectBestAlternative({ id: 'a', ms: -1 }, [m('a', -1), m('b', 400), m('c', 150)]);
    expect(best).toMatchObject({ id: 'c', ms: 150 });
  });

  it('текущий живой — предлагаем только заметно быстрее (разница ≥ 500 мс)', () => {
    expect(selectBestAlternative({ id: 'a', ms: 1000 }, [m('a', 1000), m('b', 800)])).toBeNull();
    expect(selectBestAlternative({ id: 'a', ms: 1000 }, [m('a', 1000), m('b', 450)])).toMatchObject({ id: 'b' });
  });

  it('мёртвы (> 5000 мс) и с таймаутом альтернативами не считаются', () => {
    expect(selectBestAlternative({ id: 'a', ms: -1 }, [m('b', 7000), m('c', -1)])).toBeNull();
    expect(selectBestAlternative({ id: 'a', ms: 900 }, [m('a', 900), m('b', 6000)])).toBeNull();
  });

  it('живых альтернатив нет — null', () => {
    expect(selectBestAlternative({ id: 'a', ms: -1 }, [])).toBeNull();
    expect(selectBestAlternative({ id: 'a', ms: -1 }, [m('a', -1)])).toBeNull();
  });
});
