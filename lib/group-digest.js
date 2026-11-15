/**
 * 关窗时把本次群聊交给 dyMemory：
 * - `saveGroupDigest`：摘要（最近 ≤10 条），写 public —— **2026-11-09 退役**：
 *   桥没有 agent header，`saveGroupDigest` 里 `header.id` 直接抛
 *   `Cannot read properties of null (reading 'id')`（日志里已有两次失败）。
 *   改用 `lib/group-turn-memory.js` 的轮次记忆（每轮群友 + 她的回复）。
 *   这里**保留代码只停调用路径**：`DIGEST_RETIRED` 改回 false 即可恢复；
 * - `saveGroupTranscript`：全文归档（窗口内全部消息），只写记忆库、**不注入 home 上下文**。
 *
 * 保留：失败只 warn、不重试、不阻断；memory 缺失/窗口空就跳过。
 */

/** 旧摘要写 public + 依赖 header，桥没有 header → 已坏；停用（代码保留）。 */
const DIGEST_RETIRED = true

/** 群摘要退役只在首次调用时提示一次（进程生命周期内）。 */
const RETIRED_NOTICE = '[channel-bridge] 群摘要已退役（改用轮次记忆）'

export function createGroupDigest({ getMemory = () => null, log = null, now = () => Date.now() } = {}) {
  const stats = {
    saved: 0,
    failed: 0,
    skipped: 0,
    lastAt: null,
    lastError: null,
    transcriptSaved: 0,
    transcriptFailed: 0,
    retired: 0,
  }
  let inflight = false
  let retiredLogged = false

  const normalize = (messages) =>
    (messages ?? [])
      .filter((m) => m && String(m.text ?? '').trim())
      .map((m) => ({ speaker: String(m.speaker ?? ''), text: String(m.text).trim(), at: Number(m.at ?? 0) }))

  async function save({ groupId, groupName = '', messages = [], at = now() } = {}) {
    if (inflight) {
      stats.skipped += 1
      return { ok: false, code: 'E_BUSY' }
    }
    if (!retiredLogged) {
      retiredLogged = true
      stats.retired += 1
      log?.info?.(RETIRED_NOTICE)
    }
    const memory = getMemory?.()
    const canDigest = memory && typeof memory.saveGroupDigest === 'function'
    const canTranscript = memory && typeof memory.saveGroupTranscript === 'function'
    // 摘要退役后只剩全文归档；连 transcript 都没有就没什么可做的
    if (!canTranscript) {
      stats.skipped += 1
      return { ok: false, code: 'E_MEMORY_UNAVAILABLE' }
    }
    const all = normalize(messages)
    if (!all.length) {
      stats.skipped += 1
      return { ok: false, code: 'E_EMPTY' }
    }
    const id = `group:${groupId}:${at}`
    // memory-core 的 saveGroupTranscript 仍按旧接口要求一个 header；桥没有 agent header，
  // 这里传一个合成 header 只为过校验，归档仍落到 memory-core 的 GROUP_CWD（渠道/qq-群）。
  const base = {
    groupName: String(groupName ?? ''), groupId: String(groupId ?? ''), at, messageId: id,
    header: { id: `group-archive:${groupId}:${at}`, cwd: '/sdcard/DSHA/渠道/qq-群' },
  }
    inflight = true
    const out = { ok: true, messageId: id, count: all.length, digest: null, transcript: null }
    try {
      // 旧摘要路径：代码保留、默认不再调用（写 public + 需要 header，桥没有 header）
      if (canDigest && !DIGEST_RETIRED) {
        try {
          const res = await memory.saveGroupDigest({ ...base, messages: all.slice(-10) })
          stats.saved += 1
          stats.lastAt = at
          out.digest = { ok: true, count: Math.min(10, all.length) }
          log?.info?.(`[channel-bridge] 群摘要已送 home：${groupId}（${Math.min(10, all.length)} 条，memory=${res?.ok === false ? 'not-ok' : 'ok'}）`)
        } catch (error) {
          stats.failed += 1
          stats.lastError = error?.message ?? String(error)
          out.digest = { ok: false, code: 'E_DIGEST_FAILED' }
          log?.warn?.(`[channel-bridge] 群摘要保存失败（不影响归档/投递）：${stats.lastError}`)
        }
      }
      if (canTranscript) {
        try {
          const res = await memory.saveGroupTranscript({ ...base, messages: all })
          stats.transcriptSaved += 1
          out.transcript = { ok: true, count: all.length, archived: Number(res?.archived ?? 0) }
          log?.info?.(`[channel-bridge] 群全文归档：${groupId}（${all.length} 条，仅记忆库，不进 home 上下文）`)
        } catch (error) {
          stats.transcriptFailed += 1
          stats.lastError = error?.message ?? String(error)
          out.transcript = { ok: false, code: 'E_TRANSCRIPT_FAILED' }
          log?.warn?.(`[channel-bridge] 群全文归档失败（不阻断）：${stats.lastError}`)
        }
      }
      // 只要调用过的能力里有一个成功就算成功；全失败才算整体失败
      const attempted = [out.digest, out.transcript].filter(Boolean)
      out.ok = attempted.length ? attempted.some((x) => x.ok) : false
      return out
    } finally {
      inflight = false
    }
  }

  return { save, stats }
}
