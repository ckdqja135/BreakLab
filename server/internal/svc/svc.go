// Package svc는 데모 서비스들이 함께 쓰는 뼈대다.
// 모든 서비스는 실제 HTTP로 통신하고, 요청이 지시한 장애를 실제로 따른다. 결과를 꾸미지 않는다.
package svc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"breaklab/internal/tele"
	"breaklab/internal/wire"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

func Env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// gate는 동시에 처리하는 요청 수를 제한한다. 자리가 없으면 줄을 서고, 호출자가 끊으면 줄에서 빠진다.
type gate struct {
	mu   sync.Mutex
	busy int
	wake chan struct{}
}

func (g *gate) enter(ctx context.Context, slots int) bool {
	for {
		g.mu.Lock()
		if g.busy < slots {
			g.busy++
			g.mu.Unlock()
			return true
		}
		w := g.wake
		g.mu.Unlock()
		select {
		case <-w:
		case <-ctx.Done():
			return false
		}
	}
}

func (g *gate) leave() {
	g.mu.Lock()
	g.busy--
	close(g.wake)
	g.wake = make(chan struct{})
	g.mu.Unlock()
}

// Server는 서비스 하나다.
type Server struct {
	ID     string
	Tracer trace.Tracer
	Slots  int // 평소 동시에 처리하는 요청 수. 0이면 제한 없음
	Mux    *http.ServeMux
	Gauges func() []wire.Gauge // 스스로 센 값. 없어도 된다
	Reset  func()              // 실험이 바뀔 때 기억을 비운다. 없어도 된다

	line gate
	mu   sync.Mutex
	run  string
	stop func(context.Context) error
}

// New는 관측 경로를 연결하고 관리용 주소(/healthz, /lab/stats, /lab/reset)를 연다.
func New(ctx context.Context, id string) *Server {
	tracer, shutdown, err := tele.Setup(ctx, id, Env("LAB_TELEMETRY_URL", "http://127.0.0.1:7701"))
	if err != nil {
		log.Fatal(err)
	}
	s := &Server{ID: id, Tracer: tracer, Mux: http.NewServeMux(), stop: shutdown, line: gate{wake: make(chan struct{})}}
	s.Mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "ok") })
	s.Mux.HandleFunc("GET /lab/stats", func(w http.ResponseWriter, _ *http.Request) {
		g := []wire.Gauge{}
		if s.Gauges != nil {
			g = s.Gauges()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"gauges": g})
	})
	s.Mux.HandleFunc("POST /lab/reset", func(w http.ResponseWriter, _ *http.Request) {
		s.mu.Lock()
		s.run = ""
		s.mu.Unlock()
		if s.Reset != nil {
			s.Reset()
		}
		io.WriteString(w, "ok")
	})
	return s
}

// Run은 종료 신호가 올 때까지 요청을 받는다.
func (s *Server) Run(ctx context.Context, addr string) {
	srv := &http.Server{Addr: addr, Handler: s.Mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(c)
		s.stop(c)
	}()
	log.Printf("%s 수신 %s", s.ID, addr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// Main은 서비스 하나를 띄운다. addr은 LISTEN을 주지 않았을 때 받는 주소다.
func Main(id, addr string, setup func(ctx context.Context, s *Server)) {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	s := New(ctx, id)
	setup(ctx, s)
	s.Run(ctx, Env("LISTEN", addr))
}

// Req는 받은 요청 하나다.
type Req struct {
	Ctx   context.Context
	Span  trace.Span
	P     wire.Policy
	Fault wire.ServiceFault // 이 서비스에 걸린 장애. 없으면 빈 값
	W     http.ResponseWriter
}

// WorkOr는 과부하 장애가 처리 시간을 정했으면 그 값을, 아니면 평소 값을 돌려준다.
func (q *Req) WorkOr(d time.Duration) time.Duration {
	if q.Fault.Slots > 0 {
		return time.Duration(q.Fault.WorkMs) * time.Millisecond
	}
	return d
}

func (q *Req) end(result, errText string) {
	q.Span.SetAttributes(attribute.String("lab.result", result))
	if errText != "" {
		q.Span.SetAttributes(attribute.String("lab.error", errText))
	}
}

// Wait는 처리 시간만큼 기다린다. 호출자가 끊으면 처리를 멈추고 false를 돌려준다.
func (q *Req) Wait(d time.Duration) bool {
	select {
	case <-time.After(d):
		return true
	case <-q.Ctx.Done():
		q.Span.AddEvent("호출자 연결 종료 감지")
		q.end(wire.ResultCanceled, "호출자가 연결을 끊어 처리를 중단함")
		return false
	}
}

func (q *Req) reply(status int, body map[string]any) error {
	q.Span.SetAttributes(attribute.Int("http.response.status_code", status))
	q.W.Header().Set("Content-Type", "application/json")
	q.W.WriteHeader(status)
	return json.NewEncoder(q.W).Encode(body)
}

// OK는 정상 응답을 쓴다.
func (q *Req) OK(body map[string]any) {
	if err := q.reply(http.StatusOK, body); err != nil {
		q.end(wire.ResultError, "응답 쓰기 실패: "+err.Error())
		return
	}
	q.end(wire.ResultOK, "")
}

// Fail은 오류 응답을 쓴다.
func (q *Req) Fail(status int, errText string) {
	q.reply(status, map[string]any{"error": errText})
	q.end(wire.ResultHTTPError, errText)
}

// Begin은 요청을 받아 span을 열고, 이 서비스에 걸린 장애(줄 세우기, 오류 응답)를 실제로 적용한다.
// ok가 false면 이미 응답을 끝낸 것이다. done은 항상 defer로 부른다.
func (s *Server) Begin(w http.ResponseWriter, r *http.Request, name string) (q *Req, done func(), ok bool) {
	p := wire.ParsePolicy(r.Header)
	ctx := tele.Propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
	ctx, span := s.Tracer.Start(ctx, name, trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(
		attribute.String("http.request.method", r.Method), attribute.String("url.path", r.URL.Path),
		attribute.String("network.peer.address", r.RemoteAddr)))
	q = &Req{Ctx: ctx, Span: span, P: p, Fault: p.Faults[s.ID], W: w}
	leave := func() {}
	done = func() { leave(); span.End() }

	s.mu.Lock()
	fresh := p.Run != "" && p.Run != s.run
	if fresh {
		s.run = p.Run
	}
	s.mu.Unlock()
	if fresh && s.Reset != nil {
		s.Reset()
	}
	if q.Fault.ID != "" {
		span.SetAttributes(attribute.String("lab.fault_ids", q.Fault.ID))
	}
	slots := s.Slots
	if q.Fault.Slots > 0 {
		slots = q.Fault.Slots
	}
	if slots > 0 {
		span.SetAttributes(attribute.Int("lab.slots", slots))
		span.AddEvent("처리 순서 대기")
		began := time.Now()
		got := s.line.enter(ctx, slots)
		span.SetAttributes(attribute.Int64("lab.queue_ms", time.Since(began).Milliseconds()))
		if !got {
			span.AddEvent("호출자 연결 종료 감지")
			q.end(wire.ResultCanceled, "처리 순서를 기다리는 중 호출자가 연결을 끊음")
			return q, done, false
		}
		leave = s.line.leave
		span.AddEvent("처리 시작")
	}
	if q.Fault.FailPercent > 0 {
		span.SetAttributes(attribute.Int("lab.fail_percent", q.Fault.FailPercent))
		if rand.IntN(100) < q.Fault.FailPercent {
			span.AddEvent("오류 응답 반환")
			q.Fail(http.StatusInternalServerError, "HTTP 500으로 응답함 (서비스 오류 장애)")
			return q, done, false
		}
	}
	return q, done, true
}

// Dep은 이 서비스가 부르는 다른 서비스다. URL은 장애 주입 프록시의 주소다.
type Dep struct {
	ID   string
	Name string
	URL  *url.URL
}

func NewDep(id, name, env, def string) Dep {
	u, err := url.Parse(Env(env, def))
	if err != nil {
		log.Fatal(err)
	}
	return Dep{ID: id, Name: name, URL: u}
}

// Client는 시도마다 새 연결을 쓴다. 연결을 재사용하면 net/http가 끊긴 연결에서 자동 재시도할 수 있어
// 화면의 시도 횟수와 실제 호출 횟수가 어긋난다.
func Client() *http.Client {
	return &http.Client{Transport: &http.Transport{DisableKeepAlives: true, Proxy: nil}}
}

type Outcome struct {
	Result, Err string
	Body        map[string]any
}

type Call struct {
	Dep     Dep
	Method  string
	Path    string
	Op      string // 같은 연결에서 하는 일이 여럿일 때 구분하는 이름
	Attempt int
	Header  http.Header
}

// Do는 호출 한 번을 client span 하나로 기록한다. 연결한 실제 주소를 남겨 프록시 통과 여부를 확인할 수 있게 한다.
func Do(parent context.Context, tr trace.Tracer, hc *http.Client, p wire.Policy, c Call) (out Outcome) {
	ctx, span := tr.Start(parent, c.Method+" "+c.Path, trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(
		attribute.String("peer.service", c.Dep.ID), attribute.String("http.request.method", c.Method),
		attribute.String("server.address", c.Dep.URL.Hostname()), attribute.String("server.port", c.Dep.URL.Port()),
		attribute.Int("lab.attempt", c.Attempt), attribute.Int64("lab.timeout_ms", p.CallTimeout.Milliseconds())))
	if c.Attempt > 1 {
		span.SetAttributes(attribute.Int("http.request.resend_count", c.Attempt-1))
	}
	if c.Op != "" {
		span.SetAttributes(attribute.String("lab.op", c.Op))
	}
	if f := p.Faults[c.Dep.ID]; f.ID != "" {
		span.SetAttributes(attribute.String("lab.fault_ids", f.ID))
	}
	defer func() {
		span.SetAttributes(attribute.String("lab.result", out.Result))
		if out.Err != "" {
			span.SetAttributes(attribute.String("lab.error", out.Err), attribute.String("error.type", out.Result))
		}
		span.End()
	}()
	ctx, cancel := context.WithTimeout(ctx, p.CallTimeout)
	defer cancel()
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		GotConn: func(i httptrace.GotConnInfo) {
			span.SetAttributes(attribute.String("lab.conn.local", i.Conn.LocalAddr().String()),
				attribute.String("lab.conn.remote", i.Conn.RemoteAddr().String()))
			span.AddEvent("연결 확보")
		},
		WroteRequest: func(i httptrace.WroteRequestInfo) {
			if i.Err == nil {
				span.SetAttributes(attribute.Bool("lab.request_written", true))
				span.AddEvent("요청 전송 완료")
			}
		},
		GotFirstResponseByte: func() { span.AddEvent("응답 첫 바이트 수신") },
	})
	u := *c.Dep.URL
	if i := strings.IndexByte(c.Path, '?'); i >= 0 {
		u.Path, u.RawQuery = c.Path[:i], c.Path[i+1:]
	} else {
		u.Path = c.Path
	}
	req, _ := http.NewRequestWithContext(ctx, c.Method, u.String(), nil)
	p.Apply(req.Header)
	for k, v := range c.Header {
		req.Header[k] = v
	}
	tele.Propagator.Inject(ctx, propagation.HeaderCarrier(req.Header))

	resp, err := hc.Do(req)
	if err == nil {
		defer resp.Body.Close()
		span.SetAttributes(attribute.Int("http.response.status_code", resp.StatusCode))
		err = json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&out.Body)
		if err == nil && resp.StatusCode != 200 {
			return Outcome{Result: wire.ResultHTTPError, Err: c.Dep.Name + " 응답 상태 " + resp.Status}
		}
	}
	if err == nil {
		out.Result = wire.ResultOK
		return out
	}
	var ne net.Error
	switch {
	case parent.Err() != nil:
		return Outcome{Result: wire.ResultCanceled, Err: "상위 요청이 취소되어 호출을 중단함"}
	case errors.Is(ctx.Err(), context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()):
		return Outcome{Result: wire.ResultTimeout, Err: "호출 타임아웃 " + p.CallTimeout.String() + " 초과"}
	case errors.Is(err, syscall.ECONNREFUSED):
		return Outcome{Result: wire.ResultRefused, Err: "연결 거부: " + err.Error()}
	case errors.Is(err, syscall.ECONNRESET), errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return Outcome{Result: wire.ResultReset, Err: "응답 전에 연결이 끊김: " + err.Error()}
	}
	return Outcome{Result: wire.ResultError, Err: err.Error()}
}
