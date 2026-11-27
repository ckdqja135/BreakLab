// 학습 과정. 단계의 완료 여부와 관찰 문장은 모두 실제 실험 상태와 관측값으로 판단한다.
import { attempts, handled, waited } from './explain'
import { human } from './format'
import type { FaultInput, LabState, Selection, Settings, Trace } from './types'

export interface Ctx {
  live: LabState
  traces: Trace[]
  selection: Selection
  focusId: string | null
  tab: string
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
  done: (c: Ctx) => boolean
  saw?: (c: Ctx) => string
}
export interface Lesson { id: string; title: string; goal: string; settings?: Partial<Settings>; steps: Step[]; learned: string[] }

const TTL = 240
const running = (c: Ctx) => c.live.run?.status === 'running'
const mine = (c: Ctx) => running(c) && c.live.run!.startedUs >= c.lessonUs
const fresh = (c: Ctx) => c.traces.filter((t) => t.startUs >= c.sinceUs && t.endUs > 0 && t.result !== 'canceled')
const same = (a: FaultInput, b: FaultInput) => a.type === b.type && a.edge === b.edge && a.node === b.node
export const active = (c: Ctx, f: FaultInput) => c.live.faults.some((x) => x.state === 'active' && same(x, f))
const picked = (c: Ctx, f: FaultInput) => (f.node ? c.selection?.type === 'node' && c.selection.id === f.node : c.selection?.type === 'edge' && c.selection.id === f.edge)
const where = (f: FaultInput) => (f.node ? "그림에서 'Service B' 상자를 누르세요." : "그림 가운데 '프록시'를 누르세요.")
const spot = (f: FaultInput) => (f.node ? 'service-b' : 'proxy')
const bad = (t: Trace) => t.result !== 'ok'
const tried = (t: Trace, result: string) => attempts(t).some((a) => a.call.result === result)

const begin: Step = {
  do: (c) => (running(c) && !mine(c) ? "이전 실험이 아직 실행 중입니다. 위쪽 '실험 종료'를 누르세요." : "위쪽 파란 '실험 시작'을 누르세요."),
  hint: (c) => (running(c) && !mine(c) ? 'end' : 'start'),
  why: '실험을 시작해야 요청과 장애를 보낼 수 있습니다. 조건은 이 과정에 맞게 채워 두었습니다.',
  done: mine,
}

const apply = (f: FaultInput, values: string, why: string): Step => ({
  do: (c) => (picked(c, f) ? `오른쪽에 ${values} 값을 채워 두었습니다. 보라색 '장애 적용'을 누르세요.` : where(f)),
  hint: (c) => (picked(c, f) ? 'apply' : spot(f)),
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
    id: 'path', title: '요청 하나 따라가기', goal: '요청이 어디를 거쳐 갔다 오는지 봅니다.',
    steps: [
      begin,
      send((t) => t.result === 'ok', '진짜 HTTP 요청 하나가 요청 발생기에서 A로, A에서 B로 갑니다. 그림 위의 점을 따라가 보세요.',
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
    id: 'slow', title: '연결이 느려지면', goal: '연결 지연이 손님의 대기 시간으로 이어지는 것을 봅니다.',
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
    id: 'timeout', title: '타임아웃: 기다림의 한도', goal: '너무 느린 답을 기다리다 포기하는 과정을 봅니다.', settings: { maxAttempts: 1 },
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
    id: 'retry', title: '재시도: 약이 될 때, 독이 될 때', goal: '같은 재시도가 상황에 따라 정반대 결과를 내는 것을 봅니다.', settings: { maxAttempts: 2, backoffMs: 200 },
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
    id: 'silence', title: '끊김의 두 얼굴', goal: '바로 실패하는 장애와 조용히 매달리는 장애를 비교합니다.', settings: { maxAttempts: 1 },
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
    id: 'queue', title: '느린 서비스 하나가 줄을 세운다', goal: '죽지 않은 서비스가 어떻게 장애를 만드는지 봅니다.', settings: { maxAttempts: 2, backoffMs: 200 },
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
