// Package proxyctl은 실험 구간의 Toxiproxy 프록시들을 제어한다.
// 미리 정해진 이름의 프록시만 다루며 다른 프록시는 건드리지 않는다.
package proxyctl

import (
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
	"time"

	"breaklab/internal/model"

	toxi "github.com/Shopify/toxiproxy/v2/client"
)

const opTimeout = 3 * time.Second

// ErrMissing은 Toxiproxy에는 연결됐지만 실험용 프록시가 없다는 뜻이다.
var ErrMissing = errors.New("실험용 프록시가 Toxiproxy에 없습니다")

// Proxy는 연결 하나에 놓인 프록시다.
type Proxy struct {
	Name, Listen, Upstream string
}

type Ctl struct {
	client  *toxi.Client
	proxies map[string]Proxy // 연결 ID별
}

func New(api, token string, proxies map[string]Proxy) *Ctl {
	c := toxi.NewClient(api)
	c.AuthToken = token
	return &Ctl{client: c, proxies: proxies}
}

// Edges는 프록시가 놓인 연결 ID를 정해진 순서로 돌려준다.
func (c *Ctl) Edges() []string {
	out := make([]string, 0, len(c.proxies))
	for e := range c.proxies {
		out = append(out, e)
	}
	sort.Strings(out)
	return out
}

func (c *Ctl) Proxy(edge string) (Proxy, bool) {
	p, ok := c.proxies[edge]
	return p, ok
}

// 공식 클라이언트의 HTTP 제한 시간은 30초로 고정돼 있다. 비상 중지가 기다리지 않도록 더 짧게 끊는다.
// 늦게 반영된 변경은 관리 서버의 주기 대조가 다시 정리한다.
func bounded(fn func() error) error {
	ch := make(chan error, 1)
	go func() { ch <- fn() }()
	select {
	case err := <-ch:
		return err
	case <-time.After(opTimeout):
		return fmt.Errorf("Toxiproxy 응답이 %s 안에 오지 않았습니다", opTimeout)
	}
}

func samePort(a, b string) bool {
	_, pa, e1 := net.SplitHostPort(a)
	_, pb, e2 := net.SplitHostPort(b)
	return e1 == nil && e2 == nil && pa == pb
}

// all은 Toxiproxy에 있는 프록시를 한 번에 읽는다.
func (c *Ctl) all() (map[string]*toxi.Proxy, error) {
	var all map[string]*toxi.Proxy
	err := bounded(func() (err error) { all, err = c.client.Proxies(); return })
	return all, err
}

func state(def Proxy, p *toxi.Proxy, err error) (model.ProxyState, error) {
	st := model.ProxyState{CheckedUs: model.NowUs(), Toxics: []string{}}
	if err == nil && p == nil {
		st.Reachable, err = true, ErrMissing
	}
	if err != nil {
		st.Error = err.Error()
		return st, err
	}
	st.Reachable, st.Enabled = true, p.Enabled
	for _, t := range p.ActiveToxics {
		st.Toxics = append(st.Toxics, t.Name)
	}
	if !samePort(p.Listen, def.Listen) || p.Upstream != def.Upstream {
		st.Error = fmt.Sprintf("프록시 설정 불일치: %s에서 %s", p.Listen, p.Upstream)
		return st, errors.New(st.Error)
	}
	return st, nil
}

// States는 모든 프록시의 실제 상태를 읽는다. 오류가 있는 연결은 errs에 담는다.
func (c *Ctl) States() (map[string]model.ProxyState, map[string]error) {
	all, err := c.all()
	out, errs := map[string]model.ProxyState{}, map[string]error{}
	for edge, def := range c.proxies {
		st, e := state(def, all[def.Name], err)
		out[edge] = st
		if e != nil {
			errs[edge] = e
		}
	}
	return out, errs
}

func (c *Ctl) State(edge string) (model.ProxyState, error) {
	def := c.proxies[edge]
	all, err := c.all()
	return state(def, all[def.Name], err)
}

// ensure는 프록시가 없거나 설정이 다르면 다시 만든다.
func (c *Ctl) ensure(def Proxy, p *toxi.Proxy) (*toxi.Proxy, error) {
	if p != nil {
		if samePort(p.Listen, def.Listen) && p.Upstream == def.Upstream {
			return p, nil
		}
		if err := bounded(p.Delete); err != nil {
			return nil, err
		}
	}
	err := bounded(func() (err error) { p, err = c.client.CreateProxy(def.Name, def.Listen, def.Upstream); return })
	return p, err
}

func ToxicName(f model.Fault) string { return "lab_" + f.ID }

func (c *Ctl) Apply(f model.Fault) error {
	def, ok := c.proxies[f.Edge]
	if !ok {
		return errors.New("프록시가 없는 연결입니다")
	}
	all, err := c.all()
	if err != nil {
		return err
	}
	p := all[def.Name]
	if p == nil {
		return ErrMissing
	}
	if f.Type == "cut" {
		return bounded(p.Disable)
	}
	stream := "downstream"
	if f.Direction == "request" {
		stream = "upstream"
	}
	kind, attrs := "latency", toxi.Attributes{"latency": f.LatencyMs, "jitter": f.JitterMs}
	// 아래 둘은 요청 방향에만 건다. 응답 방향에 걸면 도착 서비스가 응답 뒤 연결을 닫는 순간 함께 닫혀 의도와 다르게 동작한다.
	switch f.Type {
	case "blackhole": // 요청을 버리고 연결은 열어 둔다.
		kind, attrs, stream = "timeout", toxi.Attributes{"timeout": 0}, "upstream"
	case "reset": // 요청이 지나가는 순간 연결을 강제로 끊는다.
		kind, attrs, stream = "reset_peer", toxi.Attributes{"timeout": 0}, "upstream"
	}
	return bounded(func() error {
		_, err := p.AddToxic(ToxicName(f), kind, stream, 1, attrs)
		return err
	})
}

// Matches는 프록시 실제 상태가 장애 설정과 같은지 확인한다.
func Matches(st model.ProxyState, f model.Fault) bool {
	if f.Type == "cut" {
		return !st.Enabled && len(st.Toxics) == 0
	}
	return st.Enabled && len(st.Toxics) == 1 && st.Toxics[0] == ToxicName(f)
}

func Clean(st model.ProxyState) bool { return st.Reachable && st.Enabled && len(st.Toxics) == 0 }

// Clear는 고른 연결의 toxic을 모두 지우고 프록시를 켠 뒤 실제 상태를 다시 읽어 확인한다.
// edges가 비어 있으면 모든 연결을 정리한다.
func (c *Ctl) Clear(edges ...string) (map[string]model.ProxyState, model.Cleanup) {
	if len(edges) == 0 {
		edges = c.Edges()
	}
	var errs []string
	all, err := c.all()
	if err != nil {
		errs = append(errs, err.Error())
	}
	for _, edge := range edges {
		if err != nil {
			break
		}
		def := c.proxies[edge]
		p, e := c.ensure(def, all[def.Name])
		if e != nil {
			errs = append(errs, def.Name+": "+e.Error())
			continue
		}
		for _, t := range p.ActiveToxics {
			if e := bounded(func() error { return p.RemoveToxic(t.Name) }); e != nil {
				errs = append(errs, def.Name+": "+e.Error())
			}
		}
		if !p.Enabled {
			if e := bounded(p.Enable); e != nil {
				errs = append(errs, def.Name+": "+e.Error())
			}
		}
	}
	states, bad := c.States()
	out := map[string]model.ProxyState{}
	left, off := 0, 0
	for _, edge := range edges {
		st := states[edge]
		out[edge] = st
		if e := bad[edge]; e != nil {
			errs = append(errs, c.proxies[edge].Name+": "+e.Error())
		}
		left += len(st.Toxics)
		if !st.Enabled {
			off++
		}
	}
	cl := model.Cleanup{CheckedUs: model.NowUs()}
	if len(errs) > 0 || left > 0 || off > 0 {
		cl.Detail = fmt.Sprintf("정리 확인 실패: 남은 toxic %d개, 꺼진 프록시 %d개 %s", left, off, strings.Join(errs, ", "))
		return out, cl
	}
	cl.Verified, cl.Detail = true, "남은 toxic 0개, 프록시 켜짐을 확인함"
	return out, cl
}
