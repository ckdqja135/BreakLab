// 요청 하나에 일어난 일을 관측된 span만으로 문장으로 풀어 쓴다. 관측되지 않은 것은 추측하지 않는다.
import { human } from './format'
import { EDGE_TO, meta } from './meta'
import type { Span, Trace } from './types'

export type Tone = 'plain' | 'ok' | 'warn' | 'bad'
export interface Line { tone: Tone; text: string; atUs?: number }
export interface Story { lines: Line[]; verdict: Line; after: Line[]; insights: string[] }
export interface Attempt { call: Span; peer?: Span }

const peerOf = (t: Trace, call: Span) => t.spans.find((c) => c.kind === 'server' && c.parentId === call.spanId)

// 한 연결에서 일어난 호출들. 순서대로.
export function attempts(t: Trace, edge = 'a-b'): Attempt[] {
  return t.spans.filter((s) => s.kind === 'client' && s.edge === edge).sort((a, b) => a.startUs - b.startUs).map((call) => ({ call, peer: peerOf(t, call) }))
}

// 도착 서비스가 끝까지 처리한 횟수
export const handled = (t: Trace, edge = 'a-b') => attempts(t, edge).filter((a) => a.peer?.result === 'ok').length
// 실제로 결제가 이루어진 횟수
export const charges = (t: Trace) => t.spans.filter((s) => s.service === 'pay' && s.attrs?.['lab.charged'] === 'true').length
// 알림이 작업자에게 넘어가 처리됐는지
export const notified = (t: Trace) => t.spans.some((s) => s.service === 'worker' && s.kind === 'server' && s.result === 'ok')
export const queued = (t: Trace) => attempts(t, 'a-queue').some((a) => a.call.result === 'ok')
export const queueMs = (a: Attempt) => Number(a.peer?.attrs?.['lab.queue_ms'] ?? 0)
export const waited = (t: Trace, nowUs: number) => (t.endUs || nowUs) - t.startUs

// 호출 하나를 문장으로. 부른 쪽은 from, 받은 쪽은 to.
function tell(a: Attempt, nth: string, lines: Line[]) {
  const { call, peer } = a
  const from = meta(call.service), to = meta(EDGE_TO[call.edge ?? ''])
  const took = human(call.endUs - call.startUs)
  const q = queueMs(a)
  const op = call.attrs?.['lab.op']
  const add = (tone: Tone, text: string, at = call.startUs) => lines.push({ tone, text, atUs: at })
  if (!call.endUs) { add('plain', `${from.subj} ${nth}${to.ask} 답을 기다리는 중입니다.`); return }
  if (op === 'set') {
    add(call.result === 'ok' ? 'plain' : 'warn', call.result === 'ok' ? '다음 손님을 위해 읽은 상품을 캐시에 넣어 두었습니다.' : '읽은 상품을 캐시에 넣어 두지 못했습니다.')
    return
  }
  switch (call.result) {
    case 'ok':
      if (op === 'get') add('ok', peer?.attrs?.['lab.cache_hit'] === 'true' ? `캐시에 상품이 있어서 바로 꺼냈습니다 (${took}).` : `캐시를 찾아봤지만 상품이 없었습니다 (${took}). DB로 갑니다.`)
      else add('ok', `${from.subj} ${nth}${to.ask} ${took} 만에 답을 받았습니다.${q >= 50 ? ` 그중 ${human(q * 1000)}는 ${to.short} 안에서 줄을 선 시간입니다.` : ''}`)
      if (peer?.attrs?.['lab.dedup'] === 'true') lines.push({ tone: 'ok', text: '결제는 같은 주문임을 알아보고 다시 결제하지 않았습니다.' })
      break
    case 'timeout':
      add('warn', `${from.subj} ${nth}${to.ask} ${took}를 기다렸지만 답이 없어 포기했습니다.`)
      if (peer?.attrs?.['lab.dedup'] === 'true') lines.push({ tone: 'ok', text: '결제는 요청을 받았지만, 같은 주문임을 알아보고 다시 결제하지 않았습니다.' })
      else if (peer?.result === 'ok') lines.push({ tone: 'warn', text: `${to.topic} 이 요청을 끝까지 처리했습니다. 응답이 닿기 전에 ${from.subj} 먼저 포기했습니다.` })
      else if (peer?.result === 'canceled') lines.push({ tone: 'plain', text: `${to.topic} 요청을 받았지만 ${q >= 50 ? '줄을 서 있다가' : '처리하던 중에'} 상대가 끊자 멈췄습니다.` })
      else if (peer && !peer.endUs) lines.push({ tone: 'plain', text: `${to.topic} 요청을 받았고 아직 처리 중입니다.` })
      else if (!peer && call.peer === 'undetermined') lines.push({ tone: 'plain', text: `${to.subj} 이 요청을 받았다는 기록은 없습니다.` })
      break
    case 'refused':
      add('bad', `${from.subj} ${nth}${to.short} 연결을 시도했지만 바로 거부당했습니다 (${took}).`)
      break
    case 'reset':
      add('bad', `${from.subj} ${nth}${to.short}에 요청을 보냈지만 답을 받기 전에 연결이 끊겼습니다 (${took}).`)
      if (peer?.result === 'ok') lines.push({ tone: 'warn', text: `${to.topic} 이 요청을 끝까지 처리했습니다.` })
      break
    case 'http_error':
      add('bad', `${to.subj} ${nth ? `${nth.replace('로 ', ' ')}요청에 ` : ''}오류(HTTP ${call.attrs?.['http.response.status_code'] ?? '?'})로 답했습니다 (${took}).`)
      break
    case 'canceled':
      add('plain', `요청이 취소되어 ${to.short} 호출을 중단했습니다.`)
      break
    default:
      add('bad', `${to.short} 호출이 실패했습니다. ${call.error ?? ''}`)
  }
}

export function story(t: Trace, nowUs: number): Story {
  const product = t.spans.some((s) => s.edge === 'a-cache' || s.edge === 'a-db')
  const lines: Line[] = [{ tone: 'plain', text: product ? `${t.seq}번 손님이 상품을 눌렀습니다.` : `${t.seq}번 손님이 주문을 눌렀습니다.`, atUs: t.startUs }]
  const a = t.spans.find((s) => s.service === 'service-a' && s.kind === 'server')
  const calls = t.spans.filter((s) => s.kind === 'client' && s.service === 'service-a').sort((x, y) => x.startUs - y.startUs)
  // A가 한 일을 시간순으로: 다른 서비스 호출과, 호출 없이 넘어간 일
  const steps: { at: number; run: () => void }[] = []
  const per: Record<string, number> = {}
  const total: Record<string, number> = {}
  for (const c of calls) total[c.edge + (c.attrs?.['lab.op'] ?? '')] = (total[c.edge + (c.attrs?.['lab.op'] ?? '')] ?? 0) + 1
  calls.forEach((call, i) => {
    const k = call.edge + (call.attrs?.['lab.op'] ?? '')
    const n = (per[k] = (per[k] ?? 0) + 1)
    steps.push({ at: call.startUs, run: () => {
      const prev = calls[i - 1]
      if (n > 1 && prev && prev.edge === call.edge && call.startUs - prev.endUs > 1000) lines.push({ tone: 'plain', text: `A는 ${human(call.startUs - prev.endUs)} 쉬었다가 다시 시도했습니다.`, atUs: prev.endUs })
      tell({ call, peer: peerOf(t, call) }, total[k] > 1 ? `${n}번째로 ` : '', lines)
    } })
  })
  for (const e of a?.events ?? []) {
    if (e.name === '인증 결과 재사용') steps.push({ at: e.atUs, run: () => lines.push({ tone: 'ok', text: 'A는 조금 전에 확인해 둔 인증 결과를 다시 썼습니다. 인증을 부르지 않았습니다.', atUs: e.atUs }) })
    if (e.name.startsWith('캐시를 쓸 수 없어')) steps.push({ at: e.atUs, run: () => lines.push({ tone: 'warn', text: '캐시를 쓸 수 없어 DB에서 직접 읽습니다.', atUs: e.atUs }) })
  }
  steps.sort((x, y) => x.at - y.at).forEach((s) => s.run())

  const sum = human(waited(t, nowUs))
  const did = product ? '상품 화면' : '주문 완료 화면'
  let verdict: Line
  switch (t.result) {
    case 'running': verdict = { tone: 'plain', text: `손님은 ${sum}째 기다리는 중입니다.` }; break
    case 'ok': verdict = { tone: 'ok', text: `손님은 ${sum} 만에 ${did}을 봤습니다.` }; break
    case 'http_error': verdict = { tone: 'bad', text: `손님은 ${sum}를 기다린 끝에 오류 화면(HTTP ${t.httpStatus})을 봤습니다.` }; break
    case 'timeout': verdict = { tone: 'bad', text: `손님은 ${sum}를 기다리다 포기했습니다. 요청자 타임아웃입니다.` }; break
    case 'canceled': verdict = { tone: 'plain', text: '실험 중지로 이 요청은 취소되었습니다.' }; break
    default: verdict = { tone: 'bad', text: `손님은 화면을 보지 못했습니다. ${t.error ?? ''}` }
  }

  // 손님이 답을 받은 뒤에 일어난 일: 큐가 작업자에게 알림 작업을 넘긴다.
  const after: Line[] = []
  const hand = attempts(t, 'queue-worker')
  const failedHand = hand.filter((h) => h.call.endUs > 0 && h.call.result !== 'ok')
  const okHand = hand.find((h) => h.call.result === 'ok')
  if (failedHand.length) after.push({ tone: 'warn', text: `큐가 작업자에게 알림 작업을 ${failedHand.length}번 넘기려 했지만 실패했습니다. 1초마다 다시 시도합니다.`, atUs: failedHand[0].call.startUs })
  if (okHand) after.push({ tone: 'ok', text: `작업자가 알림을 보냈습니다. 손님이 주문한 지 ${human(okHand.call.endUs - t.startUs)} 뒤입니다.`, atUs: okHand.call.endUs })
  else if (queued(t)) after.push({ tone: 'warn', text: `알림은 아직 큐에서 기다리는 중입니다 (${human(nowUs - t.startUs)}째).` })

  const insights: string[] = []
  const done = calls.filter((c) => c.endUs > 0 && c.attrs?.['lab.op'] !== 'set')
  const all = (r: string[]) => done.length > 0 && done.some((c) => c.result !== 'ok') && done.filter((c) => c.result !== 'ok').every((c) => r.includes(c.result))
  const lastTo = done.length ? meta(EDGE_TO[done[done.length - 1].edge ?? '']) : meta('service-b')
  const paid = charges(t)
  const stock = handled(t, 'a-b')
  const failed = t.endUs > 0 && t.result !== 'ok' && t.result !== 'canceled'
  if (paid >= 2) insights.push(`손님은 한 번 주문했는데 결제는 ${paid}번 됐습니다. 재시도가 같은 결제를 다시 요청했기 때문입니다.`)
  else if (paid === 1 && failed) insights.push('결제는 됐는데 손님은 주문 실패를 봤습니다. 돈만 빠져나간 주문입니다.')
  if (t.spans.some((s) => s.attrs?.['lab.dedup'] === 'true')) insights.push('멱등 키 덕분에 재시도가 있었어도 결제는 한 번만 됐습니다.')
  if (!paid && stock >= 2) insights.push(`B는 같은 주문을 ${stock}번 처리했습니다. 재시도는 같은 일을 두 번 하게 만들 수 있어, 결제처럼 한 번만 해야 하는 일에는 위험합니다.`)
  else if (!paid && stock === 1 && failed && attempts(t, 'a-b').some((x) => x.call.result !== 'ok')) insights.push('B는 일을 끝냈는데 손님은 실패를 봤습니다. 손님이 다시 주문하면 같은 일이 두 번 처리됩니다.')
  if (a?.attrs?.['lab.auth_reused'] === 'true') insights.push('인증 결과를 기억해 둔 덕분에 인증을 부르지 않고 주문을 처리했습니다. 대신 기억하는 동안은 권한이 바뀌어도 알 수 없습니다.')
  if (failed && attempts(t, 'a-auth').length && !attempts(t, 'a-auth').some((x) => x.call.result === 'ok') && !attempts(t, 'a-b').length) insights.push('B는 멀쩡하지만 불러 보지도 못했습니다. 모든 주문이 인증을 먼저 거치기 때문입니다.')
  const cacheGet = attempts(t, 'a-cache').find((x) => x.call.attrs?.['lab.op'] === 'get')
  if (cacheGet && cacheGet.call.endUs > 0 && cacheGet.call.result !== 'ok') {
    insights.push(cacheGet.call.result === 'timeout'
      ? `답 없는 캐시를 기다리는 데만 ${human(cacheGet.call.endUs - cacheGet.call.startUs)}를 썼습니다. 캐시는 빨라야 의미가 있어서, 캐시를 기다리는 한도는 아주 짧게 잡습니다.`
      : '캐시가 없어도 화면은 나왔지만 DB까지 다녀오느라 느려졌습니다. 모든 손님이 이렇게 DB로 몰리면 DB가 버티지 못합니다.')
  }
  if (t.result === 'ok' && done.some((c) => c.attrs?.['lab.attempt'] !== '1')) {
    const again = done.filter((c) => c.attrs?.['lab.attempt'] !== '1')
    const first = done.find((c) => c.edge === again[0].edge)!
    insights.push(`앞선 시도는 실패했지만 재시도로 성공했습니다. 손님은 실패를 모르는 대신 ${human(again[again.length - 1].startUs - first.startUs)} 더 기다렸습니다.`)
  }
  if (failed && all(['timeout'])) insights.push(done.filter((c) => c.result === 'timeout').length > 1
    ? 'A는 시도마다 타임아웃을 끝까지 채워 기다렸습니다. 손님이 기다린 시간은 대략 타임아웃 × 시도 횟수 + 재시도 대기입니다.'
    : `타임아웃이 없었다면 A는 ${lastTo.subj} 답할 때까지 계속 붙잡혀 있었을 것입니다.`)
  if (failed && all(['refused', 'reset'])) insights.push('연결이 바로 실패해서 A가 금방 알아챘습니다. 조용히 답이 없는 장애보다 빠른 실패가 손님을 덜 기다리게 합니다.')
  if (failed && done.filter((c) => c.result === 'http_error').length > 1 && all(['http_error'])) insights.push(`${lastTo.subj} 계속 오류로 답해서 재시도도 소용없었습니다.`)
  const slow = calls.map((c) => ({ c, q: queueMs({ call: c, peer: peerOf(t, c) }) })).sort((x, y) => y.q - x.q)[0]
  if (slow && slow.q >= 100) insights.push(`${meta(EDGE_TO[slow.c.edge ?? '']).short} 안에서 줄을 서는 데만 ${human(slow.q * 1000)}가 걸렸습니다. 처리 속도보다 기다린 시간이 문제였습니다.`)
  if (t.result === 'ok' && queued(t) && !okHand) insights.push('손님은 주문을 마쳤지만 알림은 아직 나가지 않았습니다. 손님 눈에는 장애가 보이지 않습니다.')
  return { lines, verdict, after, insights }
}
