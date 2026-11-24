import { useEffect, useRef, useState } from 'react'
import type { Fault, LabState, ServiceStatus, Trace } from './types'

function upsert<T>(list: T[], item: T, same: (a: T) => boolean): T[] {
  const i = list.findIndex(same)
  if (i < 0) return [...list, item]
  const next = list.slice()
  next[i] = item
  return next
}

function reduce(s: LabState, type: string, d: any): LabState {
  switch (type) {
    case 'run': return { ...s, run: d.run, repeat: d.repeat }
    case 'fault': return { ...s, faults: upsert(s.faults, d as Fault, (f) => f.id === d.id) }
    case 'trace': return s.run && d.runId !== s.run.id ? s : { ...s, traces: upsert(s.traces, d as Trace, (t) => t.traceId === d.traceId) }
    case 'service': return { ...s, services: upsert(s.services, d as ServiceStatus, (x) => x.service === d.service) }
    case 'proxy': return { ...s, proxy: d }
    case 'notice': return { ...s, storeError: d.storeError }
  }
  return s
}

export interface Lab {
  live: LabState | null   // 제어 버튼과 안전 상태는 항상 이 값을 쓴다.
  shown: LabState | null  // 화면 갱신을 멈추면 이 값만 멈춘다.
  connected: boolean
  paused: boolean
  behind: number
  offsetUs: number
  setPaused: (p: boolean) => void
}

// onTrace는 실시간으로 도착한 관측만 받는다. 처음 불러온 상태는 애니메이션으로 만들지 않는다.
export function useLab(onTrace: (t: Trace) => void): Lab {
  const live = useRef<LabState | null>(null)
  const shown = useRef<LabState | null>(null)
  const paused = useRef(false)
  const behind = useRef(0)
  const offset = useRef(0)
  const frame = useRef(0)
  const [, tick] = useState(0)
  const [connected, setConnected] = useState(false)
  const cb = useRef(onTrace)
  cb.current = onTrace

  const render = () => {
    if (frame.current) return
    frame.current = window.setTimeout(() => { frame.current = 0; tick((n) => n + 1) }, 30)
  }

  useEffect(() => {
    let es: EventSource
    let retry = 0
    const open = () => {
      es = new EventSource('/api/events')
      es.addEventListener('snapshot', (e) => {
        const s: LabState = JSON.parse(e.data)
        offset.current = s.nowUs - Date.now() * 1000
        live.current = s
        if (!paused.current) shown.current = s
        setConnected(true)
        render()
      })
      for (const type of ['run', 'fault', 'trace', 'service', 'proxy', 'notice']) {
        es.addEventListener(type, (e) => {
          if (!live.current) return
          const d = JSON.parse((e as MessageEvent).data)
          live.current = reduce(live.current, type, d)
          if (paused.current) { if (type === 'trace' || type === 'fault') behind.current++ }
          else {
            shown.current = live.current
            if (type === 'trace') cb.current(d)
          }
          render()
        })
      }
      es.onerror = () => {
        setConnected(false)
        es.close()
        retry = window.setTimeout(open, 1500)
      }
    }
    open()
    return () => { es.close(); clearTimeout(retry) }
  }, [])

  return {
    live: live.current, shown: shown.current, connected, paused: paused.current, behind: behind.current, offsetUs: offset.current,
    setPaused: (p) => {
      paused.current = p
      behind.current = 0
      if (!p) shown.current = live.current
      tick((n) => n + 1)
    },
  }
}

export function useNowUs(offsetUs: number, every = 250): number {
  const [, t] = useState(0)
  useEffect(() => {
    const id = setInterval(() => t((n) => n + 1), every)
    return () => clearInterval(id)
  }, [every])
  return Date.now() * 1000 + offsetUs
}
