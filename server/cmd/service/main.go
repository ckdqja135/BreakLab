// service: A가 부르는 서비스들. ROLE로 역할을 정한다.
// stock(재고, Service B), auth(인증), pay(결제), cache(캐시), db(상품 DB), queue(큐), worker(작업자)
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"breaklab/internal/svc"
	"breaklab/internal/tele"
	"breaklab/internal/wire"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
)

const ms = time.Millisecond

func main() {
	role := svc.Env("ROLE", "stock")
	id, setup := "", (func(context.Context, *svc.Server))(nil)
	switch role {
	case "stock":
		id, setup = "service-b", stock
	case "auth":
		id, setup = "auth", auth
	case "pay":
		id, setup = "pay", pay
	case "cache":
		id, setup = "cache", cache
	case "db":
		id, setup = "db", db
	case "queue":
		id, setup = "queue", queue
	case "worker":
		id, setup = "worker", worker
	default:
		log.Fatalf("알 수 없는 ROLE: %s", role)
	}
	svc.Main(id, "127.0.0.1:7720", setup)
}

// 재고: 실험 조건의 처리 시간만큼 일한 뒤 응답한다.
func stock(_ context.Context, s *svc.Server) {
	s.Mux.HandleFunc("GET /stock", func(w http.ResponseWriter, r *http.Request) {
		q, done, ok := s.Begin(w, r, "GET /stock")
		defer done()
		if !ok {
			return
		}
		work := q.WorkOr(q.P.Work)
		q.Span.SetAttributes(attribute.Int64("lab.work_ms", work.Milliseconds()))
		q.Span.AddEvent("재고 조회 시작")
		if !q.Wait(work) {
			return
		}
		q.Span.AddEvent("재고 조회 완료")
		q.OK(map[string]any{"sku": "LAB-001", "stock": 42})
	})
}

// 인증: 모든 주문이 먼저 거친다.
func auth(_ context.Context, s *svc.Server) {
	s.Mux.HandleFunc("GET /verify", func(w http.ResponseWriter, r *http.Request) {
		q, done, ok := s.Begin(w, r, "GET /verify")
		defer done()
		if !ok {
			return
		}
		q.Span.AddEvent("손님 확인 시작")
		if !q.Wait(q.WorkOr(10 * ms)) {
			return
		}
		q.OK(map[string]any{"user": "guest", "valid": true})
	})
}

// 결제: 느린 외부 결제사를 흉내 낸다. 멱등 키가 오면 같은 주문을 두 번 결제하지 않는다.
func pay(_ context.Context, s *svc.Server) {
	var mu sync.Mutex
	charges := 0
	seen := map[string]bool{}
	s.Reset = func() { mu.Lock(); charges, seen = 0, map[string]bool{}; mu.Unlock() }
	s.Gauges = func() []wire.Gauge {
		mu.Lock()
		defer mu.Unlock()
		return []wire.Gauge{{Label: "실제 결제", Value: fmt.Sprintf("%d건", charges)}}
	}
	s.Mux.HandleFunc("GET /charge", func(w http.ResponseWriter, r *http.Request) {
		q, done, ok := s.Begin(w, r, "GET /charge")
		defer done()
		if !ok {
			return
		}
		key := r.Header.Get(wire.HeaderIdemKey)
		mu.Lock()
		dup := key != "" && seen[key]
		mu.Unlock()
		if dup {
			q.Span.SetAttributes(attribute.Bool("lab.dedup", true))
			q.Span.AddEvent("같은 주문 확인, 다시 결제하지 않음")
			q.OK(map[string]any{"paid": true, "duplicate": true})
			return
		}
		q.Span.AddEvent("결제 승인 요청")
		if !q.Wait(q.WorkOr(300 * ms)) {
			return
		}
		mu.Lock()
		charges++
		if key != "" {
			seen[key] = true
		}
		mu.Unlock()
		q.Span.SetAttributes(attribute.Bool("lab.charged", true))
		q.Span.AddEvent("결제 완료")
		q.OK(map[string]any{"paid": true})
	})
}

// 캐시: 메모리에 값을 둔다. 실험이 바뀌면 비운다.
func cache(_ context.Context, s *svc.Server) {
	var mu sync.Mutex
	items := map[string]bool{}
	hits, misses := 0, 0
	s.Reset = func() { mu.Lock(); items, hits, misses = map[string]bool{}, 0, 0; mu.Unlock() }
	s.Gauges = func() []wire.Gauge {
		mu.Lock()
		defer mu.Unlock()
		return []wire.Gauge{{Label: "캐시에서 찾음", Value: fmt.Sprintf("%d/%d번", hits, hits+misses)}}
	}
	s.Mux.HandleFunc("GET /get", func(w http.ResponseWriter, r *http.Request) {
		q, done, ok := s.Begin(w, r, "GET /get")
		defer done()
		if !ok || !q.Wait(q.WorkOr(2*ms)) {
			return
		}
		mu.Lock()
		hit := items[r.URL.Query().Get("key")]
		if hit {
			hits++
		} else {
			misses++
		}
		mu.Unlock()
		q.Span.SetAttributes(attribute.Bool("lab.cache_hit", hit))
		q.OK(map[string]any{"hit": hit})
	})
	s.Mux.HandleFunc("POST /set", func(w http.ResponseWriter, r *http.Request) {
		q, done, ok := s.Begin(w, r, "POST /set")
		defer done()
		if !ok || !q.Wait(q.WorkOr(2*ms)) {
			return
		}
		mu.Lock()
		items[r.URL.Query().Get("key")] = true
		mu.Unlock()
		q.OK(map[string]any{"stored": true})
	})
}

// 상품 DB: 작은 DB라서 한 번에 하나씩만, 하나에 250ms가 걸린다.
func db(_ context.Context, s *svc.Server) {
	s.Slots = 1
	s.Mux.HandleFunc("GET /product", func(w http.ResponseWriter, r *http.Request) {
		q, done, ok := s.Begin(w, r, "GET /product")
		defer done()
		if !ok {
			return
		}
		q.Span.AddEvent("상품 조회 시작")
		if !q.Wait(q.WorkOr(250 * ms)) {
			return
		}
		q.OK(map[string]any{"id": r.URL.Query().Get("id"), "name": "실험용 상품"})
	})
}

type job struct {
	header http.Header // 추적 정보와 실험 조건
	at     time.Time
}

// 큐: 받은 작업을 쌓아 두고 작업자에게 하나씩 넘긴다. 넘기지 못하면 잠시 뒤 같은 작업을 다시 넘긴다.
func queue(ctx context.Context, s *svc.Server) {
	worker := svc.NewDep("worker", "작업자", "WORKER_URL", "http://127.0.0.1:7791")
	hc := svc.Client()
	var mu sync.Mutex
	var jobs []job
	epoch, sent := 0, 0
	wake := make(chan struct{}, 1)
	s.Reset = func() { mu.Lock(); jobs, sent = nil, 0; epoch++; mu.Unlock() }
	s.Gauges = func() []wire.Gauge {
		mu.Lock()
		defer mu.Unlock()
		g := []wire.Gauge{{Label: "밀린 작업", Value: fmt.Sprintf("%d개", len(jobs)), Alert: len(jobs) > 2}}
		if len(jobs) > 0 {
			g = append(g, wire.Gauge{Label: "가장 오래 기다린 작업", Value: fmt.Sprintf("%.1f초", time.Since(jobs[0].at).Seconds()), Alert: time.Since(jobs[0].at) > 3*time.Second})
		}
		return append(g, wire.Gauge{Label: "넘긴 작업", Value: fmt.Sprintf("%d개", sent)})
	}
	s.Mux.HandleFunc("POST /enqueue", func(w http.ResponseWriter, r *http.Request) {
		q, done, ok := s.Begin(w, r, "POST /enqueue")
		defer done()
		if !ok || !q.Wait(q.WorkOr(2*ms)) {
			return
		}
		h := http.Header{}
		q.P.Apply(h)
		tele.Propagator.Inject(q.Ctx, propagation.HeaderCarrier(h))
		mu.Lock()
		full := len(jobs) >= 1000
		if !full {
			jobs = append(jobs, job{header: h, at: time.Now()})
		}
		n := len(jobs)
		mu.Unlock()
		if full {
			q.Fail(http.StatusServiceUnavailable, "큐가 가득 참")
			return
		}
		q.Span.SetAttributes(attribute.Int("lab.queue_depth", n))
		q.Span.AddEvent("작업 저장")
		select {
		case wake <- struct{}{}:
		default:
		}
		q.OK(map[string]any{"queued": true, "depth": n})
	})
	go func() {
		for attempt := 1; ; {
			mu.Lock()
			var head *job
			if len(jobs) > 0 {
				j := jobs[0]
				head = &j
			}
			was := epoch
			mu.Unlock()
			if head == nil {
				attempt = 1
				select {
				case <-wake:
				case <-time.After(200 * ms):
				case <-ctx.Done():
					return
				}
				continue
			}
			p := wire.ParsePolicy(head.header)
			p.CallTimeout = 2 * time.Second
			parent := tele.Propagator.Extract(ctx, propagation.HeaderCarrier(head.header))
			out := svc.Do(parent, s.Tracer, hc, p, svc.Call{Dep: worker, Method: "POST", Path: "/notify", Attempt: attempt})
			mu.Lock()
			if was != epoch { // 그사이 실험이 바뀌어 큐를 비웠다.
				mu.Unlock()
				attempt = 1
				continue
			}
			if out.Result == wire.ResultOK {
				jobs, sent, attempt = jobs[1:], sent+1, 1
				mu.Unlock()
				continue
			}
			mu.Unlock()
			attempt++
			select {
			case <-time.After(time.Second):
			case <-ctx.Done():
				return
			}
		}
	}()
}

// 작업자: 큐가 넘긴 알림 작업을 처리한다.
func worker(_ context.Context, s *svc.Server) {
	var mu sync.Mutex
	done := 0
	s.Reset = func() { mu.Lock(); done = 0; mu.Unlock() }
	s.Gauges = func() []wire.Gauge {
		mu.Lock()
		defer mu.Unlock()
		return []wire.Gauge{{Label: "보낸 알림", Value: fmt.Sprintf("%d건", done)}}
	}
	s.Mux.HandleFunc("POST /notify", func(w http.ResponseWriter, r *http.Request) {
		q, fin, ok := s.Begin(w, r, "POST /notify")
		defer fin()
		if !ok {
			return
		}
		q.Span.AddEvent("알림 발송 시작")
		if !q.Wait(q.WorkOr(300 * ms)) {
			return
		}
		mu.Lock()
		done++
		mu.Unlock()
		q.Span.AddEvent("알림 발송 완료")
		q.OK(map[string]any{"notified": true})
	})
}
