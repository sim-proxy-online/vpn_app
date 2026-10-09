import { useEffect, useState } from 'react';
import { withAlpha } from '../utils/color';
import { motion } from 'framer-motion';
import { TrendingDown, Activity } from 'lucide-react';
import { useTheme } from '../ThemeContext';
import { nativeGetConnectionQuality, nativeMeasurePing, ConnectionQuality } from '../native/bridge';

interface ConnectionQualityPanelProps {
  isConnected: boolean;
  testServer?: string;
  testPort?: number;
}

export default function ConnectionQualityPanel({
  isConnected,
  testServer = '8.8.8.8',
  testPort = 443,
}: ConnectionQualityPanelProps) {
  const { isDark } = useTheme();
  const [quality, setQuality] = useState<ConnectionQuality | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isConnected) return;

    const fetchQuality = async () => {
      try {
        const q = await nativeGetConnectionQuality();
        setQuality(q);
      } catch (e) {
        console.error('Failed to fetch connection quality:', e);
      }
    };

    fetchQuality();
    const interval = setInterval(fetchQuality, 5000); // Update every 5 seconds
    return () => clearInterval(interval);
  }, [isConnected]);

  const handleMeasurePing = async () => {
    setLoading(true);
    try {
      await nativeMeasurePing(testServer, testPort);
      // Quality will be updated automatically from the monitor
      const q = await nativeGetConnectionQuality();
      setQuality(q);
    } catch (e) {
      console.error('Failed to measure ping:', e);
    } finally {
      setLoading(false);
    }
  };

  const getQualityColor = (qualityLevel: string): string => {
    switch (qualityLevel) {
      case 'EXCELLENT': return '#00ff88';
      case 'GOOD': return '#ffe600';
      case 'FAIR': return '#ff9500';
      case 'POOR': return '#ff4444';
      case 'DISCONNECTED': return '#ff0000';
      default: return '#888888';
    }
  };

  const getQualityLabel = (qualityLevel: string): string => {
    const labels: Record<string, string> = {
      'EXCELLENT': 'Отличное',
      'GOOD': 'Хорошее',
      'FAIR': 'Среднее',
      'POOR': 'Плохое',
      'DISCONNECTED': 'Отключено',
      'UNKNOWN': 'Неизвестно',
    };
    return labels[qualityLevel] || 'Неизвестно';
  };

  const bgClass = isDark
    ? 'bg-gradient-to-br from-[#1a1a3e] to-[#0f0f2e]'
    : 'bg-gradient-to-br from-[#e8f0ff] to-[#f0f2f5]';
  const borderClass = isDark ? 'border-[#2a2a5e]' : 'border-[#d0d8e0]';
  const textClass = isDark ? 'text-[#e0e0ff]' : 'text-gray-700';
  const labelClass = isDark ? 'text-[#9090b0]' : 'text-gray-500';

  if (!isConnected || !quality) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className={`rounded-xl border ${borderClass} ${bgClass} p-4 w-full max-w-md`}
      >
        <div className={`text-center ${labelClass} text-sm`}>
          Подключитесь для просмотра качества соединения
        </div>
      </motion.div>
    );
  }

  const qualityColor = getQualityColor(quality.quality);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-xl border ${borderClass} ${bgClass} p-5 w-full max-w-md space-y-3`}
    >
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <Activity className="w-5 h-5" style={{ color: qualityColor }} />
        <h3 className={`font-semibold ${textClass}`}>Качество соединения</h3>
        <motion.div
          className="ml-auto px-3 py-1 rounded-full text-xs font-bold uppercase"
          style={{
            backgroundColor: `${withAlpha(qualityColor, '20')}`,
            color: qualityColor,
            border: `1px solid ${withAlpha(qualityColor, '40')}`,
          }}
        >
          {getQualityLabel(quality.quality)}
        </motion.div>
      </div>

      {/* Quality Score */}
      <div className="flex items-center gap-4 p-3 rounded-lg bg-white/5">
        <div className="flex-1">
          <div className={`text-sm ${labelClass} mb-2`}>Оценка качества</div>
          <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
            <motion.div
              className="h-full"
              style={{ backgroundColor: qualityColor }}
              initial={{ width: 0 }}
              animate={{ width: `${quality.score}%` }}
              transition={{ duration: 0.5 }}
            />
          </div>
        </div>
        <div className={`text-2xl font-bold`} style={{ color: qualityColor }}>
          {quality.score}%
        </div>
      </div>

      {/* Latency Stats */}
      <div className="grid grid-cols-3 gap-2">
        <div className="p-2 rounded-lg bg-white/5">
          <div className={`text-xs ${labelClass} mb-1`}>Среднее</div>
          <div className={`font-bold ${textClass}`}>{Math.round(quality.avgLatency)}ms</div>
        </div>
        <div className="p-2 rounded-lg bg-white/5">
          <div className={`text-xs ${labelClass} mb-1`}>Мин</div>
          <div className={`font-bold ${textClass}`}>{Math.round(quality.minLatency)}ms</div>
        </div>
        <div className="p-2 rounded-lg bg-white/5">
          <div className={`text-xs ${labelClass} mb-1`}>Макс</div>
          <div className={`font-bold ${textClass}`}>{Math.round(quality.maxLatency)}ms</div>
        </div>
      </div>

      {/* Packet Loss */}
      <div className="p-3 rounded-lg bg-white/5">
        <div className="flex items-center gap-2 mb-2">
          <TrendingDown className="w-4 h-4 text-red-400" />
          <span className={`text-sm ${labelClass}`}>Потери пакетов</span>
        </div>
        <div className="flex items-baseline gap-2">
          <div className={`text-xl font-bold`} style={{ color: quality.packetLoss > 5 ? '#ff4444' : '#00ff88' }}>
            {quality.packetLoss.toFixed(2)}%
          </div>
          {quality.packetLoss > 5 && (
            <div className="text-xs text-red-400">⚠️ Высокие потери</div>
          )}
        </div>
      </div>

      {/* Measure Button */}
      <motion.button
        onClick={handleMeasurePing}
        disabled={loading}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        className={`w-full py-2 rounded-lg text-sm font-semibold transition-all ${
          loading
            ? 'bg-white/10 text-gray-500 cursor-not-allowed'
            : isDark
            ? 'bg-gradient-to-r from-[var(--accent)] to-[#00ff88] text-black hover:shadow-lg'
            : 'bg-gradient-to-r from-[var(--accent)] to-[#00ff88] text-black hover:shadow-lg'
        }`}
        style={loading ? {} : { boxShadow: '0 0 20px rgba(var(--accent-rgb),0.3)' }}
      >
        {loading ? 'Измерение...' : '⟲ Измерить пинг'}
      </motion.button>

      {/* Info Footer */}
      <div className={`text-xs ${labelClass} text-center pt-2 border-t ${borderClass}`}>
        Последнее обновление: {new Date(quality.measureTime).toLocaleTimeString('ru-RU')}
      </div>
    </motion.div>
  );
}
