/**
 * 群聊轮次记忆（2026-11-09）：把「这轮群友说了什么 + 汐回了什么」攒成一轮，
 * 交给 dyMemory.saveGroupTurn（scope=group，不要求 header，限流 12/h、60/天，90 天 TTL）。
 *
 * 为什么不用关窗摘要：旧摘要写 public + 要求 header（桥没有 header，已坏）；
 * 轮次记忆按群写入，同一轮的多条 dy_say 在 idleMs（默认 15s）内合并成**一次** flush。
 *
 * 约定：
 * - 她自己的话（speaker === '汐'）不算 incoming，只作为本轮 reply；
 * - 只取 msg.at > 上次 flush 时间的入站消息，避免把同一批消息重复带进下一轮；
 * - 记忆服务缺失 / enabled !== true 一律跳过，不报错；任何异常只 warn，不抛。
 */

const SELF_SPEAKER = '汐'
const REPLY_MAX_CHARS = 600
const BUCKET_TEXT_MAX = 2000 // 单条防御：buffer 里异常超长文本先截断，避免把整段塞进记忆

const clip = (s, n) => {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) : t
}

export function createGroupTurnMemory({
  getMemory = () => null,
  getBucket = () => null,
  log = null,
  idleMs = 15000,
  now = () => Date.now(),
  enabled = true,
} = {}) {
  const pending = new Map() // groupId -> { texts: string[], groupName: string, timer }
  const lastAt = new Map() // groupId -> 上次成功持久化的入站消息时间（ms）
  const inflight = new Map() // groupId -> 单群单飞，避免并发重复写入
  const stats = { flushed: 0, ok: 0, duplicate: 0, limited: 0, error: 0, skipped: 0 }

  const memoryOf = () => {
    try {
      return getMemory?.() ?? null
    } catch {
      return null
    }
  }
  const bucketOf = (groupId) => {
    try {
      return getBucket?.(groupId) ?? null
    } catch (error) {
      log?.warn?.(`[channel-bridge] 群记忆取 buffer 失败：${error?.message ?? error}`)
      return null
    }
  }
  const idle = Math.max(1, Number(idleMs) || 15000)

  function noteReply({ groupId, groupName = '', text } = {}) {
    if (enabled !== true) return { ok: false, code: 'E_DISABLED' }
    const gid = String(groupId ?? '').trim()
    const body = String(text ?? '').trim()
    if (!gid || !body) return { ok: false, code: 'E_BAD_ARG' }
    // 服务没就绪：直接跳过（群回复不能因为记忆不可用而受影响）
    if (typeof memoryOf()?.saveGroupTurn !== 'function') return { ok: false, code: 'E_MEMORY_UNAVAILABLE' }

    const entry = pending.get(gid) ?? { texts: [], groupName: '' }
    entry.texts.push(clip(body, BUCKET_TEXT_MAX))
    if (groupName) entry.groupName = String(groupName)
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      void flush(gid).catch((error) => log?.warn?.(`[channel-bridge] 群记忆 flush 异常（不抛）：${error?.message ?? error}`))
    }, idle)
    entry.timer?.unref?.() // 定时器不拖住进程
    pending.set(gid, entry)
    return { ok: true, buffered: entry.texts.length }
  }

  async function flushOnce(groupId) {
    if (enabled !== true) return { ok: false, code: 'E_DISABLED' }
    const gid = String(groupId ?? '').trim()
    if (!gid) return { ok: false, code: 'E_BAD_ARG' }
    const mem = memoryOf()
    if (typeof mem?.saveGroupTurn !== 'function') {
      stats.skipped += 1
      return { ok: false, code: 'E_MEMORY_UNAVAILABLE' }
    }

    const entry = pending.get(gid)
    if (entry?.timer) clearTimeout(entry.timer)
    pending.delete(gid)

    const bucket = bucketOf(gid)
    const messages = Array.isArray(bucket?.messages) ? bucket.messages : []
    const since = lastAt.get(gid) ?? 0
    const incoming = []
    for (const m of messages) {
      if (!m || String(m.speaker ?? '') === SELF_SPEAKER) continue // 她自己的话不算 incoming
      const text = String(m.text ?? '').trim()
      if (!text) continue
      const at = Number(m.at ?? 0)
      if (!(at > since)) continue // 早于上次 flush 的不重复带
      incoming.push({ speaker: String(m.speaker ?? ''), text: clip(text, BUCKET_TEXT_MAX), at })
    }

    const replyText = clip(
      (entry?.texts ?? []).filter((t) => String(t).trim()).join('\n'),
      REPLY_MAX_CHARS,
    )
    const at = Number(now()) || Date.now()
    const groupName = entry?.groupName || bucket?.meta?.groupName || ''

    // 没有新入站 = 这只是一串“自言自语”（她连着发了几条），不单独记一条只有她自己的记忆；
    // 回复暂存，等下一批入站消息一起写，避免一轮对话被拆成多条空记忆。
    if (!incoming.length) {
      const carry = (entry?.texts ?? []).filter((t) => String(t).trim())
      if (carry.length) {
        pending.set(gid, { texts: carry, groupName: entry?.groupName || bucket?.meta?.groupName || '' })
      }
      stats.skipped += 1
      log?.info?.(`[channel-bridge] 群记忆：group=${gid} 跳过（无新入站，暂存回复 ${carry.length} 条）`)
      return { ok: false, code: 'E_NO_INCOMING' }
    }

    // 游标只能在 saveGroupTurn 成功或确认 duplicate 后推进；失败/限流必须保留原批次供重试。
    stats.flushed += 1
    try {
      const res = await mem.saveGroupTurn({
        groupId: gid,
        groupName: String(groupName ?? ''),
        incoming,
        reply: replyText ? [{ text: replyText, at }] : [],
        at,
      })
      const label =
        res?.ok === true ? (res.duplicate === true ? 'duplicate' : 'ok') : res?.reason === 'rate-limited' ? 'rate-limited' : 'error'
      if (label === 'ok') stats.ok += 1
      else if (label === 'duplicate') stats.duplicate += 1
      else if (label === 'rate-limited') stats.limited += 1
      else stats.error += 1

      if (label === 'ok' || label === 'duplicate') {
        const committedAt = incoming.reduce((max, item) => Math.max(max, Number(item.at) || 0), since)
        lastAt.set(gid, committedAt)
      } else {
        const current = pending.get(gid)
        const carry = [...(entry?.texts ?? []), ...(current?.texts ?? [])]
        if (carry.length) {
          pending.set(gid, {
            texts: carry,
            groupName: current?.groupName || entry?.groupName || groupName,
          })
        }
      }
      log?.info?.(`[channel-bridge] 群记忆：group=${gid} in=${incoming.length} chars=${Number(res?.chars ?? 0)} → ${label}`)
      return res
    } catch (error) {
      stats.error += 1
      const current = pending.get(gid)
      const carry = [...(entry?.texts ?? []), ...(current?.texts ?? [])]
      if (carry.length) {
        pending.set(gid, {
          texts: carry,
          groupName: current?.groupName || entry?.groupName || groupName,
        })
      }
      const msg = error?.message ?? String(error)
      log?.warn?.(`[channel-bridge] 群记忆写入异常（不影响发送）：${msg}`)
      return { ok: false, error: msg }
    }
  }

  async function flush(groupId) {
    const gid = String(groupId ?? '').trim()
    if (!gid) return { ok: false, code: 'E_BAD_ARG' }
    if (inflight.has(gid)) return inflight.get(gid)
    const task = flushOnce(gid).finally(() => inflight.delete(gid))
    inflight.set(gid, task)
    return task
  }

  function dispose() {
    for (const entry of pending.values()) {
      if (entry?.timer) clearTimeout(entry.timer)
    }
    pending.clear()
  }

  return { noteReply, flush, dispose, stats }
}
