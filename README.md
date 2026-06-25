<div align="center">

<img src="public/icon.png" alt="SimProxy" width="96" />

# SimProxy

**Быстрый VPN-клиент на ядре Xray для Android и Windows**  
Обходит DPI и белые списки — там, где другие клиенты не работают

<br/>

[![Android](https://img.shields.io/badge/▼%20Android%20APK-2.4.9-3ddc84?style=for-the-badge&logo=android&logoColor=white)](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.4.9/SimProxy-v2.4.9.apk)
[![Windows Setup](https://img.shields.io/badge/▼%20Windows%20Setup-2.4.9-0078d4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.4.9/SimProxy-Setup-2.4.9.exe)
[![Windows Portable](https://img.shields.io/badge/▼%20Portable%20EXE-2.4.9-6c6c6c?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.4.9/SimProxy-2.4.9-portable.exe)

<br/>

![Android 7+](https://img.shields.io/badge/Android-7.0%2B-3ddc84?style=flat-square&logo=android&logoColor=white)
![Windows 10+](https://img.shields.io/badge/Windows-10%2B-0078d4?style=flat-square&logo=windows&logoColor=white)
![Xray Core](https://img.shields.io/badge/core-Xray-555555?style=flat-square)
![Version](https://img.shields.io/badge/version-2.4.9-00f0ff?style=flat-square)

</div>

---

## О приложении

**SimProxy** — клиент на базе [Xray-core](https://github.com/XTLS/Xray-core) с поддержкой 17+ протоколов. Специально оптимизирован для работы в России и других странах с жёстким DPI: фрагментация TLS ClientHello, шумовой трафик и умная система пресетов позволяют подключаться там, где обычные клиенты показывают -1.

---

## Возможности

### Протоколы
VLESS · VMess · Trojan · Shadowsocks · Hysteria2 · TUIC · WireGuard · REALITY · ShadowTLS · AnyTLS · SOCKS · HTTP · SSH · Brook · Naive · XHTTPv2

### Подписки и серверы
- Импорт по ссылке, QR-коду (камера + галерея), из буфера обмена, из файла `.txt/.json/.yaml`
- Массовая вставка списка серверов
- Deep link `sim://` и `happ://` — открывается прямо из браузера
- **Автоопределение панелей:** Remnawave, Marzban/Marzneshin, 3x-ui, Hiddify
- Авто-обновление подписок по расписанию
- Отображение трафика, даты истечения и статуса подписки

### Обход блокировок
- **Авто-пресет по оператору** — определяет МТС / Мегафон / Теле2 / Ростелеком / Билайн и применяет нужные настройки DPI автоматически при запуске
- **Фрагментация TLS** — разбивает ClientHello на части, обходя DPI и белые списки
- **Шумовой трафик (Noises)** — дополнительная обфускация соединения
- Пресеты: `МТС · Мегафон · Теле2` / `Ростелеком · Дом.ру` / `YouTube / Instagram` / `Максимум`

### Подключение и маршрутизация
- **Авто-выбор лучшего сервера** — пинг всех узлов и подключение к быстрейшему
- **Умная маршрутизация:** Глобально · Обход RU · Только заблокированное · Обход локальных
- **Split-tunnel по приложениям** — выбираешь какие приложения идут через VPN
- Прямой доступ к российским банкам и сервисам (Госуслуги, Сбер, Тинькофф, ВТБ и др.)
- Пользовательские правила маршрутизации (домены, IP, geoIP)
- Блокировка рекламы

### Стабильность
- **Авто-реконнект** при смене сети (Wi-Fi ↔ мобильная)
- **Kill Switch** — блокирует трафик при обрыве VPN
- Watchdog — обнаруживает зависание трафика и переподключается
- **Авто-переключение** на другой сервер при деградации

### Безопасность и диагностика
- Авто-тест IP и DNS-утечек при подключении
- Speed Test — замер реальной скорости через сервер
- Мониторинг качества соединения (задержка, потери, jitter)
- **DoH / Fake DNS** — защита DNS-запросов
- Хосты-маппинг, выбор первичного/резервного DNS

### Интерфейс
- Неоновый тёмный UI с выбором цвета акцента
- Dashboard: графики трафика, история, карта серверов
- Виджет скорости ↑/↓ в шторке уведомлений (Android)
- Русский и английский интерфейс
- Онбординг для новых пользователей

### Данные и экспорт
- Резервная копия всех профилей и настроек одним файлом
- Опциональное шифрование бэкапа (AES-256)
- **Авто-обновление приложения** через GitHub Releases

---

## Установка

### Android
1. Скачайте [`SimProxy-v2.4.9.apk`](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.4.9/SimProxy-v2.4.9.apk)
2. Откройте файл на устройстве → разрешите установку из неизвестных источников
3. Добавьте подписку (ссылка / QR / буфер обмена) и нажмите кнопку подключения

> Требования: Android 7.0+ (API 24), arm64 или arm32

### Windows
| Вариант | Ссылка | Описание |
|---|---|---|
| Установщик | [SimProxy-Setup-2.4.9.exe](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.4.9/SimProxy-Setup-2.4.9.exe) | Устанавливает в профиль пользователя, без прав администратора |
| Portable | [SimProxy-2.4.9-portable.exe](https://github.com/sim-proxy-online/vpn_app/releases/download/v2.4.9/SimProxy-2.4.9-portable.exe) | Запускается без установки |

> Требования: Windows 10+ x64

---

## Deep links

Открываются прямо из браузера (схемы `sim://` и `happ://`):

| Ссылка | Действие |
|---|---|
| `sim://import/<url>` | импорт подписки или сервера |
| `sim://add/<url>` · `sim://subscribe/<url>` | импорт подписки |
| `sim://routing/add/<base64>` | импорт профиля маршрутизации |

Протокольные ссылки `vless://` `vmess://` `trojan://` `ss://` `hysteria2://` `tuic://` `wireguard://` — вставляются из буфера обмена.

---

## Сборка из исходников

**Android:**
```bash
npm install
npm run build                          # Vite → dist/index.html
cd android && ./gradlew assembleRelease
# APK: android/app/build/outputs/apk/release/app-release.apk
```

**Windows:**
```powershell
npm install
npm run electron:build
# Артефакты: desktop/dist-exe/
```

**Стек:** React 19 + Vite + TailwindCSS + Capacitor (Android) · Electron (Windows) · Xray-core · Mihomo (Clash.Meta) · tun2socks

---

## Дисклеймер

Приложение предназначено для законного использования: приватность, доступ к сервисам и обход цензуры там, где это разрешено. Подписку на прокси-серверы пользователь предоставляет самостоятельно.
