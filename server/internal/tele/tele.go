// Package tele는 OpenTelemetry SDK 설정과, 진행 중 요청을 보여 주기 위한 span 시작 알림을 담당한다.
// 완료된 span은 표준 OTLP/HTTP 내보내기로만 전송한다. 시작 알림은 결과 판정에 쓰지 않는다.
package tele

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync/atomic"
	"time"

	"breaklab/internal/model"
	"breaklab/internal/wire"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

var Propagator = propagation.TraceContext{}

// FromReadOnly는 SDK span을 내부 형식으로 바꾼다.
func FromReadOnly(s sdktrace.ReadOnlySpan, service string) model.Span {
	out := model.Span{
		TraceID: s.SpanContext().TraceID().String(), SpanID: s.SpanContext().SpanID().String(),
		Service: service, Kind: s.SpanKind().String(), Name: s.Name(),
		StartUs: s.StartTime().UnixMicro(), Result: wire.ResultRunning, Attrs: map[string]string{},
	}
	if s.Parent().HasSpanID() {
		out.ParentID = s.Parent().SpanID().String()
	}
	if !s.EndTime().IsZero() {
		out.EndUs = s.EndTime().UnixMicro()
	}
	for _, kv := range s.Attributes() {
		out.Attrs[string(kv.Key)] = kv.Value.Emit()
	}
	for _, e := range s.Events() {
		ev := model.SpanEvent{AtUs: e.Time.UnixMicro(), Name: e.Name, Attrs: map[string]string{}}
		for _, kv := range e.Attributes {
			ev.Attrs[string(kv.Key)] = kv.Value.Emit()
		}
		out.Events = append(out.Events, ev)
	}
	if out.EndUs > 0 {
		out.Result = out.Attrs["lab.result"]
		out.Error = out.Attrs["lab.error"]
	}
	return out
}

type notifier struct {
	service string
	base    string
	ch      chan model.Span
	dropped atomic.Int64
	errs    *atomic.Int64
	client  *http.Client
}

func (n *notifier) OnStart(_ context.Context, s sdktrace.ReadWriteSpan) {
	select {
	case n.ch <- FromReadOnly(s, n.service):
	default:
		n.dropped.Add(1)
	}
}
func (n *notifier) OnEnd(sdktrace.ReadOnlySpan)      {}
func (n *notifier) Shutdown(context.Context) error   { return nil }
func (n *notifier) ForceFlush(context.Context) error { return nil }

func (n *notifier) post(path string, v any) {
	b, _ := json.Marshal(v)
	resp, err := n.client.Post(n.base+path, "application/json", bytes.NewReader(b))
	if err != nil {
		n.errs.Add(1)
		return
	}
	resp.Body.Close()
}

func (n *notifier) loop() {
	beat := time.NewTicker(2 * time.Second)
	n.beat()
	for {
		select {
		case s := <-n.ch:
			n.post("/telemetry/span-start", s)
		case <-beat.C:
			n.beat()
		}
	}
}

func (n *notifier) beat() {
	n.post("/telemetry/heartbeat", wire.Heartbeat{Service: n.service, ExportErrors: n.errs.Load(), NotifyDropped: n.dropped.Load()})
}

// Setup은 관측 경로(managerURL)로만 데이터를 보내는 tracer를 만든다. 관측 실패는 요청 처리에 영향을 주지 않는다.
func Setup(ctx context.Context, service, managerURL string) (trace.Tracer, func(context.Context) error, error) {
	errs := &atomic.Int64{}
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		errs.Add(1)
		log.Printf("관측 내보내기 오류: %v", err)
	}))
	exp, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpointURL(managerURL+"/v1/traces"),
		otlptracehttp.WithTimeout(2*time.Second))
	if err != nil {
		return nil, nil, err
	}
	n := &notifier{service: service, base: managerURL, ch: make(chan model.Span, 512), errs: errs,
		client: &http.Client{Timeout: time.Second}}
	go n.loop()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", service))),
		sdktrace.WithSpanProcessor(n),
		sdktrace.WithBatcher(exp, sdktrace.WithBatchTimeout(100*time.Millisecond)),
	)
	return tp.Tracer("breaklab"), tp.Shutdown, nil
}
