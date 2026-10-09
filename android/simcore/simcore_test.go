package simcore

import (
	"fmt"
	"net"
	"testing"
	"time"
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
