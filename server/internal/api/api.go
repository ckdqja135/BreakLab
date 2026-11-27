// Package api는 브라우저용 API와 서비스용 관측 수신 API를 제공한다. 두 API는 다른 포트에서 연다.
package api

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"breaklab/internal/lab"
	"breaklab/internal/model"
	"breaklab/internal/wire"

	collector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	common "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, err error) {
	code := http.StatusInternalServerError
	var c lab.Conflict
	var i lab.Invalid
	if errors.As(err, &c) {
		code = http.StatusConflict
	} else if errors.As(err, &i) {
		code = http.StatusBadRequest
	}
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

func body(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "요청 본문을 읽을 수 없습니다: " + err.Error()})
		return false
	}
	return true
}

func reply(w http.ResponseWriter, v any, err error) {
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// Public은 브라우저용 API다. hosts에 있는 Host와 Origin만 받아 다른 웹 페이지가 실험을 조작하지 못하게 한다.
func Public(l *lab.Lab, webDir string, hosts []string) http.Handler {
	mux := http.NewServeMux()
	ok := map[string]bool{"ok": true}

	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, l.State()) })
	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) { stream(l, w, r) })
	mux.HandleFunc("POST /api/runs", func(w http.ResponseWriter, r *http.Request) {
		in := struct {
			Label    string         `json:"label"`
			Settings model.Settings `json:"settings"`
			LimitSec int            `json:"limitSec"`
		}{Settings: model.DefaultSettings}
		if body(w, r, &in) {
			run, err := l.StartRun(strings.TrimSpace(in.Label), in.Settings, in.LimitSec)
			reply(w, run, err)
		}
	})
	mux.HandleFunc("POST /api/runs/end", func(w http.ResponseWriter, _ *http.Request) {
		cl, n, err := l.EndRun("manual")
		reply(w, map[string]any{"cleanup": cl, "canceled": n}, err)
	})
	mux.HandleFunc("POST /api/emergency-stop", func(w http.ResponseWriter, _ *http.Request) {
		cl, n, err := l.EndRun("emergency")
		reply(w, map[string]any{"cleanup": cl, "canceled": n}, err)
	})
	mux.HandleFunc("POST /api/requests", func(w http.ResponseWriter, _ *http.Request) {
		seq, id, err := l.Send("single")
		reply(w, map[string]any{"seq": seq, "traceId": id}, err)
	})
	mux.HandleFunc("POST /api/repeat", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Count       int `json:"count"`
			IntervalMs  int `json:"intervalMs"`
			Concurrency int `json:"concurrency"`
		}
		if body(w, r, &in) {
			reply(w, ok, l.StartRepeat(in.Count, in.IntervalMs, in.Concurrency))
		}
	})
	mux.HandleFunc("POST /api/repeat/stop", func(w http.ResponseWriter, _ *http.Request) { reply(w, ok, l.StopRepeat()) })
	mux.HandleFunc("POST /api/faults", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Edge      string `json:"edge"`
			Node      string `json:"node"`
			Type      string `json:"type"`
			Direction string `json:"direction"`
			LatencyMs int    `json:"latencyMs"`
			JitterMs  int    `json:"jitterMs"`
			Percent   int    `json:"percent"`
			Slots     int    `json:"slots"`
			WorkMs    int    `json:"workMs"`
			TTLSec    int    `json:"ttlSec"`
		}
		if body(w, r, &in) {
			f, err := l.ApplyFault(model.Fault{Edge: in.Edge, Node: in.Node, Type: in.Type, Direction: in.Direction,
				LatencyMs: in.LatencyMs, JitterMs: in.JitterMs, Percent: in.Percent, Slots: in.Slots, WorkMs: in.WorkMs, TTLSec: in.TTLSec})
			reply(w, f, err)
		}
	})
	mux.HandleFunc("POST /api/faults/{id}/remove", func(w http.ResponseWriter, r *http.Request) {
		f, err := l.RemoveFault(r.PathValue("id"), "manual")
		reply(w, f, err)
	})
	mux.HandleFunc("GET /api/runs", func(w http.ResponseWriter, _ *http.Request) {
		runs, err := l.Runs()
		reply(w, runs, err)
	})
	mux.HandleFunc("GET /api/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		d, err := l.RunDetail(r.PathValue("id"))
		if err == nil && d == nil {
			writeJSON(w, 404, map[string]string{"error": "실행 이력을 찾을 수 없습니다"})
			return
		}
		reply(w, d, err)
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 404, map[string]string{"error": "없는 API입니다"})
	})
	files := http.FileServer(http.Dir(webDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if _, err := os.Stat(filepath.Join(webDir, filepath.Clean("/"+r.URL.Path))); err != nil {
			http.ServeFile(w, r, filepath.Join(webDir, "index.html"))
			return
		}
		files.ServeHTTP(w, r)
	})
	return guard(mux, hosts)
}

func guard(next http.Handler, hosts []string) http.Handler {
	allowed := map[string]bool{}
	for _, h := range hosts {
		allowed[strings.TrimSpace(h)] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowed[r.Host] {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "허용되지 않은 Host입니다"})
			return
		}
		if o := r.Header.Get("Origin"); o != "" {
			host := strings.TrimPrefix(strings.TrimPrefix(o, "http://"), "https://")
			if !allowed[host] {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "허용되지 않은 Origin입니다"})
				return
			}
		}
		if r.Method == http.MethodPost && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "application/json 요청만 받습니다"})
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func stream(l *lab.Lab, w http.ResponseWriter, r *http.Request) {
	rc := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	ch, cancel := l.Hub().Subscribe()
	defer cancel()
	send := func(typ string, data []byte) bool {
		rc.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", typ, data); err != nil {
			return false
		}
		return rc.Flush() == nil
	}
	first, _ := json.Marshal(l.State())
	if !send("snapshot", first) {
		return
	}
	ping := time.NewTicker(10 * time.Second)
	defer ping.Stop()
	for {
		select {
		case m, open := <-ch:
			if !open || !send(m.Type, m.Data) {
				return
			}
		case <-ping.C:
			if !send("ping", []byte("{}")) {
				return
			}
		case <-r.Context().Done():
			return
		}
	}
}

// Telemetry는 서비스가 쓰는 관측 수신 API다. OTLP는 HTTP protobuf의 trace 내보내기만 받는다.
func Telemetry(l *lab.Lab) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/traces", func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-protobuf") {
			http.Error(w, "application/x-protobuf만 지원", http.StatusUnsupportedMediaType)
			return
		}
		var src io.Reader = http.MaxBytesReader(w, r.Body, 4<<20)
		if r.Header.Get("Content-Encoding") == "gzip" {
			gz, err := gzip.NewReader(src)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			src = io.LimitReader(gz, 8<<20)
		}
		b, err := io.ReadAll(src)
		var req collector.ExportTraceServiceRequest
		if err == nil {
			err = proto.Unmarshal(b, &req)
		}
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		for _, s := range convert(&req) {
			l.AddSpan(s)
		}
		out, _ := proto.Marshal(&collector.ExportTraceServiceResponse{})
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.Write(out)
	})
	mux.HandleFunc("POST /telemetry/span-start", func(w http.ResponseWriter, r *http.Request) {
		var s model.Span
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&s); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		s.EndUs, s.Result, s.Events = 0, wire.ResultRunning, nil
		l.AddSpan(s)
	})
	mux.HandleFunc("POST /telemetry/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		var h wire.Heartbeat
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&h); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		l.Heartbeat(h)
	})
	return mux
}

func attrs(kvs []*common.KeyValue) map[string]string {
	m := map[string]string{}
	for _, kv := range kvs {
		switch v := kv.Value.GetValue().(type) {
		case *common.AnyValue_StringValue:
			m[kv.Key] = v.StringValue
		case *common.AnyValue_IntValue:
			m[kv.Key] = fmt.Sprint(v.IntValue)
		case *common.AnyValue_BoolValue:
			m[kv.Key] = fmt.Sprint(v.BoolValue)
		case *common.AnyValue_DoubleValue:
			m[kv.Key] = fmt.Sprint(v.DoubleValue)
		}
	}
	return m
}

func convert(req *collector.ExportTraceServiceRequest) []model.Span {
	var out []model.Span
	for _, rs := range req.ResourceSpans {
		service := attrs(rs.GetResource().GetAttributes())["service.name"]
		for _, ss := range rs.ScopeSpans {
			for _, p := range ss.Spans {
				s := model.Span{
					TraceID: fmt.Sprintf("%x", p.TraceId), SpanID: fmt.Sprintf("%x", p.SpanId), ParentID: fmt.Sprintf("%x", p.ParentSpanId),
					Service: service, Name: p.Name, Kind: "internal", Attrs: attrs(p.Attributes),
					StartUs: int64(p.StartTimeUnixNano / 1000), EndUs: int64(p.EndTimeUnixNano / 1000),
				}
				switch p.Kind {
				case tracepb.Span_SPAN_KIND_CLIENT:
					s.Kind = "client"
				case tracepb.Span_SPAN_KIND_SERVER:
					s.Kind = "server"
				}
				for _, e := range p.Events {
					s.Events = append(s.Events, model.SpanEvent{AtUs: int64(e.TimeUnixNano / 1000), Name: e.Name, Attrs: attrs(e.Attributes)})
				}
				if s.Result = s.Attrs["lab.result"]; s.Result == "" {
					s.Result = wire.ResultError
					log.Printf("결과 속성이 없는 span: %s %s", service, p.Name)
				}
				s.Error = s.Attrs["lab.error"]
				out = append(out, s)
			}
		}
	}
	return out
}
