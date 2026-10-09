import { useEffect, useState } from 'react';
import { Sparkles, RotateCcw, RefreshCw } from 'lucide-react';
import {
  BYPASS_STRATEGIES, currentNetworkKey, forgetStrategy, getPreferredStrategy,
  isAutoBypassEnabled, setAutoBypassEnabled, type BypassStrategyId,
} from '../utils/autoBypass';
import { activeProfiles, currentOperatorProfile, profilesFetchedAt, refreshOperatorProfiles } from '../utils/operatorProfiles';

/** Подпись сети по ключу: «MOBILE:мтс» → «Мобильная сеть · мтс», «WIFI» → «Wi-Fi». */
function networkLabel(key: string): string {
  const [type, who] = key.split(':');
  const base = type === 'MOBILE' ? 'Мобильная сеть' : type === 'WIFI' ? 'Wi-Fi' : type === 'ETHERNET' ? 'Кабель' : 'Сеть';
  return who ? `${base} · ${who}` : base;
}

/**
 * Карточка «Умный обход» в настройках: переключатель автоподбора режима обхода DPI и то, что
 * приложение уже запомнило для текущей сети (см. utils/autoBypass.ts).
 */
export default function AutoBypassCard() {
  const [on, setOn] = useState(() => isAutoBypassEnabled());
  const [netKey, setNetKey] = useState('');
  const [pref, setPref] = useState<BypassStrategyId | null>(null);

  useEffect(() => {
    let alive = true;
    currentNetworkKey().then((k) => {
      if (!alive) return;
      setNetKey(k);
      setPref(getPreferredStrategy(k));
    });
    return () => { alive = false; };
  }, []);

  const [profilesTick, setProfilesTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const toggle = () => { const next = !on; setOn(next); setAutoBypassEnabled(next); };
  const reset = () => { if (netKey) forgetStrategy(netKey); setPref(null); };
  const refreshProfiles = async () => {
    setRefreshing(true);
    await refreshOperatorProfiles({ force: true });
    setRefreshing(false);
    setProfilesTick((n) => n + 1);
  };
  // profilesTick заставляет перечитать профили из хранилища после обновления.
  void profilesTick;
  const operator = currentOperatorProfile();
  const fetchedAt = profilesFetchedAt();
  const rev = activeProfiles().rev;

  return (
    <div className="mx-4 mt-4 mb-1 rounded-2xl p-4 border border-[var(--accent-a33)]"
      style={{ background: 'linear-gradient(135deg, var(--accent-a12), rgba(47,127,230,0.10))' }}>
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-[var(--accent-a15)] text-[var(--accent)]">
          <Sparkles size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white text-[15px] font-bold leading-tight">Умный обход</p>
          <p className="text-gray-300 text-[12px] mt-1 leading-snug">
            Если подключение не удалось, приложение само попробует другой режим обхода блокировок и запомнит тот, что сработал в вашей сети.
          </p>
        </div>
        <button onClick={toggle} role="switch" aria-checked={on} aria-label="Умный обход"
          className={`relative w-[46px] h-[28px] rounded-full transition-colors shrink-0 ${on ? 'bg-[var(--accent)]' : 'bg-[#2a2a5a]'}`}>
          <span className="absolute top-[3px] w-[22px] h-[22px] rounded-full bg-white shadow transition-all"
            style={{ left: on ? 21 : 3 }} />
        </button>
      </div>

      <div className="mt-3 pt-3 border-t border-white/10 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] text-gray-400">Профиль оператора</p>
          <p className="text-[13px] font-semibold text-white mt-0.5 truncate">
            {operator ? operator.title : 'Не определён'}
            <span className="font-normal text-gray-400"> · {fetchedAt ? `с сервера, версия ${rev}` : 'встроенный'}</span>
          </p>
        </div>
        <button onClick={refreshProfiles} disabled={refreshing}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-gray-200 bg-white/[0.07] border border-white/10 active:scale-95 transition-transform disabled:opacity-60">
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> Обновить
        </button>
      </div>

      {on && netKey && (
        <div className="mt-3 pt-3 border-t border-white/10 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-gray-400">{networkLabel(netKey)}</p>
            <p className="text-[13px] font-semibold text-white mt-0.5">
              {pref ? `Запомнено: ${BYPASS_STRATEGIES[pref].label}` : 'Режим ещё не подбирался'}
            </p>
          </div>
          {pref && (
            <button onClick={reset}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-gray-200 bg-white/[0.07] border border-white/10 active:scale-95 transition-transform">
              <RotateCcw size={12} /> Сбросить
            </button>
          )}
        </div>
      )}
    </div>
  );
}
