<img width="1920" height="1200" alt="Screenshot_20260603-183232" src="https://github.com/user-attachments/assets/bf0a6bca-d6b7-4833-994d-dd340329c796" />
<div align="center">

# SimProxy

**Быстрый VPN/прокси-клиент на ядре Xray. Обходит белые списки и DPI в один тап.**

[![Скачать APK](https://img.shields.io/badge/Скачать%20APK-v2.4.1-00f0ff?style=for-the-badge&logo=android&logoColor=white)](https://github.com/sim-proxy-online/vpn_app/releases/latest/download/SimProxy-v2.4.1.apk)
[![Releases](https://img.shields.io/github/v/release/sim-proxy-online/vpn_app?style=for-the-badge&label=Releases&color=7c3aed)](https://github.com/sim-proxy-online/vpn_app/releases)
![Android](https://img.shields.io/badge/Android-7.0%2B-3ddc84?style=for-the-badge&logo=android&logoColor=white)
![Xray](https://img.shields.io/badge/core-Xray-555?style=for-the-badge)

</div>

---

## О приложении

SimProxy — Android-клиент на базе **Xray-core** с неоновым интерфейсом, ориентированный на работу в условиях DPI и белых списков мобильных операторов. Реальная проверка серверов через Proxy GET (как в Happ) и фрагментация TLS позволяют подключаться там, где обычные клиенты «не пингуются и не работают».

## Возможности

- **17+ протоколов:** VLESS, VMess, Trojan, Shadowsocks, Hysteria/Hysteria2, TUIC, WireGuard, REALITY, ShadowTLS, AnyTLS и др.
- **Импорт подписок:** по ссылке, QR-коду (камера **и из галереи**), из буфера обмена, **массовой вставкой списка**, **из файла** (.txt/.json/.yaml) и по deep link `sim://` прямо из браузера.
- **Автоопределение панелей:** Remnawave, Marzban/Marzneshin, 3x-ui, Hiddify.
- **Авто-выбор лучшего сервера:** «Подключить быстрейший» — пинг всех узлов и выбор минимальной задержки; **избранные** серверы ⭐.
- **Обход блокировок:** фрагментация TLS, шумовой трафик, пресет «YouTube Fix».
- **Профили-сценарии:** Сбалансированный · Стриминг · Игры · Макс. приватность — пресеты DPI/DNS/маршрутизации в один тап.
- **Умная маршрутизация:** глобально / обход RU / только заблокированное / split-tunnel по приложениям (поиск, иконки, фильтр польз./систем., массовые действия) + свои правила.
- **DNS:** DoH (Cloudflare, Google, AdGuard, Quad9), Fake DNS, защита от утечек.
- **Стабильность:** **авто-реконнект** при смене сети (Wi-Fi ↔ моб.), Kill Switch, виджет **скорости ↑/↓ в шторке уведомлений**.
- **Безопасность и диагностика:** **авто-тест IP/DNS-утечек** при подключении, Speed Test, мониторинг качества и трафика.
- **Резервные копии:** экспорт/импорт всех профилей и настроек одним файлом, опционально с шифрованием паролем (AES-256).
- **Локализация:** русский и английский интерфейс.
- **Авто-обновление:** проверка новых версий через [GitHub Releases](https://github.com/sim-proxy-online/vpn_app/releases).
- **Кастомизация:** выбор цвета акцента (перекрашивает весь интерфейс) + онбординг для новичков.

## Установка

1. Скачайте [`SimProxy-v2.4.1.apk`](https://github.com/sim-proxy-online/vpn_app/releases/latest/download/SimProxy-v2.4.1.apk) или перейдите на страницу [**Releases**](https://github.com/sim-proxy-online/vpn_app/releases/latest).
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

Windows (PowerShell):

```powershell
npm install
npm run build                          # сборка веб-части (Vite)
node android/prepare-android.cjs       # копирование ассетов в Android-проект
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
./android/gradlew.bat -p ./android assembleRelease --no-daemon
```

APK появится в `android/app/build/outputs/apk/release/app-release.apk`.

**Стек:** React 19 + Vite + TailwindCSS (WebView через Capacitor) · Xray-core (libxray) · tun2socks.

## Дисклеймер

Приложение предназначено для законного использования: приватность, доступ к сервисам и обход цензуры там, где это разрешено. Подписку на прокси-серверы пользователь предоставляет сам.
