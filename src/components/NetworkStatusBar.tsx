import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Wifi, WifiOff, Smartphone, Zap } from 'lucide-react';
import { useTheme } from '../ThemeContext';
import { nativeGetCurrentNetwork, nativeGetNetworkInfo, nativeIsNetworkAvailable } from '../native/bridge';

export default function NetworkStatusBar() {
  const { isDark } = useTheme();
  const [networkType, setNetworkType] = useState<string>('NONE');
  const [networkInfo, setNetworkInfo] = useState<string>('');
  const [isAvailable, setIsAvailable] = useState(false);

  useEffect(() => {
    const fetchNetworkStatus = async () => {
      try {
        const type = await nativeGetCurrentNetwork();
        const info = await nativeGetNetworkInfo();
        const available = await nativeIsNetworkAvailable();

        setNetworkType(type);
        setNetworkInfo(info);
        setIsAvailable(available);
      } catch (e) {
        console.error('Failed to fetch network status:', e);
      }
    };

    fetchNetworkStatus();
    const interval = setInterval(fetchNetworkStatus, 10000); // Update every 10 seconds
    return () => clearInterval(interval);
  }, []);

  const getNetworkIcon = () => {
    switch (networkType) {
      case 'WIFI':
        return <Wifi className="w-4 h-4" />;
      case 'MOBILE':
        return <Smartphone className="w-4 h-4" />;
      case 'ETHERNET':
        return <Zap className="w-4 h-4" />;
      default:
        return <WifiOff className="w-4 h-4" />;
    }
  };

  const getNetworkColor = (): string => {
    if (!isAvailable) return '#ff4444';
    switch (networkType) {
      case 'WIFI': return 'var(--accent)';
      case 'MOBILE': return '#ffe600';
      case 'ETHERNET': return '#00ff88';
      default: return '#888888';
    }
  };

  const getNetworkLabel = (): string => {
    if (!isAvailable) return 'Нет сети';
    switch (networkType) {
      case 'WIFI': return 'WiFi';
      case 'MOBILE': return 'Мобильная сеть';
      case 'ETHERNET': return 'Ethernet';
      default: return networkType;
    }
  };

  const color = getNetworkColor();
  const bgClass = isDark ? 'bg-white/5' : 'bg-black/5';
  const textClass = isDark ? 'text-[#e0e0ff]' : 'text-gray-700';

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg ${bgClass} w-fit`}
    >
      <div
        className={isAvailable ? 'sim-pulse-opacity' : undefined}
        style={{ color }}
      >
        {getNetworkIcon()}
      </div>
      <div className="flex flex-col gap-0.5">
        <div className={`text-xs font-semibold ${textClass}`}>
          {getNetworkLabel()}
        </div>
        {networkInfo && (
          <div className={`text-[10px] opacity-70 ${textClass} line-clamp-1`}>
            {networkInfo}
          </div>
        )}
      </div>
    </motion.div>
  );
}

