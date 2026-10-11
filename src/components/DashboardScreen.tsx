import { useState, useEffect } from 'react';
import { Zap, BarChart3, Clock, Globe, ArrowLeft, Download, Upload, Activity } from 'lucide-react';
import TrafficAnalysis from './TrafficAnalysis';
import TrafficGraph from './TrafficGraph';
import ConnectionHistory from './ConnectionHistory';
import ServerMap from './ServerMap';
import { ServerNode } from '../types';
import { VpnStats } from '../native/bridge';
import { nativeGetStats, isNative } from '../native/bridge';
import { onTheme } from '../utils/color';

interface DashboardScreenProps {
  onBack: () => void;
  isConnected: boolean;
  selectedNode: ServerNode | null;
  allNodes: ServerNode[];
  connectedTime: number;
}

export default function DashboardScreen({
  onBack,
  isConnected,
  selectedNode,
  allNodes,
  connectedTime,
}: DashboardScreenProps) {
  const [activeTab, setActiveTab] = useState<'stats' | 'traffic' | 'history' | 'map'>('stats');
  const [stats, setStats] = useState<VpnStats | null>(null);

  useEffect(() => {
    if (!isConnected || !isNative()) {
      if (!isConnected) setStats(null);
      return;
    }
    const interval = setInterval(async () => {
      try {
        const s = await nativeGetStats();
        if (s && !s.error) {
          setStats(s);
        }
      } catch (e) { console.error(e); }
    }, 3000);
    return () => clearInterval(interval);
  }, [isConnected]);

  const formatSpeed = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B/s`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const bg = 'bg-[#0a0a1a]';
  const textClass = 'text-[#e0e0ff]';
  const labelClass = 'text-[#9090b0]';

  const tabs = [
    { id: 'stats', label: 'Статистика', icon: <Activity size={18} /> },
    { id: 'traffic', label: 'Трафик', icon: <BarChart3 size={18} /> },
    { id: 'history', label: 'История', icon: <Clock size={18} /> },
    { id: 'map', label: 'Серверы', icon: <Globe size={18} /> },
  ] as const;

  return (
    <div className={`flex flex-col h-full ${bg}`}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-12 pb-4 shrink-0 border-b" style={{ borderColor: 'rgba(var(--ink-rgb),0.05)' }}>
        <button
          onClick={onBack}
          className="lg:hidden w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-[var(--accent)] active:scale-90 transition-all"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1">
          <h2 className={`font-orbitron text-[18px] font-bold tracking-wide ${textClass}`}>Аналитика</h2>
          <p className={`text-xs mt-0.5 ${labelClass}`}>Реал-тайм статистика VPN</p>
        </div>
        {isConnected && (
          <div className="text-right">
            <div className="text-xs font-mono" style={{ color: onTheme('#00ff88') }}>● АКТИВНО</div>
            <div className={`text-[10px] ${labelClass}`}>{connectedTime}s</div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className={`flex gap-2 px-4 py-3 border-b overflow-x-auto`} style={{ borderColor: 'var(--line)' }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg whitespace-nowrap font-medium transition-all text-sm ${
              activeTab === tab.id
                ? 'bg-[var(--accent-a22)] text-[var(--accent)] border border-[var(--accent-a33)]'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-6 pb-8">
        {activeTab === 'stats' && (
          <div className="space-y-6 max-w-2xl">
            {isConnected && stats ? (
              <>
                <TrafficGraph
                  uploadSpeed={stats.uplinkSpeed}
                  downloadSpeed={stats.downlinkSpeed}
                  isRunning={isConnected}
                />

                <div className="grid grid-cols-2 gap-4">
                  <div className="glass-card p-4 rounded-2xl border border-[#2a2a5a22]">
                    <div className="flex items-center gap-2 mb-2">
                      <Download size={16} className="text-[var(--accent)]" />
                      <span className="text-xs text-gray-400 uppercase">Download</span>
                    </div>
                    <p className="text-xl font-orbitron font-bold text-white">{formatSpeed(stats.downlinkSpeed)}</p>
                    <p className="text-[10px] text-gray-500 mt-1">Total: {formatBytes(stats.download)}</p>
                  </div>

                  <div className="glass-card p-4 rounded-2xl border border-[#2a2a5a22]">
                    <div className="flex items-center gap-2 mb-2">
                      <Upload size={16} className="text-[#b000ff]" />
                      <span className="text-xs text-gray-400 uppercase">Upload</span>
                    </div>
                    <p className="text-xl font-orbitron font-bold text-white">{formatSpeed(stats.uplinkSpeed)}</p>
                    <p className="text-[10px] text-gray-500 mt-1">Total: {formatBytes(stats.upload)}</p>
                  </div>
                </div>

                <div className="glass-card p-4 rounded-2xl border border-[#2a2a5a22] flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-[#1a1a3a] flex items-center justify-center">
                      <Zap size={20} className="text-[#ffe600]" />
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">Текущий сервер</p>
                      <p className="text-sm font-semibold text-white">{selectedNode?.name}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-400">Протокол</p>
                    <p className="text-sm font-mono text-[var(--accent)]">{selectedNode?.protocol.toUpperCase()}</p>
                  </div>
                </div>
              </>
            ) : (
              <div className={`rounded-2xl p-12 text-center glass-card border border-[#2a2a5a22]`}>
                <div className="w-16 h-16 rounded-full bg-[#1a1a3a] flex items-center justify-center mx-auto mb-4 border border-[#2a2a5a33]">
                  <Activity size={32} className="text-gray-600" />
                </div>
                <h3 className="text-white font-semibold mb-1">Ожидание подключения</h3>
                <p className="text-xs text-gray-500">Подключитесь к VPN для просмотра реал-тайм графиков и скорости</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'traffic' && (
          <div className="max-w-2xl">
            {isConnected ? (
              <TrafficAnalysis />
            ) : (
              <div className={`rounded-2xl p-12 text-center glass-card border border-[#2a2a5a22]`}>
                <p className={labelClass}>Подключитесь для анализа протоколов трафика</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'history' && (
          <div className="max-w-2xl">
            <ConnectionHistory />
          </div>
        )}

        {activeTab === 'map' && (
          <div className="max-w-2xl">
            <ServerMap
              servers={allNodes}
              selectedServer={selectedNode}
              onSelectServer={(server) => console.log('Selected:', server)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
