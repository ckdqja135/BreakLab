// Service A: 요청을 받아 프록시를 거쳐 Service B를 호출한다.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"os/signal"
	"strconv"
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

type server struct {
	tracer trace.Tracer
	bURL   *url.URL
	client *http.Client
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	tracer, shutdown, err := tele.Setup(ctx, "service-a", env("LAB_TELEMETRY_URL", "http://127.0.0.1:7701"))
	if err != nil {
		log.Fatal(err)
	}
	b, err := url.Parse(env("B_URL", "http://127.0.0.1:7721"))
	if err != nil {
		log.Fatal(err)
	}
	s := &server{tracer: tracer, bURL: b, client: &http.Client{
		// 연결을 재사용하면 net/http가 끊긴 연결에서 자동 재시도할 수 있다.
		// 화면의 시도 횟수와 실제 호출 횟수를 맞추기 위해 시도마다 새 연결을 쓴다.
		Transport: &http.Transport{DisableKeepAlives: true, Proxy: nil},
	}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /order", s.order)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "ok") })
	srv := &http.Server{Addr: env("LISTEN", "127.0.0.1:7710"), Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(c)
		shutdown(c)
	}()
	log.Printf("service-a 수신 %s, B 호출 주소 %s", srv.Addr, b)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func (s *server) order(w http.ResponseWriter, r *http.Request) {
	p := wire.ParsePolicy(r.Header)
	ctx := tele.Propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
	ctx, span := s.tracer.Start(ctx, "GET /order", trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(
		attribute.String("http.request.method", "GET"), attribute.String("url.path", "/order"),
		attribute.String("network.peer.address", r.RemoteAddr),
		attribute.Int64("lab.call_timeout_ms", p.CallTimeout.Milliseconds()),
		attribute.Int("lab.max_attempts", p.MaxAttempts)))
	defer span.End()

	finish := func(status int, result, errText string, attempts int, body map[string]any) {
		span.SetAttributes(attribute.String("lab.result", result), attribute.Int("lab.attempts", attempts))
		if errText != "" {
			span.SetAttributes(attribute.String("lab.error", errText))
		}
		if status == 0 {
			return
		}
		span.SetAttributes(attribute.Int("http.response.status_code", status))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(body)
	}

	var last outcome
	for i := 1; i <= p.MaxAttempts; i++ {
		last = s.callB(ctx, p, i)
		if last.result == wire.ResultOK {
			finish(200, wire.ResultOK, "", i, map[string]any{"order": "accepted", "stock": last.body, "attempts": i})
			return
		}
		if ctx.Err() != nil {
			finish(0, wire.ResultCanceled, "요청자가 연결을 끊어 처리를 중단함", i, nil)
			return
		}
		if i < p.MaxAttempts {
			span.AddEvent("재시도 대기", trace.WithAttributes(attribute.Int64("ms", p.Backoff.Milliseconds())))
			select {
			case <-time.After(p.Backoff):
			case <-ctx.Done():
				finish(0, wire.ResultCanceled, "재시도 대기 중 요청자가 연결을 끊음", i, nil)
				return
			}
		}
	}
	status := http.StatusBadGateway
	if last.result == wire.ResultTimeout {
		status = http.StatusGatewayTimeout
	}
	finish(status, wire.ResultHTTPError, "B 호출 실패: "+last.err, p.MaxAttempts,
		map[string]any{"error": last.result, "message": "B 호출 실패: " + last.err, "attempts": p.MaxAttempts})
}

type outcome struct {
	result, err string
	body        map[string]any
}

func (s *server) callB(parent context.Context, p wire.Policy, attempt int) (out outcome) {
	ctx, span := s.tracer.Start(parent, "GET /stock", trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(
		attribute.String("peer.service", "service-b"), attribute.String("http.request.method", "GET"),
		attribute.String("server.address", s.bURL.Hostname()), attribute.String("server.port", s.bURL.Port()),
		attribute.Int("lab.attempt", attempt), attribute.Int64("lab.timeout_ms", p.CallTimeout.Milliseconds())))
	if attempt > 1 {
		span.SetAttributes(attribute.Int("http.request.resend_count", attempt-1))
	}
	defer func() {
		span.SetAttributes(attribute.String("lab.result", out.result))
		if out.err != "" {
			span.SetAttributes(attribute.String("lab.error", out.err), attribute.String("error.type", out.result))
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
	req, _ := http.NewRequestWithContext(ctx, "GET", s.bURL.JoinPath("/stock").String(), nil)
	req.Header.Set(wire.HeaderWork, strconv.FormatInt(p.Work.Milliseconds(), 10))
	p.ApplyService(req.Header)
	if p.Faults != "" {
		span.SetAttributes(attribute.String("lab.fault_ids", p.Faults))
	}
	tele.Propagator.Inject(ctx, propagation.HeaderCarrier(req.Header))

	resp, err := s.client.Do(req)
	if err == nil {
		defer resp.Body.Close()
		span.SetAttributes(attribute.Int("http.response.status_code", resp.StatusCode))
		err = json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&out.body)
		if err == nil && resp.StatusCode != 200 {
			return outcome{result: wire.ResultHTTPError, err: "B 응답 상태 " + resp.Status}
		}
	}
	if err == nil {
		out.result = wire.ResultOK
		return out
	}
	return classify(parent, ctx, p, err)
}

func classify(parent, ctx context.Context, p wire.Policy, err error) outcome {
	var ne net.Error
	switch {
	case parent.Err() != nil:
		return outcome{result: wire.ResultCanceled, err: "상위 요청이 취소되어 호출을 중단함"}
	case errors.Is(ctx.Err(), context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()):
		return outcome{result: wire.ResultTimeout, err: "호출 타임아웃 " + p.CallTimeout.String() + " 초과"}
	case errors.Is(err, syscall.ECONNREFUSED):
		return outcome{result: wire.ResultRefused, err: "연결 거부: " + err.Error()}
	case errors.Is(err, syscall.ECONNRESET), errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return outcome{result: wire.ResultReset, err: "응답 전에 연결이 끊김: " + err.Error()}
	}
	return outcome{result: wire.ResultError, err: err.Error()}
}
