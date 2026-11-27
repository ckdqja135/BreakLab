// 도전 과제. 장애와 손님 수는 정해져 있고, 실험 조건만 바꿔서 목표를 맞춘다.
// 성공 여부는 실제로 실행한 결과(관측된 요청)로만 판정한다.
import { charges, degraded, waited } from './explain'
import { human } from './format'
import type { Burst } from './lessons'
import type { FaultInput, Trace } from './types'

export type Action = { send: number } | { fault: FaultInput } | { burst: Burst }
export interface Goal { text: string; check: (ts: Trace[]) => { ok: boolean; got: string } }
export interface Quest {
  id: string
  topic: string
  title: string
  story: string      // 상황
  script: Action[]   // 도전을 시작하면 이 순서로 실행한다
  goals: Goal[]
  hints: string[]    // 하나씩 열어 본다
}

const done = (ts: Trace[]) => ts.filter((t) => t.endUs > 0 && t.result !== 'canceled')
const failed = (ts: Trace[]) => done(ts).filter((t) => t.result !== 'ok')
const held = (ts: Trace[]) => done(ts).filter((t) => t.result === 'ok' && degraded(t).length > 0)
const full = (ts: Trace[]) => done(ts).filter((t) => t.result === 'ok' && degraded(t).length === 0)
const longest = (ts: Trace[]) => Math.max(0, ...done(ts).map((t) => waited(t, 0)))

// 자주 쓰는 목표
const noFail = (what = '주문'): Goal => ({ text: `${what} 실패 0명`, check: (ts) => ({ ok: failed(ts).length === 0, got: `실패 ${failed(ts).length}명` }) })
const within = (sec: number): Goal => ({ text: `가장 오래 기다린 손님 ${sec}초 이하`, check: (ts) => ({ ok: longest(ts) <= sec * 1e6, got: human(longest(ts)) }) })
const fullAtLeast = (n: number, what = '주문'): Goal => ({ text: `임시 접수가 아닌 완전한 ${what} ${n}건 이상`, check: (ts) => ({ ok: full(ts).length >= n, got: `${full(ts).length}건` }) })
const noDouble: Goal = { text: '같은 주문이 두 번 결제된 일 0건', check: (ts) => { const n = ts.filter((t) => charges(t) >= 2).length; return { ok: n === 0, got: `${n}건` } } }
const noHeld: Goal = { text: '임시 접수 0건 (모두 제대로 완료)', check: (ts) => ({ ok: held(ts).length === 0, got: `임시 접수 ${held(ts).length}건` }) }

const TTL = 120

export const QUESTS: Quest[] = [
  {
    id: 'slow-stock', topic: 'stock', title: '느려진 재고 서비스',
    story: 'B가 느려져서 한 번에 하나, 하나에 600ms씩만 처리합니다. 그 상태로 손님 12명이 몰려옵니다. 처음 조건 그대로면 절반쯤이 2초 넘게 기다리다 실패합니다.',
    script: [{ fault: { node: 'service-b', type: 'overload', slots: 1, workMs: 600, ttlSec: TTL } }, { burst: { count: 12, intervalMs: 150, concurrency: 5 } }],
    goals: [noFail(), within(0.9), fullAtLeast(3)],
    hints: [
      'B가 받을 수 있는 양은 정해져 있습니다. 다 받게 하려고 하지 말고, 넘치는 손님을 어떻게 대할지 정하세요.',
      "실패를 없애려면 '대체 응답'이 필요합니다. 못 받은 주문을 실패 대신 임시 접수로 돌립니다.",
      "기다림을 줄이려면 줄을 세우지 말아야 합니다. '동시 호출 제한'을 1로 두면 B가 처리 중일 때 온 손님은 바로 임시 접수가 됩니다.",
    ],
  },
  {
    id: 'slow-pay', topic: 'pay', title: '이중 결제 없이 느린 결제 넘기기',
    story: '결제사의 답이 1.5초씩 늦게 옵니다. 결제 자체는 됩니다. 손님 6명이 주문합니다. 처음 조건 그대로면 모두 실패하고 결제만 두 번씩 됩니다.',
    script: [{ fault: { edge: 'a-pay', type: 'latency', direction: 'response', latencyMs: 1500, ttlSec: TTL } }, { burst: { count: 6, intervalMs: 300, concurrency: 2 } }],
    goals: [noDouble, fullAtLeast(5), within(2.5)],
    hints: [
      '결제는 되고 있습니다. 문제는 A가 답을 받기 전에 포기한다는 점입니다.',
      '결제사의 답이 오기까지 평소 0.3초에 지연 1.5초가 더해져 약 1.8초가 걸립니다. A의 한도와 비교해 보세요.',
      "'시도별 타임아웃 ms'를 1.8초보다 넉넉하게 올리면, 재시도 없이 한 번에 성공합니다.",
    ],
  },
  {
    id: 'no-cache', topic: 'cache', title: '캐시 없는 날',
    story: '캐시가 죽었습니다. 손님 15명이 한꺼번에 상품을 봅니다. DB는 한 번에 하나, 하나에 250ms씩만 처리합니다. 처음 조건 그대로면 DB에 줄이 생겨 여러 명이 실패합니다.',
    script: [{ fault: { edge: 'a-cache', type: 'cut', ttlSec: TTL } }, { burst: { count: 15, intervalMs: 100, concurrency: 5 } }],
    goals: [noFail('조회'), within(0.8), fullAtLeast(5, '조회')],
    hints: [
      'DB가 감당할 수 있는 만큼만 보내야 합니다. 나머지 손님에게는 최신 정보 대신 기본 상품 정보를 보여 줄 수 있습니다.',
      "'대체 응답'을 켜면 DB에서 읽지 못한 조회가 실패 대신 기본 정보로 응답합니다.",
      "'동시 호출 제한'을 2로 두면 DB에는 처리 중 하나와 대기 하나만 남고, 나머지는 바로 기본 정보를 받습니다.",
    ],
  },
  {
    id: 'auth-down', topic: 'auth', title: '인증이 죽어도 주문은 받는다',
    story: '주문 한 건이 지나간 직후 인증 서버가 죽고, 이어서 손님 10명이 옵니다. 처음 조건 그대로면 10명 모두 실패합니다. 인증을 건너뛰는 것은 안 됩니다.',
    script: [{ send: 1 }, { fault: { edge: 'a-auth', type: 'cut', ttlSec: TTL } }, { burst: { count: 10, intervalMs: 200, concurrency: 5 } }],
    goals: [noFail(), noHeld],
    hints: [
      '대체 응답은 인증을 건너뛰지 않습니다. 다른 방법이 필요합니다.',
      '인증이 죽기 전에 주문 한 건이 지나갔습니다. 그때 받은 결과를 다시 쓸 수 있다면 어떨까요.',
      "'인증 결과 기억 초'를 10초 이상으로 두면, 인증이 죽은 동안에도 앞서 확인한 결과로 주문을 받습니다.",
    ],
  },
  {
    id: 'rush-day', topic: 'shop', title: '손님이 몰리는 날',
    story: '하필 손님이 몰리는 날에 세 가지가 겹쳤습니다. B는 한 번에 하나, 하나에 300ms씩만 처리하고, 결제사의 답은 0.7초씩 늦게 오며, 작업자는 죽어 있습니다. 손님 12명이 옵니다.',
    script: [
      { fault: { node: 'service-b', type: 'overload', slots: 1, workMs: 300, ttlSec: TTL } },
      { fault: { edge: 'a-pay', type: 'latency', direction: 'response', latencyMs: 700, ttlSec: TTL } },
      { fault: { edge: 'queue-worker', type: 'cut', ttlSec: TTL } },
      { burst: { count: 12, intervalMs: 150, concurrency: 4 } },
    ],
    goals: [noFail(), noDouble, within(1.8), fullAtLeast(2)],
    hints: [
      '세 장애가 모두 손님에게 닿는 것은 아닙니다. 작업자가 죽어도 주문은 됩니다. 알림은 나중에 나가도 됩니다.',
      '결제는 약 1.0초가 걸려 A의 한도 1000ms를 아슬아슬하게 넘습니다. 한도를 조금 올리고, 재시도는 끄거나 멱등 키를 붙이세요.',
      "B에 줄이 생기지 않게 '동시 호출 제한'을 두고, 못 받은 주문은 '대체 응답'으로 임시 접수하세요.",
    ],
  },
]
