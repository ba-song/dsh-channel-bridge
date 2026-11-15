/**
 * 假在线检测：连接 opened=true、心跳也正常，但对端不推消息（2026-11-06 12:03 事故）。
 *
 * - `lastMessageAt` 只在 **message 事件** 时更新（meta/heartbeat 不算）；
 * - 状态：`DOWN`（未连）> `SILENT`（已连、≥silentMs 无 message 且有入站历史）> `OK`；
 * - SILENT 时**强制重连**：立即一次；仍然静默就**每 silentMs 再来一次**。
 *   2026-11-07 18:30 事故后放宽：原先「只强连一次」，一次没救回来就只告警，
 *   假在线会一直拖到对端下次主动推消息为止（当天拖了 31 分钟才自愈）。
 * - 强连失败（forceReconnect 返回 false）按 retryMs（默认 5 分钟）后再试，避免卡死。
 * - 收到任意 message 后计时与强连节拍一起重置。
 */
export function createHealth({
  silentMs = 30 * 60 * 1000,
  warnEveryMs = 5 * 60 * 1000,
  retryMs = 5 * 60 * 1000,
  now = () => Date.now(),
  log = null,
  hasHistory = () => false,
  forceReconnect = () => false,
} = {}) {
  const stats = { lastMessageAt: 0, forcedReconnects: 0, lastWarnAt: 0 }
  let nextForceAt = 0

  function noteMessage() {
    stats.lastMessageAt = now()
    nextForceAt = 0
  }

  function status({ opened = false } = {}) {
    if (!opened) return 'DOWN'
    if (!stats.lastMessageAt) return 'OK'
    if (!hasHistory()) return 'OK'
    return now() - stats.lastMessageAt >= silentMs ? 'SILENT' : 'OK'
  }

  function silentSince() {
    return stats.lastMessageAt ? stats.lastMessageAt + silentMs : null
  }

  /** 周期调用：SILENT 就强连（立即一次，之后每 silentMs 一次；失败 retryMs 后重试）。 */
  function check({ opened = false } = {}) {
    const s = status({ opened })
    if (s !== 'SILENT') return { status: s, forced: false }
    if (now() >= nextForceAt) {
      stats.forcedReconnects += 1
      const ok = forceReconnect() === true
      nextForceAt = now() + (ok ? silentMs : Math.max(60000, Number(retryMs) || 300000))
      log?.warn?.(
        `[channel-bridge] 假在线：${Math.round((now() - stats.lastMessageAt) / 60000)} 分钟没有 message 事件（meta/心跳正常），第 ${stats.forcedReconnects} 次强制重连${ok ? '' : '失败'}`,
      )
      return { status: s, forced: true, ok, count: stats.forcedReconnects }
    }
    if (now() - stats.lastWarnAt >= warnEveryMs) {
      stats.lastWarnAt = now()
      log?.warn?.(
        `[channel-bridge] 仍在静默：已强连 ${stats.forcedReconnects} 次仍无 message 事件，${Math.max(1, Math.round((nextForceAt - now()) / 60000))} 分钟后再次强连`,
      )
    }
    return { status: s, forced: false }
  }

  return { noteMessage, status, silentSince, check, stats }
}
