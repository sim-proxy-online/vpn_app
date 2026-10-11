import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerNode, SubscriptionProfile } from '../types';

vi.mock('../native/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../native/bridge')>();
  return { ...actual, startPingBatch: vi.fn(() => () => {}), nativeWarmupCore: vi.fn(async () => {}) };
});

import HomeProfilePanel from './HomeProfilePanel';
import { startPingBatch } from '../native/bridge';

// Панель профиля на главной — только для широкого экрана. На телефоне она раньше пряталась стилем, но работала:
// при каждом открытии главной невидимо мерились все серверы профиля.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeProfile(id: string): SubscriptionProfile {
  const nodes = ['a', 'b', 'c'].map((n): ServerNode => ({
    id: `${id}-${n}`, name: `Сервер ${n}`, address: `${n}.example`, port: 443, protocol: 'vless', remark: '', rawLink: '',
  } as ServerNode));
  return { id, name: 'Подписка', url: 'https://example.invalid/sub', nodes, updatedAt: '', lastUpdateTimestamp: 0, autoUpdate: true, status: 'healthy' };
}

function setScreen(wide: boolean) {
  (window as any).matchMedia = (query: string) => ({
    matches: wide, media: query,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
  });
}

describe('HomeProfilePanel', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  const mount = (profile: SubscriptionProfile) => {
    root = createRoot(host);
    act(() => {
      root!.render(
        <HomeProfilePanel
          profiles={[profile]}
          activeProfileId={profile.id}
          onSelectNode={() => {}}
          onSetActive={() => {}}
          onUpdateProfile={async () => {}}
          onGoToProfiles={() => {}}
        />
      );
    });
  };
  const unmount = () => { act(() => { root?.unmount(); }); root = null; };
  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(startPingBatch).mockClear();
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => {
    unmount();
    host.remove();
    vi.useRealTimers();
    delete (window as any).matchMedia;
  });

  it('is not mounted on a narrow screen and measures nothing', () => {
    setScreen(false);
    mount(makeProfile('narrow'));
    wait(5000);
    expect(host.innerHTML).toBe('');
    expect(startPingBatch).not.toHaveBeenCalled();
  });

  it('measures the profile servers once on a wide screen', () => {
    setScreen(true);
    const profile = makeProfile('wide');
    mount(profile);
    expect(host.textContent).toContain('Сервер a');
    wait(1100);
    expect(startPingBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startPingBatch).mock.calls[0][0]).toBe(profile.nodes);
  });

  it('does not measure again when the home screen is reopened in the same session', () => {
    setScreen(true);
    const profile = makeProfile('reopen');
    mount(profile);
    wait(1100);
    unmount();
    mount(profile);
    wait(5000);
    expect(startPingBatch).toHaveBeenCalledTimes(1);
  });

  it('keeps the measured values after the home screen is reopened', () => {
    setScreen(true);
    const profile = makeProfile('values');
    mount(profile);
    wait(1100);
    const onItem = vi.mocked(startPingBatch).mock.calls[0][1];
    act(() => { onItem(profile.nodes[0].id, 137); });
    expect(host.textContent).toContain('137 мс');
    unmount();
    mount(profile);
    expect(host.textContent).toContain('137 мс');
  });

  it('respects the provider switch that turns measuring on open off', () => {
    setScreen(true);
    localStorage.setItem('sim-ping-on-open', 'false');
    mount(makeProfile('off'));
    wait(5000);
    expect(startPingBatch).not.toHaveBeenCalled();
  });
});
