import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Shield, Download, Upload, Lock, X, KeyRound, Check } from 'lucide-react';
import { withAlpha } from '../utils/color';
import {
  exportBackup, pickTextFile, applyBackup, decryptBackup,
  isEncryptedBackup, type BackupPayload,
} from '../utils/BackupManager';

/** Строка-кнопка в стиле SettingsScreen (локальная копия, чтобы быть самодостаточной). */
function ActionRow({ icon, iconColor, label, desc, onClick }: {
  icon: React.ReactNode; iconColor: string; label: string; desc: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-[#ffffff03] transition-colors text-left">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: withAlpha(iconColor, '10'), color: iconColor }}>{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-white text-[13px] font-medium leading-tight">{label}</p>
        <p className="text-gray-500 text-[10px] mt-0.5 leading-tight">{desc}</p>
      </div>
    </button>
  );
}

type Dialog =
  | { kind: 'export' }
  | { kind: 'restore-password'; payload: any; clearExisting: boolean }
  | null;

export default function BackupRestorePanel() {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => { setDialog(null); setPassword(''); setError(null); setBusy(false); };

  const doExport = async () => {
    setBusy(true); setError(null);
    try {
      await exportBackup(password.trim() || undefined);
      close();
    } catch (e: any) {
      setError(e?.message || 'Ошибка экспорта');
      setBusy(false);
    }
  };

  const finishRestore = (payload: BackupPayload) => {
    const n = applyBackup(payload, { clearExisting: true });
    alert(`Восстановлено ключей: ${n}. Приложение перезапустится.`);
    window.location.reload();
  };

  const startRestore = async () => {
    setError(null);
    const file = await pickTextFile('.json,.simbackup,.txt');
    if (!file) return;
    let obj: any;
    try { obj = JSON.parse(file.text); }
    catch { alert('Файл повреждён или не является бэкапом'); return; }

    if (isEncryptedBackup(obj)) {
      setDialog({ kind: 'restore-password', payload: obj, clearExisting: true });
      return;
    }
    // Незашифрованный: либо новый формат {magic,data}, либо старый {sim-...}
    try {
      if (obj && obj.magic && obj.data) {
        finishRestore(obj as BackupPayload);
      } else if (obj && typeof obj === 'object') {
        // Старый плоский формат — оборачиваем
        finishRestore({ magic: 'SIMBACKUP', app: 'sim-proxy', createdAt: '', version: 1, data: obj });
      } else {
        alert('Неизвестный формат файла');
      }
    } catch (e: any) {
      alert(e?.message || 'Ошибка восстановления');
    }
  };

  const doDecryptRestore = async () => {
    if (dialog?.kind !== 'restore-password') return;
    setBusy(true); setError(null);
    try {
      const payload = await decryptBackup(dialog.payload, password.trim());
      finishRestore(payload);
    } catch (e: any) {
      setError(e?.message || 'Неверный пароль');
      setBusy(false);
    }
  };

  return (
    <>
      <ActionRow icon={<Shield size={15} />} iconColor="var(--accent)"
        label="Зашифрованный бэкап" desc="Все профили и настройки в один файл (опц. пароль)"
        onClick={() => { setDialog({ kind: 'export' }); setPassword(''); setError(null); }} />
      <ActionRow icon={<Upload size={15} />} iconColor="#00ff88"
        label="Восстановить из бэкапа" desc="Загрузить .simbackup или .json"
        onClick={startRestore} />

      <AnimatePresence>
        {dialog && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-6 bg-black/80 backdrop-blur-md" onClick={close}>
            <motion.div onClick={e => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="w-full max-w-sm bg-[#0d0d22] border border-[#2a2a5a] rounded-3xl p-6 shadow-2xl relative">
              <button onClick={close} className="absolute top-4 right-4 text-gray-500 hover:text-white"><X size={18} /></button>

              <div className="flex items-center gap-3 mb-5">
                <div className="w-11 h-11 rounded-2xl flex items-center justify-center"
                  style={{ background: withAlpha('var(--accent)', '15'), color: 'var(--accent)' }}>
                  {dialog.kind === 'export' ? <Download size={20} /> : <KeyRound size={20} />}
                </div>
                <div>
                  <h3 className="font-orbitron text-base font-bold text-white">
                    {dialog.kind === 'export' ? 'Бэкап данных' : 'Введите пароль'}
                  </h3>
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">
                    {dialog.kind === 'export' ? 'Профили + настройки' : 'Файл зашифрован'}
                  </p>
                </div>
              </div>

              {dialog.kind === 'export' && (
                <p className="text-[11px] text-gray-400 mb-3 leading-relaxed">
                  Пароль необязателен. Если задать — файл будет зашифрован (AES-256), и без пароля его нельзя восстановить.
                </p>
              )}

              <div className="relative mb-4">
                <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
                <input type="password" autoFocus value={password} onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') (dialog.kind === 'export' ? doExport() : doDecryptRestore()); }}
                  placeholder={dialog.kind === 'export' ? 'Пароль (необязательно)' : 'Пароль от бэкапа'}
                  className="w-full bg-[#12122a] border border-[#2a2a5a] rounded-xl pl-9 pr-4 py-2.5 text-sm text-white focus:outline-none focus:border-[var(--accent-a44)]" />
              </div>

              {error && <p className="text-[11px] text-red-400 mb-3 font-medium">{error}</p>}

              <button onClick={dialog.kind === 'export' ? doExport : doDecryptRestore} disabled={busy || (dialog.kind === 'restore-password' && !password.trim())}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-[var(--accent)] text-black text-[11px] font-bold uppercase tracking-widest active:scale-95 transition-all disabled:opacity-40">
                {busy ? 'Подождите…' : (<><Check size={14} /> {dialog.kind === 'export' ? 'Сохранить файл' : 'Восстановить'}</>)}
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
