import type { Cleanup, Fault, FaultInput, Run, RunDetail, Settings } from './types'

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  }).catch(() => { throw new Error('관리 서버에 연결할 수 없습니다') })
  const data = await res.json().catch(() => ({ error: `응답을 읽을 수 없습니다 (HTTP ${res.status})` }))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

export interface StopResult { cleanup: Cleanup; canceled: number }

export const api = {
  startRun: (label: string, scenario: string, settings: Settings, limitSec: number) => call<Run>('POST', '/api/runs', { label, scenario, settings, limitSec }),
  endRun: () => call<StopResult>('POST', '/api/runs/end'),
  emergency: () => call<StopResult>('POST', '/api/emergency-stop'),
  send: () => call<{ seq: number; traceId: string }>('POST', '/api/requests'),
  startRepeat: (count: number, intervalMs: number, concurrency: number) => call('POST', '/api/repeat', { count, intervalMs, concurrency }),
  stopRepeat: () => call('POST', '/api/repeat/stop'),
  applyFault: (f: FaultInput) => call<Fault>('POST', '/api/faults', f),
  removeFault: (id: string) => call<Fault>('POST', `/api/faults/${id}/remove`),
  runs: () => call<Run[]>('GET', '/api/runs'),
  run: (id: string) => call<RunDetail>('GET', `/api/runs/${id}`),
}
