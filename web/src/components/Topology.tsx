import { Activity, Boxes, CircleCheck, CircleHelp, CircleX, Eye, EyeOff, Server, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { LiveAnimator, replaySpan, replayTokens, type Token } from '../anim'
import { faultKind, isActive, ms, resultLabel, routeLabel, seconds } from '../format'
import type { Fault, LabState, Selection, ServiceStatus, Span, Trace } from '../types'

const Y = 205
const LANE = 11
const BOX: Record<string, { x: number; w: number; icon: LucideIcon }> = {
  generator: { x: 40, w: 168, icon: Activity },
  'service-a': { x: 372, w: 176, icon: Server },
  'service-b': { x: 792, w: 176, icon: Boxes },
}
const LINE: Record<string, [number, number]> = { 'gen-a': [208, 372], 'a-b': [548, 792] }
const H = 104

interface Props {
  state: LabState
  traces: Trace[]
  faults: Fault[]
  past: boolean
  selection: Selection
  onSelect: (s: Selection) => void
  focus: Trace | null
  replay: boolean
  onReplayTime: (us: number | null) => void
  onReplayEnd: () => void
  animator: LiveAnimator
  nowUs: number
}

export interface EdgeStat { ok: number; fail: number; last?: Span; inFlight: number; total: number }

export function edgeStat(traces: Trace[], edge: string): EdgeStat {
  const st: EdgeStat = { ok: 0, fail: 0, inFlight: 0, total: 0 }
  for (const t of traces) for (const s of t.spans) {
    if (s.edge !== edge || s.kind !== 'client') continue
    st.total++
    if (s.endUs === 0) { st.inFlight++; continue }
    if (s.result === 'ok') st.ok++
    else if (s.result !== 'canceled') st.fail++
    if (!st.last || s.endUs > st.last.endUs) st.last = s
  }
  return st
}

const tagText = (f: Fault) =>
  f.type === 'latency' ? `지연 ${f.latencyMs}ms ${f.direction === 'request' ? '요청 방향' : '응답 방향'}`
    : f.type === 'error' ? `오류 응답 ${f.percent}%`
    : f.type === 'overload' ? `과부하: ${f.slots}개씩, 건당 ${f.workMs}ms`
    : faultKind[f.type].name
const tagState = (f: Fault, live: boolean, nowUs: number) =>
  f.state === 'active' && live ? `${f.node ? '적용됨' : '적용 확인됨'}, ${seconds(f.expiresUs - nowUs)} 뒤 자동 해제`
    : f.state === 'applying' ? '적용 중' : f.state === 'removing' ? '제거 확인 중' : '정리 미확인, 재시도 중'

const key = (fn: () => void) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() } }

export function Topology(p: Props) {
  const active = p.faults.filter(isActive)
  const focusEdges = new Set(p.focus?.spans.filter((s) => s.edge).map((s) => s.edge))
  return (
    <svg className="topo" viewBox="0 0 1008 410" role="group" aria-label="서비스 토폴로지">
      <defs>
        <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="context-stroke" /></marker>
      </defs>
      <Ruler />
      {p.state.topology.edges.map((e) => {
        const [x1, x2] = LINE[e.id]
        const st = edgeStat(p.traces, e.id)
        const fault = active.find((f) => f.edge === e.id)
        const sel = p.selection?.type === 'edge' && p.selection.id === e.id
        const dim = p.focus && !focusEdges.has(e.id)
        const observed = st.total > 0
        const mid = (x1 + x2) / 2
        const cls = (lane: 'request' | 'response') =>
          `wire ${observed ? '' : 'unobserved'} ${fault && (fault.type === 'cut' || (fault.type === 'latency' ? fault.direction === lane : lane === 'request')) ? 'faulted' : ''} ${p.focus && focusEdges.has(e.id) ? 'focused' : ''}`
        const gap = fault?.type === 'cut' ? 26 : e.proxy ? 15 : 0
        const pick = () => p.onSelect({ type: 'edge', id: e.id })
        return (
          <g key={e.id} className={`edge ${sel ? 'sel' : ''} ${dim ? 'dim' : ''}`} role="button" tabIndex={0} aria-label={`연결 ${e.from}에서 ${e.to}`} onClick={pick} onKeyDown={key(pick)}>
            <rect className="hit" x={x1 + 2} y={Y - 82} width={x2 - x1 - 4} height={170} rx="4" />
            {gap ? (
              <>
                <path className={cls('request')} d={`M${x1} ${Y - LANE}H${mid - gap}`} /><path className={cls('request')} d={`M${mid + gap} ${Y - LANE}H${x2 - 3}`} markerEnd="url(#arr)" />
                <path className={cls('response')} d={`M${x2} ${Y + LANE}H${mid + gap}`} /><path className={cls('response')} d={`M${mid - gap} ${Y + LANE}H${x1 + 3}`} markerEnd="url(#arr)" />
              </>
            ) : (
              <>
                <path className={cls('request')} d={`M${x1} ${Y - LANE}H${x2 - 3}`} markerEnd="url(#arr)" />
                <path className={cls('response')} d={`M${x2} ${Y + LANE}H${x1 + 3}`} markerEnd="url(#arr)" />
              </>
            )}
            {e.proxy && (
              <g className={`valve ${fault ? 'on' : ''}`} data-c="proxy">
                <path d={`M${mid - 15} ${Y - 24} L${mid + 15} ${Y + 24} V${Y - 24} L${mid - 15} ${Y + 24} Z`} />
                <text x={mid} y={Y + 42} className="t-small">프록시</text>
              </g>
            )}
            <text x={mid} y={Y - 66} className="t-label">{e.protocol}</text>
            <text x={mid} y={Y - 51} className={`t-small ${st.last?.route === 'bypassed' ? 'alert' : ''}`}>
              {!observed ? '설정된 연결, 관측된 호출 없음' : st.last?.route ? routeLabel[st.last.route] : '경로 관측 대기'}
            </text>
            <g className="dimline">
              <path d={`M${x1 + 1} ${Y + 58}V${Y + 84} M${x2 - 1} ${Y + 58}V${Y + 84}`} />
              <path d={`M${x1 + 4} ${Y + 76}H${x2 - 4}`} markerStart="url(#arr)" markerEnd="url(#arr)" />
              <rect x={mid - 48} y={Y + 66} width="96" height="20" />
              <text x={mid} y={Y + 81} className="t-dim">{st.last ? ms(st.last.endUs - st.last.startUs) : '측정 없음'}</text>
            </g>
            <text x={mid} y={Y + 106} className="t-small">
              {st.last ? `최근 ${resultLabel[st.last.result].text}, 성공 ${st.ok} 실패 ${st.fail}` : st.inFlight ? `진행 중 ${st.inFlight}` : ''}
            </text>
            {fault && (
              <g className="faulttag">
                <path d={`M${mid} ${Y - 26}V${Y - 46} M${mid} ${Y - 80}V${Y - 92}`} />
                <rect x={mid - 104} y={Y - 136} width="208" height="44" rx="3" />
                <text x={mid} y={Y - 118} className="t-fault">{tagText(fault)}</text>
                <text x={mid} y={Y - 101} className="t-fault2">{tagState(fault, !p.past, p.nowUs)}</text>
              </g>
            )}
          </g>
        )
      })}
      {p.state.topology.nodes.map((n) => {
        const b = BOX[n.id]
        const Icon = b.icon
        const svc = p.state.services.find((s) => s.service === n.id)
        const busy = p.traces.reduce((c, t) => c + t.spans.filter((s) => s.service === n.id && s.kind === (n.id === 'generator' ? 'client' : 'server') && s.endUs === 0).length, 0)
        const sel = p.selection?.type === 'node' && p.selection.id === n.id
        const on = p.focus?.spans.some((s) => s.service === n.id)
        const pick = () => p.onSelect({ type: 'node', id: n.id })
        const fault = active.find((f) => f.node === n.id)
        const cx = b.x + b.w / 2
        // 과부하 중에는 받은 요청 가운데 자리를 얻지 못한 수가 줄을 선 수다.
        const queued = fault?.type === 'overload' && !p.past ? Math.max(0, busy - (fault.slots ?? 0)) : 0
        return (
          <g key={n.id} className={`node ${sel ? 'sel' : ''} ${fault ? 'faulted' : ''} ${p.focus ? (on ? 'focused' : 'dim') : ''}`} data-c={n.id} role="button" tabIndex={0} aria-label={n.name} onClick={pick} onKeyDown={key(pick)}>
            <rect className="body" x={b.x} y={Y - H / 2} width={b.w} height={H} />
            <path className="ticks" d={`M${b.x - 6} ${Y - H / 2}h12 M${b.x} ${Y - H / 2 - 6}v12 M${b.x + b.w - 6} ${Y - H / 2}h12 M${b.x + b.w} ${Y - H / 2 - 6}v12 M${b.x - 6} ${Y + H / 2}h12 M${b.x} ${Y + H / 2 - 6}v12 M${b.x + b.w - 6} ${Y + H / 2}h12 M${b.x + b.w} ${Y + H / 2 - 6}v12`} />
            <Icon x={b.x + 14} y={Y - 38} size={22} className="nicon" />
            <text x={b.x + 46} y={Y - 21} className="t-name">{n.name}</text>
            {svc ? <NodeStatus svc={svc} x={b.x + 14} /> : (
              <>
                <text x={b.x + 14} y={Y + 10} className="t-stat">관리 서버에서 실행</text>
                <text x={b.x + 14} y={Y + 30} className="t-stat">실제 HTTP 요청</text>
              </>
            )}
            {busy > 0 && (queued > 0
              ? <g className="busy queued"><rect x={b.x + b.w - 112} y={Y - H / 2 - 12} width="104" height="22" rx="3" /><text x={b.x + b.w - 60} y={Y - H / 2 + 3}>처리 {busy - queued}, 줄 {queued}</text></g>
              : <g className="busy"><rect x={b.x + b.w - 70} y={Y - H / 2 - 12} width="62" height="22" rx="3" /><text x={b.x + b.w - 39} y={Y - H / 2 + 3}>처리 중 {busy}</text></g>)}
            {fault && (
              <g className="faulttag">
                <path d={`M${cx - 60} ${Y - H / 2}V${Y - H / 2 - 20}`} />
                <rect x={cx - 104} y={Y - H / 2 - 64} width="208" height="44" rx="3" />
                <text x={cx} y={Y - H / 2 - 46} className="t-fault">{tagText(fault)}</text>
                <text x={cx} y={Y - H / 2 - 29} className="t-fault2">{tagState(fault, !p.past, p.nowUs)}</text>
              </g>
            )}
          </g>
        )
      })}
      <Tokens {...p} />
    </svg>
  )
}

function NodeStatus({ svc, x }: { svc: ServiceStatus; x: number }) {
  const H1 = { up: [CircleCheck, '서비스 응답 정상', 'ok'], down: [CircleX, '서비스 응답 없음', 'bad'], unknown: [CircleHelp, '서비스 확인 전', 'mute'] }[svc.health] as [LucideIcon, string, string]
  const T1 = { ok: [Eye, '관측 수신 중', 'ok'], stale: [EyeOff, '관측 끊김', 'warn'], never: [CircleHelp, '관측 수신 전', 'mute'] }[svc.telemetry] as [LucideIcon, string, string]
  return (
    <>
      {[H1, T1].map(([Icon, label, tone], i) => (
        <g key={label} className={`tone-${tone}`}>
          <Icon x={x} y={Y - 3 + i * 20} size={14} />
          <text x={x + 20} y={Y + 9 + i * 20} className="t-stat">{label}</text>
        </g>
      ))}
    </>
  )
}

function Ruler() {
  const xs = Array.from({ length: 21 }, (_, i) => 4 + i * 50)
  const ys = Array.from({ length: 9 }, (_, i) => 4 + i * 50)
  return <path className="ruler" d={`M4 4H1004 M4 4V404 ${xs.map((x, i) => `M${x} 4v${i % 4 ? 5 : 9}`).join(' ')} ${ys.map((y, i) => `M4 ${y}h${i % 4 ? 5 : 9}`).join(' ')}`} />
}

const MAX_TOKENS = 40

function Tokens(p: Props) {
  const [tokens, set] = useState<Token[]>([])
  const props = useRef(p)
  props.current = p
  useEffect(() => {
    let id = 0
    let began = 0
    let had = false
    const loop = (now: number) => {
      const { focus, replay, animator, onReplayTime, onReplayEnd, past } = props.current
      let next: Token[] = []
      if (replay && focus) {
        if (!began) began = now
        const r = replaySpan(focus)
        const t = Math.min(1, (now - began) / r.uiMs)
        const at = r.startUs + t * (r.endUs - r.startUs)
        next = replayTokens(focus, at)
        onReplayTime(at)
        if (now - began > r.uiMs + 900) { began = 0; onReplayTime(null); onReplayEnd() }
      } else {
        began = 0
        next = past ? [] : animator.frame(now)
      }
      if (next.length || had) set(next)
      had = next.length > 0
      id = requestAnimationFrame(loop)
    }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [])
  const many = tokens.length > 8
  return (
    <g className="tokens" aria-hidden>
      {tokens.slice(0, MAX_TOKENS).map((t) => {
        const [x1, x2] = LINE[t.edge]
        const x = x1 + (x2 - x1) * t.pos
        const y = t.lane === 'req' ? Y - LANE : Y + LANE
        const lab = resultLabel[t.result]
        const Icon = lab.icon
        return (
          <g key={t.key} transform={`translate(${x} ${y})`} className={`token tone-${lab.tone} ${t.hold ? 'hold' : ''}`} opacity={t.fade}>
            {t.mark ? <><circle r="12" className="markbg" /><Icon x={-9} y={-9} size={18} /></> : <><circle r="7" className="dot" />{t.hold && <circle r="7" className="pulse" />}</>}
            {(!many || t.mark) && <text y={t.lane === 'req' ? -16 : 22}>{t.label}{t.mark ? ` ${lab.text}` : ''}</text>}
          </g>
        )
      })}
      {tokens.length > MAX_TOKENS && <text x="500" y="398" className="t-small">표시 한도를 넘은 요청 {tokens.length - MAX_TOKENS}개는 그리지 않음</text>}
    </g>
  )
}
