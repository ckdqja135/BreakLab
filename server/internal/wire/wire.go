// Package wire는 관리 서버와 데모 서비스가 함께 쓰는 요청 헤더와 관측 메시지 형식을 정의한다.
package wire

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

const (
	HeaderCallTimeout = "X-Lab-Call-Timeout-Ms"
	HeaderMaxAttempts = "X-Lab-Max-Attempts"
	HeaderBackoff     = "X-Lab-Backoff-Ms"
	HeaderWork        = "X-Lab-Work-Ms"
	HeaderFlow        = "X-Lab-Flow"       // A가 차례로 부를 단계
	HeaderRun         = "X-Lab-Run"        // 실험 ID. 서비스가 실험마다 기억을 비우는 기준
	HeaderAuthCache   = "X-Lab-Auth-Cache" // A가 인증 결과를 기억하는 초
	HeaderIdempotent  = "X-Lab-Idempotent" // A가 결제에 멱등 키를 붙일지
	HeaderFaults      = "X-Lab-Faults"     // 서비스 안에서 일으킬 장애. 서비스 ID별 JSON
	// 아래는 A가 스스로를 지키는 장치다.
	HeaderBreaker     = "X-Lab-Breaker-S"    // 연달아 실패하면 이 초만큼 호출을 쉰다. 0이면 끔
	HeaderLimit       = "X-Lab-Limit"        // 한 서비스에 동시에 보내는 호출 수. 0이면 제한 없음
	HeaderFallback    = "X-Lab-Fallback"     // 실패한 단계가 있어도 임시로 접수한다
	HeaderBackoffGrow = "X-Lab-Backoff-Grow" // 재시도 대기를 매번 두 배로 늘리고 흔든다
	HeaderIdemKey     = "Idempotency-Key"
)

// 결과 값. span 속성 lab.result에 기록한다.
const (
	ResultRunning   = "running"
	ResultOK        = "ok"
	ResultHTTPError = "http_error"
	ResultTimeout   = "timeout"
	ResultCanceled  = "canceled"
	ResultRefused   = "refused"
	ResultReset     = "reset"
	ResultError     = "error"
	// ResultShed는 A가 스스로 부르지 않기로 한 경우다. 호출이 없으므로 span에는 쓰지 않는다.
	ResultShed = "shed"
)

// ServiceFault는 한 서비스가 요청을 처리할 때 실제로 따르는 장애 지시다.
type ServiceFault struct {
	ID          string `json:"id"`
	FailPercent int    `json:"fail,omitempty"`  // 오류로 응답하는 비율
	Slots       int    `json:"slots,omitempty"` // 동시에 처리하는 요청 수
	WorkMs      int    `json:"work,omitempty"`  // 요청 하나의 처리 시간
}

// Policy는 요청 하나가 서비스들을 지나며 따르는 조건이다. 요청마다 헤더로 전달하므로 실행 중 설정이 섞이지 않는다.
type Policy struct {
	CallTimeout  time.Duration
	MaxAttempts  int
	Backoff      time.Duration
	Work         time.Duration // B의 처리 시간
	Flow         string
	Run          string
	AuthCacheSec int
	Idempotent   bool
	Faults       map[string]ServiceFault

	BreakerSec    int
	MaxConcurrent int
	Fallback      bool
	BackoffGrow   bool
}

func clamp(n, min, max int) int {
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

func clampHeader(h http.Header, key string, def, min, max int) int {
	n, err := strconv.Atoi(h.Get(key))
	if err != nil {
		return def
	}
	return clamp(n, min, max)
}

// token은 영문 소문자, 숫자, 쉼표, 줄표만 통과시킨다.
func token(v string, max int) string {
	if len(v) > max {
		return ""
	}
	for _, c := range v {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c == ',' || c == '-') {
			return ""
		}
	}
	return v
}

// ParsePolicy는 서비스 쪽에서도 상한을 다시 적용한다.
func ParsePolicy(h http.Header) Policy {
	ms := time.Millisecond
	p := Policy{
		CallTimeout:  time.Duration(clampHeader(h, HeaderCallTimeout, 1000, 50, 10000)) * ms,
		MaxAttempts:  clampHeader(h, HeaderMaxAttempts, 1, 1, 4),
		Backoff:      time.Duration(clampHeader(h, HeaderBackoff, 200, 0, 2000)) * ms,
		Work:         time.Duration(clampHeader(h, HeaderWork, 15, 0, 3000)) * ms,
		Flow:         token(h.Get(HeaderFlow), 64),
		Run:          token(h.Get(HeaderRun), 32),
		AuthCacheSec: clampHeader(h, HeaderAuthCache, 0, 0, 120),
		Idempotent:   h.Get(HeaderIdempotent) == "1",

		BreakerSec:    clampHeader(h, HeaderBreaker, 0, 0, 30),
		MaxConcurrent: clampHeader(h, HeaderLimit, 0, 0, 5),
		Fallback:      h.Get(HeaderFallback) == "1",
		BackoffGrow:   h.Get(HeaderBackoffGrow) == "1",
	}
	if v := h.Get(HeaderFaults); v != "" && len(v) <= 1024 {
		var m map[string]ServiceFault
		if json.Unmarshal([]byte(v), &m) == nil {
			p.Faults = map[string]ServiceFault{}
			for k, f := range m {
				p.Faults[token(k, 32)] = ServiceFault{ID: token(f.ID, 32), FailPercent: clamp(f.FailPercent, 0, 100), Slots: clamp(f.Slots, 0, 5), WorkMs: clamp(f.WorkMs, 0, 3000)}
			}
		}
	}
	return p
}

// Apply는 다음 서비스로 보낼 요청에 조건을 그대로 옮겨 싣는다.
func (p Policy) Apply(h http.Header) {
	h.Set(HeaderCallTimeout, strconv.FormatInt(p.CallTimeout.Milliseconds(), 10))
	h.Set(HeaderMaxAttempts, strconv.Itoa(p.MaxAttempts))
	h.Set(HeaderBackoff, strconv.FormatInt(p.Backoff.Milliseconds(), 10))
	h.Set(HeaderWork, strconv.FormatInt(p.Work.Milliseconds(), 10))
	h.Set(HeaderFlow, p.Flow)
	h.Set(HeaderRun, p.Run)
	h.Set(HeaderAuthCache, strconv.Itoa(p.AuthCacheSec))
	h.Set(HeaderBreaker, strconv.Itoa(p.BreakerSec))
	h.Set(HeaderLimit, strconv.Itoa(p.MaxConcurrent))
	for k, on := range map[string]bool{HeaderIdempotent: p.Idempotent, HeaderFallback: p.Fallback, HeaderBackoffGrow: p.BackoffGrow} {
		if on {
			h.Set(k, "1")
		}
	}
	if len(p.Faults) > 0 {
		b, _ := json.Marshal(p.Faults)
		h.Set(HeaderFaults, string(b))
	}
}

// Heartbeat는 관측 경로가 살아 있는지 확인하기 위해 서비스가 주기적으로 보낸다.
type Heartbeat struct {
	Service       string `json:"service"`
	ExportErrors  int64  `json:"exportErrors"`
	NotifyDropped int64  `json:"notifyDropped"`
}

// Gauge는 서비스가 스스로 센 값이다. 관리 서버가 관리 경로로 읽어 화면에 그대로 보여 준다.
type Gauge struct {
	Label string `json:"label"`
	Value string `json:"value"`
	Alert bool   `json:"alert,omitempty"`
}
