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
  status: 'healthy' | 'warning' | 'expired' | 'error';
}

export type AppScreen = 'home' | 'servers' | 'profiles' | 'settings' | 'debug' | 'dns' | 'dashboard';
export type ConnectionState = 'disconnected' | 'connecting' | 'verifying' | 'connected' | 'disconnecting' | 'reconnecting';
