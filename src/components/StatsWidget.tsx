import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowUp, ArrowDown, Zap, TrendingUp } from 'lucide-react';
import { useTheme } from '../ThemeContext';
import { nativeGetStats, VpnStats } from '../native/bridge';

interface StatsWidgetProps {
  isConnected: boolean;
}

export default function StatsWidget({ isConnected }: StatsWidgetProps) {
  const { isDark } = useTheme();
  const [stats, setStats] = useState<VpnStats | null>(null);
  const [speedHistory, setSpeedHistory] = useState<number[]>([]);

  useEffect(() => {
    if (!isConnected) return;

    // Fetch stats immediately and then every 2 seconds
    const fetchStats = async () => {
      try {
        const s = await nativeGetStats();
        setStats(s);
        setSpeedHistory(prev => [...prev.slice(-9), s.downlinkSpeed]);
      } catch (e) {
        console.error('Failed to fetch stats:', e);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 2000);
    return () => clearInterval(interval);
  }, [isConnected]);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const formatSpeed = (bytes: number): string => {
    return formatBytes(bytes) + '/s';
  };


  const bgClass = isDark
    ? 'bg-gradient-to-br from-[#1a1a3e] to-[#0f0f2e]'
    : 'bg-gradient-to-br from-[#e8f0ff] to-[#f0f2f5]';

  const borderClass = isDark ? 'border-[#2a2a5e]' : 'border-[#d0d8e0]';
  const textClass = isDark ? 'text-[#e0e0ff]' : 'text-gray-700';
  const labelClass = isDark ? 'text-[#9090b0]' : 'text-gray-500';

  if (!isConnected) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className={`rounded-xl border ${borderClass} ${bgClass} p-4 w-full max-w-md`}
      >
        <div className={`text-center ${labelClass} text-sm`}>
          Подключитесь для просмотра статистики
        </div>
      </motion.div>
    );
  }

  const maxSpeed = Math.max(...speedHistory, stats?.downlinkSpeed || 1);
  const qualityScore = stats
    ? stats.downlinkSpeed > 5000000 ? '⭐⭐⭐⭐⭐'
    : stats.downlinkSpeed > 1000000 ? '⭐⭐⭐⭐'
    : stats.downlinkSpeed > 500000 ? '⭐⭐⭐'
    : '⭐⭐'
    : '○';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-xl border ${borderClass} ${bgClass} p-5 w-full max-w-md`}
    >
      <div className="grid grid-cols-2 gap-3 mb-4">
        {/* Download Speed */}
        <motion.div
          className="flex flex-col gap-2 p-3 rounded-lg bg-white/5"
          key={`down-${stats?.downlinkSpeed}`}
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ duration: 0.3 }}
        >
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-green-500/20">
              <ArrowDown className="w-4 h-4 text-green-400" />
            </div>
            <span className={`text-xs ${labelClass}`}>Загрузка</span>
          </div>
          <div className={`text-lg font-bold ${textClass}`}>
            {stats ? formatSpeed(stats.downlinkSpeed) : '0 B/s'}
          </div>
          <div className={`text-xs ${labelClass}`}>
            {stats ? formatBytes(stats.download) : '0 B'} всего
          </div>
        </motion.div>

        {/* Upload Speed */}
        <motion.div
          className="flex flex-col gap-2 p-3 rounded-lg bg-white/5"
          key={`up-${stats?.uplinkSpeed}`}
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ duration: 0.3 }}
        >
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-blue-500/20">
              <ArrowUp className="w-4 h-4 text-blue-400" />
            </div>
            <span className={`text-xs ${labelClass}`}>Выгрузка</span>
          </div>
          <div className={`text-lg font-bold ${textClass}`}>
            {stats ? formatSpeed(stats.uplinkSpeed) : '0 B/s'}
          </div>
          <div className={`text-xs ${labelClass}`}>
            {stats ? formatBytes(stats.upload) : '0 B'} всего
          </div>
        </motion.div>
      </div>

      {/* Quality & Latency */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="flex flex-col gap-2 p-3 rounded-lg bg-white/5">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-yellow-400" />
            <span className={`text-xs ${labelClass}`}>Качество</span>
          </div>
          <div className={`text-lg font-bold text-yellow-400`}>
            {qualityScore}
          </div>
        </div>
        <div className="flex flex-col gap-2 p-3 rounded-lg bg-white/5">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-purple-400" />
            <span className={`text-xs ${labelClass}`}>Пинг</span>
          </div>
          <div className={`text-lg font-bold text-purple-400`}>
            {stats?.latency ? `${Math.round(stats.latency)}ms` : '─'}
          </div>
        </div>
      </div>

      {/* Speed Graph */}
      {speedHistory.length > 1 && (
        <div className="pt-3 border-t" style={{ borderColor: isDark ? '#2a2a5e' : '#d0d8e0' }}>
          <div className={`text-xs ${labelClass} mb-2`}>Скорость загрузки (последние 20 сек)</div>
          <div className="flex items-end gap-1 h-10">
            {speedHistory.map((speed, i) => (
              <motion.div
                key={i}
                className="flex-1 rounded-t bg-gradient-to-t from-green-500 to-green-300 opacity-70"
                style={{ height: `${(speed / maxSpeed) * 100}%`, minHeight: '2px' }}
                initial={{ height: 0 }}
                animate={{ height: `${(speed / maxSpeed) * 100}%` }}
                transition={{ duration: 0.2 }}
              />
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}
