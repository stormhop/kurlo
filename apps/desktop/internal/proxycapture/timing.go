package proxycapture

import (
	"context"
	"crypto/tls"
	"math"
	"net/http/httptrace"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type timingTrace struct {
	mu           sync.Mutex
	start        time.Time
	getConn      time.Time
	socketDone   bool
	dnsStart     time.Time
	connectStart time.Time
	tlsStart     time.Time
	wroteRequest time.Time
	firstByte    time.Time
	prepare      time.Duration
	socket       time.Duration
	dns          time.Duration
	tcp          time.Duration
	tls          time.Duration
	used         bool
}

func withTiming(ctx context.Context, start time.Time) (context.Context, *timingTrace) {
	t := &timingTrace{start: start}
	return httptrace.WithClientTrace(ctx, t.clientTrace()), t
}

func (t *timingTrace) socketStartLocked(now time.Time) {
	if t.socketDone || t.getConn.IsZero() {
		return
	}
	t.socketDone = true
	t.socket += max(0, now.Sub(t.getConn))
}

func (t *timingTrace) clientTrace() *httptrace.ClientTrace {
	lock := func(f func(now time.Time)) {
		t.mu.Lock()
		defer t.mu.Unlock()
		f(time.Now())
	}
	return &httptrace.ClientTrace{
		GetConn: func(string) {
			lock(func(now time.Time) {
				if t.getConn.IsZero() {
					t.prepare = max(0, now.Sub(t.start))
				}
				t.getConn = now
				t.socketDone = false
				t.used = true
			})
		},
		DNSStart: func(httptrace.DNSStartInfo) {
			lock(func(now time.Time) { t.socketStartLocked(now); t.dnsStart = now })
		},
		DNSDone: func(httptrace.DNSDoneInfo) {
			lock(func(now time.Time) {
				if !t.dnsStart.IsZero() {
					t.dns += max(0, now.Sub(t.dnsStart))
					t.dnsStart = time.Time{}
				}
			})
		},
		ConnectStart: func(string, string) {
			lock(func(now time.Time) { t.socketStartLocked(now); t.connectStart = now })
		},
		ConnectDone: func(string, string, error) {
			lock(func(now time.Time) {
				if !t.connectStart.IsZero() {
					t.tcp += max(0, now.Sub(t.connectStart))
					t.connectStart = time.Time{}
				}
			})
		},
		TLSHandshakeStart: func() {
			lock(func(now time.Time) { t.tlsStart = now })
		},
		TLSHandshakeDone: func(tls.ConnectionState, error) {
			lock(func(now time.Time) {
				if !t.tlsStart.IsZero() {
					t.tls += max(0, now.Sub(t.tlsStart))
					t.tlsStart = time.Time{}
				}
			})
		},
		GotConn: func(httptrace.GotConnInfo) {
			lock(func(now time.Time) { t.socketStartLocked(now) })
		},
		WroteRequest: func(httptrace.WroteRequestInfo) {
			lock(func(now time.Time) { t.wroteRequest = now })
		},
		GotFirstResponseByte: func() {
			lock(func(now time.Time) {
				if t.firstByte.IsZero() {
					t.firstByte = now
				}
			})
		},
	}
}

func (t *timingTrace) result(finish time.Time) *model.ResponseTime {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.used {
		return nil
	}
	var waiting, download time.Duration
	if !t.firstByte.IsZero() {
		if !t.wroteRequest.IsZero() {
			waiting = max(0, t.firstByte.Sub(t.wroteRequest))
		}
		download = max(0, finish.Sub(t.firstByte))
	}
	total := max(0, finish.Sub(t.start))
	process := max(0, total-t.prepare-t.socket-t.dns-t.tcp-t.tls-waiting-download)
	return &model.ResponseTime{
		Total:                timingMillis(total),
		Prepare:              timingMillis(t.prepare),
		SocketInitialization: timingMillis(t.socket),
		DNSLookup:            timingMillis(t.dns),
		TCPHandshake:         timingMillis(t.tcp),
		TLSHandshake:         timingMillis(t.tls),
		WaitingTTFB:          timingMillis(waiting),
		Download:             timingMillis(download),
		Process:              timingMillis(process),
	}
}

func timingMillis(d time.Duration) float64 {
	return math.Round(float64(d)/float64(time.Millisecond)*100) / 100
}

func harTimings(t *model.ResponseTime, duration int64) map[string]float64 {
	if t == nil {
		return map[string]float64{"blocked": -1, "dns": -1, "connect": -1, "ssl": -1, "send": 0, "wait": float64(duration), "receive": 0}
	}
	dns, connect, ssl := -1.0, -1.0, -1.0
	if t.DNSLookup > 0 {
		dns = t.DNSLookup
	}
	if t.TCPHandshake > 0 || t.TLSHandshake > 0 {
		connect = t.TCPHandshake + t.TLSHandshake
	}
	if t.TLSHandshake > 0 {
		ssl = t.TLSHandshake
	}
	return map[string]float64{"blocked": t.Prepare + t.SocketInitialization + t.Process, "dns": dns, "connect": connect, "ssl": ssl, "send": t.Send, "wait": t.WaitingTTFB, "receive": t.Download}
}

func sessionTimings(h map[string]float64, total float64) *model.ResponseTime {
	if len(h) == 0 {
		return nil
	}
	part := func(name string) float64 {
		if v, ok := h[name]; ok && v > 0 && !math.IsInf(v, 0) {
			return v
		}
		return 0
	}
	ssl := part("ssl")
	tcp := max(0, part("connect")-ssl)
	t := &model.ResponseTime{Prepare: part("blocked"), DNSLookup: part("dns"), TCPHandshake: tcp, TLSHandshake: ssl, Send: part("send"), WaitingTTFB: part("wait"), Download: part("receive")}
	sum := t.Prepare + t.DNSLookup + t.TCPHandshake + t.TLSHandshake + t.Send + t.WaitingTTFB + t.Download
	if sum == 0 {
		return nil
	}
	t.Total = max(total, sum)
	t.Process = math.Round((t.Total-sum)*100) / 100
	return t
}
