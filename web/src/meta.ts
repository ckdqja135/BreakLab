// 서비스마다 화면에서 쓰는 이름과 아이콘, 문장에 쓰는 말.
import { Activity, BellRing, Boxes, CreditCard, Database, KeyRound, ListOrdered, Server, Zap, type LucideIcon } from 'lucide-react'

export interface NodeMeta {
  name: string
  short: string  // 문장에서 부르는 이름
  subj: string   // 주어 (이/가)
  topic: string  // 주제 (은/는)
  ask: string    // A가 이 서비스에 하는 일. "~고"로 끝난다
  icon: LucideIcon
}

export const NODE: Record<string, NodeMeta> = {
  generator: { name: '요청 발생기', short: '요청 발생기', subj: '요청 발생기가', topic: '요청 발생기는', ask: '', icon: Activity },
  'service-a': { name: 'Service A', short: 'A', subj: 'A가', topic: 'A는', ask: '', icon: Server },
  'service-b': { name: 'Service B', short: 'B', subj: 'B가', topic: 'B는', ask: 'B에 재고를 묻고', icon: Boxes },
  auth: { name: '인증', short: '인증', subj: '인증이', topic: '인증은', ask: '인증에 손님 확인을 맡기고', icon: KeyRound },
  pay: { name: '결제', short: '결제', subj: '결제가', topic: '결제는', ask: '결제를 요청하고', icon: CreditCard },
  cache: { name: '캐시', short: '캐시', subj: '캐시가', topic: '캐시는', ask: '캐시에서 상품을 찾아보고', icon: Zap },
  db: { name: '상품 DB', short: 'DB', subj: 'DB가', topic: 'DB는', ask: 'DB에서 상품을 읽고', icon: Database },
  queue: { name: '큐', short: '큐', subj: '큐가', topic: '큐는', ask: '큐에 알림 작업을 넣고', icon: ListOrdered },
  worker: { name: '작업자', short: '작업자', subj: '작업자가', topic: '작업자는', ask: '작업자에게 알림 작업을 넘기고', icon: BellRing },
}

// 연결 ID에서 도착 서비스를 찾는다. 연결 ID는 서버가 정한 목록과 같다.
export const EDGE_TO: Record<string, string> = {
  'gen-a': 'service-a', 'a-b': 'service-b', 'a-auth': 'auth', 'a-pay': 'pay', 'a-cache': 'cache', 'a-db': 'db', 'a-queue': 'queue', 'queue-worker': 'worker',
}
export const EDGE_FROM: Record<string, string> = {
  'gen-a': 'generator', 'a-b': 'service-a', 'a-auth': 'service-a', 'a-pay': 'service-a', 'a-cache': 'service-a', 'a-db': 'service-a', 'a-queue': 'service-a', 'queue-worker': 'queue',
}
export const meta = (id: string | undefined): NodeMeta => NODE[id ?? ''] ?? { name: id ?? '?', short: id ?? '?', subj: `${id}이(가)`, topic: `${id}은(는)`, ask: '', icon: Server }
