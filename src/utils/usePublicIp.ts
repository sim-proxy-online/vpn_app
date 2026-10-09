import { useEffect, useState } from 'react';
import { nativeGetPublicIp } from '../native/bridge';
import { countryName } from './publicIp';

export interface PublicIpState {
  ip?: string;
  /** Название страны по-русски. */
  country?: string;
  /** Определить не удалось после всех попыток. */
  failed: boolean;
}

// Сразу после подключения туннель ещё «прогревается», поэтому адрес пробуем несколько раз с растущими паузами.
const ATTEMPT_DELAYS_MS = [1200, 3500, 8000, 18000];

/**
 * Внешний адрес и страна, как их видит интернет через туннель, — пока VPN подключён. Меняется сервер (переподключение)
 * или защита выключается — состояние сбрасывается и адрес определяется заново.
 */
export function usePublicIp(connected: boolean, serverKey: string | undefined): PublicIpState {
  const [state, setState] = useState<PublicIpState>({ failed: false });

  useEffect(() => {
    setState({ failed: false });
    if (!connected) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (i: number) => {
      timer = setTimeout(async () => {
        let found = null;
        try { found = await nativeGetPublicIp(); } catch { /* повторим */ }
        if (cancelled) return;
        if (found) setState({ ip: found.ip, country: countryName(found.country) || found.country || undefined, failed: false });
        else if (i + 1 < ATTEMPT_DELAYS_MS.length) attempt(i + 1);
        else setState({ failed: true });
      }, ATTEMPT_DELAYS_MS[i]);
    };
    attempt(0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [connected, serverKey]);

  return state;
}
