package lab

import (
	"fmt"

	"breaklab/internal/model"
)

const (
	generatorID = "generator"
	hubID       = "service-a"
)

// Service는 실험 대상 서비스 하나의 설정이다. Base는 실험 구간을 거치지 않는 관리 경로 주소다.
type Service struct {
	ID, Base string
}

type nodeDef struct {
	model.Node
	stateful bool // 실험을 시작할 때 기억을 비운다
	drain    bool // 실험이 끝날 때도 비운다
	gauges   bool // 스스로 센 값을 읽어 온다
}

// nodes는 실험을 허용한 서비스 목록이다.
var nodes = []nodeDef{
	{Node: model.Node{ID: generatorID, Name: "클라이언트", Role: "손님 대신 실제 HTTP 요청을 보냄. 관리 서버 안에서 실행됨"}},
	{Node: model.Node{ID: hubID, Name: "Service A", Role: "손님의 요청을 받아 다른 서비스를 차례로 부름"}, stateful: true, gauges: true},
	{Node: model.Node{ID: "service-b", Name: "Service B", Role: "재고 조회", Faults: true}},
	{Node: model.Node{ID: "auth", Name: "인증", Role: "모든 주문이 먼저 거치는 손님 확인", Faults: true}},
	{Node: model.Node{ID: "pay", Name: "결제", Role: "느린 외부 결제사", Faults: true}, stateful: true, gauges: true},
	{Node: model.Node{ID: "cache", Name: "캐시", Role: "자주 찾는 상품을 메모리에 보관", Faults: true}, stateful: true, gauges: true},
	{Node: model.Node{ID: "db", Name: "상품 DB", Role: "한 번에 하나씩, 하나에 250ms가 걸리는 작은 DB", Faults: true, Slots: 1}},
	{Node: model.Node{ID: "queue", Name: "큐", Role: "알림 작업을 쌓아 두고 작업자에게 하나씩 넘김", Faults: true}, stateful: true, drain: true, gauges: true},
	{Node: model.Node{ID: "worker", Name: "작업자", Role: "큐가 넘긴 알림 작업을 처리", Faults: true}, stateful: true, gauges: true},
}

// edges는 실험을 허용한 연결 목록이다. gen-a를 뺀 모든 연결은 프록시를 거친다.
var edges = []model.Edge{
	{ID: "gen-a", From: generatorID, To: hubID, Protocol: "HTTP/1.1"},
	{ID: "a-b", From: hubID, To: "service-b", Protocol: "HTTP/1.1"},
	{ID: "a-auth", From: hubID, To: "auth", Protocol: "HTTP/1.1"},
	{ID: "a-pay", From: hubID, To: "pay", Protocol: "HTTP/1.1"},
	{ID: "a-cache", From: hubID, To: "cache", Protocol: "HTTP/1.1"},
	{ID: "a-db", From: hubID, To: "db", Protocol: "HTTP/1.1"},
	{ID: "a-queue", From: hubID, To: "queue", Protocol: "HTTP/1.1"},
	{ID: "queue-worker", From: "queue", To: "worker", Protocol: "HTTP/1.1"},
}

type scenarioDef struct {
	model.Scenario
	path func(seq int) string // 클라이언트가 A에 보내는 경로
	flow string               // A가 차례로 부를 단계
}

func order(int) string { return "/order" }

// 주제마다 그 주제에 필요한 서비스와 연결만 쓴다. Col과 Row는 화면에 놓을 자리다(가운데 줄이 Row 1).
var scenarios = []scenarioDef{
	{Scenario: model.Scenario{ID: "stock", Name: "주문과 재고", About: "A가 B에 재고를 묻습니다. 가장 단순한 구조입니다.",
		Nodes: []model.Place{{ID: generatorID, Col: 0, Row: 1}, {ID: hubID, Col: 1, Row: 1}, {ID: "service-b", Col: 2, Row: 1}},
		Edges: []string{"gen-a", "a-b"}}, path: order, flow: "stock"},
	{Scenario: model.Scenario{ID: "auth", Name: "인증", About: "주문마다 먼저 인증을 거친 뒤 재고를 묻습니다.",
		Nodes: []model.Place{{ID: generatorID, Col: 0, Row: 1}, {ID: hubID, Col: 1, Row: 1}, {ID: "service-b", Col: 2, Row: 1}, {ID: "auth", Col: 1, Row: 0}},
		Edges: []string{"gen-a", "a-auth", "a-b"}}, path: order, flow: "auth,stock"},
	{Scenario: model.Scenario{ID: "pay", Name: "외부 결제", About: "재고를 확인한 뒤 외부 결제사에 결제를 요청합니다.",
		Nodes: []model.Place{{ID: generatorID, Col: 0, Row: 1}, {ID: hubID, Col: 1, Row: 1}, {ID: "service-b", Col: 2, Row: 1}, {ID: "pay", Col: 1, Row: 0}},
		Edges: []string{"gen-a", "a-b", "a-pay"}}, path: order, flow: "stock,pay"},
	{Scenario: model.Scenario{ID: "cache", Name: "캐시와 DB", About: "상품을 캐시에서 먼저 찾고, 없으면 DB에서 읽어 캐시에 넣어 둡니다.",
		Nodes: []model.Place{{ID: generatorID, Col: 0, Row: 1}, {ID: hubID, Col: 1, Row: 1}, {ID: "db", Col: 2, Row: 1}, {ID: "cache", Col: 1, Row: 0}},
		Edges: []string{"gen-a", "a-cache", "a-db"}}, path: func(seq int) string { return fmt.Sprintf("/product?id=%d", seq%5) }},
	{Scenario: model.Scenario{ID: "queue", Name: "큐와 작업자", About: "재고를 확인한 뒤 알림 작업을 큐에 넣고 바로 답합니다. 알림은 작업자가 나중에 보냅니다.",
		Nodes: []model.Place{{ID: generatorID, Col: 0, Row: 1}, {ID: hubID, Col: 1, Row: 1}, {ID: "service-b", Col: 2, Row: 1}, {ID: "queue", Col: 1, Row: 0}, {ID: "worker", Col: 2, Row: 0}},
		Edges: []string{"gen-a", "a-b", "a-queue", "queue-worker"}}, path: order, flow: "stock,notify"},
	// 서비스가 많아 네 칸 세 줄에 놓는다. A는 가운데 줄의 두 칸을 차지한다.
	{Scenario: model.Scenario{ID: "shop", Name: "전체 쇼핑몰", About: "주문 한 건이 인증, 재고, 결제를 차례로 거치고, 알림은 큐를 통해 나중에 나갑니다.",
		Nodes: []model.Place{{ID: generatorID, Col: 0, Row: 1}, {ID: hubID, Col: 1, Row: 1, Span: 2}, {ID: "auth", Col: 1, Row: 0}, {ID: "pay", Col: 2, Row: 0},
			{ID: "service-b", Col: 3, Row: 1}, {ID: "queue", Col: 1, Row: 2}, {ID: "worker", Col: 2, Row: 2}},
		Edges: []string{"gen-a", "a-auth", "a-b", "a-pay", "a-queue", "queue-worker"}}, path: order, flow: "auth,stock,pay,notify"},
}

func scenario(id string) *scenarioDef {
	for i := range scenarios {
		if scenarios[i].ID == id {
			return &scenarios[i]
		}
	}
	return nil
}

func nodeName(id string) string {
	for _, n := range nodes {
		if n.ID == id {
			return n.Name
		}
	}
	return id
}

func edgeDef(id string) *model.Edge {
	for i := range edges {
		if edges[i].ID == id {
			return &edges[i]
		}
	}
	return nil
}

func (s *scenarioDef) has(list []string, id string) bool {
	for _, x := range list {
		if x == id {
			return true
		}
	}
	return false
}

func (s *scenarioDef) hasNode(id string) bool {
	for _, p := range s.Nodes {
		if p.ID == id {
			return true
		}
	}
	return false
}
