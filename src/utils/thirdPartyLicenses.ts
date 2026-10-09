/**
 * Сторонние компоненты, которые входят в приложение, и их лицензии.
 * Показывается в Настройки → «О приложении» → «Лицензии». Полный разбор — THIRD_PARTY_LICENSES.md.
 *
 * Версии нативных ядер соответствуют сборкам, которые лежат в Android (jniLibs) и Windows
 * (desktop/resources); при их обновлении нужно обновить и эту таблицу.
 */

export type LicenseId = 'MPL-2.0' | 'GPL-3.0' | 'MIT' | 'Apache-2.0' | 'ISC' | 'OFL-1.1';

export interface ThirdPartyComponent {
  name: string;
  /** Версия или ревизия, как её видно в сборке. */
  version?: string;
  license: LicenseId;
  url: string;
  /** Где используется. */
  usage: string;
  /** Обязательство лицензии, которое нужно показать пользователю (например, GPL). */
  notice?: string;
}

export const MIHOMO_SOURCE_URL = 'https://github.com/MetaCubeX/mihomo';

export const THIRD_PARTY_COMPONENTS: ThirdPartyComponent[] = [
  {
    name: 'Xray-core',
    version: '26.3.27',
    license: 'MPL-2.0',
    url: 'https://github.com/XTLS/Xray-core',
    usage: 'Основное ядро (Android, iOS, Windows)',
    notice: 'Исходный код ядра доступен по ссылке; наша обёртка использует только его публичный API.',
  },
  {
    name: 'mihomo (Clash.Meta)',
    version: 'rev. 88dcbf7f (Android) · 90b1066e (Windows)',
    license: 'GPL-3.0',
    url: MIHOMO_SOURCE_URL,
    usage: 'Второе ядро для Hysteria2, TUIC, AnyTLS и др. (Android, Windows)',
    notice:
      'Распространяется по лицензии GNU GPL v3. Исходный код указанных ревизий — по ссылке; ' +
      'исходники сборки с нашими изменениями предоставляются по запросу через app.petrovich.party.',
  },
  {
    name: 'hev-socks5-tunnel',
    version: '2.18.0',
    license: 'MIT',
    url: 'https://github.com/heiher/hev-socks5-tunnel',
    usage: 'Мост TUN → SOCKS5 для ядра mihomo (Android)',
  },
  {
    name: 'gVisor (netstack)',
    license: 'Apache-2.0',
    url: 'https://github.com/google/gvisor',
    usage: 'Сетевой стек внутри Xray и mihomo',
  },
  {
    name: 'libXray',
    license: 'MIT',
    url: 'https://github.com/XTLS/libXray',
    usage: 'Сборка Xray для iOS (через SwiftyXrayKit)',
  },
  {
    name: 'SwiftyXrayKit',
    version: '≥ 2.0.0',
    license: 'Apache-2.0',
    url: 'https://github.com/dima-u/SwiftyXrayKit',
    usage: 'Привязка Xray к Network Extension (iOS)',
  },
  {
    name: 'Capacitor',
    version: '8.x',
    license: 'MIT',
    url: 'https://github.com/ionic-team/capacitor',
    usage: 'Оболочка приложения (Android, iOS)',
  },
  {
    name: 'Electron',
    version: '32',
    license: 'MIT',
    url: 'https://github.com/electron/electron',
    usage: 'Оболочка приложения (Windows)',
  },
  {
    name: 'React',
    version: '19',
    license: 'MIT',
    url: 'https://github.com/facebook/react',
    usage: 'Интерфейс',
  },
  {
    name: 'Framer Motion',
    version: '12',
    license: 'MIT',
    url: 'https://github.com/motiondivision/motion',
    usage: 'Анимации интерфейса',
  },
  {
    name: 'Lucide',
    version: '1.x',
    license: 'ISC',
    url: 'https://github.com/lucide-icons/lucide',
    usage: 'Иконки',
  },
  {
    name: 'qrcode.react',
    version: '4.x',
    license: 'ISC',
    url: 'https://github.com/zpao/qrcode.react',
    usage: 'QR-коды',
  },
  {
    name: 'flag-icons',
    license: 'MIT',
    url: 'https://github.com/lipis/flag-icons',
    usage: 'Флаги стран',
  },
  {
    name: 'Inter',
    license: 'OFL-1.1',
    url: 'https://github.com/rsms/inter',
    usage: 'Шрифт интерфейса',
  },
  {
    name: 'Orbitron',
    license: 'OFL-1.1',
    url: 'https://github.com/theleagueof/orbitron',
    usage: 'Шрифт заголовков',
  },
  {
    name: 'v2ray-rules-dat (geoip.dat, geosite.dat)',
    license: 'GPL-3.0',
    url: 'https://github.com/Loyalsoldier/v2ray-rules-dat',
    usage: 'Правила маршрутизации по странам и доменам',
    notice: 'Данные распространяются по лицензии репозитория-источника (Loyalsoldier/v2ray-rules-dat).',
  },
];

/** Компоненты, к которым лицензия требует показать обязательство (GPL и т.п.). */
export function componentsWithNotice(list: ThirdPartyComponent[] = THIRD_PARTY_COMPONENTS): ThirdPartyComponent[] {
  return list.filter((c) => !!c.notice);
}
