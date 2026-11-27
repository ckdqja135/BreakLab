// 학습 과정. 단계의 완료 여부와 관찰 문장은 모두 실제 실험 상태와 관측값으로 판단한다.
import { attempts, charges, degraded, handled, notified, queued, waited } from './explain'
import { human } from './format'
import { EDGE_FROM, EDGE_TO, meta } from './meta'
import type { FaultInput, LabState, Selection, Settings, Trace } from './types'

export interface Ctx {
  live: LabState
  traces: Trace[]
  selection: Selection
  focusId: string | null
  tab: string
  topic: string    // 이 과정의 주제
  lessonUs: number // 이 과정을 시작한 시각
  sinceUs: number  // 이 단계가 시작된 시각
}
type Text = string | ((c: Ctx) => string)
export interface Burst { count: number; intervalMs: number; concurrency: number }
export interface Step {
  do: Text
  why?: string
  hint?: Text            // 강조할 화면 요소
  fault?: FaultInput     // 장애 설정 칸에 채워 줄 값
  under?: FaultInput     // 이 장애가 걸려 있어야 하는 단계. 풀렸으면 적용 단계로 돌아간다
  burst?: Burst          // 반복 요청 칸에 채워 줄 값
  manual?: boolean       // 읽고 직접 넘기는 단계
  settings?: Partial<Settings> // 이 단계부터 바뀌는 실험 조건. 실험을 새로 시작한다
  done: (c: Ctx) => boolean
  saw?: (c: Ctx) => string
}
export interface Lesson { id: string; topic: string; group?: string; title: string; goal: string; settings?: Partial<Settings>; steps: Step[]; learned: string[] }

const TTL = 240
const running = (c: Ctx) => c.live.run?.status === 'running'
const mine = (c: Ctx) => running(c) && c.live.run!.startedUs >= c.lessonUs && (c.live.run!.scenario || 'stock') === c.topic
// 이 단계에서 보내 끝난 요청. A가 남긴 기록까지 도착한 것만 센다.
const settled = (t: Trace) => t.endUs > 0 && !t.spans.some((s) => s.service === 'service-a' && s.endUs === 0)
const fresh = (c: Ctx) => c.traces.filter((t) => t.startUs >= c.sinceUs && settled(t) && t.result !== 'canceled')
const same = (a: FaultInput, b: FaultInput) => a.type === b.type && a.edge === b.edge && a.node === b.node
export const active = (c: Ctx, f: FaultInput) => c.live.faults.some((x) => x.state === 'active' && same(x, f))
const picked = (c: Ctx, f: FaultInput) => (f.node ? c.selection?.type === 'node' && c.selection.id === f.node : c.selection?.type === 'edge' && c.selection.id === f.edge)
const where = (f: FaultInput) => (f.node
  ? `그림에서 '${meta(f.node).name}' 상자를 누르세요.`
  : `그림에서 ${meta(EDGE_FROM[f.edge!]).short}와 ${meta(EDGE_TO[f.edge!]).short} 사이의 '프록시'를 누르세요.`)
const spot = (f: FaultInput) => f.node ?? f.edge!
const bad = (t: Trace) => t.result !== 'ok'
const tried = (t: Trace, result: string, edge = 'a-b') => attempts(t, edge).some((a) => a.call.result === result)
const longest = (ts: Trace[]) => human(Math.max(...ts.map((t) => waited(t, 0))))
const avg = (ts: Trace[]) => human(ts.reduce((n, t) => n + waited(t, 0), 0) / Math.max(1, ts.length))

const begin: Step = {
  do: (c) => (running(c) && !mine(c) ? "이전 실험이 아직 실행 중입니다. 위쪽 '실험 종료'를 누르세요." : "위쪽 파란 '실험 시작'을 누르세요."),
  hint: (c) => (running(c) && !mine(c) ? 'end' : 'start'),
  why: '실험을 시작해야 요청과 장애를 보낼 수 있습니다. 주제와 조건은 이 과정에 맞게 맞춰 두었습니다.',
  done: mine,
}

// rerun은 조건을 바꿔 실험을 새로 시작하게 한다. 같은 장애를 조건만 바꿔 다시 겪어 보기 위한 단계다.
const renewed = (c: Ctx) => running(c) && c.live.run!.startedUs >= c.sinceUs && (c.live.run!.scenario || 'stock') === c.topic
const rerun = (settings: Partial<Settings>, what: string, why: string): Step => ({
  do: (c) => (running(c) && !renewed(c) ? "위쪽 '실험 종료'를 누르세요. 조건을 바꿔 다시 시작합니다." : `위쪽 파란 '실험 시작'을 누르세요. ${what}`),
  hint: (c) => (running(c) && !renewed(c) ? 'end' : 'start'),
  why, settings,
  done: renewed,
})

// 같은 대상에 이 과정과 다른 장애가 걸려 있으면 먼저 지우게 한다.
const other = (c: Ctx, f: FaultInput) => c.live.faults.some((x) => x.edge === f.edge && x.node === f.node && x.type !== f.type && !['removed', 'apply_failed'].includes(x.state))
const apply = (f: FaultInput, values: string, why: string): Step => ({
  do: (c) => (!picked(c, f) ? where(f) : other(c, f) ? "이 과정과 다른 장애가 걸려 있습니다. 오른쪽 '장애 제거'를 누르세요." : `오른쪽에 ${values} 값을 채워 두었습니다. 보라색 '장애 적용'을 누르세요.`),
  hint: (c) => (!picked(c, f) ? spot(f) : other(c, f) ? 'remove' : 'apply'),
  why, fault: f,
  done: (c) => active(c, f),
})

const remove = (f: FaultInput, why: string): Step => ({
  do: (c) => (picked(c, f) ? "오른쪽 '장애 제거'를 누르세요." : where(f)),
  hint: (c) => (picked(c, f) ? 'remove' : spot(f)),
  why,
  done: (c) => !c.live.faults.some((x) => same(x, f) && !['removed', 'apply_failed'].includes(x.state)),
})

const send = (ok: (t: Trace) => boolean, why: string, saw: (t: Trace, c: Ctx) => string, under?: FaultInput): Step => ({
  do: "위쪽 '요청 1회'를 누르세요.", hint: 'send', why, under,
  done: (c) => fresh(c).some(ok),
  saw: (c) => saw(fresh(c).filter(ok).pop()!, c),
})

const many = (b: Burst, why: string, saw: (ts: Trace[], c: Ctx) => string, under?: FaultInput): Step => ({
  do: `위쪽 반복 요청 칸을 채워 두었습니다(횟수 ${b.count}, 간격 ${b.intervalMs}ms, 동시 ${b.concurrency}). '반복 요청'을 누르세요.`,
  hint: 'repeat', why, under, burst: b,
  done: (c) => !c.live.repeat.active && fresh(c).filter((t) => t.kind === 'repeat').length >= b.count,
  saw: (c) => saw(fresh(c).filter((t) => t.kind === 'repeat'), c),
})

const read = (text: string, why: string, hint?: string): Step => ({ do: text, why, hint, manual: true, done: () => false })

const took = (t: Trace) => human(waited(t, 0))
const slow: FaultInput = { edge: 'a-b', type: 'latency', direction: 'response', latencyMs: 300, ttlSec: TTL }
const tooSlow: FaultInput = { edge: 'a-b', type: 'latency', direction: 'response', latencyMs: 1500, ttlSec: TTL }
const cut: FaultInput = { edge: 'a-b', type: 'cut', ttlSec: TTL }
const silent: FaultInput = { edge: 'a-b', type: 'blackhole', ttlSec: TTL }
const flaky: FaultInput = { node: 'service-b', type: 'error', percent: 50, ttlSec: TTL }
const jammed: FaultInput = { node: 'service-b', type: 'overload', slots: 1, workMs: 600, ttlSec: TTL }
const crowd: Burst = { count: 10, intervalMs: 200, concurrency: 5 }

export const LESSONS: Lesson[] = [
  {
    id: 'path', topic: 'stock', title: '요청 하나 따라가기', goal: '요청이 어디를 거쳐 갔다 오는지 봅니다.',
    steps: [
      begin,
      send((t) => t.result === 'ok', '진짜 HTTP 요청 하나가 클라이언트에서 A로, A에서 B로 갑니다. 그림 위의 점을 따라가 보세요.',
        (t) => `${t.seq}번 요청은 ${took(t)} 걸렸습니다. A는 B의 답을 받은 뒤에야 답을 돌려줬습니다.`),
      read("아래 '손님 화면'에서 방금 손님과 오른쪽 풀이를 읽어 보세요.", '요청 하나를 주문하는 손님 한 명으로 보여 줍니다. 숫자는 모두 실제로 잰 값입니다.', 'tab-impact'),
      {
        do: "아래 '요청 흐름' 탭을 누르고, 표에서 방금 요청 줄을 누르세요.", hint: 'tab-calls',
        why: '요청 하나가 서비스마다 얼마나 머물렀는지 막대로 볼 수 있습니다.',
        done: (c) => c.tab === 'calls' && !!c.focusId,
        saw: () => '막대 하나가 호출 하나입니다. A의 막대 안에 B를 부른 막대가 들어 있습니다. A는 B를 기다리는 동안 그 요청을 끝낼 수 없습니다.',
      },
    ],
    learned: ['점 하나, 막대 하나는 실제 호출 하나입니다.', 'A는 B의 답을 받아야 답할 수 있습니다. 그래서 B가 느려지면 A도 느려집니다.'],
  },
  {
    id: 'slow', topic: 'stock', title: '연결이 느려지면', goal: '연결 지연이 손님의 대기 시간으로 이어지는 것을 봅니다.',
    steps: [
      begin,
      send((t) => t.result === 'ok', '먼저 장애가 없을 때의 속도를 재 둡니다.', (t) => `장애가 없을 때는 ${took(t)}입니다. 이 값을 기억해 두세요.`),
      apply(slow, '지연 300ms, 응답 방향', 'B의 답이 A로 돌아오는 길을 300ms 늦춥니다. 네트워크가 느려진 상황입니다.'),
      send((t) => t.result === 'ok' && waited(t, 0) >= 250e3, '같은 요청을 다시 보내 얼마나 달라지는지 봅니다.',
        (t) => `이번에는 ${took(t)}입니다. 지연 300ms가 그대로 손님의 대기 시간에 더해졌습니다. 실패는 아니지만 손님은 느려졌다고 느낍니다.`, slow),
      remove(slow, '장애를 없애면 바로 돌아오는지 봅니다.'),
      send((t) => t.result === 'ok', '복구를 확인합니다.', (t) => `${took(t)}로 돌아왔습니다. 연결 지연은 없애는 즉시 회복됩니다.`),
    ],
    learned: ['의존하는 서비스와의 연결이 느려지면 그만큼 손님이 더 기다립니다.', '느려졌을 뿐 실패는 아니어서, 실패 수만 보면 이 문제를 놓칩니다. 응답 시간도 함께 봐야 합니다.'],
  },
  {
    id: 'timeout', topic: 'stock', title: '타임아웃: 기다림의 한도', goal: '너무 느린 답을 기다리다 포기하는 과정을 봅니다.', settings: { maxAttempts: 1 },
    steps: [
      begin,
      apply(tooSlow, '지연 1500ms, 응답 방향', 'A는 B를 1000ms까지만 기다립니다. 그보다 긴 1500ms 지연을 겁니다.'),
      send((t) => bad(t) && tried(t, 'timeout'), 'A가 언제 포기하는지 봅니다.',
        (t) => `A는 ${human(attempts(t)[0].call.endUs - attempts(t)[0].call.startUs)}만 기다리고 포기했고, 손님은 ${took(t)} 만에 오류 화면을 봤습니다.${handled(t) ? ' 그런데 B는 이 요청을 끝까지 처리했습니다.' : ''}`, tooSlow),
      read("아래 '손님 화면'의 풀이에서 'B는 이 요청을 끝까지 처리했습니다'를 찾아보세요.", '타임아웃은 A가 기다리기를 그만둔 것일 뿐입니다. B가 한 일까지 없던 것이 되지는 않습니다.', 'tab-impact'),
      remove(tooSlow, '다음 과정을 위해 장애를 없앱니다.'),
    ],
    learned: ['타임아웃은 손님이 기다리는 시간의 상한선입니다. 없으면 느린 서비스에 끝없이 붙잡힙니다.', 'A가 포기해도 B는 일을 끝낼 수 있습니다. 실패로 보이지만 실제로는 처리된 요청이 생깁니다.'],
  },
  {
    id: 'retry', topic: 'stock', title: '재시도: 약이 될 때, 독이 될 때', goal: '같은 재시도가 상황에 따라 정반대 결과를 내는 것을 봅니다.', settings: { maxAttempts: 2, backoffMs: 200 },
    steps: [
      begin,
      apply(flaky, '오류 비율 50%', 'B가 절반의 확률로 오류를 냅니다. 잠깐 스치는 일시적 오류와 비슷합니다.'),
      many({ count: 20, intervalMs: 200, concurrency: 2 }, 'A는 실패하면 한 번 더 시도합니다. 손님 20명 중 몇 명이 살아남는지 봅니다.', (ts) => {
        const hit = ts.filter((t) => attempts(t).length > 1 || bad(t)).length
        const lost = ts.filter(bad).length
        if (!hit) return `이번에는 우연히 손님 ${ts.length}명 모두 첫 시도에 성공했습니다. 오류는 확률로 일어나므로 이런 때도 있습니다.`
        return `손님 ${ts.length}명 중 ${hit}명이 첫 시도에서 오류를 만났습니다. 그중 ${hit - lost}명은 재시도로 성공했고 ${lost}명은 끝내 실패했습니다. 재시도가 없었다면 ${hit}명 모두 실패였습니다.`
      }, flaky),
      remove(flaky, '이번에는 다른 종류의 장애로 바꿉니다.'),
      apply(tooSlow, '지연 1500ms, 응답 방향', '이번에는 B가 계속 느린 상황입니다. A의 한도 1000ms를 넘습니다.'),
      send((t) => bad(t) && attempts(t).length > 1, '같은 재시도가 이번에는 어떻게 되는지 봅니다.',
        (t) => `A는 ${attempts(t).length}번 모두 한도를 꽉 채워 기다렸습니다. 손님은 ${took(t)}를 기다리고도 실패했고, B는 같은 요청을 ${handled(t)}번 처리했습니다.`, tooSlow),
      remove(tooSlow, '다음 과정을 위해 장애를 없앱니다.'),
    ],
    learned: [
      '잠깐 스치는 오류에는 재시도가 약입니다. 손님은 실패를 모르고 지나갑니다.',
      '계속되는 장애에는 재시도가 독입니다. 손님은 더 오래 기다리고, 힘든 B는 일을 두 배로 받습니다.',
      '같은 요청이 두 번 처리될 수 있습니다. 결제 같은 일은 재시도해도 한 번만 처리되게 만들어야 합니다.',
    ],
  },
  {
    id: 'silence', topic: 'stock', title: '끊김의 두 얼굴', goal: '바로 실패하는 장애와 조용히 매달리는 장애를 비교합니다.', settings: { maxAttempts: 1 },
    steps: [
      begin,
      apply(cut, '연결 차단', 'B로 가는 길을 닫습니다. B 서버가 꺼진 상황과 비슷합니다.'),
      send((t) => bad(t) && tried(t, 'refused'), '얼마나 빨리 실패하는지 봅니다.', (t) => `실패까지 ${took(t)} 걸렸습니다. 연결이 바로 거부되어 A가 즉시 알아챘습니다.`, cut),
      remove(cut, '같은 끊김이지만 모양이 다른 장애로 바꿉니다.'),
      apply(silent, '응답 없음', '이번에는 연결은 받아 주되 아무 답도 하지 않습니다. 방화벽이 조용히 버리거나 서버가 멈춰 버린 상황과 비슷합니다.'),
      send((t) => bad(t) && tried(t, 'timeout'), '이번에는 얼마나 걸리는지 봅니다.', (t, c) => {
        const quick = c.traces.filter((x) => tried(x, 'refused')).pop()
        const times = quick ? Math.round(waited(t, 0) / Math.max(1, waited(quick, 0))) : 0
        return `이번에는 ${took(t)}를 기다린 뒤에야 실패했습니다.${times > 1 ? ` 같은 실패인데 손님이 기다린 시간은 약 ${times.toLocaleString()}배입니다.` : ''} A가 정한 한도까지 꼬박 붙잡혀 있었습니다.`
      }, silent),
      remove(silent, '다음 과정을 위해 장애를 없앱니다.'),
    ],
    learned: ['바로 거부되는 장애는 빨리 실패해서 오히려 다루기 쉽습니다.', '답이 없는 장애는 타임아웃까지 손님과 A를 붙잡아 둡니다. 타임아웃이 길수록 피해가 커집니다.'],
  },
  {
    id: 'jam', topic: 'stock', title: '느린 서비스 하나가 줄을 세운다', goal: '죽지 않은 서비스가 어떻게 장애를 만드는지 봅니다.', settings: { maxAttempts: 2, backoffMs: 200 },
    steps: [
      begin,
      many(crowd, '먼저 장애 없이 손님 10명을 한꺼번에 보냅니다.', (ts) => `손님 ${ts.length}명 중 ${ts.filter((t) => t.result === 'ok').length}명이 성공했고, 가장 오래 기다린 손님도 ${human(Math.max(...ts.map((t) => waited(t, 0))))}였습니다.`),
      apply(jammed, '동시 처리 1개, 건당 600ms', 'B가 한 번에 하나만, 하나에 600ms씩 처리하게 합니다. 느려진 DB를 떠올리면 됩니다. 손님이 한 명뿐이라면 0.6초면 끝납니다.'),
      many(crowd, '같은 손님 10명을 다시 보냅니다. 그림의 Service B 위에 줄이 생기는지 보세요.', (ts) => {
        const tries = ts.reduce((n, t) => n + attempts(t).length, 0)
        return `같은 손님 ${ts.length}명인데 ${ts.filter(bad).length}명이 실패했고, 가장 오래 기다린 손님은 ${human(Math.max(...ts.map((t) => waited(t, 0))))}입니다. B는 하나에 0.6초면 되지만, 줄에서 기다리다 A의 한도를 넘겼습니다. A는 B를 ${tries}번 불렀습니다(재시도 ${tries - ts.length}번).`
      }, jammed),
      read("아래 '손님 화면'의 사고 그래프에서 보라색 구간과 그 앞을 비교해 보세요.", '같은 손님, 같은 서비스인데 B의 처리 속도 하나로 결과가 갈렸습니다.', 'tab-impact'),
      remove(jammed, '장애를 없애고 회복되는지 봅니다.'),
      send((t) => t.result === 'ok', '복구를 확인합니다.', (t) => `${took(t)}로 돌아왔습니다.`),
    ],
    learned: [
      '서비스는 죽지 않아도 장애가 됩니다. 처리 속도보다 요청이 빨리 오면 줄이 생기고, 줄에서 기다린 시간이 타임아웃을 넘깁니다.',
      '이때 재시도는 줄을 더 길게 만듭니다. 과부하에는 재시도를 줄이거나 요청을 빨리 거절하는 편이 낫습니다.',
    ],
  },
]

const cutAuth: FaultInput = { edge: 'a-auth', type: 'cut', ttlSec: TTL }
const slowPay: FaultInput = { edge: 'a-pay', type: 'latency', direction: 'response', latencyMs: 1500, ttlSec: TTL }
const cutCache: FaultInput = { edge: 'a-cache', type: 'cut', ttlSec: TTL }
const mutedCache: FaultInput = { edge: 'a-cache', type: 'blackhole', ttlSec: TTL }
const cutWorker: FaultInput = { edge: 'queue-worker', type: 'cut', ttlSec: TTL }
const warm: Burst = { count: 10, intervalMs: 300, concurrency: 1 }
const rush: Burst = { count: 15, intervalMs: 100, concurrency: 5 }
const cacheState = (t: Trace) => t.spans.find((s) => s.service === 'service-a' && s.kind === 'server')?.attrs?.['lab.cache']
const payTries = (t: Trace) => attempts(t, 'a-pay').length
const unsent = (ts: Trace[]) => ts.filter((t) => queued(t) && !notified(t)).length
// 작업자가 알림을 다 보낸 시각. 주문한 때부터 잰다.
const sentAt = (t: Trace) => Math.max(0, ...t.spans.filter((s) => s.service === 'worker' && s.kind === 'server' && s.result === 'ok').map((s) => s.endUs - t.startUs))

LESSONS.push(
  {
    id: 'gate', topic: 'auth', title: '모두가 거치는 문', goal: '공통 서비스 하나가 죽으면 전체가 멈추는 것을 봅니다.', settings: { maxAttempts: 1 },
    steps: [
      begin,
      send((t) => t.result === 'ok', '이 주제에서는 A가 먼저 인증에 손님 확인을 맡기고, 그다음 B에 재고를 묻습니다.',
        (t) => `${t.seq}번 주문은 ${took(t)} 걸렸습니다. A가 인증과 B를 차례로 불렀습니다.`),
      apply(cutAuth, '연결 차단', '인증으로 가는 길을 끊습니다. 인증 서버가 죽은 상황입니다. B는 건드리지 않습니다.'),
      many(crowd, '손님 10명을 보냅니다. B는 멀쩡하다는 점을 기억하세요.',
        (ts) => `손님 ${ts.length}명 중 ${ts.filter(bad).length}명이 실패했습니다. B는 멀쩡하지만 A는 B를 ${ts.reduce((n, t) => n + attempts(t, 'a-b').length, 0)}번 불렀습니다. 인증에서 막혀 B까지 가지도 못했습니다.`, cutAuth),
      read('그림에서 A와 B 사이에는 요청이 지나가지 않은 것을 확인하세요.', '모든 요청이 거치는 서비스는 하나만 죽어도 전체가 멈춥니다. 이런 곳을 단일 장애점이라고 부릅니다.'),
      remove(cutAuth, '인증을 되살립니다.'),
      send((t) => t.result === 'ok', '복구를 확인합니다.', (t) => `${took(t)} 만에 다시 주문이 됩니다.`),
    ],
    learned: ['모든 요청이 거치는 서비스가 죽으면, 멀쩡한 다른 서비스까지 쓸모없어집니다.', '그래서 인증 같은 공통 서비스는 여러 대로 늘리거나, 잠깐 죽어도 버틸 방법을 마련합니다.'],
  },
  {
    id: 'remember', topic: 'auth', title: '기억해 두면 버틴다', goal: '인증 결과를 잠깐 기억해 두어 인증 장애를 넘기는 것을 봅니다.', settings: { maxAttempts: 1, authCacheSec: 60 },
    steps: [
      begin,
      send((t) => t.result === 'ok', '이번에는 A가 인증 결과를 60초 동안 기억합니다. 첫 주문에서 인증을 한 번 부릅니다.',
        (t) => `첫 주문에서 인증을 불렀고 ${took(t)} 걸렸습니다. A는 이 결과를 60초 동안 기억합니다.`),
      apply(cutAuth, '연결 차단', '앞 과정과 똑같이 인증을 죽입니다.'),
      many(crowd, '같은 손님 10명을 보냅니다. 앞 과정에서는 모두 실패했습니다.',
        (ts) => `인증이 죽어 있는데도 손님 ${ts.length}명 중 ${ts.filter((t) => t.result === 'ok').length}명이 주문에 성공했습니다. A가 기억해 둔 결과를 다시 써서 인증을 ${ts.reduce((n, t) => n + attempts(t, 'a-auth').length, 0)}번 불렀습니다.`, cutAuth),
      read("아래 '손님 화면'의 풀이에서 'A는 조금 전에 확인해 둔 인증 결과를 다시 썼습니다'를 찾아보세요.", '기억하는 시간이 끝나면 다시 인증을 불러야 하고, 그때도 죽어 있으면 실패합니다. 또 그동안은 권한이 바뀌어도 알 수 없습니다.', 'tab-impact'),
      remove(cutAuth, '인증을 되살립니다.'),
    ],
    learned: ['자주 바뀌지 않는 결과를 잠깐 기억해 두면, 그 서비스가 잠시 죽어도 버틸 수 있습니다.', '공짜는 아닙니다. 기억하는 동안은 바뀐 내용을 모릅니다. 얼마나 오래 기억할지가 설계의 핵심입니다.'],
  },
  {
    id: 'slowpay', topic: 'pay', title: '느린 결제가 주문을 막는다', goal: '느린 외부 서비스가 내 서비스를 어떻게 끌어내리는지 봅니다.', settings: { maxAttempts: 1 },
    steps: [
      begin,
      send((t) => t.result === 'ok', 'A가 B에 재고를 묻고, 이어서 외부 결제사에 결제를 요청합니다.',
        (t) => `${took(t)} 걸렸습니다. 그중 ${human(attempts(t, 'a-pay')[0].call.endUs - attempts(t, 'a-pay')[0].call.startUs)}가 결제를 기다린 시간입니다. 결제사는 원래 느립니다.`),
      apply(slowPay, '지연 1500ms, 응답 방향', '결제사의 답이 1500ms 늦게 오게 합니다. A의 한도 1000ms보다 깁니다.'),
      send((t) => bad(t) && tried(t, 'timeout', 'a-pay'), '주문이 어떻게 되는지 봅니다.',
        (t) => `손님은 ${took(t)}를 기다리고 주문 실패를 봤습니다. 그런데 결제는 ${charges(t)}번 됐습니다. 돈은 빠져나갔는데 주문은 실패했습니다.`, slowPay),
      read("그림의 결제 상자에 적힌 '실제 결제' 숫자와, 아래 '손님 화면'의 주문 완료 수를 비교해 보세요.", "실패로 보인다고 아무 일도 일어나지 않은 것이 아닙니다. 타임아웃은 '실패'가 아니라 '모른다'는 뜻입니다.", 'tab-impact'),
      remove(slowPay, '다음 과정을 위해 장애를 없앱니다.'),
    ],
    learned: ['외부 서비스가 느려지면 그것을 기다리는 내 서비스도 같이 느려지고 실패합니다.', '타임아웃으로 끝난 요청은 처리됐을 수도, 안 됐을 수도 있습니다. 결제처럼 되돌리기 어려운 일은 결과를 다시 확인하는 절차가 필요합니다.'],
  },
  {
    id: 'twice', topic: 'pay', title: '재시도가 부른 이중 결제', goal: '재시도가 같은 결제를 두 번 일으키는 것을 봅니다.', settings: { maxAttempts: 2, backoffMs: 200 },
    steps: [
      begin,
      apply(slowPay, '지연 1500ms, 응답 방향', '앞 과정과 같은 장애입니다. 다만 이번에는 A가 실패하면 한 번 더 시도합니다.'),
      send((t) => bad(t) && payTries(t) > 1, '재시도가 결제에 어떤 일을 하는지 봅니다.',
        (t) => `A가 결제를 ${payTries(t)}번 요청했고, 결제사는 ${charges(t)}번 모두 결제했습니다. 손님은 한 번 주문하고 ${charges(t)}번 결제당했으며, 주문은 실패했습니다.`, slowPay),
      remove(slowPay, '다음 과정에서 이것을 막는 방법을 봅니다.'),
    ],
    learned: ['재시도는 같은 요청을 한 번 더 보내는 것입니다. 첫 요청이 사실은 처리됐다면 두 번 처리됩니다.', '되돌리기 어려운 일에는 재시도를 함부로 붙이면 안 됩니다.'],
  },
  {
    id: 'once', topic: 'pay', title: '멱등 키로 이중 결제 막기', goal: '여러 번 요청해도 한 번만 처리되게 만드는 방법을 봅니다.', settings: { maxAttempts: 2, backoffMs: 200, idempotent: true },
    steps: [
      begin,
      apply(slowPay, '지연 1500ms, 응답 방향', '앞 과정과 장애도 재시도도 같습니다. 다른 점은 A가 결제 요청에 주문 고유 번호(멱등 키)를 붙인다는 것 하나입니다.'),
      send((t) => bad(t) && payTries(t) > 1, '이번에는 몇 번 결제되는지 봅니다.',
        (t) => `A가 결제를 ${payTries(t)}번 요청했지만 결제는 ${charges(t)}번만 됐습니다. 결제사가 같은 주문임을 알아보고 두 번째 요청은 새로 결제하지 않았습니다.`, slowPay),
      read("아래 '손님 화면'의 풀이에서 '다시 결제하지 않았습니다'를 찾아보세요.", '결제사는 이미 본 번호가 오면 저장해 둔 결과만 돌려줍니다. 주문은 여전히 실패로 보이지만, 손님이 다시 주문해도 돈이 두 번 나가지 않습니다.', 'tab-impact'),
      remove(slowPay, '장애를 없앱니다.'),
    ],
    learned: ['여러 번 보내도 한 번 보낸 것과 결과가 같은 성질을 멱등이라고 합니다.', '재시도는 받는 쪽이 멱등일 때만 안전합니다. 멱등 키는 그 약속을 지키는 흔한 방법입니다.'],
  },
  {
    id: 'shield', topic: 'cache', title: '캐시가 죽으면 DB가 맞는다', goal: '캐시가 DB를 얼마나 지켜 주고 있었는지 봅니다.', settings: { maxAttempts: 1 },
    steps: [
      begin,
      many(warm, '상품 5개를 번갈아 조회합니다. 처음에는 캐시에 없어서 DB까지 가고, 그다음부터는 캐시에서 바로 나옵니다.', (ts) => {
        const miss = ts.filter((t) => cacheState(t) === 'miss'), hit = ts.filter((t) => cacheState(t) === 'hit')
        return `처음 ${miss.length}번은 캐시에 없어 DB에서 읽었고(평균 ${avg(miss)}), 그 뒤 ${hit.length}번은 캐시에서 바로 꺼냈습니다(평균 ${avg(hit)}).`
      }),
      many(rush, '이제 손님 15명을 한꺼번에 보냅니다. 캐시가 있을 때의 모습입니다.', (ts) => `캐시가 있을 때는 손님 ${ts.length}명이 모두 ${longest(ts)} 안에 끝났습니다. DB는 한 번도 부르지 않았습니다.`),
      apply(cutCache, '연결 차단', '캐시로 가는 길을 끊습니다. A는 캐시를 못 쓰면 DB에서 직접 읽습니다.'),
      many(rush, '같은 손님 15명을 다시 보냅니다. 그림의 상품 DB 위를 보세요.', (ts) => {
        const calls = ts.reduce((n, t) => n + attempts(t, 'a-db').length, 0)
        return `캐시가 죽자 손님 ${ts.length}명이 모두 DB로 몰렸습니다(DB 호출 ${calls}번). 가장 오래 기다린 손님은 ${longest(ts)}, 실패한 손님은 ${ts.filter(bad).length}명입니다. DB는 한 번에 하나, 0.25초씩만 처리할 수 있어 줄이 생겼습니다.`
      }, cutCache),
      read("아래 '손님 화면'의 사고 그래프에서 보라색 구간과 그 앞을 비교해 보세요.", '캐시는 속도만 올려 주던 것이 아니라 DB로 가는 요청을 막아 주고 있었습니다. 캐시가 사라지면 DB가 평소의 몇 배를 한꺼번에 받습니다.', 'tab-impact'),
      remove(cutCache, '캐시를 되살립니다.'),
      send((t) => t.result === 'ok', '복구를 확인합니다.', (t) => `${took(t)}로 돌아왔습니다. 캐시에 남아 있던 상품을 바로 꺼냈습니다.`),
    ],
    learned: ['캐시는 DB의 방패입니다. 캐시가 죽으면 DB가 감당하지 못할 요청이 한꺼번에 몰립니다.', '그래서 캐시 장애는 DB 장애로 번지기 쉽습니다. 캐시가 없을 때 DB로 가는 요청 수를 제한하는 장치가 필요합니다.'],
  },
  {
    id: 'mute', topic: 'cache', title: '느린 캐시는 없는 것보다 나쁘다', goal: '답이 없는 캐시가 죽은 캐시보다 해로운 이유를 봅니다.', settings: { maxAttempts: 1 },
    steps: [
      begin,
      many(warm, '먼저 캐시를 채웁니다.', (ts) => `캐시가 채워졌습니다. 캐시에서 꺼낼 때는 평균 ${avg(ts.filter((t) => cacheState(t) === 'hit'))}입니다.`),
      apply(cutCache, '연결 차단', '먼저 캐시가 아예 죽은 경우를 봅니다.'),
      send((t) => t.result === 'ok' && cacheState(t) === 'down', '캐시가 죽었을 때의 속도를 잽니다.', (t) => `캐시가 죽었을 때는 ${took(t)}입니다. 연결이 바로 거부되어 곧장 DB로 갔습니다.`, cutCache),
      remove(cutCache, '이번에는 죽지는 않았지만 답이 없는 캐시로 바꿉니다.'),
      apply(mutedCache, '응답 없음', '캐시가 연결은 받아 주되 답을 하지 않습니다. 과부하로 멈춘 캐시 서버와 비슷합니다.'),
      send((t) => t.result === 'ok' && tried(t, 'timeout', 'a-cache'), '같은 조회를 다시 보냅니다.', (t, c) => {
        const dead = c.traces.filter((x) => tried(x, 'refused', 'a-cache')).pop()
        return `이번에는 ${took(t)}입니다. A가 캐시의 답을 한도까지 기다린 뒤에야 DB로 갔습니다.${dead ? ` 캐시가 아예 죽었을 때(${took(dead)})보다 훨씬 느립니다.` : ''}`
      }, mutedCache),
      remove(mutedCache, '장애를 없앱니다.'),
    ],
    learned: ['답이 없는 캐시는 죽은 캐시보다 해롭습니다. 죽으면 바로 DB로 가지만, 답이 없으면 한도까지 기다립니다.', '캐시를 기다리는 한도는 아주 짧게 잡아야 합니다. 캐시가 느리면 건너뛰는 편이 낫습니다.'],
  },
  {
    id: 'backlog', topic: 'queue', title: '보이지 않는 장애: 큐가 쌓인다', goal: '주문은 멀쩡한데 뒤에서 일이 밀리는 장애를 봅니다.', settings: { maxAttempts: 2, backoffMs: 200 },
    steps: [
      begin,
      send((t) => t.result === 'ok' && notified(t), 'A는 재고를 확인하고 알림 작업을 큐에 넣은 뒤 바로 답합니다. 알림은 작업자가 나중에 보냅니다.',
        (t) => `손님은 ${took(t)} 만에 주문을 마쳤고, 알림은 주문 ${human(sentAt(t))} 뒤에 나갔습니다. 손님은 알림을 기다리지 않았습니다.`),
      apply(cutWorker, '연결 차단', '큐에서 작업자로 가는 길을 끊습니다. 작업자가 죽은 상황입니다.'),
      many({ count: 10, intervalMs: 200, concurrency: 2 }, '손님 10명을 보냅니다. 주문이 되는지, 그림의 큐 상자 숫자가 어떻게 변하는지 보세요.',
        (ts) => `손님 ${ts.length}명 중 ${ts.filter((t) => t.result === 'ok').length}명이 평소처럼 ${longest(ts)} 안에 주문을 마쳤습니다. 하지만 알림 ${unsent(ts)}건이 큐에 쌓여 있습니다. 손님도, 주문 성공 수도 장애를 알려 주지 않습니다.`, cutWorker),
      read("그림의 큐 상자에서 '밀린 작업' 숫자를 보세요. 큐 상자를 누르면 오른쪽에서 '가장 오래 기다린 작업'도 볼 수 있습니다.", '큐가 없었다면 주문이 실패했을 것입니다. 큐 덕분에 주문은 살았지만 장애가 숨어 버렸습니다. 그래서 큐 길이와 가장 오래된 작업의 나이를 따로 지켜봅니다.', 'queue'),
      remove(cutWorker, '작업자를 되살립니다. 밀린 작업이 빠지는 데 얼마나 걸리는지 보세요.'),
      {
        do: "큐 상자의 '밀린 작업'이 0개가 될 때까지 지켜보세요.", hint: 'queue',
        why: '작업자는 알림 하나에 0.3초씩, 차례대로 처리합니다.',
        done: (c) => c.traces.length > 0 && unsent(c.traces) === 0,
        saw: (c) => `밀린 알림이 모두 나갔습니다. 가장 늦은 알림은 주문 ${human(Math.max(...c.traces.map(sentAt)))} 뒤에야 도착했습니다. 작업자가 살아난 뒤에도 밀린 일을 다 처리할 때까지는 정상이 아니었습니다.`,
      },
    ],
    learned: ['큐는 뒤쪽 서비스의 장애로부터 앞쪽을 지켜 줍니다. 작업자가 죽어도 주문은 됩니다.', '대신 장애가 눈에 보이지 않게 됩니다. 큐 길이와 가장 오래된 작업의 나이를 지켜봐야 합니다.', '복구는 작업자가 살아난 순간이 아니라 밀린 일이 다 빠진 순간입니다.'],
  },
)

const cutPay: FaultInput = { edge: 'a-pay', type: 'cut', ttlSec: TTL }
const few: Burst = { count: 8, intervalMs: 300, concurrency: 2 }
const six: Burst = { count: 6, intervalMs: 200, concurrency: 2 }
const quick = (ts: Trace[]) => ts.filter((t) => waited(t, 0) < 100e3)
const calls = (ts: Trace[], edge: string) => ts.reduce((n, t) => n + attempts(t, edge).length, 0)
const held = (ts: Trace[]) => ts.filter((t) => t.result === 'ok' && degraded(t).length > 0).length

LESSONS.push(
  {
    id: 'breaker', topic: 'stock', group: '방어 장치', title: '서킷 브레이커: 빨리 포기하기', goal: '고장 난 서비스를 계속 두드리지 않게 하는 장치를 봅니다.', settings: { maxAttempts: 1 },
    steps: [
      begin,
      apply(silent, '응답 없음', 'B가 답하지 않는 상황을 만듭니다. A는 부를 때마다 1000ms를 기다립니다.'),
      many(few, '먼저 방어 장치 없이 손님 8명을 보냅니다.',
        (ts) => `손님 ${ts.length}명이 모두 ${longest(ts)} 가까이 기다린 뒤 실패했습니다. A는 답 없는 B를 ${calls(ts, 'a-b')}번 불러 매번 끝까지 기다렸습니다.`, silent),
      rerun({ breakerSec: 5 }, '이번에는 서킷 브레이커를 켠 조건입니다.', '서킷 브레이커는 한 서비스가 연달아 3번 실패하면 5초 동안 그 서비스를 부르지 않습니다. 두꺼비집이 내려가는 것과 같습니다.'),
      apply(silent, '응답 없음', '아까와 같은 장애를 겁니다.'),
      many(few, '같은 손님 8명을 보냅니다.', (ts) => {
        const fast = quick(ts)
        return `처음 ${ts.length - fast.length}명은 여전히 1초쯤 기다렸지만, 그 뒤 ${fast.length}명은 ${fast.length ? longest(fast) : '-'} 안에 결과를 받았습니다. A가 B를 ${calls(ts, 'a-b')}번만 불렀기 때문입니다.`
      }, silent),
      read("그림의 Service A 상자에 '서킷 열림'이 보이는지 확인하세요.", '손님은 여전히 실패를 보지만 기다리지 않습니다. 그리고 B는 그동안 요청을 받지 않아 회복할 틈을 얻습니다.', 'service-a'),
      remove(silent, 'B를 되살립니다. 서킷은 바로 닫히지 않습니다.'),
      {
        do: "5초쯤 기다린 뒤 '요청 1회'를 누르세요. 실패하면 조금 뒤에 다시 누르세요.", hint: 'send',
        why: '쉬는 시간이 지나면 A는 시험 삼아 딱 한 번 불러 봅니다. 성공하면 다시 평소대로 부릅니다.',
        done: (c) => fresh(c).some((t) => t.result === 'ok'),
        saw: (c) => `쉬는 시간이 지나자 A가 B를 한 번 불러 봤고 ${took(fresh(c).filter((t) => t.result === 'ok').pop()!)} 만에 성공했습니다. 서킷이 닫혀 다시 정상입니다.`,
      },
    ],
    learned: [
      '서킷 브레이커는 고장 난 서비스를 계속 두드리지 않게 합니다. 손님은 빨리 결과를 알고, 고장 난 쪽은 쉴 수 있습니다.',
      '실패 자체를 없애지는 못합니다. 대체 응답과 함께 쓰면 실패를 임시 접수로 바꿀 수 있습니다.',
      '너무 민감하면 멀쩡한 서비스도 끊고, 너무 둔하면 소용이 없습니다. 몇 번 실패에 열고 얼마나 쉴지가 조절할 곳입니다.',
    ],
  },
  {
    id: 'soften', topic: 'pay', group: '방어 장치', title: '대체 응답: 실패 대신 임시 접수', goal: '일부 기능을 포기하고 응답을 지키는 방법을 봅니다.', settings: { maxAttempts: 1 },
    steps: [
      begin,
      apply(cutPay, '연결 차단', '결제사로 가는 길을 끊습니다. 재고(B)는 멀쩡합니다.'),
      many(six, '먼저 방어 장치 없이 손님 6명을 보냅니다.',
        (ts) => `재고는 있는데도 손님 ${ts.length}명 중 ${ts.filter(bad).length}명이 주문에 실패했습니다. 결제가 안 되면 주문 전체를 실패로 돌리기 때문입니다.`, cutPay),
      rerun({ fallback: true }, '이번에는 대체 응답을 켠 조건입니다.', '대체 응답은 어떤 단계가 실패하면 그 단계만 건너뛰고 주문을 임시로 접수합니다. 건너뛴 결제는 나중에 다시 요청해야 합니다.'),
      apply(cutPay, '연결 차단', '아까와 같은 장애를 겁니다.'),
      many(six, '같은 손님 6명을 보냅니다.',
        (ts) => `이번에는 손님 ${ts.length}명 중 ${held(ts)}명이 임시 접수로 응답을 받았고, 실패는 ${ts.filter(bad).length}명입니다. 손님은 오류 화면 대신 '주문 접수, 확인 중'을 봤습니다.`, cutPay),
      read("아래 '손님 화면'에서 주황색 '임시' 손님을 눌러 풀이를 읽어 보세요.", '공짜는 아닙니다. 건너뛴 결제는 나중에 반드시 다시 처리해야 하고 그동안 재고가 묶입니다. 인증처럼 건너뛰면 안 되는 단계도 있습니다.', 'tab-impact'),
      remove(cutPay, '장애를 없앱니다.'),
    ],
    learned: [
      '전부 아니면 전무가 아닙니다. 일부 기능을 포기하고 응답을 지키는 방법이 있습니다.',
      '무엇을 건너뛰어도 되는지는 일의 성격에 달렸습니다. 추천 목록은 빼도 되지만 인증은 뺄 수 없습니다.',
      '건너뛴 일은 사라지지 않습니다. 나중에 처리할 방법까지 함께 마련해야 합니다.',
    ],
  },
  {
    id: 'shed', topic: 'stock', group: '방어 장치', title: '동시 호출 제한: 넘치면 빨리 거절하기', goal: '받을 수 있는 만큼만 받는 것이 왜 나은지 봅니다.', settings: { maxAttempts: 2, backoffMs: 200 },
    steps: [
      begin,
      apply(jammed, '동시 처리 1개, 건당 600ms', 'B가 한 번에 하나만, 하나에 600ms씩 처리하게 합니다.'),
      many(crowd, '먼저 방어 장치 없이 손님 10명을 보냅니다.',
        (ts) => `손님 ${ts.length}명 중 ${ts.filter(bad).length}명이 실패했고, 가장 오래 기다린 손님은 ${longest(ts)}입니다. A는 힘들어하는 B를 ${calls(ts, 'a-b')}번 불렀습니다.`, jammed),
      rerun({ maxConcurrent: 1 }, '이번에는 B에 동시에 보내는 호출을 1개로 제한한 조건입니다.', '동시 호출 제한은 이미 한도만큼 답을 기다리는 중이면, 새 요청을 B에 보내지 않고 바로 거절합니다.'),
      apply(jammed, '동시 처리 1개, 건당 600ms', '아까와 같은 장애를 겁니다.'),
      many(crowd, '같은 손님 10명을 보냅니다.', (ts) => {
        const fast = quick(ts.filter(bad))
        return `성공 ${ts.filter((t) => t.result === 'ok').length}명, 실패 ${ts.filter(bad).length}명입니다. 성공이 늘지는 않았습니다. 대신 가장 오래 기다린 손님이 ${longest(ts)}로 줄었고, A가 B를 부른 횟수도 ${calls(ts, 'a-b')}번으로 줄었습니다. 받지 못할 요청 ${fast.length}건은 ${fast.length ? longest(fast) : '-'} 안에 거절했습니다.`
      }, jammed),
      read("아래 '실행 이력과 비교' 탭에서 방금 두 실행을 골라 비교해 보세요.", '다 받으려다 모두 느려지는 것보다, 받을 수 있는 만큼만 받고 나머지는 빨리 거절하는 편이 낫습니다. 거절당한 손님도 2초를 기다리다 실패하는 것보다는 낫습니다.', 'tab-history'),
      remove(jammed, '장애를 없앱니다.'),
    ],
    learned: [
      '과부하에서는 요청을 다 받는 것이 친절이 아닙니다. 줄이 길어지면 모두가 느려지고 모두가 실패합니다.',
      '한도를 넘는 요청을 빨리 거절하면, 받은 요청은 제대로 처리되고 느린 서비스는 무너지지 않습니다.',
      '여기에 대체 응답을 더하면 거절 대신 임시 접수로 바꿀 수 있습니다.',
    ],
  },
)

const ms = (t: Trace, edge: string) => { const a = attempts(t, edge)[0]; return a ? human(a.call.endUs - a.call.startUs) : '-' }

LESSONS.push({
  id: 'spread', topic: 'shop', title: '한 곳의 장애가 번지는 길', goal: '여러 서비스를 거치는 주문에서 장애가 어디까지 번지는지 봅니다.', settings: { maxAttempts: 2, backoffMs: 200 },
  steps: [
    begin,
    send((t) => t.result === 'ok' && notified(t), '주문 한 건이 인증, 재고, 결제를 차례로 거치고, 알림은 큐를 통해 나중에 나갑니다. 그림에서 점이 지나가는 순서를 보세요.',
      (t) => `주문은 ${took(t)} 걸렸습니다. 인증에 ${ms(t, 'a-auth')}, 재고에 ${ms(t, 'a-b')}, 결제에 ${ms(t, 'a-pay')}를 썼고, 알림은 주문 ${human(sentAt(t))} 뒤에 나갔습니다.`),
    apply(slowPay, '지연 1500ms, 응답 방향', '순서의 맨 끝에 있는 결제사만 느려지게 합니다. 인증과 재고는 건드리지 않습니다.'),
    many({ count: 8, intervalMs: 200, concurrency: 4 }, '손님 8명을 보냅니다. 요청이 어디까지 가는지 보세요.', (ts) => {
      const paid = ts.reduce((n, t) => n + charges(t), 0)
      return `결제 하나만 느려졌는데 손님 ${ts.length}명 중 ${ts.filter(bad).length}명이 실패했습니다. 인증은 ${calls(ts, 'a-auth')}번, 재고는 ${calls(ts, 'a-b')}번 제대로 일했지만 모두 헛일이 됐습니다. 결제는 ${paid}번 됐고, 알림은 ${ts.filter(notified).length}건 나갔습니다.`
    }, slowPay),
    read("아래 '손님 화면'에서 실패한 손님을 눌러 풀이를 읽어 보세요.", '뒤쪽 서비스 하나의 장애가 앞쪽 서비스들이 한 일을 헛수고로 만들고, 손님에게는 전체 실패로 보입니다. 순서의 끝에 있을수록 버려지는 일이 많습니다.', 'tab-impact'),
    remove(slowPay, '이번에는 다른 곳을 죽여 봅니다.'),
    apply(cutWorker, '연결 차단', '이번에는 작업자를 죽입니다. 결제와 똑같이 서비스 하나가 죽는 것입니다.'),
    many({ count: 8, intervalMs: 200, concurrency: 4 }, '같은 손님 8명을 보냅니다.',
      (ts) => `이번에는 손님 ${ts.length}명 중 ${ts.filter((t) => t.result === 'ok').length}명이 주문에 성공했습니다. 알림 ${unsent(ts)}건만 큐에 쌓였습니다. 똑같이 서비스 하나가 죽었는데 손님이 겪는 일은 정반대입니다.`, cutWorker),
    remove(cutWorker, '작업자를 되살립니다.'),
  ],
  learned: [
    '요청이 답을 직접 기다리는 서비스가 죽으면 그 요청도 죽습니다. 큐 뒤에 있는 서비스가 죽으면 손님은 모릅니다.',
    '그래서 지금 꼭 끝내야 하는 일과 나중에 해도 되는 일을 나누는 것이 설계의 시작입니다.',
    '한 요청이 거치는 서비스가 많을수록, 그중 하나만 죽어도 실패할 가능성이 커집니다.',
  ],
})
