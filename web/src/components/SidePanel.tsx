import { CircleCheck, ShieldAlert, TriangleAlert, X, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Badge, clock, faultKind, faultState, faultText, ms, nodeName, reasonLabel, resultLabel, routeLabel, seconds } from '../format'
import type { Fault, FaultInput, FaultType, LabState, Selection, Settings, Target, Trace } from '../types'
import { Num } from './Field'
import { edgeStat } from './Topology'

interface Props {
  live: LabState; traces: Trace[]; faults: Fault[]; past: boolean; selection: Selection; onSelect: (s: Selection) => void
  settings: Settings; setSettings: (s: Settings) => void; label: string; setLabel: (s: string) => void; limitSec: number; setLimitSec: (n: number) => void
  nowUs: number; act: (fn: () => Promise<unknown>) => void; busy: boolean; onTrace: (id: string) => void
  preset: FaultInput | null // 학습 과정이 권하는 장애 값
}

export function SidePanel(p: Props) {
  return (
    <aside className="side">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={!p.selection} onClick={() => p.onSelect(null)}>실험 조건</button>
        <button role="tab" aria-selected={!!p.selection} disabled={!p.selection} onClick={() => undefined}>선택 대상</button>
        {p.selection && <button className="icon" aria-label="선택 해제" onClick={() => p.onSelect(null)}><X size={15} /></button>}
      </div>
      <div className="sidebody">
        {!p.selection ? <Conditions {...p} /> : p.selection.type === 'edge' ? <EdgeDetail {...p} id={p.selection.id} /> : <NodeDetail {...p} id={p.selection.id} />}
      </div>
    </aside>
  )
}

function Conditions({ live, settings, setSettings, label, setLabel, limitSec, setLimitSec }: Props) {
  const running = live.run?.status !== undefined && live.run.status !== 'ended'
  const s = running ? live.run!.settings : settings
  const set = (k: keyof Settings) => (n: number) => setSettings({ ...settings, [k]: n })
  return (
    <>
      <p className="lead">{running ? '실행 중에는 조건이 고정됩니다. 바꾸려면 실험을 종료하고 다시 시작하세요.' : '이 조건으로 실험을 시작합니다. 조건은 실행 이력에 함께 저장되어 비교할 수 있습니다.'}</p>
      <label className="num wide"><span>실험 이름</span>
        <input value={running ? live.run!.label : label} maxLength={60} disabled={running} placeholder="예: 재시도 2회" onChange={(e) => setLabel(e.target.value)} /></label>
      <h3>요청자</h3>
      <div className="grid2">
        <Num label="전체 타임아웃 ms" value={s.clientTimeoutMs} min={100} max={20000} step={100} disabled={running} onChange={set('clientTimeoutMs')} hint="A 응답을 기다리는 한도" />
        <Num label="실험 시간 제한 초" value={running ? live.run!.limitSec : limitSec} min={10} max={live.limits.maxRunSec} step={10} disabled={running} onChange={setLimitSec} hint="지나면 자동 종료" />
      </div>
      <h3>Service A의 B 호출</h3>
      <div className="grid2">
        <Num label="시도별 타임아웃 ms" value={s.callTimeoutMs} min={50} max={10000} step={50} disabled={running} onChange={set('callTimeoutMs')} />
        <Num label="최대 시도 횟수" value={s.maxAttempts} min={1} max={4} disabled={running} onChange={set('maxAttempts')} hint="1이면 재시도 없음" />
        <Num label="재시도 대기 ms" value={s.backoffMs} min={0} max={2000} step={50} disabled={running} onChange={set('backoffMs')} />
      </div>
      <h3>Service B</h3>
      <div className="grid2"><Num label="처리 시간 ms" value={s.workMs} min={0} max={3000} step={5} disabled={running} onChange={set('workMs')} hint="B가 실제로 대기하는 시간" /></div>
      <p className="note">요청 한도: 동시 {live.limits.maxInFlight}개, 실험당 {live.limits.maxRequestsPerRun.toLocaleString()}개. 서비스 사이 연결은 시도마다 새로 맺습니다.</p>
      {live.storeError && <p className="warnbox"><TriangleAlert size={15} aria-hidden />이력 저장 오류: {live.storeError}</p>}
    </>
  )
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="kv"><dt>{k}</dt><dd>{children}</dd></div>
}

function Recent({ traces, pick, onTrace }: { traces: Trace[]; pick: (t: Trace) => { text: string; result: keyof typeof resultLabel; us: number }[]; onTrace: (id: string) => void }) {
  const rows = [...traces].reverse().flatMap((t) => pick(t).map((r) => ({ ...r, t }))).slice(0, 6)
  if (!rows.length) return <p className="note">이 실행에서 관측된 호출이 없습니다.</p>
  return (
    <ul className="recent">
      {rows.map((r, i) => (
        <li key={i}><button onClick={() => onTrace(r.t.traceId)}><span>#{r.t.seq} {r.text}</span><Badge label={resultLabel[r.result]} /><span className="mono">{r.us > 0 ? ms(r.us) : ''}</span></button></li>
      ))}
    </ul>
  )
}

function NodeDetail(p: Props & { id: string }) {
  const n = p.live.topology.nodes.find((x) => x.id === p.id)!
  const svc = p.live.services.find((s) => s.service === p.id)
  const kind = p.id === 'generator' ? 'client' : 'server'
  return (
    <>
      <h2>{n.name}</h2>
      <p className="lead">{n.role}</p>
      <dl>
        <Row k="주소"><span className="mono">{n.addr}</span></Row>
        {svc && <>
          <Row k="서비스 응답">{svc.health === 'up' ? '정상' : svc.health === 'down' ? '응답 없음' : '확인 전'} <small>{svc.healthCheckedUs > 0 && clock(svc.healthCheckedUs)}</small></Row>
          {svc.healthError && <Row k="확인 오류"><span className="mono small">{svc.healthError}</span></Row>}
          <Row k="관측 수신">{svc.telemetry === 'ok' ? '수신 중' : svc.telemetry === 'stale' ? '끊김' : '수신 전'} <small>{svc.lastTelemetryUs > 0 && clock(svc.lastTelemetryUs)}</small></Row>
          <Row k="내보내기 오류">{svc.exportErrors}회</Row>
        </>}
      </dl>
      {svc && svc.health === 'up' && svc.telemetry !== 'ok' && <p className="warnbox"><TriangleAlert size={15} aria-hidden />서비스는 응답하지만 관측 데이터가 오지 않습니다. 서비스 장애가 아니라 관측 경로 문제입니다.</p>}
      {svc && <p className="note">서비스 응답은 실험 구간을 거치지 않는 별도 경로로 확인합니다.</p>}
      {p.id === 'service-b' && <FaultControl {...p} target={{ node: p.id }} />}
      <h3>관련 요청</h3>
      <Recent traces={p.traces} onTrace={p.onTrace} pick={(t) => t.spans.filter((s) => s.service === p.id && s.kind === kind).map((s) => ({ text: kind === 'client' ? '요청' : '처리', result: s.result, us: s.endUs ? s.endUs - s.startUs : 0 }))} />
    </>
  )
}

function EdgeDetail(p: Props & { id: string }) {
  const e = p.live.topology.edges.find((x) => x.id === p.id)!
  const st = edgeStat(p.traces, e.id)
  const errs = p.traces.flatMap((t) => t.spans.filter((s) => s.edge === e.id && s.error)).slice(-3).reverse()
  return (
    <>
      <h2>{nodeName[e.from]} <span aria-hidden>→</span> {nodeName[e.to]}</h2>
      {e.proxy ? <FaultControl {...p} target={{ edge: e.id }} /> : <p className="note">이 연결은 프록시를 거치지 않아 장애를 넣을 수 없습니다.</p>}
      <h3>통신 현황</h3>
      <dl>
        <Row k="프로토콜">{e.protocol}</Row>
        <Row k="관측된 호출">{st.total ? `${st.total}회 (성공 ${st.ok}, 실패 ${st.fail})` : '없음 (연결이 없다는 뜻은 아님)'}</Row>
        <Row k="최근 소요 시간">{st.last ? ms(st.last.endUs - st.last.startUs) : '-'}</Row>
        <Row k="최근 호출 경로">{st.last?.route ? routeLabel[st.last.route] : '-'}</Row>
        {e.proxy && <>
          <Row k="실제 경로"><span className="mono small">A {'>'} {e.proxy.listen} {'>'} {e.proxy.upstream}</span></Row>
          <Row k="프록시"><span className="mono small">{e.proxy.name}</span> <small>{!p.live.proxy.reachable ? '연결 안 됨' : p.live.proxy.enabled ? '켜짐' : '꺼짐'}, toxic {p.live.proxy.toxics?.length ?? 0}개</small></Row>
          <Row k="영향 범위">{e.proxy.edges.length === 1 ? '이 연결만' : `연결 ${e.proxy.edges.length}개가 공유`}. 이 프록시를 지나는 모든 요청에 적용됩니다.</Row>
        </>}
      </dl>
      {st.last?.route === 'bypassed' && <p className="warnbox"><ShieldAlert size={15} aria-hidden />최근 호출이 프록시를 거치지 않았습니다. 이 호출에는 장애가 적용되지 않았습니다.</p>}
      {errs.length > 0 && <><h3>최근 오류</h3><ul className="errs">{errs.map((s) => <li key={s.spanId}><time className="mono">{clock(s.endUs)}</time>{s.error}</li>)}</ul></>}
    </>
  )
}

const EDGE_TYPES: FaultType[] = ['latency', 'cut', 'blackhole', 'reset']
const NODE_TYPES: FaultType[] = ['error', 'overload']

function FaultControl(p: Props & { target: Target }) {
  const node = 'node' in p.target ? p.target.node : undefined
  const edge = 'edge' in p.target ? p.target.edge : undefined
  const types = node ? NODE_TYPES : EDGE_TYPES
  const [type, setType] = useState<FaultType>(types[0])
  const [direction, setDirection] = useState<'request' | 'response'>('response')
  const [latency, setLatency] = useState(300)
  const [jitter, setJitter] = useState(0)
  const [percent, setPercent] = useState(50)
  const [slots, setSlots] = useState(1)
  const [work, setWork] = useState(600)
  const [ttl, setTtl] = useState(60)
  const mine = (f: FaultInput) => (node ? f.node === node : f.edge === edge)
  useEffect(() => {
    const v = p.preset
    if (!v || !mine(v)) return
    setType(v.type); setJitter(v.jitterMs ?? 0)
    if (v.direction) setDirection(v.direction)
    if (v.latencyMs) setLatency(v.latencyMs)
    if (v.percent) setPercent(v.percent)
    if (v.slots) setSlots(v.slots)
    if (v.workMs) setWork(v.workMs)
    setTtl(v.ttlSec)
  }, [p.preset])
  const { limits } = p.live
  const over = ['removed', 'apply_failed']
  const cur = p.live.faults.find((f) => mine(f) && !over.includes(f.state))
  const done = p.faults.filter((f) => mine(f) && over.includes(f.state)).slice(-3).reverse()
  const running = p.live.run?.status === 'running'
  const s = running ? p.live.run!.settings : p.settings
  const Cur = cur && faultKind[cur.type].icon
  return (
    <>
      <h3>장애</h3>
      {cur && Cur ? (
        <div className="faultcard">
          <b><Cur size={15} aria-hidden />{faultText(cur)}</b>
          <span>{faultState[cur.state]}{cur.state === 'active' && `, ${seconds(cur.expiresUs - p.nowUs)} 뒤 자동 해제`}</span>
          {cur.appliedUs > 0 && <small>{node ? '요청에 싣기 시작' : '프록시 적용 확인'} {clock(cur.appliedUs)}</small>}
          {cur.cleanup && !cur.cleanup.verified && <small className="alert">{cur.cleanup.detail}</small>}
          <button data-c="remove" disabled={p.busy || cur.state === 'applying' || cur.state === 'removing'} onClick={() => p.act(() => api.removeFault(cur.id))}><X size={15} aria-hidden />장애 제거</button>
        </div>
      ) : (
        <div className="faultform">
          <div className={`seg ${types.length > 2 ? 'two' : ''}`} role="radiogroup" aria-label="장애 유형">
            {types.map((t) => {
              const Icon = faultKind[t].icon
              return <button key={t} role="radio" aria-checked={type === t} onClick={() => setType(t)}><Icon size={14} aria-hidden />{faultKind[t].name}</button>
            })}
          </div>
          <p className="note">{faultKind[type].about}</p>
          {type === 'latency' && <>
            <div className="seg" role="radiogroup" aria-label="지연 방향">
              <button role="radio" aria-checked={direction === 'request'} onClick={() => setDirection('request')}>요청 방향 (A에서 B)</button>
              <button role="radio" aria-checked={direction === 'response'} onClick={() => setDirection('response')}>응답 방향 (B에서 A)</button>
            </div>
            <div className="grid2">
              <Num label="지연 ms" value={latency} min={1} max={limits.maxLatencyMs} step={100} onChange={(n) => { setLatency(n); if (jitter > n) setJitter(n) }} />
              <Num label="흔들림 ±ms" value={jitter} min={0} max={latency} step={10} onChange={setJitter} />
            </div>
            <p className="note">{latency + jitter >= s.callTimeoutMs ? `A의 시도별 타임아웃 ${s.callTimeoutMs}ms를 넘을 수 있는 값입니다.` : `A의 시도별 타임아웃은 ${s.callTimeoutMs}ms입니다.`}</p>
          </>}
          {type === 'blackhole' && <p className="note">A는 시도마다 {s.callTimeoutMs}ms를 기다린 뒤 포기합니다.</p>}
          {type === 'error' && <>
            <Num label="오류 비율 %" value={percent} min={1} max={100} step={10} onChange={setPercent} />
            <p className="note">{s.maxAttempts > 1 ? `A는 실패하면 최대 ${s.maxAttempts}번까지 다시 시도합니다.` : 'A는 재시도하지 않는 조건입니다.'}</p>
          </>}
          {type === 'overload' && <>
            <div className="grid2">
              <Num label="동시 처리 수" value={slots} min={1} max={limits.maxInFlight} onChange={setSlots} />
              <Num label="건당 처리 ms" value={work} min={1} max={3000} step={100} onChange={setWork} />
            </div>
            <p className="note">B는 초당 약 {((slots * 1000) / work).toFixed(1)}개까지 처리합니다. 그보다 빨리 들어오면 줄이 생깁니다.</p>
          </>}
          <Num label="자동 해제 초" value={ttl} min={limits.minFaultTtlSec} max={limits.maxFaultTtlSec} step={5} onChange={setTtl} />
          <button className="inject" data-c="apply" disabled={!running || p.busy}
            onClick={() => p.act(() => api.applyFault({ ...(node ? { node } : { edge }), type, direction, latencyMs: latency, jitterMs: jitter, percent, slots, workMs: work, ttlSec: ttl }))}><Zap size={15} aria-hidden />장애 적용</button>
          {!running && <p className="note">실험을 시작하면 적용할 수 있습니다.</p>}
          {node && <p className="note">서비스 장애는 요청에 실어 보내고 B가 실제로 그렇게 동작합니다. 적용한 뒤 보내는 요청부터 해당됩니다.</p>}
        </div>
      )}
      {done.length > 0 && <>
        <h3>이 실행의 장애 기록</h3>
        <ul className="faultlog">
          {done.map((f) => (
            <li key={f.id}>
              <b>{faultText(f)}</b>
              <span>{f.state === 'removed' ? <><CircleCheck size={13} aria-hidden />제거 확인 ({reasonLabel[f.endReason ?? ''] ?? f.endReason})</> : <><TriangleAlert size={13} aria-hidden />적용 실패</>}</span>
              {f.recoveryUs ? <small>제거 확인 후 새로 보낸 첫 성공까지 {ms(f.recoveryUs)}</small> : f.state === 'removed' && <small>제거 후 성공한 요청이 아직 없음</small>}
            </li>
          ))}
        </ul>
      </>}
    </>
  )
}
