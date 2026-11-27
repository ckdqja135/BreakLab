// 도전 과제. 시작을 누르면 정해진 장애와 손님을 실제로 실행하고, 끝난 뒤 관측된 결과로 목표를 판정한다.
import { Check, ChevronRight, CircleCheck, CircleDashed, CircleX, Lightbulb, LoaderCircle, Play, Trophy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { QUESTS, type Quest } from '../quests'
import type { Scenario, Settings } from '../types'
import type { Lab } from '../useLab'

const KEY = 'breaklab.quest'
const load = (): string[] => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v : [] } catch { return [] } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface Verdict { text: string; ok: boolean; got: string }
export interface QuestState {
  quest: Quest | null
  phase: 'idle' | 'running' | 'done'
  note: string
  result: Verdict[] | null
  error: string | null
  passed: string[]
  hints: number
  tries: number
  pick: (q: Quest | null) => void
  run: () => void
  hint: () => void
}

export function useQuest(lab: Lab, settings: Settings | null, onPick: (q: Quest) => void): QuestState {
  const [quest, setQuest] = useState<Quest | null>(null)
  const [phase, setPhase] = useState<QuestState['phase']>('idle')
  const [note, setNote] = useState('')
  const [result, setResult] = useState<Verdict[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [passed, setPassed] = useState(load)
  const [hints, setHints] = useState(0)
  const [tries, setTries] = useState(0)
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(passed)) } catch { /* 저장하지 못해도 이번 접속에서는 쓸 수 있다 */ } }, [passed])

  const run = async () => {
    if (!quest || !settings || phase === 'running') return
    setPhase('running'); setResult(null); setError(null); setTries((n) => n + 1)
    const live = () => lab.peek()!
    const until = async (ok: () => boolean, ms: number) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (ok()) return true
      return false
    }
    // 보낸 요청이 모두 끝났는지
    const settled = (n: number) => live().traces.length >= n && live().traces.every((t) => t.endUs > 0) && !live().repeat.active
    try {
      if (live().run && live().run!.status !== 'ended') await api.endRun()
      setNote('실험을 시작하는 중')
      const started = await api.startRun(`도전: ${quest.title}`, quest.topic, settings, 120)
      await until(() => live().run?.id === started.id && live().traces.length === 0, 3000)
      let sent = 0
      for (const a of quest.script) {
        if ('fault' in a) { setNote('장애를 거는 중'); await api.applyFault(a.fault); continue }
        const count = 'send' in a ? a.send : a.burst.count
        setNote(`손님 ${count}명을 보내는 중`)
        if ('send' in a) for (let i = 1; i <= a.send; i++) { await api.send(); await until(() => settled(sent + i), 15000) }
        else await api.startRepeat(a.burst.count, a.burst.intervalMs, a.burst.concurrency)
        sent += count
        if (!(await until(() => settled(sent), 90000))) throw new Error('요청이 제때 끝나지 않았습니다. 다시 시도해 주세요.')
      }
      setNote('결과를 모으는 중')
      // A가 남긴 기록까지 도착한 뒤에 판정한다.
      await until(() => live().traces.every((t) => !t.spans.some((s) => s.service === 'service-a' && s.endUs === 0)), 3000)
      const seen = live().traces.slice()
      await api.endRun()
      const verdicts = quest.goals.map((g) => ({ text: g.text, ...g.check(seen) }))
      setResult(verdicts); setPhase('done')
      if (verdicts.every((v) => v.ok)) setPassed((p) => (p.includes(quest.id) ? p : [...p, quest.id]))
    } catch (e) {
      setError((e as Error).message); setPhase('idle')
      await api.endRun().catch(() => undefined)
    }
  }

  return {
    quest, phase, note, result, error, passed, hints, tries,
    pick: (q) => { if (phase === 'running') return; setQuest(q); setPhase('idle'); setResult(null); setError(null); setHints(0); setTries(0); if (q) onPick(q) },
    run: () => { void run() },
    hint: () => setHints((n) => n + 1),
  }
}

export function QuestPanel({ q, topics }: { q: QuestState; topics: Scenario[] }) {
  const name = (id: string) => topics.find((t) => t.id === id)?.name ?? id
  if (!q.quest) {
    return (
      <div className="coachbody">
        <p className="lead">장애와 손님 수는 정해져 있습니다. 실험 조건만 바꿔서 목표를 맞춰 보세요. 결과는 실제로 실행해서 판정합니다.</p>
        <ol className="lessons">
          {QUESTS.map((x, i) => (
            <li key={x.id}>
              <button onClick={() => q.pick(x)}>
                <i className={q.passed.includes(x.id) ? 'done' : ''}>{q.passed.includes(x.id) ? <Check size={14} aria-label="성공" /> : i + 1}</i>
                <span><b>{x.title}</b><small>{name(x.topic)}</small></span>
                <ChevronRight size={15} aria-hidden />
              </button>
            </li>
          ))}
        </ol>
      </div>
    )
  }
  const { quest, phase, result } = q
  const won = !!result && result.every((v) => v.ok)
  return (
    <>
      <header><Trophy size={16} aria-hidden /><b>{quest.title}</b><span className="grow" /><button className="plain" disabled={phase === 'running'} onClick={() => q.pick(null)}>목록</button></header>
      <div className="coachbody">
        <p className="lead">{quest.story}</p>
        <h4>목표</h4>
        <ul className="goals">
          {quest.goals.map((g, i) => {
            const v = result?.[i]
            const Icon = !v ? CircleDashed : v.ok ? CircleCheck : CircleX
            return <li key={g.text} className={!v ? '' : v.ok ? 'tone-ok' : 'tone-bad'}><Icon size={15} aria-hidden /><span>{g.text}{v && <small>결과: {v.got}</small>}</span></li>
          })}
        </ul>
        {result && <p className={`verdict tone-${won ? 'ok' : 'bad'}`}>{won ? '성공입니다. 모든 목표를 맞췄습니다.' : '아직 못 맞춘 목표가 있습니다. 조건을 바꿔 다시 해 보세요.'}</p>}
        {q.error && <p className="verdict tone-bad">{q.error}</p>}
        {phase === 'running'
          ? <p className="running"><LoaderCircle size={15} className="spin" aria-hidden />{q.note}</p>
          : <button className="primary" data-c="quest-run" onClick={q.run}><Play size={15} aria-hidden />{q.tries ? '이 조건으로 다시 도전' : '이 조건으로 도전 시작'}</button>}
        <p className="note">오른쪽 '실험 조건'에서 값을 바꾼 뒤 시작하세요. 시작하면 장애를 걸고 손님을 보내는 일은 자동으로 진행됩니다.</p>
        {quest.hints.slice(0, q.hints).map((h) => <p key={h} className="insight"><Lightbulb size={15} aria-hidden /><span>{h}</span></p>)}
        {q.hints < quest.hints.length && <button className="plain hintbtn" onClick={q.hint}><Lightbulb size={14} aria-hidden />힌트 보기 ({q.hints}/{quest.hints.length})</button>}
      </div>
    </>
  )
}
