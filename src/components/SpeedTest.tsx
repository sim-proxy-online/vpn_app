import { useState } from 'react';
import { motion } from 'framer-motion';
import { Zap, ArrowUp, ArrowDown, RotateCcw } from 'lucide-react';
import { useTheme } from '../ThemeContext';
import { nativeStartSpeedTest, SpeedTestResult } from '../native/bridge';

interface SpeedTestProps {
  isConnected: boolean;
  serverName?: string;
}

export default function SpeedTest({ isConnected, serverName }: SpeedTestProps) {
  const { isDark } = useTheme();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SpeedTestResult | null>(null);
  const [progress, setProgress] = useState(0);

  const startSpeedTest = async () => {
    if (!isConnected) return;

    setTesting(true);
    setProgress(0);
    setResult(null);

    try {
      // Simulate progress updates
      const progressInterval = setInterval(() => {
        setProgress(prev => Math.min(prev + Math.random() * 20, 95));
      }, 200);

      const testResult = await nativeStartSpeedTest();

      clearInterval(progressInterval);
      setProgress(100);
      setResult(testResult);
    } catch (e) {
      console.error('Speed test error:', e);
    } finally {
      setTesting(false);
      setProgress(0);
    }
  };

  const bgClass = isDark
    ? 'bg-gradient-to-br from-[#1a1a3e] to-[#0f0f2e]'
    : 'bg-gradient-to-br from-[#e8f0ff] to-[#f0f2f5]';

  const borderClass = isDark ? 'border-[#2a2a5e]' : 'border-[#d0d8e0]';
  const textClass = isDark ? 'text-[#e0e0ff]' : 'text-gray-700';
  const labelClass = isDark ? 'text-[#9090b0]' : 'text-gray-500';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-xl border ${borderClass} ${bgClass} p-5 w-full max-w-md`}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Zap className={`w-5 h-5 ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`} />
          <h3 className={`font-semibold ${textClass}`}>Тест скорости</h3>
        </div>
        {serverName && <span className={`text-xs ${labelClass}`}>{serverName}</span>}
      </div>

      {!result ? (
        <>
          <motion.button
            onClick={startSpeedTest}
            disabled={!isConnected || testing}
            className={`w-full py-3 rounded-lg font-semibold transition-all ${
              !isConnected || testing
                ? isDark
                  ? 'bg-gray-700/50 text-gray-500 cursor-not-allowed'
                  : 'bg-gray-300/50 text-gray-500 cursor-not-allowed'
                : isDark
                ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:from-purple-500 hover:to-pink-500'
                : 'bg-gradient-to-r from-purple-500 to-pink-500 text-white hover:from-purple-600 hover:to-pink-600'
            }`}
            whileHover={!testing && isConnected ? { scale: 1.02 } : {}}
            whileTap={!testing && isConnected ? { scale: 0.98 } : {}}
          >
            {testing ? `Тестирование... ${Math.round(progress)}%` : 'Начать тест'}
          </motion.button>

          {testing && (
            <motion.div className="mt-3 w-full bg-gray-700/30 rounded-full h-2 overflow-hidden">
              <motion.div
                className="h-full bg-gradient-to-r from-purple-500 to-pink-500"
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.3 }}
              />
            </motion.div>
          )}
        </>
      ) : (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            {/* Download */}
            <motion.div
              className="flex flex-col items-center gap-2 p-3 rounded-lg bg-white/5"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.1 }}
            >
              <ArrowDown className="w-5 h-5 text-green-400" />
              <div className={`text-lg font-bold ${textClass}`}>
                {result.download.toFixed(1)} Mbps
              </div>
              <div className={`text-xs ${labelClass}`}>Загрузка</div>
            </motion.div>

            {/* Upload */}
            <motion.div
              className="flex flex-col items-center gap-2 p-3 rounded-lg bg-white/5"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2 }}
            >
              <ArrowUp className="w-5 h-5 text-blue-400" />
              <div className={`text-lg font-bold ${textClass}`}>
                {result.upload.toFixed(1)} Mbps
              </div>
              <div className={`text-xs ${labelClass}`}>Выгрузка</div>
            </motion.div>

            {/* Ping */}
            <motion.div
              className="flex flex-col items-center gap-2 p-3 rounded-lg bg-white/5"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.3 }}
            >
              <div className="w-5 h-5 text-yellow-400">📡</div>
              <div className={`text-lg font-bold ${textClass}`}>
                {result.ping.toFixed(0)} ms
              </div>
              <div className={`text-xs ${labelClass}`}>Пинг</div>
            </motion.div>
          </div>

          <motion.button
            onClick={() => setResult(null)}
            className={`w-full py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 ${
              isDark
                ? 'bg-gray-700/30 hover:bg-gray-700/50 text-gray-300'
                : 'bg-gray-300/30 hover:bg-gray-300/50 text-gray-700'
            }`}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <RotateCcw size={14} /> Тест заново
          </motion.button>
        </motion.div>
      )}
    </motion.div>
  );
}
