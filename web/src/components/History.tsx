import { CircleCheck, FolderOpen, TriangleAlert, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { clock, dateTime, faultText, ms, reasonLabel, seconds } from '../format'
import type { Run, RunDetail, Settings } from '../types'

interface Props { refresh: string; onOpen: (d: RunDetail) => void; onLoad: (s: Settings, label: string) => void; onError: (m: string) => void }

export function History({ refresh, onOpen, onLoad, onError }: Props) {
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [details, setDetails] = useState<Record<string, RunDetail>>({})
  useEffect(() => { api.runs().then(setRuns).catch((e) => { setRuns([]); onError(e.message) }) }, [refresh])
  useEffect(() => {
    let alive = true
    for (const id of picked) api.run(id).then((d) => alive && setDetails((m) => ({ ...m, [id]: d }))).catch((e) => onError(e.message))
    return () => { alive = false }
  }, [picked, refresh])

  if (!runs) return <div className="empty">이력을 불러오는 중입니다.</div>
  if (!runs.length) return <div className="empty">저장된 실행이 없습니다. 실험을 시작하면 조건과 결과가 여기에 남습니다.</div>
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]))
  const shown = picked.map((id) => details[id]).filter(Boolean)
  return (
    <div className="split">
      <div className="tablewrap">
        <table>
          <thead><tr><th>비교</th><th>실행 시각</th><th>이름</th><th>기간</th><th>조건</th><th className="r">요청</th><th className="r">실패</th><th className="r">p50</th><th className="r">p95</th><th>종료</th><th>정리</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className={picked.includes(r.id) ? 'sel' : ''} onClick={() => toggle(r.id)}>
                <td><input type="checkbox" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} onClick={(e) => e.stopPropagation()} aria-label={`${r.label || r.id} 비교 선택`} /></td>
                <td className="mono">{dateTime(r.startedUs)}</td>
                <td>{r.label || <span className="sub">이름 없음</span>}</td>
                <td>{r.status === 'ended' ? seconds(r.endedUs - r.startedUs) : '실행 중'}</td>
                <td className="sub">타임아웃 {r.settings.callTimeoutMs}ms, 시도 {r.settings.maxAttempts}, B {r.settings.workMs}ms</td>
                <td className="r mono">{r.summary.total}</td><td className="r mono">{r.summary.failed}</td>
                <td className="r mono">{r.summary.p50Us ? ms(r.summary.p50Us) : '-'}</td><td className="r mono">{r.summary.p95Us ? ms(r.summary.p95Us) : '-'}</td>
                <td>{r.status === 'ended' ? reasonLabel[r.endReason ?? ''] ?? r.endReason : '-'}</td>
                <td>{r.cleanup ? r.cleanup.verified ? <span className="badge tone-ok"><CircleCheck size={13} aria-hidden />확인</span> : <span className="badge tone-bad"><TriangleAlert size={13} aria-hidden />미확인</span> : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="timeline">
        {shown.length === 0 && <div className="empty">실행을 하나 고르면 상세가, 두 개를 고르면 비교가 나옵니다.</div>}
        {shown.length === 1 && <Detail d={shown[0]} onOpen={onOpen} onLoad={onLoad} />}
        {shown.length === 2 && <Compare a={shown[0]} b={shown[1]} />}
      </section>
    </div>
  )
}

function Detail({ d, onOpen, onLoad }: { d: RunDetail; onOpen: Props['onOpen']; onLoad: Props['onLoad'] }) {
  return (
    <div className="tlscroll pad">
      <div className="tlhead flush"><b>{d.run.label || '이름 없는 실행'}</b><span className="grow" />
        <button onClick={() => onLoad(d.run.settings, d.run.label)}><Upload size={14} aria-hidden />이 조건 불러오기</button>
        <button className="primary" onClick={() => onOpen(d)}><FolderOpen size={14} aria-hidden />요청 흐름 보기</button></div>
      {d.run.cleanup && <p className="note">정리 결과: {d.run.cleanup.detail}</p>}
      <h4>장애 적용 내역</h4>
      {d.faults.length ? <ul className="faultlog">{d.faults.map((f) => (
        <li key={f.id}><b>{faultText(f)}</b><span>적용 {f.appliedUs ? clock(f.appliedUs) : '안 됨'}, 제거 {f.removedUs ? clock(f.removedUs) : '미확인'} ({reasonLabel[f.endReason ?? ''] ?? '-'})</span>
          {f.recoveryUs ? <small>제거 확인 후 새로 보낸 첫 성공까지 {ms(f.recoveryUs)}</small> : null}</li>))}</ul> : <p className="note">장애를 적용하지 않은 실행입니다.</p>}
      <h4>실행 기록</h4>
      <ol className="logs">{d.events.map((e) => <li key={e.id}><time className="mono">{clock(e.atUs)}</time>{e.detail}</li>)}</ol>
    </div>
  )
}

function Compare({ a, b }: { a: RunDetail; b: RunDetail }) {
  if (a.run.startedUs > b.run.startedUs) [a, b] = [b, a]
  const faults = (d: RunDetail) => d.faults.map(faultText).join(', ') || '없음'
  const rec = (d: RunDetail) => d.faults.filter((f) => f.recoveryUs).map((f) => ms(f.recoveryUs)).join(', ') || '-'
  const rate = (d: RunDetail) => { const n = d.run.summary.ok + d.run.summary.failed; return n ? `${((d.run.summary.failed / n) * 100).toFixed(1)}%` : '-' }
  const n = (f: (d: RunDetail) => number, unit: (v: number) => string = String): [string, string, string] => {
    const diff = f(b) - f(a)
    return [unit(f(a)), unit(f(b)), diff === 0 ? '같음' : `${diff > 0 ? '+' : '-'}${unit(Math.abs(diff))}`]
  }
  const t = (f: (d: RunDetail) => string): [string, string, string] => [f(a), f(b), f(a) === f(b) ? '같음' : '다름']
  const groups: [string, [string, [string, string, string]][]][] = [
    ['조건', [
      ['시도별 타임아웃', n((d) => d.run.settings.callTimeoutMs, (v) => `${v}ms`)], ['최대 시도', n((d) => d.run.settings.maxAttempts)],
      ['재시도 대기', n((d) => d.run.settings.backoffMs, (v) => `${v}ms`)], ['요청자 타임아웃', n((d) => d.run.settings.clientTimeoutMs, (v) => `${v}ms`)],
      ['B 처리 시간', n((d) => d.run.settings.workMs, (v) => `${v}ms`)], ['적용한 장애', t(faults)],
    ]],
    ['결과', [
      ['요청 수', n((d) => d.run.summary.total)], ['실패', n((d) => d.run.summary.failed)], ['실패율 (취소 제외)', t(rate)], ['취소', n((d) => d.run.summary.canceled)],
      ['응답 p50', n((d) => d.run.summary.p50Us, ms)], ['응답 p95', n((d) => d.run.summary.p95Us, ms)], ['응답 최대', n((d) => d.run.summary.maxUs, ms)],
      ['B 호출 시도', n((d) => d.run.summary.attempts)], ['재시도', n((d) => d.run.summary.retries)], ['호출 타임아웃', n((d) => d.run.summary.callTimeouts)],
      ['장애 제거 후 첫 성공', t(rec)], ['관측 누락 / 판단 불가', n((d) => d.run.summary.obsIncomplete)],
    ]],
  ]
  return (
    <div className="tlscroll pad">
      <table className="cmp">
        <thead><tr><th /><th>{a.run.label || '이름 없음'}<small>{dateTime(a.run.startedUs)}</small></th><th>{b.run.label || '이름 없음'}<small>{dateTime(b.run.startedUs)}</small></th><th>변화</th></tr></thead>
        {groups.map(([g, items]) => (
          <tbody key={g}>
            <tr className="grp"><th colSpan={4}>{g}</th></tr>
            {items.map(([k, v]) => <tr key={k} className={v[2] === '같음' ? '' : 'diff'}><th>{k}</th><td>{v[0]}</td><td>{v[1]}</td><td>{v[2]}</td></tr>)}
          </tbody>
        ))}
      </table>
      <p className="note">응답 시간은 취소하지 않은 완료 요청 전체(실패 포함)의 값입니다. 요청 수가 다르면 단순 비교에 주의하세요.</p>
    </div>
  )
}
