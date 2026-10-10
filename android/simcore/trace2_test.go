//go:build probe

package simcore

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"os"
	"strconv"
	"testing"
	"time"

	"golang.org/x/net/proxy"
)

// Временная диагностика: один и тот же запрос через SOCKS-порт работающего ядра и напрямую
// (то есть через TUN, если VPN включён). Ядро здесь не запускается.
//
//	SIMCORE_AB_SOCKS=127.0.0.1:10808 SIMCORE_AB_SECS=60 ./simtrace -test.run TestSocksVsTun -test.v
func TestSocksVsTun(t *testing.T) {
	socks := os.Getenv("SIMCORE_AB_SOCKS")
	if socks == "" {
		t.Skip("SIMCORE_AB_SOCKS не задан")
	}
	secs, _ := strconv.Atoi(os.Getenv("SIMCORE_AB_SECS"))
	if secs <= 0 {
		secs = 60
	}
	onlyTun := os.Getenv("SIMCORE_AB_ONLYTUN") == "1"
	// one: соединение + GET, возвращает (мс до установления TCP, мс до первого байта ответа, ошибка)
	one := func(dial func(addr string) (net.Conn, error), ip string) (int64, int64, string) {
		t1 := time.Now()
		c, err := dial(ip + ":80")
		if err != nil {
			return time.Since(t1).Milliseconds(), -1, "dial: " + err.Error()
		}
		defer c.Close()
		cm := time.Since(t1).Milliseconds()
		_ = c.SetDeadline(time.Now().Add(12 * time.Second))
		if _, err := c.Write([]byte("GET / HTTP/1.1\r\nHost: " + ip + "\r\nConnection: close\r\n\r\n")); err != nil {
			return cm, time.Since(t1).Milliseconds(), "write: " + err.Error()
		}
		line, err := bufio.NewReader(c).ReadString('\n')
		if err != nil || len(line) < 8 {
			return cm, time.Since(t1).Milliseconds(), fmt.Sprintf("read: %v", err)
		}
		return cm, time.Since(t1).Milliseconds(), ""
	}
	sd, err := proxy.SOCKS5("tcp", socks, nil, &net.Dialer{Timeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	direct := &net.Dialer{Timeout: 10 * time.Second}
	t0 := time.Now()
	ips := []string{"1.1.1.1", "1.0.0.1"}
	var n, sBad, tBad int
	var sSum, tSum int64
	for i := 0; time.Since(t0) < time.Duration(secs)*time.Second; i++ {
		ip := ips[i%len(ips)]
		var sc, sf int64
		var se string
		if !onlyTun {
			sc, sf, se = one(func(a string) (net.Conn, error) { return sd.Dial("tcp", a) }, ip)
		}
		tc, tf, te := one(func(a string) (net.Conn, error) { return direct.Dial("tcp", a) }, ip)
		n++
		slow := ""
		if se != "" || sf > 3000 {
			sBad++
			slow += " <-- SOCKS"
		} else {
			sSum += sf
		}
		if te != "" || tf > 3000 {
			tBad++
			slow += " <-- TUN"
		} else {
			tSum += tf
		}
		if slow != "" || os.Getenv("SIMCORE_AB_ALL") == "1" {
			fmt.Printf("AB %s t=%5.1fs %-8s socks conn=%d first=%d %s | tun conn=%d first=%d %s%s\n",
				time.Now().Format("15:04:05.000"), time.Since(t0).Seconds(), ip, sc, sf, se, tc, tf, te, slow)
		}
		time.Sleep(300 * time.Millisecond)
	}
	fmt.Printf("AB SUMMARY n=%d  socks: bad=%d avg_ok=%d ms   tun: bad=%d avg_ok=%d ms\n",
		n, sBad, sSum/int64(max(1, n-sBad)), tBad, tSum/int64(max(1, n-tBad)))
}

// Временная диагностика: DNS и TLS-рукопожатие к реальным сайтам через TUN (как грузит страницу браузер).
//
//	SIMCORE_WEB=1 SIMCORE_WEB_ROUNDS=2 ./simtrace -test.run TestWebViaTun -test.v
func TestWebViaTun(t *testing.T) {
	if os.Getenv("SIMCORE_WEB") == "" {
		t.Skip("SIMCORE_WEB не задан")
	}
	rounds, _ := strconv.Atoi(os.Getenv("SIMCORE_WEB_ROUNDS"))
	if rounds <= 0 {
		rounds = 1
	}
	dnsAddr := os.Getenv("SIMCORE_WEB_DNS")
	if dnsAddr == "" {
		dnsAddr = "8.8.8.8:53"
	}
	res := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 8 * time.Second}).DialContext(ctx, "udp", dnsAddr)
	}}
	hosts := []string{"telegram.org", "web.telegram.org", "t.me", "core.telegram.org", "google.com", "www.youtube.com", "github.com",
		"www.wikipedia.org", "www.cloudflare.com", "www.apple.com", "www.microsoft.com", "www.amazon.com", "www.reddit.com", "x.com",
		"www.instagram.com", "www.facebook.com", "web.whatsapp.com", "openai.com", "www.notion.so", "discord.com", "www.twitch.tv",
		"open.spotify.com", "www.netflix.com", "stackoverflow.com", "medium.com", "www.npmjs.com", "pypi.org", "www.docker.com",
		"ton.org", "tonkeeper.com", "getgems.io", "fragment.com", "wallet.tg", "walletbot.me", "app.tonkeeper.com", "tonviewer.com",
		"connectivitycheck.gstatic.com", "www.gstatic.com", "cp.cloudflare.com", "play.google.com"}
	var n, dnsBad, tlsBad int
	var dnsSum, tlsSum int64
	t0 := time.Now()
	for r := 0; r < rounds; r++ {
		for _, h := range hosts {
			n++
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			t1 := time.Now()
			ips, err := res.LookupIP(ctx, "ip4", h)
			cancel()
			dms := time.Since(t1).Milliseconds()
			if err != nil || len(ips) == 0 {
				dnsBad++
				tlsBad++
				fmt.Printf("WEB %s %-30s DNS FAIL %d ms: %v\n", time.Now().Format("15:04:05"), h, dms, err)
				continue
			}
			dnsSum += dms
			t2 := time.Now()
			c, err := (&net.Dialer{Timeout: 10 * time.Second}).Dial("tcp", net.JoinHostPort(ips[0].String(), "443"))
			note := ""
			if err == nil {
				_ = c.SetDeadline(time.Now().Add(10 * time.Second))
				tc := tls.Client(c, &tls.Config{ServerName: h, InsecureSkipVerify: true})
				err = tc.Handshake()
				_ = c.Close()
			}
			tms := time.Since(t2).Milliseconds()
			if err != nil {
				tlsBad++
				note = "TLS FAIL: " + err.Error()
			} else {
				tlsSum += tms
			}
			if note != "" || dms > 1500 || tms > 3000 || os.Getenv("SIMCORE_AB_ALL") == "1" {
				fmt.Printf("WEB %s %-30s dns=%5d ms  tcp+tls=%5d ms  %s %s\n", time.Now().Format("15:04:05"), h, dms, tms, ips[0], note)
			}
		}
	}
	fmt.Printf("WEB SUMMARY n=%d in %.0fs  dns: bad=%d avg_ok=%d ms   tcp+tls: bad=%d avg_ok=%d ms\n", n, time.Since(t0).Seconds(),
		dnsBad, dnsSum/int64(max(1, n-dnsBad)), tlsBad, tlsSum/int64(max(1, n-tlsBad)))
}

// Временная диагностика: UDP через TUN (NTP). Сначала отдельный сокет на каждый сервер, затем один
// сокет на все серверы сразу (так работают QUIC/звонки: один локальный порт, много адресатов).
//
//	SIMCORE_UDP=1 ./simtrace -test.run TestUdpViaTun -test.v
func TestUdpViaTun(t *testing.T) {
	if os.Getenv("SIMCORE_UDP") == "" {
		t.Skip("SIMCORE_UDP не задан")
	}
	servers := []string{"216.239.35.0:123", "162.159.200.1:123", "216.239.35.4:123", "162.159.200.123:123", "216.239.35.8:123", "216.239.35.12:123"}
	req := make([]byte, 48)
	req[0] = 0x1B
	rounds := 5
	okSep, nSep := 0, 0
	for r := 0; r < rounds; r++ {
		for _, s := range servers {
			nSep++
			c, err := net.Dial("udp", s)
			if err != nil {
				continue
			}
			_ = c.SetDeadline(time.Now().Add(4 * time.Second))
			t1 := time.Now()
			_, _ = c.Write(req)
			buf := make([]byte, 128)
			n, err := c.Read(buf)
			_ = c.Close()
			if err == nil && n >= 48 {
				okSep++
			} else if os.Getenv("SIMCORE_AB_ALL") == "1" {
				fmt.Printf("UDP separate %s no reply in %d ms: %v\n", s, time.Since(t1).Milliseconds(), err)
			}
		}
	}
	fmt.Printf("UDP SUMMARY separate sockets: %d/%d replies\n", okSep, nSep)

	pc, err := net.ListenPacket("udp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	got := map[string]int{}
	sent := 0
	for r := 0; r < rounds; r++ {
		for _, s := range servers {
			ua, _ := net.ResolveUDPAddr("udp", s)
			_, _ = pc.WriteTo(req, ua)
			sent++
		}
		_ = pc.SetReadDeadline(time.Now().Add(3 * time.Second))
		for {
			buf := make([]byte, 128)
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				break
			}
			if n >= 48 {
				got[from.String()]++
			}
		}
	}
	total := 0
	for _, v := range got {
		total += v
	}
	fmt.Printf("UDP SUMMARY one socket, %d servers: %d/%d replies, from %d distinct servers %v\n", len(servers), total, sent, len(got), got)
}
