// Package wire는 관리 서버와 데모 서비스가 함께 쓰는 요청 헤더와 관측 메시지 형식을 정의한다.
package wire

import (
	"net/http"
	"strconv"
	"time"
)

const (
	HeaderCallTimeout = "X-Lab-Call-Timeout-Ms"
	HeaderMaxAttempts = "X-Lab-Max-Attempts"
	HeaderBackoff     = "X-Lab-Backoff-Ms"
	HeaderWork        = "X-Lab-Work-Ms"
	// 아래는 Service B 안에서 일으키는 장애다. A는 받은 값을 그대로 B에 전달한다.
	HeaderFailPercent = "X-Lab-B-Fail-Percent"
	HeaderSlots       = "X-Lab-B-Slots"
	HeaderFaults      = "X-Lab-Fault-Ids"
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
)

// Policy는 A가 B를 호출할 때 쓰는 조건이다. 요청마다 헤더로 전달하므로 실행 중 설정이 섞이지 않는다.
type Policy struct {
	CallTimeout time.Duration
	MaxAttempts int
	Backoff     time.Duration
	Work        time.Duration
	FailPercent int    // B가 오류로 응답하는 비율. 0이면 끔
	Slots       int    // B가 동시에 처리하는 요청 수. 0이면 제한 없음
	Faults      string // 이 요청에 실린 서비스 장애 ID 목록(쉼표 구분)
}

func clampHeader(h http.Header, key string, def, min, max int) int {
	n, err := strconv.Atoi(h.Get(key))
	if err != nil {
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

// ParsePolicy는 서비스 쪽에서도 상한을 다시 적용한다.
func ParsePolicy(h http.Header) Policy {
	ms := time.Millisecond
	return Policy{
		CallTimeout: time.Duration(clampHeader(h, HeaderCallTimeout, 1000, 50, 10000)) * ms,
		MaxAttempts: clampHeader(h, HeaderMaxAttempts, 1, 1, 4),
		Backoff:     time.Duration(clampHeader(h, HeaderBackoff, 200, 0, 2000)) * ms,
		Work:        time.Duration(clampHeader(h, HeaderWork, 15, 0, 3000)) * ms,
		FailPercent: clampHeader(h, HeaderFailPercent, 0, 0, 100),
		Slots:       clampHeader(h, HeaderSlots, 0, 0, 5),
		Faults:      faultIDs(h.Get(HeaderFaults)),
	}
}

// faultIDs는 관리 서버가 만든 ID 형식(16진수와 쉼표)만 통과시킨다.
func faultIDs(v string) string {
	if len(v) > 64 {
		return ""
	}
	for _, c := range v {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c == ',') {
			return ""
		}
	}
	return v
}

func (p Policy) Apply(h http.Header) {
	h.Set(HeaderCallTimeout, strconv.FormatInt(p.CallTimeout.Milliseconds(), 10))
	h.Set(HeaderMaxAttempts, strconv.Itoa(p.MaxAttempts))
	h.Set(HeaderBackoff, strconv.FormatInt(p.Backoff.Milliseconds(), 10))
	h.Set(HeaderWork, strconv.FormatInt(p.Work.Milliseconds(), 10))
	p.ApplyService(h)
}

// ApplyService는 B 안에서 일으킬 장애만 싣는다. 장애가 없으면 헤더를 붙이지 않는다.
func (p Policy) ApplyService(h http.Header) {
	if p.FailPercent > 0 {
		h.Set(HeaderFailPercent, strconv.Itoa(p.FailPercent))
	}
	if p.Slots > 0 {
		h.Set(HeaderSlots, strconv.Itoa(p.Slots))
	}
	if p.Faults != "" {
		h.Set(HeaderFaults, p.Faults)
	}
}

// Heartbeat는 관측 경로가 살아 있는지 확인하기 위해 서비스가 주기적으로 보낸다.
type Heartbeat struct {
	Service       string `json:"service"`
	ExportErrors  int64  `json:"exportErrors"`
	NotifyDropped int64  `json:"notifyDropped"`
}
