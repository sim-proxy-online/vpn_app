import { useState } from 'react';
import { motion } from 'framer-motion';
import { BarChart3 } from 'lucide-react';
import { useTheme } from '../ThemeContext';

interface TrafficStats {
  protocol: string;
  bytesIn: number;
  bytesOut: number;
  packetCount: number;
  percentage: number;
}

export default function TrafficAnalysis() {
  const { isDark } = useTheme();
  const [trafficStats] = useState<TrafficStats[]>([
    { protocol: 'HTTPS', bytesIn: 450000000, bytesOut: 50000000, packetCount: 1250, percentage: 65 },
    { protocol: 'HTTP', bytesIn: 150000000, bytesOut: 20000000, packetCount: 450, percentage: 22 },
    { protocol: 'DNS', bytesIn: 0, bytesOut: 5000000, packetCount: 2500, percentage: 8 },
    { protocol: 'Other', bytesIn: 20000000, bytesOut: 5000000, packetCount: 100, percentage: 5 },
  ]);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0 || isNaN(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
    const val = bytes / Math.pow(k, i);
    return (val.toFixed(2).replace(/\.00$/, '')) + ' ' + sizes[i];
  };

  const bgClass = isDark
    ? 'bg-gradient-to-br from-[#1a1a3e] to-[#0f0f2e]'
    : 'bg-gradient-to-br from-[#e8f0ff] to-[#f0f2f5]';

  const borderClass = isDark ? 'border-[#2a2a5e]' : 'border-[#d0d8e0]';
  const textClass = isDark ? 'text-[#e0e0ff]' : 'text-gray-700';
  const labelClass = isDark ? 'text-[#9090b0]' : 'text-gray-500';

  const colors = ['var(--accent)', '#00ff88', '#ffe600', '#ff6b35'];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-xl border ${borderClass} ${bgClass} p-5 w-full`}
    >
      <div className="flex items-center gap-3 mb-4">
        <BarChart3 className="w-5 h-5" style={{ color: 'var(--accent)' }} />
        <h3 className={`font-semibold ${textClass}`}>Анализ трафика</h3>
      </div>

      {/* Pie Chart */}
      <div className="mb-6 flex justify-center">
        <div className="relative w-48 h-48">
          <svg width="100%" height="100%" viewBox="0 0 200 200" className="drop-shadow-2xl">
            {trafficStats.map((stat, index) => {
              const totalPercentage = trafficStats.reduce((sum, s) => sum + s.percentage, 0);
              const normalizedPercentage = totalPercentage > 0 ? (stat.percentage / totalPercentage) * 100 : 0;

              const startAngle = trafficStats.slice(0, index).reduce((sum, s) => sum + ((s.percentage / (totalPercentage || 1)) * 360), 0);
              const endAngle = startAngle + ((stat.percentage / (totalPercentage || 1)) * 360);

              if (normalizedPercentage === 0) return null;
              if (normalizedPercentage >= 100) {
                return (
                  <circle key={stat.protocol} cx="100" cy="100" r="70" fill="transparent" stroke={colors[index]} strokeWidth="25" />
                );
              }

              const startRad = (startAngle - 90) * Math.PI / 180;
              const endRad = (endAngle - 90) * Math.PI / 180;

              const x1 = 100 + 70 * Math.cos(startRad);
              const y1 = 100 + 70 * Math.sin(startRad);
              const x2 = 100 + 70 * Math.cos(endRad);
              const y2 = 100 + 70 * Math.sin(endRad);

              const largeArc = endAngle - startAngle > 180 ? 1 : 0;

              const pathData = [
                `M 100 100`,
                `L ${x1} ${y1}`,
                `A 70 70 0 ${largeArc} 1 ${x2} ${y2}`,
                'Z'
              ].join(' ');

              return (
                <motion.path
                  key={stat.protocol}
                  d={pathData}
                  fill={colors[index]}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 0.8, scale: 1 }}
                  whileHover={{ opacity: 1, scale: 1.05 }}
                  transition={{ type: 'spring', stiffness: 300 }}
                />
              );
            })}
            <circle cx="100" cy="100" r="45" fill={isDark ? '#0f0f2e' : '#f0f2f5'} />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className={`text-[10px] uppercase tracking-tighter ${labelClass}`}>Трафик</span>
            <span className={`text-lg font-bold ${textClass}`}>100%</span>
          </div>
        </div>
      </div>

      {/* Stats Table */}
      <div className="space-y-2">
        {trafficStats.map((stat, index) => (
          <motion.div
            key={stat.protocol}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.1 }}
            className={`p-3 rounded-lg ${isDark ? 'bg-white/5' : 'bg-black/5'}`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded"
                  style={{ backgroundColor: colors[index] }}
                />
                <span className={`text-sm font-semibold ${textClass}`}>
                  {stat.protocol}
                </span>
              </div>
              <span className={`text-sm font-bold ${textClass}`}>
                {stat.percentage}%
              </span>
            </div>

            {/* Progress bar */}
            <div className={`w-full h-2 rounded-full overflow-hidden ${isDark ? 'bg-white/10' : 'bg-black/10'}`}>
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${stat.percentage}%` }}
                transition={{ duration: 0.8, ease: 'easeOut' }}
                style={{ backgroundColor: colors[index], opacity: 0.7 }}
                className="h-full"
              />
            </div>

            {/* Details */}
            <div className="flex gap-4 mt-2 text-xs">
              <div>
                <span className={labelClass}>Вход:</span>
                <span className={`ml-1 ${textClass}`}>{formatBytes(stat.bytesIn)}</span>
              </div>
              <div>
                <span className={labelClass}>Выход:</span>
                <span className={`ml-1 ${textClass}`}>{formatBytes(stat.bytesOut)}</span>
              </div>
              <div>
                <span className={labelClass}>Пакеты:</span>
                <span className={`ml-1 ${textClass}`}>{stat.packetCount}</span>
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Total */}
      <div className={`mt-4 pt-3 border-t ${borderClass} flex justify-between text-sm`}>
        <span className={labelClass}>Всего:</span>
        <span className={`font-semibold ${textClass}`}>
          {formatBytes(trafficStats.reduce((sum, s) => sum + s.bytesIn + s.bytesOut, 0))}
        </span>
      </div>
    </motion.div>
  );
}

