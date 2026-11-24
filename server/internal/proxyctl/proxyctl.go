// Package proxyctl은 실험 구간의 Toxiproxy 프록시 하나를 제어한다.
// 미리 정해진 프록시 이름만 다루며 다른 프록시는 건드리지 않는다.
package proxyctl

import (
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"breaklab/internal/model"

	toxi "github.com/Shopify/toxiproxy/v2/client"
)

const opTimeout = 3 * time.Second

// ErrMissing은 Toxiproxy에는 연결됐지만 실험용 프록시가 없다는 뜻이다.
var ErrMissing = errors.New("실험용 프록시가 Toxiproxy에 없습니다")

type Ctl struct {
	client                 *toxi.Client
	Name, Listen, Upstream string
}

func New(api, token, name, listen, upstream string) *Ctl {
	c := toxi.NewClient(api)
	c.AuthToken = token
	return &Ctl{client: c, Name: name, Listen: listen, Upstream: upstream}
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

func (c *Ctl) get() (*toxi.Proxy, error) {
	var p *toxi.Proxy
	err := bounded(func() error {
		all, err := c.client.Proxies()
		if err != nil {
			return err
		}
		p = all[c.Name]
		return nil
	})
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, ErrMissing
	}
	return p, nil
}

func (c *Ctl) State() (model.ProxyState, error) {
	st := model.ProxyState{CheckedUs: model.NowUs(), Toxics: []string{}}
	p, err := c.get()
	if err != nil {
		st.Reachable = errors.Is(err, ErrMissing)
		st.Error = err.Error()
		return st, err
	}
	st.Reachable, st.Enabled = true, p.Enabled
	for _, t := range p.ActiveToxics {
		st.Toxics = append(st.Toxics, t.Name)
	}
	if !samePort(p.Listen, c.Listen) || p.Upstream != c.Upstream {
		st.Error = fmt.Sprintf("프록시 설정 불일치: %s에서 %s", p.Listen, p.Upstream)
		return st, errors.New(st.Error)
	}
	return st, nil
}

// Ensure는 프록시가 없거나 설정이 다르면 다시 만든다.
func (c *Ctl) Ensure() error {
	p, err := c.get()
	if err == nil {
		if samePort(p.Listen, c.Listen) && p.Upstream == c.Upstream {
			return nil
		}
		if err := bounded(p.Delete); err != nil {
			return err
		}
	} else if !errors.Is(err, ErrMissing) {
		return err
	}
	return bounded(func() error {
		_, err := c.client.CreateProxy(c.Name, c.Listen, c.Upstream)
		return err
	})
}

func ToxicName(f model.Fault) string { return "lab_" + f.ID }

func (c *Ctl) Apply(f model.Fault) error {
	p, err := c.get()
	if err != nil {
		return err
	}
	if f.Type == "cut" {
		return bounded(p.Disable)
	}
	stream := "downstream"
	if f.Direction == "request" {
		stream = "upstream"
	}
	return bounded(func() error {
		_, err := p.AddToxic(ToxicName(f), "latency", stream, 1, toxi.Attributes{"latency": f.LatencyMs, "jitter": f.JitterMs})
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

// Clear는 모든 toxic을 지우고 프록시를 켠 뒤 실제 상태를 다시 읽어 확인한다.
func (c *Ctl) Clear() (model.ProxyState, model.Cleanup) {
	fail := func(st model.ProxyState, err error) (model.ProxyState, model.Cleanup) {
		return st, model.Cleanup{CheckedUs: model.NowUs(), Detail: "정리 확인 실패: " + err.Error()}
	}
	if err := c.Ensure(); err != nil {
		return fail(model.ProxyState{CheckedUs: model.NowUs(), Error: err.Error(), Toxics: []string{}}, err)
	}
	p, err := c.get()
	if err != nil {
		return fail(model.ProxyState{CheckedUs: model.NowUs(), Error: err.Error(), Toxics: []string{}}, err)
	}
	var errs []string
	for _, t := range p.ActiveToxics {
		if err := bounded(func() error { return p.RemoveToxic(t.Name) }); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if !p.Enabled {
		if err := bounded(p.Enable); err != nil {
			errs = append(errs, err.Error())
		}
	}
	st, err := c.State()
	if err != nil {
		return fail(st, err)
	}
	if !Clean(st) {
		return fail(st, fmt.Errorf("남은 toxic %d개, 프록시 켜짐 %v %s", len(st.Toxics), st.Enabled, strings.Join(errs, ", ")))
	}
	return st, model.Cleanup{Verified: true, CheckedUs: st.CheckedUs, Detail: "남은 toxic 0개, 프록시 켜짐을 확인함"}
}
