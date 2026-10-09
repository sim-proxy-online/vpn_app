# Сторонние компоненты

Нативные части приложения собраны из открытых проектов. В приложении нет закрытых библиотек
сторонних приложений. Тот же список показывается в приложении: Настройки → «О приложении» →
«Лицензии и открытый код» (источник: `src/utils/thirdPartyLicenses.ts`).

Лицензии сверены с репозиториями-источниками (GitHub API и файл `LICENSE` на нужной ревизии).

## Нативные компоненты

| Компонент | Версия / ревизия | Лицензия | Где |
|---|---|---|---|
| [Xray-core](https://github.com/XTLS/Xray-core) | 26.3.27 | MPL-2.0 | Android: `libgojni.so` через `android/simcore`; Windows: `xray.exe`; iOS: через libXray |
| [mihomo](https://github.com/MetaCubeX/mihomo) | Android `88dcbf7f`, Windows `90b1066e` (ветка `Meta`) | **GPL-3.0** | Android: `libmihomo.so`; Windows: `mihomo.exe` (отдельный процесс) |
| [hev-socks5-tunnel](https://github.com/heiher/hev-socks5-tunnel) | 2.18.0 | MIT | Android: мост TUN → SOCKS5 |
| [gVisor](https://github.com/google/gvisor) | из зависимостей | Apache-2.0 | netstack внутри Xray и mihomo |
| [libXray](https://github.com/XTLS/libXray) | через SwiftyXrayKit | MIT | iOS |
| [SwiftyXrayKit](https://github.com/dima-u/SwiftyXrayKit) | ≥ 2.0.0 | Apache-2.0 | iOS |
| [Capacitor](https://github.com/ionic-team/capacitor) | 8.x | MIT | Android, iOS |
| [Electron](https://github.com/electron/electron) | 32 | MIT | Windows |

## Веб-часть и ресурсы

React (MIT), Framer Motion (MIT), Lucide (ISC), qrcode.react (ISC), flag-icons (MIT),
шрифты Inter и Orbitron (SIL OFL 1.1), geoip.dat / geosite.dat из
[Loyalsoldier/v2ray-rules-dat](https://github.com/Loyalsoldier/v2ray-rules-dat) (GPL-3.0).

## Что обязательно сделать при распространении

### mihomo (GPL-3.0)

Обе ревизии, которые мы поставляем, взяты из ветки `Meta` апстрима, где файл `LICENSE` — GPL-3.0
(в ветке `main` лицензия MIT, но поставляемые сборки собраны не из неё).

Информация о сборке (`go version -m`) показывает признак `vcs.modified=true`, то есть бинарники
собраны из рабочей копии **с локальными изменениями**. Для GPL-3.0 это означает:

1. Передавать пользователю текст лицензии (есть в приложении, ссылка и текст — в `LICENSE`
   апстрима).
2. Предоставлять по запросу **полный исходный код именно поставляемой сборки**, включая наши
   изменения (GPLv3 §6). Для этого нужно сохранить diff относительно ревизий `88dcbf7f` и
   `90b1066e` в приватном репозитории (или опубликовать).
3. Либо пересобрать mihomo из чистой ревизии без изменений — тогда достаточно ссылки на апстрим.

Отдельный запуск mihomo как процесса не делает всё приложение производным произведением, но
требования к самому mihomo при распространении бинарника остаются.

### Xray-core (MPL-2.0)

Сохранять уведомления об авторских правах и давать ссылку на исходники использованной версии
(таблица выше). Наша обёртка `android/simcore` — отдельные файлы и использует публичный API.

### geoip.dat / geosite.dat

Данные из Loyalsoldier/v2ray-rules-dat распространяются на условиях лицензии репозитория-источника
(GPL-3.0): указана ссылка на источник; при распространении в составе приложения нужно давать
ссылку на него.

## Открытые вопросы

- `xray.exe` собран из исходников xray-core (`(devel)`, go1.26.3, без `vcs`-информации), точная
  ревизия не записана. Лучше фиксировать версию при сборке (`-ldflags "-X ..."` либо `vcs`).
- Где взяты шрифты и флаги (по именам файлов это flag-icons, Inter, Orbitron) — подтвердить
  в `public/` и положить файлы лицензий рядом.
