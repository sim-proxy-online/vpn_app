/**
 * BackupManager — экспорт/импорт всех данных приложения (профили + настройки)
 * с опциональным шифрованием паролем (AES-GCM 256 + PBKDF2).
 *
 * Формат зашифрованного файла (.simbackup):
 *   { v: 2, enc: 'aes-gcm', kdf: 'pbkdf2', salt, iv, iter, data }
 * Незашифрованный (.json) остаётся обратно совместим со старым экспортом —
 * это просто объект { "sim-...": value }.
 */

const PREFIX = 'sim-';
const MAGIC = 'SIMBACKUP';
const PBKDF2_ITER = 150_000;

export interface BackupPayload {
  magic: string;
  app: 'sim-proxy';
  createdAt: string;
  version: number;
  /** Снимок всех ключей localStorage с префиксом sim- */
  data: Record<string, string | null>;
}

export interface EncryptedBackup {
  v: 2;
  enc: 'aes-gcm';
  kdf: 'pbkdf2';
  iter: number;
  salt: string; // base64
  iv: string;   // base64
  payload: string; // base64 шифротекст
}

/** Собрать снимок всех данных приложения из localStorage. */
export function collectBackup(): BackupPayload {
  const data: Record<string, string | null> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) data[k] = localStorage.getItem(k);
  }
  return {
    magic: MAGIC,
    app: 'sim-proxy',
    createdAt: new Date().toISOString(),
    version: 2,
    data,
  };
}

/** Применить снимок: записать ключи sim- в localStorage. Возвращает число ключей. */
export function applyBackup(payload: BackupPayload, opts?: { clearExisting?: boolean }): number {
  if (!payload || payload.magic !== MAGIC || typeof payload.data !== 'object') {
    throw new Error('Файл не является резервной копией Sim Proxy');
  }
  if (opts?.clearExisting) {
    Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).forEach(k => localStorage.removeItem(k));
  }
  let n = 0;
  for (const [k, v] of Object.entries(payload.data)) {
    if (!k.startsWith(PREFIX)) continue;
    if (v === null) { localStorage.removeItem(k); continue; }
    if (typeof v !== 'string') continue; // защита от tampered/malformed backup JSON
    localStorage.setItem(k, v);
    n++;
  }
  return n;
}

// ── base64 helpers ──
function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBuf(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deriveKey(password: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password) as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: iter, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Зашифровать снимок паролем → объект EncryptedBackup. */
export async function encryptBackup(payload: BackupPayload, password: string): Promise<EncryptedBackup> {
  if (!password) throw new Error('Пароль не задан');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITER);
  const enc = new TextEncoder();
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(JSON.stringify(payload)) as BufferSource);
  return {
    v: 2,
    enc: 'aes-gcm',
    kdf: 'pbkdf2',
    iter: PBKDF2_ITER,
    salt: bufToB64(salt.buffer),
    iv: bufToB64(iv.buffer),
    payload: bufToB64(ct),
  };
}

/** Расшифровать EncryptedBackup паролем → снимок. Бросает при неверном пароле. */
export async function decryptBackup(file: EncryptedBackup, password: string): Promise<BackupPayload> {
  if (!file || file.enc !== 'aes-gcm') throw new Error('Неизвестный формат бэкапа');
  const salt = b64ToBuf(file.salt);
  const iv = b64ToBuf(file.iv);
  const key = await deriveKey(password, salt, file.iter || PBKDF2_ITER);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, b64ToBuf(file.payload) as BufferSource);
  } catch {
    throw new Error('Неверный пароль или повреждённый файл');
  }
  const text = new TextDecoder().decode(plain);
  return JSON.parse(text) as BackupPayload;
}

/** true, если объект — зашифрованный бэкап. */
export function isEncryptedBackup(obj: unknown): obj is EncryptedBackup {
  return !!obj && typeof obj === 'object' && (obj as any).enc === 'aes-gcm' && typeof (obj as any).payload === 'string';
}

/** Инициировать скачивание файла в браузере/WebView. */
export function downloadFile(filename: string, content: string, mime = 'application/json') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Открыть системный диалог выбора файла и вернуть его текст. */
export function pickTextFile(accept = '.json,.simbackup,.txt'): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (!f) { resolve(null); return; }
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, text: String(r.result || '') });
      r.onerror = () => resolve(null);
      r.readAsText(f);
    };
    inp.click();
  });
}

const dateStamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

/** Экспорт: если задан пароль — шифруем (.simbackup), иначе обычный JSON. */
export async function exportBackup(password?: string): Promise<void> {
  const payload = collectBackup();
  if (password && password.trim()) {
    const enc = await encryptBackup(payload, password.trim());
    downloadFile(`sim-proxy-${dateStamp()}.simbackup`, JSON.stringify(enc), 'application/octet-stream');
  } else {
    downloadFile(`sim-proxy-backup-${dateStamp()}.json`, JSON.stringify(payload, null, 2));
  }
}
