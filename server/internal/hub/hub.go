// Package hub는 SSE 구독자에게 상태 변경을 전달한다.
package hub

import (
	"encoding/json"
	"sync"
)

type Msg struct {
	Type string
	Data []byte
}

type Hub struct {
	mu   sync.Mutex
	subs map[chan Msg]struct{}
}

func New() *Hub { return &Hub{subs: map[chan Msg]struct{}{}} }

func (h *Hub) Subscribe() (chan Msg, func()) {
	ch := make(chan Msg, 512)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() { h.drop(ch) }
}

func (h *Hub) drop(ch chan Msg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
}

// Publish는 느린 구독자를 끊는다. 끊긴 브라우저는 다시 연결하면서 전체 상태를 새로 받는다.
func (h *Hub) Publish(typ string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- Msg{typ, b}:
		default:
			delete(h.subs, ch)
			close(ch)
		}
	}
}
