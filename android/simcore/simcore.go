// Package simcore — собственная тонкая обёртка над xray-core для Android.
//
// Собирается через gomobile bind в AAR (Java-пакет com.simproxy.simcore) и заменяет
// закрытую сторонюю обёртку. Использует только публичный API xray-core (MPL-2.0):
//   - core.New / Instance.Start / Instance.Close — запуск и остановка ядра;
//   - переменная окружения xray.tun.fd — встроенный TUN-инбаунд xray на Android;
//   - internet.RegisterDialerController — защита сокетов через VpnService.protect().
package simcore

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/platform"
	"github.com/xtls/xray-core/common/xudp"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/infra/conf/serial"
	"github.com/xtls/xray-core/transport/internet"

	// Подключаем все прокси/транспорты/приложения xray (как в штатном дистрибутиве).
	_ "github.com/xtls/xray-core/main/distro/all"
)

// WrapperVersion — версия самой обёртки (не путать с версией xray-core).
const WrapperVersion = "simcore-1.0.0"

// Protector реализуется на стороне Java и вызывает VpnService.protect(fd):
// сокеты ядра к VPN-серверу не должны попадать обратно в туннель.
type Protector interface {
	Protect(fd int32) bool
}

// Listener получает события жизненного цикла ядра (для журнала приложения).
type Listener interface {
	OnStatus(code int64, message string)
}

// Коды событий для Listener.OnStatus.
const (
	StatusStarting int64 = 1
	StatusStarted  int64 = 2
	StatusStopped  int64 = 3
	StatusError    int64 = 4
)

var (
	mu        sync.Mutex
	protector Protector
	setupOnce sync.Once
)

// Fallback-DNS для самой обёртки: на Android у Go нет /etc/resolv.conf, поэтому
// стандартный резолвер пытается 127.0.0.1:53 и [::1]:53 и не работает.
var fallbackDNS = []string{"77.88.8.8:53", "1.1.1.1:53", "8.8.8.8:53"}

// CoreVersion возвращает версию xray-core.
func CoreVersion() string { return core.Version() }

// Version возвращает версию обёртки.
func Version() string { return WrapperVersion }

// SetProtector задаёт обработчик защиты сокетов (VpnService.protect).
func SetProtector(p Protector) {
	mu.Lock()
	protector = p
	mu.Unlock()
}

// InitEnv настраивает окружение ядра. Вызывать один раз при старте приложения.
//
//	assetDir — каталог с geoip.dat / geosite.dat;
//	xudpKey  — 32 байта в base64url без заполнения (43 символа) либо пустая строка.
//
// Ключ XUDP ставится напрямую в переменную пакета, а не через env: в xray-core его
// читают из env с задержкой 100 мс, и при неверном значении ядро паникует.
func InitEnv(assetDir string, xudpKey string) error {
	if assetDir != "" {
		if err := os.Setenv(platform.NormalizeEnvName(platform.AssetLocation), assetDir); err != nil {
			return err
		}
	}
	if xudpKey != "" {
		raw, err := base64.RawURLEncoding.DecodeString(xudpKey)
		if err != nil || len(raw) != 32 {
			return fmt.Errorf("xudp key: нужно 32 байта в base64url без заполнения")
		}
		xudp.BaseKey = raw
	}
	setupOnce.Do(setup)
	return nil
}

// setup регистрирует защиту сокетов и безопасный DNS-резолвер (один раз на процесс).
func setup() {
	_ = internet.RegisterDialerController(func(network, address string, c syscall.RawConn) error {
		return protectConn(c)
	})
	_ = internet.RegisterListenerController(func(network, address string, c syscall.RawConn) error {
		return protectConn(c)
	})

	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var lastErr error
			for _, server := range fallbackDNS {
				d := net.Dialer{
					Timeout: 3 * time.Second,
					Control: func(_, _ string, c syscall.RawConn) error { return protectConn(c) },
				}
				conn, err := d.DialContext(ctx, network, server)
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, lastErr
		},
	}
}

func protectConn(c syscall.RawConn) error {
	mu.Lock()
	p := protector
	mu.Unlock()
	if p == nil {
		return nil
	}
	var ok bool
	if err := c.Control(func(fd uintptr) { ok = p.Protect(int32(fd)) }); err != nil {
		return err
	}
	if !ok {
		return errors.New("VpnService.protect вернул false")
	}
	return nil
}

func buildInstance(config string) (*core.Instance, error) {
	cfg, err := serial.LoadJSONConfig(strings.NewReader(config))
	if err != nil {
		return nil, fmt.Errorf("конфиг: %w", err)
	}
	inst, err := core.New(cfg)
	if err != nil {
		return nil, fmt.Errorf("создание ядра: %w", err)
	}
	return inst, nil
}

// Core — один запущенный экземпляр ядра.
type Core struct {
	mu       sync.Mutex
	listener Listener
	inst     *core.Instance
	running  bool
}

// NewCore создаёт управляющий объект. Listener может быть nil.
func NewCore(l Listener) *Core { return &Core{listener: l} }

func (c *Core) emit(code int64, msg string) {
	if c.listener != nil {
		c.listener.OnStatus(code, msg)
	}
}

// Start запускает ядро и возвращается, не дожидаясь остановки.
// tunFd > 0 — встроенный TUN-режим xray (конфиг должен содержать inbound "tun");
// tunFd <= 0 — обычный режим (SOCKS/HTTP-инбаунды из конфига).
func (c *Core) Start(config string, tunFd int32) (err error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	defer func() {
		// Паника внутри xray не должна ронять весь процесс приложения.
		if r := recover(); r != nil {
			err = fmt.Errorf("паника ядра: %v\n%s", r, debug.Stack())
			c.running = false
			c.emit(StatusError, err.Error())
		}
	}()

	if c.running {
		return errors.New("ядро уже запущено")
	}
	setupOnce.Do(setup)
	c.emit(StatusStarting, "запуск xray "+core.Version())

	envTun := platform.NormalizeEnvName(platform.TunFdKey)
	if tunFd > 0 {
		if err := os.Setenv(envTun, strconv.Itoa(int(tunFd))); err != nil {
			return err
		}
	} else {
		_ = os.Unsetenv(envTun)
	}

	inst, err := buildInstance(config)
	if err != nil {
		c.emit(StatusError, err.Error())
		return err
	}
	if err := inst.Start(); err != nil {
		_ = inst.Close()
		c.emit(StatusError, err.Error())
		return fmt.Errorf("старт ядра: %w", err)
	}
	c.inst = inst
	c.running = true
	c.emit(StatusStarted, "ядро запущено")
	return nil
}

// Stop останавливает ядро (повторный вызов безопасен).
func (c *Core) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.inst == nil {
		return
	}
	defer func() { _ = recover() }()
	_ = c.inst.Close()
	c.inst = nil
	c.running = false
	c.emit(StatusStopped, "ядро остановлено")
	debug.FreeOSMemory()
}

// IsRunning сообщает, запущено ли ядро.
func (c *Core) IsRunning() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.running
}

// MeasureDelay поднимает временный экземпляр ядра с переданным конфигом и измеряет
// задержку HTTP GET по url через его исходящее подключение. Возвращает миллисекунды
// либо -1 при ошибке или таймауте. TUN-инбаунд не используется.
func MeasureDelay(config string, url string, timeoutMs int64) (ms int64) {
	defer func() {
		if r := recover(); r != nil {
			ms = -1
		}
	}()
	if timeoutMs <= 0 {
		timeoutMs = 5000
	}
	setupOnce.Do(setup)
	_ = os.Unsetenv(platform.NormalizeEnvName(platform.TunFdKey))

	inst, err := buildInstance(config)
	if err != nil {
		return -1
	}
	if err := inst.Start(); err != nil {
		_ = inst.Close()
		return -1
	}
	defer inst.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	tr := &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			dest, err := xnet.ParseDestination(fmt.Sprintf("%s:%s", network, addr))
			if err != nil {
				return nil, err
			}
			return core.Dial(ctx, inst, dest)
		},
	}
	client := &http.Client{
		Transport: tr,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return -1
	}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return -1
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
	_ = resp.Body.Close()
	return time.Since(start).Milliseconds()
}
