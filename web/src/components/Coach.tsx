// 학습 과정 안내. 단계는 실제 실험 상태를 보고 스스로 넘어간다.
import { Check, ChevronRight, CircleCheck, Eye, GraduationCap, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { LESSONS, active, type Burst, type Ctx, type Lesson, type Step } from '../lessons'
import type { FaultInput } from '../types'

const KEY = 'breaklab.learn'
interface Saved { open: boolean; done: string[] }

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return { open: v.open !== false, done: Array.isArray(v.done) ? v.done : [] }
  } catch { return { open: true, done: [] } }
}

interface Course { lesson: Lesson; step: number; sinceUs: number; lessonUs: number; notes: string[]; ended: boolean }

export interface CoachState {
  open: boolean
  setOpen: (open: boolean) => void
  course: Course | null
  done: string[]
  start: (l: Lesson) => void
  quit: () => void
  next: () => void
  step: Step | null
  text: string
  hint: string | null
  fault: FaultInput | null
  burst: Burst | null
}

export function useCoach(base: Omit<Ctx, 'lessonUs' | 'sinceUs'> | null, nowUs: number, onStart: (l: Lesson) => void): CoachState {
  const [saved, setSaved] = useState(load)
  const [course, setCourse] = useState<Course | null>(null)
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(saved)) } catch { /* 저장하지 못해도 이번 접속에서는 쓸 수 있다 */ } }, [saved])

  const ctx = base && course ? { ...base, lessonUs: course.lessonUs, sinceUs: course.sinceUs } : null
  const step = course && !course.ended ? course.lesson.steps[course.step] : null
  const advance = (note?: string) => {
    if (!course) return
    const notes = note ? [...course.notes, note] : course.notes
    if (course.step + 1 < course.lesson.steps.length) { setCourse({ ...course, step: course.step + 1, sinceUs: nowUs, notes }); return }
    setCourse({ ...course, notes, ended: true })
    setSaved((s) => (s.done.includes(course.lesson.id) ? s : { ...s, done: [...s.done, course.lesson.id] }))
  }
  useEffect(() => {
    if (!course || !step || !ctx) return
    if (step.done(ctx)) { advance(step.saw?.(ctx)); return }
    // 장애가 자동 해제됐으면 적용 단계로 돌아간다.
    if (step.under && !active(ctx, step.under)) {
      const back = course.lesson.steps.findIndex((s) => s.fault === step.under)
      if (back >= 0 && back < course.step) setCourse({ ...course, step: back, sinceUs: nowUs })
    }
  })

  const say = (v: Step['do'] | undefined) => (v === undefined || !ctx ? '' : typeof v === 'function' ? v(ctx) : v)
  const on = saved.open && !!step
  return {
    open: saved.open,
    setOpen: (open) => setSaved((s) => ({ ...s, open })),
    course, done: saved.done,
    start: (lesson) => { setCourse({ lesson, step: 0, sinceUs: nowUs, lessonUs: nowUs, notes: [], ended: false }); onStart(lesson) },
    quit: () => setCourse(null),
    next: () => { if (step?.manual) advance() },
    step, text: say(step?.do),
    hint: on ? say(step?.hint) || null : null,
    fault: on ? step?.fault ?? null : null,
    burst: on ? step?.burst ?? null : null,
  }
}

export function Coach({ c }: { c: CoachState }) {
  const close = <button className="icon" aria-label="학습 과정 닫기" onClick={() => c.setOpen(false)}><X size={15} /></button>
  if (!c.course) {
    return (
      <aside className="coach" aria-label="학습 과정">
        <header><GraduationCap size={17} aria-hidden /><b>학습 과정</b><span className="grow" />{close}</header>
        <div className="coachbody">
          <p className="lead">장애를 직접 일으키며 하나씩 배웁니다. 처음이라면 1번부터 해 보세요.</p>
          <ol className="lessons">
            {LESSONS.map((l, i) => (
              <li key={l.id}>
                <button onClick={() => c.start(l)}>
                  <i className={c.done.includes(l.id) ? 'done' : ''}>{c.done.includes(l.id) ? <Check size={14} aria-label="마침" /> : i + 1}</i>
                  <span><b>{l.title}</b><small>{l.goal}</small></span>
                  <ChevronRight size={15} aria-hidden />
                </button>
              </li>
            ))}
          </ol>
        </div>
      </aside>
    )
  }
  const { lesson, step, notes, ended } = c.course
  const n = LESSONS.indexOf(lesson)
  const following = LESSONS[n + 1]
  return (
    <aside className="coach" aria-label="학습 과정">
      <header><GraduationCap size={17} aria-hidden /><b>{n + 1}. {lesson.title}</b><span className="grow" /><button className="plain" onClick={c.quit}>목록</button>{close}</header>
      <div className="stepdots" aria-hidden>{lesson.steps.map((_, i) => <i key={i} className={ended || i < step ? 'done' : i === step ? 'now' : ''} />)}</div>
      <div className="coachbody">
        {ended ? (
          <div className="todo ended">
            <small>이 과정에서 배운 것</small>
            <ul>{lesson.learned.map((x) => <li key={x}><CircleCheck size={15} aria-hidden /><span>{x}</span></li>)}</ul>
            {following
              ? <button className="primary" onClick={() => c.start(following)}>다음: {following.title}<ChevronRight size={15} aria-hidden /></button>
              : <p>모든 과정을 마쳤습니다. 이제 조건과 장애를 자유롭게 바꿔 가며 실험해 보세요.</p>}
          </div>
        ) : (
          <div className="todo">
            <small>지금 할 일 {step + 1}/{lesson.steps.length}</small>
            <b>{c.text}</b>
            {c.step?.why && <p>{c.step.why}</p>}
            {c.step?.manual && <button className="primary" onClick={c.next}>읽었어요<ChevronRight size={15} aria-hidden /></button>}
          </div>
        )}
        {notes.length > 0 && (
          <>
            <h4>지금까지 본 것</h4>
            <ul className="saw">{[...notes].reverse().map((x, i) => <li key={notes.length - i}><Eye size={14} aria-hidden /><span>{x}</span></li>)}</ul>
          </>
        )}
      </div>
    </aside>
  )
}
