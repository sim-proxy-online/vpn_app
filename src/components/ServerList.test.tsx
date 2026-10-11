import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerNode } from '../types';
import ServerList from './ServerList';

// Плитка «Авто-переключение» стоит на месте прежней кнопки «Быстрейший»; подбор быстрейшего сервера удалён.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const node = (id: string): ServerNode => ({
  id, name: `Сервер ${id}`, address: `${id}.example`, port: 443, protocol: 'vless', remark: '', rawLink: '',
} as ServerNode);

describe('ServerList: плитка «Авто-переключение»', () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = (autoSwitch: boolean, onAutoSwitchChange = vi.fn()) => {
    act(() => {
      root.render(
        <ServerList
          nodes={[node('one'), node('two')]}
          selectedNode={null}
          onSelect={() => {}}
          onBack={() => {}}
          isConnected={false}
          autoSwitch={autoSwitch}
          onAutoSwitchChange={onAutoSwitchChange}
        />,
      );
    });
    return onAutoSwitchChange;
  };
  const tile = () => host.querySelector('button[role="switch"]') as HTMLButtonElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
  });

  it('показывает состояние и переключает его нажатием', () => {
    const onChange = render(false);
    expect(tile().textContent).toContain('Авто-переключение');
    expect(tile().textContent).toContain('Выключено');
    expect(tile().getAttribute('aria-checked')).toBe('false');

    act(() => { tile().click(); });
    expect(onChange).toHaveBeenCalledWith(true);

    const onChangeOn = render(true);
    expect(tile().textContent).toContain('Включено');
    expect(tile().getAttribute('aria-checked')).toBe('true');
    act(() => { tile().click(); });
    expect(onChangeOn).toHaveBeenCalledWith(false);
  });

  it('переключатель на экране один, кнопки «Быстрейший» нет', () => {
    render(false);
    expect(host.querySelectorAll('button[role="switch"]')).toHaveLength(1);
    expect(host.textContent).not.toContain('Быстрейший');
    expect(host.textContent).toContain('Скорость');
  });
});
