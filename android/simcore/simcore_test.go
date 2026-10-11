package simcore

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	commlog "github.com/xtls/xray-core/common/log"
	"github.com/xtls/xray-core/common/platform"
)

// Минимальный конфиг: SOCKS-инбаунд + прямое исходящее (freedom).
func socksConfig(port int) string {
	return fmt.Sprintf(`{
  "log": {"loglevel": "none"},
  "inbounds": [{"tag":"in","protocol":"socks","listen":"127.0.0.1","port":%d,"settings":{"udp":false}}],
  "outbounds": [{"tag":"direct","protocol":"freedom"}]
}`, port)
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("loopback недоступен: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

type recListener struct{ events []int64 }

func (r *recListener) OnStatus(code int64, _ string) { r.events = append(r.events, code) }

func TestVersions(t *testing.T) {
	if CoreVersion() == "" || Version() != WrapperVersion {
		t.Fatalf("версии: core=%q wrapper=%q", CoreVersion(), Version())
	}
	t.Logf("xray %s, wrapper %s", CoreVersion(), Version())
}

func TestInitEnvRejectsBadKey(t *testing.T) {
	if err := InitEnv("", "короткий"); err == nil {
		t.Fatal("ожидалась ошибка для некорректного ключа XUDP")
	}
	// ровно 32 байта в base64url без заполнения = 43 символа
	if err := InitEnv("", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); err != nil {
		t.Fatalf("валидный ключ отклонён: %v", err)
	}
}

func TestStartStopSocks(t *testing.T) {
	port := freePort(t)
	rec := &recListener{}
	c := NewCore(rec)
	if err := c.Start(socksConfig(port), 0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !c.IsRunning() {
		t.Fatal("IsRunning=false после Start")
	}
	deadline := time.Now().Add(5 * time.Second)
	open := false
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 300*time.Millisecond)
		if err == nil {
			conn.Close()
			open = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !open {
		t.Fatal("SOCKS-порт не открылся")
	}
	if err := c.Start(socksConfig(port), 0); err == nil {
		t.Fatal("повторный Start должен вернуть ошибку")
	}
	c.Stop()
	c.Stop() // повторный Stop безопасен
	if c.IsRunning() {
		t.Fatal("IsRunning=true после Stop")
	}
	if len(rec.events) < 3 || rec.events[0] != StatusStarting || rec.events[1] != StatusStarted {
		t.Fatalf("события: %v", rec.events)
	}
}

func TestStartBadConfig(t *testing.T) {
	c := NewCore(nil)
	if err := c.Start(`{"inbounds": [ not json`, 0); err == nil {
		t.Fatal("ожидалась ошибка для битого JSON")
	}
	if c.IsRunning() {
		t.Fatal("ядро не должно считаться запущенным")
	}
}

func TestMeasureDelayBadConfig(t *testing.T) {
	if ms := MeasureDelay("not json", "http://127.0.0.1/", 1000); ms != -1 {
		t.Fatalf("ожидалось -1, получено %d", ms)
	}
}

// Живая проверка: замер задержки через временный экземпляр ядра с прямым выходом.
// Без сети тест пропускается.
func TestMeasureDelayDirect(t *testing.T) {
	cfg := `{"log":{"loglevel":"none"},"outbounds":[{"tag":"direct","protocol":"freedom"}]}`
	ms := MeasureDelay(cfg, "http://cp.cloudflare.com/generate_204", 8000)
	if ms < 0 {
		t.Skip("нет сети или сайт недоступен")
	}
	t.Logf("delay %d ms", ms)
	if ms > 8000 {
		t.Fatalf("слишком большая задержка: %d", ms)
	}
}

// Временный экземпляр для замера не должен оставлять боевой туннель без журнала: app/log каждого нового
// экземпляра регистрирует себя общим обработчиком xray, а при закрытии экземпляра перестаёт писать.
func TestMeasureDelayKeepsLiveLog(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "live.log")
	cfg := fmt.Sprintf(`{
  "log": {"loglevel": "warning", "error": %q},
  "inbounds": [{"tag":"in","protocol":"socks","listen":"127.0.0.1","port":%d,"settings":{"udp":false}}],
  "outbounds": [{"tag":"direct","protocol":"freedom"}]
}`, logPath, freePort(t))
	inst, err := buildInstance(cfg)
	if err != nil {
		t.Fatalf("buildInstance: %v", err)
	}
	if err := inst.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	mu.Lock()
	liveInst = inst
	mu.Unlock()
	defer func() {
		mu.Lock()
		liveInst = nil
		mu.Unlock()
		_ = inst.Close()
	}()

	// Сам замер заведомо неудачный (порт закрыт): важны подъём и закрытие временного экземпляра.
	_ = MeasureDelay(socksConfig(freePort(t)), "http://127.0.0.1:1/", 500)

	const marker = "marker-after-measure"
	commlog.Record(&commlog.GeneralMessage{Severity: commlog.Severity_Warning, Content: marker})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if b, _ := os.ReadFile(logPath); strings.Contains(string(b), marker) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("после замера журнал боевого экземпляра молчит")
}

// Пока запускается ядро (startMu занят), замер не стартует и не трогает xray.tun.fd: иначе боевой туннель
// прочитал бы пустую переменную и поднялся без TUN-дескриптора.
func TestMeasureWaitsForCoreStart(t *testing.T) {
	envTun := platform.NormalizeEnvName(platform.TunFdKey)
	startMu.Lock() // идёт запуск боевого ядра
	if err := os.Setenv(envTun, "42"); err != nil {
		startMu.Unlock()
		t.Fatal(err)
	}
	defer os.Unsetenv(envTun)

	done := make(chan int64, 1)
	go func() { done <- MeasureDelay(socksConfig(freePort(t)), "http://127.0.0.1:1/", 300) }()

	time.Sleep(300 * time.Millisecond)
	got := os.Getenv(envTun)
	finished := len(done) > 0
	startMu.Unlock()
	if got != "42" {
		t.Fatalf("замер изменил %s во время запуска ядра: %q", envTun, got)
	}
	if finished {
		t.Fatal("замер не дождался окончания запуска ядра")
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("замер не завершился после окончания запуска ядра")
	}
}

func TestWithTunInbound(t *testing.T) {
	cfg := `{"inbounds":[{"tag":"socks-in","protocol":"socks","port":10808}],"outbounds":[{"protocol":"freedom"}],"big":12345678901234567}`
	out, err := withTunInbound(cfg, 1400)
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Inbounds []struct {
			Protocol string `json:"protocol"`
			Settings struct {
				MTU int `json:"MTU"`
			} `json:"settings"`
		} `json:"inbounds"`
	}
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatal(err)
	}
	if len(m.Inbounds) != 2 || m.Inbounds[0].Protocol != "socks" || m.Inbounds[1].Protocol != "tun" || m.Inbounds[1].Settings.MTU != 1400 {
		t.Fatalf("inbounds: %+v", m.Inbounds)
	}
	if !strings.Contains(out, "12345678901234567") {
		t.Fatal("большое целое число испорчено при перекодировании")
	}
	// если tun уже есть — конфиг не трогаем
	same, _ := withTunInbound(out, 1400)
	if same != out {
		t.Fatal("повторная подстановка не должна менять конфиг")
	}
	// некорректный JSON
	if _, err := withTunInbound("{", 0); err == nil {
		t.Fatal("ожидалась ошибка")
	}
}

func TestUsesDialerProxy(t *testing.T) {
	if usesDialerProxy.MatchString(`{"sockopt":{"dialerProxy":""}}`) {
		t.Fatal("пустой dialerProxy не должен считаться цепочкой")
	}
	if !usesDialerProxy.MatchString(`{"sockopt":{"dialerProxy" : "fragment"}}`) {
		t.Fatal("непустой dialerProxy не распознан")
	}
}
