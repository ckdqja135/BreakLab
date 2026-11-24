import { Ban, CircleAlert, CircleCheck, CircleHelp, CircleX, Eye, EyeOff, LoaderCircle, TimerOff, Unplug, type LucideIcon } from 'lucide-react'
import type { Fault, Observation, Peer, Result, Route } from './types'

export function ms(us: number | undefined): string {
  if (us === undefined || us < 0) return '-'
  const v = us / 1000
  if (v >= 10000) return `${(v / 1000).toFixed(1)}s`
  return v < 100 ? `${v.toFixed(1)}ms` : `${Math.round(v).toLocaleString()}ms`
}
export const clock = (us: number) => {
  const d = new Date(us / 1000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}
export const dateTime = (us: number) => {
  const d = new Date(us / 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${clock(us).slice(0, 8)}`
}
export const seconds = (us: number) => {
  const s = Math.max(0, Math.round(us / 1e6))
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`
}

type Tone = 'ok' | 'warn' | 'bad' | 'mute' | 'live'
interface Label { text: string; icon: LucideIcon; tone: Tone }

export const resultLabel: Record<Result, Label> = {
  running: { text: '진행 중', icon: LoaderCircle, tone: 'live' },
  ok: { text: '성공', icon: CircleCheck, tone: 'ok' },
  http_error: { text: 'HTTP 오류', icon: CircleAlert, tone: 'bad' },
  timeout: { text: '타임아웃', icon: TimerOff, tone: 'warn' },
  canceled: { text: '취소', icon: Ban, tone: 'mute' },
  refused: { text: '연결 거부', icon: Unplug, tone: 'bad' },
  reset: { text: '연결 끊김', icon: Unplug, tone: 'bad' },
  error: { text: '오류', icon: CircleX, tone: 'bad' },
}
export const obsLabel: Record<Observation, Label> = {
  waiting: { text: '관측 대기', icon: LoaderCircle, tone: 'live' },
  complete: { text: '관측 완료', icon: Eye, tone: 'ok' },
  partial: { text: '일부 누락', icon: EyeOff, tone: 'warn' },
  unknown: { text: '판단 불가', icon: CircleHelp, tone: 'mute' },
}
export const peerLabel: Record<Peer, string> = {
  observed: '도착 서비스에서 관측됨', waiting: '관측 대기', missing: '관측 누락', undetermined: '도달 여부 판단 불가', not_sent: '요청을 보내기 전에 실패',
}
export const routeLabel: Record<Route, string> = {
  proxied: '프록시 경유 확인', proxy_side: '프록시 연결 확인, 도착 미확인', proxy_dial: '프록시 주소로 연결 시도, 실패',
  bypassed: '프록시 우회 감지', undetermined: '경로 판단 불가', direct: '직접 연결',
}
export const reasonLabel: Record<string, string> = {
  manual: '수동', expired: '자동 만료', emergency: '비상 중지', time_limit: '시간 제한', shutdown: '서버 종료', restart: '재시작 후 정리',
  interrupted: '비정상 중단', lost: '프록시 상태 변경 감지', apply_failed: '적용 실패', done: '완료', limit: '제한 도달',
}
export const nodeName: Record<string, string> = { generator: '요청 발생기', 'service-a': 'Service A', 'service-b': 'Service B' }

export const faultText = (f: Fault) =>
  f.type === 'cut' ? '연결 차단' : `지연 ${f.latencyMs?.toLocaleString()}ms${f.jitterMs ? ` ±${f.jitterMs}` : ''} (${f.direction === 'request' ? '요청 방향' : '응답 방향'})`

export const faultState: Record<Fault['state'], string> = {
  applying: '적용 중', active: '적용됨', removing: '제거 중', removed: '제거 확인됨', apply_failed: '적용 실패', cleanup_failed: '정리 미확인',
}

export function Badge({ label, extra }: { label: Label; extra?: string }) {
  const Icon = label.icon
  return (
    <span className={`badge tone-${label.tone}`}>
      <Icon size={13} className={label.icon === LoaderCircle ? 'spin' : ''} aria-hidden />
      {label.text}{extra ? ` ${extra}` : ''}
    </span>
  )
}
