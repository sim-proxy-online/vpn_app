import { describe, expect, it } from 'vitest';
import { parseSimUrl } from './data';

// App.tsx решает по `type`, какие действия из sim:// ссылок требуют подтверждения
// пользователя (import / subscribe / routing_add / vpn_off), а какие нет (vpn_on).
describe('parseSimUrl', () => {
  it('maps quick actions', () => {
    expect(parseSimUrl('sim://vpn/on')).toEqual({ type: 'vpn_on' });
    expect(parseSimUrl('sim://vpn/off')).toEqual({ type: 'vpn_off' });
    expect(parseSimUrl('happ://vpn/off')).toEqual({ type: 'vpn_off' });
  });

  it('recognises subscription links in the supported forms', () => {
    const url = 'https://example.com/sub/token';
    expect(parseSimUrl(`sim://add/${url}`)).toEqual({ type: 'subscribe', url });
    expect(parseSimUrl(`sim://subscribe/${url}`)).toEqual({ type: 'subscribe', url });
    expect(parseSimUrl(`sim://import/${encodeURIComponent(url)}`)).toEqual({ type: 'subscribe', url });
  });

  it('parses a routing profile and requires a Name', () => {
    const profile = { Name: 'Mine', Rules: [] };
    const b64 = btoa(JSON.stringify(profile));
    expect(parseSimUrl(`sim://routing/add/${b64}`)).toMatchObject({ type: 'routing_add', profile });
    const noName = btoa(JSON.stringify({ Rules: [] }));
    expect(parseSimUrl(`sim://routing/add/${noName}`)?.type).not.toBe('routing_add');
  });

  it('ignores foreign schemes and empty input', () => {
    expect(parseSimUrl('https://example.com')).toBeNull();
    expect(parseSimUrl('javascript:alert(1)')).toBeNull();
    expect(parseSimUrl('')).toBeNull();
  });
});
