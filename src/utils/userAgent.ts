/**
 * Наш User-Agent для сетевых запросов приложения: Petrovich/<версия>.
 * Единый источник для слоя подписок, моста и iOS-шима (без циклических импортов).
 */
declare const __APP_VERSION__: string | undefined;

const VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

export const APP_USER_AGENT = `Petrovich/${VERSION}`;

/**
 * User-Agent запросов ПОДПИСКИ — тот же, что был в 2.7.0. Серверы подписок выбирают формат ответа по
 * User-Agent: на этот отдают полные конфиги (балансировщики и запасные маршруты для сетей с белыми
 * списками), а на незнакомый им Petrovich/<версия> — простые ссылки на один сервер без запасных путей.
 * Менять только вместе с настройкой сервера подписки (проверено 10.10.2026 на x.petrovich.party).
 */
export const SUBSCRIPTION_USER_AGENT = 'v2rayNG/1.8.19';
