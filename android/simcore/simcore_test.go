package simcore

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strings"
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

func TestDNSOrder(t *testing.T) {
	SetSystemDNS("10.1.2.3, 77.88.8.8, не-адрес, 2001:db8::1")
	defer SetSystemDNS("")
	got := dnsServers()
	want := []string{"10.1.2.3:53", "77.88.8.8:53", "[2001:db8::1]:53", "1.1.1.1:53", "8.8.8.8:53"}
	if len(got) != len(want) {
		t.Fatalf("получено %v, ожидалось %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("получено %v, ожидалось %v", got, want)
		}
	}
}

// fakeDNS отвечает на любой A-запрос адресом 192.0.2.1; delay имитирует медленный сервер.
func fakeDNS(t *testing.T, delay time.Duration) (addr string, stop func()) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("loopback недоступен: %v", err)
	}
	go func() {
		buf := make([]byte, 512)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			q := append([]byte(nil), buf[:n]...)
			go func() {
				time.Sleep(delay)
				if len(q) < 12 {
					return
				}
				// заголовок: id, флаги QR|RD|RA, 1 вопрос, 1 ответ
				resp := append([]byte{}, q[:2]...)
				resp = append(resp, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0)
				// вопрос: метки имени до нулевого байта + 4 байта (тип, класс); EDNS-запись отбрасываем
				end := 12
				for end < len(q) && q[end] != 0 {
					end += int(q[end]) + 1
				}
				end += 5
				if end > len(q) {
					return
				}
				qtype := uint16(q[end-4])<<8 | uint16(q[end-3])
				resp = append(resp, q[12:end]...)
				if qtype == 1 { // A
					resp = append(resp, 0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 1)
				} else {
					resp[7] = 0 // для AAAA и прочих — пустой ответ без записей
				}
				_, _ = pc.WriteTo(resp, from)
			}()
		}
	}()
	return pc.LocalAddr().String(), func() { pc.Close() }
}

func TestRaceConnSkipsDeadServer(t *testing.T) {
	good, stop := fakeDNS(t, 0)
	defer stop()
	// «мёртвый» сервер: порт без слушателя, ответа не будет
	dead := "127.0.0.1:1"
	conn, err := dialRace(context.Background(), []string{dead, good}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// минимальный DNS-запрос A для example.com
	q := []byte{0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0,
		7, 'e', 'x', 'a', 'm', 'p', 'l', 'e', 3, 'c', 'o', 'm', 0, 0, 1, 0, 1}
	start := time.Now()
	if _, err := conn.Write(q); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 512)
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatalf("ответ не получен: %v", err)
	}
	if n < 12 || buf[0] != 0x12 || buf[1] != 0x34 {
		t.Fatalf("неверный ответ: % x", buf[:n])
	}
	if time.Since(start) > time.Second {
		t.Fatalf("слишком долго: %v", time.Since(start))
	}
}

func TestRaceConnDeadline(t *testing.T) {
	conn, err := dialRace(context.Background(), []string{"127.0.0.1:1"}, nil)
	if err != nil {
		t.Skipf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	start := time.Now()
	if _, err := conn.Read(make([]byte, 16)); err == nil {
		t.Fatal("ожидался таймаут")
	}
	if time.Since(start) > time.Second {
		t.Fatalf("таймаут сработал слишком поздно: %v", time.Since(start))
	}
}

// Сквозная проверка: стандартный резолвер Go с нашим Dial получает ответ, даже когда первый
// сервер в списке «молчит».
func TestResolverEndToEnd(t *testing.T) {
	good, stop := fakeDNS(t, 20*time.Millisecond)
	defer stop()
	r := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialRace(ctx, []string{"127.0.0.1:1", good}, nil)
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	start := time.Now()
	ips, err := r.LookupHost(ctx, "example.com")
	if err != nil {
		t.Fatalf("LookupHost: %v", err)
	}
	if len(ips) == 0 || ips[0] != "192.0.2.1" {
		t.Fatalf("ips: %v", ips)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("слишком долго: %v", d)
	}
	t.Logf("%v за %v", ips, time.Since(start))
}
