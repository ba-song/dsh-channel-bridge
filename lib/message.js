/** 投递消息体：必须是 user/message、content 是数组、带 UUID、source.kind='channel-inbound'。 */
import { randomUUID } from 'node:crypto'

export function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj
  for (const v of Object.values(obj)) deepFreeze(v)
  return Object.freeze(obj)
}

export function buildChannelMessage(text, parsed, { id = randomUUID(), blocks = [] } = {}) {
  const channel = String(parsed?.channel ?? 'qq')
  const kind = String(parsed?.kind ?? 'private')
  const contact = String(parsed?.contactId ?? '')
  const content = [{ type: 'text', text: String(text ?? '') }]
  // 2026-11-16：群聊图片直投（第一张图作为 image block），她不用再 read_image
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b && typeof b === 'object' && b.type) content.push(b)
  }
  return deepFreeze({
    id,
    role: 'user',
    content,
    // source.kind='user' → GUI 渲染成正常聊天气泡（不是「收到执行请求」卡片）。
    // 渠道信息全放附加字段，解析/审计仍可用。
    source: {
      kind: 'user',
      channel,
      contact,
      contactKind: kind,
      contactId: contact,
      contactName: String(parsed?.contactName ?? ''),
      messageKind: kind,
      at: Number(parsed?.at ?? Date.now()),
    },
  })
}
