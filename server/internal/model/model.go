// Package model은 API, 저장소, SSE가 공유하는 데이터 형식을 정의한다.
// 시각은 모두 Unix 마이크로초(Us)다. JavaScript의 안전한 정수 범위에 들어간다.
package model

import (
	"fmt"
	"math"
	"sort"
	"time"

	"breaklab/internal/wire"
)

func NowUs() int64 { return time.Now().UnixMicro() }

type Settings struct {
	ClientTimeoutMs int `json:"clientTimeoutMs"`
	CallTimeoutMs   int `json:"callTimeoutMs"`
	MaxAttempts     int `json:"maxAttempts"`
	BackoffMs       int `json:"backoffMs"`
	WorkMs          int `json:"workMs"`
}

var DefaultSettings = Settings{ClientTimeoutMs: 5000, CallTimeoutMs: 1000, MaxAttempts: 2, BackoffMs: 200, WorkMs: 15}

type Limits struct {
	MaxInFlight      int `json:"maxInFlight"`
	MaxRequests      int `json:"maxRequestsPerRun"`
	MaxRepeatCount   int `json:"maxRepeatCount"`
	MinIntervalMs    int `json:"minIntervalMs"`
	MaxIntervalMs    int `json:"maxIntervalMs"`
	MaxRunSec        int `json:"maxRunSec"`
	MinFaultTTLSec   int `json:"minFaultTtlSec"`
	MaxFaultTTLSec   int `json:"maxFaultTtlSec"`
	MaxLatencyMs     int `json:"maxLatencyMs"`
	ObservationGrace int `json:"observationGraceMs"`
}

var DefaultLimits = Limits{
	MaxInFlight: 5, MaxRequests: 1000, MaxRepeatCount: 200, MinIntervalMs: 100, MaxIntervalMs: 5000,
	MaxRunSec: 900, MinFaultTTLSec: 5, MaxFaultTTLSec: 300, MaxLatencyMs: 10000, ObservationGrace: 4000,
}

func inRange(name string, v, min, max int) error {
	if v < min || v > max {
		return fmt.Errorf("%s 값은 %d에서 %d 사이여야 합니다", name, min, max)
	}
	return nil
}

func (s Settings) Validate() error {
	for _, e := range []error{
		inRange("요청자 전체 타임아웃(ms)", s.ClientTimeoutMs, 100, 20000),
		inRange("A의 B 호출 타임아웃(ms)", s.CallTimeoutMs, 50, 10000),
		inRange("최대 시도 횟수", s.MaxAttempts, 1, 4),
		inRange("재시도 대기(ms)", s.BackoffMs, 0, 2000),
		inRange("B 처리 시간(ms)", s.WorkMs, 0, 3000),
	} {
		if e != nil {
			return e
		}
	}
	return nil
}

func (s Settings) Policy() wire.Policy {
	ms := time.Millisecond
	return wire.Policy{
		CallTimeout: time.Duration(s.CallTimeoutMs) * ms, MaxAttempts: s.MaxAttempts,
		Backoff: time.Duration(s.BackoffMs) * ms, Work: time.Duration(s.WorkMs) * ms,
	}
}

type SpanEvent struct {
	AtUs  int64             `json:"atUs"`
	Name  string            `json:"name"`
	Attrs map[string]string `json:"attrs,omitempty"`
}

type Span struct {
	TraceID  string            `json:"traceId"`
	SpanID   string            `json:"spanId"`
	ParentID string            `json:"parentId"`
	Service  string            `json:"service"`
	Kind     string            `json:"kind"` // client, server, internal
	Name     string            `json:"name"`
	StartUs  int64             `json:"startUs"`
	EndUs    int64             `json:"endUs"` // 0이면 종료가 아직 관측되지 않음
	Result   string            `json:"result"`
	Error    string            `json:"error,omitempty"`
	Attrs    map[string]string `json:"attrs,omitempty"`
	Events   []SpanEvent       `json:"events,omitempty"`
	SeenUs   int64             `json:"seenUs"` // 관리 서버가 처음 받은 시각

	// 아래는 관리 서버가 관측값으로 판정한 값이다.
	Edge     string   `json:"edge,omitempty"`
	Peer     string   `json:"peer,omitempty"`  // observed, waiting, missing, undetermined, not_sent
	Route    string   `json:"route,omitempty"` // proxied, proxy_side, proxy_dial, bypassed, undetermined, direct
	FaultIDs []string `json:"faultIds,omitempty"`
}

const (
	ObsWaiting  = "waiting"
	ObsComplete = "complete"
	ObsPartial  = "partial"
	ObsUnknown  = "unknown"
)

type Trace struct {
	TraceID     string   `json:"traceId"`
	RunID       string   `json:"runId"`
	Seq         int      `json:"seq"`
	Kind        string   `json:"kind"` // single, repeat
	StartUs     int64    `json:"startUs"`
	EndUs       int64    `json:"endUs"`
	Result      string   `json:"result"`
	HTTPStatus  int      `json:"httpStatus,omitempty"`
	Error       string   `json:"error,omitempty"`
	Observation string   `json:"observation"`
	Notes       []string `json:"notes"`
	Spans       []Span   `json:"spans"`
}

type Cleanup struct {
	Verified  bool   `json:"verified"`
	CheckedUs int64  `json:"checkedUs"`
	Detail    string `json:"detail"`
}

// Fault 상태: applying, active, removing, removed, apply_failed, cleanup_failed
// 연결 장애(latency, cut, blackhole, reset)는 Edge에, 서비스 장애(error, overload)는 Node에 건다.
type Fault struct {
	ID          string   `json:"id"`
	RunID       string   `json:"runId"`
	Edge        string   `json:"edge,omitempty"`
	Node        string   `json:"node,omitempty"`
	Type        string   `json:"type"`
	Direction   string   `json:"direction,omitempty"` // request(A에서 B), response(B에서 A)
	LatencyMs   int      `json:"latencyMs,omitempty"`
	JitterMs    int      `json:"jitterMs,omitempty"`
	Percent     int      `json:"percent,omitempty"` // error: 오류로 응답하는 비율
	Slots       int      `json:"slots,omitempty"`   // overload: 동시에 처리하는 요청 수
	WorkMs      int      `json:"workMs,omitempty"`  // overload: 요청 하나의 처리 시간
	TTLSec      int      `json:"ttlSec"`
	State       string   `json:"state"`
	RequestedUs int64    `json:"requestedUs"`
	AppliedUs   int64    `json:"appliedUs"` // 프록시에서 적용을 확인한 시각
	ExpiresUs   int64    `json:"expiresUs"`
	RemoveReqUs int64    `json:"removeRequestedUs"`
	RemovedUs   int64    `json:"removedUs"` // 프록시에서 제거를 확인한 시각
	EndReason   string   `json:"endReason,omitempty"`
	Error       string   `json:"error,omitempty"`
	Cleanup     *Cleanup `json:"cleanup,omitempty"`
	RecoveryUs  int64    `json:"recoveryUs,omitempty"` // 제거 확인 후 새로 보낸 첫 성공 요청의 완료까지 걸린 시간
}

func (f *Fault) Final() bool { return f.State == "removed" || f.State == "apply_failed" }

type Summary struct {
	Total         int   `json:"total"`
	OK            int   `json:"ok"`
	Failed        int   `json:"failed"`
	Canceled      int   `json:"canceled"`
	InFlight      int   `json:"inFlight"`
	P50Us         int64 `json:"p50Us"`
	P95Us         int64 `json:"p95Us"`
	MaxUs         int64 `json:"maxUs"`
	Attempts      int   `json:"attempts"`
	Retries       int   `json:"retries"`
	CallTimeouts  int   `json:"callTimeouts"`
	ObsIncomplete int   `json:"obsIncomplete"`
}

type Run struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	StartedUs int64    `json:"startedUs"`
	EndedUs   int64    `json:"endedUs"`
	LimitSec  int      `json:"limitSec"`
	Status    string   `json:"status"` // running, ending, ended
	EndReason string   `json:"endReason,omitempty"`
	Settings  Settings `json:"settings"`
	Summary   Summary  `json:"summary"`
	Cleanup   *Cleanup `json:"cleanup,omitempty"`
}

type Repeat struct {
	Active     bool   `json:"active"`
	Count      int    `json:"count"`
	IntervalMs int    `json:"intervalMs"`
	Concurrent int    `json:"concurrency"`
	Sent       int    `json:"sent"`
	StopReason string `json:"stopReason,omitempty"`
}

type ServiceStatus struct {
	Service       string `json:"service"`
	Health        string `json:"health"` // up, down, unknown
	HealthError   string `json:"healthError,omitempty"`
	HealthUs      int64  `json:"healthCheckedUs"`
	Telemetry     string `json:"telemetry"` // ok, stale, never
	TelemetryUs   int64  `json:"lastTelemetryUs"`
	ExportErrors  int64  `json:"exportErrors"`
	NotifyDropped int64  `json:"notifyDropped"`
}

type ProxyState struct {
	Reachable bool     `json:"reachable"`
	Enabled   bool     `json:"enabled"`
	Toxics    []string `json:"toxics"`
	CheckedUs int64    `json:"checkedUs"`
	Error     string   `json:"error,omitempty"`
}

type Node struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
	Addr string `json:"addr"`
}

type EdgeProxy struct {
	Name     string   `json:"name"`
	Listen   string   `json:"listen"`
	Upstream string   `json:"upstream"`
	Edges    []string `json:"edges"` // 이 프록시를 공유하는 논리 연결
}

type Edge struct {
	ID       string     `json:"id"`
	From     string     `json:"from"`
	To       string     `json:"to"`
	Protocol string     `json:"protocol"`
	Proxy    *EdgeProxy `json:"proxy,omitempty"`
}

type Topology struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

type Event struct {
	ID     int64  `json:"id"`
	RunID  string `json:"runId"`
	AtUs   int64  `json:"atUs"`
	Type   string `json:"type"`
	Detail string `json:"detail"`
}

// Summarize의 지연 통계는 사용자가 취소하지 않은 완료 요청 전체(실패 포함)의 최근접 순위 백분위다.
func Summarize(traces []Trace) Summary {
	var s Summary
	var ds []int64
	for _, t := range traces {
		s.Total++
		switch t.Result {
		case wire.ResultRunning:
			s.InFlight++
		case wire.ResultOK:
			s.OK++
		case wire.ResultCanceled:
			s.Canceled++
		default:
			s.Failed++
		}
		if t.EndUs > 0 && t.Result != wire.ResultCanceled {
			ds = append(ds, t.EndUs-t.StartUs)
		}
		if t.Observation == ObsPartial || t.Observation == ObsUnknown {
			s.ObsIncomplete++
		}
		n := 0
		for _, sp := range t.Spans {
			if sp.Edge == "a-b" && sp.Kind == "client" {
				n++
				if sp.Result == wire.ResultTimeout {
					s.CallTimeouts++
				}
			}
		}
		s.Attempts += n
		if n > 1 {
			s.Retries += n - 1
		}
	}
	if len(ds) > 0 {
		sort.Slice(ds, func(i, j int) bool { return ds[i] < ds[j] })
		rank := func(p float64) int64 { return ds[int(math.Ceil(p*float64(len(ds))))-1] }
		s.P50Us, s.P95Us, s.MaxUs = rank(0.5), rank(0.95), ds[len(ds)-1]
	}
	return s
}
