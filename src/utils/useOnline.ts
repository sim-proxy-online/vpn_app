import { useEffect, useState } from 'react';
import { isDesktopPlatform, isNative, nativeHasInternet } from '../native/bridge';

// «Нет сети» показывается, только если сети нет подряд несколько проверок: при смене Wi-Fi на мобильную сеть и при
// переключении VPN связь на секунду-другую пропадает, и мигающая заметка была бы ложной тревогой.
const OFFLINE_AFTER_MS = 2500;
const POLL_MS = 3000;
const MISSES_BEFORE_OFFLINE = 2;

/**
 * Есть ли у устройства сеть.
 *  • Android: система спрашивается напрямую (nativeHasInternet) каждые 3 с, «нет» — после двух отрицательных ответов подряд.
 *    Ни navigator.onLine (после остановки VPN WebView подолгу считает, что сети нет), ни isNetworkAvailable монитора
 *    (отвечает по последнему событию и в первые секунды после запуска ошибается) для этого не годятся.
 *  • Desktop и браузер: navigator.onLine и события online/offline с задержкой.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    if (isNative() && !isDesktopPlatform()) {
      let misses = 0;
      const poll = () => {
        if (nativeHasInternet()) { misses = 0; setOnline(true); }
        else if (++misses >= MISSES_BEFORE_OFFLINE) setOnline(false);
      };
      poll();
      const id = setInterval(poll, POLL_MS);
      return () => clearInterval(id);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (timer) clearTimeout(timer);
      if (typeof navigator === 'undefined' || navigator.onLine !== false) { setOnline(true); return; }
      timer = setTimeout(() => { if (navigator.onLine === false) setOnline(false); }, OFFLINE_AFTER_MS);
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return online;
}
