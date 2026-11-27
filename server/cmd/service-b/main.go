// Service B: 정해진 시간 동안 처리한 뒤 응답하고, 호출자가 끊으면 작업을 중단한다.
// 요청 헤더가 지시하면 동시에 처리하는 수를 줄이거나 오류로 응답한다. 실제로 그렇게 동작하며 결과를 꾸미지 않는다.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"breaklab/internal/tele"
	"breaklab/internal/wire"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

func env(k, d string) string {
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

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	tracer, shutdown, err := tele.Setup(ctx, "service-b", env("LAB_TELEMETRY_URL", "http://127.0.0.1:7701"))
	if err != nil {
		log.Fatal(err)
	}
	var handled atomic.Int64
	line := &gate{wake: make(chan struct{})}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "ok") })
	mux.HandleFunc("GET /stock", func(w http.ResponseWriter, r *http.Request) {
		p := wire.ParsePolicy(r.Header)
		ctx := tele.Propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := tracer.Start(ctx, "GET /stock", trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(
			attribute.String("http.request.method", "GET"), attribute.String("url.path", "/stock"),
			attribute.String("network.peer.address", r.RemoteAddr), attribute.Int64("lab.work_ms", p.Work.Milliseconds())))
		defer span.End()
		if p.Faults != "" {
			span.SetAttributes(attribute.String("lab.fault_ids", p.Faults))
		}
		if p.Slots > 0 {
			span.SetAttributes(attribute.Int("lab.slots", p.Slots))
			span.AddEvent("처리 순서 대기")
			began := time.Now()
			if !line.enter(ctx, p.Slots) {
				span.AddEvent("호출자 연결 종료 감지")
				span.SetAttributes(attribute.String("lab.result", wire.ResultCanceled),
					attribute.String("lab.error", "처리 순서를 기다리는 중 호출자가 연결을 끊음"),
					attribute.Int64("lab.queue_ms", time.Since(began).Milliseconds()))
				return
			}
			defer line.leave()
			span.SetAttributes(attribute.Int64("lab.queue_ms", time.Since(began).Milliseconds()))
		}
		if p.FailPercent > 0 {
			span.SetAttributes(attribute.Int("lab.fail_percent", p.FailPercent))
			if rand.IntN(100) < p.FailPercent {
				span.AddEvent("오류 응답 반환")
				span.SetAttributes(attribute.String("lab.result", wire.ResultHTTPError), attribute.Int("http.response.status_code", 500),
					attribute.String("lab.error", "B가 HTTP 500으로 응답함 (서비스 오류 장애)"))
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(map[string]any{"error": "internal"})
				return
			}
		}
		span.AddEvent("재고 조회 시작")
		select {
		case <-time.After(p.Work):
		case <-ctx.Done():
			span.AddEvent("호출자 연결 종료 감지")
			span.SetAttributes(attribute.String("lab.result", wire.ResultCanceled),
				attribute.String("lab.error", "호출자가 연결을 끊어 처리를 중단함"))
			return
		}
		span.AddEvent("재고 조회 완료")
		w.Header().Set("Content-Type", "application/json")
		err := json.NewEncoder(w).Encode(map[string]any{"sku": "LAB-001", "stock": 42, "served": handled.Add(1)})
		if err != nil {
			span.SetAttributes(attribute.String("lab.result", wire.ResultError), attribute.String("lab.error", "응답 쓰기 실패: "+err.Error()))
			return
		}
		span.SetAttributes(attribute.String("lab.result", wire.ResultOK), attribute.Int("http.response.status_code", 200))
	})
	srv := &http.Server{Addr: env("LISTEN", "127.0.0.1:7720"), Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(c)
		shutdown(c)
	}()
	log.Printf("service-b 수신 %s", srv.Addr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
