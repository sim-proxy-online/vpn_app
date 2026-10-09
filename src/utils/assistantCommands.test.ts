import { describe, it, expect } from 'vitest';
import { matchCommand, normalize, describeCommand, looseNameMatch, hasGreeting, nodeHints, isAffirm, isRefusal } from './assistantCommands';
import type { ServerNode } from '../types';

const node = (name: string, flag?: string) => ({ name, flag } as ServerNode);
const HINTS = nodeHints([node('🇫🇮 Финляндия 01', 'fi'), node('🇩🇪 NL-сервер', 'nl'), node('Нидерланды Amsterdam', '')]);

describe('normalize', () => {
  it('строчные, ё→е, без пунктуации, схлопывает пробелы', () => {
    expect(normalize('  Подключи,  пожалуйста! Ёлка ')).toBe('подключи пожалуйста елка');
  });
});

describe('matchCommand — базы', () => {
  it('подключить', () => {
    expect(matchCommand('подключи')).toEqual({ type: 'connect' });
    expect(matchCommand('включи vpn')).toEqual({ type: 'connect' });
    expect(matchCommand('го vpn')).toEqual({ type: 'connect' });
  });
  it('отключить', () => {
    expect(matchCommand('выключи туннель')).toEqual({ type: 'disconnect' });
    expect(matchCommand('отключи vpn')).toEqual({ type: 'disconnect' });
    expect(matchCommand('снимай защиту')).toEqual({ type: 'disconnect' });
  });
  it('перезапустить', () => {
    expect(matchCommand('перезапусти туннель')).toEqual({ type: 'restart' });
    expect(matchCommand('сделай ребут')).toEqual({ type: 'restart' });
  });
  it('иммунитет вкл/выкл', () => {
    expect(matchCommand('включи иммунитет')).toEqual({ type: 'shield-on' });
    expect(matchCommand('выключи иммунитет')).toEqual({ type: 'shield-off' });
    expect(matchCommand('сними щит')).toEqual({ type: 'shield-off' });
  });
  it('банки/госуслуги не видели VPN → shield-on', () => {
    expect(matchCommand('сделай чтобы банки не видели vpn')).toEqual({ type: 'shield-on' });
    expect(matchCommand('банк не видит vpn')).toEqual({ type: 'shield-on' });
    expect(matchCommand('госуслуги блокируют меня за впн')).toEqual({ type: 'shield-on' });
    expect(matchCommand('слушай, сберопять отказывается заходить из-за впн, ну сделай что-нибудь')).toEqual({ type: 'shield-on' });
  });
  it('обновить подписку', () => {
    expect(matchCommand('обнови подписку')).toEqual({ type: 'update-sub' });
    expect(matchCommand('подтяни свежие узлы')).toEqual({ type: 'update-sub' });
  });
  it('диагностика по жалобам', () => {
    expect(matchCommand('проверь всё')).toEqual({ type: 'diagnose' });
    expect(matchCommand('что не так')).toEqual({ type: 'diagnose' });
    expect(matchCommand('ютуб не грузится через впн')).toEqual({ type: 'diagnose' });
    expect(matchCommand('впн лагает жутко')).toEqual({ type: 'diagnose' });
    expect(matchCommand('чинить connection reset')).toEqual({ type: 'diagnose' });
    expect(matchCommand('у меня connection reset')).toEqual({ type: 'diagnose' });
    expect(matchCommand('туннель упал и не поднимается')).toEqual({ type: 'diagnose' });
    expect(matchCommand('соединение обрывается каждые пять минут')).toEqual({ type: 'diagnose' });
  });
  it('статус', () => {
    expect(matchCommand('покажи статус')).toEqual({ type: 'status' });
    expect(matchCommand('как там соединение')).toEqual({ type: 'status' });
  });
  it('помощь и светские реплики', () => {
    expect(matchCommand('что ты умеешь')).toEqual({ type: 'help' });
    expect(matchCommand('как дела')).toEqual({ type: 'chat' });
    expect(matchCommand('ты кто')).toEqual({ type: 'chat' });
  });
  it('привет и спасибо', () => {
    expect(matchCommand('привет')).toEqual({ type: 'greet' });
    expect(matchCommand('добрый вечер')).toEqual({ type: 'greet' });
    expect(matchCommand('спасибо большое')).toEqual({ type: 'thanks' });
  });
});

describe('matchCommand — смена узла', () => {
  it('с глаголом', () => {
    expect(matchCommand('смени на финляндию')).toEqual({ type: 'switch-node', query: 'финляндию' });
    expect(matchCommand('переключись на NL')).toEqual({ type: 'switch-node', query: 'nl' });
  });
  it('без глагола — по названию страны (nodeHints)', () => {
    expect(matchCommand('хочу финляндию', HINTS)).toEqual({ type: 'switch-node', query: 'финляндия' });
    expect(matchCommand('го германию', HINTS)).toBeNull(); // нет такого узла — не выдумываем
    expect(matchCommand('го nl', HINTS)).toEqual({ type: 'switch-node', query: 'nl' });
  });
  it('на самый быстрый', () => {
    expect(matchCommand('переключи на самый быстрый')).toEqual({ type: 'switch-node', query: 'best' });
  });
  it('голый глагол — пустой запрос (переспрос)', () => {
    expect(matchCommand('смени узел')).toEqual({ type: 'switch-node', query: '' });
  });
  it('смена узла не схватывает команды про фильтр', () => {
    expect(matchCommand('смени на иммунитет')).toEqual({ type: 'shield-on' });
  });
  it('жалоба на узел — диагностика, а не смена', () => {
    expect(matchCommand('финляндия опять не работает')).toEqual({ type: 'diagnose' });
  });
});

describe('matchCommand — длинные/разговорные фразы', () => {
  it('привет + команда — побеждает команда', () => {
    expect(matchCommand('привет! выруби-ка vpn пожалуйста')).toEqual({ type: 'disconnect' });
    expect(matchCommand('привет, обнови подпискуpls')).toEqual({ type: 'update-sub' });
  });
  it('привет без команды', () => {
    expect(matchCommand('привет как жизнь')).toEqual({ type: 'chat' }); // small-talk перевешивает greet
  });
  it('изи-из-текста без маркеров — null', () => {
    expect(matchCommand('')).toBeNull();
    expect(matchCommand('а')).toBeNull();
    expect(matchCommand('qwerty')).toBeNull();
  });
});

describe('hasGreeting', () => {
  it('ловит приветствия в начале и в середине', () => {
    expect(hasGreeting('привет, включи vpn')).toBe(true);
    expect(hasGreeting('включи vpn, привет')).toBe(true);
    expect(hasGreeting('включи vpn')).toBe(false);
  });
});

describe('looseNameMatch', () => {
  it('вхождение в любую сторону', () => {
    expect(looseNameMatch('netherlands amsterdam', 'nl')).toBe(false); // 'nl' короче — не по substring-правилу
    expect(looseNameMatch('финляндия 01', 'финляндия')).toBe(true);
    expect(looseNameMatch('финляндию', 'финляндия')).toBe(true); // общий префикс ≥6
  });
  it('пустое — false', () => {
    expect(looseNameMatch('', 'de')).toBe(false);
  });
});

describe('describeCommand', () => {
  it('даёт объяснение actionable-командам', () => {
    for (const cmd of [
      { type: 'connect' }, { type: 'disconnect' }, { type: 'restart' },
      { type: 'shield-on' }, { type: 'shield-off' }, { type: 'diagnose' },
      { type: 'update-sub' }, { type: 'status' },
    ] as const) {
      expect(describeCommand(cmd)).toBeTruthy();
    }
    expect(describeCommand({ type: 'switch-node', query: 'фр' })).toContain('фр');
    expect(describeCommand({ type: 'switch-node', query: '' })).toBeNull();
    expect(describeCommand({ type: 'help' })).toBeNull();
  });
});

describe('нечёткое распознавание (опечатки и формы)', () => {
  it('маркеры с опечатками всё равно срабатывают', () => {
    expect(matchCommand('включи имунитет')).toEqual({ type: 'shield-on' });      // иммунитет
    expect(matchCommand('обновить падписку')).toEqual({ type: 'update-sub' });   // подписку
    expect(matchCommand('перазапусти туннель')).toEqual({ type: 'restart' });    // перезапусти
    expect(matchCommand('праверь все')).toEqual({ type: 'diagnose' });    // проверь
  });
  it('короткие слова не чиним — «стоп» не должно становиться «стол»', () => {
    // «зуб» рядом со «стоп» по Левенштейну, но короткие маркеры не участвуют
    expect(matchCommand('у меня зуб болит')).toBeNull();
  });
});

describe('смысловой fallback — ни одна фраза не уходит в молчание', () => {
  it('тема сеть/VPN без маркеров → диагностика', () => {
    expect(matchCommand('впн какой-то странный сегодня')).toEqual({ type: 'diagnose' });
    expect(matchCommand('ютуб опять эти танцы с бубном')).toEqual({ type: 'diagnose' });
    expect(matchCommand('приватность на нуле совсем')
      ).toEqual({ type: 'diagnose' });
  });
  it('вопрос без маркеров → помощь', () => {
    expect(matchCommand('а можно как-то по-другому?')).toEqual({ type: 'help' });
    expect(matchCommand('сколько стоит этот сервис')).toEqual({ type: 'help' });
  });
  it('полный мусор по-прежнему null', () => {
    expect(matchCommand('qwe rty')).toBeNull();
    expect(matchCommand('йцукен гшщ')).toBeNull();
  });
});

describe('isAffirm / isRefusal', () => {
  it('согласие', () => {
    expect(isAffirm('да')).toBe(true);
    expect(isAffirm('Давай!')).toBe(true);
    expect(isAffirm('ок')).toBe(true);
    expect(isAffirm('ага')).toBe(true);
    expect(isAffirm('да не знаю')).toBe(false); // не голое «да»
  });
  it('отказ', () => {
    expect(isRefusal('нет')).toBe(true);
    expect(isRefusal('не надо')).toBe(true);
    expect(isRefusal('отмена')).toBe(true);
    expect(isRefusal('нет не надо иммунитет')).toBe(false); // это команда, не отказ
  });
});
