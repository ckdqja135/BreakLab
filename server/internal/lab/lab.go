// Package lab은 실험 실행, 요청 발생, 장애 수명 주기, 관측 판정을 묶는다.
package lab

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"sync"
	"syscall"
	"time"

	"breaklab/internal/hub"
	"breaklab/internal/model"
	"breaklab/internal/proxyctl"
	"breaklab/internal/store"
	"breaklab/internal/tele"
	"breaklab/internal/wire"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const (
	generatorID    = "generator"
	injectableEdge = "a-b"
)

// edges는 실험을 허용한 연결 목록이다. API는 이 목록의 ID만 받는다.
var edges = []model.Edge{
	{ID: "gen-a", From: generatorID, To: "service-a", Protocol: "HTTP/1.1"},
	{ID: "a-b", From: "service-a", To: "service-b", Protocol: "HTTP/1.1"},
}

type Config struct {
	AURL, AHealth, BHealth string
}

// Conflict는 현재 상태에서 할 수 없는 요청이다.
type Conflict struct{ Msg string }

func (c Conflict) Error() string { return c.Msg }

// Invalid는 입력값 오류다.
type Invalid struct{ Msg string }

func (c Invalid) Error() string { return c.Msg }

type Lab struct {
	cfg    Config
	st     *store.Store
	hub    *hub.Hub
	px     *proxyctl.Ctl
	reg    *registry
	tracer trace.Tracer
	client *http.Client
	probe  *http.Client
	topo   model.Topology
	limits model.Limits

	opMu sync.Mutex // Toxiproxy 변경을 한 번에 하나씩 처리한다.

	mu           sync.Mutex
	run          *model.Run
	runCtx       context.Context
	runCancel    context.CancelFunc
	repeatCancel context.CancelFunc
	repeat       model.Repeat
	faults       []*model.Fault
	inflight     int
	seq          int
	wg           *sync.WaitGroup
	proxy        model.ProxyState
	services     map[string]*model.ServiceStatus
	storeErr     string
}

func New(cfg Config, st *store.Store, px *proxyctl.Ctl) *Lab {
	es := append([]model.Edge(nil), edges...)
	es[1].Proxy = &model.EdgeProxy{Name: px.Name, Listen: px.Listen, Upstream: px.Upstream, Edges: []string{"a-b"}}
	l := &Lab{
		cfg: cfg, st: st, hub: hub.New(), px: px, limits: model.DefaultLimits,
		client: &http.Client{Transport: &http.Transport{DisableKeepAlives: true, Proxy: nil}},
		probe:  &http.Client{Timeout: time.Second, Transport: &http.Transport{DisableKeepAlives: true, Proxy: nil}},
		topo: model.Topology{Nodes: []model.Node{
			{ID: generatorID, Name: "요청 발생기", Role: "관리 서버 안에서 실제 HTTP 요청을 보냄", Addr: "labd"},
			{ID: "service-a", Name: "Service A", Role: "요청을 받아 B를 호출", Addr: cfg.AURL},
			{ID: "service-b", Name: "Service B", Role: "재고 조회 응답", Addr: "http://" + px.Upstream},
		}, Edges: es},
		services: map[string]*model.ServiceStatus{
			"service-a": {Service: "service-a", Health: "unknown", Telemetry: "never"},
			"service-b": {Service: "service-b", Health: "unknown", Telemetry: "never"},
		},
		wg: &sync.WaitGroup{},
	}
	l.reg = newRegistry(px.Listen, time.Duration(l.limits.ObservationGrace)*time.Millisecond)
	l.tracer = sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rootProcessor{l.reg})).Tracer("breaklab")
	return l
}

func (l *Lab) Hub() *hub.Hub { return l.hub }

// rootProcessor는 요청 발생기의 완료 span을 같은 프로세스 안에서 전달한다.
type rootProcessor struct{ reg *registry }

func (rootProcessor) OnStart(context.Context, sdktrace.ReadWriteSpan) {}
func (p rootProcessor) OnEnd(s sdktrace.ReadOnlySpan)                 { p.reg.add(tele.FromReadOnly(s, generatorID)) }
func (rootProcessor) Shutdown(context.Context) error                  { return nil }
func (rootProcessor) ForceFlush(context.Context) error                { return nil }

func newID() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// save는 저장 실패가 실험 중지 경로를 막지 않도록 오류를 상태로만 남긴다.
func (l *Lab) save(err error) {
	if err == nil {
		return
	}
	log.Printf("저장 오류: %v", err)
	l.mu.Lock()
	l.storeErr = err.Error()
	l.mu.Unlock()
	l.hub.Publish("notice", map[string]string{"storeError": err.Error()})
}

func (l *Lab) event(runID, typ, detail string) {
	e := model.Event{RunID: runID, AtUs: model.NowUs(), Type: typ, Detail: detail}
	l.save(l.st.AddEvent(e))
	l.hub.Publish("event", e)
}

func (l *Lab) publishRun() {
	l.mu.Lock()
	var r *model.Run
	if l.run != nil {
		c := *l.run
		r = &c
	}
	rep := l.repeat
	l.mu.Unlock()
	if r != nil {
		l.save(l.st.SaveRun(*r))
	}
	l.hub.Publish("run", map[string]any{"run": r, "repeat": rep})
}

func (l *Lab) publishFault(f model.Fault) {
	l.save(l.st.SaveFault(f))
	l.hub.Publish("fault", f)
}

// State는 화면이 처음 열리거나 다시 연결될 때 쓰는 전체 상태다.
func (l *Lab) State() map[string]any {
	traces := l.reg.all()
	l.mu.Lock()
	defer l.mu.Unlock()
	faults := []model.Fault{}
	for _, f := range l.faults {
		faults = append(faults, *f)
	}
	svcs := []model.ServiceStatus{}
	for _, id := range []string{"service-a", "service-b"} {
		svcs = append(svcs, *l.services[id])
	}
	var run *model.Run
	if l.run != nil {
		c := *l.run
		run = &c
	}
	return map[string]any{
		"topology": l.topo, "limits": l.limits, "defaults": model.DefaultSettings, "run": run, "repeat": l.repeat,
		"faults": faults, "traces": traces, "services": svcs, "proxy": l.proxy, "storeError": l.storeErr,
		"nowUs": model.NowUs(),
	}
}

func (l *Lab) unresolvedLocked() *model.Fault {
	for _, f := range l.faults {
		if f.State == "cleanup_failed" {
			return f
		}
	}
	return nil
}

func (l *Lab) StartRun(label string, s model.Settings, limitSec int) (*model.Run, error) {
	if err := s.Validate(); err != nil {
		return nil, Invalid{err.Error()}
	}
	if limitSec == 0 {
		limitSec = 600
	}
	if limitSec < 10 || limitSec > l.limits.MaxRunSec {
		return nil, Invalid{fmt.Sprintf("실행 시간 제한은 10초에서 %d초 사이여야 합니다", l.limits.MaxRunSec)}
	}
	if len([]rune(label)) > 60 {
		return nil, Invalid{"실험 이름은 60자 이하여야 합니다"}
	}
	l.opMu.Lock()
	defer l.opMu.Unlock()
	l.mu.Lock()
	if l.run != nil && l.run.Status != "ended" {
		l.mu.Unlock()
		return nil, Conflict{"이미 실행 중인 실험이 있습니다"}
	}
	l.mu.Unlock()

	// 시작 전에 프록시가 깨끗한 상태인지 실제로 확인한다.
	st, cl := l.px.Clear()
	l.mu.Lock()
	l.proxy = st
	l.mu.Unlock()
	l.hub.Publish("proxy", st)
	if !cl.Verified {
		return nil, Conflict{"프록시 상태를 확인할 수 없어 시작하지 않았습니다. " + cl.Detail}
	}
	l.resolveFailed(cl)

	for _, t := range l.reg.collect(nil, true) { // 이전 실행의 남은 관측을 확정한다.
		l.save(l.st.SaveTrace(t))
	}
	l.reg.reset()
	l.mu.Lock()
	l.runCtx, l.runCancel = context.WithCancel(context.Background())
	l.run = &model.Run{ID: newID(), Label: label, StartedUs: model.NowUs(), LimitSec: limitSec, Status: "running", Settings: s}
	l.faults, l.seq, l.repeat, l.wg = nil, 0, model.Repeat{}, &sync.WaitGroup{}
	run := *l.run
	l.mu.Unlock()
	l.publishRun()
	l.event(run.ID, "run_started", "실험 시작")
	l.save(l.st.Prune())
	l.hub.Publish("snapshot", l.State())
	return &run, nil
}

// EndRun은 새 요청을 막고 진행 중 요청을 취소한 뒤 장애를 제거하고 실제 상태를 확인한다.
// 실행 중인 실험이 없어도 비상 중지는 프록시를 정리한다.
func (l *Lab) EndRun(reason string) (model.Cleanup, int, error) {
	l.mu.Lock()
	active := l.run != nil && l.run.Status == "running"
	if !active && reason != "emergency" {
		l.mu.Unlock()
		return model.Cleanup{}, 0, Conflict{"실행 중인 실험이 없습니다"}
	}
	canceled := l.inflight
	wg := l.wg
	runID := ""
	if l.run != nil {
		runID = l.run.ID
	}
	if active {
		l.run.Status = "ending"
		l.stopRepeatLocked(reason)
		l.runCancel()
	}
	l.mu.Unlock()
	if active {
		l.publishRun()
	}
	if reason == "emergency" {
		l.event(runID, "emergency", fmt.Sprintf("비상 중지: 진행 중 요청 %d개 취소", canceled))
	}

	l.opMu.Lock()
	cl := l.clearFaults(reason)
	l.opMu.Unlock()

	if active {
		done := make(chan struct{})
		go func() { wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
		sum := model.Summarize(l.reg.all())
		l.mu.Lock()
		l.run.Status, l.run.EndReason, l.run.EndedUs, l.run.Cleanup, l.run.Summary = "ended", reason, model.NowUs(), &cl, sum
		l.mu.Unlock()
		l.publishRun()
		l.event(runID, "run_ended", "실험 종료: "+cl.Detail)
	}
	return cl, canceled, nil
}

// clearFaults는 opMu를 잡은 상태에서 호출한다.
func (l *Lab) clearFaults(reason string) model.Cleanup {
	req := model.NowUs()
	st, cl := l.px.Clear()
	var changed []model.Fault
	l.mu.Lock()
	l.proxy = st
	for _, f := range l.faults {
		if f.Final() {
			continue
		}
		if f.RemoveReqUs == 0 {
			f.RemoveReqUs = req
		}
		l.settle(f, reason, cl)
		changed = append(changed, *f)
	}
	l.mu.Unlock()
	l.hub.Publish("proxy", st)
	for _, f := range changed {
		l.publishFault(f)
		l.event(f.RunID, "fault_"+f.State, faultText(f)+" 종료 ("+reasonText[reason]+"): "+cl.Detail)
	}
	return cl
}

// settle은 mu를 잡은 상태에서 호출한다.
func (l *Lab) settle(f *model.Fault, reason string, cl model.Cleanup) {
	c := cl
	f.Cleanup = &c
	if f.EndReason == "" {
		f.EndReason = reason
	}
	if cl.Verified {
		f.State, f.RemovedUs = "removed", cl.CheckedUs
	} else {
		f.State = "cleanup_failed"
	}
}

// resolveFailed는 나중에 정리가 확인된 장애의 상태를 갱신한다.
func (l *Lab) resolveFailed(cl model.Cleanup) {
	var changed []model.Fault
	l.mu.Lock()
	for _, f := range l.faults {
		if f.State == "cleanup_failed" {
			l.settle(f, f.EndReason, cl)
			changed = append(changed, *f)
		}
	}
	var runChanged bool
	if len(changed) > 0 && l.run != nil && l.run.Cleanup != nil && !l.run.Cleanup.Verified {
		c := cl
		l.run.Cleanup, runChanged = &c, true
	}
	l.mu.Unlock()
	for _, f := range changed {
		l.publishFault(f)
		l.event(f.RunID, "fault_removed", faultText(f)+" 재확인: "+cl.Detail)
	}
	if runChanged {
		l.publishRun()
	}
}

var reasonText = map[string]string{
	"manual": "수동", "expired": "자동 만료", "emergency": "비상 중지", "time_limit": "시간 제한", "shutdown": "서버 종료", "lost": "프록시 상태 변경",
}

func faultText(f model.Fault) string {
	if f.Type == "cut" {
		return "연결 차단"
	}
	dir := "응답 방향"
	if f.Direction == "request" {
		dir = "요청 방향"
	}
	return fmt.Sprintf("지연 %dms %s", f.LatencyMs, dir)
}

func (l *Lab) ApplyFault(in model.Fault) (*model.Fault, error) {
	if in.Edge != injectableEdge {
		return nil, Invalid{"장애를 넣을 수 없는 연결입니다"}
	}
	switch in.Type {
	case "latency":
		if in.LatencyMs < 1 || in.LatencyMs > l.limits.MaxLatencyMs {
			return nil, Invalid{fmt.Sprintf("지연은 1ms에서 %dms 사이여야 합니다", l.limits.MaxLatencyMs)}
		}
		if in.JitterMs < 0 || in.JitterMs > in.LatencyMs {
			return nil, Invalid{"흔들림은 0 이상, 지연 값 이하여야 합니다"}
		}
		if in.Direction != "request" && in.Direction != "response" {
			return nil, Invalid{"지연 방향은 request 또는 response여야 합니다"}
		}
	case "cut":
		in.LatencyMs, in.JitterMs, in.Direction = 0, 0, ""
	default:
		return nil, Invalid{"지원하지 않는 장애 유형입니다"}
	}
	if in.TTLSec < l.limits.MinFaultTTLSec || in.TTLSec > l.limits.MaxFaultTTLSec {
		return nil, Invalid{fmt.Sprintf("자동 만료는 %d초에서 %d초 사이여야 합니다", l.limits.MinFaultTTLSec, l.limits.MaxFaultTTLSec)}
	}
	l.opMu.Lock()
	defer l.opMu.Unlock()
	l.mu.Lock()
	if l.run == nil || l.run.Status != "running" {
		l.mu.Unlock()
		return nil, Conflict{"실험을 시작한 뒤 장애를 적용할 수 있습니다"}
	}
	if l.unresolvedLocked() != nil {
		l.mu.Unlock()
		return nil, Conflict{"이전 장애의 정리가 확인되지 않았습니다"}
	}
	for _, f := range l.faults {
		if f.Edge == in.Edge && !f.Final() {
			l.mu.Unlock()
			return nil, Conflict{"이 연결에는 이미 장애가 적용되어 있습니다. 먼저 제거하세요"}
		}
	}
	f := &model.Fault{ID: newID(), RunID: l.run.ID, Edge: in.Edge, Type: in.Type, Direction: in.Direction,
		LatencyMs: in.LatencyMs, JitterMs: in.JitterMs, TTLSec: in.TTLSec, State: "applying", RequestedUs: model.NowUs()}
	l.faults = append(l.faults, f)
	snap := *f
	l.mu.Unlock()
	l.publishFault(snap)

	err := l.px.Apply(snap)
	var st model.ProxyState
	if err == nil {
		if st, err = l.px.State(); err == nil && !proxyctl.Matches(st, snap) {
			err = errors.New("적용 후 프록시 상태가 설정과 다릅니다")
		}
	}
	if err != nil {
		// 일부만 적용됐을 수 있으므로 바로 정리하고 확인한다.
		st2, cl := l.px.Clear()
		l.mu.Lock()
		l.proxy = st2
		f.Error, f.EndReason = err.Error(), "apply_failed"
		f.Cleanup = &cl
		f.State = "apply_failed"
		if !cl.Verified {
			f.State = "cleanup_failed"
		}
		snap = *f
		l.mu.Unlock()
		l.publishFault(snap)
		l.hub.Publish("proxy", st2)
		l.event(snap.RunID, "fault_apply_failed", faultText(snap)+": "+err.Error())
		return nil, Conflict{"장애를 적용하지 못했습니다: " + err.Error()}
	}
	l.mu.Lock()
	f.State, f.AppliedUs = "active", st.CheckedUs
	f.ExpiresUs = f.AppliedUs + int64(f.TTLSec)*1e6
	l.proxy = st
	snap = *f
	l.mu.Unlock()
	l.hub.Publish("proxy", st)
	l.publishFault(snap)
	l.event(snap.RunID, "fault_active", faultText(snap)+" 적용 확인")
	return &snap, nil
}

func (l *Lab) RemoveFault(id, reason string) (*model.Fault, error) {
	l.opMu.Lock()
	defer l.opMu.Unlock()
	l.mu.Lock()
	var f *model.Fault
	for _, x := range l.faults {
		if x.ID == id {
			f = x
		}
	}
	if f == nil || f.Final() {
		l.mu.Unlock()
		return nil, Conflict{"제거할 장애가 없습니다"}
	}
	f.State, f.RemoveReqUs = "removing", model.NowUs()
	snap := *f
	l.mu.Unlock()
	l.publishFault(snap)
	l.clearFaults(reason)
	l.mu.Lock()
	snap = *f
	l.mu.Unlock()
	if snap.State != "removed" {
		return &snap, Conflict{"장애 제거를 확인하지 못했습니다. " + snap.Cleanup.Detail}
	}
	return &snap, nil
}

// Send는 실제 HTTP 요청 1개를 보낸다.
func (l *Lab) Send(kind string) (int, string, error) {
	l.mu.Lock()
	if l.run == nil || l.run.Status != "running" {
		l.mu.Unlock()
		return 0, "", Conflict{"실험을 시작한 뒤 요청을 보낼 수 있습니다"}
	}
	if l.inflight >= l.limits.MaxInFlight {
		l.mu.Unlock()
		return 0, "", Conflict{fmt.Sprintf("동시에 진행할 수 있는 요청은 %d개입니다", l.limits.MaxInFlight)}
	}
	if l.seq >= l.limits.MaxRequests {
		l.mu.Unlock()
		return 0, "", Conflict{fmt.Sprintf("실험 하나에서 보낼 수 있는 요청은 %d개입니다", l.limits.MaxRequests)}
	}
	l.seq++
	l.inflight++
	l.wg.Add(1)
	seq, run, rctx, wg := l.seq, *l.run, l.runCtx, l.wg
	l.mu.Unlock()

	ctx, span := l.tracer.Start(rctx, "GET /order", trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(
		attribute.String("peer.service", "service-a"), attribute.String("http.request.method", "GET"),
		attribute.String("lab.run_id", run.ID), attribute.Int("lab.seq", seq),
		attribute.Int("lab.timeout_ms", run.Settings.ClientTimeoutMs)))
	root := tele.FromReadOnly(span.(sdktrace.ReadOnlySpan), generatorID)
	l.reg.begin(model.Trace{TraceID: root.TraceID, RunID: run.ID, Seq: seq, Kind: kind, StartUs: root.StartUs}, root)
	go func() {
		defer func() {
			l.mu.Lock()
			l.inflight--
			l.mu.Unlock()
			wg.Done()
		}()
		l.do(ctx, rctx, span, run.Settings)
	}()
	return seq, root.TraceID, nil
}

func (l *Lab) do(ctx, rctx context.Context, span trace.Span, s model.Settings) {
	timeout := time.Duration(s.ClientTimeoutMs) * time.Millisecond
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", l.cfg.AURL+"/order", nil)
	s.Policy().Apply(req.Header)
	tele.Propagator.Inject(ctx, propagation.HeaderCarrier(req.Header))

	result, errText, status := wire.ResultOK, "", 0
	resp, err := l.client.Do(req)
	if err == nil {
		status = resp.StatusCode
		_, err = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		resp.Body.Close()
	}
	switch {
	case err == nil && status >= 400:
		result, errText = wire.ResultHTTPError, fmt.Sprintf("A가 HTTP %d를 응답함", status)
	case err == nil:
	case rctx.Err() != nil:
		result, errText = wire.ResultCanceled, "실험 중지로 요청을 취소함"
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		result, errText = wire.ResultTimeout, "요청자 전체 타임아웃 "+timeout.String()+" 초과"
	case errors.Is(err, syscall.ECONNREFUSED):
		result, errText = wire.ResultRefused, "A 연결 거부: "+err.Error()
	default:
		result, errText = wire.ResultError, err.Error()
	}
	if status > 0 {
		span.SetAttributes(attribute.Int("http.response.status_code", status), attribute.Bool("lab.request_written", true))
	} else if result == wire.ResultTimeout || result == wire.ResultCanceled {
		span.SetAttributes(attribute.Bool("lab.request_written", true))
	}
	span.SetAttributes(attribute.String("lab.result", result), attribute.String("lab.error", errText))
	end := time.Now()
	span.End(trace.WithTimestamp(end))
	l.reg.finish(span.SpanContext().TraceID().String(), result, errText, status, end.UnixMicro())
}

func (l *Lab) StartRepeat(count, intervalMs, concurrency int) error {
	lim := l.limits
	if count < 1 || count > lim.MaxRepeatCount {
		return Invalid{fmt.Sprintf("반복 횟수는 1에서 %d 사이여야 합니다", lim.MaxRepeatCount)}
	}
	if intervalMs < lim.MinIntervalMs || intervalMs > lim.MaxIntervalMs {
		return Invalid{fmt.Sprintf("간격은 %dms에서 %dms 사이여야 합니다", lim.MinIntervalMs, lim.MaxIntervalMs)}
	}
	if concurrency < 1 || concurrency > lim.MaxInFlight {
		return Invalid{fmt.Sprintf("동시 실행은 1에서 %d 사이여야 합니다", lim.MaxInFlight)}
	}
	l.mu.Lock()
	if l.run == nil || l.run.Status != "running" {
		l.mu.Unlock()
		return Conflict{"실험을 시작한 뒤 요청을 보낼 수 있습니다"}
	}
	if l.repeat.Active {
		l.mu.Unlock()
		return Conflict{"이미 반복 요청이 진행 중입니다"}
	}
	ctx, cancel := context.WithCancel(l.runCtx)
	l.repeatCancel = cancel
	l.repeat = model.Repeat{Active: true, Count: count, IntervalMs: intervalMs, Concurrent: concurrency}
	runID := l.run.ID
	l.mu.Unlock()
	l.publishRun()
	go l.repeatLoop(ctx, runID, count, time.Duration(intervalMs)*time.Millisecond, concurrency)
	return nil
}

func (l *Lab) repeatLoop(ctx context.Context, runID string, count int, interval time.Duration, concurrency int) {
	tick := time.NewTicker(interval)
	defer tick.Stop()
	reason := "done"
	for sent := 0; sent < count; {
		l.mu.Lock()
		busy := l.inflight >= concurrency
		l.mu.Unlock()
		if !busy {
			if _, _, err := l.Send("repeat"); err != nil {
				if ctx.Err() == nil {
					reason = "limit"
				}
				break
			}
			sent++
			l.mu.Lock()
			if l.run != nil && l.run.ID == runID {
				l.repeat.Sent = sent
			}
			l.mu.Unlock()
			l.publishRun()
		}
		if sent == count {
			break
		}
		select {
		case <-tick.C:
		case <-ctx.Done():
			return
		}
	}
	l.mu.Lock()
	if l.run != nil && l.run.ID == runID && l.repeat.Active {
		l.repeat.Active, l.repeat.StopReason = false, reason
	}
	l.mu.Unlock()
	l.publishRun()
}

func (l *Lab) stopRepeatLocked(reason string) {
	if l.repeat.Active {
		l.repeat.Active, l.repeat.StopReason = false, reason
		l.repeatCancel()
	}
}

// StopRepeat은 새 요청 발생만 멈춘다. 이미 보낸 요청은 끝까지 기다린다.
func (l *Lab) StopRepeat() error {
	l.mu.Lock()
	if !l.repeat.Active {
		l.mu.Unlock()
		return Conflict{"진행 중인 반복 요청이 없습니다"}
	}
	l.stopRepeatLocked("manual")
	l.mu.Unlock()
	l.publishRun()
	return nil
}

func (l *Lab) AddSpan(s model.Span) {
	if l.services[s.Service] == nil {
		return
	}
	l.touch(s.Service, nil)
	l.reg.add(s)
}

func (l *Lab) Heartbeat(h wire.Heartbeat) { l.touch(h.Service, &h) }

func (l *Lab) touch(service string, h *wire.Heartbeat) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if s := l.services[service]; s != nil {
		s.TelemetryUs = model.NowUs()
		if h != nil {
			s.ExportErrors, s.NotifyDropped = h.ExportErrors, h.NotifyDropped
		}
	}
}

// Recover는 이전 프로세스가 남긴 실행과 장애를 정리한다.
func (l *Lab) Recover() {
	runs, err := l.st.Interrupt()
	l.save(err)
	faults, err := l.st.AllFaults()
	l.save(err)
	for i := range faults {
		if !faults[i].Final() {
			faults[i].State, faults[i].EndReason = "cleanup_failed", "restart"
			if faults[i].RemoveReqUs == 0 {
				faults[i].RemoveReqUs = model.NowUs()
			}
			l.faults = append(l.faults, &faults[i])
		}
	}
	l.opMu.Lock()
	st, cl := l.px.Clear()
	l.opMu.Unlock()
	l.mu.Lock()
	l.proxy = st
	for _, f := range l.faults {
		if !cl.Verified {
			c := cl
			f.Cleanup = &c
		}
	}
	l.mu.Unlock()
	if cl.Verified {
		l.resolveFailed(cl)
	}
	for _, r := range runs {
		c := cl
		c.Detail = "재시작 후 " + cl.Detail
		r.Cleanup = &c
		if ts, err := l.st.Traces(r.ID); err == nil {
			r.Summary = model.Summarize(ts)
		}
		l.save(l.st.SaveRun(r))
		l.event(r.ID, "interrupted", "관리 서버 재시작으로 실험이 중단됨: "+cl.Detail)
	}
}

// Loop는 관측 갱신, 만료, 상태 대조를 주기적으로 처리한다.
func (l *Lab) Loop(ctx context.Context) {
	go every(ctx, 50*time.Millisecond, l.flush)
	go every(ctx, 250*time.Millisecond, l.expire)
	go every(ctx, 2*time.Second, l.reconcile)
	go every(ctx, 2*time.Second, l.checkServices)
}

func every(ctx context.Context, d time.Duration, fn func()) {
	t := time.NewTicker(d)
	defer t.Stop()
	fn()
	for {
		select {
		case <-t.C:
			fn()
		case <-ctx.Done():
			return
		}
	}
}

func (l *Lab) faultSnapshot() []model.Fault {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]model.Fault, 0, len(l.faults))
	for _, f := range l.faults {
		out = append(out, *f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RequestedUs < out[j].RequestedUs })
	return out
}

func (l *Lab) flush() {
	changed := l.reg.collect(l.faultSnapshot(), false)
	if len(changed) == 0 {
		return
	}
	for _, t := range changed {
		l.save(l.st.SaveTrace(t))
		l.hub.Publish("trace", t)
		l.noteRecovery(t)
	}
	sum := model.Summarize(l.reg.all())
	l.mu.Lock()
	ok := l.run != nil && l.run.ID == changed[0].RunID
	if ok {
		l.run.Summary = sum
	}
	l.mu.Unlock()
	if ok {
		l.publishRun()
	}
}

// noteRecovery는 장애 제거 확인 뒤 새로 보낸 첫 성공 요청이 끝난 시각을 기록한다.
func (l *Lab) noteRecovery(t model.Trace) {
	if t.Result != wire.ResultOK {
		return
	}
	l.mu.Lock()
	var last *model.Fault
	for _, f := range l.faults {
		last = f
	}
	if last == nil || last.RunID != t.RunID || last.RemovedUs == 0 || last.RecoveryUs != 0 || t.StartUs < last.RemovedUs {
		l.mu.Unlock()
		return
	}
	last.RecoveryUs = t.EndUs - last.RemovedUs
	snap := *last
	l.mu.Unlock()
	l.publishFault(snap)
}

func (l *Lab) expire() {
	now := model.NowUs()
	var ids []string
	l.mu.Lock()
	for _, f := range l.faults {
		if f.State == "active" && now >= f.ExpiresUs {
			ids = append(ids, f.ID)
		}
	}
	over := l.run != nil && l.run.Status == "running" && now >= l.run.StartedUs+int64(l.run.LimitSec)*1e6
	l.mu.Unlock()
	for _, id := range ids {
		l.RemoveFault(id, "expired")
	}
	if over {
		l.EndRun("time_limit")
	}
}

// reconcile은 프록시의 실제 상태를 기대 상태와 비교하고 어긋나면 안전한 쪽으로 정리한다.
func (l *Lab) reconcile() {
	l.opMu.Lock()
	defer l.opMu.Unlock()
	st, err := l.px.State()
	l.mu.Lock()
	var active, failed *model.Fault
	for _, f := range l.faults {
		switch f.State {
		case "active":
			active = f
		case "cleanup_failed":
			failed = f
		}
	}
	l.proxy = st
	runID := ""
	if l.run != nil {
		runID = l.run.ID
	}
	l.mu.Unlock()
	if err != nil && !st.Reachable {
		l.hub.Publish("proxy", st)
		return
	}
	switch {
	case active != nil && err == nil && proxyctl.Matches(st, *active):
	case active != nil:
		l.event(active.RunID, "fault_lost", "프록시 상태가 설정과 달라져 장애를 종료함")
		l.clearFaults("lost")
		return
	case err != nil || !proxyctl.Clean(st):
		l.event(runID, "unexpected_state", "기록에 없는 프록시 상태를 발견해 정리함")
		var cl model.Cleanup
		st, cl = l.px.Clear()
		l.mu.Lock()
		l.proxy = st
		l.mu.Unlock()
		if cl.Verified {
			l.resolveFailed(cl)
		}
	case failed != nil:
		l.resolveFailed(model.Cleanup{Verified: true, CheckedUs: st.CheckedUs, Detail: "남은 toxic 0개, 프록시 켜짐을 확인함"})
	}
	l.hub.Publish("proxy", st)
}

// checkServices는 실험 트래픽과 분리된 경로로 서비스와 관측 수신 상태를 따로 확인한다.
func (l *Lab) checkServices() {
	for id, url := range map[string]string{"service-a": l.cfg.AHealth, "service-b": l.cfg.BHealth} {
		resp, err := l.probe.Get(url)
		l.mu.Lock()
		s := l.services[id]
		s.HealthUs, s.Health, s.HealthError = model.NowUs(), "up", ""
		if err != nil {
			s.Health, s.HealthError = "down", err.Error()
		} else {
			resp.Body.Close()
			if resp.StatusCode != 200 {
				s.Health, s.HealthError = "down", resp.Status
			}
		}
		s.Telemetry = "ok"
		if s.TelemetryUs == 0 {
			s.Telemetry = "never"
		} else if model.NowUs()-s.TelemetryUs > 6e6 {
			s.Telemetry = "stale"
		}
		snap := *s
		l.mu.Unlock()
		l.hub.Publish("service", snap)
	}
}

// Shutdown은 종료 전에 장애를 정리한다.
func (l *Lab) Shutdown() {
	if _, _, err := l.EndRun("shutdown"); err != nil {
		l.opMu.Lock()
		l.clearFaults("shutdown")
		l.opMu.Unlock()
	}
}

func (l *Lab) Runs() ([]model.Run, error) { return l.st.Runs() }

func (l *Lab) RunDetail(id string) (map[string]any, error) {
	rs, err := l.st.Run(id)
	if err != nil {
		return nil, err
	}
	if len(rs) == 0 {
		return nil, nil
	}
	faults, err := l.st.Faults(id)
	if err != nil {
		return nil, err
	}
	traces, err := l.st.Traces(id)
	if err != nil {
		return nil, err
	}
	events, err := l.st.Events(id)
	if err != nil {
		return nil, err
	}
	return map[string]any{"run": rs[0], "faults": faults, "traces": traces, "events": events}, nil
}
