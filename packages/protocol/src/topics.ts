export type TopicKind =
  | 'status'
  | 'osd'
  | 'state'
  | 'services'
  | 'services_reply'
  | 'events'
  | 'events_reply'
  | 'requests'
  | 'requests_reply'
  | 'property_set'
  | 'property_set_reply'
  | 'drc_up'
  | 'drc_down'

export interface ParsedTopic {
  kind: TopicKind
  sn: string
}

const SYS_STATUS = /^sys\/product\/([^/]+)\/status$/
const THING =
  /^thing\/product\/([^/]+)\/(osd|state|services|services_reply|events|events_reply|requests|requests_reply|property\/set|property\/set_reply|drc\/up|drc\/down)$/

const KIND_BY_SEGMENT: Record<string, TopicKind> = {
  osd: 'osd',
  state: 'state',
  services: 'services',
  services_reply: 'services_reply',
  events: 'events',
  events_reply: 'events_reply',
  requests: 'requests',
  requests_reply: 'requests_reply',
  'property/set': 'property_set',
  'property/set_reply': 'property_set_reply',
  'drc/up': 'drc_up',
  'drc/down': 'drc_down',
}

export function parseTopic(topic: string): ParsedTopic | null {
  const sys = SYS_STATUS.exec(topic)
  if (sys?.[1]) return { kind: 'status', sn: sys[1] }

  const thing = THING.exec(topic)
  if (thing?.[1] && thing[2]) {
    const kind = KIND_BY_SEGMENT[thing[2]]
    if (kind) return { kind, sn: thing[1] }
  }
  return null
}

export const topic = {
  status: (gatewaySn: string) => `sys/product/${gatewaySn}/status`,
  statusReply: (gatewaySn: string) => `sys/product/${gatewaySn}/status_reply`,
  osd: (sn: string) => `thing/product/${sn}/osd`,
  state: (sn: string) => `thing/product/${sn}/state`,
  services: (gatewaySn: string) => `thing/product/${gatewaySn}/services`,
  servicesReply: (gatewaySn: string) => `thing/product/${gatewaySn}/services_reply`,
  events: (gatewaySn: string) => `thing/product/${gatewaySn}/events`,
  requests: (gatewaySn: string) => `thing/product/${gatewaySn}/requests`,
  requestsReply: (gatewaySn: string) => `thing/product/${gatewaySn}/requests_reply`,
}

export const SUBSCRIBE_TOPICS = [
  'sys/product/+/status',
  'thing/product/+/osd',
  'thing/product/+/state',
  'thing/product/+/services_reply',
  'thing/product/+/events',
  'thing/product/+/requests',
]
