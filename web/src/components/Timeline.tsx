import { Play, X } from 'lucide-react'
import { useState } from 'react'
import { replaySpan } from '../anim'
import { Badge, clock, faultText, ms, nodeName, obsLabel, peerLabel, resultLabel, routeLabel } from '../format'
import { EDGE_TO, meta } from '../meta'
import type { Fault, Span, Trace } from '../types'

interface Props { trace: Trace; faults: Fault[]; playUs: number | null; replaying: boolean; onReplay: () => void; onClose: () => void }

interface Row { key: string; depth: number; label: string; span?: Span; ghost?: string; startUs: number; endUs: number }

function rows(t: Trace, horizon: number): Row[] {
  const out: Row[] = []
  const add = (s: Span, depth: number) => {
    const to = meta(EDGE_TO[s.edge ?? '']).short
    const label = s.service === 'generator' ? '요청 발생기' : s.kind === 'client' ? `${meta(s.service).short}의 ${to} 호출 ${callName(s)}` : `${nodeName[s.service] ?? s.service} 처리`
    out.push({ key: s.spanId, depth, label, span: s, startUs: s.startUs, endUs: s.endUs || horizon })
    const kids = t.spans.filter((c) => c.parentId === s.spanId)
    kids.forEach((c) => add(c, depth + 1))
    if (s.kind === 'client' && s.peer && s.peer !== 'observed') {
      out.push({ key: `${s.spanId}-peer`, depth: depth + 1, label: `${meta(EDGE_TO[s.edge ?? '']).name} ${s.peer === 'not_sent' ? '미도달' : '관측 안 됨'}`, ghost: peerLabel[s.peer], startUs: s.startUs, endUs: s.endUs || horizon })
    }
  }
  const ids = new Set(t.spans.map((s) => s.spanId))
  t.spans.filter((s) => !s.parentId || !ids.has(s.parentId)).forEach((s) => add(s, 0))
  return out
}

export function Timeline({ trace: t, faults, playUs, replaying, onReplay, onClose }: Props) {
  const [hover, setHover] = useState<string | null>(null)
  const r = replaySpan(t)
  const open = t.spans.some((s) => s.endUs === 0)
  const total = Math.max(1000, r.endUs - r.startUs)
  const x = (us: number) => Math.min(100, Math.max(0, ((us - r.startUs) / total) * 100))
  const list = rows(t, r.endUs)
  const step = niceStep(total / 1000)
  const ticks = Array.from({ length: Math.floor(total / 1000 / step) + 1 }, (_, i) => i * step)
  const bands = faults.filter((f) => f.appliedUs > 0 && f.appliedUs < r.endUs && (f.removedUs === 0 || f.removedUs > r.startUs))
  const logs = t.spans.flatMap((s) => (s.events ?? []).map((e) => ({ ...e, s }))).sort((a, b) => a.atUs - b.atUs)
  const h = hover ? list.find((l) => l.key === hover) : undefined
  return (
    <section className="timeline" aria-label="요청 상세 타임라인">
      <div className="tlhead">
        <b>요청 #{t.seq}</b><Badge label={resultLabel[t.result]} extra={t.httpStatus ? String(t.httpStatus) : undefined} /><Badge label={obsLabel[t.observation]} />
        <span className="mono">{t.endUs ? ms(t.endUs - t.startUs) : '진행 중'}</span>
        <span className="grow" />
        <button disabled={open || replaying} onClick={onReplay} title="측정된 시각을 일정 비율로 늘려 토폴로지에서 다시 보여 줍니다"><Play size={14} aria-hidden />경로 다시 보기</button>
        <button className="icon" aria-label="타임라인 닫기" onClick={onClose}><X size={15} /></button>
      </div>
      {replaying && <p className="replaynote">다시 보기 중: 실제 {ms(r.endUs - r.startUs)}를 화면 {(r.uiMs / 1000).toFixed(1)}초로 표시 ({r.scale >= 1.05 ? `${r.scale.toFixed(r.scale < 10 ? 1 : 0)}배 느리게` : r.scale <= 0.95 ? `${(1 / r.scale).toFixed(1)}배 빠르게` : '실제 속도'})</p>}
      <div className="tlscroll">
        <div className="tlgrid">
          <div className="tlabels"><div className="axis" />{list.map((l) => <div key={l.key} className="tlabel" style={{ paddingLeft: 4 + l.depth * 10 }}>{l.label}</div>)}</div>
          <div className="tplot" onMouseLeave={() => setHover(null)}>
            <div className="axis">{ticks.map((v) => <span key={v} style={{ left: `${(v * 1000 / total) * 100}%` }}>{v >= 1000 ? `${v / 1000}s` : `${v}ms`}</span>)}</div>
            <div className="lines">{ticks.map((v) => <i key={v} style={{ left: `${(v * 1000 / total) * 100}%` }} />)}</div>
            {bands.map((f) => (
              <div key={f.id} className="band" style={{ left: `${x(f.appliedUs)}%`, width: `${(f.removedUs ? x(f.removedUs) : 100) - x(f.appliedUs)}%` }} title={`${faultText(f)} 적용 구간`}>
                {f.appliedUs > r.startUs && <em className="edge-on">적용</em>}{f.removedUs > 0 && f.removedUs < r.endUs && <em className="edge-off">제거</em>}
              </div>
            ))}
            {list.map((l) => (
              <div key={l.key} className="trow" onMouseEnter={() => setHover(l.key)}>
                <div tabIndex={0} onFocus={() => setHover(l.key)} aria-label={`${l.label} ${l.ghost ?? resultLabel[l.span!.result].text}`}
                  className={`bar ${l.ghost ? 'ghost' : `tone-${resultLabel[l.span!.result].tone}`} ${l.span && !l.span.endUs ? 'open' : ''}`} style={{ left: `${x(l.startUs)}%`, width: `max(3px, ${x(l.endUs) - x(l.startUs)}%)` }}>
                  {l.span?.events?.map((e, i) => <u key={i} style={{ left: `${l.endUs > l.startUs ? ((e.atUs - l.startUs) / (l.endUs - l.startUs)) * 100 : 0}%` }} />)}
                </div>
                <span className={`bartext ${x(l.endUs) > 62 ? 'inside' : ''}`} style={x(l.endUs) > 62 ? { right: `${100 - x(l.endUs)}%` } : { left: `${x(l.endUs)}%` }}>
                  {l.ghost ?? `${resultLabel[l.span!.result].text} ${l.span!.endUs ? ms(l.endUs - l.startUs) : ''}`}
                </span>
              </div>
            ))}
            {playUs !== null && <div className="playhead" style={{ left: `${x(playUs)}%` }} />}
          </div>
        </div>
        <div className="tldetail">
          {h?.span ? (
            <dl className="inline">
              <div><dt>{h.label}</dt><dd>{clock(h.span.startUs)}부터 {h.span.endUs ? ms(h.span.endUs - h.span.startUs) : '종료 관측 대기'}</dd></div>
              {h.span.route && <div><dt>경로</dt><dd>{routeLabel[h.span.route]}</dd></div>}
              {h.span.attrs?.['lab.conn.remote'] && <div><dt>연결한 주소</dt><dd className="mono">{h.span.attrs['lab.conn.remote']}</dd></div>}
              {h.span.error && <div><dt>오류</dt><dd>{h.span.error}</dd></div>}
            </dl>
          ) : h?.ghost ? <p className="note">{h.label}: {h.ghost}</p> : <p className="note">막대에 마우스를 올리면 상세 정보가 나옵니다. 보라색 배경은 장애가 적용되어 있던 시간입니다.</p>}
        </div>
        {t.error && <p className="note">{t.error}</p>}
        {t.notes.map((n) => <p key={n} className="note strong">{n}</p>)}
        {bands.map((f) => <p key={f.id} className="note">장애 {faultText(f)}: 적용 확인 {clock(f.appliedUs)}{f.removedUs ? `, 제거 확인 ${clock(f.removedUs)}` : ', 적용 중'}</p>)}
        <h4>관련 로그 <small>각 서비스가 span에 남긴 기록</small></h4>
        <ol className="logs">
          {logs.map((l, i) => <li key={i}><time className="mono">+{ms(l.atUs - t.startUs)}</time><span>{nodeName[l.s.service] ?? l.s.service}{l.s.kind === 'client' && l.s.edge ? ` > ${meta(EDGE_TO[l.s.edge]).short} ${callName(l.s)}` : ''}</span>{l.name}{l.attrs?.ms ? ` ${l.attrs.ms}ms` : ''}</li>)}
          {!logs.length && <li>도착한 로그가 없습니다.</li>}
        </ol>
        <p className="note mono small">trace {t.traceId}</p>
      </div>
    </section>
  )
}

// 같은 연결에서 하는 일이 여럿이면 일의 이름을, 아니면 몇 번째 시도인지를 보여 준다.
export const callName = (s: Span) => ({ get: '찾기', set: '저장' } as Record<string, string>)[s.attrs?.['lab.op'] ?? ''] ?? `시도 ${s.attrs?.['lab.attempt'] ?? ''}`

function niceStep(totalMs: number): number {
  const raw = totalMs / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const n = raw / mag
  return Math.max(0.1, (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag)
}
