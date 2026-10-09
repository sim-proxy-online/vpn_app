# Сторонние компоненты

Нативные части приложения собраны из открытых проектов. Исходники этих проектов доступны по
ссылкам ниже; в приложении нет закрытых библиотек сторонних приложений.

| Компонент | Версия | Лицензия | Где используется |
|---|---|---|---|
| [Xray-core](https://github.com/XTLS/Xray-core) | 26.3.27 | MPL-2.0 | `libgojni.so` (через обёртку `android/simcore`) |
| [gVisor](https://github.com/google/gvisor) (netstack) | из зависимостей Xray | Apache-2.0 | внутри Xray (TUN-режим) |
| [hev-socks5-tunnel](https://github.com/heiher/hev-socks5-tunnel) | 2.18.0 | MIT | `libhev-socks5-tunnel.so` (мост TUN → SOCKS5) |
| [mihomo](https://github.com/MetaCubeX/mihomo) | см. сборку | GPL-3.0 (уточнить для используемой версии) | `libmihomo.so`, запускается отдельным процессом |
| [gomobile](https://pkg.go.dev/golang.org/x/mobile) | — | BSD-3-Clause | сгенерированный код привязки `go.Seq`, `com.simproxy.simcore` |
| Geo-данные (geoip.dat, geosite.dat) | Loyalsoldier/v2ray-rules-dat | см. репозиторий источника | правила маршрутизации |

Собственный код обёртки (`android/simcore`) использует только публичный API xray-core.

## Что нужно сделать перед публикацией

- Показать список лицензий в приложении (экран «О программе» / «Лицензии»).
- Для mihomo (GPL-3.0): положить текст лицензии и ссылку на исходники нужной версии.
- Для Xray-core (MPL-2.0): сохранить ссылку на исходники используемой версии (см. таблицу).
