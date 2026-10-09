import { useState } from 'react';
import { motion } from 'framer-motion';
import { MapPin } from 'lucide-react';
import { useTheme } from '../ThemeContext';
import { ServerNode } from '../types';

interface ServerMapProps {
  servers: ServerNode[];
  selectedServer?: ServerNode | null;
  onSelectServer?: (server: ServerNode) => void;
}

export default function ServerMap({ servers, selectedServer, onSelectServer }: ServerMapProps) {
  const { isDark } = useTheme();
  const [hoveredServer, setHoveredServer] = useState<ServerNode | null>(null);

  const bgClass = isDark
    ? 'bg-gradient-to-br from-[#1a1a3e] to-[#0f0f2e]'
    : 'bg-gradient-to-br from-[#e8f0ff] to-[#f0f2f5]';

  const borderClass = isDark ? 'border-[#2a2a5e]' : 'border-[#d0d8e0]';
  const textClass = isDark ? 'text-[#e0e0ff]' : 'text-gray-700';
  const labelClass = isDark ? 'text-[#9090b0]' : 'text-gray-500';

  // Simple map representation - list view with geographic grouping
  const groupedByCountry = servers.reduce((acc, server) => {
    const country = server.flag || 'Unknown';
    if (!acc[country]) acc[country] = [];
    acc[country].push(server);
    return acc;
  }, {} as Record<string, ServerNode[]>);

  const countries = Object.keys(groupedByCountry).sort();

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-xl border ${borderClass} ${bgClass} p-5 w-full`}
    >
      <div className="flex items-center gap-3 mb-4">
        <MapPin className="w-5 h-5" style={{ color: 'var(--accent)' }} />
        <h3 className={`font-semibold ${textClass}`}>
          Карта серверов ({servers.length})
        </h3>
      </div>

      <div className="space-y-3 max-h-[400px] overflow-y-auto">
        {countries.map((country) => (
          <motion.div
            key={country}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className={`rounded-lg p-3 ${isDark ? 'bg-white/5' : 'bg-black/5'}`}
          >
            <div className={`text-sm font-semibold mb-2 ${textClass}`}>
              {country}
            </div>

            <div className="space-y-1">
              {groupedByCountry[country].map((server) => (
                <motion.button
                  key={server.name}
                  onClick={() => onSelectServer?.(server)}
                  onMouseEnter={() => setHoveredServer(server)}
                  onMouseLeave={() => setHoveredServer(null)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded text-xs transition-all ${
                    selectedServer?.name === server.name
                      ? isDark ? 'bg-blue-600/30 border border-blue-400' : 'bg-blue-100 border border-blue-400'
                      : hoveredServer?.name === server.name
                      ? isDark ? 'bg-white/10' : 'bg-black/10'
                      : isDark ? 'bg-white/5 hover:bg-white/10' : 'bg-black/5 hover:bg-black/10'
                  }`}
                  whileHover={{ x: 4 }}
                >
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{
                      backgroundColor: server.ping
                        ? server.ping < 50 ? '#00ff88' : server.ping < 100 ? '#ffe600' : '#ff4444'
                        : '#999999',
                    }}
                  />

                  <span className={labelClass}>{server.name}</span>

                  {server.ping && (
                    <span className={`ml-auto text-[10px] ${labelClass}`}>
                      {server.ping}ms
                    </span>
                  )}
                </motion.button>
              ))}
            </div>
          </motion.div>
        ))}
      </div>

      {/* Legend */}
      <div className={`mt-4 pt-3 border-t ${borderClass} grid grid-cols-3 gap-2 text-xs`}>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#00ff88]" />
          <span className={labelClass}>Быстро (&lt;50ms)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#ffe600]" />
          <span className={labelClass}>Нормально (&lt;100ms)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#ff4444]" />
          <span className={labelClass}>Медленно (&gt;100ms)</span>
        </div>
      </div>
    </motion.div>
  );
}

