//go:build probe

package simcore

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"
)

// Временная диагностика: конфиг узла как есть (только свой SOCKS-инбаунд), серия запросов во времени.
//
//	SIMCORE_TRACE_FILE=<node-NN.json> SIMCORE_TRACE_SECS=90 go test -tags probe -run TestTraceRoute -v
func TestTraceRoute(t *testing.T) {
	f := os.Getenv("SIMCORE_TRACE_FILE")
	if f == "" {
		t.Skip("SIMCORE_TRACE_FILE не задан")
	}
	secs, _ := strconv.Atoi(os.Getenv("SIMCORE_TRACE_SECS"))
	if secs <= 0 {
		secs = 90
	}
	raw, err := os.ReadFile(f)
	if err != nil {
		t.Fatal(err)
	}
	var c map[string]any
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"test", "api", "stats", "metrics", "remarks"} {
		delete(c, k)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("loopback: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	c["inbounds"] = []any{map[string]any{"tag": "socks", "protocol": "socks", "listen": "127.0.0.1", "port": port,
		"settings": map[string]any{"udp": true},
		"sniffing": map[string]any{"enabled": true, "routeOnly": os.Getenv("SIMCORE_TRACE_ROUTEONLY") != "0", "destOverride": []any{"http", "tls", "quic"}}}}
	c["log"] = map[string]any{"loglevel": os.Getenv("SIMCORE_TRACE_LOG")}
	if os.Getenv("SIMCORE_TRACE_LOG") == "" {
		c["log"] = map[string]any{"loglevel": "info"}
	}
	// SIMCORE_TRACE_ONLY=<tag>: весь трафик в один outbound (без балансировщиков и обсерватории).
	if only := os.Getenv("SIMCORE_TRACE_ONLY"); only != "" {
		delete(c, "burstObservatory")
		delete(c, "observatory")
		c["routing"] = map[string]any{"rules": []any{map[string]any{"type": "field", "network": "tcp,udp", "outboundTag": only}}}
	}
	cfg, _ := json.Marshal(c)

	core := NewCore(nil)
	t0 := time.Now()
	if err := core.Start(string(cfg), 0); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer core.Stop()
	fmt.Printf("TRACE started in %d ms\n", time.Since(t0).Milliseconds())
	proxyURL, _ := url.Parse(fmt.Sprintf("socks5://127.0.0.1:%d", port))
	targets := []string{"http://1.1.1.1/", "http://connectivitycheck.gstatic.com/generate_204", "http://cp.cloudflare.com/generate_204", "http://1.0.0.1/", "http://www.msftconnecttest.com/connecttest.txt", "http://detectportal.firefox.com/success.txt"}
	i := 0
	for time.Since(t0) < time.Duration(secs)*time.Second {
		u := targets[i%len(targets)]
		i++
		client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL), DisableKeepAlives: true},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		t1 := time.Now()
		resp, err := client.Get(u)
		at := time.Since(t0).Seconds()
		if err != nil {
			fmt.Printf("TRACE t=%5.1fs %-52s FAIL after %d ms: %v\n", at, u, time.Since(t1).Milliseconds(), err)
		} else {
			_ = resp.Body.Close()
			fmt.Printf("TRACE t=%5.1fs %-52s %d in %d ms\n", at, u, resp.StatusCode, time.Since(t1).Milliseconds())
		}
		time.Sleep(700 * time.Millisecond)
	}
}
