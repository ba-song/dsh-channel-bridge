/**
 * 周期对账：不依赖 WS 推送，主动去 SL 拉最近历史，把「漏掉的入站」补投。
 *
 * 每轮（默认 60s）：
 *   - 私聊（`get_friend_msg_history(count=20)`）→ 过滤（有 message_id、库中无、
 *     time > last_seen、不是自己发的）→ 按时间顺序投递 → 成功才落库并推进游标；
 *   - 群聊（`get_group_msg_history(count=groupCount)`，`reconcile.groups` 默认 true）→
 *     同一套过滤 + **必须过 @ 门禁**（shouldDeliverGroup，和实时入站同一把闸）；
 *     门禁拦下的不落库、不推进游标（下轮还会看到，等真的 @ 或实时路径处理），失败/超时按群独立退避。
 * 失败不推进游标，下一轮重试；同一个 message_id 先到先得（hasMessageId 去重，WS/补收/对账共用）。
 */
import { parseMessageEvent } from './parse.js'
import { shouldDeliverGroup } from './mention.js'

export function createReconciler({
  cfg = {},
  store = null,
  getClient = () => null,
  deliverOne = async () => ({ ok: false, code: 'E_NO_DELIVER' }),
  onMessage = null,
  log = null,
  now = () => Date.now(),
  setInterval: setI = setInterval,
  clearInterval: clearI = clearInterval,
} = {}) {
  const c = { enabled: true, everyMs: 60000, count: 20, backoffMs: 3600000, activeDays: 7, groups: true, groupCount: 20, ...(cfg.reconcile ?? {}) }
  const stats = {
    runs: 0,
    fetched: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
    contactSkipped: 0,
    backoffSkipped: 0,
    staleSkipped: 0,
    // 群维度（私聊字段保持不变，群单独计数，互不污染）
    groupFetched: 0,
    groupNew: 0,
    groupDelivered: 0,
    groupSkipped: 0,
    groupGateSkipped: 0,
    groupFailed: 0,
    groupBackoffSkipped: 0,
    groupStaleSkipped: 0,
    groupParseFail: 0,
    lastAt: 0,
    lastError: null,
  }
  const backoff = new Map() // contact -> { skipUntil, failCount }
  let timer = null
  let running = null

  /**
   * 非好友/不可聊：这类联系人退避，不算 failed。
   * 注意：**超时**必须走瞬时错误分支（E_TIMEOUT），不能伪装成 E_SEND_FAILED ——
   * 2026-11-07 18:30 事故：一次 15s 超时被当成「非好友」，主人被退避 60 分钟，那条消息整整一小时没进会话。
   */
  const isContactError = (code, message) => {
    const c2 = String(code ?? '')
    if (c2 === 'E_SEND_FAILED' || c2 === 'E_NOT_FRIEND' || c2 === 'E_GROUP_NOT_JOINED') return true
    return /not friend|非好友|不在好友/i.test(String(message ?? ''))
  }

  const selfIdOf = (evt) => String(evt?.self_id ?? cfg?.selfId ?? '')
  const isSelf = (evt) => {
    const uid = evt?.user_id
    return uid !== undefined && uid !== null && selfIdOf(evt) !== '' && String(uid) === selfIdOf(evt)
  }

  /** 历史事件一般是完整 OneBot 事件；个别版本只回消息体。缺 post_type/message_type 时兜底成群入站（不覆盖已有字段）。 */
  let shapeWarned = false
  function asGroupEvent(evt) {
    if (!evt || typeof evt !== 'object') return evt
    const missPost = String(evt.post_type ?? '') === ''
    const missType = String(evt.message_type ?? '') === ''
    if (!missPost && !missType) return evt
    if (!shapeWarned) {
      shapeWarned = true
      log?.warn?.('[channel-bridge] 群对账：历史事件缺 post_type/message_type，已按 message/group 兜底解析（接口形状变了？）')
    }
    return { ...evt, ...(missPost ? { post_type: 'message' } : {}), ...(missType ? { message_type: 'group' } : {}) }
  }

  /** 历史事件 → 正文（段数组）。 */
  function textOfHistory(evt) {
    const msg = evt?.message
    if (typeof msg === 'string') return msg
    if (!Array.isArray(msg)) return ''
    const parts = []
    for (const seg of msg) {
      const t = String(seg?.type ?? '')
      const d = seg?.data ?? {}
      if (t === 'text') parts.push(String(d.text ?? ''))
      else if (t === 'at') parts.push(`@${d.qq ?? ''}`)
      else if (t === 'reply') continue
      else if (t === 'image') parts.push('[图片]')
      else if (t === 'record') parts.push('[语音]')
      else if (t === 'file') parts.push('[文件]')
      else if (t === 'face' || t === 'mface') parts.push('[表情]')
    }
    return parts.join('')
  }

  /** 单个群的补收：拉历史 → 过滤 → 过 @ 门禁 → 按时间投递；失败按群退避，不影响其它群。 */
  async function reconcileGroup(client, row, run) {
    const contact = String(row.contact)
    const lastSeen = Number(row.last_seen_at ?? 0)
    const bkey = `group:${contact}` // 与私聊共用一个 Map，但 key 加前缀，互不覆盖
    const prevBackoff = backoff.get(bkey)
    if (prevBackoff && now() < prevBackoff.skipUntil) {
      stats.groupBackoffSkipped += 1
      run.groupBackoffSkipped += 1
      return
    }
    let msgs = []
    try {
      const res = await client.call('get_group_msg_history', { group_id: contact, count: c.groupCount }, { timeoutMs: 15000 })
      msgs = Array.isArray(res?.data?.messages) ? res.data.messages : []
    } catch (error) {
      // 群历史拉不到 → 该群退避，别的群照常。
      // 连接断/超时是瞬时的（2026-11-10 实测：WS 每 30 分钟重连会撞上），只退避 2 分钟；
      // 只有“拉得到连接但拉不到数据”才按配置长退避，避免群里静音一小时。
      const code = error?.code ?? error?.message ?? String(error)
      const transient = code === 'E_NOT_CONNECTED' || code === 'E_TIMEOUT'
      const backoffMs = transient ? 120000 : Math.max(60000, Number(c.backoffMs) || 3600000)
      backoff.set(bkey, { skipUntil: now() + backoffMs, failCount: (prevBackoff?.failCount ?? 0) + 1 })
      stats.groupFailed += 1
      run.groupFailed += 1
      stats.lastError = code
      log?.warn?.(
        `[channel-bridge] 群对账 group=${contact} 拉历史失败：${code}（${transient ? '2 分钟后重试' : `退避 ${Math.round(backoffMs / 60000)} 分钟`}）`,
      )
      return
    }
    stats.groupFetched += msgs.length
    run.groupFetched += msgs.length
    backoff.delete(bkey) // 拉到了 → 恢复正常
    const fresh = []
    const batchSeen = new Set() // 历史接口偶尔回同一条两次：同一批里也只投一次
    for (const evt of msgs) {
      const mid = evt?.message_id === undefined || evt?.message_id === null ? '' : String(evt.message_id)
      if (!mid || isSelf(evt)) continue
      if (batchSeen.has(mid)) {
        stats.groupSkipped += 1
        run.groupSkipped += 1
        continue
      }
      batchSeen.add(mid)
      const rawTime = Number(evt?.time ?? 0)
      const at = rawTime * (rawTime < 1e12 ? 1000 : 1)
      if (!at || at <= lastSeen) continue
      if (store.hasMessageId?.(mid)) {
        // WS / 补收 / 别的群已经投过：先到先得
        stats.groupSkipped += 1
        run.groupSkipped += 1
        continue
      }
      fresh.push({ evt, at, mid })
    }
    fresh.sort((x, y) => x.at - y.at)
    if (!fresh.length) return
    stats.groupNew += fresh.length
    run.groupNew += fresh.length
    const mentionMode = cfg?.group?.requireMention !== false
    const ownerIds = (cfg?.owner?.qqIds ?? []).map((x) => String(x))
    let delivered = 0
    let gated = 0
    let parseFail = 0
    let deliveredAt = 0
    let deliveredId = null
    for (const item of fresh) {
      let parsed = null
      try {
        parsed = parseMessageEvent(asGroupEvent(item.evt), {
          selfId: cfg?.selfId || selfIdOf(item.evt),
          owner: { qqIds: ownerIds },
          channel: 'qq',
          now,
        })
      } catch {
        parsed = null
      }
      if (!parsed || parsed.kind !== 'group') {
        parseFail += 1
        stats.groupParseFail += 1
        run.groupParseFail += 1
        continue
      }
      parsed.contactId = contact
      // 群名以联系人表为准（历史事件里常常没有 group_name，parse 会退化成「群_<号>」）
      if (!parsed.contactName || parsed.contactName === `群_${contact}`) parsed.contactName = String(row.name || parsed.contactName || contact)
      parsed.at = item.at
      parsed.messageId = item.mid
      parsed.reconcile = true
      // 和实时入站同一把 @ 闸：补收不得绕过（群聊默认只有 @ 才回）
      const gateRes = shouldDeliverGroup(parsed, {
        requireMention: mentionMode,
        selfId: cfg?.selfId || selfIdOf(item.evt),
        mentionNames: cfg?.group?.mentionNames ?? [],
      })
      if (!gateRes.ok) {
        // 门禁拦下：不投、不落库、不动游标（消息留在历史窗口里，下轮/实时路径还能再判，不悄悄吞掉）
        gated += 1
        stats.groupGateSkipped += 1
        run.groupGateSkipped += 1
        if (gateRes.warn) log?.throttled?.('reconcile-group-no-self', '[channel-bridge] 群对账：selfId 未知，群消息一律不投（等 get_login_info/配置补上）')
        continue
      }
      // 实时路径在 @ 命中时会带「公开近况 + 群上下文」，补收保持一致
      if (mentionMode && gateRes.reason === 'at-bot') parsed.wantGroupContext = true
      try {
        const r = await deliverOne(parsed, item.evt)
        if (r?.skipped === true) {
          // deliverOne 说「过了闸但没下发」（例如 mode=observe / 队列满）：不落库、不动游标
          gated += 1
          stats.groupGateSkipped += 1
          run.groupGateSkipped += 1
          continue
        }
        if (!r?.ok) {
          stats.groupFailed += 1
          run.groupFailed += 1
          stats.lastError = r?.code ?? 'E_DELIVER_FAILED'
          log?.warn?.(`[channel-bridge] 群对账投递失败 group=${contact} ${item.mid}：${stats.lastError}（游标不动，下轮重试）`)
          break
        }
        try {
          store.insertEvent({
            at: item.at,
            channel: 'qq',
            kind: 'group',
            contact,
            senderId: parsed.senderId,
            direction: 'in',
            text: parsed.text,
            messageId: item.mid,
            meta: { reconcile: true, originalAt: item.at },
          })
        } catch {}
        stats.groupDelivered += 1
        run.groupDelivered += 1
        delivered += 1
        deliveredAt = item.at
        deliveredId = item.mid
        try {
          onMessage?.(parsed)
        } catch {}
      } catch (error) {
        stats.groupFailed += 1
        run.groupFailed += 1
        stats.lastError = error?.message ?? String(error)
        log?.warn?.(`[channel-bridge] 群对账投递异常 group=${contact}：${stats.lastError}`)
        break
      }
    }
    if (deliveredAt) {
      try {
        store.markContactSeen({ channel: 'qq', contact, kind: 'group', at: deliveredAt, replayId: deliveredId })
      } catch {}
    }
    // 只在真投出去时记一行（门禁拦下的不逐轮刷屏，交给本轮汇总）
    if (delivered > 0) {
      log?.info?.(
        `[channel-bridge] 群对账：group=${contact} 拉 ${msgs.length} / 新 ${fresh.length} / 投 ${delivered}` +
          (gated ? ` / 门禁跳 ${gated}` : '') +
          (parseFail ? ` / 解析失败 ${parseFail}` : ''),
      )
    }
  }

  async function runOnce() {
    stats.runs += 1
    stats.lastAt = now()
    const run = {
      fetched: 0,
      delivered: 0,
      skipped: 0,
      failed: 0,
      contactSkipped: 0,
      groupFetched: 0,
      groupNew: 0,
      groupDelivered: 0,
      groupSkipped: 0,
      groupGateSkipped: 0,
      groupFailed: 0,
      groupBackoffSkipped: 0,
      groupParseFail: 0,
    } // 本轮计数（日志只看本轮）
    if (c.enabled === false) return stats
    const client = getClient?.()
    if (!client || typeof client.call !== 'function') {
      stats.lastError = 'E_NOT_CONNECTED'
      return stats
    }
    const activeMs = Math.max(1, Number(c.activeDays) || 7) * 24 * 3600 * 1000
    const rows = store?.listContacts?.('qq') ?? []
    const contacts = rows.filter((r) => {
      if (r.kind !== 'private') return false
      // 只对账最近 N 天有动静的联系人；陌生人冷启动不扫
      if (now() - Number(r.last_seen_at ?? 0) > activeMs) {
        stats.staleSkipped += 1
        return false
      }
      return true
    })
    // 群：kind='group' 且最近 activeDays 有动静；reconcile.groups=false 可整块关掉
    const groups =
      c.groups === false
        ? []
        : rows.filter((r) => {
            if (r.kind !== 'group') return false
            if (now() - Number(r.last_seen_at ?? 0) > activeMs) {
              stats.groupStaleSkipped += 1
              return false
            }
            return true
          })
    if (!contacts.length && !groups.length) {
      log?.info?.('[channel-bridge] 对账：没有联系人（私聊/群），跳过')
      return stats
    }
    for (const row of contacts) {
      const contact = String(row.contact)
      const lastSeen = Number(row.last_seen_at ?? 0)
      const b = backoff.get(contact)
      if (b && now() < b.skipUntil) {
        stats.backoffSkipped += 1
        continue // 退避窗口内：不拉、不 warn
      }
      let msgs = []
      try {
        const res = await client.call('get_friend_msg_history', { user_id: contact, count: c.count }, { timeoutMs: 15000 })
        msgs = Array.isArray(res?.data?.messages) ? res.data.messages : []
      } catch (error) {
        const code = error?.code ?? error?.message ?? String(error)
        stats.lastError = code
        if (isContactError(code, error?.message)) {
          // 非好友/不可聊：按联系人退避 1 小时，不重复刷 warn，不计 failed
          stats.contactSkipped += 1
          run.contactSkipped += 1
          const prev = backoff.get(contact)
          backoff.set(contact, { skipUntil: now() + Math.max(60000, Number(c.backoffMs) || 3600000), failCount: (prev?.failCount ?? 0) + 1 })
          if (!prev) log?.warn?.(`[channel-bridge] 对账跳过联系人 ${contact}（${code}，退避 ${Math.round((Number(c.backoffMs) || 3600000) / 60000)} 分钟，期间不重试）`)
          continue
        }
        stats.failed += 1
        run.failed += 1
        log?.warn?.(`[channel-bridge] 对账 ${contact} 拉历史失败：${code}`)
        continue
      }
      stats.fetched += msgs.length
      run.fetched += msgs.length
      backoff.delete(contact) // 拉到了 → 恢复正常
      const fresh = []
      for (const evt of msgs) {
        const mid = evt?.message_id === undefined || evt?.message_id === null ? '' : String(evt.message_id)
        if (!mid || isSelf(evt)) continue
        const at = Number(evt?.time ?? 0) * (Number(evt?.time ?? 0) < 1e12 ? 1000 : 1)
        if (!at || at <= lastSeen) continue
        if (store.hasMessageId?.(mid)) {
          stats.skipped += 1
          run.skipped += 1
          continue
        }
        fresh.push({ evt, at, mid })
      }
      fresh.sort((a, b) => a.at - b.at)
      if (!fresh.length) continue
      let deliveredAt = 0
      let deliveredId = null
      for (const item of fresh) {
        const parsed = {
          channel: 'qq',
          kind: 'private',
          contactId: contact,
          contactName: String(row.name || contact),
          senderId: String(item.evt?.user_id ?? ''),
          senderName: String(item.evt?.sender?.card || item.evt?.sender?.nickname || ''),
          text: textOfHistory(item.evt),
          media: [],
          at: item.at,
          messageId: item.mid,
          reconcile: true,
        }
        try {
          const r = await deliverOne(parsed, item.evt)
          if (!r?.ok) {
            stats.failed += 1
            run.failed += 1
            stats.lastError = r?.code ?? 'E_DELIVER_FAILED'
            log?.warn?.(`[channel-bridge] 对账投递失败 ${item.mid}：${stats.lastError}（游标不动，下轮重试）`)
            break
          }
          try {
            store.insertEvent({
              at: item.at,
              channel: 'qq',
              kind: 'private',
              contact,
              senderId: parsed.senderId,
              direction: 'in',
              text: parsed.text,
              messageId: item.mid,
              meta: { reconcile: true, originalAt: item.at },
            })
          } catch {}
          stats.delivered += 1
          run.delivered += 1
          deliveredAt = item.at
          deliveredId = item.mid
          try {
            onMessage?.(parsed)
          } catch {}
        } catch (error) {
          stats.failed += 1
          run.failed += 1
          stats.lastError = error?.message ?? String(error)
          log?.warn?.(`[channel-bridge] 对账投递异常：${stats.lastError}`)
          break
        }
      }
      if (deliveredAt) {
        try {
          store.markContactSeen({ channel: 'qq', contact, kind: 'private', at: deliveredAt, replayId: deliveredId })
        } catch {}
      }
    }
    // 群：同一轮里逐个群补收；任何单群异常不影响其它群
    for (const row of groups) {
      try {
        await reconcileGroup(client, row, run)
      } catch (error) {
        stats.groupFailed += 1
        run.groupFailed += 1
        stats.lastError = error?.message ?? String(error)
        log?.warn?.(`[channel-bridge] 群对账异常 group=${row.contact}：${stats.lastError}`)
      }
    }
    const groupPart =
      c.groups === false || (!groups.length && !run.groupFetched && !run.groupDelivered && !run.groupFailed && !run.groupGateSkipped && !run.groupSkipped)
        ? ''
        : ` / 群：拉 ${run.groupFetched} / 新 ${run.groupNew} / 投 ${run.groupDelivered} / 门禁跳 ${run.groupGateSkipped} / 失败 ${run.groupFailed} / 退避跳 ${run.groupBackoffSkipped}` +
          (run.groupParseFail ? ` / 解析失败 ${run.groupParseFail}` : '')
    log?.info?.(
      `[channel-bridge] 对账：本轮拉取 ${run.fetched} 条 / 新投 ${run.delivered} / 累计拉取 ${stats.fetched} / 跳过 ${run.skipped}` +
        ` / 失败 ${run.failed} / 联系人退避 ${run.contactSkipped} / 累计退避跳过 ${stats.backoffSkipped} / 过期不扫 ${stats.staleSkipped}（累计投递 ${stats.delivered}）` +
        groupPart,
    )
    return stats
  }

  return {
    stats,
    config: c,
    backoff,
    /** 单飞：对账与实时/补收并发时只跑一轮。 */
    runOnce() {
      if (running) return running
      running = Promise.resolve()
        .then(runOnce)
        .catch((error) => {
          stats.failed += 1
          stats.lastError = error?.message ?? String(error)
          return stats
        })
        .finally(() => {
          running = null
        })
      return running
    },
    start() {
      if (timer || c.enabled === false) return
      timer = setI(() => {
        void this.runOnce()
      }, Math.max(1000, c.everyMs))
      timer?.unref?.()
    },
    stop() {
      if (timer) clearI(timer)
      timer = null
    },
    get running() {
      return Boolean(running)
    },
  }
}
