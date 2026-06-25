import { useState } from 'react';
import { withAlpha } from '../utils/color';
import { motion } from 'framer-motion';
import { Calendar, TrendingUp, TrendingDown, Clock, Globe } from 'lucide-react';
import { useTheme } from '../ThemeContext';

interface ConnectionRecord {
  id: string;
  date: Date;
  server: string;
  country: string;
  duration: number; // seconds
  dataDown: number; // bytes
  dataUp: number; // bytes
  avgSpeed: number; // Mbps
  quality: 'excellent' | 'good' | 'fair' | 'poor';
  protocol: string;
}

export default function ConnectionHistoryChart() {
  const { isDark } = useTheme();
  const [timeRange, setTimeRange] = useState<'day' | 'week' | 'month'>('week');

  // Mock data for demonstration
  const [records] = useState<ConnectionRecord[]>([
    {
      id: '1',
      date: new Date(Date.now() - 86400000),
      server: 'US West 1',
      country: '🇺🇸',
      duration: 3600,
      dataDown: 1500000000,
      dataUp: 200000000,
      avgSpeed: 45.5,
      quality: 'excellent',
      protocol: 'VLESS',
    },
    {
      id: '2',
      date: new Date(Date.now() - 172800000),
      server: 'EU Central',
      country: '🇩🇪',
      duration: 5400,
      dataDown: 2000000000,
      dataUp: 300000000,
      avgSpeed: 38.2,
      quality: 'good',
      protocol: 'VLESS',
    },
  ]);

  const bgClass = isDark
    ? 'bg-gradient-to-br from-[#1a1a3e] to-[#0f0f2e]'
    : 'bg-gradient-to-br from-[#e8f0ff] to-[#f0f2f5]';
  const borderClass = isDark ? 'border-[#2a2a5e]' : 'border-[#d0d8e0]';
  const textClass = isDark ? 'text-[#e0e0ff]' : 'text-gray-700';
  const labelClass = isDark ? 'text-[#9090b0]' : 'text-gray-500';

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDuration = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}ч ${m}м` : `${m}м`;
  };

  const getQualityColor = (quality: string): string => {
    switch (quality) {
      case 'excellent': return '#00ff88';
      case 'good': return '#ffe600';
      case 'fair': return '#ff9500';
      case 'poor': return '#ff4444';
      default: return '#888888';
    }
  };

  const totalData = records.reduce((sum, r) => sum + r.dataDown + r.dataUp, 0);
  const totalDuration = records.reduce((sum, r) => sum + r.duration, 0);
  const avgSpeed = records.length > 0
    ? (records.reduce((sum, r) => sum + r.avgSpeed, 0) / records.length).toFixed(1)
    : '0';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-xl border ${borderClass} ${bgClass} p-5 w-full`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Calendar className="w-5 h-5" style={{ color: 'var(--accent)' }} />
          <h3 className={`font-semibold ${textClass}`}>История соединений</h3>
        </div>

        {/* Time Range Tabs */}
        <div className="flex gap-2">
          {(['day', 'week', 'month'] as const).map((range) => (
            <motion.button
              key={range}
              onClick={() => setTimeRange(range)}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                timeRange === range
                  ? 'bg-[var(--accent)] text-black'
                  : isDark
                  ? 'bg-white/10 text-white'
                  : 'bg-black/10 text-gray-700'
              }`}
            >
              {range === 'day' ? 'День' : range === 'week' ? 'Неделя' : 'Месяц'}
            </motion.button>
          ))}
        </div>
      </div>

      {/* Stats Summary */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="p-3 rounded-lg bg-white/5">
          <div className={`text-xs ${labelClass} mb-1`}>Всего данных</div>
          <div className={`font-bold ${textClass}`}>{formatBytes(totalData)}</div>
        </div>
        <div className="p-3 rounded-lg bg-white/5">
          <div className={`text-xs ${labelClass} mb-1`}>Время подключения</div>
          <div className={`font-bold ${textClass}`}>{formatDuration(totalDuration)}</div>
        </div>
        <div className="p-3 rounded-lg bg-white/5">
          <div className={`text-xs ${labelClass} mb-1`}>Средняя скорость</div>
          <div className={`font-bold ${textClass}`}>{avgSpeed} Mbps</div>
        </div>
      </div>

      {/* Records List */}
      <div className="space-y-2 max-h-[300px] overflow-y-auto">
        {records.length === 0 ? (
          <div className={`text-center ${labelClass} py-6`}>
            Нет записей за выбранный период
          </div>
        ) : (
          records.map((record) => (
            <motion.div
              key={record.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              className={`p-3 rounded-lg border ${borderClass} bg-white/5`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  {/* Header Row */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg">{record.country}</span>
                    <div>
                      <div className={`text-sm font-semibold ${textClass}`}>
                        {record.server}
                      </div>
                      <div className={`text-xs ${labelClass}`}>
                        {record.date.toLocaleString('ru-RU')}
                      </div>
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                      <span
                        className="px-2 py-0.5 rounded text-xs font-bold"
                        style={{
                          backgroundColor: `${withAlpha(getQualityColor(record.quality), '20')}`,
                          color: getQualityColor(record.quality),
                        }}
                      >
                        {record.quality.toUpperCase()}
                      </span>
                    </div>
                  </div>

                  {/* Stats Row */}
                  <div className="grid grid-cols-4 gap-2 text-xs">
                    <div className="flex items-center gap-1">
                      <Clock className="w-3 h-3" style={{ color: 'var(--accent)' }} />
                      <span className={labelClass}>{formatDuration(record.duration)}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <TrendingDown className="w-3 h-3" style={{ color: '#00ff88' }} />
                      <span className={labelClass}>{formatBytes(record.dataDown)}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <TrendingUp className="w-3 h-3" style={{ color: '#ffe600' }} />
                      <span className={labelClass}>{formatBytes(record.dataUp)}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Globe className="w-3 h-3" style={{ color: '#ff6b35' }} />
                      <span className={labelClass}>{record.avgSpeed} Mbps</span>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className={`mt-4 pt-3 border-t ${borderClass} text-center`}>
        <button
          className={`text-xs font-semibold transition-colors ${
            isDark
              ? 'text-[var(--accent)] hover:text-[#00ffff]'
              : 'text-blue-600 hover:text-blue-700'
          }`}
        >
          Выгрузить отчет
        </button>
      </div>
    </motion.div>
  );
}
