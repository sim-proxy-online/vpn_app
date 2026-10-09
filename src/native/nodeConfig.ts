/**
 * Сборка конфига ядра для узла — ЕДИНЫЙ путь и для основного подключения
 * (App.handleToggle), и для фонового failover (native/failover.ts): запасной
 * сервер обязан получить конфиг, построенный так же, как основной, иначе после
 * автопереключения в фоне поведение ядра непредсказуемо.
 *
 * Носители конфига: share-link → buildXrayConfig; Clash-YAML → как есть, с
 * подменой SOCKS-порта под TUN; полный JSON-конфиг пользователя → как есть, с
 * адаптацией (inbounds, дедуп outbound-тегов, DNS, observatory — см. комментарии
 * в теле); mihomo-протоколы (hysteria2/tuic/anytls и т.п.) → buildMihomoConfig.
 */
import type { RoutingProfile, ServerNode } from '../types';
import { rebindInboundTags } from '../data';
import { buildXrayConfig, isProtocolSupportedByCore } from './bridge';
import { buildMihomoConfig, shouldUseMihomo } from './mihomoConfig';

function load<T>(key: string, fb: T): T { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fb; } catch { return fb; } }

/** Какое ядро исполнит узел: mihomo — YAML (Clash) и hysteria2/tuic/anytls и т.п., иначе Xray. */
export function resolveCore(node: ServerNode): 'xray' | 'mihomo' {
  const rawTrim = node.rawLink.trim();
  const isClashYaml = rawTrim.includes('proxies:') || rawTrim.includes('proxy-groups:');
  return isClashYaml || shouldUseMihomo(node.protocol) ? 'mihomo' : 'xray';
}

/** Конфиг ядра для узла; бросает ошибку для протоколов, которых не умеет ни одно ядро. */
export function buildNodeConfig(node: ServerNode, settings: Record<string, unknown>, routingProfile?: RoutingProfile): string {
  const rawTrim = node.rawLink.trim();
  const isClashYaml = rawTrim.includes('proxies:') || rawTrim.includes('proxy-groups:');
  const useMihomo = isClashYaml || shouldUseMihomo(node.protocol);
  // Протоколы, которые НЕ умеет ни одно из подключённых ядер.
  if (!useMihomo && !isProtocolSupportedByCore(node.protocol)
      && node.protocol !== 'json'
      && !rawTrim.startsWith('{') && !rawTrim.startsWith('[')) {
    throw new Error(
      `Протокол ${node.protocol.toUpperCase()} не поддерживается. ` +
      `Выберите сервер с VLESS/VMess/Trojan/Shadowsocks/WireGuard/Hysteria2/TUIC.`
    );
  }

  let configJson: string;

  // Прямой путь mihomo для share-link нод hysteria2/tuic/anytls и т.п.:
  // генерируем mihomo-конфиг из ноды (TUN fd подставит Java-сторона).
  if (useMihomo && !isClashYaml) {
    configJson = buildMihomoConfig(node, settings);
  } else
  try {
    // ДЕТЕКЦИЯ YAML (MIHOMO/CLASH)
    let rawLinkTrimmed = node.rawLink.trim();
    const isYaml = rawLinkTrimmed.includes('proxies:') || rawLinkTrimmed.includes('proxy-groups:');

    if (isYaml) {
       // АДАПТАЦИЯ MIHOMO YAML: подменяем SOCKS порт на системный
       const sPort = Number(settings.socksPort);
       if (rawLinkTrimmed.includes('socks-port:')) {
           rawLinkTrimmed = rawLinkTrimmed.replace(/socks-port:\s*\d+/g, `socks-port: ${sPort}`);
       } else if (rawLinkTrimmed.includes('mixed-port:')) {
           rawLinkTrimmed = rawLinkTrimmed.replace(/mixed-port:\s*\d+/g, `socks-port: ${sPort}`);
       } else {
           rawLinkTrimmed = `socks-port: ${sPort}\n${rawLinkTrimmed}`;
       }
       configJson = rawLinkTrimmed;
    } else if (node.protocol === 'json' || (rawLinkTrimmed.startsWith('{') && rawLinkTrimmed.endsWith('}')) || rawLinkTrimmed.startsWith('[')) {
      let finalConfig: any;
      try {
        const parsedRaw = JSON.parse(rawLinkTrimmed);
        finalConfig = Array.isArray(parsedRaw) ? parsedRaw[0] : parsedRaw;
      } catch (e) {
        console.error("Failed to parse JSON config", e);
        throw new Error("Ошибка формата JSON конфига");
      }

      if (finalConfig && typeof finalConfig === 'object') {
        const sPort = Number(settings.socksPort) || 10808;

        // ВАЖНО: используем конфиг пользователя КАК ЕСТЬ (как Happ).
        // Сохраняем outbounds, balancers, routing, dns, observatory, policy — там
        // маршрутизация по сервисам (Telegram->balancer, Instagram->cand-02,
        // РФ-госсайты->direct и т.д.), которая и заставляет всё работать.
        // Меняем ТОЛЬКО inbounds (под TUN fd) и чистим Android-несовместимый sockopt.

        // Системные секции десктоп-клиента, требующие отдельных inbound'ов, — убираем.
        // (observatory и routing.balancers НЕ трогаем — они нужны балансировщику.)
        delete finalConfig.test;
        delete finalConfig.api;
        delete finalConfig.stats;
        // КРИТИЧНО: убираем metrics (Prometheus-endpoint серверного мониторинга).
        // Если в конфиге есть и metrics, и stats — xray-core паникует при старте:
        // "panic: Reuse of exported var name: stats" (SIGABRT в треде XrayCore,
        // приложение вылетает на Android; «ошибка ядра» на Windows).
        delete finalConfig.metrics;

        // Инбаунды: наш SOCKS (для readiness-пробы) + TUN (fd из coreRunLoopWithTun).
        // НЕ ставить "dns" в destOverride — это невалидный протокол сниффинга.
        finalConfig.inbounds = [
            {
                tag: "socks-in",
                port: sPort,
                listen: "127.0.0.1",
                protocol: "socks",
                settings: { udp: true, auth: "noauth", userLevel: 8 },
                sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], routeOnly: false }
            },
            {
                tag: "tun",
                protocol: "tun",
                // MTU из настроек (по умолчанию 1400, как у VPN-интерфейса в нативном коде): раньше здесь стояло
                // жёсткое 1280 — для готовых конфигов (подписки с балансировщиком) настройка не учитывалась.
                // name ОБЯЗАТЕЛЕН: без него TunConfig.Build() генерирует имя через GetAvailableTunName() →
                // net.Interfaces() → netlink bind, запрещённый SELinux для untrusted_app
                // (netlinkrib: permission denied) — ядро падает на старте. На Android имя берётся из fd.
                settings: { name: "utun10", mtu: Math.min(1500, Math.max(576, Number(load('sim-mtu', '1400')) || 1400)), stack: "gvisor" },
                sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] }
            }
        ];

        // Чистим только Android-несовместимые sockopt-поля (interface/mark).
        // mux, dialerProxy, reality, congestion, flow и пр. — СОХРАНЯЕМ.
        if (!Array.isArray(finalConfig.outbounds)) finalConfig.outbounds = [];
        finalConfig.outbounds.forEach((ob: any) => {
            if (ob?.streamSettings?.sockopt) {
                delete ob.streamSettings.sockopt.interface;
                delete ob.streamSettings.sockopt.mark;
            }
            // mux несовместим с xtls-rprx-vision и через этот форк ломает ВСЕ
            // соединения (gstatic тоже падал). Выключаем mux на всех аутбаундах.
            if (ob && ob.mux) ob.mux = { enabled: false };

            // XHTTP extra: только `uplinkDataPlacement` РОНЯЕТ ядро (access
            // violation при старте xhttp-дайлера в xray 26.5.9).
            // ВСЕ ОСТАЛЬНЫЕ поля (uplinkHTTPMethod, xPaddingMethod, xPaddingObfsMode,
            // xPaddingPlacement и др.) — это легитимные поля Happ/форк-ядра:
            // они определяют CDN-обфускацию WL-аутбаундов (xmux, tokenish-padding).
            // Удаление этих полей ломает WL CDN-транспорт на сетях с DPI-фильтрацией.
            const extra = ob?.streamSettings?.xhttpSettings?.extra;
            if (extra && typeof extra === 'object') {
                delete extra['uplinkDataPlacement'];
            }
        });

        // КРИТИЧНО: Xray отклоняет ВЕСЬ конфиг, если два outbound'а имеют
        // одинаковый tag ("app/proxyman/outbound: existing tag found: <tag>" →
        // ядро не стартует, статус not_running). Пользовательские конфиги и
        // подписки иногда содержат дубль (напр. вендорский и свой сервер оба с
        // тегом "proxy"). Оставляем ПЕРВЫЙ outbound каждого тега, последующие
        // дубли отбрасываем — конфиг становится валидным, маршрутизация по тегам цела.
        {
            const seenTags = new Set<string>();
            const before = finalConfig.outbounds.length;
            finalConfig.outbounds = finalConfig.outbounds.filter((ob: any) => {
                const tag = ob && typeof ob.tag === 'string' ? ob.tag : '';
                if (!tag) return true;                 // без тега — оставляем
                if (seenTags.has(tag)) return false;   // дубликат — выкидываем
                seenTags.add(tag);
                return true;
            });
            if (finalConfig.outbounds.length !== before) {
                console.warn(`Удалены дубликаты outbound-тегов: ${before} → ${finalConfig.outbounds.length}`);
            }
        }

        // Гарантируем системные аутбаунды, если routing на них ссылается, а их нет.
        const ensureOutbound = (tag: string, protocol: string) => {
            if (!finalConfig.outbounds.some((o: any) => o.tag === tag)) {
                finalConfig.outbounds.push({ tag, protocol });
            }
        };
        ensureOutbound("direct", "freedom");
        ensureOutbound("block", "blackhole");
        // dns-out добавляем только для конфигов без балансера (см. логику dns-out ниже).
        // Для конфигов с балансером dns-out добавляется условно после проверки hasBalancerRoute.
        ensureOutbound("dns-out", "dns");

        // DNS: сохраняем пользовательский (умный: DoH + РФ-госдомены). Если нет — дефолт.
        if (!finalConfig.dns || typeof finalConfig.dns !== 'object') {
            finalConfig.dns = { servers: ["1.1.1.1", "8.8.8.8"], queryStrategy: "UseIPv4" };
        }

        // КРИТИЧНО: домены САМИХ серверов (proxy/cand-*) резолвим напрямую через
        // системный DNS (localhost). Иначе DoH из конфига их не резолвит: чтобы сделать
        // DoH-запрос, надо подключиться к серверу, а чтобы подключиться — резолвить его
        // домен = дедлок, всё таймаутит (хотя ядро работает). Приложение исключено из VPN,
        // поэтому системный резолвер сервера ходит напрямую (минуя туннель).
        try {
            const serverDomains: string[] = [];
            (finalConfig.outbounds || []).forEach((ob: any) => {
                (ob?.settings?.vnext || []).forEach((v: any) => { if (v?.address) serverDomains.push(v.address); });
                (ob?.settings?.servers || []).forEach((s: any) => { if (s?.address) serverDomains.push(s.address); });
            });
            const sdRules = serverDomains
                .filter((a) => a && !/^[0-9.]+$/.test(a) && a.indexOf(':') === -1)
                .map((a) => `full:${a}`);
            if (sdRules.length && finalConfig.dns && Array.isArray(finalConfig.dns.servers)) {
                finalConfig.dns.servers.unshift({ address: "localhost", domains: sdRules, skipFallback: true });
            }
        } catch { /* ignore */ }

        // Routing: сохраняем ЦЕЛИКОМ (маршрутизация по сервисам). Гарантируем перехват
        // DNS (port 53 -> dns-out) первым правилом — это критично для конфигов с
        // балансером: без него UDP DNS идёт через балансер как сырые UDP-пакеты,
        // которые xhttp/WS/REALITY аутбаунды не форвардят (нет UDP-поддержки без mux).
        // dns-out обрабатывает DNS внутри xray и резолвит через DoH/прокси правильно.
        if (!finalConfig.routing || !Array.isArray(finalConfig.routing.rules)) {
            finalConfig.routing = {
                rules: [
                    { type: "field", port: 53, outboundTag: "dns-out" },
                    { type: "field", network: "tcp,udp", outboundTag: "proxy" }
                ]
            };
        } else {
            const hasDns = finalConfig.routing.rules.some((r: any) => r && r.outboundTag === "dns-out");
            if (!hasDns) {
                finalConfig.routing.rules.unshift({ type: "field", port: 53, outboundTag: "dns-out" });
            }
        }

        // КРИТИЧНО: снимаем привязку правил к инбаундам автора. Исходный конфиг привязывает
        // catch-all (и маршрут на балансировщик) к inboundTag:["socks","http"] — своим
        // старым инбаундам. Наш трафик идёт из "tun"/"socks-in" → правило НЕ матчится,
        // трафик не маршрутизируется = таймаут ВСЕГО. Снятие привязки чинит это.
        // Теги loopback-аутбаундов при этом сохраняются (см. rebindInboundTags) — на них
        // держится цепочка «балансер → запасной балансер».
        if (finalConfig.routing && Array.isArray(finalConfig.routing.rules)) {
            finalConfig.routing.rules = rebindInboundTags(finalConfig.routing.rules, finalConfig.outbounds);

            // КРИТИЧНО: после снятия inboundTag некоторые правила остаются БЕЗ
            // единого условия сопоставления. Классика — metrics-роут подписок
            // { inboundTag:["metrics_out"], outboundTag:"metrics_out" }: он матчился
            // только по inboundTag, а теперь это пустышка { outboundTag:"metrics_out" }.
            // Xray-core 26.x отвергает ВЕСЬ конфиг на старте:
            // "app/router: this rule has no effective fields" → ядро не стартует
            // (на Windows-десктопе виден как «ошибка запуска ядра»/not_running).
            // Старое ядро на Android такие правила молча игнорирует — поэтому баг
            // проявлялся только на Windows. Выкидываем правила без матчеров.
            const RULE_MATCHERS = ['domain', 'ip', 'port', 'sourcePort', 'network',
                'protocol', 'inboundTag', 'source', 'user', 'attrs'];
            finalConfig.routing.rules = finalConfig.routing.rules.filter((r: any) => {
                if (!r || typeof r !== 'object') return false;
                return RULE_MATCHERS.some((k) => {
                    const v = r[k];
                    return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
                });
            });
        }

        // КРИТИЧНО: в Xray-core 26.x ЛЮБОЙ балансер требует фичу Observatory.
        // Если конфиг содержит routing.balancers, но ни observatory, ни
        // burstObservatory не заданы, ядро падает на старте с
        // "core: not all dependencies are resolved" (статус циклит Running→Closed,
        // SOCKS-порт не открывается → not_running). Поднимаем burstObservatory для
        // всех тегов, на которые ссылаются селекторы балансеров, чтобы зависимость
        // резолвилась и health-пинги питали leastLoad/leastPing-стратегии.
        try {
            const balancers = finalConfig.routing?.balancers;
            if (Array.isArray(balancers) && balancers.length &&
                !finalConfig.observatory && !finalConfig.burstObservatory) {
                const selectors = Array.from(new Set(
                    balancers.flatMap((b: any) => Array.isArray(b?.selector) ? b.selector : [])
                )).filter((s: any) => typeof s === 'string' && s.length);
                finalConfig.burstObservatory = {
                    subjectSelector: selectors.length ? selectors : ['proxy'],
                    pingConfig: {
                        destination: 'http://www.google.com/gen_204',
                        interval: '5m',
                        sampling: 2,
                        timeout: '5s'
                    }
                };
            }
        } catch { /* ignore — без балансера observatory не нужна */ }

        finalConfig.log = { loglevel: "info" };
        delete finalConfig.remarks;
        configJson = JSON.stringify(finalConfig);
      } else {
        throw new Error("JSON config must be an object");
      }
    } else {
      configJson = buildXrayConfig(node, settings, routingProfile);
    }
  } catch (e) {
    // YAML/JSON-разбор упал — строим конфиг напрямую из node
    configJson = buildXrayConfig(node, settings, routingProfile);
  }
  return configJson;
}