export type Result = 'running' | 'ok' | 'http_error' | 'timeout' | 'canceled' | 'refused' | 'reset' | 'error'
export type Observation = 'waiting' | 'complete' | 'partial' | 'unknown'
export type Peer = 'observed' | 'waiting' | 'missing' | 'undetermined' | 'not_sent'
export type Route = 'proxied' | 'proxy_side' | 'proxy_dial' | 'bypassed' | 'undetermined' | 'direct'

export interface Settings { clientTimeoutMs: number; callTimeoutMs: number; maxAttempts: number; backoffMs: number; workMs: number }
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
export interface Fault {
  id: string; runId: string; edge: string; type: 'latency' | 'cut'; direction?: 'request' | 'response'; latencyMs?: number; jitterMs?: number
  ttlSec: number; state: 'applying' | 'active' | 'removing' | 'removed' | 'apply_failed' | 'cleanup_failed'
  requestedUs: number; appliedUs: number; expiresUs: number; removeRequestedUs: number; removedUs: number
  endReason?: string; error?: string; cleanup?: Cleanup; recoveryUs?: number
}
export interface Summary {
  total: number; ok: number; failed: number; canceled: number; inFlight: number; p50Us: number; p95Us: number; maxUs: number
  attempts: number; retries: number; callTimeouts: number; obsIncomplete: number
}
export interface Run {
  id: string; label: string; startedUs: number; endedUs: number; limitSec: number; status: 'running' | 'ending' | 'ended'
  endReason?: string; settings: Settings; summary: Summary; cleanup?: Cleanup
}
export interface Repeat { active: boolean; count: number; intervalMs: number; concurrency: number; sent: number; stopReason?: string }
export interface ServiceStatus {
  service: string; health: 'up' | 'down' | 'unknown'; healthError?: string; healthCheckedUs: number
  telemetry: 'ok' | 'stale' | 'never'; lastTelemetryUs: number; exportErrors: number; notifyDropped: number
}
export interface ProxyState { reachable: boolean; enabled: boolean; toxics: string[] | null; checkedUs: number; error?: string }
export interface TopoNode { id: string; name: string; role: string; addr: string }
export interface Edge { id: string; from: string; to: string; protocol: string; proxy?: { name: string; listen: string; upstream: string; edges: string[] } }
export interface LabEvent { id: number; runId: string; atUs: number; type: string; detail: string }
export interface LabState {
  topology: { nodes: TopoNode[]; edges: Edge[] }; limits: Limits; defaults: Settings; run: Run | null; repeat: Repeat
  faults: Fault[]; traces: Trace[]; services: ServiceStatus[]; proxy: ProxyState; storeError: string; nowUs: number
}
export interface RunDetail { run: Run; faults: Fault[]; traces: Trace[]; events: LabEvent[] }
export type Selection = { type: 'node' | 'edge'; id: string } | null
