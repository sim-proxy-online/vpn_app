import { useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, CheckCircle, Loader } from 'lucide-react';
import { useTheme } from '../ThemeContext';
import { nativeTestIpLeak, nativeTestDnsLeak, LeakTestResult } from '../native/bridge';

interface LeakDetectorProps {
  isConnected: boolean;
  vpnIp?: string;
}

export default function LeakDetector({ isConnected, vpnIp: _vpnIp }: LeakDetectorProps) {
  const { isDark } = useTheme();
  const [testing, setTesting] = useState(false);
  const [ipLeak, setIpLeak] = useState<LeakTestResult | null>(null);
  const [dnsLeak, setDnsLeak] = useState<{ leakDetected: boolean; dnsServers: string[] } | null>(null);

  const runLeakTest = async () => {
    if (!isConnected) return;

    setTesting(true);
    try {
      const [ipRes, dnsRes] = await Promise.all([
        nativeTestIpLeak(),
        nativeTestDnsLeak(),
      ]);

      setIpLeak(ipRes);
      setDnsLeak(dnsRes);
    } catch (e) {
      console.error('Leak test error:', e);
    } finally {
      setTesting(false);
    }
  };

  const bgClass = isDark
    ? 'bg-gradient-to-br from-[#1a1a3e] to-[#0f0f2e]'
    : 'bg-gradient-to-br from-[#e8f0ff] to-[#f0f2f5]';

  const borderClass = isDark ? 'border-[#2a2a5e]' : 'border-[#d0d8e0]';
  const textClass = isDark ? 'text-[#e0e0ff]' : 'text-gray-700';
  const labelClass = isDark ? 'text-[#9090b0]' : 'text-gray-500';

  const hasLeak = ipLeak?.hasLeak || dnsLeak?.leakDetected;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-xl border ${borderClass} ${bgClass} p-5 w-full`}
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className={`font-semibold ${textClass}`}>Проверка утечек</h3>
        <motion.button
          onClick={runLeakTest}
          disabled={!isConnected || testing}
          className={`px-4 py-2 rounded-lg font-medium transition-all text-sm ${
            !isConnected || testing
              ? isDark
                ? 'bg-gray-700/50 text-gray-500 cursor-not-allowed'
                : 'bg-gray-300/50 text-gray-500 cursor-not-allowed'
              : isDark
              ? 'bg-blue-600 hover:bg-blue-500 text-white'
              : 'bg-blue-500 hover:bg-blue-600 text-white'
          }`}
          whileHover={!testing && isConnected ? { scale: 1.05 } : {}}
          whileTap={!testing && isConnected ? { scale: 0.95 } : {}}
        >
          {testing ? (
            <span className="flex items-center gap-2">
              <Loader size={14} className="animate-spin" /> Проверка...
            </span>
          ) : ipLeak ? 'Проверить снова' : 'Начать проверку'}
        </motion.button>
      </div>

      {!ipLeak && !dnsLeak && !testing && (
        <div className={`text-sm ${labelClass} text-center py-4`}>
          Нажмите кнопку для проверки утечек IP и DNS
        </div>
      )}

      {(ipLeak || dnsLeak) && (
        <motion.div className="space-y-3">
          {/* IP Leak Result */}
          {ipLeak && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className={`p-4 rounded-lg border ${
                ipLeak.hasLeak
                  ? isDark
                    ? 'bg-red-900/20 border-red-700/50'
                    : 'bg-red-100/50 border-red-300'
                  : isDark
                  ? 'bg-green-900/20 border-green-700/50'
                  : 'bg-green-100/50 border-green-300'
              }`}
            >
              <div className="flex items-start gap-3">
                {ipLeak.hasLeak ? (
                  <AlertTriangle className={`w-5 h-5 flex-shrink-0 ${isDark ? 'text-red-400' : 'text-red-600'}`} />
                ) : (
                  <CheckCircle className={`w-5 h-5 flex-shrink-0 ${isDark ? 'text-green-400' : 'text-green-600'}`} />
                )}
                <div className="flex-1">
                  <div className={`font-semibold ${ipLeak.hasLeak ? (isDark ? 'text-red-200' : 'text-red-800') : (isDark ? 'text-green-200' : 'text-green-800')}`}>
                    {ipLeak.hasLeak ? 'Утечка IP обнаружена!' : 'IP защищен'}
                  </div>
                  <div className={`text-sm mt-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                    <div>Ваш IP: <span className="font-mono">{ipLeak.ipAddress}</span></div>
                    <div>Страна: <span className="font-mono">{ipLeak.country}</span></div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {/* DNS Leak Result */}
          {dnsLeak && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className={`p-4 rounded-lg border ${
                dnsLeak.leakDetected
                  ? isDark
                    ? 'bg-red-900/20 border-red-700/50'
                    : 'bg-red-100/50 border-red-300'
                  : isDark
                  ? 'bg-green-900/20 border-green-700/50'
                  : 'bg-green-100/50 border-green-300'
              }`}
            >
              <div className="flex items-start gap-3">
                {dnsLeak.leakDetected ? (
                  <AlertTriangle className={`w-5 h-5 flex-shrink-0 ${isDark ? 'text-red-400' : 'text-red-600'}`} />
                ) : (
                  <CheckCircle className={`w-5 h-5 flex-shrink-0 ${isDark ? 'text-green-400' : 'text-green-600'}`} />
                )}
                <div className="flex-1">
                  <div className={`font-semibold ${dnsLeak.leakDetected ? (isDark ? 'text-red-200' : 'text-red-800') : (isDark ? 'text-green-200' : 'text-green-800')}`}>
                    {dnsLeak.leakDetected ? 'Утечка DNS обнаружена!' : 'DNS защищен'}
                  </div>
                  {dnsLeak.dnsServers.length > 0 && (
                    <div className={`text-sm mt-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                      <div className="font-mono">
                        {dnsLeak.dnsServers.map((dns, i) => (
                          <div key={i}>{dns}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {/* Summary */}
          {(ipLeak || dnsLeak) && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className={`p-3 rounded-lg text-sm ${
                hasLeak
                  ? isDark
                    ? 'bg-red-900/20 text-red-200'
                    : 'bg-red-100 text-red-800'
                  : isDark
                  ? 'bg-green-900/20 text-green-200'
                  : 'bg-green-100 text-green-800'
              }`}
            >
              {hasLeak
                ? '⚠️ Обнаружены утечки! Ваша приватность может быть скомпрометирована.'
                : '✓ Ваша приватность защищена! Утечек не обнаружено.'}
            </motion.div>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}

