export type Result = 'running' | 'ok' | 'http_error' | 'timeout' | 'canceled' | 'refused' | 'reset' | 'error'
export type Observation = 'waiting' | 'complete' | 'partial' | 'unknown'
export type Peer = 'observed' | 'waiting' | 'missing' | 'undetermined' | 'not_sent'
export type Route = 'proxied' | 'proxy_side' | 'proxy_dial' | 'bypassed' | 'undetermined' | 'direct'

export interface Settings {
  clientTimeoutMs: number; callTimeoutMs: number; maxAttempts: number; backoffMs: number; workMs: number
  authCacheSec: number; idempotent: boolean
}
export interface Limits {
  maxInFlight: number; maxRequestsPerRun: number; maxRepeatCount: number; minIntervalMs: number; maxIntervalMs: number
  maxRunSec: number; minFaultTtlSec: number; maxFaultTtlSec: number; maxLatencyMs: number; observationGraceMs: number
}
export interface SpanEvent { atUs: number; name: string; attrs?: Record<string, string> }
export interface Span {
  traceId: string; spanId: string; parentId: string; service: string; kind: 'client' | 'server' | 'internal'; name: string
  startUs: number; endUs: number; result: Result; error?: string; attrs?: Record<string, string>; events?: SpanEvent[]
  seenUs: number; edge?: string; peer?: Peer; route?: Route; faultIds?: string[]
}
export interface Trace {
  traceId: string; runId: string; seq: number; kind: 'single' | 'repeat'; startUs: number; endUs: number; result: Result
  httpStatus?: number; error?: string; observation: Observation; notes: string[]; spans: Span[]
}
export interface Cleanup { verified: boolean; checkedUs: number; detail: string }
export type FaultType = 'latency' | 'cut' | 'blackhole' | 'reset' | 'error' | 'overload'
// 연결 장애는 edge에, 서비스 장애(error, overload)는 node에 건다.
export interface FaultInput {
  edge?: string; node?: string; type: FaultType; direction?: 'request' | 'response'; latencyMs?: number; jitterMs?: number
  percent?: number; slots?: number; workMs?: number; ttlSec: number
}
export interface Fault extends FaultInput {
  id: string; runId: string; state: 'applying' | 'active' | 'removing' | 'removed' | 'apply_failed' | 'cleanup_failed'
  requestedUs: number; appliedUs: number; expiresUs: number; removeRequestedUs: number; removedUs: number
  endReason?: string; error?: string; cleanup?: Cleanup; recoveryUs?: number
}
export interface Summary {
  total: number; ok: number; failed: number; canceled: number; inFlight: number; p50Us: number; p95Us: number; maxUs: number
  attempts: number; retries: number; callTimeouts: number; obsIncomplete: number
}
export interface Run {
  id: string; scenario?: string; label: string; startedUs: number; endedUs: number; limitSec: number; status: 'running' | 'ending' | 'ended'
  endReason?: string; settings: Settings; summary: Summary; cleanup?: Cleanup
}
export interface Repeat { active: boolean; count: number; intervalMs: number; concurrency: number; sent: number; stopReason?: string }
export interface ServiceStatus {
  service: string; health: 'up' | 'down' | 'unknown'; healthError?: string; healthCheckedUs: number
  telemetry: 'ok' | 'stale' | 'never'; lastTelemetryUs: number; exportErrors: number; notifyDropped: number
  gauges?: Gauge[]
}
// 서비스가 스스로 센 값. 관리 서버가 읽어 온 그대로다.
export interface Gauge { label: string; value: string; alert?: boolean }
export interface ProxyState { reachable: boolean; enabled: boolean; toxics: string[] | null; checkedUs: number; error?: string }
export interface TopoNode { id: string; name: string; role: string; addr: string; faults?: boolean; slots?: number }
export interface Place { id: string; col: number; row: number }
export interface Scenario { id: string; name: string; about: string; nodes: Place[]; edges: string[] }
export interface Edge { id: string; from: string; to: string; protocol: string; proxy?: { name: string; listen: string; upstream: string; edges: string[] } }
export interface LabEvent { id: number; runId: string; atUs: number; type: string; detail: string }
export interface LabState {
  topology: { nodes: TopoNode[]; edges: Edge[]; scenarios: Scenario[] }; limits: Limits; defaults: Settings; run: Run | null; repeat: Repeat
  faults: Fault[]; traces: Trace[]; services: ServiceStatus[]; proxies: Record<string, ProxyState>; storeError: string; nowUs: number
}
export interface RunDetail { run: Run; faults: Fault[]; traces: Trace[]; events: LabEvent[] }
export type Selection = { type: 'node' | 'edge'; id: string } | null
export type Target = { edge: string } | { node: string }
