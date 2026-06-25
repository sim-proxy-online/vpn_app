import { useState, useEffect, useMemo } from 'react';
import { withAlpha } from '../utils/color';
import { motion, AnimatePresence } from 'framer-motion';
import { Smartphone, Search, Shield, Zap, X, CheckCircle2 } from 'lucide-react';
import { useTheme } from '../ThemeContext';
import { nativeGetSplitTunnelApps, nativeSetSplitTunnelApp, SplitTunnelApp } from '../native/bridge';

// ── Пресет «Российские сервисы → Напрямую» ────────────────────────────────
// Трафик этих приложений идёт мимо VPN-туннеля: они работают с российских
// IP-адресов, не требуют обхода блокировок и часто ломаются через зарубежный VPN.
const RU_BYPASS_PRESET: { id: string; name: string }[] = [
  // Госуслуги (реальный пакет на устройстве)
  { id: 'ru.rtlabs.mobile.ebs.gosuslugi.android', name: 'Госуслуги' },
  { id: 'ru.gosuslugi',                            name: 'Госуслуги (alt)' },
  { id: 'ru.gosuslugi.auto',                       name: 'Госуслуги.Авто' },
  { id: 'ru.gosuslugi.esiaplus.android',           name: 'Госуслуги ЕСИА' },
  // Банки и платежи
  { id: 'ru.sberbankmobile',               name: 'СберБанк' },
  { id: 'ru.sberbank.sberpay',             name: 'СберПэй' },
  { id: 'com.idamob.tinkoff.android',      name: 'Т-Банк (Тинькофф)' },
  { id: 'ru.tinkoff.sme',                  name: 'Тинькофф Бизнес' },
  { id: 'ru.vtb24.mobilebanking.android',  name: 'ВТБ' },
  { id: 'ru.alfabank.mobile.android',      name: 'Альфа-Банк' },
  { id: 'ru.gazprombank.android',          name: 'Газпромбанк' },
  { id: 'ru.raiffeisen.mobile',            name: 'Райффайзен' },
  { id: 'ru.pochtabank.android',           name: 'Почта Банк' },
  { id: 'ru.psbank.android',               name: 'Промсвязьбанк' },
  { id: 'ru.sovcombank.mobile',            name: 'Совкомбанк' },
  { id: 'ru.openbank.mobile',              name: 'Банк Открытие' },
  { id: 'ru.rosbank.android',              name: 'Росбанк' },
  { id: 'ru.akbarsbank.mobile',            name: 'Ак Барс Банк' },
  { id: 'ru.nspk.mirpay',                  name: 'MirPay' },
  { id: 'ru.nspk.sbpay',                   name: 'СБП' },
  { id: 'com.yandex.bank',                 name: 'Яндекс Банк' },
  // Соцсети и VK
  { id: 'com.vkontakte.android',           name: 'ВКонтакте' },
  { id: 'ru.ok.android',                   name: 'Одноклассники' },
  { id: 'com.vk.vkvideo',                  name: 'VK Видео' },
  { id: 'com.vk.clips',                    name: 'VK Видео (alt)' },
  { id: 'com.vk.im',                       name: 'VK Мессенджер' },
  { id: 'com.vk.calls',                    name: 'VK Звонки' },
  { id: 'com.vk.mail',                     name: 'VK Почта' },
  { id: 'com.vk.max',                      name: 'VK Max' },
  // Яндекс-сервисы (без браузера)
  { id: 'ru.yandex.searchplugin',          name: 'Яндекс' },
  { id: 'ru.yandex.yandexmaps',            name: 'Яндекс.Карты' },
  { id: 'ru.yandex.yandexnavi',            name: 'Яндекс.Навигатор' },
  { id: 'ru.yandex.taxi',                  name: 'Яндекс.Такси' },
  { id: 'ru.yandex.uber',                  name: 'Яндекс Go' },
  { id: 'ru.yandex.eda',                   name: 'Яндекс.Еда' },
  { id: 'ru.yandex.disk',                  name: 'Яндекс.Диск' },
  { id: 'ru.yandex.mail',                  name: 'Яндекс.Почта' },
  { id: 'ru.yandex.music',                 name: 'Яндекс.Музыка' },
  { id: 'ru.yandex.travel',                name: 'Яндекс.Путешествия' },
  { id: 'ru.yandex.kinopoisk',             name: 'Кинопоиск (Яндекс)' },
  { id: 'com.yandex.aliceapp',             name: 'Алиса' },
  { id: 'ru.beru.android',                 name: 'Яндекс.Маркет' },
  // Кино и стриминг
  { id: 'ru.kinopoisk.android',            name: 'Кинопоиск' },
  { id: 'ru.ivi.client',                   name: 'IVI' },
  { id: 'ru.okko.tv',                      name: 'Okko' },
  { id: 'ru.rutube.app',                   name: 'Rutube' },
  { id: 'ru.more.tv',                      name: 'More.TV / Max' },
  { id: 'ru.start.android',                name: 'START' },
  { id: 'tv.premier.frontend',             name: 'Premier' },
  // Операторы
  { id: 'ru.mts.mymts',                    name: 'Мой МТС' },
  { id: 'com.mts.mts',                     name: 'МТС (alt)' },
  { id: 'com.beeline.ru',                  name: 'Мой Билайн' },
  { id: 'ru.megafon.mlk',                  name: 'МегаФон' },
  { id: 'ru.megafon.online',               name: 'МегаФон (alt)' },
  { id: 'ru.tele2.mytele2',                name: 'Мой Tele2' },
  // Маркетплейсы
  { id: 'com.wildberries.ru',              name: 'Wildberries' },
  { id: 'ru.ozon.app.android',             name: 'Ozon' },
  { id: 'com.avito.android',               name: 'Авито' },
  { id: 'ru.avito.android',                name: 'Авито (alt)' },
  { id: 'ru.lamoda.android',               name: 'Lamoda' },
  // Связь и утилиты
  { id: 'ru.oneme.app',                    name: 'OneMe' },
  { id: 'ru.rostel',                       name: 'Росттелеком' },
  // Карты, сервисы, доставка
  { id: 'ru.dublgis.dgismobile',           name: '2ГИС' },
  { id: 'ru.rzd.pass',                     name: 'РЖД Пассажирам' },
  { id: 'ru.rzd.passenger',                name: 'РЖД (alt)' },
  { id: 'ru.cdek.delivery',                name: 'СДЭК' },
  { id: 'com.octopod.russianpost.client.android', name: 'Почта России' },
  { id: 'ru.russianpost.android',          name: 'Почта России (alt)' },
  { id: 'ru.hh.android',                   name: 'hh.ru' },
  { id: 'ru.cian.app',                     name: 'ЦИАН' },
  { id: 'ru.domclick.mobile',              name: 'Домклик' },
];

const PRESET_ID_SET = new Set(RU_BYPASS_PRESET.map(p => p.id));

export default function SplitTunnelSettings() {
  const { isDark } = useTheme();
  const [apps, setApps] = useState<SplitTunnelApp[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'user' | 'system'>('user');
  const [presetApplying, setPresetApplying] = useState(false);

  useEffect(() => {
    loadApps();
  }, []);

  const loadApps = async () => {
    setLoading(true);
    try {
      const installedApps = await nativeGetSplitTunnelApps();
      // Пресет уже применён нативно (SplitTunnelManager.java) при первом старте приложения.
      setApps(Array.isArray(installedApps) ? installedApps : []);
    } catch (e) {
      console.error('Failed to load apps:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleModeChange = async (appId: string, newMode: 'always' | 'never' | 'smart') => {
    try {
      const success = await nativeSetSplitTunnelApp(appId, newMode);
      if (success) {
        setApps(prev => prev.map(app =>
          app.id === appId ? { ...app, mode: newMode } : app
        ));
      }
    } catch (e) {
      console.error('Failed to change app mode:', e);
    }
  };

  const bulkSet = async (newMode: 'always' | 'never' | 'smart') => {
    const targets = filteredApps;
    setApps(prev => prev.map(a => targets.some(t => t.id === a.id) ? { ...a, mode: newMode } : a));
    await Promise.all(targets.map(a => nativeSetSplitTunnelApp(a.id, newMode).catch(() => {})));
  };

  // ── Пресет: российские приложения ──
  const presetInstalled = useMemo(
    () => apps.filter(a => PRESET_ID_SET.has(a.id)),
    [apps]
  );
  const presetBypassCount = useMemo(
    () => presetInstalled.filter(a => a.mode === 'never').length,
    [presetInstalled]
  );
  const presetFullyApplied = presetInstalled.length > 0 && presetBypassCount === presetInstalled.length;

  const applyRuPreset = async () => {
    if (presetApplying || presetInstalled.length === 0) return;
    setPresetApplying(true);
    const targets = presetInstalled.filter(a => a.mode !== 'never');
    setApps(prev => prev.map(a => PRESET_ID_SET.has(a.id) ? { ...a, mode: 'never' } : a));
    await Promise.all(targets.map(a => nativeSetSplitTunnelApp(a.id, 'never').catch(() => {})));
    setPresetApplying(false);
  };

  const resetRuPreset = async () => {
    if (presetApplying) return;
    setPresetApplying(true);
    const targets = presetInstalled.filter(a => a.mode === 'never');
    setApps(prev => prev.map(a => PRESET_ID_SET.has(a.id) && a.mode === 'never' ? { ...a, mode: 'smart' } : a));
    await Promise.all(targets.map(a => nativeSetSplitTunnelApp(a.id, 'smart').catch(() => {})));
    setPresetApplying(false);
  };

  const filteredApps = apps.filter(app => {
    if (filter === 'user' && app.system) return false;
    if (filter === 'system' && !app.system) return false;
    const q = searchQuery.toLowerCase();
    return app.name.toLowerCase().includes(q) || app.id.toLowerCase().includes(q);
  });

  const borderClass = isDark ? 'border-[#2a2a5a44]' : 'border-[#d0d8e0]';
  const textClass = isDark ? 'text-white' : 'text-[#0f172a]';
  const labelClass = isDark ? 'text-gray-500' : 'text-gray-400';

  const modes = [
    { id: 'always', icon: <Shield size={10} />, label: 'VPN',    color: '#00ff88' },
    { id: 'smart',  icon: <Zap size={10} />,    label: 'AUTO',   color: 'var(--accent)' },
    { id: 'never',  icon: <X size={10} />,      label: 'BYPASS', color: '#ff0066' },
  ] as const;

  return (
    <div className="flex flex-col w-full h-full max-h-[500px]">

      {/* ── Пресет «Российские сервисы» ── */}
      <div className="px-3 pt-3 pb-2 shrink-0">
        <div className={`rounded-2xl border p-3 transition-all ${
          presetFullyApplied
            ? 'border-[#cc000033] bg-[#cc00000a]'
            : 'border-[#ffffff0a] bg-[#ffffff04]'
        }`}>
          <div className="flex items-center gap-2.5 mb-2.5">
            {/* RU badge */}
            <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
              presetFullyApplied ? 'bg-[#cc0000]' : 'bg-[#cc000030]'
            }`}>
              <span className="text-[9px] font-black text-white tracking-tight">RU</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-[12px] font-bold text-white leading-tight">
                  Российские сервисы
                </p>
                {presetFullyApplied && (
                  <CheckCircle2 size={12} className="text-[#cc0000] shrink-0" />
                )}
              </div>
              <p className="text-[9px] text-gray-500 mt-0.5">
                {loading
                  ? 'Загрузка...'
                  : presetInstalled.length === 0
                    ? `Ни одного из ${RU_BYPASS_PRESET.length} не установлено`
                    : `${presetInstalled.length} из ${RU_BYPASS_PRESET.length} установлено${presetBypassCount > 0 ? ` · ${presetBypassCount} на прямом обходе` : ''}`
                }
              </p>
            </div>
          </div>

          {/* Категории */}
          <div className="flex flex-wrap gap-1 mb-2.5">
            {['Банки', 'Госуслуги', 'ВК / ОК', 'Яндекс', 'Маркетплейсы', 'ТВ', 'Операторы'].map(tag => (
              <span key={tag}
                className="px-1.5 py-0.5 rounded bg-white/5 text-[7px] font-bold uppercase tracking-tight text-gray-500 border border-white/5">
                {tag}
              </span>
            ))}
          </div>

          <div className="flex gap-2">
            <button
              onClick={applyRuPreset}
              disabled={loading || presetApplying || presetInstalled.length === 0 || presetFullyApplied}
              className="flex-1 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all disabled:opacity-40
                bg-[#cc000020] border border-[#cc000044] text-red-400 hover:bg-[#cc000030] active:scale-[0.97]"
            >
              {presetApplying ? 'Применяется...' : presetFullyApplied ? 'Применён' : 'Применить обход'}
            </button>
            <button
              onClick={resetRuPreset}
              disabled={loading || presetApplying || presetBypassCount === 0}
              className="px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all disabled:opacity-40
                bg-white/5 border border-white/10 text-gray-400 hover:bg-white/10 active:scale-[0.97]"
            >
              Сбросить
            </button>
          </div>
        </div>
      </div>

      {/* Search + filter + bulk actions */}
      <div className="px-3 pb-3 sticky top-0 bg-[#0d0d22] z-10 space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600" />
          <input
            type="text"
            placeholder="Поиск по названию или ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={`w-full pl-9 pr-4 py-2.5 rounded-xl border ${borderClass} bg-[#1a1a3a55] text-xs ${textClass} placeholder-gray-700 focus:outline-none focus:border-[var(--accent-a33)] transition-all`}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex bg-[#00000033] p-0.5 rounded-lg border border-white/5">
            {([['user','Польз.'],['system','Систем.'],['all','Все']] as const).map(([id, label]) => (
              <button key={id} onClick={() => setFilter(id)}
                className={`px-2.5 py-1 rounded-md text-[9px] font-black uppercase tracking-tight transition-all ${
                  filter === id ? 'bg-[var(--accent-a15)] text-[var(--accent)]' : 'text-gray-500'
                }`}>{label}</button>
            ))}
          </div>
          <div className="flex gap-1">
            <button onClick={() => bulkSet('always')} title="Все через VPN"
              className="px-2 py-1 rounded-md text-[8px] font-black uppercase bg-[#00ff8815] text-[#00ff88] border border-[#00ff8833]">Все VPN</button>
            <button onClick={() => bulkSet('never')} title="Все мимо VPN"
              className="px-2 py-1 rounded-md text-[8px] font-black uppercase bg-[#ff006615] text-[#ff0066] border border-[#ff006633]">Все мимо</button>
            <button onClick={() => bulkSet('smart')} title="Сброс (авто)"
              className="px-2 py-1 rounded-md text-[8px] font-black uppercase bg-white/5 text-gray-400 border border-white/10">Сброс</button>
          </div>
        </div>
      </div>

      {/* Apps List */}
      <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-1.5 scrollbar-thin">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <div className="w-8 h-8 border-2 border-[var(--accent-a22)] border-t-[var(--accent)] rounded-full animate-spin" />
            <span className="text-[10px] font-bold text-gray-600 uppercase tracking-widest">Загрузка приложений...</span>
          </div>
        ) : filteredApps.length === 0 ? (
          <div className="text-center py-12">
            <Smartphone className="w-10 h-10 text-gray-800 mx-auto mb-3 opacity-20" />
            <p className="text-[10px] font-bold text-gray-600 uppercase tracking-widest">
              {apps.length === 0 ? 'Приложения не найдены' : 'Ничего не найдено'}
            </p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {filteredApps.map((app) => {
              const isPreset = PRESET_ID_SET.has(app.id);
              return (
                <motion.div
                  key={app.id}
                  layout
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex items-center gap-3 p-2.5 rounded-2xl border transition-all ${
                    isPreset && app.mode === 'never'
                      ? 'border-[#cc000022] bg-[#cc000008]'
                      : `${borderClass} ${isDark ? 'bg-white/[0.02]' : 'bg-black/[0.01]'} hover:bg-white/[0.05]`
                  }`}
                >
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 overflow-hidden bg-[#1a1a3a] border border-white/5 shadow-inner relative">
                    {app.icon ? (
                      <img src={app.icon} alt="" loading="lazy" decoding="async" className="w-full h-full object-contain" />
                    ) : (
                      <span className="text-[10px] font-black text-[var(--accent)] opacity-40">{(app.name?.[0] || '?').toUpperCase()}</span>
                    )}
                    {/* RU preset badge */}
                    {isPreset && (
                      <div className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-[#cc0000] flex items-center justify-center">
                        <span className="text-[5px] font-black text-white leading-none">RU</span>
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0 pr-1">
                    <div className={`text-[13px] font-bold truncate ${textClass} leading-tight`}>{app.name}</div>
                    <div className={`text-[9px] font-mono truncate ${labelClass} mt-0.5 opacity-60`}>{app.id}</div>
                  </div>

                  {/* Mode Selector */}
                  <div className="flex bg-[#00000033] p-1 rounded-xl border border-white/5 shrink-0">
                    {modes.map((m) => {
                      const active = app.mode === m.id;
                      return (
                        <button
                          key={m.id}
                          onClick={() => handleModeChange(app.id, m.id)}
                          className={`flex flex-col items-center justify-center w-9 h-8 rounded-lg transition-all duration-300 ${
                            active
                              ? 'shadow-lg'
                              : 'opacity-30 hover:opacity-100 grayscale hover:grayscale-0'
                          }`}
                          style={active ? {
                            background: `${withAlpha(m.color, '15')}`,
                            border: `1px solid ${withAlpha(m.color, '33')}`,
                            color: m.color
                          } : {}}
                        >
                          {m.icon}
                          <span className="text-[7px] font-black mt-0.5">{m.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* Stats/Legend */}
      <div className={`p-3 border-t ${borderClass} bg-[#1a1a3a22] flex items-center justify-between`}>
        <div className="flex gap-3">
          {modes.map(m => (
            <div key={m.id} className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: m.color }} />
              <span className="text-[8px] font-bold text-gray-500 uppercase">{m.label}</span>
            </div>
          ))}
        </div>
        <span className="text-[9px] font-mono text-gray-600">{filteredApps.length} APPS</span>
      </div>
    </div>
  );
}
