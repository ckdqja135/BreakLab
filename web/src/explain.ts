// 요청 하나에 일어난 일을 관측된 span만으로 문장으로 풀어 쓴다. 관측되지 않은 것은 추측하지 않는다.
import { human } from './format'
import type { Span, Trace } from './types'

export type Tone = 'plain' | 'ok' | 'warn' | 'bad'
export interface Line { tone: Tone; text: string; atUs?: number }
export interface Story { lines: Line[]; verdict: Line; insights: string[] }
export interface Attempt { call: Span; peer?: Span }

// A가 B를 부른 시도들. 순서대로.
export function attempts(t: Trace): Attempt[] {
  return t.spans.filter((s) => s.kind === 'client' && s.edge === 'a-b').sort((a, b) => a.startUs - b.startUs)
    .map((call) => ({ call, peer: t.spans.find((c) => c.kind === 'server' && c.parentId === call.spanId) }))
}

// B가 끝까지 처리한 횟수
export const handled = (t: Trace) => attempts(t).filter((a) => a.peer?.result === 'ok').length
export const queueMs = (a: Attempt) => Number(a.peer?.attrs?.['lab.queue_ms'] ?? 0)
export const waited = (t: Trace, nowUs: number) => (t.endUs || nowUs) - t.startUs

export function story(t: Trace, nowUs: number): Story {
  const lines: Line[] = [{ tone: 'plain', text: `${t.seq}번 손님이 주문을 눌렀습니다.`, atUs: t.startUs }]
  const tries = attempts(t)
  tries.forEach(({ call, peer }, i) => {
    const nth = tries.length > 1 ? `${i + 1}번째로 ` : ''
    const took = human(call.endUs - call.startUs)
    const q = queueMs({ call, peer })
    if (i > 0) {
      const rest = call.startUs - tries[i - 1].call.endUs
      if (rest > 1000) lines.push({ tone: 'plain', text: `A는 ${human(rest)} 쉬었다가 다시 시도했습니다.`, atUs: tries[i - 1].call.endUs })
    }
    const add = (tone: Tone, text: string) => lines.push({ tone, text, atUs: call.startUs })
    if (!call.endUs) { add('plain', `A가 ${nth}B에 재고를 묻고 답을 기다리는 중입니다.`); return }
    switch (call.result) {
      case 'ok':
        add('ok', `A가 ${nth}B에 재고를 물었고 ${took} 만에 답을 받았습니다.${q >= 50 ? ` 그중 ${human(q * 1000)}는 B 안에서 줄을 선 시간입니다.` : ''}`)
        break
      case 'timeout':
        add('warn', `A가 ${nth}B에 재고를 물었지만 ${took}를 기다려도 답이 없어 포기했습니다.`)
        if (peer?.result === 'ok') lines.push({ tone: 'warn', text: 'B는 이 요청을 끝까지 처리했습니다. 응답이 닿기 전에 A가 먼저 포기했습니다.' })
        else if (peer?.result === 'canceled') lines.push({ tone: 'plain', text: `B는 요청을 받았지만 ${q >= 50 ? '줄을 서 있다가' : '처리하던 중에'} A가 끊자 멈췄습니다.` })
        else if (peer && !peer.endUs) lines.push({ tone: 'plain', text: 'B는 요청을 받았고 아직 처리 중입니다.' })
        else if (!peer && call.peer === 'undetermined') lines.push({ tone: 'plain', text: 'B가 이 요청을 받았다는 기록은 없습니다.' })
        break
      case 'refused':
        add('bad', `A가 ${nth}B에 연결하려 했지만 바로 거부당했습니다 (${took}).`)
        break
      case 'reset':
        add('bad', `A가 ${nth}B에 요청을 보냈지만 답을 받기 전에 연결이 끊겼습니다 (${took}).`)
        if (peer?.result === 'ok') lines.push({ tone: 'warn', text: 'B는 이 요청을 끝까지 처리했습니다.' })
        break
      case 'http_error':
        add('bad', `B가 ${nth}받은 요청에 오류(HTTP ${call.attrs?.['http.response.status_code'] ?? '?'})로 답했습니다 (${took}).`)
        break
      case 'canceled':
        add('plain', '요청이 취소되어 B 호출을 중단했습니다.')
        break
      default:
        add('bad', `B 호출이 실패했습니다. ${call.error ?? ''}`)
    }
  })

  const total = human(waited(t, nowUs))
  let verdict: Line
  switch (t.result) {
    case 'running': verdict = { tone: 'plain', text: `손님은 ${total}째 기다리는 중입니다.` }; break
    case 'ok': verdict = { tone: 'ok', text: `손님은 ${total} 만에 주문 완료 화면을 봤습니다.` }; break
    case 'http_error': verdict = { tone: 'bad', text: `손님은 ${total}를 기다린 끝에 오류 화면(HTTP ${t.httpStatus})을 봤습니다.` }; break
    case 'timeout': verdict = { tone: 'bad', text: `손님은 ${total}를 기다리다 포기했습니다. 요청자 타임아웃입니다.` }; break
    case 'canceled': verdict = { tone: 'plain', text: '실험 중지로 이 요청은 취소되었습니다.' }; break
    default: verdict = { tone: 'bad', text: `손님은 주문하지 못했습니다. ${t.error ?? ''}` }
  }

  const insights: string[] = []
  const ended = tries.filter((a) => a.call.endUs > 0)
  const all = (r: string[]) => ended.length > 0 && ended.every((a) => r.includes(a.call.result))
  const done = handled(t)
  if (done >= 2) insights.push(`B는 같은 주문을 ${done}번 처리했습니다. 재시도는 같은 일을 두 번 하게 만들 수 있어, 결제처럼 한 번만 해야 하는 일에는 위험합니다.`)
  else if (done === 1 && t.endUs > 0 && t.result !== 'ok' && t.result !== 'canceled') insights.push('B는 일을 끝냈는데 손님은 실패를 봤습니다. 손님이 다시 주문하면 같은 일이 두 번 처리됩니다.')
  if (t.result === 'ok' && tries.length > 1) insights.push(`앞선 시도는 실패했지만 재시도로 성공했습니다. 손님은 실패를 모르는 대신 ${human(tries[tries.length - 1].call.startUs - tries[0].call.startUs)} 더 기다렸습니다.`)
  if (all(['timeout'])) insights.push(ended.length > 1
    ? 'A는 시도마다 타임아웃을 끝까지 채워 기다렸습니다. 손님이 기다린 시간은 대략 타임아웃 × 시도 횟수 + 재시도 대기입니다.'
    : '타임아웃이 없었다면 A는 B가 답할 때까지 계속 붙잡혀 있었을 것입니다.')
  if (all(['refused', 'reset'])) insights.push('연결이 바로 실패해서 A가 금방 알아챘습니다. 조용히 답이 없는 장애보다 빠른 실패가 손님을 덜 기다리게 합니다.')
  if (ended.length > 1 && all(['http_error'])) insights.push('B가 계속 오류로 답해서 재시도도 소용없었습니다.')
  const line = Math.max(0, ...tries.map(queueMs))
  if (line >= 100) insights.push(`B 안에서 줄을 서는 데만 ${human(line * 1000)}가 걸렸습니다. B의 처리 속도보다 기다린 시간이 문제였습니다.`)
  return { lines, verdict, insights }
}
