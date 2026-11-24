// Service B: 정해진 시간 동안 처리한 뒤 응답하고, 호출자가 끊으면 작업을 중단한다.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
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

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	tracer, shutdown, err := tele.Setup(ctx, "service-b", env("LAB_TELEMETRY_URL", "http://127.0.0.1:7701"))
	if err != nil {
		log.Fatal(err)
	}
	var handled atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "ok") })
	mux.HandleFunc("GET /stock", func(w http.ResponseWriter, r *http.Request) {
		p := wire.ParsePolicy(r.Header)
		ctx := tele.Propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := tracer.Start(ctx, "GET /stock", trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(
			attribute.String("http.request.method", "GET"), attribute.String("url.path", "/stock"),
			attribute.String("network.peer.address", r.RemoteAddr), attribute.Int64("lab.work_ms", p.Work.Milliseconds())))
		defer span.End()
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
