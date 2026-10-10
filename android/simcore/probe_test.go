//go:build probe

package simcore

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

// Проверка «замера по рабочему пути» на реальных конфигах подписки (не входит в обычные тесты):
//
//	SIMCORE_PROBE_DIR=<папка с node-*.json> go test -tags probe -run TestProbeRoute -v
//
// Повторяет buildJsonPingConfig(node, keepRoute=true) из src/native/bridge.ts и то, что делает
// NativeBridge.pingViaFullCore: SOCKS-инбаунд + GET connectivitycheck.gstatic.com/generate_204.
func TestProbeRoute(t *testing.T) {
	dir := os.Getenv("SIMCORE_PROBE_DIR")
	if dir == "" {
		t.Skip("SIMCORE_PROBE_DIR не задан")
	}
	files, _ := filepath.Glob(filepath.Join(dir, "node-*.json"))
	sort.Strings(files)
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var c map[string]any
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatal(err)
		}
		name, _ := c["remarks"].(string)
		for _, k := range []string{"test", "api", "stats", "metrics", "remarks"} {
			delete(c, k)
		}
		// «Первый outbound недоступен»: уводим его на адрес, который сразу отказывает.
		if obs, ok := c["outbounds"].([]any); ok {
			for _, o := range obs {
				m, _ := o.(map[string]any)
				if ss, ok := m["streamSettings"].(map[string]any); ok {
					if so, ok := ss["sockopt"].(map[string]any); ok {
						delete(so, "interface")
						delete(so, "mark")
					}
				}
				if _, ok := m["mux"]; ok {
					m["mux"] = map[string]any{"enabled": false}
				}
			}
			if first, ok := obs[0].(map[string]any); ok {
				if st, ok := first["settings"].(map[string]any); ok {
					if vn, ok := st["vnext"].([]any); ok && len(vn) > 0 {
						vn[0].(map[string]any)["address"] = "127.0.0.1"
						vn[0].(map[string]any)["port"] = 9
					}
				}
			}
		}
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Skipf("loopback недоступен: %v", err)
		}
		port := l.Addr().(*net.TCPAddr).Port
		_ = l.Close()
		c["inbounds"] = []any{map[string]any{"tag": "socks-in", "protocol": "socks", "listen": "127.0.0.1", "port": port, "settings": map[string]any{"udp": false}}}
		c["log"] = map[string]any{"loglevel": "none"}
		cfg, _ := json.Marshal(c)

		core := NewCore(nil)
		t0 := time.Now()
		if err := core.Start(string(cfg), 0); err != nil {
			t.Logf("%-13s START FAILED: %v   %s", filepath.Base(f), err, name)
			continue
		}
		startMs := time.Since(t0).Milliseconds()
		proxyURL, _ := url.Parse(fmt.Sprintf("socks5://127.0.0.1:%d", port))
		client := &http.Client{Timeout: 9 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL), DisableKeepAlives: true}}
		res := make([]int64, 0, 2)
		for i := 0; i < 2; i++ {
			t1 := time.Now()
			resp, err := client.Get("http://connectivitycheck.gstatic.com/generate_204")
			if err != nil {
				res = append(res, -1)
				continue
			}
			_ = resp.Body.Close()
			res = append(res, time.Since(t1).Milliseconds())
		}
		core.Stop()
		t.Logf("%-13s start=%4d ms  GET via full route: %5d %5d ms   %s", filepath.Base(f), startMs, res[0], res[1], name)
	}
}
