import { useState } from 'react';
import { SCENARIO_PRESETS, applyScenarioPreset, getActiveScenario, clearActiveScenario } from '../utils/ScenarioPresets';

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
        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Сценарий использования</p>
        {active && (
          <button onClick={clear} className="text-[10px] text-gray-500 hover:text-red-400 transition-colors active:scale-95">
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
                <span className="text-lg">{p.emoji}</span>
                <span className={`text-[12px] font-bold flex-1 ${isActive ? 'text-[var(--accent)]' : 'text-white'}`}>{p.name}</span>
                {isActive && <span className="w-2 h-2 rounded-full bg-[var(--accent)] shadow-[0_0_6px_var(--accent)]" />}
              </div>
              <span className="text-[9px] text-gray-500 leading-tight">{p.desc}</span>
              {flash === p.id && (
                <span className="absolute top-1.5 right-1.5 text-[8px] font-bold text-[#00ff88] uppercase">✓ применено</span>
              )}
            </button>
          );
        })}
      </div>
      {isConnected && (
        <p className="text-[9px] text-[#ffe600] mt-2.5 leading-tight">
          ⚠️ Переподключитесь, чтобы применить изменения к активному соединению.
        </p>
      )}
    </div>
  );
}
