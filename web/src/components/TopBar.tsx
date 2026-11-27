import { OctagonX, Play, Repeat2, Send, Square, Waypoints, WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { reasonLabel, seconds } from '../format'
import type { Burst } from '../lessons'
import type { LabState } from '../types'
import { Num } from './Field'

interface Props { live: LabState; connected: boolean; nowUs: number; act: (fn: () => Promise<unknown>) => void; onStart: () => void; onEmergency: () => void; busy: boolean; burst: Burst | null }

export function TopBar({ live, connected, nowUs, act, onStart, onEmergency, busy, burst }: Props) {
  const [count, setCount] = useState(20)
  const [interval, setInterval] = useState(300)
  const [conc, setConc] = useState(2)
  // 학습 과정이 권하는 값으로 채운다.
  useEffect(() => { if (burst) { setCount(burst.count); setInterval(burst.intervalMs); setConc(burst.concurrency) } }, [burst])
  const { run, repeat, limits } = live
  const running = run?.status === 'running'
  const ending = run?.status === 'ending'
  return (
    <header className="topbar">
      <div className="brand"><Waypoints size={20} aria-hidden /><div><strong>BreakLab</strong><span>서비스 장애 실험실</span></div></div>
      <div className="runstate" role="status">
        <span className={`lamp ${running ? 'on' : ''}`} aria-hidden />
        <div>
          <b>{running ? '실험 실행 중' : ending ? '종료 처리 중' : run ? `실험 종료됨 (${reasonLabel[run.endReason ?? ''] ?? run.endReason})` : '실험 대기'}</b>
          <span>
            {running ? `${run.label || '이름 없음'}, ${seconds(run.startedUs + run.limitSec * 1e6 - nowUs)} 남음` : run?.cleanup ? (run.cleanup.verified ? '장애 정리 확인됨' : '장애 정리 미확인') : '조건을 정하고 시작하세요'}
          </span>
        </div>
      </div>
      <div className="controls">
        {running || ending
          ? <button data-c="end" onClick={() => act(api.endRun)} disabled={ending || busy}><Square size={15} aria-hidden />실험 종료</button>
          : <button className="primary" data-c="start" onClick={onStart} disabled={busy || !connected}><Play size={15} aria-hidden />실험 시작</button>}
        <button className={running ? 'primary' : ''} data-c="send" disabled={!running || busy} onClick={() => act(api.send)}><Send size={15} aria-hidden />요청 1회</button>
        <div className="repeat" aria-label="반복 요청">
          <Num label="횟수" value={count} min={1} max={limits.maxRepeatCount} onChange={setCount} disabled={repeat.active} />
          <Num label="간격 ms" value={interval} min={limits.minIntervalMs} max={limits.maxIntervalMs} step={100} onChange={setInterval} disabled={repeat.active} />
          <Num label="동시" value={conc} min={1} max={limits.maxInFlight} onChange={setConc} disabled={repeat.active} />
          {repeat.active
            ? <button onClick={() => act(api.stopRepeat)}><Square size={15} aria-hidden />요청 발생 중지 {repeat.sent}/{repeat.count}</button>
            : <button data-c="repeat" disabled={!running || busy} onClick={() => act(() => api.startRepeat(count, interval, conc))}><Repeat2 size={15} aria-hidden />반복 요청</button>}
        </div>
      </div>
      {!connected && <span className="badge tone-bad"><WifiOff size={13} aria-hidden />실시간 연결 끊김, 다시 연결 중</span>}
      <button className="emergency" onClick={onEmergency}><OctagonX size={17} aria-hidden />비상 중지</button>
    </header>
  )
}
