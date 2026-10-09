import { motion } from 'framer-motion';
import { ShieldAlert, X } from 'lucide-react';
import type { RoutingProfile, ServerNode } from '../types';

// Действия из sim:// / happ:// ссылок, которые меняют, куда идёт трафик, или
// отключают защиту. Любая веб-страница может открыть такую ссылку, поэтому
// без явного подтверждения пользователя их выполнять нельзя.
export type DeepLinkAction =
  | { type: 'import'; nodes: ServerNode[] }
  | { type: 'subscribe'; url: string }
  | { type: 'routing_add'; profile: RoutingProfile; activate: boolean }
  | { type: 'vpn_off' };

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function describe(action: DeepLinkAction): { title: string; subject?: string; detail: string; confirm: string } {
  switch (action.type) {
    case 'subscribe':
      return {
        title: 'Добавить подписку?',
        subject: hostOf(action.url),
        detail: action.url,
        confirm: 'Добавить',
      };
    case 'import': {
      const n = action.nodes[0];
      return {
        title: 'Добавить сервер?',
        subject: n?.name || n?.address,
        detail: n ? `${n.protocol.toUpperCase()} · ${n.address}:${n.port}` : '',
        confirm: 'Добавить',
      };
    }
    case 'routing_add':
      return {
        title: 'Импортировать маршрутизацию?',
        subject: action.profile.Name,
        detail: 'Правила маршрутизации определяют, какой трафик пойдёт через VPN, а какой мимо него.',
        confirm: 'Импортировать',
      };
    case 'vpn_off':
      return {
        title: 'Отключить VPN?',
        detail: 'Ссылка просит выключить VPN. Пока он отключён, трафик идёт напрямую.',
        confirm: 'Отключить',
      };
  }
}

interface Props {
  action: DeepLinkAction;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function DeepLinkConfirm({ action, onConfirm, onCancel }: Props) {
  const d = describe(action);
  return (
    <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center p-4 bg-black/80 backdrop-blur-md" onClick={onCancel}>
      <motion.div
        onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm bg-[#0d0d22] border border-[#2a2a5a] rounded-3xl p-6 shadow-2xl relative"
        role="dialog" aria-modal="true" aria-label={d.title}
      >
        <button onClick={onCancel} aria-label="Закрыть" className="absolute top-4 right-4 text-gray-500 hover:text-white"><X size={18} /></button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <ShieldAlert size={22} />
          </div>
          <h3 className="font-orbitron text-base font-bold text-white pr-6">{d.title}</h3>
        </div>

        <p className="text-[11px] text-gray-500 mb-3">Запрос пришёл из ссылки. Подтверждайте, только если сами её открыли.</p>

        {d.subject && <p className="text-sm font-semibold text-white break-all mb-1">{d.subject}</p>}
        {d.detail && (
          <p className="text-[11px] text-gray-400 font-mono break-all leading-relaxed max-h-20 overflow-y-auto mb-5 bg-[#12122a] rounded-xl p-3 border border-[#2a2a5a44]">
            {d.detail}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <button onClick={onCancel}
            className="py-3 rounded-2xl bg-[#1a1a3a] text-gray-300 text-xs font-bold uppercase tracking-widest active:scale-95">
            Отмена
          </button>
          <button onClick={onConfirm}
            className="py-3 rounded-2xl bg-[var(--accent)] text-black text-xs font-bold uppercase tracking-widest active:scale-95">
            {d.confirm}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
