/**
 * Наш User-Agent для сетевых запросов приложения: SimProxy/<версия>.
 * Единый источник для слоя подписок, моста и iOS-шима (без циклических импортов).
 */
declare const __APP_VERSION__: string | undefined;

const VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

export const APP_USER_AGENT = `SimProxy/${VERSION}`;
