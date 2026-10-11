import { useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, CheckCircle, Loader } from 'lucide-react';
import { nativeTestIpLeak, nativeTestDnsLeak, LeakTestResult } from '../native/bridge';

interface LeakDetectorProps {
  isConnected: boolean;
  vpnIp?: string;
}

export default function LeakDetector({ isConnected, vpnIp: _vpnIp }: LeakDetectorProps) {
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

  const bgClass = 'bg-gradient-to-br from-[#1a1a3e] to-[#0f0f2e]';

  const borderClass = 'border-[#2a2a5e]';
  const textClass = 'text-[#e0e0ff]';
  const labelClass = 'text-[#9090b0]';

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
              ? 'bg-gray-700/50 text-gray-500 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-500 text-white'
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
                  ? 'bg-red-900/20 border-red-700/50'
                  : 'bg-green-900/20 border-green-700/50'
              }`}
            >
              <div className="flex items-start gap-3">
                {ipLeak.hasLeak ? (
                  <AlertTriangle className={`w-5 h-5 flex-shrink-0 text-red-400`} />
                ) : (
                  <CheckCircle className={`w-5 h-5 flex-shrink-0 text-green-400`} />
                )}
                <div className="flex-1">
                  <div className={`font-semibold ${ipLeak.hasLeak ? ('text-red-200') : ('text-green-200')}`}>
                    {ipLeak.hasLeak ? 'Утечка IP обнаружена!' : 'IP защищен'}
                  </div>
                  <div className={`text-sm mt-1 text-gray-300`}>
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
                  ? 'bg-red-900/20 border-red-700/50'
                  : 'bg-green-900/20 border-green-700/50'
              }`}
            >
              <div className="flex items-start gap-3">
                {dnsLeak.leakDetected ? (
                  <AlertTriangle className={`w-5 h-5 flex-shrink-0 text-red-400`} />
                ) : (
                  <CheckCircle className={`w-5 h-5 flex-shrink-0 text-green-400`} />
                )}
                <div className="flex-1">
                  <div className={`font-semibold ${dnsLeak.leakDetected ? ('text-red-200') : ('text-green-200')}`}>
                    {dnsLeak.leakDetected ? 'Утечка DNS обнаружена!' : 'DNS защищен'}
                  </div>
                  {dnsLeak.dnsServers.length > 0 && (
                    <div className={`text-sm mt-2 text-gray-300`}>
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
                  ? 'bg-red-900/20 text-red-200'
                  : 'bg-green-900/20 text-green-200'
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

