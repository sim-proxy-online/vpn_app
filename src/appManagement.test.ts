import { describe, expect, it } from 'vitest';
import {
  applyManagement, cleanText, collectParams, expiryNotice, extractManagedParams, isTrustedProfile, migrateUrl,
  normRange, parseBool, safeButtonLink, safeHttpsUrl, statusFromTraffic, trustProfile, userAgentFor, type SettingValue,
} from './utils/appManagement';
import { parseSubscription } from './data';
import type { SubscriptionProfile, SubscriptionTraffic } from './types';

const profile = (over: Partial<SubscriptionProfile> = {}): SubscriptionProfile => ({
  id: 'p1', name: 'Тест', url: 'https://sub.example.org/api/sub/abc?x=1', nodes: [], updatedAt: '', lastUpdateTimestamp: 0,
  autoUpdate: true, status: 'healthy', ...over,
});
const recorder = () => { const w: Record<string, SettingValue> = {}; return { w, write: (k: string, v: SettingValue) => { w[k] = v; } }; };

describe('collectParams', () => {
  it('reads headers and "#key: value" body lines, headers win, unknown keys are dropped', () => {
    const bag = collectParams(
      { 'Fragmentation-Enable': '1', 'x-evil': 'yes', 'sniffing-enable': 'true' },
      '#fragmentation-enable: 0\n#fragmentation-length: 10-20\n#not-a-happ-key: 1\nvless://abc',
    );
    expect(bag['fragmentation-enable']).toBe('1');
    expect(bag['fragmentation-length']).toBe('10-20');
    expect(bag['sniffing-enable']).toBe('true');
    expect(bag['x-evil']).toBeUndefined();
    expect(bag['not-a-happ-key']).toBeUndefined();
  });
});

describe('value helpers', () => {
  it('booleans follow Happ: true/1 enable, any other non-empty value disables', () => {
    expect(parseBool('1')).toBe(true);
    expect(parseBool('TRUE')).toBe(true);
    expect(parseBool('0')).toBe(false);
    expect(parseBool('yes')).toBe(false);
    expect(parseBool('')).toBeUndefined();
  });

  it('ranges are clamped and ordered, junk is rejected', () => {
    expect(normRange('10-20', 1, 2000)).toBe('10-20');
    expect(normRange('50', 1, 2000)).toBe('50');
    expect(normRange('30-10', 1, 2000)).toBe('10-30');
    expect(normRange('0-99999', 1, 2000)).toBe('1-2000');
    expect(normRange('abc', 1, 2000)).toBeUndefined();
    expect(normRange('1-2-3', 1, 2000)).toBeUndefined();
  });

  it('text: base64 prefix decoded, control characters stripped, length capped', () => {
    expect(cleanText('base64:' + btoa(String.fromCharCode(...new TextEncoder().encode('Привет'))), 50)).toBe('Привет');
    expect(cleanText('a\u0000b\nc', 50)).toBe('a b c');
    expect(cleanText('x'.repeat(500), 200)).toHaveLength(200);
    expect(cleanText('   ', 10)).toBeUndefined();
  });

  it('urls: https only, no credentials, no local hosts', () => {
    expect(safeHttpsUrl('https://sub.example.org/x')).toBe('https://sub.example.org/x');
    expect(safeHttpsUrl('http://sub.example.org/x')).toBeUndefined();
    expect(safeHttpsUrl('https://user:pass@sub.example.org/')).toBeUndefined();
    expect(safeHttpsUrl('https://192.168.1.5/x')).toBeUndefined();
    expect(safeHttpsUrl('https://localhost/x')).toBeUndefined();
    expect(safeHttpsUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeButtonLink('tg://resolve?domain=support')).toBe('tg://resolve?domain=support');
    expect(safeButtonLink('file:///etc/passwd')).toBeUndefined();
  });

  it('new-domain keeps the path and query of the current subscription address', () => {
    expect(migrateUrl('https://old.example.org:8443/api/sub/abc?x=1', undefined, 'new.example.net')).toBe('https://new.example.net/api/sub/abc?x=1');
    expect(migrateUrl('https://old.example.org/a', 'https://other.example.net/b', 'ignored.example.net')).toBe('https://other.example.net/b');
    expect(migrateUrl('https://old.example.org/a', undefined, 'not a domain')).toBeUndefined();
    expect(migrateUrl('https://old.example.org/a', 'http://insecure.example.net/', undefined)).toBeUndefined();
  });
});

describe('extractManagedParams', () => {
  it('returns nothing when the provider sent no management parameters', () => {
    expect(extractManagedParams({ 'profile-title': 'x', 'subscription-userinfo': 'upload=1' }, 'vless://abc')).toBeUndefined();
  });

  it('maps the supported settings to the app keys, with validation', () => {
    const p = extractManagedParams({
      'fragmentation-enable': '1', 'fragmentation-packets': 'tlshello', 'fragmentation-length': '5-10',
      'fragmentation-interval': '2-9999', 'fragmentation-maxsplit': '100-200',
      'noises-enable': '1', 'noises-packet-type': 'array', 'noises-delay': '10-20', 'noises-rand': '1-9000',
      'sniffing-enable': '0', 'mux-enable': 'true', 'mux-tcp-connections': '8', 'subscription-autoconnect': '1',
    }, '')!;
    expect(p.settings).toEqual({
      'sim-frag-enable': true, 'sim-frag-packets': 'tlshello', 'sim-frag-length': '5-10', 'sim-frag-interval': '2-500',
      'sim-frag-maxsplit': '100-200', 'sim-noises-enable': true, 'sim-noises-type': 'rand', 'sim-noises-delay': '10-20',
      'sim-noises-rand': '1-8192', 'sim-sniffing': false, 'sim-mux-enabled': true, 'sim-mux-concurrency': 8, 'sim-autoconnect': true,
    });
    expect(p.rejected).toEqual([]);
  });

  it('rejects out-of-range or malformed values instead of applying them', () => {
    const p = extractManagedParams({
      'fragmentation-packets': 'rm -rf', 'fragmentation-length': 'many', 'mux-tcp-connections': '100000',
      'noises-packet-type': 'weird', 'new-url': 'http://insecure.example.net/', 'new-domain': 'localhost',
    }, '')!;
    expect(p.settings).toEqual({});
    expect(p.rejected.sort()).toEqual(['fragmentation-length', 'fragmentation-packets', 'mux-tcp-connections', 'new-domain', 'new-url', 'noises-packet-type']);
  });

  it('parameters that would replace the tunnel or swap credentials are never turned into settings; they are only listed', () => {
    const p = extractManagedParams({
      'custom-tunnel-config': '{}', 'socks-auth-mode': 'manual', 'socks-auth-password': 'secret', 'hide-vpn-icon': '1',
      'tun-type': 'xray', 'fragmentation-enable': '1',
    }, '')!;
    expect(Object.keys(p.settings)).toEqual(['sim-frag-enable']);
    expect(p.ignored.sort()).toEqual(['custom-tunnel-config', 'hide-vpn-icon', 'socks-auth-mode', 'socks-auth-password', 'tun-type']);
  });

  it('a route exclusion that would send everything around the tunnel is rejected', () => {
    const p = extractManagedParams({ 'exclude-routes': '0.0.0.0/0', 'per-app-proxy-mode': 'bypass', 'per-app-proxy-list': 'not a package' }, '')!;
    expect(p.settings['sim-managed-exclude-routes']).toBeUndefined();
    expect(p.settings['sim-managed-per-app']).toBeUndefined();
    expect(p.rejected.sort()).toEqual(['exclude-routes', 'per-app-proxy-mode']);
  });

  it('safe display parameters: announcement, info block with colour fallback, expiry', () => {
    const p = extractManagedParams({
      announce: 'Технические работы', 'sub-info-text': 'Скидка', 'sub-info-color': 'purple', 'sub-info-button-text': 'Открыть',
      'sub-info-button-link': 'https://shop.example.org/', 'sub-expire': '1', 'sub-expire-button-link': 'https://shop.example.org/pay',
    }, '')!;
    expect(p.announce).toBe('Технические работы');
    expect(p.info).toEqual({ text: 'Скидка', color: 'blue', buttonText: 'Открыть', buttonLink: 'https://shop.example.org/' });
    expect(p.expire).toEqual({ warn: true, notify: false, buttonLink: 'https://shop.example.org/pay' });
  });

  it('subscription view parameters: sort order, pin, always expanded, expand now', () => {
    const p = extractManagedParams({ 'subscriptions-sort-type': 'ALPHABET', 'subscription-pin': '1', 'subscriptions-collapse': '0', 'subscriptions-expand-now': 'true' }, '')!;
    expect(p.sortType).toBe('alphabet');
    expect(p.pin).toBe(true);
    expect(p.alwaysExpanded).toBe(true);
    expect(p.expandNow).toBe(true);
    // false у expand-now и true у collapse ничего не включают
    const q = extractManagedParams({ 'subscriptions-collapse': '1', 'subscriptions-expand-now': '0', 'subscriptions-sort-type': 'random' }, '')!;
    expect(q.alwaysExpanded).toBeUndefined();
    expect(q.expandNow).toBeUndefined();
    expect(q.sortType).toBeUndefined();
    expect(q.rejected).toEqual(['subscriptions-sort-type']);
  });

  it('behaviour settings map onto existing app settings: ping type, autoconnect type, update/ping on open, routing', () => {
    const p = extractManagedParams({
      'ping-type': 'proxy-head', 'subscription-autoconnect-type': 'lowestdelay', 'subscription-auto-update-open-enable': '1',
      'subscription-ping-onopen-enabled': '0', 'routing-enable': '0',
    }, '')!;
    expect(p.settings).toEqual({
      'sim-ping-mode': 'proxy', 'sim-autoconnect-type': 'lowestdelay', 'sim-update-on-open': true, 'sim-ping-on-open': false, 'sim-routing': 'global',
    });
    expect(extractManagedParams({ 'ping-type': 'icmp' }, '')!.settings['sim-ping-mode']).toBe('tcp');
    expect(extractManagedParams({ 'routing-enable': '1' }, '')!.settings['sim-routing']).toBeUndefined();
    expect(extractManagedParams({ 'ping-type': 'carrier-pigeon' }, '')!.rejected).toEqual(['ping-type']);
  });

  it('user agent: printable ASCII only', () => {
    expect(extractManagedParams({ 'change-user-agent': 'Mozilla/5.0 (Linux; Android 14)' }, '')!.userAgent).toBe('Mozilla/5.0 (Linux; Android 14)');
    expect(extractManagedParams({ 'change-user-agent': 'bad\u0001agent' }, '')!.rejected).toEqual(['change-user-agent']);
    expect(extractManagedParams({ 'change-user-agent': 'Привет' }, '')!.userAgent).toBeUndefined();
  });

  it('the provider colour (color-profile) is shown for every provider; no parameter or resetcolors means our theme', () => {
    const theme = JSON.stringify({ buttonColor: '#9377FFFF', backgroundColors: ['#3D2A7DFF'] });
    const p = extractManagedParams({ 'color-profile': theme }, '')!;
    expect(p.accent).toBe('#9377ff');
    const stranger = applyManagement(profile(), p, () => {});
    expect(stranger.managed?.accent).toBe('#9377ff');
    // провайдер перестал присылать цвет (или прислал resetcolors) — подписка возвращается в нашу тему
    const cleared = applyManagement(stranger, extractManagedParams({ 'color-profile': 'resetcolors' }, '')!, () => {});
    expect(cleared.managed?.accent).toBeUndefined();
    const silent = applyManagement(stranger, extractManagedParams({ announce: 'Привет' }, '')!, () => {});
    expect(silent.managed?.accent).toBeUndefined();
    // мусор не красит ничего и попадает в список отклонённых
    const junk = extractManagedParams({ 'color-profile': 'not a theme' }, '')!;
    expect(junk.accent).toBeUndefined();
    expect(junk.rejected).toEqual(['color-profile']);
  });

  it('apps and routes become validated plans stored as JSON under sim-managed-*', () => {
    const p = extractManagedParams({
      'per-app-proxy-mode': 'bypass', 'per-app-proxy-list': 'com.google.chrome, ru.sberbankmobile',
      'exclude-routes': '192.168.1.0/24, 10.0.0.0/8',
    }, '')!;
    expect(JSON.parse(String(p.settings['sim-managed-per-app']))).toEqual({ mode: 'bypass', list: ['com.google.chrome', 'ru.sberbankmobile'], replace: false });
    expect(JSON.parse(String(p.settings['sim-managed-exclude-routes']))).toEqual({ list: ['192.168.1.0/24', '10.0.0.0/8'], replace: false });
  });

  it('a button without a safe link loses its label', () => {
    const p = extractManagedParams({ 'sub-info-text': 'x', 'sub-info-button-text': 'Жми', 'sub-info-button-link': 'javascript:alert(1)' }, '')!;
    expect(p.info?.buttonText).toBeUndefined();
    expect(p.info?.buttonLink).toBeUndefined();
  });

  it('cabinet url for in-app renewal is taken only from a safe https link', () => {
    const ok = extractManagedParams({ 'x-cabinet-url': 'https://petrovich.party' }, '')!;
    expect(ok.cabinetUrl).toBe('https://petrovich.party/');
    expect(applyManagement(profile(), ok, () => {}).managed?.cabinetUrl).toBe('https://petrovich.party/');

    const bad = extractManagedParams({ 'x-cabinet-url': 'javascript:alert(1)' }, '')!;
    expect(bad.cabinetUrl).toBeUndefined();
    expect(bad.rejected).toContain('x-cabinet-url');
  });

  it('parseSubscription exposes the parameters from headers and from the body', () => {
    const r = parseSubscription('#sniffing-enable: 1\nvless://11111111-1111-4111-8111-111111111111@example.org:443?security=tls#n', undefined, { 'fragmentation-enable': '1' });
    expect(r.nodes.length).toBe(1);
    expect(r.managed?.settings).toEqual({ 'sim-frag-enable': true, 'sim-sniffing': true });
  });
});

describe('trust and application', () => {
  const params = () => extractManagedParams({ 'fragmentation-enable': '1', 'fragmentation-length': '5-10', announce: 'Привет', 'subscription-auto-update-enable': '0' }, '')!;

  it('an unknown provider only gets the harmless display data; settings wait for permission', () => {
    const { w, write } = recorder();
    const out = applyManagement(profile(), params(), write);
    expect(w).toEqual({});
    expect(out.managed?.announce).toBe('Привет');
    expect(out.managed?.pending).toEqual({ 'sim-frag-enable': true, 'sim-frag-length': '5-10' });
    expect(out.autoUpdate).toBe(true);
    expect(out.url).toBe('https://sub.example.org/api/sub/abc?x=1');
  });

  it('after the user allows it, the waiting settings are applied at once', () => {
    const { w, write } = recorder();
    const waiting = applyManagement(profile(), params(), write);
    const allowed = trustProfile(waiting, true, write);
    expect(w).toEqual({ 'sim-frag-enable': true, 'sim-frag-length': '5-10' });
    expect(allowed.managed?.pending).toBeUndefined();
    expect(allowed.managed?.appliedCount).toBe(2);
    expect(allowed.managed?.trusted).toBe(true);
  });

  it('trusted hosts are applied without asking', () => {
    for (const p of [profile({ url: 'https://sub.petrovich.party/x' })]) {
      const { w, write } = recorder();
      const out = applyManagement(p, params(), write);
      expect(isTrustedProfile(p)).toBe(true);
      expect(w['sim-frag-enable']).toBe(true);
      expect(out.autoUpdate).toBe(false);
      expect(out.managed?.pending).toBeUndefined();
    }
    expect(isTrustedProfile(profile({ url: 'https://petrovich.party.evil.example/x' }))).toBe(false);
  });

  it('the subscription address is migrated only for a trusted profile', () => {
    const p = extractManagedParams({ 'new-domain': 'new.example.net', 'fallback-url': 'https://backup.example.net/sub' }, '')!;
    const stranger = applyManagement(profile(), p, () => {});
    expect(stranger.url).toBe('https://sub.example.org/api/sub/abc?x=1');
    expect(stranger.managed?.fallbackUrl).toBeUndefined();
    const own = applyManagement(profile({ managed: { trusted: true } }), p, () => {});
    expect(own.url).toBe('https://new.example.net/api/sub/abc?x=1');
    expect(own.managed?.fallbackUrl).toBe('https://backup.example.net/sub');
  });

  it('without management data the profile is returned untouched', () => {
    const base = profile();
    expect(applyManagement(base, undefined, () => {})).toBe(base);
  });

  it('server descriptions belong to each server (linkMeta) — a subscription-level header does not touch them', () => {
    const base = profile({ nodes: [{ id: 'a', description: 'Свой' } as any, { id: 'b' } as any] });
    const out = applyManagement(base, extractManagedParams({ serverDescription: 'Узел', announce: 'x' }, '')!, () => {});
    expect(out.nodes.map((n) => n.description)).toEqual(['Свой', undefined]);
  });

  it('view parameters are stored for every provider, the user agent is used only for a trusted one', () => {
    const p = extractManagedParams({ 'subscriptions-sort-type': 'ping', 'subscription-pin': '1', 'change-user-agent': 'MyAgent/1' }, '')!;
    const stranger = applyManagement(profile(), p, () => {});
    expect(stranger.managed).toMatchObject({ sortType: 'ping', pinned: true, userAgent: 'MyAgent/1' });
    expect(userAgentFor(stranger)).toBeUndefined();
    const own = applyManagement(profile({ url: 'https://sub.petrovich.party/x' }), p, () => {});
    expect(userAgentFor(own)).toBe('MyAgent/1');
    // после «Разрешить» подействует сразу, без нового обновления подписки
    expect(userAgentFor(trustProfile(stranger, true, () => {}))).toBe('MyAgent/1');
  });

  it('hide-settings is kept only for a trusted profile', () => {
    const p = extractManagedParams({ 'hide-settings': '1' }, '')!;
    expect(applyManagement(profile(), p, () => {}).managed?.hideSettings).toBeUndefined();
    expect(applyManagement(profile({ managed: { trusted: true } }), p, () => {}).managed?.hideSettings).toBe(true);
  });
});

// Форма реального ответа панели Remnawave (заголовки и конфиги скопированы с боевой подписки, без секретов).
describe('a real Remnawave response', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';
  const headers = {
    announce: 'base64:', 'sub-expire': '1', 'hide-settings': '1', 'support-url': 'https://petrovich.party',
    'profile-title': 'base64:0JrQstCw0LTRgNCw0YIg0J/QtdGC0YDQvtCy0LjRh9Cw',
    'sub-info-text': 'base64:0J3QtSDRgNCw0LHQvtGC0LDQtdGCPyDQntCx0L3QvtCy0LjRgtC1INC/0L7QtNC/0LjRgdC60YMg0Lgg0YHQvNC10L3QuNGC0LUg0LvQvtC60LDRhtC40Y4u',
    'sub-info-color': 'green', 'sub-info-button-link': 'https://petrovich.party/cabinet/login',
    'sub-info-button-text': 'base64:0J7RgtC60YDRi9GC0Ywg0LrQsNCx0LjQvdC10YI=', 'sub-expire-button-link': 'https://t.me/sim_proxy_vpn_bot',
    'profile-update-interval': '2', 'subscription-userinfo': 'upload=0; download=67261110445; total=0; expire=0',
  };
  const config = (remarks: string, host: string, description?: string) => ({
    dns: {}, remarks, routing: {}, inbounds: [], burstObservatory: {},
    outbounds: [{ tag: 'proxy', protocol: 'vless', settings: { vnext: [{ address: host, port: 443, users: [{ id: UUID, encryption: 'none' }] }] },
      streamSettings: { network: 'tcp', security: 'reality', realitySettings: { serverName: 'a.example', publicKey: 'k', shortId: 'ab', fingerprint: 'chrome' } } }],
    ...(description ? { meta: { serverDescription: description } } : {}),
  });
  const body = (withMeta: boolean) => JSON.stringify([
    config('🇷🇺 Автоматический 4G ⚡️', 'a.example', withMeta ? 'LTE автовыбор лучшего' : undefined),
    config('🇷🇺 Универсальный  LTE | БС', 'b.example', withMeta ? 'LTE Все мобильные операторы' : undefined),
  ]);

  it('Happ user agent: plain-text descriptions arrive per server, headers give the info block and hide-settings', () => {
    const r = parseSubscription(body(true), undefined, headers);
    expect(r.name).toBe('Квадрат Петровича');
    expect(r.nodes.map((n) => n.description)).toEqual(['LTE автовыбор лучшего', 'LTE Все мобильные операторы']);
    expect(r.managed?.announce).toBeUndefined(); // «announce: base64:» с пустым текстом — объявления нет
    expect(r.managed?.info).toEqual({ text: 'Не работает? Обновите подписку и смените локацию.', color: 'green', buttonText: 'Открыть кабинет', buttonLink: 'https://petrovich.party/cabinet/login' });
    expect(r.managed?.expire?.warn).toBe(true);
    const applied = applyManagement(profile({ url: 'https://x.petrovich.party/token' }), r.managed, () => {});
    expect(applied.managed?.hideSettings).toBe(true);
  });

  it('v2rayNG user agent: the panel sends no meta, so there are no descriptions — the parameters still work', () => {
    const r = parseSubscription(body(false), undefined, headers);
    expect(r.nodes).toHaveLength(2);
    expect(r.nodes.every((n) => n.description === undefined)).toBe(true);
    expect(r.managed?.info?.color).toBe('green');
  });

  it('the panel can ask for a user agent by header; a trusted host uses it on the next update, a stranger does not', () => {
    const r = parseSubscription(body(false), undefined, { ...headers, 'change-user-agent': 'Happ/2.7.0' });
    const own = applyManagement(profile({ url: 'https://x.petrovich.party/token' }), r.managed, () => {});
    expect(userAgentFor(own)).toBe('Happ/2.7.0');
    const stranger = applyManagement(profile({ url: 'https://sub.example.org/token' }), r.managed, () => {});
    expect(userAgentFor(stranger)).toBeUndefined();
  });
});

describe('expiryNotice', () => {
  const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
  const withExpire = (leftMs: number, e = { warn: true, notify: false }) =>
    profile({ managed: { expire: e }, traffic: { upload: 0, download: 0, total: 0, expire: Math.floor((NOW + leftMs) / 1000) } });

  it('warns within three days and says how many days are left', () => {
    expect(expiryNotice(withExpire(2 * 86_400_000), NOW)).toContain('через 2 дня');
    expect(expiryNotice(withExpire(3_600_000), NOW)).toContain('через 1 день');
    expect(expiryNotice(withExpire(-1000), NOW)).toContain('закончилась');
  });

  it('is silent when far from the end, when not enabled, or without an expiry date', () => {
    expect(expiryNotice(withExpire(10 * 86_400_000), NOW)).toBeNull();
    expect(expiryNotice(withExpire(86_400_000, { warn: false, notify: false }), NOW)).toBeNull();
    expect(expiryNotice(profile({ managed: { expire: { warn: true, notify: true } } }), NOW)).toBeNull();
  });

  it('the in-app banner (sub-expire) and the push (notification-subs-expire) are separate switches', () => {
    const bannerOnly = withExpire(86_400_000, { warn: true, notify: false });
    const pushOnly = withExpire(86_400_000, { warn: false, notify: true });
    expect(expiryNotice(bannerOnly, NOW, 'banner')).not.toBeNull();
    expect(expiryNotice(bannerOnly, NOW, 'push')).toBeNull();
    expect(expiryNotice(pushOnly, NOW, 'banner')).toBeNull();
    expect(expiryNotice(pushOnly, NOW, 'push')).not.toBeNull();
  });
});

describe('statusFromTraffic', () => {
  const traffic = (over: Partial<SubscriptionTraffic> = {}) =>
    ({ upload: 0, download: 0, total: 0, ...over }) as SubscriptionTraffic;

  it('is healthy without traffic or with a comfortable margin', () => {
    expect(statusFromTraffic(undefined)).toBe('healthy');
    expect(statusFromTraffic(traffic({ total: 100, usagePercentage: 10, remainingDays: 30 }))).toBe('healthy');
  });

  it('expires at one day left or above 95% of traffic', () => {
    expect(statusFromTraffic(traffic({ total: 100, remainingDays: 0 }))).toBe('expired');
    expect(statusFromTraffic(traffic({ total: 100, remainingDays: 1 }))).toBe('expired');
    expect(statusFromTraffic(traffic({ total: 100, usagePercentage: 96, remainingDays: 30 }))).toBe('expired');
  });

  it('warns within seven days or above 80% of traffic', () => {
    expect(statusFromTraffic(traffic({ total: 100, remainingDays: 7 }))).toBe('warning');
    expect(statusFromTraffic(traffic({ total: 100, usagePercentage: 85, remainingDays: 30 }))).toBe('warning');
  });
});
