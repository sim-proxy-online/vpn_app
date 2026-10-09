/**
 * Внешний адрес для плитки «Ваш адрес» на главном экране.
 *
 * Адрес определяется запросом к https://1.1.1.1/cdn-cgi/trace: это IP-литерал (DNS не нужен, сертификат содержит
 * этот адрес), а в ответе — строки «ip=…» и «loc=…» (код страны). На Android запрос делает нативная часть через
 * живой SOCKS туннеля: приложение исключено из VPN, поэтому прямой запрос из WebView показал бы настоящий адрес,
 * а не адрес сервера. Здесь — разбор ответа и название страны.
 */

export interface PublicIp {
  ip: string;
  /** Двухбуквенный код страны (DE) или пустая строка. */
  country: string;
}

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:]{2,45}$/i;

export function isIpAddress(v: string): boolean {
  const s = v.trim();
  if (IPV4.test(s)) return s.split('.').every((p) => Number(p) <= 255);
  return s.includes(':') && IPV6.test(s);
}

/** Разбирает ответ cdn-cgi/trace («ключ=значение» построчно); null, если адреса в нём нет. */
export function parseTrace(text: string): PublicIp | null {
  let ip = '';
  let country = '';
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === 'ip') ip = value;
    else if (key === 'loc') country = value.toUpperCase();
  }
  if (!isIpAddress(ip)) return null;
  return { ip, country: /^[A-Z]{2}$/.test(country) ? country : '' };
}

let regionNames: Intl.DisplayNames | null | undefined;

/** Название страны по коду на русском («DE» → «Германия»); если определить нельзя — сам код. */
export function countryName(code: string): string {
  const c = (code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  if (regionNames === undefined) {
    try { regionNames = new Intl.DisplayNames(['ru'], { type: 'region' }); } catch { regionNames = null; }
  }
  try { return regionNames?.of(c) || c; } catch { return c; }
}
