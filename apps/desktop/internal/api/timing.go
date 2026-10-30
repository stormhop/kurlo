package api

import (
	"context"
	"crypto/tls"
	"math"
	"net/http/httptrace"
	"strings"
	"sync"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type responseTimingRecorder struct {
	mu sync.Mutex

	start       time.Time
	prepareDone time.Time

	getConn        time.Time
	socketRecorded bool

	dnsStart     time.Time
	connectStart time.Time
	tlsStart     time.Time
	wroteRequest time.Time

	socketTotal  time.Duration
	dnsTotal     time.Duration
	tcpTotal     time.Duration
	tlsTotal     time.Duration
	waitingTotal time.Duration

	firstResponseByte time.Time
	lastResponseByte  time.Time

	events     []model.TimelineEvent
	connection model.ConnectionInfo
}

func (r *responseTimingRecorder) addEventLocked(label string, at time.Time, detail string) {
	r.events = append(r.events, model.TimelineEvent{
		Label:  label,
		AtMs:   millisBetween(r.start, at),
		Detail: detail,
	})
}

func (r *responseTimingRecorder) timeline() []model.TimelineEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.events) == 0 {
		return nil
	}
	out := make([]model.TimelineEvent, len(r.events))
	copy(out, r.events)
	return out
}

func (r *responseTimingRecorder) connectionInfo() model.ConnectionInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.connection
}

func tlsVersionName(version uint16) string {
	switch version {
	case tls.VersionTLS13:
		return "TLS 1.3"
	case tls.VersionTLS12:
		return "TLS 1.2"
	case tls.VersionTLS11:
		return "TLS 1.1"
	case tls.VersionTLS10:
		return "TLS 1.0"
	default:
		return ""
	}
}

func withResponseTiming(ctx context.Context, start time.Time) (context.Context, *responseTimingRecorder) {
	rec := &responseTimingRecorder{start: start}
	return httptrace.WithClientTrace(ctx, rec.clientTrace()), rec
}

func (r *responseTimingRecorder) markEvent(label, detail string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.addEventLocked(label, time.Now(), detail)
}

func (r *responseTimingRecorder) markPrepared() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.prepareDone.IsZero() {
		r.prepareDone = time.Now()
	}
}

func (r *responseTimingRecorder) snapshot(finish time.Time) model.ResponseTime {
	r.mu.Lock()
	defer r.mu.Unlock()

	download := time.Duration(0)
	if !r.lastResponseByte.IsZero() && finish.After(r.lastResponseByte) {
		download = finish.Sub(r.lastResponseByte)
	}
	prepare := durationBetween(r.start, r.prepareDone)
	process := durationBetween(r.start, finish) - prepare - r.socketTotal - r.dnsTotal - r.tcpTotal - r.tlsTotal - r.waitingTotal - download
	if process < 0 {
		process = 0
	}

	return model.ResponseTime{
		Total:                millisBetween(r.start, finish),
		Prepare:              roundMillis(prepare),
		SocketInitialization: roundMillis(r.socketTotal),
		DNSLookup:            roundMillis(r.dnsTotal),
		TCPHandshake:         roundMillis(r.tcpTotal),
		TLSHandshake:         roundMillis(r.tlsTotal),
		WaitingTTFB:          roundMillis(r.waitingTotal),
		Download:             roundMillis(download),
		Process:              roundMillis(process),
	}
}

func (r *responseTimingRecorder) clientTrace() *httptrace.ClientTrace {
	return &httptrace.ClientTrace{
		GetConn: func(hostPort string) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.getConn = time.Now()
			r.socketRecorded = false
			r.addEventLocked("Connection requested", r.getConn, hostPort)
		},
		DNSStart: func(info httptrace.DNSStartInfo) {
			r.mu.Lock()
			defer r.mu.Unlock()
			now := time.Now()
			r.recordSocketStartLocked(now)
			r.dnsStart = now
			r.addEventLocked("DNS lookup started", now, info.Host)
		},
		DNSDone: func(info httptrace.DNSDoneInfo) {
			r.mu.Lock()
			defer r.mu.Unlock()
			now := time.Now()
			if !r.dnsStart.IsZero() && now.After(r.dnsStart) {
				r.dnsTotal += now.Sub(r.dnsStart)
			}
			r.dnsStart = time.Time{}
			addresses := make([]string, 0, len(info.Addrs))
			for _, addr := range info.Addrs {
				addresses = append(addresses, addr.String())
			}
			r.connection.Addresses = addresses
			r.addEventLocked("DNS lookup done", now, strings.Join(addresses, ", "))
		},
		ConnectStart: func(network, addr string) {
			r.mu.Lock()
			defer r.mu.Unlock()
			now := time.Now()
			r.recordSocketStartLocked(now)
			r.connectStart = now
			r.addEventLocked("TCP connecting", now, network+" "+addr)
		},
		ConnectDone: func(network, addr string, err error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			now := time.Now()
			if !r.connectStart.IsZero() && now.After(r.connectStart) {
				r.tcpTotal += now.Sub(r.connectStart)
			}
			r.connectStart = time.Time{}
			detail := network + " " + addr
			if err != nil {
				detail += " — " + err.Error()
			}
			r.addEventLocked("TCP connected", now, detail)
		},
		TLSHandshakeStart: func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.tlsStart = time.Now()
			r.addEventLocked("TLS handshake started", r.tlsStart, "")
		},
		TLSHandshakeDone: func(state tls.ConnectionState, err error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			now := time.Now()
			if !r.tlsStart.IsZero() && now.After(r.tlsStart) {
				r.tlsTotal += now.Sub(r.tlsStart)
			}
			r.tlsStart = time.Time{}
			if err != nil {
				r.addEventLocked("TLS handshake failed", now, err.Error())
				return
			}
			r.connection.TLSVersion = tlsVersionName(state.Version)
			r.connection.TLSCipher = tls.CipherSuiteName(state.CipherSuite)
			r.connection.ALPN = state.NegotiatedProtocol
			r.connection.ServerName = state.ServerName
			detail := r.connection.TLSVersion
			if r.connection.TLSCipher != "" {
				detail += ", " + r.connection.TLSCipher
			}
			r.addEventLocked("TLS handshake done", now, detail)
		},
		GotConn: func(info httptrace.GotConnInfo) {
			r.mu.Lock()
			defer r.mu.Unlock()
			now := time.Now()
			if !r.socketRecorded && !r.getConn.IsZero() && now.After(r.getConn) {
				r.socketTotal += now.Sub(r.getConn)
				r.socketRecorded = true
			}
			r.connection.Reused = info.Reused
			r.connection.WasIdle = info.WasIdle
			if info.Conn != nil {
				if local := info.Conn.LocalAddr(); local != nil {
					r.connection.LocalAddr = local.String()
				}
				if remote := info.Conn.RemoteAddr(); remote != nil {
					r.connection.RemoteAddr = remote.String()
				}
			}
			detail := "new connection"
			if info.Reused {
				detail = "reused connection"
			}
			if r.connection.RemoteAddr != "" {
				detail += " — " + r.connection.RemoteAddr
			}
			r.addEventLocked("Connection ready", now, detail)
		},
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.wroteRequest = time.Now()
			detail := ""
			if info.Err != nil {
				detail = info.Err.Error()
			}
			r.addEventLocked("Request sent", r.wroteRequest, detail)
		},
		GotFirstResponseByte: func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			now := time.Now()
			if r.firstResponseByte.IsZero() {
				r.firstResponseByte = now
			}
			r.lastResponseByte = now
			if !r.wroteRequest.IsZero() && now.After(r.wroteRequest) {
				r.waitingTotal += now.Sub(r.wroteRequest)
			}
			r.wroteRequest = time.Time{}
			r.addEventLocked("First response byte", now, "")
		},
	}
}

func (r *responseTimingRecorder) recordSocketStartLocked(now time.Time) {
	if r.socketRecorded || r.getConn.IsZero() || !now.After(r.getConn) {
		return
	}
	r.socketTotal += now.Sub(r.getConn)
	r.socketRecorded = true
}

func millisBetween(start, finish time.Time) float64 {
	return roundMillis(durationBetween(start, finish))
}

func durationBetween(start, finish time.Time) time.Duration {
	if start.IsZero() || finish.IsZero() || !finish.After(start) {
		return 0
	}
	return finish.Sub(start)
}

func roundMillis(d time.Duration) float64 {
	if d <= 0 {
		return 0
	}
	return math.Round((float64(d)/float64(time.Millisecond))*100) / 100
}
