// Service A: 손님의 요청을 받아 다른 서비스들을 차례로 부른다. 모든 호출은 장애 주입 프록시를 거친다.
package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"time"

	"breaklab/internal/svc"
	"breaklab/internal/wire"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

type hub struct {
	s      *svc.Server
	client *http.Client
	deps   map[string]svc.Dep

	mu        sync.Mutex
	authRun   string
	authUntil time.Time           // 이 시각까지는 앞서 확인한 인증 결과를 다시 쓴다
	guard     map[string]*breaker // 서비스 ID별 서킷 브레이커
	flying    map[string]int      // 서비스 ID별로 지금 답을 기다리는 호출 수
}

// breaker는 한 서비스가 연달아 실패하면 잠시 부르지 않게 한다.
// 쉬는 시간이 지나면 시험 삼아 한 번만 불러 보고, 성공하면 다시 평소대로 부른다.
type breaker struct {
	fails int
	until time.Time // 이 시각까지 부르지 않는다. 비어 있으면 닫힌 상태
	trial bool      // 시험 호출이 나가 있다
}

const breakAfter = 3

// allow는 지금 이 서비스를 불러도 되는지 답한다.
func (h *hub) allow(dep string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	b := h.guard[dep]
	if b == nil || b.until.IsZero() {
		return true
	}
	if time.Now().Before(b.until) || b.trial {
		return false
	}
	b.trial = true
	return true
}

func (h *hub) record(dep string, ok bool, sec int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	b := h.guard[dep]
	if b == nil {
		b = &breaker{}
		h.guard[dep] = b
	}
	if ok {
		*b = breaker{}
		return
	}
	if b.fails++; b.trial || b.fails >= breakAfter {
		*b = breaker{until: time.Now().Add(time.Duration(sec) * time.Second)}
	}
}

// enter는 한 서비스에 동시에 보내는 호출 수를 센다. 한도를 넘으면 false를 돌려준다.
func (h *hub) enter(dep string, limit int) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.flying[dep] >= limit {
		return false
	}
	h.flying[dep]++
	return true
}

func (h *hub) leave(dep string) {
	h.mu.Lock()
	h.flying[dep]--
	h.mu.Unlock()
}

// gauges는 지금 열려 있는 서킷을 알려 준다.
func (h *hub) gauges() []wire.Gauge {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []wire.Gauge
	for _, d := range h.deps {
		if b := h.guard[d.ID]; b != nil && time.Now().Before(b.until) {
			out = append(out, wire.Gauge{Label: "서킷 열림", Value: fmt.Sprintf("%s, %.0f초 남음", d.Name, time.Until(b.until).Seconds()), Alert: true})
		}
	}
	return out
}

func main() {
	svc.Main("service-a", "127.0.0.1:7710", func(_ context.Context, s *svc.Server) {
		h := &hub{s: s, client: svc.Client(), guard: map[string]*breaker{}, flying: map[string]int{}, deps: map[string]svc.Dep{
			"stock":  svc.NewDep("service-b", "B", "B_URL", "http://127.0.0.1:7721"),
			"auth":   svc.NewDep("auth", "인증", "AUTH_URL", "http://127.0.0.1:7731"),
			"pay":    svc.NewDep("pay", "결제", "PAY_URL", "http://127.0.0.1:7741"),
			"cache":  svc.NewDep("cache", "캐시", "CACHE_URL", "http://127.0.0.1:7751"),
			"db":     svc.NewDep("db", "DB", "DB_URL", "http://127.0.0.1:7761"),
			"notify": svc.NewDep("queue", "큐", "QUEUE_URL", "http://127.0.0.1:7771"),
		}}
		s.Reset = func() {
			h.mu.Lock()
			h.authRun, h.authUntil, h.guard = "", time.Time{}, map[string]*breaker{}
			h.mu.Unlock()
		}
		s.Gauges = h.gauges
		s.Mux.HandleFunc("GET /order", h.order)
		s.Mux.HandleFunc("GET /product", h.product)
	})
}

// work는 요청 하나를 처리하는 동안의 상태다.
type work struct {
	h        *hub
	q        *svc.Req
	attempts int      // 다른 서비스를 부른 횟수. 관리 서버가 빠진 관측을 찾는 데 쓴다
	degraded []string // 실패했지만 건너뛰고 임시로 접수한 서비스
}

func (h *hub) begin(w http.ResponseWriter, r *http.Request, name string) (*work, func(), bool) {
	q, done, ok := h.s.Begin(w, r, name)
	q.Span.SetAttributes(attribute.Int64("lab.call_timeout_ms", q.P.CallTimeout.Milliseconds()), attribute.Int("lab.max_attempts", q.P.MaxAttempts))
	x := &work{h: h, q: q}
	return x, func() {
		q.Span.SetAttributes(attribute.Int("lab.attempts", x.attempts))
		if len(x.degraded) > 0 {
			q.Span.SetAttributes(attribute.String("lab.degraded", strings.Join(x.degraded, ",")))
		}
		done()
	}, ok
}

// once는 다른 서비스를 한 번 부른다.
func (x *work) once(c svc.Call) svc.Outcome {
	x.attempts++
	return svc.Do(x.q.Ctx, x.h.s.Tracer, x.h.client, x.q.P, c)
}

// skip은 A가 스스로 부르지 않기로 한 일을 기록한다.
func (x *work) skip(d svc.Dep, why string) svc.Outcome {
	x.q.Span.AddEvent("호출 생략", trace.WithAttributes(attribute.String("to", d.ID), attribute.String("why", why)))
	return svc.Outcome{Result: wire.ResultShed, Err: why + "(으)로 부르지 않음"}
}

// try는 실패하면 실험 조건의 횟수만큼 다시 부른다. 방어 장치가 켜져 있으면 부르기 전에 먼저 따른다.
func (x *work) try(c svc.Call) (last svc.Outcome) {
	p, h, id := x.q.P, x.h, c.Dep.ID
	if p.MaxConcurrent > 0 {
		if !h.enter(id, p.MaxConcurrent) {
			return x.skip(c.Dep, "동시 호출 제한")
		}
		defer h.leave(id)
	}
	for i := 1; i <= p.MaxAttempts; i++ {
		if p.BreakerSec > 0 && !h.allow(id) {
			return x.skip(c.Dep, "서킷 열림")
		}
		c.Attempt = i
		last = x.once(c)
		if p.BreakerSec > 0 && x.q.Ctx.Err() == nil {
			h.record(id, last.Result == wire.ResultOK, p.BreakerSec)
		}
		if last.Result == wire.ResultOK || x.q.Ctx.Err() != nil {
			return last
		}
		if i < p.MaxAttempts {
			wait := p.Backoff
			if p.BackoffGrow { // 두 배씩 늘리고, 여럿이 같은 순간에 다시 몰리지 않게 흔든다.
				wait = min(p.Backoff<<(i-1), 5*time.Second)
				wait += time.Duration(rand.Int64N(int64(wait)/2 + 1))
			}
			x.q.Span.AddEvent("재시도 대기", trace.WithAttributes(attribute.Int64("ms", wait.Milliseconds())))
			select {
			case <-time.After(wait):
			case <-x.q.Ctx.Done():
				return last
			}
		}
	}
	return last
}

// soften은 실패한 단계를 건너뛰고 임시로 접수해도 되는지 본다. 인증은 건너뛰지 않는다.
func (x *work) soften(d svc.Dep) bool {
	if !x.q.P.Fallback || d.ID == "auth" || x.q.Ctx.Err() != nil {
		return false
	}
	x.q.Span.AddEvent("대체 응답", trace.WithAttributes(attribute.String("to", d.ID)))
	x.degraded = append(x.degraded, d.ID)
	return true
}

// fail은 다른 서비스 호출이 끝내 실패했을 때 손님에게 오류를 돌려준다.
func (x *work) fail(d svc.Dep, out svc.Outcome) {
	if x.q.Ctx.Err() != nil {
		x.q.Span.SetAttributes(attribute.String("lab.result", wire.ResultCanceled), attribute.String("lab.error", "요청자가 연결을 끊어 처리를 중단함"))
		return
	}
	status := http.StatusBadGateway
	switch out.Result {
	case wire.ResultTimeout:
		status = http.StatusGatewayTimeout
	case wire.ResultShed:
		status = http.StatusServiceUnavailable
	}
	x.q.Fail(status, d.Name+" 호출 실패: "+out.Err)
}

// authorized는 기억해 둔 인증 결과가 아직 유효한지 본다.
func (h *hub) authorized(p wire.Policy) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return p.AuthCacheSec > 0 && h.authRun == p.Run && time.Now().Before(h.authUntil)
}

func (h *hub) order(w http.ResponseWriter, r *http.Request) {
	x, done, ok := h.begin(w, r, "GET /order")
	defer done()
	if !ok {
		return
	}
	p := x.q.P
	for _, step := range strings.Split(p.Flow, ",") {
		d, known := h.deps[step]
		if !known {
			continue
		}
		c := svc.Call{Dep: d, Method: "GET"}
		switch step {
		case "auth":
			if h.authorized(p) {
				x.q.Span.AddEvent("인증 결과 재사용")
				x.q.Span.SetAttributes(attribute.Bool("lab.auth_reused", true))
				continue
			}
			c.Path = "/verify"
		case "stock":
			c.Path = "/stock"
		case "pay":
			c.Path = "/charge"
			if p.Idempotent {
				c.Header = http.Header{wire.HeaderIdemKey: {x.q.Span.SpanContext().TraceID().String()}}
			}
		case "notify":
			c.Method, c.Path = "POST", "/enqueue"
		default:
			continue
		}
		out := x.try(c)
		if out.Result != wire.ResultOK {
			if x.soften(d) {
				continue
			}
			x.fail(d, out)
			return
		}
		if step == "auth" && p.AuthCacheSec > 0 {
			h.mu.Lock()
			h.authRun, h.authUntil = p.Run, time.Now().Add(time.Duration(p.AuthCacheSec)*time.Second)
			h.mu.Unlock()
		}
	}
	if len(x.degraded) > 0 {
		x.q.OK(map[string]any{"order": "pending", "without": x.degraded})
		return
	}
	x.q.OK(map[string]any{"order": "accepted"})
}

// product는 캐시를 먼저 보고, 없거나 캐시를 쓸 수 없으면 DB에서 읽는다.
func (h *hub) product(w http.ResponseWriter, r *http.Request) {
	x, done, ok := h.begin(w, r, "GET /product")
	defer done()
	if !ok {
		return
	}
	id := r.URL.Query().Get("id")
	if len(id) > 8 || strings.ContainsAny(id, "&?/ ") {
		id = "0"
	}
	cache, db := h.deps["cache"], h.deps["db"]
	got := x.once(svc.Call{Dep: cache, Method: "GET", Path: "/get?key=" + id, Op: "get", Attempt: 1})
	if got.Result == wire.ResultOK && got.Body["hit"] == true {
		x.q.Span.SetAttributes(attribute.String("lab.cache", "hit"))
		x.q.OK(map[string]any{"id": id, "from": "cache"})
		return
	}
	state := "miss"
	if got.Result != wire.ResultOK {
		state = "down"
		x.q.Span.AddEvent("캐시를 쓸 수 없어 DB에서 직접 읽음")
	}
	x.q.Span.SetAttributes(attribute.String("lab.cache", state))
	out := x.try(svc.Call{Dep: db, Method: "GET", Path: "/product?id=" + id})
	if out.Result != wire.ResultOK {
		if x.soften(db) {
			x.q.OK(map[string]any{"id": id, "from": "default"})
			return
		}
		x.fail(db, out)
		return
	}
	if state == "miss" { // 다음 손님을 위해 넣어 둔다. 실패해도 이번 응답에는 영향이 없다.
		x.once(svc.Call{Dep: cache, Method: "POST", Path: "/set?key=" + id, Op: "set", Attempt: 1})
	}
	x.q.OK(map[string]any{"id": id, "from": "db"})
}
