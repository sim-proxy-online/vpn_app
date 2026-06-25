import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BatteryCharging, Shield, ChevronRight, Check, X } from 'lucide-react';
import {
  nativeGetBatteryStatus,
  nativeRequestDozeExemption,
  nativeRequestOemBatterySettings,
  type BatteryStatus,
} from '../native/bridge';

// Производители с агрессивными OEM-килерами (помимо стандартного Doze)
const OEM_NAMES: Record<string, string> = {
  xiaomi: 'Xiaomi / MIUI',
  redmi: 'Redmi / MIUI',
  poco: 'POCO / MIUI',
  samsung: 'Samsung',
  huawei: 'Huawei / EMUI',
  honor: 'Honor',
  vivo: 'Vivo',
  oppo: 'OPPO',
  realme: 'Realme',
  oneplus: 'OnePlus',
  meizu: 'Meizu',
};

const OEM_HINT: Record<string, string> = {
  xiaomi: 'В MIUI: Настройки → Батарея → Экономия энергии → найдите Sim Proxy → «Без ограничений» + «Автозапуск».',
  redmi: 'В MIUI: Настройки → Батарея → Экономия энергии → найдите Sim Proxy → «Без ограничений» + «Автозапуск».',
  poco: 'В MIUI: Настройки → Батарея → Экономия энергии → найдите Sim Proxy → «Без ограничений» + «Автозапуск».',
  samsung: 'В Samsung: Настройки → Уход за устройством → Батарея → Ограничения в фоне → снимите Sim Proxy.',
  huawei: 'В EMUI: Настройки → Батарея → Запуск приложений → переключите Sim Proxy в «Управление вручную» и включите все три пункта.',
  honor: 'В Magic UI: Настройки → Батарея → Запуск приложений → Sim Proxy → управление вручную, всё включить.',
  vivo: 'В Vivo: Настройки → Батарея → Высокое потребление в фоне → разрешите Sim Proxy.',
  oppo: 'В ColorOS: Настройки → Батарея → Другие настройки батареи → разрешения фона → найдите Sim Proxy.',
  realme: 'В Realme UI: Настройки → Батарея → Другие настройки батареи → фоновые разрешения → Sim Proxy.',
  oneplus: 'В OxygenOS: Настройки → Батарея → Оптимизация батареи → найдите Sim Proxy → «Не оптимизировать».',
  meizu: 'В Flyme: Настройки → Батарея → выберите Sim Proxy → отключите ограничения.',
};

function detectOem(manufacturer: string): string | null {
  for (const key of Object.keys(OEM_NAMES)) {
    if (manufacturer.includes(key)) return key;
  }
  return null;
}

type Step = 'doze' | 'oem' | 'done';

interface Props {
  onDone: () => void;
}

export default function BatteryPermSheet({ onDone }: Props) {
  const [step, setStep] = useState<Step>('doze');
  const [status, setStatus] = useState<BatteryStatus | null>(null);
  const [oemKey, setOemKey] = useState<string | null>(null);

  useEffect(() => {
    nativeGetBatteryStatus().then((s) => {
      setStatus(s);
      setOemKey(detectOem(s.manufacturer));
      if (s.doze) {
        // Doze уже выдан — переходим сразу к OEM-шагу или к done
        const oem = detectOem(s.manufacturer);
        setStep(oem ? 'oem' : 'done');
      }
    }).catch(() => {
      setStep('done');
    });
  }, []);

  const handleDoze = async () => {
    await nativeRequestDozeExemption();
    // После диалога проверяем статус
    setTimeout(async () => {
      const s = await nativeGetBatteryStatus().catch(() => ({ doze: true, manufacturer: '' }));
      setStatus(s);
      const oem = detectOem(s.manufacturer);
      setOemKey(oem);
      setStep(oem ? 'oem' : 'done');
    }, 800);
  };

  const handleOem = async () => {
    await nativeRequestOemBatterySettings();
    setStep('done');
  };

  if (step === 'done') {
    return (
      <AnimatePresence>
        <motion.div
          key="done"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[300] flex items-end justify-center pointer-events-none"
        >
          <motion.div
            initial={{ y: 80 }}
            animate={{ y: 0 }}
            exit={{ y: 80 }}
            transition={{ type: 'spring', damping: 22 }}
            className="pointer-events-auto w-full max-w-sm mx-auto mb-8 px-4"
          >
            <div className="rounded-2xl border border-green-500/30 bg-[#0d1a12] px-6 py-5 flex items-center gap-4 shadow-[0_0_40px_#00ff4422]">
              <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
                <Check size={20} className="text-green-400" />
              </div>
              <div>
                <div className="text-white font-semibold text-sm">Готово</div>
                <div className="text-gray-400 text-xs mt-0.5">VPN будет работать стабильно в фоне</div>
              </div>
              <button onClick={onDone} className="ml-auto text-gray-500 hover:text-white transition-colors">
                <X size={18} />
              </button>
            </div>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    );
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-end justify-center">
      {/* Затемнение фона */}
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onDone}
      />

      <motion.div
        initial={{ y: '100%' }} animate={{ y: 0 }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        className="relative w-full max-w-md mx-auto rounded-t-3xl bg-[#0e0e1e] border-t border-x border-white/10 px-6 pt-5 pb-[calc(32px+env(safe-area-inset-bottom,0px))]"
      >
        {/* Ручка */}
        <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mb-6" />

        <AnimatePresence mode="wait">
          {step === 'doze' && (
            <motion.div key="doze" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              {/* Иконка */}
              <div className="w-16 h-16 rounded-2xl bg-[var(--accent,#7c3aed)]/15 border border-[var(--accent,#7c3aed)]/30 flex items-center justify-center mb-5 mx-auto"
                style={{ boxShadow: '0 0 32px #7c3aed22' }}>
                <BatteryCharging size={32} className="text-[var(--accent,#7c3aed)]" />
              </div>

              <h2 className="font-orbitron text-xl font-bold text-white text-center mb-3">
                VPN отключился в фоне
              </h2>
              <p className="text-gray-400 text-sm text-center leading-relaxed mb-2">
                Система ограничила работу приложения для экономии батареи. Одно разрешение — и VPN будет держаться даже при выключенном экране.
              </p>
              <p className="text-gray-500 text-xs text-center leading-relaxed mb-6">
                Это стандартная настройка для всех VPN-приложений. Никаких дополнительных доступов — только разрешение работать в фоне.
              </p>

              {/* Список что это даёт */}
              <div className="rounded-xl bg-white/5 border border-white/8 divide-y divide-white/5 mb-6">
                {[
                  ['VPN держится при выключенном экране', true],
                  ['Автоматическое переподключение при смене сети', true],
                  ['Фоновые пинги для стабильности соединения', true],
                ].map(([text, ok]) => (
                  <div key={text as string} className="flex items-center gap-3 px-4 py-3">
                    <Check size={14} className="text-green-400 shrink-0" />
                    <span className="text-gray-300 text-xs">{text as string}</span>
                  </div>
                ))}
              </div>

              <button
                onClick={handleDoze}
                className="w-full py-4 rounded-2xl text-white font-orbitron text-sm font-black tracking-widest uppercase active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                style={{ background: 'var(--accent,#7c3aed)', boxShadow: '0 0 24px #7c3aed44' }}
              >
                Разрешить <ChevronRight size={16} />
              </button>
              <button onClick={onDone} className="w-full mt-3 py-3 text-gray-500 text-sm text-center hover:text-gray-300 transition-colors">
                Позже
              </button>
            </motion.div>
          )}

          {step === 'oem' && oemKey && (
            <motion.div key="oem" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <div className="w-16 h-16 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center mb-5 mx-auto"
                style={{ boxShadow: '0 0 32px #f59e0b22' }}>
                <Shield size={32} className="text-amber-400" />
              </div>

              <h2 className="font-orbitron text-lg font-bold text-white text-center mb-3">
                Ещё один шаг
              </h2>
              <p className="text-gray-400 text-sm text-center leading-relaxed mb-2">
                На устройствах <span className="text-white font-medium">{OEM_NAMES[oemKey]}</span> есть
                дополнительный механизм экономии батареи, который может отключать VPN.
              </p>

              <div className="rounded-xl bg-amber-500/8 border border-amber-500/20 px-4 py-3 mb-6">
                <p className="text-amber-200/80 text-xs leading-relaxed">{OEM_HINT[oemKey]}</p>
              </div>

              <button
                onClick={handleOem}
                className="w-full py-4 rounded-2xl font-orbitron text-sm font-black tracking-widest uppercase active:scale-[0.98] transition-all flex items-center justify-center gap-2 text-black"
                style={{ background: '#f59e0b', boxShadow: '0 0 24px #f59e0b44' }}
              >
                Открыть настройки <ChevronRight size={16} />
              </button>
              <button onClick={onDone} className="w-full mt-3 py-3 text-gray-500 text-sm text-center hover:text-gray-300 transition-colors">
                Пропустить
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
