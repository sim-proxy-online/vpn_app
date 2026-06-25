import type { Config } from 'tailwindcss';

export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        orbitron: ['Orbitron', 'sans-serif'],
      },
      colors: {
        'neon-cyan': '#00f0ff',
        'neon-purple': '#b000ff',
        'neon-pink': '#ff00aa',
        'neon-green': '#00ff88',
        'neon-yellow': '#ffe600',
        'neon-orange': '#ff6600',
        'dark-bg': '#0a0a1a',
        'dark-card': '#12122a',
        'dark-surface': '#1a1a3a',
        'dark-border': '#2a2a5a',
      },
    },
  },
  plugins: [],
} satisfies Config;

