# SimProxy v2.2.1 — Android + Windows

**Быстрый VPN/прокси-клиент на ядре Xray. Обходит белые списки и DPI в один тап.**
Теперь не только на Android, но и на **Windows** — с тем же неоновым интерфейсом.

## 📦 Загрузки

| Платформа | Файл | Требования |
|---|---|---|
| 🤖 **Android** | [`SimProxy-v2.2.1.apk`](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.2.1/SimProxy-v2.2.1.apk) | Android 7.0+ (API 24), arm64-v8a / armeabi-v7a |
| 🪟 **Windows** | [`SimProxy-2.2.1.exe`](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.2.1/SimProxy-Setup-2.2.1.exe) | Windows 10/11 x64 |

---
## 🆕 Изменения в v2.2.1 (паритет Windows ↔ Android)

- **Таймер подключения в свёрнутом окне (Windows).** Отключён фоновый троттлинг Chromium — счётчик времени идёт непрерывно, даже когда окно свёрнуто.
- **Мультиядро для всех протоколов (Windows).** Десктоп-мост доверяет явному выбору ядра: hysteria / hysteria2 / tuic / anytls / shadowtls / naive уходят на mihomo, остальные — на xray.
- **Рамка карточки сервера повторяет цвет большой кнопки** на главном экране (подключено — зелёный, проверка — жёлтый, переподключение — фиолетовый).

> Windows также доступен установщиком [`SimProxy-2.2.1.exe`](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.2.1/SimProxy-Setup-2.2.1.exe) (помимо портативной версии).

## 🆕 Что нового

### 🪟 Windows-версия (десктоп)
- Полноценный клиент на **Xray-core** в портативном `.exe` — запуск без установки.
- **Профиль и список серверов прямо на главной**: слева активная подписка с трафиком и серверами, справа — большая кнопка подключения.
- **Авто-пинг всех серверов при запуске** — сразу видно лучшие узлы.
- Закреплённый интерфейс: карточка профиля и кнопка подключения зафиксированы, прокручивается только список серверов.
- Широкое окно по умолчанию — десктоп-раскладка сразу, без подгонки размеров.
- Системное контекстное меню и горячие клавиши (копировать/вставить), авто-очистка системного прокси при выходе.

### 🤖 Android
- **Авто-обновление приложения** — теперь APK скачивается и ставится прямо в приложении: при выходе новой версии появляется окно «Доступно обновление» с прогрессом загрузки и запуском установки в один тап (разрешение «Установка неизвестных приложений» запрашивается один раз).
- Стабильный пинг и подключение через Proxy GET (как в Happ) даже на белых списках операторов.

---

## ✨ Возможности (обе платформы)

- **17+ протоколов:** VLESS, VMess, Trojan, Shadowsocks, Hysteria/Hysteria2, TUIC, WireGuard, REALITY, ShadowTLS, AnyTLS и др.
- **Импорт подписок:** по ссылке, QR-коду, из буфера, массовой вставкой, из файла (.txt/.json/.yaml), deep link `sim://`.
- **Автоопределение панелей:** Remnawave, Marzban/Marzneshin, 3x-ui, Hiddify.
- **Авто-выбор лучшего сервера** + избранные ⭐, реальная проверка пинга всех узлов.
- **Обход блокировок:** фрагментация TLS, шумовой трафик, пресет «YouTube Fix».
- **Профили-сценарии:** Сбалансированный · Стриминг · Игры · Макс. приватность.
- **Умная маршрутизация:** глобально / обход RU / только заблокированное / split-tunnel + свои правила.
- **DNS:** DoH (Cloudflare, Google, AdGuard, Quad9), Fake DNS, защита от утечек.
- **Стабильность:** авто-реконнект при смене сети, Kill Switch, виджет скорости в шторке (Android).
- **Безопасность:** авто-тест IP/DNS-утечек, Speed Test, мониторинг качества и трафика.
- **Резервные копии:** экспорт/импорт профилей и настроек (опц. AES-256).
- **Локализация:** русский и английский.

---

## 🚀 Установка

**Android:**
1. Скачайте [`SimProxy-v2.2.1.apk`](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.2.1/SimProxy-v2.2.1.apk).
2. Откройте на устройстве → разрешите установку из неизвестных источников.
3. Добавьте подписку (ссылка / QR / буфер) и нажмите подключение.

**Windows:**
1. Скачайте [`SimProxy-2.2.1.exe`](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.2.1/SimProxy-Setup-2.2.1.exe).
2. Запустите двойным кликом — установка не нужна.
3. Профили → добавьте подписку → выберите сервер → подключитесь.

> ⚠️ **Windows SmartScreen:** exe без цифровой подписи, при первом запуске Windows может показать предупреждение — нажмите «Подробнее → Выполнить в любом случае».

---

## ⚖️ Дисклеймер

Приложение предназначено для законного использования: приватность, доступ к сервисам и обход цензуры там, где это разрешено. Подписку на прокси-серверы пользователь предоставляет сам.

<br>

---
---

<br>

# SimProxy — Android + Windows (English)

**Fast VPN/proxy client powered by Xray. Bypasses operator whitelists and DPI in one tap.**
Now on **Windows** too — with the same neon interface.

## 📦 Downloads

| Platform | File | Requirements |
|---|---|---|
| 🤖 **Android** | [`SimProxy-v2.2.1.apk`](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.2.1/SimProxy-v2.2.1.apk) | Android 7.0+ (API 24), arm64-v8a / armeabi-v7a |
| 🪟 **Windows** | [`SimProxy-2.2.1.exe`](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.2.1/SimProxy-Setup-2.2.1.exe) | Windows 10/11 x64 |

---

## 🆕 What's new

### 🪟 Windows build (desktop)
- Full **Xray-core** client in a portable `.exe` — runs without installation.
- **Profile and server list right on the Home screen**: active subscription with traffic and servers on the left, the big connect button on the right.
- **Auto-ping of all servers on launch** — best nodes are visible immediately.
- Pinned interface: the profile card and the connect button stay fixed; only the server list scrolls.
- Wide default window — desktop layout right away, no manual resizing.
- Native context menu and shortcuts (copy/paste), automatic system-proxy cleanup on exit.

### 🤖 Android
- **In-app auto-update** — the APK is now downloaded and installed right inside the app: when a new version ships, an "Update available" dialog shows download progress and launches the install in one tap (the "install unknown apps" permission is requested once).
- Reliable ping and connection via Proxy GET (Happ-style), even on carrier whitelists.

---

## ✨ Features (both platforms)

- **17+ protocols:** VLESS, VMess, Trojan, Shadowsocks, Hysteria/Hysteria2, TUIC, WireGuard, REALITY, ShadowTLS, AnyTLS and more.
- **Subscription import:** by link, QR code, clipboard, bulk paste, from file (.txt/.json/.yaml), `sim://` deep links.
- **Panel auto-detection:** Remnawave, Marzban/Marzneshin, 3x-ui, Hiddify.
- **Best-server auto-pick** + favorites ⭐, real ping test of every node.
- **Censorship bypass:** TLS fragmentation, noise traffic, "YouTube Fix" preset.
- **Scenario profiles:** Balanced · Streaming · Gaming · Max privacy.
- **Smart routing:** global / bypass RU / blocked-only / per-app split tunnel + custom rules.
- **DNS:** DoH (Cloudflare, Google, AdGuard, Quad9), Fake DNS, leak protection.
- **Stability:** auto-reconnect on network change, Kill Switch, speed widget in the notification shade (Android).
- **Security:** automatic IP/DNS leak test, Speed Test, quality & traffic monitoring.
- **Backups:** export/import of all profiles and settings (optional AES-256).
- **Localization:** Russian and English.

---

## 🚀 Installation

**Android:**
1. Download [`SimProxy-v2.2.1.apk`](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.2.1/SimProxy-v2.2.1.apk).
2. Open it on your device → allow installation from unknown sources.
3. Add a subscription (link / QR / clipboard) and tap connect.

**Windows:**
1. Download [`SimProxy-2.2.1.exe`](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.2.1/SimProxy-Setup-2.2.1.exe).
2. Run it by double-click — no installation needed.
3. Profiles → add a subscription → pick a server → connect.

> ⚠️ **Windows SmartScreen:** the exe is unsigned, so Windows may warn on first launch — click "More info → Run anyway".

---

## ⚖️ Disclaimer

This app is intended for lawful use: privacy, access to services, and circumventing censorship where permitted. Proxy server subscriptions are provided by the user.

