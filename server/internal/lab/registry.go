package lab

import (
	"net"
	"slices"
	"sort"
	"strconv"
	"sync"
	"time"

	"breaklab/internal/model"
	"breaklab/internal/wire"
)

// registry는 요청별 span을 모으고 관측 상태를 판정한다.
// 데이터가 없다는 사실을 성공이나 실패로 바꾸지 않는다.
type registry struct {
	mu        sync.Mutex
	recs      map[string]*rec
	proxyPort string
	grace     time.Duration
	dropped   int64
}

type rec struct {
	t        model.Trace
	spans    map[string]*model.Span
	lastSeen time.Time
	dirty    bool
	waiting  bool
}

func newRegistry(proxyListen string, grace time.Duration) *registry {
	_, port, _ := net.SplitHostPort(proxyListen)
	return &registry{recs: map[string]*rec{}, proxyPort: port, grace: grace}
}

func (r *registry) begin(t model.Trace, root model.Span) {
	r.mu.Lock()
	defer r.mu.Unlock()
	t.Result, t.Observation = wire.ResultRunning, model.ObsWaiting
	rc := &rec{t: t, spans: map[string]*model.Span{}, lastSeen: time.Now(), dirty: true, waiting: true}
	root.SeenUs = model.NowUs()
	rc.spans[root.SpanID] = &root
	r.recs[t.TraceID] = rc
}

func (r *registry) finish(traceID, result, errText string, status int, endUs int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if rc := r.recs[traceID]; rc != nil {
		rc.t.Result, rc.t.Error, rc.t.HTTPStatus, rc.t.EndUs = result, errText, status, endUs
		rc.lastSeen, rc.dirty = time.Now(), true
	}
}

// add는 시작 알림과 완료 span을 모두 받는다. 완료 정보를 시작 알림이 덮어쓰지 않는다.
func (r *registry) add(s model.Span) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rc := r.recs[s.TraceID]
	if rc == nil {
		r.dropped++
		return
	}
	old := rc.spans[s.SpanID]
	if old != nil && old.EndUs > 0 {
		return
	}
	s.SeenUs = model.NowUs()
	if old != nil {
		s.SeenUs = old.SeenUs
	}
	rc.spans[s.SpanID] = &s
	rc.lastSeen, rc.dirty, rc.waiting = time.Now(), true, true
}

func (r *registry) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.recs = map[string]*rec{}
}

// collect는 바뀐 요청을 다시 판정해 돌려준다. force면 유예 시간을 기다리지 않고 확정한다.
func (r *registry) collect(faults []model.Fault, force bool) []model.Trace {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []model.Trace
	now := time.Now()
	for _, rc := range r.recs {
		expired := force || now.Sub(rc.lastSeen) > r.grace
		if !rc.dirty && !(rc.waiting && expired && rc.t.EndUs > 0) {
			continue
		}
		r.evaluate(rc, faults, expired)
		rc.dirty = false
		out = append(out, rc.snapshot())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}

func (r *registry) all() []model.Trace {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]model.Trace, 0, len(r.recs))
	for _, rc := range r.recs {
		out = append(out, rc.snapshot())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}

func (rc *rec) snapshot() model.Trace {
	t := rc.t
	if t.Notes == nil {
		t.Notes = []string{}
	}
	t.Spans = make([]model.Span, 0, len(rc.spans))
	for _, s := range rc.spans {
		t.Spans = append(t.Spans, *s)
	}
	sort.Slice(t.Spans, func(i, j int) bool { return t.Spans[i].StartUs < t.Spans[j].StartUs })
	return t
}

func (r *registry) evaluate(rc *rec, faults []model.Fault, expired bool) {
	var notes []string
	missing, unknown, pending := false, false, rc.t.EndUs == 0
	children := map[string][]*model.Span{}
	for _, s := range rc.spans {
		if s.ParentID != "" {
			children[s.ParentID] = append(children[s.ParentID], s)
			if rc.spans[s.ParentID] == nil {
				if expired {
					missing = true
					notes = append(notes, s.Service+" span의 상위 span이 도착하지 않음")
				} else {
					pending = true
				}
			}
		}
		if s.EndUs == 0 && s.Service != generatorID {
			if expired {
				missing = true
				notes = append(notes, s.Service+" "+s.Name+"의 종료 기록이 도착하지 않음")
			} else {
				pending = true
			}
		}
	}
	for _, s := range rc.spans {
		if s.Kind == "client" {
			s.Edge = edgeOf(s)
			var peer *model.Span
			for _, c := range children[s.SpanID] {
				if c.Kind == "server" {
					peer = c
				}
			}
			s.Peer = r.peerState(s, peer, expired)
			s.Route = r.route(s, peer)
			s.FaultIDs = faultsFor(s, faults)
			switch s.Peer {
			case "waiting":
				pending = true
			case "missing":
				missing = true
				notes = append(notes, "응답은 받았지만 도착 서비스의 span이 없음: "+edgeName(s.Edge))
			case "undetermined":
				unknown = true
				notes = append(notes, "도착 서비스가 요청을 받았는지 판단할 수 없음: "+edgeName(s.Edge))
			}
			if peer != nil && s.StartUs-peer.StartUs > 5000 {
				notes = append(notes, "서비스 간 시계 차이가 있어 구간 시간이 정확하지 않을 수 있음")
			}
			if peer != nil && s.EndUs > 0 && peer.StartUs > s.EndUs {
				notes = append(notes, "호출자가 포기한 뒤 도착 서비스가 요청을 받음: "+edgeName(s.Edge))
			}
		}
		if s.Kind == "server" && s.EndUs > 0 && s.Attrs["lab.attempts"] != "" {
			want, _ := strconv.Atoi(s.Attrs["lab.attempts"])
			got := 0
			for _, c := range children[s.SpanID] {
				if c.Kind == "client" {
					got++
				}
			}
			if got < want {
				if expired {
					missing = true
					notes = append(notes, "호출 시도 span 일부가 도착하지 않음")
				} else {
					pending = true
				}
			}
		}
	}
	sort.Strings(notes)
	rc.t.Notes = slices.Compact(notes)
	rc.waiting = pending
	switch {
	case pending:
		rc.t.Observation = model.ObsWaiting
	case missing:
		rc.t.Observation = model.ObsPartial
	case unknown:
		rc.t.Observation = model.ObsUnknown
	default:
		rc.t.Observation = model.ObsComplete
	}
}

func edgeName(id string) string {
	if id == injectableEdge {
		return "Service A에서 Service B"
	}
	return "요청 발생기에서 Service A"
}

func edgeOf(s *model.Span) string {
	for _, e := range edges {
		if e.From == s.Service && e.To == s.Attrs["peer.service"] {
			return e.ID
		}
	}
	return ""
}

func (r *registry) peerState(s, peer *model.Span, expired bool) string {
	switch {
	case peer != nil:
		return "observed"
	case s.EndUs == 0 && !expired:
		return "waiting"
	case s.EndUs > 0 && s.Attrs["http.response.status_code"] == "" && s.Attrs["lab.request_written"] == "":
		return "not_sent" // 요청을 쓰기 전에 실패했으므로 도착할 수 없다.
	case !expired:
		return "waiting"
	case s.Attrs["http.response.status_code"] != "":
		return "missing"
	}
	return "undetermined"
}

// route는 A와 B 양쪽이 기록한 실제 연결 주소로 프록시 통과 여부를 판정한다.
func (r *registry) route(s, peer *model.Span) string {
	if s.Edge != injectableEdge {
		return "direct"
	}
	remote, local := s.Attrs["lab.conn.remote"], s.Attrs["lab.conn.local"]
	if remote == "" {
		if s.EndUs > 0 && s.Attrs["server.port"] == r.proxyPort {
			return "proxy_dial" // 프록시 주소로 연결을 시도했지만 연결되지 않았다.
		}
		if s.EndUs > 0 && s.Attrs["server.port"] != "" {
			return "bypassed"
		}
		return "undetermined"
	}
	_, port, _ := net.SplitHostPort(remote)
	if port != r.proxyPort {
		return "bypassed"
	}
	if peer == nil {
		return "proxy_side"
	}
	if peer.Attrs["network.peer.address"] == local {
		return "bypassed"
	}
	return "proxied"
}

func faultsFor(s *model.Span, faults []model.Fault) []string {
	var ids []string
	if s.Edge != injectableEdge || s.Route == "bypassed" || s.Route == "undetermined" {
		return nil
	}
	for _, f := range faults {
		if f.Edge != s.Edge || f.AppliedUs == 0 || (s.EndUs > 0 && f.AppliedUs > s.EndUs) || (f.RemovedUs > 0 && f.RemovedUs < s.StartUs) {
			continue
		}
		ids = append(ids, f.ID)
	}
	return ids
}
