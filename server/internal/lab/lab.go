// Package lab은 실험 실행, 요청 발생, 장애 수명 주기, 관측 판정을 묶는다.
package lab

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"slices"
	"sort"
	"strings"
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

type Config struct {
	AURL     string    // 요청 발생기가 부르는 A의 주소
	Services []Service // A가 부르는 서비스들의 관리 경로
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
	bases  map[string]string // 서비스 ID별 관리 경로 주소
	order  []string          // 서비스 ID. 화면에 보내는 순서

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
	proxies      map[string]model.ProxyState // 연결 ID별
	services     map[string]*model.ServiceStatus
	storeErr     string
}

func New(cfg Config, st *store.Store, px *proxyctl.Ctl) *Lab {
	l := &Lab{
		cfg: cfg, st: st, hub: hub.New(), px: px, limits: model.DefaultLimits,
		client:   &http.Client{Transport: &http.Transport{DisableKeepAlives: true, Proxy: nil}},
		probe:    &http.Client{Timeout: time.Second, Transport: &http.Transport{DisableKeepAlives: true, Proxy: nil}},
		bases:    map[string]string{hubID: cfg.AURL},
		proxies:  map[string]model.ProxyState{},
		services: map[string]*model.ServiceStatus{},
		wg:       &sync.WaitGroup{},
	}
	for _, s := range cfg.Services {
		l.bases[s.ID] = s.Base
	}
	for _, n := range nodes {
		nd := n.Node
		if nd.Addr = l.bases[n.ID]; n.ID == generatorID {
			nd.Addr = "labd"
		} else {
			l.services[n.ID] = &model.ServiceStatus{Service: n.ID, Health: "unknown", Telemetry: "never"}
			l.order = append(l.order, n.ID)
		}
		l.topo.Nodes = append(l.topo.Nodes, nd)
	}
	for _, e := range edges {
		if p, ok := px.Proxy(e.ID); ok {
			e.Proxy = &model.EdgeProxy{Name: p.Name, Listen: p.Listen, Upstream: p.Upstream, Edges: []string{e.ID}}
		}
		l.topo.Edges = append(l.topo.Edges, e)
	}
	for _, s := range scenarios {
		l.topo.Scenarios = append(l.topo.Scenarios, s.Scenario)
	}
	l.reg = newRegistry(l.topo.Edges, time.Duration(l.limits.ObservationGrace)*time.Millisecond)
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
	for _, id := range l.order {
		svcs = append(svcs, *l.services[id])
	}
	var run *model.Run
	if l.run != nil {
		c := *l.run
		run = &c
	}
	return map[string]any{
		"topology": l.topo, "limits": l.limits, "defaults": model.DefaultSettings, "run": run, "repeat": l.repeat,
		"faults": faults, "traces": traces, "services": svcs, "proxies": l.proxyCopy(), "storeError": l.storeErr,
		"nowUs": model.NowUs(),
	}
}

// proxyCopy는 mu를 잡은 상태에서 호출한다.
func (l *Lab) proxyCopy() map[string]model.ProxyState {
	out := make(map[string]model.ProxyState, len(l.proxies))
	for k, v := range l.proxies {
		out[k] = v
	}
	return out
}

// setProxies는 읽어 온 프록시 상태를 반영하고 화면에 알린다.
func (l *Lab) setProxies(sts map[string]model.ProxyState) {
	l.mu.Lock()
	for k, v := range sts {
		l.proxies[k] = v
	}
	all := l.proxyCopy()
	l.mu.Unlock()
	l.hub.Publish("proxies", all)
}

// reset은 서비스가 실험 중에 쌓은 기억을 관리 경로로 비운다. 실패해도 서비스는 새 실험의 첫 요청에서 스스로 비운다.
func (l *Lab) reset(only func(nodeDef) bool) {
	for _, n := range nodes {
		if !only(n) {
			continue
		}
		req, _ := http.NewRequest("POST", l.bases[n.ID]+"/lab/reset", nil)
		if resp, err := l.probe.Do(req); err != nil {
			log.Printf("%s 초기화 실패: %v", n.ID, err)
		} else {
			resp.Body.Close()
		}
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

func (l *Lab) StartRun(label, topic string, s model.Settings, limitSec int) (*model.Run, error) {
	if topic == "" {
		topic = scenarios[0].ID
	}
	if scenario(topic) == nil {
		return nil, Invalid{"없는 실험 주제입니다"}
	}
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
	sts, cl := l.px.Clear()
	l.setProxies(sts)
	if !cl.Verified {
		return nil, Conflict{"프록시 상태를 확인할 수 없어 시작하지 않았습니다. " + cl.Detail}
	}
	l.resolveFailed(cl)
	l.reset(func(n nodeDef) bool { return n.stateful })

	for _, t := range l.reg.collect(nil, true) { // 이전 실행의 남은 관측을 확정한다.
		l.save(l.st.SaveTrace(t))
	}
	l.reg.reset()
	l.mu.Lock()
	l.runCtx, l.runCancel = context.WithCancel(context.Background())
	l.run = &model.Run{ID: newID(), Scenario: topic, Label: label, StartedUs: model.NowUs(), LimitSec: limitSec, Status: "running", Settings: s}
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
		l.reset(func(n nodeDef) bool { return n.drain }) // 밀린 작업이 실험이 끝난 뒤에 흘러가지 않게 한다.
	}

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

// clearFaults는 opMu를 잡은 상태에서 호출한다. 모든 프록시를 비우고 모든 장애를 끝낸다.
func (l *Lab) clearFaults(reason string) model.Cleanup {
	req := model.NowUs()
	sts, cl := l.px.Clear()
	var changed []model.Fault
	l.mu.Lock()
	for _, f := range l.faults {
		if f.Final() {
			continue
		}
		if f.RemoveReqUs == 0 {
			f.RemoveReqUs = req
		}
		if f.Node != "" {
			l.settle(f, reason, serviceCleanup())
		} else {
			l.settle(f, reason, cl)
		}
		changed = append(changed, *f)
	}
	l.mu.Unlock()
	l.setProxies(sts)
	for _, f := range changed {
		l.publishFault(f)
		l.event(f.RunID, "fault_"+f.State, faultText(f)+" 종료 ("+reasonText[reason]+"): "+f.Cleanup.Detail)
	}
	return cl
}

// clearEdge는 opMu를 잡은 상태에서 호출한다. 연결 하나의 프록시를 비우고 그 연결의 장애만 끝낸다.
func (l *Lab) clearEdge(f *model.Fault, reason string) model.Fault {
	sts, cl := l.px.Clear(f.Edge)
	l.mu.Lock()
	if f.RemoveReqUs == 0 {
		f.RemoveReqUs = model.NowUs()
	}
	l.settle(f, reason, cl)
	snap := *f
	l.mu.Unlock()
	l.setProxies(sts)
	l.publishFault(snap)
	l.event(snap.RunID, "fault_"+snap.State, faultText(snap)+" 종료 ("+reasonText[reason]+"): "+cl.Detail)
	return snap
}

// 서비스 장애는 요청에 실어 보내므로 남는 상태가 없다. 싣기를 멈추면 끝난다.
func serviceCleanup() model.Cleanup {
	return model.Cleanup{Verified: true, CheckedUs: model.NowUs(), Detail: "새 요청에 더 이상 싣지 않음"}
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
	if f.Node != "" {
		if f.Type == "error" {
			return fmt.Sprintf("%s 오류 응답 %d%%", nodeName(f.Node), f.Percent)
		}
		return fmt.Sprintf("%s 과부하 (동시 %d개, 건당 %dms)", nodeName(f.Node), f.Slots, f.WorkMs)
	}
	to := f.Edge
	if e := edgeDef(f.Edge); e != nil {
		to = nodeName(e.To)
	}
	switch f.Type {
	case "cut":
		return to + " 연결 차단"
	case "reset":
		return to + " 연결 리셋"
	case "blackhole":
		return to + " 연결 응답 없음"
	}
	dir := "응답 방향"
	if f.Direction == "request" {
		dir = "요청 방향"
	}
	return fmt.Sprintf("%s 연결 지연 %dms %s", to, f.LatencyMs, dir)
}

func (l *Lab) ApplyFault(in model.Fault) (*model.Fault, error) {
	onNode := in.Type == "error" || in.Type == "overload"
	if onNode {
		in.Edge, in.Direction, in.LatencyMs, in.JitterMs = "", "", 0, 0
	} else {
		in.Node, in.Percent, in.Slots, in.WorkMs = "", 0, 0, 0
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
	case "cut", "blackhole", "reset":
		in.LatencyMs, in.JitterMs, in.Direction = 0, 0, ""
	case "error":
		in.Slots, in.WorkMs = 0, 0
		if in.Percent < 1 || in.Percent > 100 {
			return nil, Invalid{"오류 비율은 1에서 100 사이여야 합니다"}
		}
	case "overload":
		in.Percent = 0
		if in.Slots < 1 || in.Slots > l.limits.MaxInFlight {
			return nil, Invalid{fmt.Sprintf("동시 처리 수는 1에서 %d 사이여야 합니다", l.limits.MaxInFlight)}
		}
		if in.WorkMs < 1 || in.WorkMs > 3000 {
			return nil, Invalid{"건당 처리 시간은 1ms에서 3000ms 사이여야 합니다"}
		}
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
	// 이 실험의 주제에 들어 있는 대상에만 건다.
	sc := scenario(l.run.Scenario)
	target := false
	if onNode {
		for _, n := range nodes {
			target = target || (n.ID == in.Node && n.Faults && sc.hasNode(n.ID))
		}
	} else if _, ok := l.px.Proxy(in.Edge); ok {
		target = sc.has(sc.Edges, in.Edge)
	}
	if !target {
		l.mu.Unlock()
		if onNode {
			return nil, Invalid{"장애를 넣을 수 없는 서비스입니다"}
		}
		return nil, Invalid{"장애를 넣을 수 없는 연결입니다"}
	}
	for _, f := range l.faults {
		if f.Edge == in.Edge && f.Node == in.Node && !f.Final() {
			l.mu.Unlock()
			return nil, Conflict{"이 대상에는 이미 장애가 적용되어 있습니다. 먼저 제거하세요"}
		}
	}
	f := &model.Fault{ID: newID(), RunID: l.run.ID, Edge: in.Edge, Node: in.Node, Type: in.Type, Direction: in.Direction,
		LatencyMs: in.LatencyMs, JitterMs: in.JitterMs, Percent: in.Percent, Slots: in.Slots, WorkMs: in.WorkMs,
		TTLSec: in.TTLSec, State: "applying", RequestedUs: model.NowUs()}
	l.faults = append(l.faults, f)
	if onNode {
		// 프록시를 건드리지 않는다. 지금부터 보내는 요청에 실려 B가 그대로 동작한다.
		f.State, f.AppliedUs = "active", f.RequestedUs
		f.ExpiresUs = f.AppliedUs + int64(f.TTLSec)*1e6
		snap := *f
		l.mu.Unlock()
		l.publishFault(snap)
		l.event(snap.RunID, "fault_active", faultText(snap)+" 적용: 지금부터 보내는 요청에 실림")
		return &snap, nil
	}
	snap := *f
	l.mu.Unlock()
	l.publishFault(snap)

	err := l.px.Apply(snap)
	var st model.ProxyState
	if err == nil {
		if st, err = l.px.State(snap.Edge); err == nil && !proxyctl.Matches(st, snap) {
			err = errors.New("적용 후 프록시 상태가 설정과 다릅니다")
		}
	}
	if err != nil {
		// 일부만 적용됐을 수 있으므로 바로 정리하고 확인한다.
		st2, cl := l.px.Clear(snap.Edge)
		l.mu.Lock()
		f.Error, f.EndReason = err.Error(), "apply_failed"
		f.Cleanup = &cl
		f.State = "apply_failed"
		if !cl.Verified {
			f.State = "cleanup_failed"
		}
		snap = *f
		l.mu.Unlock()
		l.publishFault(snap)
		l.setProxies(st2)
		l.event(snap.RunID, "fault_apply_failed", faultText(snap)+": "+err.Error())
		return nil, Conflict{"장애를 적용하지 못했습니다: " + err.Error()}
	}
	l.mu.Lock()
	f.State, f.AppliedUs = "active", st.CheckedUs
	f.ExpiresUs = f.AppliedUs + int64(f.TTLSec)*1e6
	snap = *f
	l.mu.Unlock()
	l.setProxies(map[string]model.ProxyState{snap.Edge: st})
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
	if f.Node != "" {
		f.RemoveReqUs = model.NowUs()
		l.settle(f, reason, serviceCleanup())
		snap := *f
		l.mu.Unlock()
		l.publishFault(snap)
		l.event(snap.RunID, "fault_removed", faultText(snap)+" 종료 ("+reasonText[reason]+"): "+snap.Cleanup.Detail)
		return &snap, nil
	}
	f.State, f.RemoveReqUs = "removing", model.NowUs()
	snap := *f
	l.mu.Unlock()
	l.publishFault(snap)
	snap = l.clearEdge(f, reason)
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
	// 적용 중인 서비스 장애는 요청을 만드는 순간의 값으로 싣는다. 보낸 뒤에는 바뀌지 않는다.
	sc := scenario(run.Scenario)
	pol := run.Settings.Policy()
	pol.Flow, pol.Run, pol.Faults = sc.flow, run.ID, map[string]wire.ServiceFault{}
	for _, f := range l.faults {
		if f.Node != "" && f.State == "active" {
			pol.Faults[f.Node] = wire.ServiceFault{ID: f.ID, FailPercent: f.Percent, Slots: f.Slots, WorkMs: f.WorkMs}
		}
	}
	l.mu.Unlock()
	path := sc.path(seq)
	name := "GET " + strings.SplitN(path, "?", 2)[0]

	ctx, span := l.tracer.Start(rctx, name, trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(
		attribute.String("peer.service", hubID), attribute.String("http.request.method", "GET"),
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
		l.do(ctx, rctx, span, run.Settings, pol, path)
	}()
	return seq, root.TraceID, nil
}

func (l *Lab) do(ctx, rctx context.Context, span trace.Span, s model.Settings, pol wire.Policy, path string) {
	timeout := time.Duration(s.ClientTimeoutMs) * time.Millisecond
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", l.cfg.AURL+path, nil)
	pol.Apply(req.Header)
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
	sts, cl := l.px.Clear()
	l.opMu.Unlock()
	l.setProxies(sts)
	l.reset(func(n nodeDef) bool { return n.stateful })
	l.mu.Lock()
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
	go every(ctx, 500*time.Millisecond, l.readGauges)
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

// reconcile은 프록시들의 실제 상태를 기대 상태와 비교하고 어긋나면 안전한 쪽으로 정리한다.
func (l *Lab) reconcile() {
	l.opMu.Lock()
	defer l.opMu.Unlock()
	sts, errs := l.px.States()
	l.mu.Lock()
	active := map[string]*model.Fault{}
	failed := false
	for _, f := range l.faults {
		if f.Node != "" {
			continue // 서비스 장애는 프록시 상태와 무관하다.
		}
		switch f.State {
		case "active":
			active[f.Edge] = f
		case "cleanup_failed":
			failed = true
		}
	}
	runID := ""
	if l.run != nil {
		runID = l.run.ID
	}
	l.mu.Unlock()
	l.setProxies(sts)
	var lost []*model.Fault
	var dirty []string
	for _, edge := range l.px.Edges() {
		st, f := sts[edge], active[edge]
		if !st.Reachable {
			return // Toxiproxy에 닿지 않으면 판단하지 않는다.
		}
		switch {
		case f != nil && errs[edge] == nil && proxyctl.Matches(st, *f):
		case f != nil:
			lost = append(lost, f)
		case errs[edge] != nil || !proxyctl.Clean(st):
			dirty = append(dirty, edge)
		}
	}
	for _, f := range lost {
		l.event(f.RunID, "fault_lost", "프록시 상태가 설정과 달라져 장애를 종료함: "+faultText(*f))
		l.clearEdge(f, "lost")
	}
	clean := model.Cleanup{Verified: true, CheckedUs: model.NowUs(), Detail: "남은 toxic 0개, 프록시 켜짐을 확인함"}
	if len(dirty) > 0 {
		l.event(runID, "unexpected_state", "기록에 없는 프록시 상태를 발견해 정리함")
		var fixed map[string]model.ProxyState
		fixed, clean = l.px.Clear(dirty...)
		l.setProxies(fixed)
	}
	if failed && len(lost) == 0 && clean.Verified {
		l.resolveFailed(clean)
	}
}

// checkServices는 실험 트래픽과 분리된 경로로 서비스와 관측 수신 상태를 따로 확인한다.
func (l *Lab) checkServices() {
	for _, id := range l.order {
		resp, err := l.probe.Get(l.bases[id] + "/healthz")
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

// readGauges는 서비스가 스스로 센 값(밀린 작업 수 등)을 관리 경로로 읽는다. 값이 바뀐 서비스만 화면에 알린다.
func (l *Lab) readGauges() {
	for _, n := range nodes {
		if !n.gauges {
			continue
		}
		var out struct {
			Gauges []wire.Gauge `json:"gauges"`
		}
		resp, err := l.probe.Get(l.bases[n.ID] + "/lab/stats")
		if err == nil {
			err = json.NewDecoder(io.LimitReader(resp.Body, 1<<14)).Decode(&out)
			resp.Body.Close()
		}
		if err != nil {
			out.Gauges = nil
		}
		l.mu.Lock()
		s := l.services[n.ID]
		same := slices.Equal(s.Gauges, out.Gauges)
		s.Gauges = out.Gauges
		snap := *s
		l.mu.Unlock()
		if !same {
			l.hub.Publish("service", snap)
		}
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
