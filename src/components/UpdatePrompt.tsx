import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, X, Rocket, Loader2, ShieldAlert, RefreshCw } from 'lucide-react';
import { checkForUpdate, RELEASES_PAGE, type UpdateInfo } from '../utils/UpdateChecker';
import {
  nativeOpenUrl,
  canInstallApk,
  nativeDownloadAndInstallApk,
  nativeInstallDownloadedApk,
  nativeDownloadUpdateApk,
  nativeIsUnmeteredNetwork,
  isDesktopPlatform,
  nativeCheckForUpdatesNow,
  nativeQuitAndInstallUpdate,
  type InstallResult,
  type DesktopUpdateState,
} from '../native/bridge';

function load<T>(k: string, fb: T): T { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : fb; } catch { return fb; } }
function save(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

const DAY = 24 * 60 * 60 * 1000;

type Phase = 'idle' | 'downloading' | 'installing' | 'need_permission' | 'error' | 'ready';

/**
 * Обновления на всех платформах:
 *   • Desktop (Windows) — electron-updater качает дельту в фоне и ставит тихо при
 *     выходе (главный процесс). Здесь только ненавязчивая плашка «готово» с опцией
 *     перезапустить сейчас.
 *   • Android — APK докачивается в фоне (на Wi-Fi) заранее; пользователь видит лишь
 *     один тап «Установить» (системный диалог обязателен для сайдлоада).
 *   • Web — деградация до открытия страницы релиза.
 */
export default function UpdatePrompt() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [pct, setPct] = useState(0);
  const [errMsg, setErrMsg] = useState('');
  // Desktop: обновление скачано electron-updater'ом и поставится при выходе.
  const [desktopReady, setDesktopReady] = useState<{ version: string | null } | null>(null);

  // ── Авто-проверка (Android/Web). На desktop обновлением занимается electron-updater. ──
  useEffect(() => {
    if (isDesktopPlatform()) return;
    if (!load('sim-autoupdate-check', true)) return;
    const last = load<number>('sim-last-update-check', 0);
    if (Date.now() - last < DAY) return;

    const t = setTimeout(async () => {
      try {
        const u = await checkForUpdate();
        save('sim-last-update-check', Date.now());
        if (!u.hasUpdate) return;
        // Бесшовный Android: на безлимитной сети тихо докачиваем APK заранее, и
        // показываем модалку уже в состоянии «готово к установке» (один тап).
        if (canInstallApk() && u.downloadUrl && await nativeIsUnmeteredNetwork()) {
          setPct(0);
          const res = await nativeDownloadUpdateApk(u.downloadUrl);
          if (res.ok && res.status === 'downloaded') { setPhase('ready'); setInfo(u); return; }
        }
        setPhase('idle');
        setInfo(u); // обычный путь — докачка по тапу «Обновить»
      } catch { /* тихо игнорируем сетевые ошибки */ }
    }, 6000);
    return () => clearTimeout(t);
  }, []);

  // Прогресс загрузки (Android-нативка и desktop electron-updater шлют один event).
  useEffect(() => {
    const onProgress = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d && typeof d.pct === 'number') setPct(d.pct);
    };
    window.addEventListener('update-progress', onProgress);
    return () => window.removeEventListener('update-progress', onProgress);
  }, []);

  // Desktop: статус electron-updater. Когда скачано — показываем плашку «готово».
  useEffect(() => {
    if (!isDesktopPlatform()) return;
    const onDesktop = (e: Event) => {
      const s = (e as CustomEvent).detail as DesktopUpdateState | undefined;
      if (s && s.status === 'downloaded') setDesktopReady({ version: s.version });
    };
    window.addEventListener('desktop-update', onDesktop);
    return () => window.removeEventListener('desktop-update', onDesktop);
  }, []);

  // Ручной показ (кнопка «Проверить обновление» в настройках).
  useEffect(() => {
    const onShow = (e: Event) => {
      if (isDesktopPlatform()) {
        // electron-updater сам качает в фоне; просто триггерим проверку, плашку
        // покажет событие 'desktop-update' по завершении.
        nativeCheckForUpdatesNow();
        return;
      }
      const detail = (e as CustomEvent).detail as UpdateInfo | undefined;
      if (detail && detail.hasUpdate) { setPhase('idle'); setPct(0); setInfo(detail); return; }
      checkForUpdate()
        .then((u) => { if (u.hasUpdate) { setPhase('idle'); setPct(0); setInfo(u); } })
        .catch(() => {});
    };
    window.addEventListener('sim-show-update', onShow);
    return () => window.removeEventListener('sim-show-update', onShow);
  }, []);

  // ── Desktop-плашка: обновление скачано, поставится при выходе ──
  if (desktopReady && !info) {
    return (
      <div className="fixed bottom-4 right-4 z-[180] max-w-xs">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          className="bg-[#0d0d22] border border-[var(--accent-a33)] rounded-2xl p-4 shadow-2xl flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-[var(--accent-a15)] text-[var(--accent)] shrink-0">
            <Rocket size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm font-bold">Обновление готово{desktopReady.version ? ` (${desktopReady.version})` : ''}</p>
            <p className="text-[11px] text-gray-400 mt-0.5">Установится автоматически при выходе.</p>
            <div className="flex gap-3 mt-2">
              <button onClick={() => nativeQuitAndInstallUpdate()}
                className="flex items-center gap-1.5 text-[11px] font-bold text-[var(--accent)] active:scale-95">
                <RefreshCw size={12} /> Перезапустить сейчас
              </button>
              <button onClick={() => setDesktopReady(null)} className="text-[11px] text-gray-500">Позже</button>
            </div>
          </div>
          <button onClick={() => setDesktopReady(null)} className="text-gray-500 hover:text-white shrink-0"><X size={16} /></button>
        </motion.div>
      </div>
    );
  }

  if (!info) return null;
  const dl = info.downloadUrl || info.pageUrl || RELEASES_PAGE;
  const inApp = canInstallApk() && !!info.downloadUrl;
  const busy = phase === 'downloading' || phase === 'installing';
  const isReady = phase === 'ready';

  function applyResult(res: InstallResult) {
    if (res.status === 'installing') {
      setPhase('installing');
    } else if (res.status === 'need_permission') {
      setPhase('need_permission');
    } else if (res.ok) {
      setInfo(null);
    } else {
      setErrMsg(res.error || 'Не удалось обновить');
      setPhase('error');
    }
  }

  async function handleUpdate() {
    // Уже скачано в фоне (Android seamless) — ставим без повторной загрузки.
    if (isReady) {
      setPhase('installing');
      try { applyResult(await nativeInstallDownloadedApk()); }
      catch (e) { setErrMsg(String(e)); setPhase('error'); }
      return;
    }
    if (!inApp) { nativeOpenUrl(dl); setInfo(null); return; }
    setErrMsg('');
    setPct(0);
    setPhase('downloading');
    try {
      applyResult(await nativeDownloadAndInstallApk(info!.downloadUrl!));
    } catch (e) {
      setErrMsg(String(e)); setPhase('error');
    }
  }

  async function handleRetryInstall() {
    setPhase('installing');
    try {
      applyResult(await nativeInstallDownloadedApk());
    } catch (e) {
      setErrMsg(String(e)); setPhase('error');
    }
  }

  const primaryLabel = isReady ? 'Установить' : (inApp ? 'Обновить' : 'Скачать');

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[180] flex items-end sm:items-center justify-center p-4 bg-black/80 backdrop-blur-md" onClick={() => !busy && setInfo(null)}>
        <motion.div onClick={e => e.stopPropagation()}
          initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 30 }}
          className="w-full max-w-sm bg-[#0d0d22] border border-[#2a2a5a] rounded-3xl p-6 shadow-2xl relative">
          {!busy && (
            <button onClick={() => setInfo(null)} className="absolute top-4 right-4 text-gray-500 hover:text-white"><X size={18} /></button>
          )}

          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-[var(--accent-a15)] text-[var(--accent)] border border-[var(--accent-a33)]">
              <Rocket size={22} />
            </div>
            <div>
              <h3 className="font-orbitron text-base font-bold text-white">Доступно обновление</h3>
              <p className="text-[11px] text-gray-500 font-mono">{info.current} → <span className="text-[var(--accent)] font-bold">{info.latest}</span></p>
            </div>
          </div>

          {info.notes && (phase === 'idle' || isReady) && (
            <div className="max-h-32 overflow-y-auto mb-4 text-[11px] text-gray-400 leading-relaxed whitespace-pre-wrap bg-[#12122a] rounded-xl p-3 border border-[#2a2a5a44]">
              {info.notes.slice(0, 500)}
            </div>
          )}

          {isReady && (
            <p className="mb-4 text-[12px] text-[#00ff88] flex items-center gap-2">
              <Download size={14} /> Обновление загружено — установка в один тап.
            </p>
          )}

          {phase === 'downloading' && (
            <div className="mb-4">
              <div className="flex items-center justify-between text-[11px] text-gray-400 mb-2 font-mono">
                <span>Загрузка обновления…</span><span>{pct}%</span>
              </div>
              <div className="h-2 rounded-full bg-[#1a1a3a] overflow-hidden">
                <div className="h-full bg-[var(--accent)] transition-all duration-200" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}

          {phase === 'installing' && (
            <p className="mb-4 text-[12px] text-gray-300 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-[var(--accent)]" /> Открываю установщик системы…
            </p>
          )}

          {phase === 'need_permission' && (
            <div className="mb-4 text-[11px] text-amber-300/90 leading-relaxed bg-amber-500/10 rounded-xl p-3 border border-amber-500/20 flex gap-2">
              <ShieldAlert size={28} className="shrink-0 text-amber-400" />
              <span>Разрешите «Установка неизвестных приложений» для Sim Proxy в открывшихся настройках, затем вернитесь и нажмите «Установить».</span>
            </div>
          )}

          {phase === 'error' && (
            <p className="mb-4 text-[11px] text-red-400 bg-red-500/10 rounded-xl p-3 border border-red-500/20">{errMsg}</p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <button
              disabled={busy}
              onClick={() => { nativeOpenUrl(inApp ? (info.pageUrl || dl) : dl); setInfo(null); }}
              className="py-3 rounded-xl bg-[#1a1a3a] text-gray-400 text-[10px] font-bold uppercase tracking-widest active:scale-95 disabled:opacity-40">
              {inApp ? 'В браузере' : 'Позже'}
            </button>

            {phase === 'need_permission' ? (
              <button onClick={handleRetryInstall}
                className="flex items-center justify-center gap-2 py-3 rounded-xl bg-[var(--accent)] text-black text-[10px] font-bold uppercase tracking-widest active:scale-95">
                <Download size={14} /> Установить
              </button>
            ) : (
              <button disabled={busy} onClick={handleUpdate}
                className="flex items-center justify-center gap-2 py-3 rounded-xl bg-[var(--accent)] text-black text-[10px] font-bold uppercase tracking-widest active:scale-95 disabled:opacity-60">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {primaryLabel}
              </button>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
