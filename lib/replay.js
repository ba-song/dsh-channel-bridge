/**
 * 掉线补收（P4-lite 第 2 项）。
 *
 * 重连成功（onOpen）时跑一次，单飞：
 *   - 只对 `channel_contacts` 里观察过的人/群拉历史（每人最多 20 条，2 小时窗）
 *   - 只投**没见过的**（`channel_events.message_id` 去重），正文前加 `[补收·HH:MM]`
 *   - 首次见到的联系人默认只记「补收起点」，不灌历史（`replay.onFirstSeen` 可开）
 *   - 任何失败只记日志，不阻断
 */
// 群聊补收默认关停（改由 reconcileGroup 带 @ 门禁去重对账）；进程内只提示一次。
let groupSkipLogged = false

export function createReplay({ cfg, store, getClient, deliver, mode, log = null, now = () => Date.now() } = {}) {
  const c = { enabled: true, count: 20, windowMs: 2 * 60 * 60 * 1000, onFirstSeen: false, groups: false, maxContacts: 20, timeoutMs: 20000, ...(cfg?.replay ?? {}) }
  let inflight = null
  const stats = { runs: 0, contacts: 0, fetched: 0, delivered: 0, skipped: 0, selfSkipped: 0, skippedAnswered: 0, alreadyReplied: 0, failed: 0, baseline: 0, groupSkipped: 0, lastRun: null }

  async function run() {
    stats.runs += 1
    const runStats = { fetched: 0, delivered: 0, skipped: 0, selfSkipped: 0, skippedAnswered: 0, alreadyReplied: 0, failed: 0, baseline: 0 }
    if (c.enabled === false) return stats
    if (mode?.current?.() === 'observe') {
      log?.throttled?.('replay-observe', '[channel-bridge] observe 模式不补收（补了也没法投递）')
      return stats
    }
    const contacts = (store?.listContacts?.('qq') ?? []).slice(0, c.maxContacts)
    if (!contacts.length) {
      log?.info?.('[channel-bridge] 没有观察过的联系人，跳过补收')
      return stats
    }
    stats.contacts += contacts.length
    const client = getClient?.()
    if (!client) {
      log?.warn?.('[channel-bridge] 补收跳过：客户端未就绪')
      return stats
    }

    for (const row of contacts) {
      const kind = row.kind === 'group' ? 'group' : 'private'
      // 群聊不再走 replay：群对账（reconcileGroup）带 @ 门禁与去重，replay 补群会绕门禁重投。
      if (kind === 'group' && c.groups !== true) {
        stats.groupSkipped += 1
        if (!groupSkipLogged) {
          groupSkipLogged = true
          log?.info?.('[channel-bridge] replay 不再补群（改用群对账+@门禁）')
        }
        continue
      }
      const id = String(row.contact)
      const lastSeen = Number(row.last_seen_at ?? 0)
      // 第一次见：默认只记起点，不灌历史
      if (!lastSeen && c.onFirstSeen !== true) {
        try {
          store.markContactSeen({ channel: 'qq', contact: id, kind, at: now() })
        } catch {}
        stats.baseline += 1
        runStats.baseline += 1
        log?.info?.(`[channel-bridge] 补收：首次见到 ${kind}/${id}，只记起点不补历史`)
        continue
      }
      const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history'
      const params = kind === 'group' ? { group_id: id, count: c.count } : { user_id: id, count: c.count }
      let msgs = []
      try {
        const res = await client.call(action, params, { timeoutMs: c.timeoutMs })
        msgs = Array.isArray(res?.data?.messages) ? res.data.messages : []
      } catch (error) {
        stats.failed += 1
        runStats.failed += 1
        log?.warn?.(`[channel-bridge] 补收 ${kind}/${id} 拉历史失败：${error?.code ?? error?.message ?? error}`)
        continue
      }
      stats.fetched += msgs.length
      runStats.fetched += msgs.length

      const fresh = []
      for (const evt of msgs) {
        const mid = evt?.message_id === undefined || evt?.message_id === null ? '' : String(evt.message_id)
        if (!mid) continue
        if (store.hasMessageId?.(mid)) {
          stats.skipped += 1
          runStats.skipped += 1
          continue
        }
        const at = Number(evt?.time ?? 0) * (Number(evt?.time ?? 0) < 1e12 ? 1000 : 1)
        if (!at || at <= lastSeen) {
          stats.skipped += 1
          runStats.skipped += 1
          continue
        }
        if (now() - at > c.windowMs) {
          stats.skipped += 1
          runStats.skipped += 1
          continue
        }
        const uid = item_user(evt)
        const self = String(evt?.self_id ?? cfg?.selfId ?? '')
        const isSelf = Boolean(uid && self && uid === self)
        if (isSelf) {
          // 她的消息只当「尾巴分界」用，不投
          stats.selfSkipped += 1
          runStats.selfSkipped += 1
        }
        fresh.push({ evt, at, mid, isSelf })
      }
      fresh.sort((a, b) => a.at - b.at)
      // 主人规则：只补「没被回复的主人消息」——最后一条是她发的就整批不补
      let candidates = fresh
      const last = fresh[fresh.length - 1]
      if (last?.isSelf) {
        stats.skippedAnswered += 1
        runStats.skippedAnswered += 1
        log?.info?.(`[channel-bridge] 补收：${kind}/${id} 最后一条是她发的（${labelOf(last.at, c.timeZoneOffsetMinutes)}），整批不补`)
        try {
          store.markContactSeen({ channel: 'qq', contact: id, kind, at: Math.max(lastSeen, last.at), replayId: last.mid })
        } catch {}
        continue
      }
      let lastSelfIdx = -1
      for (let i = fresh.length - 1; i >= 0; i -= 1) {
        if (fresh[i].isSelf) {
          lastSelfIdx = i
          break
        }
      }
      if (lastSelfIdx >= 0) {
        const replied = fresh.slice(0, lastSelfIdx + 1).filter((x) => !x.isSelf).length
        stats.alreadyReplied += replied
        runStats.alreadyReplied += replied
        candidates = fresh.slice(lastSelfIdx + 1)
        log?.info?.(`[channel-bridge] 补收：${kind}/${id} 只补她最后一次发言之后的 ${candidates.length} 条（已回复 ${replied} 条不投）`)
      }
      const take = candidates.slice(-c.count)
      // 同一批里也不允许重复（历史接口偶尔会回同一条两次）
      const batchSeen = new Set()
      let deliveredAt = 0
      let deliveredId = null
      for (const item of take) {
        if (batchSeen.has(item.mid)) {
          stats.skipped += 1
          runStats.skipped += 1
          continue
        }
        batchSeen.add(item.mid)
        try {
          const parsed = {
            channel: 'qq',
            kind,
            contactId: id,
            contactName: String(row.name || id),
            senderId: String(item.evt?.user_id ?? ''),
            senderName: String(item.evt?.sender?.card || item.evt?.sender?.nickname || ''),
            text: '',
            media: [],
            at: item.at,
            messageId: item.mid,
            replay: true,
            replayLabel: labelOf(item.at, c.timeZoneOffsetMinutes),
          }
          const parsedFull = parseForReplay(item.evt, parsed, cfg?.selfId ?? '')
          if (!parsedFull) {
            stats.selfSkipped += 1
            runStats.selfSkipped += 1
            continue
          }
          const verdict = deliver(parsedFull)
          // 只有真进队列才算投递成功；observe/队列满不算，也不推进游标
          if (verdict === 'MODE_OBSERVE' || verdict === 'QUEUE_FULL') {
            stats.skipped += 1
            runStats.skipped += 1
            continue
          }
          stats.delivered += 1
          runStats.delivered += 1
          if (item.at >= deliveredAt) {
            deliveredAt = item.at
            deliveredId = item.mid
          }
        } catch (error) {
          stats.failed += 1
          runStats.failed += 1
          log?.warn?.(`[channel-bridge] 补收投递失败：${error?.message ?? error}`)
        }
      }
      // 游标只推进到「真投出去的最后一条」；一条都没投出去就不动
      if (deliveredAt) {
        try {
          store.markContactSeen({ channel: 'qq', contact: id, kind, at: deliveredAt, replayId: deliveredId })
        } catch {}
      }
    }
    stats.lastRun = runStats
    log?.info?.(
      `[channel-bridge] 补收：本轮投递 ${runStats.delivered} 条（拉取 ${runStats.fetched}，跳过 ${runStats.skipped}，自己发的 ${runStats.selfSkipped}，失败 ${runStats.failed}；累计投递 ${stats.delivered}）`,
    )
    return stats
  }

  return {
    stats,
    /** 单飞：并发/重复触发共用同一个 promise。 */
    replayOnConnect() {
      if (inflight) return inflight
      inflight = run().finally(() => {
        inflight = null
      })
      return inflight
    },
  }
}

/** 补收消息用同一套解析，但正文要保留（历史事件形状与实时一致）。 */
function item_user(evt) {
  const u = evt?.user_id
  return u === undefined || u === null ? '' : String(u)
}

function parseForReplay(evt, base, selfId = '') {
  // 延迟 require 会导致 ESM 问题，这里直接内联最小解析：text 段拼接
  const uid = evt?.user_id === undefined || evt?.user_id === null ? '' : String(evt.user_id)
  const self = String(evt?.self_id ?? selfId ?? '')
  if (uid && self && uid === self) return null // 自己发的（历史接口会带两边）不补
  const parts = []
  const msg = evt?.message
  if (typeof msg === 'string') parts.push(msg)
  else if (Array.isArray(msg)) {
    for (const seg of msg) {
      const t = String(seg?.type ?? '')
      const d = seg?.data ?? {}
      if (t === 'text') parts.push(String(d.text ?? ''))
      else if (t === 'at') parts.push(`@${d.qq ?? ''}`)
      else if (t === 'image') parts.push('[图片]')
      else if (t === 'record') parts.push('[语音]')
      else if (t === 'file') parts.push('[文件]')
      else if (t === 'face' || t === 'mface') parts.push('[表情]')
    }
  }
  return { ...base, text: parts.join('') }
}

function labelOf(at, offsetMinutes = 480) {
  return new Date(Number(at || 0) + Number(offsetMinutes) * 60000).toISOString().slice(11, 16)
}
