// 손님 화면: 실제 요청 하나를 주문하는 손님 한 명으로 보여 준다. 숫자는 모두 관측값이며 만들어 내지 않는다.
import { Ban, CircleCheck, CircleDashed, CircleX, Lightbulb, ListTree, LoaderCircle, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { charges, degraded, notified, queued, story, waited } from '../explain'
import { Badge, faultText, human, resultLabel } from '../format'
import type { Fault, Run, Scenario, Trace } from '../types'

interface Props { traces: Trace[]; faults: Fault[]; run: Run | null; scenario: Scenario; nowUs: number; live: boolean; focusId: string | null; onFocus: (id: string | null) => void; onOpen: (id: string) => void }

const failed = (t: Trace) => t.endUs > 0 && t.result !== 'ok' && t.result !== 'canceled'
// 일부 단계를 건너뛰고 임시로 접수된 요청. 성공도 실패도 아니어서 따로 센다.
const soft = (t: Trace) => t.result === 'ok' && degraded(t).length > 0
const toneOf = (t: Trace) => (t.result === 'running' ? 'live' : soft(t) ? 'warn' : t.result === 'ok' ? 'ok' : t.result === 'canceled' ? 'mute' : 'bad')

export function Impact({ traces, faults, run, scenario, nowUs, live, focusId, onFocus, onOpen }: Props) {
  if (!traces.length) return <div className="empty">아직 손님이 없습니다. 실험을 시작하고 요청을 보내면, 요청 하나가 주문하는 손님 한 명으로 나타납니다.</div>
  const shown = traces.find((t) => t.traceId === focusId) ?? [...traces].reverse().find((t) => t.endUs > 0) ?? traces[traces.length - 1]
  return (
    <div className="impact">
      <Crowd traces={traces} scenario={scenario} fallback={!!run?.settings.fallback} nowUs={nowUs} pickedId={shown.traceId} onFocus={onFocus} />
      <Incident traces={traces} faults={faults} run={run} nowUs={nowUs} live={live} pickedId={shown.traceId} onFocus={onFocus} />
      <Told t={shown} nowUs={nowUs} onOpen={onOpen} />
    </div>
  )
}

function Crowd({ traces, scenario, fallback, nowUs, pickedId, onFocus }: { traces: Trace[]; scenario: Scenario; fallback: boolean; nowUs: number; pickedId: string; onFocus: (id: string) => void }) {
  const done = traces.filter((t) => t.endUs > 0 && t.result !== 'canceled')
  const bad = done.filter(failed).length
  const waiting = traces.filter((t) => t.result === 'running').length
  const times = done.map((t) => t.endUs - t.startUs)
  const has = (id: string) => scenario.nodes.some((n) => n.id === id)
  const held = done.filter(soft).length
  const good = done.length - bad - held
  // 손님 눈에는 보이지 않는 피해. 모두 관측된 span에서 센다.
  const paid = traces.reduce((n, t) => n + charges(t), 0)
  // 헛된 결제: 주문은 실패했는데 결제된 것과, 한 주문에 두 번째부터 결제된 것
  const wasted = traces.reduce((n, t) => n + (failed(t) ? charges(t) : Math.max(0, charges(t) - 1)), 0)
  const unsent = traces.filter((t) => queued(t) && !notified(t)).length
  const verb = has('cache') ? '조회' : '주문'
  return (
    <section className="crowd" aria-label="손님">
      <div className="tiles">
        <div className={waiting ? 'tile tone-live' : 'tile'}><b>{waiting}</b><span>대기 중</span></div>
        <div className="tile tone-ok"><b>{good}</b><span>{verb} 완료</span></div>
        {(fallback || held > 0) && <div className={held ? 'tile tone-warn' : 'tile'}><b>{held}</b><span>임시 접수</span></div>}
        <div className={bad ? 'tile tone-bad' : 'tile'}><b>{bad}</b><span>{verb} 실패</span></div>
        {has('pay') && <div className={wasted ? 'tile tone-bad' : 'tile tone-ok'}><b>{paid}</b><span>실제 결제</span></div>}
        {has('queue') && <div className={unsent ? 'tile tone-bad' : 'tile'}><b>{unsent}</b><span>알림 밀림</span></div>}
      </div>
      {has('pay') && wasted > 0 && <p className="hidden-harm">결제 {paid}번 가운데 {wasted}번은 주문이 실패했거나 같은 주문에 두 번 결제된 것입니다. 손님 화면에는 보이지 않는 피해입니다.</p>}
      {has('queue') && unsent > 0 && <p className="hidden-harm">주문은 끝났지만 알림을 아직 못 받은 손님이 {unsent}명입니다. 손님 화면에는 보이지 않는 피해입니다.</p>}
      <p className="note">
        {done.length ? `손님 ${done.length}명이 평균 ${human(times.reduce((a, b) => a + b, 0) / times.length)} 기다렸고, 가장 오래 기다린 손님은 ${human(Math.max(...times))}입니다.` : '첫 손님이 기다리는 중입니다.'}
      </p>
      <ul className="people">
        {[...traces].reverse().slice(0, 60).map((t) => {
          const run = t.result === 'running'
          const tone = toneOf(t)
          const Icon = run ? LoaderCircle : soft(t) ? CircleDashed : t.result === 'ok' ? CircleCheck : t.result === 'canceled' ? Ban : CircleX
          return (
            <li key={t.traceId}>
              <button className={`person tone-${tone} ${t.traceId === pickedId ? 'sel' : ''}`} onClick={() => onFocus(t.traceId)} aria-label={`${t.seq}번 손님 ${resultLabel[t.result].text}`}>
                <UserRound size={15} aria-hidden /><b>#{t.seq}</b>
                <Icon size={13} className={run ? 'spin' : ''} aria-hidden />
                <span>{run ? `${human(waited(t, nowUs))}째` : t.result === 'canceled' ? '취소' : soft(t) ? `${human(waited(t, nowUs))} 임시` : t.result === 'ok' ? human(waited(t, nowUs)) : `${human(waited(t, nowUs))} 실패`}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(480)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function nice(max: number, steps = [1, 2, 5, 10]): number {
  const mag = 10 ** Math.floor(Math.log10(max))
  return steps.find((s) => max / mag <= s)! * mag
}

// 사고 그래프: 가로는 실험 시간, 세로는 손님이 기다린 시간. 보라색 띠는 장애가 걸려 있던 구간이다.
function Incident({ traces, faults, run, nowUs, live, pickedId, onFocus }: { traces: Trace[]; faults: Fault[]; run: Run | null; nowUs: number; live: boolean; pickedId: string; onFocus: (id: string) => void }) {
  const [ref, W] = useWidth()
  const H = 200
  const m = { l: 44, r: 10, t: 42, b: 20 }
  const t0 = run?.startedUs ?? traces[0].startUs
  const last = Math.max(...traces.map((t) => t.endUs || t.startUs))
  const t1 = Math.max(live ? nowUs : run?.endedUs || last, last, t0 + 20e6)
  const limit = (run?.settings.callTimeoutMs ?? 1000) * 1000
  const top = nice(Math.max(limit * 1.15, ...traces.map((t) => waited(t, nowUs) * 1.08)) / 1000, [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) * 1000
  const x = (us: number) => m.l + ((us - t0) / (t1 - t0)) * (W - m.l - m.r)
  const y = (us: number) => H - m.b - (Math.min(us, top) / top) * (H - m.t - m.b)
  const secs = (t1 - t0) / 1e6
  const step = nice(secs / 5)
  const bands = faults.filter((f) => f.appliedUs > 0)
  return (
    <section className="incident" aria-label="사고 그래프">
      <h4>사고 그래프 <small>점 하나가 손님 한 명, 높을수록 오래 기다림</small></h4>
      <div ref={ref} style={{ height: H }}>
        <svg width={W} height={H} role="img" aria-label="시간에 따른 손님 대기 시간">
          {[0, 0.5, 1].map((r) => (
            <g key={r}>
              <path className="gl" d={`M${m.l} ${y(top * r)}H${W - m.r}`} />
              <text className="ax" x={m.l - 6} y={y(top * r) + 4} textAnchor="end">{r === 0 ? '0' : `${+((top * r) / 1e6).toFixed(2)}초`}</text>
            </g>
          ))}
          {Array.from({ length: Math.floor(secs / step) + 1 }, (_, i) => i * step).map((s) => (
            <text key={s} className="ax" x={x(t0 + s * 1e6)} y={H - 5} textAnchor="middle">{s}초</text>
          ))}
          {bands.map((f, i) => {
            const a = Math.max(m.l, x(f.appliedUs))
            const b = Math.min(W - m.r, x(f.removedUs || t1))
            return (
              <g key={f.id}>
                <rect className="fband" x={a} y={m.t - 4} width={Math.max(2, b - a)} height={H - m.b - m.t + 4} />
                <text className="flabel" x={a + 3} y={10 + (i % 3) * 12}>{faultText(f)}</text>
              </g>
            )
          })}
          {limit <= top && <g><path className="limit" d={`M${m.l} ${y(limit)}H${W - m.r}`} /><text className="ax halo" x={m.l + 4} y={y(limit) - 4}>A가 다른 서비스를 기다리는 한도 {human(limit)}</text></g>}
          {traces.map((t) => {
            const run = t.result === 'running'
            const tone = toneOf(t)
            const px = x(t.startUs)
            const py = y(waited(t, nowUs))
            return (
              <g key={t.traceId} className={`mark tone-${tone} ${t.traceId === pickedId ? 'sel' : ''}`} onClick={() => onFocus(t.traceId)}>
                <title>{`${t.seq}번 손님: ${resultLabel[t.result].text}, ${human(waited(t, nowUs))}`}</title>
                <path d={`M${px} ${H - m.b}V${py}`} />
                {failed(t) ? <path className="x" d={`M${px - 4} ${py - 4}l8 8M${px + 4} ${py - 4}l-8 8`} /> : <circle className={soft(t) ? 'hollow' : ''} cx={px} cy={py} r={run ? 3 : 3.5} />}
                <rect className="hit" x={px - 5} y={m.t} width="10" height={H - m.t - m.b} />
              </g>
            )
          })}
        </svg>
      </div>
      <p className="note">동그라미는 성공, 빈 동그라미는 임시 접수, 가위표는 실패입니다. 보라색 구간은 장애가 걸려 있던 시간입니다.</p>
    </section>
  )
}

const clockOf = (base: number, at?: number) => (at === undefined ? '' : `+${human(at - base)}`)

function Told({ t, nowUs, onOpen }: { t: Trace; nowUs: number; onOpen: (id: string) => void }) {
  const s = story(t, nowUs)
  return (
    <section className="told" aria-label="풀이">
      <h4>{t.seq}번 손님에게 일어난 일 <Badge label={resultLabel[t.result]} extra={t.httpStatus && t.result !== 'ok' ? String(t.httpStatus) : undefined} /></h4>
      <ol>
        {s.lines.map((l, i) => <li key={i} className={`tone-${l.tone}`}><time className="mono">{clockOf(t.startUs, l.atUs)}</time><span>{l.text}</span></li>)}
      </ol>
      <p className={`verdict tone-${s.verdict.tone}`}>{s.verdict.text}</p>
      {s.after.length > 0 && <><h4>손님이 답을 받은 뒤</h4><ol>{s.after.map((l, i) => <li key={i} className={`tone-${l.tone}`}><time className="mono">{clockOf(t.startUs, l.atUs)}</time><span>{l.text}</span></li>)}</ol></>}
      {s.insights.map((x) => <p key={x} className="insight"><Lightbulb size={15} aria-hidden /><span>{x}</span></p>)}
      <button onClick={() => onOpen(t.traceId)}><ListTree size={14} aria-hidden />타임라인으로 보기</button>
    </section>
  )
}
