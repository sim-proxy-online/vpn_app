import { useState } from 'react';
import { withAlpha } from '../utils/color';
import { ConnectionState } from '../types';

interface NeonButtonProps {
  state: ConnectionState;
  onToggle: () => void;
}

export default function NeonButton({ state, onToggle }: NeonButtonProps) {
  const [clickDisabled, setClickDisabled] = useState(false);
  const isConnected = state === 'connected';
  const isConnecting = state === 'connecting';
  const isVerifying = state === 'verifying';
  const isDisconnecting = state === 'disconnecting';
  const isReconnecting = state === 'reconnecting';
  const isProcessing = isConnecting || isDisconnecting || isVerifying || isReconnecting;

  const handleToggle = () => {
    if (clickDisabled || isProcessing) return;
    setClickDisabled(true);
    onToggle();
    // Safety cooldown to prevent rapid tapping even if state hasn't updated yet
    setTimeout(() => setClickDisabled(false), 800);
  };

  const getColor = () => {
    if (isConnected) return '#00ff88';
    if (isVerifying) return '#ffe600';
    if (isReconnecting) return '#b000ff';
    if (isDisconnecting) return '#ff6600';
    return 'var(--accent)';
  };

  const getLabel = () => {
    if (isConnected) return 'ЗАЩИЩЕНО';
    if (isVerifying) return 'ПРОВЕРКА...';
    if (isReconnecting) return 'ПОВТОР...';
    if (isConnecting) return 'ЗАПУСК...';
    if (isDisconnecting) return 'СТОП...';
    return 'ПОДКЛЮЧИТЬ';
  };

  const color = getColor();

  return (
    <div className="flex flex-col items-center gap-8 sm:gap-10">
      <div className="relative">
        {isProcessing && (
          <div className="absolute inset-[-20px] rounded-full border-2 opacity-20 animate-ping" style={{ borderColor: color }} />
        )}
        {(isConnected || isProcessing) && (
          <div
            className="absolute -inset-10 rounded-full blur-3xl opacity-10"
            style={{ background: `radial-gradient(circle, ${color}, transparent)` }}
          />
        )}

        <button
          onClick={handleToggle}
          disabled={isProcessing && !isReconnecting || clickDisabled}
          className="relative w-52 h-52 sm:w-60 sm:h-60 md:w-64 md:h-64 rounded-full flex items-center justify-center cursor-pointer select-none z-10 disabled:cursor-wait transition-transform duration-100 active:scale-[0.96]"
          style={{
            background: `radial-gradient(circle at center, ${withAlpha(color, '15')} 0%, ${withAlpha(color, '05')} 40%, transparent 75%)`,
            boxShadow: `0 0 60px ${withAlpha(color, '15')}, inset 0 0 40px ${withAlpha(color, '08')}`,
            border: `1.5px solid ${withAlpha(color, '33')}`,
          }}
        >
          {/* Inner ring */}
          <div className="absolute inset-4 rounded-full border border-dashed border-white/5 animate-[spin_20s_linear_infinite]" />

          {/* Glowing ring */}
          <div
            className="absolute inset-0 rounded-full"
            style={{ border: `2px solid ${withAlpha(color, '33')}`, filter: `drop-shadow(0 0 8px ${withAlpha(color, '44')})` }}
          />

          {isProcessing && (
            <div className={`absolute inset-[-8px] ${isVerifying ? 'animate-[spin_0.8s_linear_infinite]' : 'animate-spin'}`}>
              <svg className="w-full h-full" viewBox="0 0 160 160">
                <circle cx="80" cy="80" r="78" fill="none" stroke={color} strokeWidth="3"
                  strokeDasharray={isVerifying ? "80 80" : "40 120"} strokeLinecap="round" />
              </svg>
            </div>
          )}

          <div className="relative z-10 flex flex-col items-center gap-2">
            <svg
              className="w-14 h-14 sm:w-16 sm:h-16 md:w-20 md:h-20"
              viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round"
              style={{ filter: `drop-shadow(0 0 12px ${color})` }}>
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
              <line x1="12" y1="2" x2="12" y2="12" />
            </svg>
          </div>
        </button>
      </div>

      <div className="text-center z-10">
        <div className="relative">
          <p className="relative font-orbitron text-xl sm:text-2xl font-black tracking-[0.4em] uppercase"
            style={{ color, textShadow: `0 0 10px ${withAlpha(color, 'aa')}, 0 0 20px ${withAlpha(color, '66')}` }}>
            {getLabel()}
          </p>
        </div>
      </div>
    </div>
  );
}