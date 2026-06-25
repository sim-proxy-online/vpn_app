/**
 * ScenarioPresets — готовые наборы настроек под сценарии использования.
 * Применение пишет ключи sim-* в localStorage; они подхватываются при
 * следующем подключении (см. сбор settings в App.handleToggle).
 */

export interface ScenarioPreset {
  id: string;
  name: string;
  emoji: string;
  desc: string;
  /** Карта ключ→значение, записываемая в localStorage (JSON.stringify). */
  settings: Record<string, unknown>;
}

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: 'balanced',
    name: 'Сбалансированный',
    emoji: '⚖️',
    desc: 'Универсальные настройки по умолчанию',
    settings: {
      'sim-frag-enable': true,
      'sim-frag-packets': 'tlshello',
      'sim-frag-length': '50-100',
      'sim-frag-interval': '10-20',
      'sim-noises-enable': false,
      'sim-mux-enabled': false,
      'sim-tfo': false,
      'sim-domain-strategy': 'IPIfNonMatch',
      'sim-fakedns': false,
      'sim-sniffing': true,
    },
  },
  {
    id: 'streaming',
    name: 'Стриминг',
    emoji: '🎬',
    desc: 'Максимальная скорость для видео 4K',
    settings: {
      'sim-frag-enable': false,        // меньше накладных расходов = выше throughput
      'sim-noises-enable': false,
      'sim-mux-enabled': false,
      'sim-tfo': true,
      'sim-domain-strategy': 'IPIfNonMatch',
      'sim-fakedns': true,             // быстрый резолв доменов CDN
      'sim-sniffing': true,
      'sim-dns-address': '1.1.1.1',
    },
  },
  {
    id: 'gaming',
    name: 'Игры',
    emoji: '🎮',
    desc: 'Минимальный пинг, без лишней обработки',
    settings: {
      'sim-frag-enable': false,
      'sim-noises-enable': false,
      'sim-mux-enabled': false,
      'sim-tfo': true,
      'sim-domain-strategy': 'AsIs',
      'sim-fakedns': false,
      'sim-sniffing': false,           // без сниффинга — меньше задержка на пакет
      'sim-idle-timeout': '600',
    },
  },
  {
    id: 'privacy',
    name: 'Макс. приватность',
    emoji: '🛡️',
    desc: 'Сильный обход DPI, защита от утечек',
    settings: {
      'sim-frag-enable': true,
      'sim-frag-packets': 'tlshello',
      'sim-frag-length': '40-80',
      'sim-frag-interval': '5-15',
      'sim-noises-enable': true,
      'sim-noises-type': 'rand',
      'sim-noises-delay': '50',
      'sim-noises-rand': '1-1024',
      'sim-mux-enabled': false,
      'sim-domain-strategy': 'IPIfNonMatch',
      'sim-fakedns': true,
      'sim-sniffing': true,
      'sim-killswitch': true,
      'sim-auto-leaktest': true,
      'sim-dns-address': '1.1.1.1',
    },
  },
];

/** Применить пресет: записать все его ключи в localStorage. */
export function applyScenarioPreset(id: string): boolean {
  const preset = SCENARIO_PRESETS.find(p => p.id === id);
  if (!preset) return false;
  for (const [k, v] of Object.entries(preset.settings)) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  }
  try { localStorage.setItem('sim-active-scenario', JSON.stringify(id)); } catch {}
  return true;
}

export function getActiveScenario(): string | null {
  try { const s = localStorage.getItem('sim-active-scenario'); return s ? JSON.parse(s) : null; } catch { return null; }
}

export function clearActiveScenario(): void {
  try { localStorage.removeItem('sim-active-scenario'); } catch {}
}
