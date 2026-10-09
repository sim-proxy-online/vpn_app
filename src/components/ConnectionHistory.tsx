import { useState } from 'react';
import { motion } from 'framer-motion';
import { Clock, TrendingDown, TrendingUp, CheckCircle, AlertCircle } from 'lucide-react';
import { useTheme } from '../ThemeContext';

interface ConnectionHistory {
  id: string;
  timestamp: Date;
  serverName: string;
  country: string;
  duration: number; // in seconds
  status: 'success' | 'failed' | 'disconnected';
  bytesIn: number;
  bytesOut: number;
}

export default function ConnectionHistory() {
  const { isDark } = useTheme();
  const [history] = useState<ConnectionHistory[]>([
    {
      id: '1',
      timestamp: new Date(Date.now() - 3600000),
      serverName: 'US West 1',
      country: '🇺🇸',
      duration: 1800,
      status: 'success',
      bytesIn: 500000000,
      bytesOut: 50000000,
    },
    {
      id: '2',
      timestamp: new Date(Date.now() - 7200000),
      serverName: 'EU Central',
      country: '🇩🇪',
      duration: 3600,
      status: 'success',
      bytesIn: 1000000000,
      bytesOut: 100000000,
    },
    {
      id: '3',
      timestamp: new Date(Date.now() - 10800000),
      serverName: 'Asia Pacific',
      country: '🇯🇵',
      duration: 0,
      status: 'failed',
      bytesIn: 0,
      bytesOut: 0,
    },
  ]);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDuration = (seconds: number): string => {
    if (seconds === 0) return '-';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const formatTime = (date: Date): string => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes}m назад`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h назад`;
    const days = Math.floor(hours / 24);
    return `${days}d назад`;
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
      className={`rounded-xl border ${borderClass} ${bgClass} p-5 w-full`}
    >
      <div className="flex items-center gap-3 mb-4">
        <Clock className="w-5 h-5" style={{ color: 'var(--accent)' }} />
        <h3 className={`font-semibold ${textClass}`}>История соединений</h3>
      </div>

      <div className="space-y-2 max-h-[300px] overflow-y-auto">
        {history.length === 0 ? (
          <div className={`text-center py-8 ${labelClass}`}>
            Нет истории соединений
          </div>
        ) : (
          history.map((item, index) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.05 }}
              className={`p-3 rounded-lg border transition-all ${
                item.status === 'success'
                  ? isDark ? 'bg-green-900/10 border-green-700/30' : 'bg-green-100/30 border-green-300'
                  : isDark ? 'bg-red-900/10 border-red-700/30' : 'bg-red-100/30 border-red-300'
              }`}
            >
              <div className="flex items-center gap-3">
                {item.status === 'success' ? (
                  <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                )}

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{item.country}</span>
                    <span className={`font-medium text-sm ${textClass}`}>
                      {item.serverName}
                    </span>
                    <span className={`text-xs ${labelClass} ml-auto`}>
                      {formatTime(item.timestamp)}
                    </span>
                  </div>

                  <div className="flex gap-3 mt-1 text-xs">
                    {item.status === 'success' && (
                      <>
                        <div className="flex items-center gap-1">
                          <Clock size={12} className={labelClass} />
                          <span className={labelClass}>{formatDuration(item.duration)}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <TrendingDown size={12} className="text-green-400" />
                          <span className="text-green-400">{formatBytes(item.bytesIn)}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <TrendingUp size={12} className="text-blue-400" />
                          <span className="text-blue-400">{formatBytes(item.bytesOut)}</span>
                        </div>
                      </>
                    )}
                    {item.status === 'failed' && (
                      <span className="text-red-400">Ошибка подключения</span>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          ))
        )}
      </div>

      {/* Summary */}
      {history.length > 0 && (
        <div className={`mt-4 pt-3 border-t ${borderClass}`}>
          <div className={`text-xs ${labelClass}`}>
            Всего соединений: <span className={`font-semibold ${textClass}`}>{history.length}</span>
          </div>
          <div className={`text-xs ${labelClass} mt-1`}>
            Успешных: <span className="text-green-400 font-semibold">
              {history.filter(h => h.status === 'success').length}
            </span>
          </div>
        </div>
      )}
    </motion.div>
  );
}

