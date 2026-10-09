import { describe, it, expect } from 'vitest';
import { THIRD_PARTY_COMPONENTS, componentsWithNotice, MIHOMO_SOURCE_URL } from './thirdPartyLicenses';

describe('thirdPartyLicenses', () => {
  it('у каждого компонента есть имя, лицензия, https-ссылка и описание', () => {
    for (const c of THIRD_PARTY_COMPONENTS) {
      expect(c.name.trim().length).toBeGreaterThan(0);
      expect(c.license).toBeTruthy();
      expect(c.url.startsWith('https://')).toBe(true);
      expect(c.usage.trim().length).toBeGreaterThan(0);
    }
  });

  it('имена не повторяются', () => {
    const names = THIRD_PARTY_COMPONENTS.map(c => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('основные ядра перечислены, а GPL-компоненты несут обязательство', () => {
    const byName = (n: string) => THIRD_PARTY_COMPONENTS.find(c => c.name.startsWith(n));
    expect(byName('Xray-core')?.license).toBe('MPL-2.0');
    const mihomo = byName('mihomo');
    expect(mihomo?.license).toBe('GPL-3.0');
    expect(mihomo?.url).toBe(MIHOMO_SOURCE_URL);
    for (const c of THIRD_PARTY_COMPONENTS.filter(x => x.license === 'GPL-3.0')) {
      expect(c.notice, `${c.name}: для GPL нужен текст обязательства`).toBeTruthy();
    }
    expect(componentsWithNotice().length).toBeGreaterThan(0);
  });
});
