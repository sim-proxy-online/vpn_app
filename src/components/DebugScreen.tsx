import { useState, useEffect } from 'react';
import { ChevronLeft, Copy, Trash2, RefreshCw } from 'lucide-react';
import { nativeGetLogs, nativeGetLastError } from '../native/bridge';

interface DebugScreenProps {
  onBack: () => void;
}

export default function DebugScreen({ onBack }: DebugScreenProps) {
  const [logs, setLogs] = useState('');
  const [lastError, setLastError] = useState('');
  const [loading, setLoading] = useState(false);

  const refreshLogs = async () => {
    setLoading(true);
    try {
      const [logsData, errorData] = await Promise.all([
        nativeGetLogs(),
        nativeGetLastError()
      ]);
      setLogs(logsData);
      setLastError(errorData);
    } catch (e) {
      console.error('Failed to fetch logs:', e);
    }
    setLoading(false);
  };

  useEffect(() => {
    refreshLogs();
    const interval = setInterval(refreshLogs, 5000); // Auto-refresh every 5s
    return () => clearInterval(interval);
  }, []);

  const copyToClipboard = async () => {
    const text = `LAST ERROR:\n${lastError}\n\nLOGS:\n${logs}`;
    try {
      await navigator.clipboard.writeText(text);
      alert('Скопировано в буфер обмена');
    } catch {
      alert('Не удалось скопировать');
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gradient-to-br from-[#0a0a1a] to-[#1a0a2e] text-white">
      {/* Header */}
      <div className="border-b border-[#00ff88]/20 p-4 flex items-center gap-3">
        <button
          onClick={onBack}
          className="p-2 hover:bg-[#00ff88]/10 rounded-lg transition"
        >
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-xl font-bold flex-1">🔧 Диагностика</h1>
        <button
          onClick={refreshLogs}
          disabled={loading}
          className="p-2 hover:bg-[#00ff88]/10 rounded-lg transition disabled:opacity-50"
        >
          <RefreshCw size={20} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {/* Last Error */}
        {lastError && (
          <div className="p-4 border-b border-[#ff4444]/30 bg-[#2a0a0a]">
            <h2 className="text-[#ff6666] font-semibold mb-2">❌ Последняя ошибка</h2>
            <div className="bg-black/50 p-3 rounded text-sm font-mono text-[#ff8888] overflow-x-auto">
              {lastError}
            </div>
          </div>
        )}

        {/* Logs */}
        <div className="p-4">
          <h2 className="text-[#00ff88] font-semibold mb-2">📋 Логи</h2>
          <div className="bg-black/50 p-3 rounded text-xs font-mono text-[#00cc66] overflow-x-auto max-h-96 whitespace-pre-wrap break-words">
            {logs || 'Нет доступных логов'}
          </div>
        </div>
      </div>

      {/* Footer Actions */}
      <div className="border-t border-[#00ff88]/20 p-4 flex gap-2">
        <button
          onClick={copyToClipboard}
          className="flex-1 bg-[#00ff88]/20 hover:bg-[#00ff88]/30 text-[#00ff88] font-semibold py-2 rounded-lg transition flex items-center justify-center gap-2"
        >
          <Copy size={18} />
          Копировать
        </button>
        <button
          onClick={() => {
            setLogs('');
            setLastError('');
          }}
          className="flex-1 bg-[#ff4444]/20 hover:bg-[#ff4444]/30 text-[#ff8888] font-semibold py-2 rounded-lg transition flex items-center justify-center gap-2"
        >
          <Trash2 size={18} />
          Очистить
        </button>
      </div>
    </div>
  );
}
