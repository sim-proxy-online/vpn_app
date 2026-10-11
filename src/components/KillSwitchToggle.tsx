import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Shield, AlertCircle, Check } from 'lucide-react';
import { nativeToggleKillSwitch, nativeIsKillSwitchEnabled } from '../native/bridge';

interface KillSwitchToggleProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

export default function KillSwitchToggle({ enabled, onToggle }: KillSwitchToggleProps) {
  const [warningVisible, setWarningVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    // Load initial state from native
    const loadInitialState = async () => {
      const isEnabled = await nativeIsKillSwitchEnabled();
      if (isEnabled !== enabled) {
        onToggle(isEnabled);
      }
    };
    loadInitialState();
  }, []);

  const handleToggle = async () => {
    if (loading) return;

    const newState = !enabled;
    setLoading(true);

    try {
      const success = await nativeToggleKillSwitch(newState);
      if (success) {
        onToggle(newState);
        if (newState) {
          setWarningVisible(true);
          setConfirmed(true);
          setTimeout(() => {
            setWarningVisible(false);
            setConfirmed(false);
          }, 5000);
        }
        // Save to localStorage as backup
        localStorage.setItem('sim-killswitch', String(newState));
      }
    } catch (e) {
      console.error('Failed to toggle kill switch:', e);
    } finally {
      setLoading(false);
    }
  };

  const bgClass = enabled
    ? 'bg-[#1a3a2a88] border-[#00ff8833]'
    : 'bg-[#1a1a3a88] border-[#2a2a5a44]';

  const textClass = 'text-white';
  const labelClass = 'text-gray-400';

  return (
    <div className="space-y-3">
      <motion.div
        layout
        className={`rounded-2xl border ${bgClass} p-4 transition-all shadow-sm`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div
              className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-colors ${
                enabled ? 'bg-[#00ff8815] text-[#00ff88]' : 'bg-gray-500/10 text-gray-500'
              }`}
              style={enabled ? { boxShadow: '0 0 15px #00ff8811' } : {}}
            >
              {/* Без бесконечной пульсации: из-за неё открытый раздел перерисовывался ~90 раз в секунду впустую. */}
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <div className={`font-bold text-[15px] ${textClass}`}>Kill Switch</div>
              <div className={`text-[11px] font-medium leading-tight mt-0.5 ${labelClass}`}>
                {enabled
                  ? 'Блокировка трафика без VPN активна'
                  : 'Трафик разрешен даже если VPN отключен'}
              </div>
            </div>
          </div>

          {/* Toggle Button */}
          <button
            onClick={handleToggle}
            disabled={loading}
            className={`relative w-12 h-6 rounded-full transition-all duration-300 ${
              enabled
                ? 'bg-[#00ff88]'
                : 'bg-[#2a2a5a]'
            } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <motion.div
              initial={false}
              animate={{
                x: enabled ? 26 : 2,
              }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              className="absolute top-1 w-4 h-4 bg-white rounded-full shadow-md flex items-center justify-center"
            >
              {loading && (
                <div className="w-2 h-2 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              )}
            </motion.div>
          </button>
        </div>
      </motion.div>

      {/* Confirmation */}
      {confirmed && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className={`rounded-lg border ${
            'border-green-700/50 bg-green-900/20'
          } p-3 flex gap-2`}
        >
          <Check className={`w-5 h-5 flex-shrink-0 ${
            'text-green-400'
          }`} />
          <div className={`text-sm text-green-200`}>
            <strong>Kill Switch активирован!</strong> Весь трафик будет заблокирован, если VPN отключится.
          </div>
        </motion.div>
      )}

      {/* Warning */}
      {warningVisible && !confirmed && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className={`rounded-lg border ${
            'border-orange-700/50 bg-orange-900/20'
          } p-3 flex gap-2`}
        >
          <AlertCircle className={`w-5 h-5 flex-shrink-0 ${
            'text-orange-400'
          }`} />
          <div className={`text-sm text-orange-200`}>
            Kill Switch теперь <strong>отключен</strong>. Интернет работает без VPN.
          </div>
        </motion.div>
      )}

      {/* Info */}
      <div className={`rounded-lg ${
        'bg-blue-900/20 border border-blue-700/30'
      } p-3 text-sm text-blue-200`}>
        <strong>🛡️ Как это работает:</strong>
        <ul className="mt-2 space-y-1 ml-4 list-disc text-xs">
          <li>При разрыве VPN соединения весь интернет блокируется</li>
          <li>Приложения не могут отправлять трафик без VPN</li>
          <li>Защищает от утечек IP адреса</li>
          <li>Переподключается автоматически при восстановлении VPN</li>
        </ul>
      </div>
    </div>
  );
}
