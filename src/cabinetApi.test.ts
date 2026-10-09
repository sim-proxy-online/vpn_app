import { describe, expect, it } from 'vitest';
import {
  cabinetOrigin, isRenewableProfile, renewEligible,
  saveRenewalPending, loadRenewalPending, clearRenewalPending,
} from './utils/cabinetApi';
import type { SubscriptionProfile } from './types';

function profile(over: Partial<SubscriptionProfile> = {}): SubscriptionProfile {
  return {
    id: 'p1',
    name: 'Подписка',
    url: 'https://x.petrovich.party/b6hTdEhwqgV6t59e',
    nodes: [],
    updatedAt: '',
    lastUpdateTimestamp: 0,
    autoUpdate: false,
    status: 'healthy',
    ...over,
  };
}

describe('cabinetOrigin', () => {
  it('uses the x-cabinet-url header when the provider sent it', () => {
    const p = profile({ managed: { cabinetUrl: 'https://panel.example.org/' } });
    expect(cabinetOrigin(p)).toBe('https://panel.example.org');
  });

  it('falls back to our own panel for *.petrovich.party', () => {
    expect(cabinetOrigin(profile())).toBe('https://petrovich.party');
    expect(cabinetOrigin(profile({ url: 'https://petrovich.party/sub' }))).toBe('https://petrovich.party');
  });

  it('is null for foreign hosts without a cabinet header', () => {
    expect(cabinetOrigin(profile({ url: 'https://sub.stranger.example/api/sub/abc' }))).toBeNull();
    expect(cabinetOrigin(profile({ url: '' }))).toBeNull();
  });

  it('rejects unsafe cabinet urls from a header', () => {
    const p = profile({ managed: { cabinetUrl: 'javascript:alert(1)' } });
    expect(cabinetOrigin(p)).toBe('https://petrovich.party');
  });
});

describe('renewal eligibility', () => {
  it('is available only for our own profiles with a url', () => {
    expect(isRenewableProfile(profile())).toBe(true);
    expect(isRenewableProfile(profile({ url: 'https://sub.stranger.example/x' }))).toBe(false);
    expect(isRenewableProfile(profile({ url: '' }))).toBe(false);
  });

  it('the button shows when the subscription is expiring or expired', () => {
    expect(renewEligible(profile({ status: 'healthy' }))).toBe(false);
    expect(renewEligible(profile({ status: 'warning' }))).toBe(true);
    expect(renewEligible(profile({ status: 'expired' }))).toBe(true);
    expect(renewEligible(profile({ status: 'error' }))).toBe(false);
    expect(renewEligible(profile({ status: 'warning', url: 'https://sub.stranger.example/x' }))).toBe(false);
  });
});

describe('pending renewal (возобновление после перезапуска)', () => {
  // createdAt берём «сейчас»: старше PENDING_TTL_MS запись считается просроченной
  const rec = () => ({
    profileId: 'p1',
    paymentId: 'pay_123',
    payUrl: 'https://pay.platega.io/invoice/abc',
    createdAt: Date.now(),
  });

  it('round-trips a record and clears it exactly once', () => {
    localStorage.removeItem('sim-renewal-pending');
    const r = rec();
    saveRenewalPending(r);
    expect(loadRenewalPending()).toEqual(r);
    // CAS: модал и фоновый поллинг смотрят один платёж — второй вызов проигрывает
    expect(clearRenewalPending(r.paymentId)).toBe(true);
    expect(loadRenewalPending()).toBeNull();
    expect(clearRenewalPending(r.paymentId)).toBe(false);
  });

  it('does not touch another payment record', () => {
    localStorage.removeItem('sim-renewal-pending');
    const r = rec();
    saveRenewalPending(r);
    expect(clearRenewalPending('other-pay')).toBe(true);
    expect(loadRenewalPending()?.paymentId).toBe(r.paymentId);
    localStorage.removeItem('sim-renewal-pending');
  });

  it('clear without id removes whatever is stored', () => {
    localStorage.removeItem('sim-renewal-pending');
    expect(clearRenewalPending()).toBe(false);
    saveRenewalPending(rec());
    expect(clearRenewalPending()).toBe(true);
    expect(loadRenewalPending()).toBeNull();
  });

  it('drops expired records on read', () => {
    localStorage.removeItem('sim-renewal-pending');
    saveRenewalPending({ ...rec(), createdAt: Date.now() - 41 * 60_000 });
    expect(loadRenewalPending()).toBeNull();
    expect(localStorage.getItem('sim-renewal-pending')).toBeNull();
  });

  it('returns null for garbage in storage', () => {
    localStorage.setItem('sim-renewal-pending', '{broken');
    expect(loadRenewalPending()).toBeNull();
    localStorage.setItem('sim-renewal-pending', JSON.stringify({ paymentId: 42 }));
    expect(loadRenewalPending()).toBeNull();
    localStorage.removeItem('sim-renewal-pending');
  });
});
