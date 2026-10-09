package simcore

import (
	"context"
	"errors"
	"net"
	"os"
	"sync"
	"syscall"
	"time"
)

// raceConn — UDP-«соединение» к нескольким DNS-серверам сразу: запрос уходит всем, ответом
// считается первый пришедший. Стандартный резолвер Go сам перебирать серверы не умеет (мы
// подменяем Dial), и один «молчащий» сервер превращал каждый запрос в серию таймаутов.
type raceConn struct {
	conns []net.Conn
	resp  chan raceResp
	done  chan struct{}
	once  sync.Once

	mu       sync.Mutex
	deadline time.Time
}

type raceResp struct {
	data []byte
	addr net.Addr
}

func dialRace(ctx context.Context, servers []string, ctl func(string, string, syscall.RawConn) error) (net.Conn, error) {
	rc := &raceConn{resp: make(chan raceResp, 8), done: make(chan struct{})}
	var lastErr error
	for _, s := range servers {
		d := net.Dialer{Timeout: 1500 * time.Millisecond, Control: ctl}
		c, err := d.DialContext(ctx, "udp", s)
		if err != nil {
			lastErr = err
			continue
		}
		rc.conns = append(rc.conns, c)
		go rc.pump(c)
	}
	if len(rc.conns) == 0 {
		if lastErr == nil {
			lastErr = errors.New("нет DNS-серверов")
		}
		return nil, lastErr
	}
	return rc, nil
}

func (r *raceConn) pump(c net.Conn) {
	buf := make([]byte, 4096)
	for {
		n, err := c.Read(buf)
		if err != nil {
			return
		}
		select {
		case r.resp <- raceResp{data: append([]byte(nil), buf[:n]...), addr: c.RemoteAddr()}:
		case <-r.done:
			return
		}
	}
}

func (r *raceConn) Write(b []byte) (int, error) {
	var ok bool
	for _, c := range r.conns {
		if _, err := c.Write(b); err == nil {
			ok = true
		}
	}
	if !ok {
		return 0, errors.New("не удалось отправить запрос ни одному DNS-серверу")
	}
	return len(b), nil
}

func (r *raceConn) Read(b []byte) (int, error) {
	n, _, err := r.ReadFrom(b)
	return n, err
}

func (r *raceConn) ReadFrom(b []byte) (int, net.Addr, error) {
	r.mu.Lock()
	dl := r.deadline
	r.mu.Unlock()
	var timeout <-chan time.Time
	if !dl.IsZero() {
		t := time.NewTimer(time.Until(dl))
		defer t.Stop()
		timeout = t.C
	}
	select {
	case m := <-r.resp:
		return copy(b, m.data), m.addr, nil
	case <-timeout:
		return 0, nil, os.ErrDeadlineExceeded
	case <-r.done:
		return 0, nil, net.ErrClosed
	}
}

func (r *raceConn) WriteTo(b []byte, _ net.Addr) (int, error) { return r.Write(b) }

func (r *raceConn) Close() error {
	r.once.Do(func() {
		close(r.done)
		for _, c := range r.conns {
			_ = c.Close()
		}
	})
	return nil
}

func (r *raceConn) LocalAddr() net.Addr  { return r.conns[0].LocalAddr() }
func (r *raceConn) RemoteAddr() net.Addr { return r.conns[0].RemoteAddr() }

func (r *raceConn) SetDeadline(t time.Time) error {
	r.mu.Lock()
	r.deadline = t
	r.mu.Unlock()
	return nil
}
func (r *raceConn) SetReadDeadline(t time.Time) error  { return r.SetDeadline(t) }
func (r *raceConn) SetWriteDeadline(t time.Time) error { return nil }
