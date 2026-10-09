export type Protocol =
  | 'vless'
  | 'vmess'
  | 'trojan'
  | 'shadowsocks'
  | 'hysteria'
  | 'hysteria2'
  | 'tuic'
  | 'wireguard'
  | 'shadowtls'
  | 'anytls'
  | 'naive'
  | 'socks'
  | 'http'
  | 'ssh'
  | 'brook'
  | 'mtproto'
  | 'xhttp'
  | 'json';

export interface ServerNode {
  id: string;
  name: string;
  address: string;
  port: number;
  protocol: Protocol;
  remark: string;
  flag?: string;
  ping?: number;
  rawLink: string;
  transport?: string;
  headerType?: string;
  alpn?: string;
  allowInsecure?: boolean;
  security?: string;
  flow?: string;
  fingerprint?: string;
  serverDescription?: string;
  /** Описание сервера от провайдера (Happ: serverDescription в ссылке или meta.serverDescription в JSON), до 30 символов. Показывается под именем вместо протокола. */
  description?: string;
  fragment?: string;
  noises?: string;
  uuid?: string;
  password?: string;
  privateKey?: string;
  publicKey?: string;
  shortId?: string;
  preSharedKey?: string;
  sni?: string;
  path?: string;
  host?: string;
  method?: string;
  alterId?: number;
  obfs?: string;
  username?: string;
  localAddress?: string;
  mtu?: string;
  altPorts?: string;
  version?: number;
}

export interface RoutingProfile {
  Name: string;
  GlobalProxy: string;
  RemoteDNSType: string;
  RemoteDNSDomain: string;
  RemoteDNSIP: string;
  DomesticDNSType: string;
  DomesticDNSDomain: string;
  DomesticDNSIP: string;
  Geoipurl: string;
  Geositeurl: string;
  LastUpdated?: string;
  DnsHosts: Record<string, string>;
  DirectSites: string[];
  DirectIp: string[];
  ProxySites?: string[];
  ProxyIp?: string[];
  BlockSites?: string[];
  BlockIp?: string[];
  DomainStrategy: string;
  FakeDNS: string;
  RouteOrder?: string; // e.g. "block-proxy-direct"
}

export interface SubscriptionTraffic {
  upload: number;
  download: number;
  total: number;
  expire?: number; // timestamp in seconds
  usagePercentage?: number;
  remainingDays?: number;
}

export type PanelType = 'remnawave' | '3x-ui' | 'marzban' | 'hiddify' | 'xui' | 'unknown';

/**
 * Управление приложением со стороны провайдера подписки (параметры в стиле Happ, см.
 * src/utils/appManagement.ts). Хранится в профиле, чтобы объявление и кнопки были видны без сети.
 */
export interface ManagedProfileState {
  /** Пользователь разрешил провайдеру менять настройки приложения. */
  trusted?: boolean;
  /** Адрес панели управления (кабинета) из заголовка x-cabinet-url — для продления подписки в приложении. */
  cabinetUrl?: string;
  announce?: string;
  info?: { text: string; color: 'red' | 'blue' | 'green'; buttonText?: string; buttonLink?: string };
  expire?: { warn: boolean; notify: boolean; buttonLink?: string };
  hideSettings?: boolean;
  fallbackUrl?: string;
  /** subscriptions-sort-type: порядок серверов в этой подписке (without — как отдал провайдер). */
  sortType?: 'without' | 'ping' | 'alphabet';
  /** color-profile: фирменный цвет провайдера (#rrggbb); им подсвечивается карточка подписки. Нет — наша тема. */
  accent?: string;
  /** subscription-pin: подписка закреплена сверху списка. */
  pinned?: boolean;
  /** subscriptions-expand-now: раскрыть список серверов этой подписки. */
  expandNow?: boolean;
  /** subscriptions-collapse=false: список серверов всегда раскрыт. */
  alwaysExpanded?: boolean;
  /** change-user-agent: User-Agent для запросов этой подписки (только доверенному профилю). */
  userAgent?: string;
  /** Настройки от провайдера (ключи sim-*), ждущие разрешения пользователя. */
  pending?: Record<string, string | number | boolean>;
  /** Сколько настроек применено при последнем обновлении подписки. */
  appliedCount?: number;
  ignored?: string[];
  rejected?: string[];
}

/**
 * Каким User-Agent запрашивать подписку, чтобы провайдер отдал больше: описания серверов и подсказки он
 * часто даёт только Happ. default — обычный запрос; happ — запрос как у Happ дал больше и запомнен.
 * checkedAt — когда сравнивали (раз в неделю сравнение повторяется для default).
 */
export interface UaPreference {
  mode: 'default' | 'happ';
  checkedAt: number;
}

export interface SubscriptionProfile {
  id: string;
  name: string;
  url: string;
  nodes: ServerNode[];
  updatedAt: string;
  lastUpdateTimestamp: number;
  autoUpdate: boolean;
  routing?: RoutingProfile;
  traffic?: SubscriptionTraffic;
  subscriptionId?: string;
  notices?: string[];
  webPage?: string;
  updateInterval?: number;
  supportUrl?: string;
  panelType?: PanelType;
  // Историческое поле встроенного пробного профиля (фича удалена): остаётся,
  // чтобы старые бэкапы и localStorage без ошибок читались. Больше не пишется.
  trialExpiresAt?: number;
  // Параметры управления от провайдера подписки (стиль Happ): объявление, кнопки, доверие.
  managed?: ManagedProfileState;
  // Какой User-Agent даёт у этого провайдера больше данных (см. utils/subscriptionFetch.ts).
  fetchUa?: UaPreference;
  status: 'healthy' | 'warning' | 'expired' | 'error';
  // Причина последнего неудачного обновления подписки (status === 'error'); очищается при успешном.
  updateError?: string;
}

export type AppScreen = 'home' | 'servers' | 'profiles' | 'settings' | 'debug' | 'dns' | 'dashboard';
export type ConnectionState = 'disconnected' | 'connecting' | 'verifying' | 'connected' | 'disconnecting' | 'reconnecting';
