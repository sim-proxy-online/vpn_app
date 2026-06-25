/**
 * ISP auto-detection via ASN.
 * ipinfo.io returns org field like "AS8359 PJSC MTS" — we parse the ASN and map to a DPI preset.
 */

export interface IspPresetResult {
  presetId: 'standard' | 'youtube' | 'aggressive' | 'max';
  ispName: string;
}

interface PresetParams {
  frag: boolean;
  packets: string;
  length: string;
  interval: string;
  noises: boolean;
}

// Must match DPI_PRESETS values in SettingsScreen.tsx exactly (for activePresetId detection to work).
const PRESET_PARAMS: Record<string, PresetParams> = {
  standard:   { frag: true,  packets: 'tlshello', length: '10-20', interval: '1-2',  noises: false },
  youtube:    { frag: true,  packets: 'tlshello', length: '10-20', interval: '1-2',  noises: false },
  aggressive: { frag: true,  packets: 'tlshello', length: '1-5',   interval: '1-3',  noises: false },
  max:        { frag: true,  packets: 'tlshello', length: '1-5',   interval: '1-3',  noises: true  },
};

// ASN number (without "AS" prefix) → { presetId, ispName }
const ASN_MAP: Record<string, IspPresetResult> = {
  // ── МТС (мобайл + домашний + дочки) ── жёсткий ТСПУ
  '8359':  { presetId: 'aggressive', ispName: 'МТС' },
  '30922': { presetId: 'aggressive', ispName: 'МТС' },
  '8732':  { presetId: 'aggressive', ispName: 'МТС (Комстар)' },
  '57363': { presetId: 'aggressive', ispName: 'МТС' },
  '47395': { presetId: 'standard',   ispName: 'МГТС' },       // домашний интернет Москва

  // ── Мегафон (мобайл + регионы) ── жёсткий ТСПУ
  '31133': { presetId: 'aggressive', ispName: 'Мегафон' },
  '25159': { presetId: 'aggressive', ispName: 'Мегафон' },
  '25478': { presetId: 'aggressive', ispName: 'Мегафон' },
  '35807': { presetId: 'aggressive', ispName: 'Yota' },        // Yota = дочка Мегафон
  '50340': { presetId: 'aggressive', ispName: 'Мегафон' },

  // ── Теле2 (мобайл + MVNO) ── жёсткий ТСПУ
  '39374': { presetId: 'aggressive', ispName: 'Теле2' },
  '41330': { presetId: 'aggressive', ispName: 'Теле2' },
  '51570': { presetId: 'aggressive', ispName: 'Теле2' },

  // ── Билайн / ВымпелКом (мобайл + домашний) — ТСПУ у всех, всем aggressive
  '3216':  { presetId: 'aggressive', ispName: 'Билайн' },
  '8402':  { presetId: 'aggressive', ispName: 'Билайн' },
  '42387': { presetId: 'aggressive', ispName: 'Билайн' },

  // ── Ростелеком (домашний + регионы)
  '12389': { presetId: 'standard', ispName: 'Ростелеком' },
  '42481': { presetId: 'standard', ispName: 'Ростелеком' },
  '51813': { presetId: 'standard', ispName: 'Ростелеком' },
  '2848':  { presetId: 'standard', ispName: 'Ростелеком' },
  '20485': { presetId: 'standard', ispName: 'ТТК' },           // Транстелеком (дочка РТК)
  '31514': { presetId: 'standard', ispName: 'ТТК' },

  // ── ЭР-Телеком (Дом.ру)
  '9049':  { presetId: 'standard', ispName: 'Дом.ру' },
  '31200': { presetId: 'standard', ispName: 'Дом.ру' },

  // ── MVNO и виртуальные операторы
  '205638': { presetId: 'aggressive', ispName: 'Тинькофф Мобайл' },
  '60727':  { presetId: 'aggressive', ispName: 'СберМобайл' },
  '57629':  { presetId: 'aggressive', ispName: 'Тele2 MVNO' },

  // ── Другие российские провайдеры
  '49869': { presetId: 'standard', ispName: 'Convex' },
  '41754': { presetId: 'standard', ispName: 'МТТ' },
  '43478': { presetId: 'standard', ispName: 'ЮТелеком' },
  '51500': { presetId: 'standard', ispName: 'Новотелеком' },
  '35598': { presetId: 'standard', ispName: 'Inetcom' },
  '34757': { presetId: 'standard', ispName: 'Сеть ТВ' },
  '50058': { presetId: 'standard', ispName: 'РТС' },
};

export interface IspDetectionResult {
  ispName: string;
  ispRaw: string;
  presetId: IspPresetResult['presetId'] | null;
  presetLabel: string | null;
}

const PRESET_LABELS: Record<string, string> = {
  standard:   'Стандарт',
  youtube:    'YouTube',
  aggressive: 'МТС / Мегафон',
  max:        'Максимум',
};

/** Parse org string like "AS8359 PJSC MTS" → ASN lookup, then name-based fallback. */
export function detectIspPreset(org: string): IspPresetResult | null {
  if (!org) return null;

  // 1. ASN lookup
  const asnMatch = /^AS(\d+)/i.exec(org);
  if (asnMatch) {
    const byAsn = ASN_MAP[asnMatch[1]];
    if (byAsn) return byAsn;
  }

  // 2. Name-based fallback (handles regional subsidiaries and non-Russian ASNs)
  const l = org.toLowerCase();
  if (/\bmts\b|мтс/.test(l))                          return { presetId: 'aggressive', ispName: 'МТС' };
  if (/megafon|мегафон/.test(l))                       return { presetId: 'aggressive', ispName: 'Мегафон' };
  if (/\byota\b/.test(l))                              return { presetId: 'aggressive', ispName: 'Yota' };
  if (/tele2|теле2/.test(l))                           return { presetId: 'aggressive', ispName: 'Теле2' };
  if (/tinkoff|тинькофф/.test(l))                      return { presetId: 'aggressive', ispName: 'Тинькофф Мобайл' };
  if (/sber.*mobil|sbermobile|сбер.*мобил/.test(l))    return { presetId: 'aggressive', ispName: 'СберМобайл' };
  if (/beeline|билайн|vimpelcom|veon/.test(l))         return { presetId: 'aggressive', ispName: 'Билайн' };
  if (/rostelecom|ростелеком/.test(l))                 return { presetId: 'standard',   ispName: 'Ростелеком' };
  if (/\bttk\b|транстелеком/.test(l))                  return { presetId: 'standard',   ispName: 'ТТК' };
  if (/dom\.?ru|domru|er.?telecom|эр.?телеком/.test(l)) return { presetId: 'standard', ispName: 'Дом.ру' };
  if (/\bmgts\b|мгтс/.test(l))                         return { presetId: 'standard',   ispName: 'МГТС' };

  return null;
}

/** Write DPI preset settings to localStorage. Fires 'isp-preset-applied' event. */
export function applyIspPresetToStorage(presetId: string): void {
  const p = PRESET_PARAMS[presetId];
  if (!p) return;
  try {
    localStorage.setItem('sim-frag-enable',   JSON.stringify(p.frag));
    localStorage.setItem('sim-frag-packets',  JSON.stringify(p.packets));
    localStorage.setItem('sim-frag-length',   JSON.stringify(p.length));
    localStorage.setItem('sim-frag-interval', JSON.stringify(p.interval));
    localStorage.setItem('sim-noises-enable', JSON.stringify(p.noises));
  } catch {}
}

/**
 * Fetch current IP geo info, detect ISP, optionally apply preset to localStorage.
 * Always fires 'isp-preset-applied' event so SettingsScreen can update its state.
 */
/** Return last stored detection result (survives screen re-mounts). */
export function getStoredDetectionResult(): IspDetectionResult | null {
  try {
    const s = localStorage.getItem('sim-isp-detection');
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

/**
 * Fetch current IP geo info, detect ISP, optionally apply preset to localStorage.
 * Stores result and fires 'isp-preset-applied' event.
 */
function makeAbortSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(id) };
}

/** Fetch org string using WebView fetch with safe AbortController timeout. */
async function webFetchOrg(url: string): Promise<string> {
  const { signal, clear } = makeAbortSignal(6000);
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) return '';
    const d = await r.json() as { org?: string; asn?: string };
    return d.org ?? d.asn ?? '';
  } finally {
    clear();
  }
}

/** Fetch org string using native OkHttp — bypasses WebView restrictions. */
async function nativeFetchOrg(url: string): Promise<string> {
  const { nativeFetchUrl } = await import('../native/bridge');
  const res = await nativeFetchUrl(url);
  const body = typeof res === 'string' ? res : (res as { body?: string }).body ?? '';
  if (!body) return '';
  const d = JSON.parse(body) as { org?: string; asn?: string };
  return d.org ?? d.asn ?? '';
}

const IPINFO_URL = 'https://ipinfo.io/json?token=85f86434c5059f';
const IPAPI_URL  = 'https://ipapi.co/json/';

/** Fetch org/ASN string: WebView fetch → native OkHttp → ipapi.co fallback. */
async function fetchOrgString(): Promise<string> {
  // 1. WebView fetch (ipinfo.io)
  try { const v = await webFetchOrg(IPINFO_URL); if (v) return v; } catch { /* fall through */ }
  // 2. Native OkHttp fetch (ipinfo.io) — обходит ограничения WebView
  try { const v = await nativeFetchOrg(IPINFO_URL); if (v) return v; } catch { /* fall through */ }
  // 3. Fallback API
  try { const v = await webFetchOrg(IPAPI_URL); if (v) return v; } catch { /* fall through */ }
  try { const v = await nativeFetchOrg(IPAPI_URL); if (v) return v; } catch { /* fall through */ }
  return '';
}

export async function runIspDetection(applyPreset = true): Promise<IspDetectionResult> {
  const { nativeGetNetworkCarrier } = await import('../native/bridge');
  const carrierName = nativeGetNetworkCarrier();
  const carrierMatch = carrierName ? detectIspPreset(carrierName) : null;

  // Fast path: мобильный оператор (aggressive) определяется мгновенно через TelephonyManager.
  // Aggressive пресет корректен для всех ТСПУ-операторов и работает на любой сети (WiFi/mobile).
  // Для home-ISP (standard) нужна IP-детекция — TelephonyManager не различает WiFi-провайдера.
  if (carrierMatch?.presetId === 'aggressive') {
    const result: IspDetectionResult = {
      ispName: carrierMatch.ispName,
      ispRaw: carrierName,
      presetId: carrierMatch.presetId,
      presetLabel: PRESET_LABELS[carrierMatch.presetId] ?? null,
    };
    try { localStorage.setItem('sim-isp-detection', JSON.stringify(result)); } catch {}
    if (applyPreset) applyIspPresetToStorage(carrierMatch.presetId);
    globalThis.dispatchEvent(new CustomEvent('isp-preset-applied', { detail: result }));
    return result;
  }

  // IP-based detection для home ISP: корректно определяет WiFi-провайдера по ASN.
  // Разделяет Ростелеком/Дом.ру (standard) от случаев без SIM-матча.
  let orgRaw = await fetchOrgString();
  let match = orgRaw ? detectIspPreset(orgRaw) : null;

  // TelephonyManager fallback: когда IP-запрос заблокирован DPI или нет интернета.
  if (!match && carrierMatch) {
    orgRaw = carrierName;
    match = carrierMatch;
  }

  const ispName = match?.ispName ?? (orgRaw.replace(/^AS\d+\s+/i, '').substring(0, 30) || 'Неизвестно');

  const result: IspDetectionResult = {
    ispName,
    ispRaw: orgRaw,
    presetId: match?.presetId ?? null,
    presetLabel: match ? (PRESET_LABELS[match.presetId] ?? null) : null,
  };

  try { localStorage.setItem('sim-isp-detection', JSON.stringify(result)); } catch {}
  if (applyPreset && match) applyIspPresetToStorage(match.presetId);
  // Диспатчим только когда ISP определён — иначе SettingsScreen перезаписывает
  // ручные настройки DPI устаревшими значениями из localStorage
  if (match) globalThis.dispatchEvent(new CustomEvent('isp-preset-applied', { detail: result }));
  return result;
}
