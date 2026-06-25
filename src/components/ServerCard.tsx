import { withAlpha } from '../utils/color';
import { MapPin, Zap } from 'lucide-react';
import { ServerNode, Protocol } from '../types';
import { useTheme } from '../ThemeContext';
import Flag from './Flag';

interface ServerCardProps {
  node: ServerNode;
  isSelected: boolean;
  isConnected: boolean;
  onSelect: (node: ServerNode) => void;
}

const protoColors: Record<Protocol, string> = {
  vless: 'var(--accent)', vmess: '#7b68ee', trojan: '#ff00aa', shadowsocks: '#ffe600',
  hysteria: '#ff6b35', hysteria2: '#00ff88', tuic: '#ff4dc4', wireguard: '#88171a',
  shadowtls: '#a78bfa', anytls: '#34d399', naive: '#f97316', socks: '#94a3b8', http: '#64748b',
  ssh: '#a3e635', brook: '#22d3ee', mtproto: '#818cf8', xhttp: '#fb7185', json: '#94a3b8'
};

const securityIcons: Record<string, string> = {
  'none': '🔓', 'tls': '🔒', 'reality': '🎭', 'xtls': '🔐',
};

export default function ServerCard({ node, isSelected, isConnected, onSelect }: ServerCardProps) {
  const { isDark } = useTheme();
  const protoColor = protoColors[node.protocol] || 'var(--accent)';
  const isCurrentConnection = isConnected && isSelected;

  const getQualityIndicator = (ping?: number): { text: string; color: string } => {
    if (!ping) return { text: '?', color: '#999' };
    if (ping < 30) return { text: '⚡', color: '#00ff88' };
    if (ping < 80) return { text: '✓', color: '#ffe600' };
    if (ping < 150) return { text: '⚠', color: '#ff6b35' };
    return { text: '✗', color: '#ff0000' };
  };

  const quality = getQualityIndicator(node.ping);

  return (
    <button
      onClick={() => onSelect(node)}
      className={`relative w-full rounded-2xl border overflow-hidden transition-all group active:scale-[0.98] ${
        isCurrentConnection
          ? isDark
            ? 'border-green-500/50 bg-gradient-to-r from-green-900/20 to-green-800/10'
            : 'border-green-400/50 bg-gradient-to-r from-green-100 to-green-50'
          : isSelected
          ? isDark
            ? 'border-cyan-500/30 bg-gradient-to-r from-cyan-900/20 to-cyan-800/10'
            : 'border-cyan-400/30 bg-gradient-to-r from-cyan-100 to-cyan-50'
          : isDark
          ? 'border-gray-700/30 hover:border-gray-600/50 hover:bg-gray-900/20'
          : 'border-gray-300/30 hover:border-gray-400/50 hover:bg-gray-200/20'
      }`}
    >
      {/* Background Glow */}
      {isCurrentConnection && (
        <div
          className="absolute inset-0 sim-pulse-opacity"
          style={{ background: `radial-gradient(circle, ${protoColor}, transparent)`, opacity: 0.3 }}
        />
      )}

      {/* Content */}
      <div className="relative p-4 flex gap-4">
        {/* Left side - Flag and basic info */}
        <div className="flex flex-col items-center gap-2 min-w-[60px]">
          <Flag flag={node.flag} name={node.name} size={30} className="filter drop-shadow-sm" />
          <div className="text-center">
            <div className={`text-[9px] font-bold px-2 py-1 rounded-full ${
              isDark ? 'bg-gray-700/50 text-gray-300' : 'bg-gray-300/50 text-gray-700'
            }`}>
              {node.protocol.toUpperCase()}
            </div>
          </div>
        </div>

        {/* Middle - Server details */}
        <div className="flex-1 text-left min-w-0">
          <p className={`font-semibold truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {node.name}
          </p>
          <div className={`flex items-center gap-1 mt-1 text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            <MapPin size={12} className="flex-shrink-0" />
            <span className="font-mono truncate">{node.address}</span>
            {node.port !== 443 && <span>:{node.port}</span>}
          </div>

          {/* Security & Transport info */}
          <div className="flex items-center gap-2 mt-2 text-[10px] flex-wrap">
            {node.security && node.security !== 'none' && (
              <span className={`px-2 py-1 rounded ${isDark ? 'bg-blue-900/30 text-blue-300' : 'bg-blue-200/50 text-blue-700'}`}>
                {securityIcons[node.security] || '🔐'} {node.security.toUpperCase()}
              </span>
            )}
            {node.transport && node.transport !== 'tcp' && (
              <span className={`px-2 py-1 rounded ${isDark ? 'bg-purple-900/30 text-purple-300' : 'bg-purple-200/50 text-purple-700'}`}>
                {node.transport.toUpperCase()}
              </span>
            )}
          </div>

          {/* Server description if available */}
          {node.serverDescription && (
            <p className={`text-[9px] mt-2 line-clamp-2 ${isDark ? 'text-gray-500' : 'text-gray-600'}`}>
              📝 {node.serverDescription}
            </p>
          )}
        </div>

        {/* Right side - Ping and status */}
        <div className="flex flex-col items-end justify-between min-w-fit">
          {/* Ping */}
          <div className="flex flex-col items-center gap-1">
            <span style={{ color: quality.color }} className="text-lg font-bold">
              {quality.text}
            </span>
            {node.ping ? (
              <span className={`text-[11px] font-mono font-bold ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {node.ping}ms
              </span>
            ) : (
              <span className={`text-[9px] ${isDark ? 'text-gray-600' : 'text-gray-500'}`}>—</span>
            )}
          </div>

          {/* Connection indicator */}
          {isCurrentConnection && (
            <div
              className="flex items-center gap-1 px-2 py-1 rounded-full sim-pulse-scale"
              style={{
                background: `${withAlpha(protoColor, '20')}`,
                border: `1px solid ${protoColor}`,
                color: protoColor,
              }}
            >
              <Zap size={12} />
              <span className="text-[10px] font-bold">ONLINE</span>
            </div>
          )}

          {/* Selection indicator */}
          {isSelected && !isCurrentConnection && (
            <div
              className="w-2.5 h-2.5 rounded-full"
              style={{
                background: protoColor,
                boxShadow: `0 0 8px ${withAlpha(protoColor, '66')}`,
              }}
            />
          )}
        </div>
      </div>
    </button>
  );
}
