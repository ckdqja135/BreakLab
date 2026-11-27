import { CircleCheck, CircleHelp, CircleX, Eye, EyeOff, Gauge as GaugeIcon, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { LiveAnimator, replaySpan, replayTokens, type Token } from '../anim'
import { faultKind, isActive, ms, resultLabel, routeLabel, seconds } from '../format'
import { meta } from '../meta'
import type { Edge, Fault, LabState, Scenario, Selection, ServiceStatus, Span, Trace } from '../types'

// 자리: 가로 세 칸, 세로 두 줄. 가운데 줄(row 1)에 요청이 지나가고, 윗줄(row 0)에는 A가 따로 부르는 서비스가 놓인다.
const COL = [{ x: 40, w: 168 }, { x: 372, w: 176 }, { x: 792, w: 176 }]
const H = 104
const LANE = 11

interface Geo {
  height: number
  box: Record<string, { x: number; w: number; y: number }> // y는 상자 가운데
  line: Record<string, { v: boolean; a: number; b: number; at: number }> // 가로면 at이 y, 세로면 at이 x
}

export function layout(sc: Scenario, edges: Edge[]): Geo {
  const tall = sc.nodes.some((n) => n.row === 0)
  const Y = tall ? [160, 410] : [0, 205]
  const box: Geo['box'] = {}
  for (const n of sc.nodes) box[n.id] = { ...COL[n.col], y: Y[n.row] }
  const line: Geo['line'] = {}
  for (const id of sc.edges) {
    const e = edges.find((x) => x.id === id)
    const f = e && box[e.from], t = e && box[e.to]
    if (!f || !t) continue
    line[id] = f.x === t.x
      ? { v: true, a: f.y - H / 2, b: t.y + H / 2, at: f.x + f.w / 2 } // 아래 상자의 위에서 위 상자의 아래로
      : { v: false, a: f.x + f.w, b: t.x, at: f.y }
  }
  return { height: tall ? 530 : 410, box, line }
}

// place는 연결 위의 한 점이다. pos 0은 출발 서비스, 1은 도착 서비스.
function place(g: Geo, edge: string, pos: number, lane: 'req' | 'res'): [number, number, boolean] {
  const l = g.line[edge]
  if (!l) return [-99, -99, false]
  const along = l.a + (l.b - l.a) * pos
  const side = lane === 'req' ? -LANE : LANE
  return l.v ? [l.at + side, along, true] : [along, l.at + side, false]
}

interface Props {
  state: LabState
  scenario: Scenario
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
  const g = layout(p.scenario, p.state.topology.edges)
  const active = p.faults.filter(isActive)
  const focusEdges = new Set(p.focus?.spans.filter((s) => s.edge).map((s) => s.edge))
  const nodes = p.state.topology.nodes.filter((n) => g.box[n.id])
  const edges = p.state.topology.edges.filter((e) => g.line[e.id])
  return (
    <svg className="topo" viewBox={`0 0 1008 ${g.height}`} role="group" aria-label="서비스 토폴로지">
      <defs>
        <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="context-stroke" /></marker>
      </defs>
      <Ruler h={g.height} />
      {edges.map((e) => {
        const l = g.line[e.id]
        const st = edgeStat(p.traces, e.id)
        const fault = active.find((f) => f.edge === e.id)
        const sel = p.selection?.type === 'edge' && p.selection.id === e.id
        const dim = p.focus && !focusEdges.has(e.id)
        const observed = st.total > 0
        const mid = (l.a + l.b) / 2
        const cls = (lane: 'request' | 'response') =>
          `wire ${observed ? '' : 'unobserved'} ${fault && (fault.type === 'cut' || (fault.type === 'latency' ? fault.direction === lane : lane === 'request')) ? 'faulted' : ''} ${p.focus && focusEdges.has(e.id) ? 'focused' : ''}`
        const gap = fault?.type === 'cut' ? 26 : e.proxy ? 15 : 0
        const dir = l.b > l.a ? 1 : -1
        const pick = () => p.onSelect({ type: 'edge', id: e.id })
        const route = !observed ? '설정된 연결, 관측된 호출 없음' : st.last?.route ? routeLabel[st.last.route] : '경로 관측 대기'
        const took = st.last ? ms(st.last.endUs - st.last.startUs) : '측정 없음'
        const count = st.last ? `최근 ${resultLabel[st.last.result].text}, 성공 ${st.ok} 실패 ${st.fail}` : st.inFlight ? `진행 중 ${st.inFlight}` : ''
        const common = { className: `edge ${sel ? 'sel' : ''} ${dim ? 'dim' : ''}`, role: 'button', tabIndex: 0, 'aria-label': `연결 ${meta(e.from).name}에서 ${meta(e.to).name}`, onClick: pick, onKeyDown: key(pick) }
        if (l.v) {
          const x = l.at
          // 세로 연결은 글자와 장애 표시를 모두 왼쪽에 둔다. 오른쪽은 가운데 줄 연결의 장애 표시 자리다.
          return (
            <g key={e.id} {...common}>
              <rect className="hit" x={x - 196} y={l.b + 2} width={236} height={l.a - l.b - 4} rx="4" />
              <path className={cls('request')} d={`M${x - LANE} ${l.a}V${mid + gap}`} /><path className={cls('request')} d={`M${x - LANE} ${mid - gap}V${l.b + 3}`} markerEnd="url(#arr)" />
              <path className={cls('response')} d={`M${x + LANE} ${l.b}V${mid - gap}`} /><path className={cls('response')} d={`M${x + LANE} ${mid + gap}V${l.a - 3}`} markerEnd="url(#arr)" />
              <g className={`valve ${fault ? 'on' : ''}`} data-c={e.id}>
                <path d={`M${x - 24} ${mid - 15} L${x + 24} ${mid + 15} H${x - 24} L${x + 24} ${mid - 15} Z`} />
                <text x={x + 30} y={mid + 28} className="t-small left">프록시</text>
              </g>
              <text x={x - 34} y={mid + 2} className="t-label right">{e.protocol} <tspan className="t-dimv">{took}</tspan></text>
              <text x={x - 34} y={mid + 18} className={`t-small right ${st.last?.route === 'bypassed' ? 'alert' : ''}`}>{route}</text>
              <text x={x - 34} y={mid + 33} className="t-small right">{count}</text>
              {fault && (
                <g className="faulttag">
                  <path d={`M${x - 34} ${mid - 36}L${x - 24} ${mid - 16}`} />
                  <rect x={x - 242} y={mid - 66} width="208" height="44" rx="3" />
                  <text x={x - 138} y={mid - 48} className="t-fault">{tagText(fault)}</text>
                  <text x={x - 138} y={mid - 31} className="t-fault2">{tagState(fault, !p.past, p.nowUs)}</text>
                </g>
              )}
            </g>
          )
        }
        const [x1, x2, Y] = [l.a, l.b, l.at]
        return (
          <g key={e.id} {...common}>
            <rect className="hit" x={x1 + 2} y={Y - 82} width={x2 - x1 - 4} height={170} rx="4" />
            {gap ? (
              <>
                <path className={cls('request')} d={`M${x1} ${Y - LANE}H${mid - gap}`} /><path className={cls('request')} d={`M${mid + gap} ${Y - LANE}H${x2 - 3 * dir}`} markerEnd="url(#arr)" />
                <path className={cls('response')} d={`M${x2} ${Y + LANE}H${mid + gap}`} /><path className={cls('response')} d={`M${mid - gap} ${Y + LANE}H${x1 + 3 * dir}`} markerEnd="url(#arr)" />
              </>
            ) : (
              <>
                <path className={cls('request')} d={`M${x1} ${Y - LANE}H${x2 - 3}`} markerEnd="url(#arr)" />
                <path className={cls('response')} d={`M${x2} ${Y + LANE}H${x1 + 3}`} markerEnd="url(#arr)" />
              </>
            )}
            {e.proxy && (
              <g className={`valve ${fault ? 'on' : ''}`} data-c={e.id}>
                <path d={`M${mid - 15} ${Y - 24} L${mid + 15} ${Y + 24} V${Y - 24} L${mid - 15} ${Y + 24} Z`} />
                <text x={mid} y={Y + 42} className="t-small">프록시</text>
              </g>
            )}
            <text x={mid} y={Y - 66} className="t-label">{e.protocol}</text>
            <text x={mid} y={Y - 51} className={`t-small ${st.last?.route === 'bypassed' ? 'alert' : ''}`}>{route}</text>
            <g className="dimline">
              <path d={`M${x1 + 1} ${Y + 58}V${Y + 84} M${x2 - 1} ${Y + 58}V${Y + 84}`} />
              <path d={`M${x1 + 4} ${Y + 76}H${x2 - 4}`} markerStart="url(#arr)" markerEnd="url(#arr)" />
              <rect x={mid - 48} y={Y + 66} width="96" height="20" />
              <text x={mid} y={Y + 81} className="t-dim">{took}</text>
            </g>
            <text x={mid} y={Y + 106} className="t-small">{count}</text>
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
      {nodes.map((n) => {
        const b = g.box[n.id]
        const Y = b.y
        const Icon = meta(n.id).icon
        const svc = p.state.services.find((s) => s.service === n.id)
        const busy = p.traces.reduce((c, t) => c + t.spans.filter((s) => s.service === n.id && s.kind === (n.id === 'generator' ? 'client' : 'server') && s.endUs === 0).length, 0)
        const sel = p.selection?.type === 'node' && p.selection.id === n.id
        const on = p.focus?.spans.some((s) => s.service === n.id)
        const pick = () => p.onSelect({ type: 'node', id: n.id })
        const fault = active.find((f) => f.node === n.id)
        const cx = b.x + b.w / 2
        // 한 번에 처리하는 수가 정해져 있으면, 받은 요청 가운데 자리를 얻지 못한 수가 줄을 선 수다.
        const slots = fault?.type === 'overload' ? fault.slots ?? 0 : n.slots ?? 0
        const queued = slots > 0 && !p.past ? Math.max(0, busy - slots) : 0
        return (
          <g key={n.id} className={`node ${sel ? 'sel' : ''} ${fault ? 'faulted' : ''} ${p.focus ? (on ? 'focused' : 'dim') : ''}`} data-c={n.id} role="button" tabIndex={0} aria-label={n.name} onClick={pick} onKeyDown={key(pick)}>
            <rect className="body" x={b.x} y={Y - H / 2} width={b.w} height={H} />
            <path className="ticks" d={`M${b.x - 6} ${Y - H / 2}h12 M${b.x} ${Y - H / 2 - 6}v12 M${b.x + b.w - 6} ${Y - H / 2}h12 M${b.x + b.w} ${Y - H / 2 - 6}v12 M${b.x - 6} ${Y + H / 2}h12 M${b.x} ${Y + H / 2 - 6}v12 M${b.x + b.w - 6} ${Y + H / 2}h12 M${b.x + b.w} ${Y + H / 2 - 6}v12`} />
            <Icon x={b.x + 14} y={Y - 38} size={22} className="nicon" />
            <text x={b.x + 46} y={Y - 21} className="t-name">{n.name}</text>
            {svc ? <NodeStatus svc={svc} x={b.x + 14} y={Y} live={!p.past} /> : (
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
      <Tokens {...p} geo={g} />
    </svg>
  )
}

// 서비스가 스스로 센 값이 있으면 둘째 줄에 그 값을 보여 준다. 관측이 끊겼을 때는 그 사실이 먼저다.
function NodeStatus({ svc, x, y, live }: { svc: ServiceStatus; x: number; y: number; live: boolean }) {
  const H1 = { up: [CircleCheck, '서비스 응답 정상', 'ok'], down: [CircleX, '서비스 응답 없음', 'bad'], unknown: [CircleHelp, '서비스 확인 전', 'mute'] }[svc.health] as [LucideIcon, string, string]
  const T1 = { ok: [Eye, '관측 수신 중', 'ok'], stale: [EyeOff, '관측 끊김', 'warn'], never: [CircleHelp, '관측 수신 전', 'mute'] }[svc.telemetry] as [LucideIcon, string, string]
  const gauge = live && svc.telemetry !== 'stale' ? svc.gauges?.[0] : undefined
  const second: [LucideIcon, string, string] = gauge ? [GaugeIcon, `${gauge.label} ${gauge.value}`, gauge.alert ? 'bad' : 'live'] : T1
  return (
    <>
      {[H1, second].map(([Icon, label, tone], i) => (
        <g key={i} className={`tone-${tone}`}>
          <Icon x={x} y={y - 3 + i * 20} size={14} />
          <text x={x + 20} y={y + 9 + i * 20} className="t-stat">{label}</text>
        </g>
      ))}
    </>
  )
}

function Ruler({ h }: { h: number }) {
  const xs = Array.from({ length: 21 }, (_, i) => 4 + i * 50)
  const ys = Array.from({ length: Math.floor((h - 8) / 50) + 1 }, (_, i) => 4 + i * 50)
  return <path className="ruler" d={`M4 4H1004 M4 4V${h - 6} ${xs.map((x, i) => `M${x} 4v${i % 4 ? 5 : 9}`).join(' ')} ${ys.map((y, i) => `M4 ${y}h${i % 4 ? 5 : 9}`).join(' ')}`} />
}

const MAX_TOKENS = 40

function Tokens(p: Props & { geo: Geo }) {
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
  const shown = tokens.filter((t) => p.geo.line[t.edge])
  const many = shown.length > 8
  return (
    <g className="tokens" aria-hidden>
      {shown.slice(0, MAX_TOKENS).map((t) => {
        const [x, y, v] = place(p.geo, t.edge, t.pos, t.lane)
        const lab = resultLabel[t.result]
        const Icon = lab.icon
        const req = t.lane === 'req'
        return (
          <g key={t.key} transform={`translate(${x} ${y})`} className={`token tone-${lab.tone} ${t.hold ? 'hold' : ''}`} opacity={t.fade}>
            {t.mark ? <><circle r="12" className="markbg" /><Icon x={-9} y={-9} size={18} /></> : <><circle r="7" className="dot" />{t.hold && <circle r="7" className="pulse" />}</>}
            {(!many || t.mark) && (v
              ? <text x={req ? 16 + LANE * 2 : 16} y={4} className="left">{t.label}{t.mark ? ` ${lab.text}` : ''}</text>
              : <text y={req ? -16 : 22}>{t.label}{t.mark ? ` ${lab.text}` : ''}</text>)}
          </g>
        )
      })}
      {shown.length > MAX_TOKENS && <text x="500" y={p.geo.height - 12} className="t-small">표시 한도를 넘은 요청 {shown.length - MAX_TOKENS}개는 그리지 않음</text>}
    </g>
  )
}
