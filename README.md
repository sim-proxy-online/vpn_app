<div align="center">

# SimProxy

**Быстрый VPN/прокси-клиент на ядре Xray. Обходит белые списки и DPI в один тап.**

[![Скачать APK](https://img.shields.io/badge/Скачать-APK-00f0ff?style=for-the-badge&logo=android)](../../releases/latest)
![Android](https://img.shields.io/badge/Android-7.0%2B-3ddc84?style=for-the-badge&logo=android&logoColor=white)
![Xray](https://img.shields.io/badge/core-Xray-555?style=for-the-badge)

</div>

---

## О приложении

SimProxy — Android-клиент на базе **Xray-core** с неоновым интерфейсом, ориентированный на работу в условиях DPI и белых списков мобильных операторов. Реальная проверка серверов через Proxy GET (как в Happ) и фрагментация TLS позволяют подключаться там, где обычные клиенты «не пингуются и не работают».

## Возможности

- **17+ протоколов:** VLESS, VMess, Trojan, Shadowsocks, Hysteria/Hysteria2, TUIC, WireGuard, REALITY, ShadowTLS, AnyTLS и др.
- **Импорт подписок:** по ссылке, QR-коду, из буфера обмена и по deep link `sim://` прямо из браузера.
- **Автоопределение панелей:** Remnawave, Marzban/Marzneshin, 3x-ui, Hiddify.
- **Обход блокировок:** фрагментация TLS, шумовой трафик, пресет «YouTube Fix».
- **Умная маршрутизация:** глобально / обход RU / только заблокированное / split-tunnel по приложениям + свои правила.
- **DNS:** DoH (Cloudflare, Google, AdGuard, Quad9), Fake DNS, защита от утечек.
- **Безопасность и диагностика:** Kill Switch, тесты IP/DNS-leak, Speed Test, мониторинг качества и трафика.
- **Кастомизация:** выбор цвета акцента (перекрашивает весь интерфейс).

## Установка

1. Скачайте `SimProxy-vX.Y.Z.apk` со страницы [**Releases**](../../releases/latest).
2. Откройте файл на Android → разрешите установку из неизвестных источников.
3. Добавьте подписку (ссылка / QR / буфер) и нажмите кнопку подключения.

> Android 7.0+ (API 24), arm64-v8a и armeabi-v7a.

## Deep links

Открываются прямо из браузера (схемы `sim://` и `happ://`):

| Ссылка | Действие |
|---|---|
| `sim://import/<ссылка>` | импорт подписки или одиночного сервера |
| `sim://add/<url>` · `sim://subscribe/<url>` | импорт подписки |
| `sim://routing/add/<base64>` | импорт профиля маршрутизации |

Протокольные ссылки (`vless://`, `vmess://`, `trojan://`, `ss://`, `hysteria2://`, `tuic://`, `wireguard://`) импортируются вставкой из буфера обмена.

## Сборка из исходников

```bash
npm install
node build_apk.cjs   # vite build → prepare-android → gradle assembleRelease
```

APK появится в `android/app/build/outputs/apk/release/app-release.apk`.

**Стек:** React 19 + Vite + TailwindCSS (WebView через Capacitor) · Xray-core (libxray) · tun2socks.

## Дисклеймер

Приложение предназначено для законного использования: приватность, доступ к сервисам и обход цензуры там, где это разрешено. Подписку на прокси-серверы пользователь предоставляет сам.
