// Ссылка на сайт для оформления подписки. Открывается из профилей и настроек.
export const SUBSCRIPTION_URL = 'https://petrovich.party/';

// Supabase-проект с функциями приложения: start_trial (пробный период) и
// get_operator_profiles (профили операторов/провайдеров для автоподбора DPI-обхода).
// Ключ publishable — рассчитан на встраивание в клиент; таблицы закрыты (RLS),
// наружу доступны только эти функции.
export const SUPABASE_RPC_URL = 'https://yktvdoglfcrtjijlttpm.supabase.co/rest/v1/rpc/start_trial';
export const SUPABASE_API_KEY = 'sb_publishable_fp9AkF05_a4oahWltj4zjw_8x6_Opo0';