import { describe, expect, it } from 'vitest';
import { buildShieldConfig, buildXrayConfig } from './bridge';
import type { RoutingProfile } from '../types';

// Режим «Иммунитет» (фильтр): туннель поднят, но весь трафик идёт direct —
// IP не меняется, а правила блокировки (реклама/трекеры/утечки/списки
// пользователя) продолжают работать. buildShieldConfig перестраивает обычный
// конфиг: прокси-аутбент вырезается, все прокси-правила → direct.

const shield = (settings: Record<string, unknown> = {}, routingProfile?: RoutingProfile) =>
  JSON.parse(buildShieldConfig(settings, routingProfile));

describe('buildShieldConfig', () => {
  it('валидный JSON: outbounds = [direct, dns-out, block], direct — первым (дефолт Xray)', () => {
    const cfg = shield();
    expect(cfg.outbounds.map((o: any) => o.tag)).toEqual(['direct', 'dns-out', 'block']);
    expect(cfg.outbounds[0].protocol).toBe('freedom');
    expect(cfg.outbounds.some((o: any) => o.protocol === 'blackhole')).toBe(true);
  });

  it('прокси/fragment/tor аутбенты вырезаны, ни одного правила на proxy', () => {
    const cfg = shield({ fragEnable: true, torMode: 'all', routing: 'global' });
    const json = JSON.stringify(cfg);
    expect(json).not.toContain('"tag": "proxy"');
    expect(json).not.toContain('"tag": "fragment"');
    expect(json).not.toContain('"tag": "tor"');
    for (const r of cfg.routing.rules) {
      expect(['direct', 'block', 'dns-out']).toContain(r.outboundTag);
    }
  });

  it('catch-all в конце: несовпавший трафик уходит direct', () => {
    const cfg = shield({ routing: 'global' });
    const last = cfg.routing.rules[cfg.routing.rules.length - 1];
    expect(last).toMatchObject({ type: 'field', network: 'tcp,udp', outboundTag: 'direct' });
    // Стратегия only-blocked (белый список блокируемых) тоже переписана в direct.
    const onlyBlocked = shield({ routing: 'only-blocked' });
    for (const r of onlyBlocked.routing.rules) expect(r.outboundTag).not.toBe('proxy');
  });

  it('inbounds как в обычном конфиге: socks-in + tun', () => {
    const cfg = shield();
    expect(cfg.inbounds.map((i: any) => i.tag)).toEqual(['socks-in', 'tun']);
  });

  it('правило adBlock: только когда включена настройка', () => {
    const adsRule = (cfg: any) => cfg.routing.rules.find((r: any) =>
      r.outboundTag === 'block' && Array.isArray(r.domain) && r.domain.includes('geosite:category-ads-all'));
    expect(adsRule(shield({ adBlock: true }))).toBeDefined();
    expect(adsRule(shield({ adBlock: false }))).toBeUndefined();
    expect(adsRule(shield({}))).toBeUndefined(); // по умолчанию выключена
  });

  it('leakProtection по умолчанию ВКЛ (IPv6 и трекеры блокируются), выключается явно', () => {
    const v6Rule = (cfg: any) => cfg.routing.rules.find((r: any) =>
      r.outboundTag === 'block' && Array.isArray(r.ip) && r.ip.includes('::/0'));
    expect(v6Rule(shield({}))).toBeDefined();
    expect(v6Rule(shield({ leakProtection: true }))).toBeDefined();
    expect(v6Rule(shield({ leakProtection: false }))).toBeUndefined();
  });

  it('пользовательские routingRules: block остаётся block, proxy переводится в direct', () => {
    const cfg = shield({
      routingRules: [
        { type: 'field', domain: ['domain:ads.example'], outboundTag: 'block' },
        { type: 'field', domain: ['domain:bank.example'], outboundTag: 'proxy' },
        { type: 'field', ip: ['geoip:ru'], outboundTag: 'direct' },
      ],
    });
    const byDomain = (d: string) => cfg.routing.rules.find((r: any) => Array.isArray(r.domain) && r.domain.includes(d));
    expect(byDomain('domain:ads.example').outboundTag).toBe('block');
    expect(byDomain('domain:bank.example').outboundTag).toBe('direct');
    expect(cfg.routing.rules.find((r: any) => Array.isArray(r.ip) && r.ip.includes('geoip:ru')).outboundTag).toBe('direct');
  });

  it('правила профиля: Block → block, Proxy/Direct → direct (смысл «не блокировать» сохранён)', () => {
    const profile = {
      BlockSites: ['evil.example'],
      BlockIp: ['9.9.9.9/32'],
      DirectSites: ['bank.example'],
      ProxySites: ['youtube.example'],
    } as unknown as RoutingProfile;
    const cfg = shield({}, profile);
    const ruleOf = (key: string, val: string) => cfg.routing.rules.find((r: any) =>
      (Array.isArray(r[key]) ? r[key] : []).includes(val));
    expect(ruleOf('domain', 'domain:evil.example').outboundTag).toBe('block');
    expect(ruleOf('ip', '9.9.9.9/32').outboundTag).toBe('block');
    expect(ruleOf('domain', 'domain:bank.example').outboundTag).toBe('direct');
    expect(ruleOf('domain', 'domain:youtube.example').outboundTag).toBe('direct');
  });

  it('DNS-перехват и приватные сети работают как в обычном конфиге', () => {
    const cfg = shield();
    expect(cfg.routing.rules.some((r: any) => r.port === 53 && r.outboundTag === 'dns-out')).toBe(true);
    expect(cfg.routing.rules.some((r: any) => r.outboundTag === 'direct' && Array.isArray(r.domain) && r.domain.includes('geosite:private'))).toBe(true);
    expect(cfg.dns).toBeDefined();
  });

  it('обычный конфиг от этого не меняется (регрессия buildXrayConfig)', () => {
    const normal = JSON.parse(buildXrayConfig(
      { id: 'n1', name: 't', address: '1.2.3.4', port: 443, protocol: 'vless', remark: '', rawLink: '' } as any,
      { adBlock: true },
    ));
    expect(normal.outbounds.some((o: any) => o.tag === 'proxy')).toBe(true);
    expect(normal.routing.rules.some((r: any) => r.outboundTag === 'proxy')).toBe(true);
  });
});
