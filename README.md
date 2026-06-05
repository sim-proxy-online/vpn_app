<div align="center">

<img src="https://github.com/user-attachments/assets/a428227b-ffe4-4b2e-b4b5-7c6ef7ee34e6" alt="SimProxy" width="100%"/>

# SimProxy

**Быстрый VPN/прокси-клиент на ядре Xray. Обходит блокировки и DPI в один тап.**

[![Android](https://img.shields.io/badge/Android-7.0%2B-3DDC84?logo=android&logoColor=white)](https://github.com/sim-proxy-online/vpn_app/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows&logoColor=white)](https://github.com/sim-proxy-online/vpn_app/releases/latest)
[![Release](https://img.shields.io/github/v/release/sim-proxy-online/vpn_app?color=b000ff&label=версия)](https://github.com/sim-proxy-online/vpn_app/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/sim-proxy-online/vpn_app/total?color=00ff88&label=скачиваний)](https://github.com/sim-proxy-online/vpn_app/releases)

</div>

---

## Скачать

<div align="center">

| Платформа | Установщик | Portable |
|:---:|:---:|:---:|
| 🤖 **Android** | [**SimProxy-v2.2.7.apk**](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.2.7/SimProxy-v2.2.7.apk) | — |
| 🪟 **Windows** | [**SimProxy-Setup-2.2.7.exe**](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.2.7/SimProxy-Setup-2.2.7.exe) | [Portable](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.2.7/SimProxy-2.2.7-portable.exe) |

> Android 7.0+ (arm64 / arm32) · Windows 10/11 x64

</div>

---

## Возможности

- **Протоколы** — VLESS, VMess, Trojan, Shadowsocks, WireGuard, SOCKS, HTTP и др.
- **Транспорты** — TCP, WebSocket, gRPC, xHTTP, HTTPUpgrade, QUIC
- **Обход DPI** — REALITY, TLS fragment, noises — работает на белых списках РФ
- **Подписки** — автообновление, поддержка HWID-locked провайдеров (ShalbanVPN и др.)
- **Раздельное туннелирование** — российские сервисы (банки, Госуслуги, Яндекс) напрямую
- **Умный пинг** — bypass-замер через fragment/REALITY-цепочку при выключенном VPN, last-known кэш
- **Windows** — системный прокси WinINET, авто-обновление, neon-интерфейс

---

## Что нового — v2.2.7

- **Bypass-пинг** — при выключенном VPN замеряет латентность через fragment/REALITY как Happ. Работает на DPI-сетях
- **Last-known кэш** — на строгом глушении показывает последний реальный пинг bypass-серверов вместо прочерков
- **Не-bypass сервера** — корректно показывают прочерк, а не ложные данные
- **Fast-path** — при повторном открытии списка пинги появляются мгновенно из кэша
- **Windows** — реализован тот же bypass-пинг через xray.exe с fragment-конфигом

<details>
<summary>История изменений</summary>

### v2.2.6
- Фикс глюков интерфейса (GPU BAD ALLOC при загрузке иконок)
- Фикс VPN в режиме split tunneling — петля трафика
- Пинг серверов через временное Xray-ядро с REALITY/fragment
- Раздельное туннелирование российских приложений
- Убрано уведомление AntiFilter Service

### v2.2.4
- Редизайн главного экрана: Status Card при подключении
- Свайп-карусель выбора сервера с флагами и протоколами
- Список серверов: цветная полоска протокола на карточках

### v2.2.3
- Фикс краша Windows при открытии «Управление трафиком»
- Защита от падений интерфейса — ошибка в одном разделе не роняет приложение

</details>

---

<div align="center">

[Все релизы](https://github.com/sim-proxy-online/vpn_app/releases) · [Сообщить о проблеме](https://github.com/sim-proxy-online/vpn_app/issues)

</div>