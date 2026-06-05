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

### 🤖 Android

<a href="https://github.com/sim-proxy-online/vpn_app/releases/download/v2.3.0/SimProxy-v2.3.0.apk">
  <img src="https://img.shields.io/badge/↓%20SimProxy--v2.3.0.apk-3DDC84?style=for-the-badge&logo=android&logoColor=white" alt="Скачать APK"/>
</a>

> Android 7.0+ · arm64-v8a · armeabi-v7a

### 🪟 Windows

<a href="https://github.com/sim-proxy-online/vpn_app/releases/download/v2.3.0/SimProxy-Setup-2.3.0.exe">
  <img src="https://img.shields.io/badge/↓%20SimProxy--Setup--2.3.0.exe-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Установщик Windows"/>
</a>
&nbsp;
<a href="https://github.com/sim-proxy-online/vpn_app/releases/download/v2.3.0/SimProxy-2.3.0-portable.exe">
  <img src="https://img.shields.io/badge/Portable-.exe-555555?style=for-the-badge&logo=windows&logoColor=white" alt="Portable Windows"/>
</a>

> Windows 10/11 · x64

</div>

---

## Возможности

- **Протоколы** — VLESS, VMess, Trojan, Shadowsocks, WireGuard, SOCKS, HTTP и др.
- **Транспорты** — TCP, WebSocket, gRPC, xHTTP, HTTPUpgrade, QUIC
- **Обход DPI** — REALITY, TLS fragment, noises — работает на белых списках РФ
- **Подписки** — автообновление, поддержка HWID-locked, любых провайдеров
- **Раздельное туннелирование** — российские сервисы (банки, Госуслуги, Яндекс) напрямую
- **Умный пинг** — bypass-замер через fragment/REALITY-цепочку при выключенном VPN, last-known кэш
- **Windows** — системный прокси WinINET, авто-обновление, neon-интерфейс

---

## Что нового — v2.3.0

### Экран настроек — полный редизайн
- **Навигационный список** вместо аккордиона — разделы как карточки с иконкой, подписью и стрелкой `>`
- **Статус-бар** вверху: Прокси и DPI с живыми индикаторами
- **Бейджи** `Вкл.` на активных разделах (Управление трафиком, Обход блокировок)
- **Жест назад** — закрывает раздел настроек, а не выбрасывает на главный экран

### Пинг при глушении
- На **stateful DPI** — показывает bypass-кэш из прошлых подключений (как Happ)
- На **мягком DPI** — живой bypass-тест через fragment/REALITY
- Bypass-кэш v2: только из реальных подключений, TCP-пинги с WiFi больше не ложно показываются

---

## Установка Android

1. Скачать APK по кнопке выше
2. Разрешить установку из неизвестных источников
3. Установить и открыть SimProxy
4. Добавить сервер или вставить ссылку подписки

---

## Поддерживаемые форматы

```
vless://  vmess://  trojan://  ss://
hysteria2://  tuic://  wireguard://
Ссылки подписок (base64, JSON, YAML, Clash)
```

---

<div align="center">
<sub>© 2026 SimProxy · <a href="https://sim-proxy.online">sim-proxy.online</a></sub>
</div>
