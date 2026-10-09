import { Megaphone, Info, CalendarClock, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import type { SubscriptionProfile } from '../types';
import { expiryNotice, isTrustedProfile, trustProfile } from '../utils/appManagement';
import { nativeOpenUrl } from '../native/bridge';

const INFO_COLORS = {
  blue: { fg: '#6cb6ff', bg: 'rgba(59,130,246,0.10)', border: 'rgba(59,130,246,0.35)' },
  green: { fg: '#4ade80', bg: 'rgba(34,197,94,0.10)', border: 'rgba(34,197,94,0.35)' },
  red: { fg: '#ff7b7b', bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.35)' },
} as const;

/**
 * Сообщения и настройки от провайдера подписки (стиль Happ, см. utils/appManagement.ts): объявление,
 * информационная плашка с кнопкой, предупреждение об окончании и переключатель «доверять провайдеру».
 * Ничего не показывает, если провайдер ничего не прислал.
 */
export default function ProviderNotice({ profile, onSave, onRenew }: { profile: SubscriptionProfile; onSave: (p: SubscriptionProfile) => void; onRenew?: () => void }) {
  const m = profile.managed;
  if (!m) return null;
  const expiry = expiryNotice(profile);
  const pendingCount = m.pending ? Object.keys(m.pending).length : 0;
  const trusted = isTrustedProfile(profile);
  const showManagement = pendingCount > 0 || (m.appliedCount ?? 0) > 0 || m.trusted === true;
  if (!m.announce && !m.info && !expiry && !showManagement) return null;
  const info = m.info ? INFO_COLORS[m.info.color] : null;

  return (
    <div className="space-y-2 mb-5">
      {m.announce && (
        <div className="flex items-start gap-2.5 rounded-2xl px-3.5 py-3 border border-white/10 bg-white/[0.04]">
          <Megaphone size={16} className="mt-0.5 shrink-0 text-gray-300" />
          <p className="text-[13px] leading-snug text-gray-100">{m.announce}</p>
        </div>
      )}

      {/* Как у Happ: сообщение об окончании подписки приоритетнее и вытесняет информационный блок. */}
      {m.info && info && !expiry && (
        <div className="rounded-2xl px-3.5 py-3 border" style={{ background: info.bg, borderColor: info.border }}>
          <div className="flex items-start gap-2.5">
            <Info size={16} className="mt-0.5 shrink-0" style={{ color: info.fg }} />
            <p className="text-[13px] leading-snug text-gray-100 flex-1">{m.info.text}</p>
          </div>
          {m.info.buttonText && m.info.buttonLink && (
            <button onClick={() => nativeOpenUrl(m.info!.buttonLink!)}
              className="mt-2.5 px-3.5 py-1.5 rounded-lg text-[12px] font-bold active:scale-95 transition-transform"
              style={{ color: info.fg, border: `1px solid ${info.border}` }}>
              {m.info.buttonText}
            </button>
          )}
        </div>
      )}

      {expiry && (
        <div className="flex items-center gap-2.5 rounded-2xl px-3.5 py-3 border border-[#ffd23f55] bg-[#ffd23f12]">
          <CalendarClock size={16} className="shrink-0 text-[#ffd23f]" />
          <p className="text-[13px] leading-snug text-[#ffe58a] flex-1">{expiry}</p>
          {/* Для наших подписок onRenew ведёт в окно оплаты внутри приложения, иначе — ссылка провайдера. */}
          {(onRenew || m.expire?.buttonLink) && (
            <button onClick={() => (onRenew ? onRenew() : nativeOpenUrl(m.expire!.buttonLink!))}
              className="px-3 py-1.5 rounded-lg text-[12px] font-bold text-[#ffd23f] border border-[#ffd23f55] active:scale-95 transition-transform">
              Продлить
            </button>
          )}
        </div>
      )}

      {showManagement && (
        <div className="flex items-center gap-2.5 rounded-2xl px-3.5 py-3 border border-white/10 bg-white/[0.03]">
          {trusted ? <ShieldCheck size={16} className="shrink-0 text-[#00e08a]" /> : <SlidersHorizontal size={16} className="shrink-0 text-gray-300" />}
          <p className="text-[12px] leading-snug text-gray-300 flex-1">
            {pendingCount > 0
              ? `Провайдер предлагает изменить настройки приложения (${pendingCount}). Пока не применено.`
              : (m.appliedCount ?? 0) > 0
                ? `Провайдер управляет настройками приложения (${m.appliedCount}).`
                : 'Вы разрешили провайдеру управлять настройками приложения.'}
          </p>
          {pendingCount > 0 ? (
            <button onClick={() => onSave(trustProfile(profile, true))}
              className="px-3 py-1.5 rounded-lg text-[12px] font-bold text-black bg-[var(--accent)] active:scale-95 transition-transform">
              Разрешить
            </button>
          ) : m.trusted ? (
            <button onClick={() => onSave(trustProfile(profile, false))}
              className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-gray-200 bg-white/[0.07] border border-white/10 active:scale-95 transition-transform">
              Отключить
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
