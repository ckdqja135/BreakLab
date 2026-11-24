// 요청 이동 표시. 모든 점은 실제로 관측된 호출 span 하나에 대응한다.
// 실시간 표시는 사람이 볼 수 있게 구간 최소 시간을 두고, 다시 보기는 측정 시간을 일정 비율로 늘린다.
import type { Result, Span, Trace } from './types'

export interface Token {
  key: string
  edge: string
  pos: number          // 0은 출발 서비스, 1은 도착 서비스
  lane: 'req' | 'res'
  result: Result
  label: string
  mark: boolean        // 실패 지점 표시
  hold: boolean        // 다음 관측을 기다리는 중
  fade: number
}

const HALF = 380
const BACK = 620
const MARK = 1100
const LINGER = 14000

interface Vis {
  span: Span
  seq: number
  seenAt: number
  peerAt: number
  endAt: number
  vStart: number
  vEnd: number
}

const peerOf = (t: Trace, s: Span) => t.spans.find((c) => c.kind === 'server' && c.parentId === s.spanId)

function parentClient(t: Trace, s: Span): string | undefined {
  const srv = t.spans.find((p) => p.spanId === s.parentId)
  return srv?.parentId
}

const text = (seq: number, s: Span) => (s.attrs?.['lab.attempt'] ? `#${seq} 시도 ${s.attrs['lab.attempt']}` : `#${seq}`)

export class LiveAnimator {
  private vis = new Map<string, Vis>()
  private traces = new Map<string, Trace>()

  push(t: Trace) {
    const now = performance.now()
    this.traces.set(t.traceId, t)
    for (const s of t.spans) {
      if (s.kind !== 'client' || !s.edge) continue
      let v = this.vis.get(s.spanId)
      if (!v) {
        v = { span: s, seq: t.seq, seenAt: now, peerAt: 0, endAt: 0, vStart: now, vEnd: Infinity }
        this.vis.set(s.spanId, v)
      }
      v.span = s
      if (!v.peerAt && peerOf(t, s)) v.peerAt = now
      if (!v.endAt && s.endUs > 0) v.endAt = now
    }
  }

  clear() { this.vis.clear(); this.traces.clear() }

  frame(now: number): Token[] {
    const out: Token[] = []
    for (const [id, v] of this.vis) {
      const t = this.traces.get(v.span.traceId)!
      const parent = this.vis.get(parentClient(t, v.span) ?? '')
      let start = v.seenAt
      if (parent) start = Math.max(start, parent.vStart + HALF * 2)
      for (const s of t.spans) {
        const sib = this.vis.get(s.spanId)
        if (sib && sib !== v && s.parentId === v.span.parentId && s.startUs < v.span.startUs) start = Math.max(start, sib.vEnd)
      }
      v.vStart = start
      const mid = start + HALF
      const arrive = v.peerAt ? Math.max(mid, v.peerAt) + HALF : Infinity
      let end = Infinity
      const ok = v.span.result === 'ok' || v.span.result === 'http_error'
      let backAt = Infinity
      if (v.endAt) {
        const lateArrival = v.peerAt > v.endAt + 60 && !ok
        const reached = v.peerAt && !lateArrival ? arrive : mid
        backAt = Math.max(reached, v.endAt)
        for (const s of t.spans) {
          const child = this.vis.get(s.spanId)
          if (child && parentClient(t, s) === v.span.spanId) backAt = Math.max(backAt, child.vEnd)
        }
        end = backAt + (ok ? BACK : MARK)
      }
      v.vEnd = end
      const base = { key: id, edge: v.span.edge!, label: text(v.seq, v.span), result: v.span.result }
      if (now < start) continue
      if (now >= end) {
        // 호출자가 포기한 뒤 도착 서비스에서 관측된 요청
        if (v.peerAt > v.endAt + 60 && now < v.peerAt + HALF * 3) {
          const p = Math.min(1, Math.max(0, (now - v.peerAt) / (HALF * 2)))
          if (now >= v.peerAt) out.push({ ...base, pos: 0.5 + p / 2, lane: 'req', result: 'canceled', label: `${base.label} 늦은 도착`, mark: false, hold: false, fade: 0.7 })
        }
        if (now > end + LINGER) this.vis.delete(id)
        continue
      }
      if (now >= backAt) {
        const p = (now - backAt) / (end - backAt)
        if (ok) out.push({ ...base, pos: 1 - p, lane: 'res', mark: false, hold: false, fade: 1 })
        else out.push({ ...base, pos: v.span.result === 'timeout' || v.span.result === 'canceled' ? 0.06 : 0.5, lane: 'req', mark: true, hold: false, fade: 1 - p * p })
        continue
      }
      let pos = 0.5
      let hold = true
      if (now < mid) { pos = ((now - start) / HALF) * 0.5; hold = false }
      else if (arrive < Infinity) {
        const p = Math.min(1, (now - (arrive - HALF)) / HALF)
        pos = 0.5 + Math.max(0, p) * 0.5
        hold = p >= 1
      }
      out.push({ ...base, pos, lane: 'req', result: 'running', mark: false, hold, fade: 1 })
    }
    return out
  }
}

export function replaySpan(t: Trace): { startUs: number; endUs: number; uiMs: number; scale: number } {
  const ends = t.spans.map((s) => s.endUs || s.startUs)
  const endUs = Math.max(t.endUs, ...ends)
  const real = Math.max(0.1, (endUs - t.startUs) / 1000)
  const uiMs = Math.min(8000, Math.max(3000, real))
  return { startUs: t.startUs, endUs, uiMs, scale: uiMs / real }
}

// 측정 시각을 그대로 쓰므로 실제로 오래 걸린 구간에서 점이 오래 머문다.
export function replayTokens(t: Trace, atUs: number): Token[] {
  const out: Token[] = []
  for (const s of t.spans) {
    if (s.kind !== 'client' || !s.edge || atUs < s.startUs) continue
    const p = peerOf(t, s)
    const ok = s.result === 'ok' || s.result === 'http_error'
    const base = { key: s.spanId, edge: s.edge, label: text(t.seq, s), result: s.result, mark: false, hold: false, fade: 1 }
    const ratio = (a: number, b: number) => (b <= a ? 1 : Math.min(1, Math.max(0, (atUs - a) / (b - a))))
    if (s.endUs && atUs >= s.endUs) {
      if (!ok && p && p.startUs > s.endUs && atUs < p.startUs) out.push({ ...base, pos: 0.5, lane: 'req', hold: true, fade: 0.6 })
      else if (!ok) out.push({ ...base, pos: s.peer === 'not_sent' ? 0.5 : 0.06, lane: 'req', mark: true })
      continue
    }
    if (!p) { out.push({ ...base, pos: 0.5 * ratio(s.startUs, s.startUs + (s.endUs - s.startUs) / 2), lane: 'req', result: 'running', hold: true }); continue }
    if (atUs < p.startUs) { out.push({ ...base, pos: ratio(s.startUs, p.startUs), lane: 'req', result: 'running' }); continue }
    if (!p.endUs || atUs < p.endUs || !ok) { out.push({ ...base, pos: 1, lane: 'req', result: 'running', hold: true }); continue }
    out.push({ ...base, pos: 1 - ratio(p.endUs, s.endUs), lane: 'res' })
  }
  return out
}
