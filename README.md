<img width="1920" height="1200" alt="Screenshot_20260603-183232" src="https://github.com/user-attachments/assets/bf0a6bca-d6b7-4833-994d-dd340329c796" />
<div align="center">

# SimProxy

**Быстрый VPN/прокси-клиент на ядре Xray. Обходит белые списки и DPI в один тап.**

[![Версия](https://img.shields.io/github/v/release/sim-proxy-online/vpn_app?style=for-the-badge&label=Версия&color=7c3aed)](https://github.com/sim-proxy-online/vpn_app/releases)
![Android](https://img.shields.io/badge/Android-7.0%2B-3ddc84?style=for-the-badge&logo=android&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-10%2F11%20x64-0078d4?style=for-the-badge&logo=windows&logoColor=white)
![Xray](https://img.shields.io/badge/core-Xray-555?style=for-the-badge)

</div>

---

## ⬇️ Скачать

<div align="center">

| Платформа | Вариант | |
|:---:|:---:|:---:|
| 🤖 **Android** <br><sub>7.0+ · arm64-v8a · armeabi-v7a</sub> | APK | [![](https://img.shields.io/badge/Скачать%20APK-v2.4.3-00f0ff?style=for-the-badge&logo=android&logoColor=black)](https://github.com/sim-proxy-online/vpn_app/releases/latest/download/SimProxy-v2.4.3.apk) |
| 🖥️ **Windows** <br><sub>10 / 11 · x64</sub> | Installer <sub>+ авто-обновление</sub> | [![](https://img.shields.io/badge/Installer-.exe-0078d4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/sim-proxy-online/vpn_app/releases/latest/download/SimProxy-Setup-2.4.3.exe) |

</div>

<div align="center">

[📋 Все релизы и changelog](https://github.com/sim-proxy-online/vpn_app/releases)

</div>

> **Android:** откройте APK → разрешите установку из неизвестных источников → добавьте подписку → подключайтесь.  
> **Windows Portable:** запустите `.exe` напрямую, без установки. **Installer:** устанавливается в систему, обновляется автоматически.

---

## О приложении

SimProxy — Android-клиент на базе **Xray-core** с неоновым интерфейсом, ориентированный на работу в условиях DPI и белых списков мобильных операторов. Реальная проверка серверов через Proxy GET и фрагментация TLS позволяют подключаться там, где обычные клиенты «не пингуются и не работают».

## Возможности

- **17+ протоколов:** VLESS, VMess, Trojan, Shadowsocks, Hysteria/Hysteria2, TUIC, WireGuard, REALITY, ShadowTLS, AnyTLS и др.
- **Импорт подписок:** по ссылке, QR-коду (камера **и из галереи**), из буфера обмена, **массовой вставкой списка**, **из файла** (.txt/.json/.yaml) и по deep link `sim://` прямо из браузера.
- **Автоопределение панелей:** Remnawave, Marzban/Marzneshin, 3x-ui, Hiddify.
- **Авто-выбор лучшего сервера:** «Подключить быстрейший» — пинг всех узлов и выбор минимальной задержки.
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

## Deep links

Открываются прямо из браузера (схемы `sim://` и `happ://`):

| Ссылка | Действие |
|---|---|
| `sim://import/<ссылка>` | импорт подписки или одиночного сервера |
| `sim://add/<url>` · `sim://subscribe/<url>` | импорт подписки |
| `sim://routing/add/<base64>` | импорт профиля маршрутизации |

Протокольные ссылки (`vless://`, `vmess://`, `trojan://`, `ss://`, `hysteria2://`, `tuic://`, `wireguard://`) импортируются вставкой из буфера обмена.

## Дисклеймер

Приложение предназначено для законного использования: приватность, доступ к сервисам и обход цензуры там, где это разрешено. Подписку на прокси-серверы пользователь предоставляет сам.
