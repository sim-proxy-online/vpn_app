import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import {
  X, Loader2, CreditCard, Wallet, CheckCircle2, AlertTriangle,
  CalendarDays, Tag, RefreshCw, ExternalLink,
} from 'lucide-react';
import type { SubscriptionProfile } from '../types';
import {
  cabinetOrigin, ensureCabinetSession, fetchPublicConfig, fetchTariffs, fetchMe,
  fetchPaymentStatus, fetchSubscriptionUrl, createPayment, payFromBalance,
  enabledExternalProviders, CabinetError,
  saveRenewalPending, loadRenewalPending, clearRenewalPending,
  type PublicConfig, type CabinetCategory, type CabinetTariff, type TariffPriceOption,
  type CabinetClient, type PaymentSelection,
} from '../utils/cabinetApi';
import { nativeOpenUrl, nativeNotify } from '../native/bridge';

type Phase = 'loading' | 'ready' | 'paying' | 'success' | 'error';

interface RenewSubscriptionProps {
  profile: SubscriptionProfile;
  onClose: () => void;
  onUpdateProfile: (id: string, silent?: boolean) => Promise<boolean | void>;
  /** Нужен только если покупка может создать НОВУЮ подписку (ссылка изменится после оплаты). */
  onSaveProfile?: (p: SubscriptionProfile) => void;
}

function formatDate(ts?: number): string {
  if (!ts) return 'Бессрочно';
  return new Date(ts * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function errMsg(e: unknown): string {
  if (e instanceof CabinetError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return 'Неизвестная ошибка';
}

function priceOf(tariff: CabinetTariff, option?: TariffPriceOption): number {
  return option?.price ?? tariff.price;
}

function daysOf(tariff: CabinetTariff, option?: TariffPriceOption): number | undefined {
  return option?.durationDays ?? tariff.durationDays ?? undefined;
}

/**
 * Продление подписки нашей панели (petrovich.party) прямо из профиля:
 * вход по ссылке-подписке (by-subscription) → тариф → способ оплаты →
 * оплата в браузере → поллинг статуса → автообновление профиля.
 * Показывается только для renewEligible-профилей (см. utils/cabinetApi.ts).
 */
export default function RenewSubscription({ profile, onClose, onUpdateProfile, onSaveProfile }: RenewSubscriptionProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [categories, setCategories] = useState<CabinetCategory[]>([]);
  const [me, setMe] = useState<CabinetClient | null>(null);

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [tariffId, setTariffId] = useState<string | null>(null);
  const [optionId, setOptionId] = useState<string | null>(null);
  const [promo, setPromo] = useState('');
  const [payChoice, setPayChoice] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [payUrl, setPayUrl] = useState<string | null>(null);
  const [paidAt, setPaidAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const origin = cabinetOrigin(profile);
  const pollRef = useRef<number | null>(null);
  const deadRef = useRef(false);
  /** id созданного платежа: по нему запись снимается с поллинга (см. clearRenewalPending). */
  const payIdRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) { clearTimeout(pollRef.current); pollRef.current = null; }
  }, []);

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      await ensureCabinetSession(profile);
      const [cfgR, catR, meR] = await Promise.all([
        fetchPublicConfig(profile), fetchTariffs(profile), fetchMe(profile),
      ]);
      if (deadRef.current) return;
      if (meR.isBlocked) throw new CabinetError(403, 'Аккаунт недоступен');
      if (catR.length === 0 || catR.every(c => (c.tariffs ?? []).length === 0)) {
        throw new CabinetError(0, 'Тарифы не найдены — откройте кабинет в браузере');
      }
      setCfg(cfgR); setCategories(catR); setMe(meR);

      // Предвыбор: текущий тариф клиента и его первый вариант цены.
      const cur = meR.currentTariff;
      const cat = (cur?.categoryId ? catR.find(c => c.id === cur.categoryId) : undefined) ?? catR[0];
      const tariff = (cur ? cat?.tariffs.find(t => t.id === cur.id) : undefined) ?? cat?.tariffs[0];
      setCategoryId(cat?.id ?? null);
      setTariffId(tariff?.id ?? null);
      setOptionId(tariff?.priceOptions?.[0]?.id ?? null);
      setPhase('ready');
    } catch (e) {
      if (deadRef.current) return;
      setError(errMsg(e));
      setPhase('error');
    }
  }, [profile]);

  useEffect(() => {
    deadRef.current = false;
    void load();
    return () => { deadRef.current = true; stopPolling(); };
  }, [load, stopPolling]);

  // Таймер ожидания оплаты (показывает, что поллинг живёт).
  useEffect(() => {
    if (phase !== 'paying' || paidAt === null) return;
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - paidAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase, paidAt]);

  const orderedCategories = useMemo(() => {
    const curCatId = me?.currentTariff?.categoryId;
    if (!curCatId) return categories;
    return [...categories].sort((a, b) => (a.id === curCatId ? -1 : 0) - (b.id === curCatId ? -1 : 0));
  }, [categories, me]);

  const category = categories.find(c => c.id === categoryId) ?? null;
  const tariff = category?.tariffs.find(t => t.id === tariffId) ?? null;
  const option = tariff?.priceOptions?.find(o => o.id === optionId) ?? tariff?.priceOptions?.[0] ?? null;
  const price = tariff ? priceOf(tariff, option ?? undefined) : 0;
  const currency = (tariff?.currency || cfg?.defaultCurrency || 'rub').toUpperCase();

  const plategaMethods = useMemo(() => cfg?.plategaMethods ?? [], [cfg]);
  const external = useMemo(() => (cfg ? enabledExternalProviders(cfg) : []), [cfg]);
  const balance = me?.balance ?? 0;
  const canUseBalance = price > 0 && balance >= price;

  // Первый доступный способ оплаты по умолчанию.
  useEffect(() => {
    if (phase !== 'ready' || payChoice !== null) return;
    if (plategaMethods.length > 0) setPayChoice(`platega:${plategaMethods[0].id}`);
    else if (canUseBalance) setPayChoice('balance');
    else if (external.length > 0) setPayChoice(external[0].id);
  }, [phase, payChoice, plategaMethods, canUseBalance, external]);

  const finishPaid = useCallback(async () => {
    stopPolling();
    // Кто первый снял запись незавершённой оплаты — тот и обновляет профиль: фоновое
    // возобновление (App.tsx) может поллить тот же платёж параллельно с модалом.
    const owner = payIdRef.current ? clearRenewalPending(payIdRef.current) : true;
    payIdRef.current = null;
    setPhase('success');
    if (!owner) return;
    try { nativeNotify('Квадрат Петровича', 'Подписка продлена'); } catch { /* без уведомления */ }
    try {
      // Покупка нового тарифа может выдать новую ссылку подписки — сохраняем её до обновления.
      if (onSaveProfile) {
        const newUrl = await fetchSubscriptionUrl(profile);
        if (newUrl && newUrl !== profile.url) {
          onSaveProfile({ ...profile, url: newUrl });
          await new Promise(r => setTimeout(r, 250));
        }
      }
      await onUpdateProfile(profile.id, true);
    } catch { /* срок обновится при следующем ручном обновлении профиля */ }
  }, [profile, onSaveProfile, onUpdateProfile, stopPolling]);

  const startPolling = useCallback((paymentId: string) => {
    stopPolling();
    const started = Date.now();
    const tick = async () => {
      if (deadRef.current) return;
      try {
        const status = await fetchPaymentStatus(profile, paymentId);
        if (status === 'PAID') { await finishPaid(); return; }
        if (status === 'FAILED') {
          if (payIdRef.current) clearRenewalPending(payIdRef.current);
          payIdRef.current = null;
          setError('Оплата не прошла. Попробуйте ещё раз.');
          setPhase('error');
          return;
        }
      } catch { /* сеть моргнула — продолжаем поллинг */ }
      if (Date.now() - started > 10 * 60_000) {
        setError('Не удалось дождаться оплаты за 10 минут. Если оплата прошла — обновите профиль.');
        setPhase('error');
        return;
      }
      pollRef.current = window.setTimeout(tick, 5000);
    };
    void tick();
  }, [profile, finishPaid, stopPolling]);

  // Оплата создавалась раньше (приложение перезапустили или свернули) — возвращаем экран
  // ожидания с исходного времени: таймер и «Открыть ещё раз» продолжают с того же места.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (phase !== 'ready' || resumedRef.current) return;
    const pending = loadRenewalPending();
    if (!pending || pending.profileId !== profile.id) return;
    resumedRef.current = true;
    payIdRef.current = pending.paymentId;
    setPayUrl(pending.payUrl);
    setPaidAt(pending.createdAt);
    setElapsed(Math.max(0, Math.floor((Date.now() - pending.createdAt) / 1000)));
    setPhase('paying');
    startPolling(pending.paymentId);
  }, [phase, profile.id, startPolling]);

  const handlePay = useCallback(async () => {
    if (!tariff || !payChoice || busy) return;
    setBusy(true);
    setError(null);
    const selection: PaymentSelection = {
      tariffId: tariff.id,
      tariffPriceOptionId: option?.id,
      promoCode: promo.trim() || undefined,
    };
    try {
      if (payChoice === 'balance') {
        await payFromBalance(profile, { ...selection, amount: price, currency: tariff.currency });
        await finishPaid();
        return;
      }
      let providerId = payChoice;
      let paymentMethod: number | undefined;
      if (payChoice.startsWith('platega:')) {
        providerId = 'platega';
        paymentMethod = Number(payChoice.slice('platega:'.length));
      }
      const created = await createPayment(profile, providerId, { ...selection, paymentMethod });
      setPayUrl(created.payUrl);
      setPaidAt(Date.now());
      setElapsed(0);
      setPhase('paying');
      // Записываем ДО открытия браузера: если приложение убьют на странице оплаты,
      // при следующем запуске поллинг возобновится (фоновый поллинг в App.tsx).
      payIdRef.current = created.paymentId ?? null;
      if (created.paymentId) {
        saveRenewalPending({ profileId: profile.id, paymentId: created.paymentId, payUrl: created.payUrl, createdAt: Date.now() });
      }
      nativeOpenUrl(created.payUrl);
      if (created.paymentId) startPolling(created.paymentId);
    } catch (e) {
      setError(errMsg(e));
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }, [tariff, option, payChoice, promo, price, busy, profile, finishPaid, startPolling]);

  /** «Я оплатил»: с id — быстрая проверка статуса, без id — считаем оплату состоявшейся и обновляем. */
  const handleManualCheck = useCallback(async () => {
    stopPolling();
    await finishPaid();
  }, [finishPaid, stopPolling]);

  const paymentRows: { key: string; label: string; hint: string; icon: typeof CreditCard }[] = [];
  for (const m of plategaMethods) {
    paymentRows.push({ key: `platega:${m.id}`, label: m.label, hint: 'Оплата через Platega', icon: CreditCard });
  }
  if (canUseBalance) {
    paymentRows.push({ key: 'balance', label: 'Мой баланс', hint: `${balance} ${currency}`, icon: Wallet });
  }
  for (const p of external) {
    paymentRows.push({ key: p.id, label: p.label, hint: 'Внешний платёж', icon: CreditCard });
  }

  const body = () => {
    switch (phase) {
      case 'loading':
        return (
          <div className="flex flex-col items-center gap-3 py-10">
            <Loader2 size={28} className="animate-spin text-[var(--accent)]" />
            <p className="text-[11px] font-black uppercase tracking-widest text-gray-400">Загружаем кабинет…</p>
          </div>
        );

      case 'error':
        return (
          <div className="flex flex-col items-center gap-4 py-8 px-2 text-center">
            <AlertTriangle size={30} className="text-[#ff7b7b]" />
            <p className="text-[13px] text-gray-200 leading-snug">{error}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                onClick={() => void load()}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[var(--accent)] text-black text-[11px] font-black uppercase tracking-widest active:scale-95 transition-all"
              >
                <RefreshCw size={13} /> Повторить
              </button>
              {origin && (
                <button
                  onClick={() => nativeOpenUrl(origin)}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white/[0.05] border border-white/10 text-gray-300 text-[11px] font-black uppercase tracking-widest active:scale-95 transition-all"
                >
                  <ExternalLink size={13} /> Открыть кабинет
                </button>
              )}
            </div>
          </div>
        );

      case 'paying':
        return (
          <div className="flex flex-col items-center gap-4 py-8 px-2 text-center">
            <Loader2 size={30} className="animate-spin text-[var(--accent)]" />
            <p className="text-[14px] font-bold text-white">Ожидаем оплату…</p>
            <p className="text-[12px] text-gray-400 leading-snug">
              Страница оплаты открылась в браузере. Вернитесь в приложение — статус обновится сам.
            </p>
            <p className="text-[11px] font-mono text-gray-500">
              {String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                onClick={() => void handleManualCheck()}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[var(--accent)] text-black text-[11px] font-black uppercase tracking-widest active:scale-95 transition-all"
              >
                <CheckCircle2 size={13} /> Я оплатил
              </button>
              {payUrl && (
                <button
                  onClick={() => nativeOpenUrl(payUrl)}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/[0.05] border border-white/10 text-gray-300 text-[11px] font-black uppercase tracking-widest active:scale-95 transition-all"
                >
                  <ExternalLink size={13} /> Открыть ещё раз
                </button>
              )}
              <button
                onClick={() => { stopPolling(); setPhase('ready'); }}
                className="px-4 py-2.5 rounded-xl text-gray-500 text-[11px] font-black uppercase tracking-widest active:scale-95 transition-all"
              >
                Отмена
              </button>
            </div>
          </div>
        );

      case 'success':
        return (
          <div className="flex flex-col items-center gap-4 py-8 px-2 text-center">
            <CheckCircle2 size={34} className="text-[#00e08a]" />
            <p className="text-[15px] font-bold text-white">Подписка продлена!</p>
            <div className="flex items-center gap-2 text-[12px] text-gray-300">
              <CalendarDays size={14} className="text-[var(--accent)]" />
              Новый срок: <span className="text-white font-bold">{formatDate(profile.traffic?.expire)}</span>
            </div>
            <button
              onClick={onClose}
              className="px-6 py-2.5 rounded-xl bg-[var(--accent)] text-black text-[11px] font-black uppercase tracking-widest active:scale-95 transition-all"
            >
              Готово
            </button>
          </div>
        );

      default:
        return (
          <div className="p-5 space-y-5">
            {/* Текущее состояние подписки */}
            <div className="rounded-2xl px-4 py-3 border border-white/10 bg-white/[0.03] flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-bold text-white truncate">{profile.name}</p>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  {profile.status === 'expired' ? 'Подписка истекла' : 'Истекает'}:{' '}
                  <span className={profile.status === 'expired' ? 'text-[#ff7b7b] font-bold' : 'text-[#ffd23f] font-bold'}>
                    {formatDate(profile.traffic?.expire)}
                  </span>
                </p>
              </div>
              {profile.traffic?.expire !== undefined && (
                <CalendarDays size={18} className="shrink-0 text-[var(--accent)] opacity-70" />
              )}
            </div>

            {/* Тарифы */}
            <div>
              <p className="text-[9px] font-black uppercase tracking-widest text-gray-500 mb-2">Тариф</p>
              <div className="space-y-2">
                {orderedCategories.map(cat => (
                  <div key={cat.id}>
                    {orderedCategories.length > 1 && (
                      <button
                        onClick={() => {
                          setCategoryId(cat.id);
                          const first = cat.tariffs[0];
                          setTariffId(first?.id ?? null);
                          setOptionId(first?.priceOptions?.[0]?.id ?? null);
                        }}
                        className={`w-full flex items-center justify-between px-3.5 py-2 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all ${
                          cat.id === categoryId
                            ? 'bg-[var(--accent)]/10 border border-[var(--accent)]/40 text-[var(--accent)]'
                            : 'bg-white/[0.03] border border-white/10 text-gray-400'
                        }`}
                      >
                        <span className="truncate">{cat.name}</span>
                        {cat.id === me?.currentTariff?.categoryId && (
                          <span className="text-[8px] text-gray-500 ml-2 shrink-0">текущий</span>
                        )}
                      </button>
                    )}
                    {cat.id === categoryId && (
                      <div className="space-y-2 mt-2">
                        {cat.tariffs.map(t => {
                          const selected = t.id === tariffId;
                          const opt = selected ? (option ?? undefined) : t.priceOptions?.[0];
                          return (
                            <div
                              key={t.id}
                              className={`rounded-2xl border transition-all ${
                                selected ? 'border-[var(--accent)]/50 bg-[var(--accent)]/[0.07]' : 'border-white/10 bg-white/[0.03]'
                              }`}
                            >
                              <button
                                onClick={() => { setTariffId(t.id); setOptionId(t.priceOptions?.[0]?.id ?? null); }}
                                className="w-full flex items-center justify-between gap-3 px-4 py-3"
                              >
                                <div className="text-left min-w-0">
                                  <p className={`text-[13px] font-bold truncate ${selected ? 'text-white' : 'text-gray-200'}`}>
                                    {t.name}
                                    {t.id === me?.currentTariffId && (
                                      <span className="ml-2 text-[8px] font-black uppercase tracking-widest text-[var(--accent)]">текущий</span>
                                    )}
                                  </p>
                                  {daysOf(t, opt) !== undefined && (
                                    <p className="text-[11px] text-gray-500">{daysOf(t, opt)} дн.</p>
                                  )}
                                </div>
                                <p className={`text-[14px] font-black shrink-0 ${selected ? 'text-[var(--accent)]' : 'text-white'}`}>
                                  {priceOf(t, opt)} {currency}
                                </p>
                              </button>
                              {selected && (t.priceOptions?.length ?? 0) > 1 && (
                                <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                                  {t.priceOptions.map(o => (
                                    <button
                                      key={o.id}
                                      onClick={() => setOptionId(o.id)}
                                      className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all ${
                                        o.id === optionId
                                          ? 'bg-[var(--accent)] text-black'
                                          : 'bg-white/[0.06] border border-white/10 text-gray-300'
                                      }`}
                                    >
                                      {o.durationDays} дн. · {o.price} {currency}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Способ оплаты */}
            <div>
              <p className="text-[9px] font-black uppercase tracking-widest text-gray-500 mb-2">Способ оплаты</p>
              {paymentRows.length === 0 ? (
                <p className="text-[12px] text-gray-400">Способы оплаты временно недоступны — откройте кабинет в браузере.</p>
              ) : (
                <div className="space-y-2">
                  {paymentRows.map(row => {
                    const selected = payChoice === row.key;
                    const Icon = row.icon;
                    return (
                      <button
                        key={row.key}
                        onClick={() => setPayChoice(row.key)}
                        className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl border transition-all ${
                          selected ? 'border-[var(--accent)]/50 bg-[var(--accent)]/[0.07]' : 'border-white/10 bg-white/[0.03]'
                        }`}
                      >
                        <Icon size={16} className={selected ? 'text-[var(--accent)]' : 'text-gray-400'} />
                        <div className="text-left min-w-0 flex-1">
                          <p className={`text-[13px] font-bold ${selected ? 'text-white' : 'text-gray-200'}`}>{row.label}</p>
                          <p className="text-[10px] text-gray-500">{row.hint}</p>
                        </div>
                        <div className={`w-4 h-4 rounded-full border-2 shrink-0 ${selected ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-gray-600'}`} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Промокод */}
            <div className="relative">
              <Tag size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                value={promo}
                onChange={e => setPromo(e.target.value)}
                placeholder="Промокод (необязательно)"
                maxLength={40}
                className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/10 text-[13px] text-white placeholder-gray-500 outline-none focus:border-[var(--accent)]/50"
              />
            </div>

            {/* Итого + оплата */}
            <div className="pt-1 space-y-3">
              <div className="flex items-center justify-between px-1">
                <span className="text-[10px] font-black uppercase tracking-widest text-gray-500">К оплате</span>
                <span className="text-[17px] font-black text-white">{price} {currency}</span>
              </div>
              <button
                onClick={() => void handlePay()}
                disabled={!tariff || !payChoice || busy}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-[var(--accent)] text-black text-[12px] font-black uppercase tracking-widest active:scale-95 transition-all disabled:opacity-40"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <CreditCard size={15} />}
                {payChoice === 'balance' ? 'Оплатить с баланса' : 'Оплатить'}
              </button>
            </div>
          </div>
        );
    }
  };

  const TITLES: Record<Phase, string> = {
    loading: 'Продление подписки', ready: 'Продление подписки',
    paying: 'Оплата', success: 'Готово', error: 'Продление подписки',
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-3"
      onClick={() => { if (phase !== 'loading' && phase !== 'paying' && !busy) onClose(); }}
    >
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-[440px] max-h-[88dvh] overflow-y-auto scrollbar-none rounded-[26px] border border-white/10 bg-[#0b1220] shadow-[0_0_60px_rgba(0,0,0,0.6)]"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b border-white/5 bg-[#0b1220]/95 backdrop-blur">
          <h2 className="text-[13px] font-black uppercase tracking-widest text-white">{TITLES[phase]}</h2>
          <button
            onClick={() => { if (!busy) onClose(); }}
            className="w-8 h-8 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-gray-400 active:scale-90 transition-all"
          >
            <X size={16} />
          </button>
        </div>
        {body()}
      </motion.div>
    </div>,
    document.body,
  );
}
