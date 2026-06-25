import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

export type Lang = 'ru' | 'en';

export const LANGUAGES: { code: Lang; label: string; flag: string }[] = [
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
];

// Плоский словарь переводов. Ключи в точечной нотации.
// RU — источник истины; EN — перевод. Недостающие ключи падают на RU, затем на сам ключ.
type Dict = Record<string, string>;

const RU: Dict = {
  'nav.home': 'Главная',
  'nav.servers': 'Серверы',
  'nav.profiles': 'Профили',
  'nav.settings': 'Настройки',

  'common.cancel': 'Отмена',
  'common.done': 'Готово',
  'common.save': 'Сохранить',
  'common.apply': 'Применить',
  'common.next': 'Далее',
  'common.skip': 'Пропустить',
  'common.start': 'Начать',
  'common.language': 'Язык',

  'onboard.1.title': 'Добро пожаловать в Sim Proxy',
  'onboard.1.text': 'Быстрый и приватный доступ в интернет. 13 протоколов, два ядра (Xray + sing-box), обход блокировок DPI.',
  'onboard.2.title': 'Добавьте подписку',
  'onboard.2.text': 'Вставьте ссылку-подписку или конфиг (vless://, vmess://…) на вкладке «Профили». Можно открыть ссылку sim:// прямо из браузера.',
  'onboard.3.title': 'Выберите быстрейший',
  'onboard.3.text': 'Кнопка «Подключить быстрейший» сама протестирует все серверы и выберет лучший по задержке. Помечайте любимые ⭐.',
  'onboard.4.title': 'Разрешения для VPN',
  'onboard.4.text': 'Для работы в фоне дайте разрешение VPN и отключите оптимизацию батареи. Это нужно, чтобы соединение не рвалось.',

  'settings.title': 'Настройки',
  'settings.section.general': 'Основные',
  'settings.section.appearance': 'Оформление',
  'settings.section.traffic': 'Управление трафиком',
  'settings.section.engine': 'Сетевой движок',
  'settings.section.dpi': 'Обход блокировок (DPI)',
  'settings.section.data': 'Система и Данные',
  'settings.section.info': 'Инфо',
};

const EN: Dict = {
  'nav.home': 'Home',
  'nav.servers': 'Servers',
  'nav.profiles': 'Profiles',
  'nav.settings': 'Settings',

  'common.cancel': 'Cancel',
  'common.done': 'Done',
  'common.save': 'Save',
  'common.apply': 'Apply',
  'common.next': 'Next',
  'common.skip': 'Skip',
  'common.start': 'Get started',
  'common.language': 'Language',

  'onboard.1.title': 'Welcome to Sim Proxy',
  'onboard.1.text': 'Fast and private internet access. 13 protocols, dual core (Xray + sing-box), DPI bypass.',
  'onboard.2.title': 'Add a subscription',
  'onboard.2.text': 'Paste a subscription link or a config (vless://, vmess://…) on the “Profiles” tab. You can also open a sim:// link right from the browser.',
  'onboard.3.title': 'Pick the fastest',
  'onboard.3.text': 'The “Connect fastest” button tests all servers and picks the one with the lowest latency. Star your favorites ⭐.',
  'onboard.4.title': 'VPN permissions',
  'onboard.4.text': 'For background operation grant the VPN permission and disable battery optimization so the connection stays alive.',

  'settings.title': 'Settings',
  'settings.section.general': 'General',
  'settings.section.appearance': 'Appearance',
  'settings.section.traffic': 'Traffic control',
  'settings.section.engine': 'Network engine',
  'settings.section.dpi': 'Censorship bypass (DPI)',
  'settings.section.data': 'System & Data',
  'settings.section.info': 'Info',
};

const DICTS: Record<Lang, Dict> = { ru: RU, en: EN };

function detectInitialLang(): Lang {
  try {
    const saved = localStorage.getItem('sim-lang');
    if (saved === 'ru' || saved === 'en') return saved;
  } catch { /* ignore */ }
  const nav = (typeof navigator !== 'undefined' ? navigator.language : 'ru') || 'ru';
  return nav.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

interface I18nContextType {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, fallback?: string) => string;
}

const I18nContext = createContext<I18nContextType>({
  lang: 'ru',
  setLang: () => {},
  t: (k) => k,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);

  useEffect(() => {
    try { localStorage.setItem('sim-lang', lang); } catch { /* ignore */ }
    try { document.documentElement.setAttribute('lang', lang); } catch { /* ignore */ }
  }, [lang]);

  const setLang = useCallback((l: Lang) => setLangState(l), []);

  const t = useCallback((key: string, fallback?: string): string => {
    return DICTS[lang][key] ?? RU[key] ?? fallback ?? key;
  }, [lang]);

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() { return useContext(I18nContext); }
