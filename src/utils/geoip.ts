/**
 * GeoIP Utilities
 * Определение географии и информации о сервере
 */

export interface GeoInfo {
  ip: string;
  country: string;
  countryCode: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  isp?: string;
  isVpn?: boolean;
  timezone?: string;
}

export async function fetchGeoInfo(ip?: string): Promise<GeoInfo | null> {
  try {
    const url = ip
      ? `https://ipinfo.io/${ip}/json?token=85f86434c5059f`
      : 'https://ipinfo.io/json?token=85f86434c5059f';

    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const [lat, lon] = (data.loc || '0,0').split(',').map(Number);

    return {
      ip: data.ip || 'Unknown',
      country: data.country || 'XX',
      countryCode: data.country_code || 'XX',
      city: data.city,
      latitude: lat || undefined,
      longitude: lon || undefined,
      isp: data.org,
      isVpn: false, // Would need additional check
      timezone: data.timezone,
    };
  } catch (e) {
    console.error('Failed to fetch geo info:', e);
    return null;
  }
}

export function getCountryEmoji(countryCode: string): string {
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

export function calculateDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

const COUNTRY_CODES: Record<string, string> = {
  'US': 'United States', 'GB': 'United Kingdom', 'CA': 'Canada',
  'AU': 'Australia', 'DE': 'Germany', 'FR': 'France', 'JP': 'Japan',
  'CN': 'China', 'IN': 'India', 'BR': 'Brazil', 'RU': 'Russia',
  'SG': 'Singapore', 'NL': 'Netherlands', 'CH': 'Switzerland',
};

export function getCountryName(code: string): string {
  return COUNTRY_CODES[code.toUpperCase()] || code;
}

