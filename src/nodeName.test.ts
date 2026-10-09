import { describe, expect, it } from 'vitest';
import { stripLeadingEmoji } from './utils/nodeName';

describe('stripLeadingEmoji', () => {
  it('removes the whole flag, both regional symbols — no stray boxed letter is left', () => {
    expect(stripLeadingEmoji('🇷🇺 Автоматический 4G ⚡️')).toBe('Автоматический 4G ⚡️');
    expect(stripLeadingEmoji('🇩🇪 Германия • Франкфурт')).toBe('Германия • Франкфурт');
    expect(stripLeadingEmoji('🇺🇸Нью-Йорк')).toBe('Нью-Йорк');
  });

  it('the result never starts with a lone regional indicator', () => {
    for (const n of ['🇷🇺 А', '🇺🇦 Б', '🇬🇧 В', '🇯🇵 Г']) {
      const out = stripLeadingEmoji(n);
      expect(/^\p{Regional_Indicator}/u.test(out)).toBe(false);
    }
  });

  it('removes one other leading emoji too, with its variation selector, modifier and join sequences', () => {
    expect(stripLeadingEmoji('⚡ Быстрый')).toBe('Быстрый');
    expect(stripLeadingEmoji('⚡️ Быстрый')).toBe('Быстрый');
    expect(stripLeadingEmoji('👍🏽 Хороший')).toBe('Хороший');
    expect(stripLeadingEmoji('👨‍💻 Админ')).toBe('Админ');
  });

  it('removes a regional flag made of tag symbols (England)', () => {
    expect(stripLeadingEmoji('🏴󠁧󠁢󠁥󠁮󠁧󠁿 Лондон')).toBe('Лондон');
  });

  it('keeps emoji inside and at the end of the name — they are part of it', () => {
    expect(stripLeadingEmoji('Премиум ⚡ LTE')).toBe('Премиум ⚡ LTE');
    expect(stripLeadingEmoji('Автоматический 4G ⚡️')).toBe('Автоматический 4G ⚡️');
  });

  it('only the first emoji goes: a flag followed by another emoji keeps the second', () => {
    expect(stripLeadingEmoji('🇷🇺 ⚡ Быстрый')).toBe('⚡ Быстрый');
  });

  it('a name that is only an emoji, an empty or a missing name come back as they were', () => {
    expect(stripLeadingEmoji('🇷🇺')).toBe('🇷🇺');
    expect(stripLeadingEmoji('')).toBe('');
    expect(stripLeadingEmoji(undefined)).toBe('');
    expect(stripLeadingEmoji(null)).toBe('');
  });

  it('plain names, digits and Latin are untouched', () => {
    expect(stripLeadingEmoji('Server 1')).toBe('Server 1');
    expect(stripLeadingEmoji('4G LTE')).toBe('4G LTE');
    expect(stripLeadingEmoji('  Москва  ')).toBe('Москва');
  });
});
