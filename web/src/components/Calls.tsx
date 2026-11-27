import { Badge, clock, ms, nodeName, obsLabel, peerLabel, resultLabel } from '../format'
import type { Edge, Trace } from '../types'
import { callName } from './Timeline'

const MAX = 300

export function Calls({ traces, edges, focusId, onPick }: { traces: Trace[]; edges: Edge[]; focusId: string | null; onPick: (id: string) => void }) {
  const rows = [...traces].reverse().flatMap((t) => t.spans.filter((s) => s.kind === 'client').map((s) => ({ t, s }))).slice(0, MAX)
  if (!rows.length) return <div className="empty">아직 관측된 요청이 없습니다. 실험을 시작하고 요청을 보내면 호출이 한 줄씩 쌓입니다.</div>
  return (
    <div className="tablewrap">
      <table>
        <thead><tr><th>발생 시각</th><th>출발</th><th>도착</th><th>요청 / 시도</th><th>결과</th><th className="r">소요 시간</th><th>관측</th><th>trace ID</th><th>오류 요약</th></tr></thead>
        <tbody>
          {rows.map(({ t, s }) => {
            const e = edges.find((x) => x.id === s.edge)
            const root = s.service === 'generator'
            const status = s.attrs?.['http.response.status_code']
            return (
              <tr key={s.spanId} className={`${t.traceId === focusId ? 'sel' : ''} ${root ? 'root' : ''}`} tabIndex={0} onClick={() => onPick(t.traceId)} onKeyDown={(ev) => ev.key === 'Enter' && onPick(t.traceId)}>
                <td className="mono">{clock(s.startUs)}</td>
                <td>{nodeName[s.service] ?? s.service}</td>
                <td>{e ? nodeName[e.to] ?? e.to : '-'}</td>
                <td>{root ? `요청 #${t.seq}${t.kind === 'repeat' ? ' (반복)' : ''}` : <span className="sub">#{t.seq} {callName(s)}</span>}</td>
                <td><Badge label={resultLabel[s.result]} extra={s.result === 'http_error' ? status : undefined} /></td>
                <td className="r mono">{s.endUs ? ms(s.endUs - s.startUs) : ''}</td>
                <td>{root ? <Badge label={obsLabel[t.observation]} /> : <span className="sub">{s.peer ? peerLabel[s.peer] : ''}</span>}</td>
                <td className="mono sub" title={t.traceId}>{t.traceId.slice(0, 8)}</td>
                <td className="err" title={s.error}>{s.error}{s.faultIds?.length ? <span className="faultchip">장애 구간</span> : null}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
