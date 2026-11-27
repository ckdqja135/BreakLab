import { CirclePause, CirclePlay, CircleCheck, GraduationCap, History as HistoryIcon, ListTree, TriangleAlert, Trophy, Undo2, UsersRound, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { LiveAnimator } from './anim'
import { api } from './api'
import { dateTime } from './format'
import type { RunDetail, Selection, Settings } from './types'
import { useLab, useNowUs } from './useLab'
import { Calls } from './components/Calls'
import { Coach, useCoach } from './components/Coach'
import { Impact } from './components/Impact'
import { QuestPanel, useQuest } from './components/Quest'
import { QUESTS } from './quests'
import { LESSONS, type Lesson } from './lessons'
import { History } from './components/History'
import { SidePanel } from './components/SidePanel'
import { Timeline } from './components/Timeline'
import { TopBar } from './components/TopBar'
import { Topology } from './components/Topology'

interface Toast { tone: 'ok' | 'bad'; text: string; sticky?: boolean }

export function App() {
  const animator = useRef(new LiveAnimator()).current
  const lab = useLab((t) => animator.push(t))
  const nowUs = useNowUs(lab.offsetUs)
  const [selection, setSelection] = useState<Selection>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [replaying, setReplaying] = useState(false)
  const [playUs, setPlayUs] = useState<number | null>(null)
  const [tab, setTab] = useState<'impact' | 'calls' | 'history'>('impact')
  const [past, setPast] = useState<RunDetail | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [label, setLabel] = useState('')
  const [limitSec, setLimitSec] = useState(600)
  const [mode, setMode] = useState<'learn' | 'quest'>('learn') // 왼쪽 아래 칸에 보일 것
  const [topic, setTopic] = useState<string | null>(null) // 고른 실험 주제. 처음에는 마지막 실험의 주제를 따른다
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)

  useEffect(() => { if (lab.live && !settings) setSettings({ ...lab.live.defaults, ...lab.live.run?.settings }) }, [lab.live, settings])
  useEffect(() => { if (lab.live && topic === null) setTopic(lab.live.run?.scenario || 'stock') }, [lab.live, topic])
  useEffect(() => {
    if (!toast || toast.sticky) return
    const id = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(id)
  }, [toast])
  const onError = useCallback((text: string) => setToast({ tone: 'bad', text }), [])
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try { await fn() } catch (e) { onError((e as Error).message) } finally { setBusy(false) }
  }

  // 과정을 시작할 때, 그리고 과정 중에 조건을 바꿔 다시 시작하는 단계(again)에서 주제와 조건을 맞춘다.
  const coach = useCoach(lab.live && { live: lab.live, traces: lab.live.traces, selection, focusId, tab }, nowUs, (l: Lesson, again) => {
    setPast(null); setFocusId(null); setReplaying(false); setPlayUs(null); setSelection(null); setTab('impact'); setTopic(l.topic)
    if (lab.live) setSettings({ ...lab.live.defaults, ...l.settings, ...again?.settings })
    setLabel(`학습 ${LESSONS.indexOf(l) + 1}. ${l.title}${again ? ' (방어 켬)' : ''}`)
  })

  // 도전 과제를 고르면 주제를 맞추고 조건을 처음 값으로 돌린다. 여기서부터 사용자가 조건을 바꾼다.
  const quest = useQuest(lab, settings, (q) => {
    setPast(null); setFocusId(null); setReplaying(false); setPlayUs(null); setSelection(null); setTab('impact'); setTopic(q.topic)
    if (lab.live) setSettings({ ...lab.live.defaults })
  })
  const hint = mode === 'learn' ? coach.hint : null

  const { live, shown } = lab
  if (!live || !shown || !settings || topic === null) return <div className="boot">{lab.connected ? '상태를 불러오는 중입니다.' : '관리 서버에 연결하는 중입니다. 서버가 실행 중인지 확인하세요.'}</div>

  // 화면에 그릴 주제: 과거 실행을 보는 중이면 그 실행의 주제, 실행 중이면 그 실험의 주제, 아니면 고른 주제
  const going = live.run && live.run.status !== 'ended'
  const topics = live.topology.scenarios
  const scenario = topics.find((s) => s.id === (past ? past.run.scenario || 'stock' : going ? live.run!.scenario : topic)) ?? topics[0]
  // 끝난 실험과 다른 주제를 고르면 그 실험의 요청은 새 그림에 맞지 않으므로 보여 주지 않는다.
  const stale = !past && !going && (shown.run?.scenario || 'stock') !== scenario.id
  const traces = past ? past.traces : stale ? [] : shown.traces
  const faults = past ? past.faults : stale ? [] : shown.faults
  const tall = scenario.nodes.some((n) => n.row === 0)
  const focus = traces.find((t) => t.traceId === focusId) ?? null
  const pickTrace = (id: string) => { setReplaying(false); setPlayUs(null); setFocusId((c) => (c === id ? null : id)); setTab('calls') }
  const closeFocus = () => { setFocusId(null); setReplaying(false); setPlayUs(null) }

  const emergency = async () => {
    try {
      const r = await api.emergency()
      setToast({ tone: r.cleanup.verified ? 'ok' : 'bad', sticky: true, text: `비상 중지 완료: 진행 중 요청 ${r.canceled}개 취소. ${r.cleanup.detail}` })
    } catch (e) { setToast({ tone: 'bad', sticky: true, text: `비상 중지 실패: ${(e as Error).message}` }) }
  }
  const start = () => act(async () => {
    setPast(null); closeFocus(); animator.clear()
    await api.startRun(label, scenario.id, settings, limitSec)
  })

  return (
    <div className={tall ? 'app tall' : 'app'} data-coach={hint ?? undefined}>
      <TopBar live={live} connected={lab.connected} nowUs={nowUs} act={act} busy={busy} onStart={start} onEmergency={emergency} burst={mode === 'learn' ? coach.burst : null} />
      <main className={past ? 'canvas pastview' : 'canvas'}>
        <div className="canvasbar">
          <button onClick={() => { animator.clear(); lab.setPaused(!lab.paused) }} aria-pressed={lab.paused}>
            {lab.paused ? <CirclePlay size={15} aria-hidden /> : <CirclePause size={15} aria-hidden />}{lab.paused ? '화면 갱신 다시 시작' : '화면 갱신 일시 정지'}
          </button>
          {lab.paused && <span className="badge tone-warn"><TriangleAlert size={13} aria-hidden />화면만 멈춤, 실제 요청은 계속됨 (밀린 변경 {lab.behind}건)</span>}
          {past && <span className="badge tone-live"><HistoryIcon size={13} aria-hidden />과거 실행 {past.run.label || '이름 없음'} {dateTime(past.run.startedUs)}<button className="link" onClick={() => { setPast(null); closeFocus() }}><Undo2 size={13} aria-hidden />현재 실험으로</button></span>}
          {Object.values(shown.proxies).some((x) => !x.reachable) && <span className="badge tone-bad"><TriangleAlert size={13} aria-hidden />장애 주입 프록시에 연결할 수 없음</span>}
          <span className="grow" />
          <span className="legend"><i className="l-obs" />관측된 연결<i className="l-cfg" />설정만 된 연결<i className="l-flt" />장애 적용</span>
        </div>
        <Topology state={shown} scenario={scenario} traces={traces} faults={faults} past={!!past} selection={selection} onSelect={setSelection} focus={focus} replay={replaying}
          onReplayTime={setPlayUs} onReplayEnd={() => setReplaying(false)} animator={animator} nowUs={nowUs} />
        <p className="caption">점 하나는 실제 호출 하나입니다. 빠른 호출은 보이도록 늦춰 그리므로 정확한 시간은 숫자와 타임라인을 보세요.</p>
      </main>
      <SidePanel live={live} traces={traces} faults={faults} past={!!past} selection={selection} onSelect={setSelection} settings={settings} setSettings={setSettings}
        label={label} setLabel={setLabel} limitSec={limitSec} setLimitSec={setLimitSec} nowUs={nowUs} act={act} busy={busy} onTrace={pickTrace} preset={mode === 'learn' ? coach.fault : null}
        scenario={scenario} setTopic={(id) => { setTopic(id); setSelection(null); closeFocus() }} />
      <section className="bottom">
        {coach.open && (
          <aside className="coach" aria-label="학습 과정과 도전 과제">
            <div className="modes" role="tablist">
              <button role="tab" aria-selected={mode === 'learn'} onClick={() => setMode('learn')}><GraduationCap size={15} aria-hidden />학습 과정</button>
              <button role="tab" aria-selected={mode === 'quest'} onClick={() => setMode('quest')}><Trophy size={15} aria-hidden />도전 과제</button>
              <span className="grow" />
              <button className="icon" aria-label="닫기" onClick={() => coach.setOpen(false)}><X size={15} /></button>
            </div>
            {mode === 'learn' ? <Coach c={coach} topics={topics} /> : <QuestPanel q={quest} topics={topics} />}
          </aside>
        )}
        <div className="bottommain">
        <div className="tabs" role="tablist">
          <button role="tab" data-c="tab-impact" aria-selected={tab === 'impact'} onClick={() => setTab('impact')}><UsersRound size={15} aria-hidden />손님 화면</button>
          <button role="tab" data-c="tab-calls" aria-selected={tab === 'calls'} onClick={() => setTab('calls')}><ListTree size={15} aria-hidden />요청 흐름</button>
          <button role="tab" data-c="tab-history" aria-selected={tab === 'history'} onClick={() => setTab('history')}><HistoryIcon size={15} aria-hidden />실행 이력과 비교</button>
          <span className="grow" />
          {tab !== 'history' && <Totals s={past ? past.run.summary : shown.run?.summary} />}
          {!coach.open && <button className="learn" onClick={() => coach.setOpen(true)}><GraduationCap size={15} aria-hidden />학습 {coach.done.length}/{LESSONS.length}, 도전 {quest.passed.length}/{QUESTS.length}</button>}
        </div>
        {tab === 'impact' ? (
          <Impact traces={traces} faults={faults} run={past ? past.run : stale ? null : shown.run} scenario={scenario} nowUs={nowUs} live={!past && shown.run?.status === 'running'} focusId={focusId}
            onFocus={(id) => { setReplaying(false); setPlayUs(null); setFocusId((c) => (c === id ? null : id)) }} onOpen={(id) => { setFocusId(id); setTab('calls') }} />
        ) : tab === 'calls' ? (
          <div className={focus ? 'split' : 'split one'}>
            <Calls traces={traces} edges={live.topology.edges} focusId={focusId} onPick={pickTrace} />
            {focus && <Timeline key={focus.traceId} trace={focus} faults={faults} playUs={playUs} replaying={replaying} onReplay={() => setReplaying(true)} onClose={closeFocus} />}
          </div>
        ) : (
          <History refresh={`${live.run?.id}-${live.run?.status}`} topics={topics} onError={onError} onOpen={(d) => { setPast(d); closeFocus(); setSelection(null); setTab('calls') }}
            onLoad={(s, l, tp) => { setSettings({ ...live.defaults, ...s }); setLabel(l); setTopic(tp); setSelection(null); setToast({ tone: 'ok', text: '조건을 불러왔습니다. 값을 바꾼 뒤 실험을 시작하세요.' }) }} />
        )}
        </div>
      </section>
      {toast && <div className={`toast tone-${toast.tone}`} role="alert">{toast.tone === 'ok' ? <CircleCheck size={17} aria-hidden /> : <TriangleAlert size={17} aria-hidden />}<span>{toast.text}</span><button className="icon" aria-label="알림 닫기" onClick={() => setToast(null)}><X size={15} /></button></div>}
    </div>
  )
}

function Totals({ s }: { s?: { total: number; ok: number; failed: number; canceled: number; inFlight: number; retries: number } }) {
  if (!s || !s.total) return null
  return <span className="totals">요청 {s.total}, 성공 {s.ok}, 실패 {s.failed}, 취소 {s.canceled}, 진행 중 {s.inFlight}, 재시도 {s.retries}</span>
}
