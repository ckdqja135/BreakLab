package lab

import (
	"testing"
	"time"

	"breaklab/internal/model"
	"breaklab/internal/wire"
)

// 요청 1개에 대해 주어진 span만 도착했을 때의 관측 상태와 A에서 B 호출의 경로 판정을 확인한다.
func TestObservationAndRoute(t *testing.T) {
	span := func(id, parent, svc, kind string, a map[string]string) model.Span {
		return model.Span{TraceID: "t", SpanID: id, ParentID: parent, Service: svc, Kind: kind, StartUs: 10, EndUs: 20, Result: wire.ResultOK, Attrs: a}
	}
	root := span("r", "", generatorID, "client", map[string]string{"peer.service": "service-a", "http.response.status_code": "200", "lab.request_written": "true"})
	aSrv := span("a", "r", "service-a", "server", map[string]string{"lab.attempts": "1"})
	call := func(remote, status string) model.Span {
		m := map[string]string{"peer.service": "service-b", "server.port": "7721", "lab.conn.local": "127.0.0.1:50000", "lab.conn.remote": remote, "lab.request_written": "true"}
		if status != "" {
			m["http.response.status_code"] = status
		}
		return span("c", "a", "service-a", "client", m)
	}
	bSrv := func(peer string) model.Span {
		return span("b", "c", "service-b", "server", map[string]string{"network.peer.address": peer})
	}
	refused := span("c", "a", "service-a", "client", map[string]string{"peer.service": "service-b", "server.port": "7721"})

	cases := []struct {
		name         string
		spans        []model.Span
		obs, route   string
		affectedByFl bool
	}{
		{"모두 도착, 프록시 경유", []model.Span{aSrv, call("127.0.0.1:7721", "200"), bSrv("127.0.0.1:60000")}, model.ObsComplete, "proxied", true},
		{"프록시 우회는 장애 적용으로 표시하지 않음", []model.Span{aSrv, call("127.0.0.1:7720", "200"), bSrv("127.0.0.1:50000")}, model.ObsComplete, "bypassed", false},
		{"응답은 있는데 B span 누락", []model.Span{aSrv, call("127.0.0.1:7721", "200")}, model.ObsPartial, "proxy_side", true},
		{"응답 없이 B span도 없음", []model.Span{aSrv, call("127.0.0.1:7721", "")}, model.ObsUnknown, "proxy_side", true},
		{"연결 거부는 B 미도달이 확실함", []model.Span{aSrv, refused}, model.ObsComplete, "proxy_dial", true},
		{"A span 누락", nil, model.ObsPartial, "", false},
	}
	faults := []model.Fault{{ID: "f", Edge: "a-b", AppliedUs: 5}}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRegistry("127.0.0.1:7721", time.Minute)
			open := root
			open.EndUs = 0
			r.begin(model.Trace{TraceID: "t", StartUs: 10}, open)
			r.add(root)
			r.finish("t", wire.ResultOK, "", 200, 20)
			for _, s := range c.spans {
				r.add(s)
			}
			if c.obs != model.ObsComplete {
				if got := r.collect(faults, false)[0]; got.Observation != model.ObsWaiting {
					t.Fatalf("유예 시간 안에는 관측 대기여야 함: %s", got.Observation)
				}
			}
			got := r.collect(faults, true)[0]
			if got.Observation != c.obs {
				t.Fatalf("관측 상태 %s, 기대 %s (%v)", got.Observation, c.obs, got.Notes)
			}
			for _, s := range got.Spans {
				if s.Edge == injectableEdge && (s.Route != c.route || (len(s.FaultIDs) > 0) != c.affectedByFl) {
					t.Fatalf("경로 %s 장애 %v, 기대 %s %v", s.Route, s.FaultIDs, c.route, c.affectedByFl)
				}
			}
		})
	}
}
