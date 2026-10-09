import { useState, type ReactNode } from 'react';
import { Scale, Clapperboard, Gamepad2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { SCENARIO_PRESETS, applyScenarioPreset, getActiveScenario, clearActiveScenario } from '../utils/ScenarioPresets';

// Иконки сценариев: линейные, в стиле остального интерфейса (вместо эмодзи).
const PRESET_ICONS: Record<string, ReactNode> = {
  balanced: <Scale size={20} />,
  streaming: <Clapperboard size={20} />,
  gaming: <Gamepad2 size={20} />,
  privacy: <ShieldCheck size={20} />,
};

/**
 * Панель быстрых пресетов-сценариев. Применение перезаписывает связанные
 * настройки DPI/DNS/маршрутизации. Новые значения вступают в силу при
 * следующем подключении.
 */
export default function ScenarioPresetsPanel({ isConnected }: { isConnected?: boolean }) {
  const [active, setActive] = useState<string | null>(() => getActiveScenario());
  const [flash, setFlash] = useState<string | null>(null);

  const apply = (id: string) => {
    applyScenarioPreset(id);
    setActive(id);
    setFlash(id);
    setTimeout(() => setFlash(null), 1500);
  };

  const clear = () => {
    clearActiveScenario();
    setActive(null);
  };

  return (
    <div className="px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[12px] font-bold text-gray-300 uppercase tracking-wider">Сценарий использования</p>
        {active && (
          <button onClick={clear} className="text-[12px] text-gray-400 hover:text-red-400 transition-colors active:scale-95">
            Отключить
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {SCENARIO_PRESETS.map(p => {
          const isActive = active === p.id;
          return (
            <button key={p.id} onClick={() => apply(p.id)}
              className={`relative flex flex-col items-start gap-1 p-3 rounded-xl border text-left transition-all active:scale-[0.97] ${
                isActive
                  ? 'bg-[var(--accent-a12)] border-[var(--accent-a44)] shadow-[0_0_15px_rgba(var(--accent-rgb),0.08)]'
                  : 'bg-[#12122a] border-[#2a2a5a44] hover:border-[#2a2a5a88]'
              }`}>
              <div className="flex items-center gap-2 w-full">
                <span className={isActive ? 'text-[var(--accent)]' : 'text-gray-300'}>{PRESET_ICONS[p.id]}</span>
                <span className={`text-[13px] font-bold flex-1 leading-tight ${isActive ? 'text-[var(--accent)]' : 'text-white'}`}>{p.name}</span>
                {isActive && <span className="w-2 h-2 rounded-full bg-[var(--accent)] shadow-[0_0_6px_var(--accent)]" />}
              </div>
              <span className="text-[11px] text-gray-400 leading-snug">{p.desc}</span>
              {flash === p.id && (
                <span className="absolute top-1.5 right-1.5 text-[10px] font-bold text-[#00e08a] uppercase">✓ применено</span>
              )}
            </button>
          );
        })}
      </div>
      {isConnected && (
        <p className="flex items-center gap-1.5 text-[11px] text-[#ffd23f] mt-2.5 leading-snug">
          <TriangleAlert size={12} className="shrink-0" /> Переподключитесь, чтобы применить изменения к активному соединению.
        </p>
      )}
    </div>
  );
}
