import { useState } from 'react';
import { motion } from 'framer-motion';
import { Zap, BarChart3, Cpu } from 'lucide-react';
import { useTheme } from '../ThemeContext';

interface VpnCoreInfo {
  name: string;
  id: 'xray' | 'singbox' | 'mihomo';
  version: string;
  status: 'active' | 'available' | 'updating';
  memory: number; // MB
  cpu: number; // %
  description: string;
  pros: string[];
  cons: string[];
  icon: string;
}

export default function VpnCoreSelector() {
  const { isDark } = useTheme();
  const [activeCore, setActiveCore] = useState<'xray' | 'singbox'>('xray');
  const [cores] = useState<VpnCoreInfo[]>([
    {
      name: 'Xray',
      id: 'xray',
      version: '1.8.4',
      status: 'active',
      memory: 45,
      cpu: 2.3,
      description: 'Полнофункциональный прокси-сервер с расширенной маршрутизацией',
      pros: ['Множество протоколов', 'Сложная маршрутизация', 'GeoIP поддержка'],
      cons: ['Больше памяти', 'Медленнее на слабых устройствах'],
      icon: '🔷',
    },
    {
      name: 'Sing-box',
      id: 'singbox',
      version: '1.7.2',
      status: 'available',
      memory: 28,
      cpu: 1.8,
      description: 'Современный и легкий прокси-клиент с оптимизированной производительностью',
      pros: ['Легче на батарею', 'Меньше памяти', 'Современный дизайн'],
      cons: ['Меньше протоколов', 'Базовая маршрутизация'],
      icon: '⬜',
    },
  ]);

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
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <Zap className="w-5 h-5" style={{ color: '#ffe600' }} />
        <h3 className={`font-semibold ${textClass}`}>Выбор VPN ядра</h3>
      </div>

      {/* Grid of cores */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        {cores.map((core) => (
          <motion.button
            key={core.id}
            onClick={() => setActiveCore(core.id as 'xray' | 'singbox')}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className={`relative p-4 rounded-lg border transition-all ${
              activeCore === core.id
                ? `${borderClass} bg-gradient-to-br from-[#2a2a5e] to-[#1a1a3e]`
                : `border-transparent ${isDark ? 'bg-white/5 hover:bg-white/10' : 'bg-black/5 hover:bg-black/10'}`
            }`}
          >
            {/* Active indicator */}
            {activeCore === core.id && (
              <motion.div
                layoutId="activeCore"
                className="absolute inset-0 rounded-lg border-2"
                style={{ borderColor: '#00ff88' }}
                transition={{ duration: 0.3 }}
              />
            )}

            {/* Content */}
            <div className="relative z-10">
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{core.icon}</span>
                  <div className="text-left">
                    <div className={`font-bold ${textClass}`}>{core.name}</div>
                    <div className={`text-xs ${labelClass}`}>v{core.version}</div>
                  </div>
                </div>

                {/* Status badge */}
                <div
                  className="px-2 py-1 rounded text-xs font-semibold"
                  style={{
                    backgroundColor:
                      core.status === 'active'
                        ? '#00ff8820'
                        : core.status === 'updating'
                        ? '#ffe60020'
                        : 'var(--accent-a20)',
                    color:
                      core.status === 'active'
                        ? '#00ff88'
                        : core.status === 'updating'
                        ? '#ffe600'
                        : 'var(--accent)',
                  }}
                >
                  {core.status === 'active'
                    ? 'Активное'
                    : core.status === 'updating'
                    ? 'Обновление'
                    : 'Доступно'}
                </div>
              </div>

              {/* Stats */}
              <div className="flex gap-3 mb-3 text-xs">
                <div className="flex items-center gap-1">
                  <Cpu className="w-3 h-3" style={{ color: '#ff6b35' }} />
                  <span className={labelClass}>{core.memory} MB</span>
                </div>
                <div className="flex items-center gap-1">
                  <BarChart3 className="w-3 h-3" style={{ color: 'var(--accent)' }} />
                  <span className={labelClass}>{core.cpu}%</span>
                </div>
              </div>

              {/* Description */}
              <p className={`text-xs ${labelClass} mb-2 text-left line-clamp-2`}>
                {core.description}
              </p>

              {/* Pros and Cons */}
              <div className="space-y-1">
                <div>
                  <div className={`text-xs font-semibold ${labelClass} mb-1`}>✅ Преимущества:</div>
                  <ul className={`text-xs ${labelClass} space-y-0.5`}>
                    {core.pros.map((pro, i) => (
                      <li key={i}>• {pro}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </motion.button>
        ))}
      </div>

      {/* Comparison table */}
      <div className={`border-t ${borderClass} pt-4`}>
        <h4 className={`text-sm font-semibold ${textClass} mb-3`}>Сравнение</h4>

        <div className="space-y-2 text-xs">
          {[
            { name: 'Скорость', xray: '🟡 Хорошо', singbox: '🟢 Отлично' },
            { name: 'Памяти', xray: '🟡 45 MB', singbox: '🟢 28 MB' },
            { name: 'CPU', xray: '🟡 2.3%', singbox: '🟢 1.8%' },
            { name: 'Протоколов', xray: '🟢 12+', singbox: '🟡 8' },
            { name: 'Маршрутизация', xray: '🟢 Расширенная', singbox: '🟡 Базовая' },
          ].map((item, i) => (
            <div key={i} className="grid grid-cols-3 gap-2">
              <div className={labelClass}>{item.name}</div>
              <div className={labelClass}>{item.xray}</div>
              <div className={labelClass}>{item.singbox}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 mt-4">
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          className="flex-1 py-2 rounded-lg bg-gradient-to-r from-[var(--accent)] to-[#00ff88] text-black font-semibold"
        >
          Применить
        </motion.button>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          className={`flex-1 py-2 rounded-lg ${
            isDark
              ? 'bg-white/10 hover:bg-white/20'
              : 'bg-black/10 hover:bg-black/20'
          } transition-colors`}
        >
          Отмена
        </motion.button>
      </div>
    </motion.div>
  );
}

