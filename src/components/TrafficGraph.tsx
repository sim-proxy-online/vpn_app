import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useTheme } from '../ThemeContext';

interface TrafficGraphProps {
  uploadSpeed: number;
  downloadSpeed: number;
  isRunning: boolean;
}

export default function TrafficGraph({ uploadSpeed, downloadSpeed, isRunning }: TrafficGraphProps) {
  const { isDark } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [history, setHistory] = useState<{ up: number; down: number }[]>(Array(60).fill({ up: 0, down: 0 }));
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!isRunning) return;
    // Debounce updates to avoid excessive state changes
    if (updateTimeoutRef.current) clearTimeout(updateTimeoutRef.current);
    updateTimeoutRef.current = setTimeout(() => {
      setHistory(prev => [...prev.slice(1), { up: uploadSpeed, down: downloadSpeed }]);
    }, 100);
    return () => {
      if (updateTimeoutRef.current) clearTimeout(updateTimeoutRef.current);
    };
  }, [uploadSpeed, downloadSpeed, isRunning]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const width = canvas.width;
      const height = canvas.height;
      const padding = 10;
      const graphWidth = width - padding * 2;
      const graphHeight = height - padding * 2;

      ctx.clearRect(0, 0, width, height);

      // Grid lines
      ctx.strokeStyle = isDark ? '#2a2a5a33' : '#d0d8e033';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = padding + (graphHeight / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
      }

      const maxSpeed = Math.max(...history.map(h => Math.max(h.up, h.down, 1024 * 1024))); // Min 1MB/s scale

      const drawLine = (data: number[], color: string, glow: string) => {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.shadowBlur = 8;
        ctx.shadowColor = glow;

        const step = graphWidth / (data.length - 1 || 1);
        data.forEach((val, i) => {
          const x = padding + i * step;
          const y = padding + graphHeight - (val / maxSpeed) * graphHeight;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Fill area
        ctx.lineTo(padding + graphWidth, padding + graphHeight);
        ctx.lineTo(padding, padding + graphHeight);
        ctx.fillStyle = color + '15';
        ctx.shadowBlur = 0;
        ctx.fill();
      };

      // Canvas не резолвит CSS-переменные — берём текущий акцент вручную.
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00f0ff';
      drawLine(history.map(h => h.down), accent, accent + '88');
      drawLine(history.map(h => h.up), '#b000ff', '#b000ff88');
    } catch (error) {
      console.error('Error drawing traffic graph:', error);
    }
  }, [history, isDark]);

  return (
    <div className="relative w-full h-48 glass-card rounded-2xl p-4 overflow-hidden border border-[#2a2a5a22]">
      <div className="flex justify-between items-center mb-2">
        <div className="flex gap-4">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-[var(--accent)]" />
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Download</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-[#b000ff]" />
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Upload</span>
          </div>
        </div>
        <span className="text-[9px] font-mono text-gray-500">60 SECONDS HISTORY</span>
      </div>
      <canvas ref={canvasRef} width={600} height={140} className="w-full h-32 block" />
    </div>
  );
}
