/**
 * 补收消息的投递路由：
 * - unified + 私聊 → 走 dyHome（和正常入站同一条路），**不写/不投旧 QQ 会话**；
 * - 其它 → 老路径（落 bridge.db + 桥自己的会话）。
 * 计数交给调用方：`counters.homeDelivered` / `counters.legacyDelivered`。
 */
import { shouldRouteToHome } from './unified.js'

export function createReplayDeliverer({
  unified = null,
  ownerIds = [],
  store = null,
  router = null,
  log = null,
  counters = { homeDelivered: 0, legacyDelivered: 0, dupSkipped: 0 },
} = {}) {
  if (counters.dupSkipped === undefined) counters.dupSkipped = 0
  function insertReplayEvent(parsed) {
    try {
      store?.insertEvent?.({
        at: parsed.at,
        channel: parsed.channel,
        kind: parsed.kind,
        contact: parsed.contactId,
        senderId: parsed.senderId,
        direction: 'in',
        text: parsed.text,
        messageId: parsed.messageId,
        meta: { replay: true, originalAt: parsed.at },
      })
      store?.upsertContact?.({ channel: parsed.channel, contact: parsed.contactId, kind: parsed.kind, name: parsed.contactName, at: parsed.at })
    } catch (error) {
      log?.warn?.(`[channel-bridge] 补收落库失败：${error?.message ?? error}`)
    }
  }

  return function deliverReplay(parsed) {
    // 和实时入站同一把闸：库里已有这个 message_id 就跳过（跨会话轮换也一样）
    if (parsed?.messageId && store?.hasMessageId?.(parsed.messageId)) {
      counters.dupSkipped += 1
      log?.info?.(`[channel-bridge] 补收跳过重复消息 ${parsed.messageId}（库里已有）`)
      return 'SKIPPED_DUP'
    }
    if (shouldRouteToHome(parsed, { unified: unified?.enabled === true, ownerIds })) {
      insertReplayEvent(parsed)
      void Promise.resolve(unified.deliver(parsed))
        .then((r) => {
          if (r?.ok && r.delivered) counters.homeDelivered += 1
          else if (!r?.ok) log?.warn?.(`[channel-bridge] 补收转 home 未成功：${r?.code}`)
        })
        .catch((error) => log?.warn?.(`[channel-bridge] 补收转 home 异常：${error?.message ?? error}`))
      return 'QUEUED'
    }
    counters.legacyDelivered += 1
    insertReplayEvent(parsed)
    return router?.deliver?.(parsed) ?? 'QUEUED'
  }
}
