/** dy_bridge_status 的返回体（纯函数，便于测试）。 */
export function buildBridgeStatus({
  clientStatus: s = {},
  mode = { current: () => 'observe' },
  cfg = {},
  log = { counters: {} },
  router = { stats: {}, pending: () => 0 },
  store = null,
  media = { stats: {} },
  replay = { stats: {} },
  replayCounters = {},
  handover = null,
  unified = null,
  mirror = null,
  auto = null,
  sessions = { stats: {} },
  health = null,
  reconcile = null,
  followUp = null,
  sessionKeys = null,
} = {}) {
  const c = (() => {
    try {
      return store?.counts?.() ?? {}
    } catch {
      return {}
    }
  })()
  return {
    mode: mode.current(),
    outbound: cfg.outbound,
    mirrorEnabled: cfg.mirror?.enabled === true,
    outbox: cfg.outboxFile,
    unified: cfg.unified,
    handover: handover ? { done: handover.alreadyDone(), chars: handover.stats?.chars ?? 0, error: handover.stats?.error ?? null } : null,
    unifiedStats: unified ? { ...unified.stats } : null,
    mirror: mirror
      ? { ok: mirror.stats.hostOk, reason: mirror.stats.lastReason, host: mirror.stats.host, db: mirror.stats.db, failed: mirror.stats.failed }
      : null,
    auto: cfg.outbound === 'auto' && auto ? { ...auto.stats } : null,
    reconcile: reconcile
      ? {
          runs: reconcile.runs ?? 0,
          delivered: reconcile.delivered ?? 0,
          skipped: reconcile.skipped ?? 0,
          failed: reconcile.failed ?? 0,
          contactSkipped: reconcile.contactSkipped ?? 0,
          backoffSkipped: reconcile.backoffSkipped ?? 0,
          staleSkipped: reconcile.staleSkipped ?? 0,
          // 群对账（与私聊分开计数，老字段语义不变）
          groupFetched: reconcile.groupFetched ?? 0,
          groupNew: reconcile.groupNew ?? 0,
          groupDelivered: reconcile.groupDelivered ?? 0,
          groupSkipped: reconcile.groupSkipped ?? 0,
          groupGateSkipped: reconcile.groupGateSkipped ?? 0,
          groupFailed: reconcile.groupFailed ?? 0,
          groupBackoffSkipped: reconcile.groupBackoffSkipped ?? 0,
          groupParseFail: reconcile.groupParseFail ?? 0,
          lastAt: reconcile.lastAt || null,
          lastError: reconcile.lastError ?? null,
        }
      : null,
    // 假在线检测：DOWN / SILENT / OK
    health: health
      ? {
          status: health.status({ opened: Boolean(s.opened) }),
          lastMessageAt: health.stats.lastMessageAt || null,
          silentSince: health.silentSince(),
          forcedReconnects: health.stats.forcedReconnects,
        }
      : null,
    opened: s.opened,
    attempts: s.attempts,
    connects: s.connects,
    closes: s.closes,
    reconnects: s.reconnects,
    hardResets: s.hardResets,
    heartbeats: s.heartbeats,
    heartbeatFails: s.heartbeatFails,
    lastEventAt: s.lastEventAt || null,
    lastEventAgoMs: s.lastEventAt ? Date.now() - s.lastEventAt : null,
    events: log.counters.events,
    messages: log.counters.inbound,
    echoSkipped: log.counters.echoSkipped ?? 0,
    groupMentionSkipped: log.counters.groupMentionSkipped ?? 0,
    cardSkipped: log.counters.cardSkipped ?? 0,
    groupFollowUpOpen: followUp?.open === true,
    groupFollowUpSkipped: log.counters.groupFollowUpSkipped ?? 0,
    delivered: router.stats.delivered,
    deliverFail: router.stats.deliverFail,
    agentErrors: router.stats.agentErrors ?? 0,
    outSent: c.out ?? 0,
    pending: s.pending,
    queued: router.pending('qq'),
    sessions: {
      private: store?.getSession?.('qq', 'private')?.session_id ?? null,
      group: store?.getSession?.('qq', 'group')?.session_id ?? null,
      agentPreset: cfg.agentPreset || null,
      lastCreatedPreset: sessions.stats?.lastPreset ?? null,
      keys: Array.isArray(sessionKeys) ? sessionKeys : [],
    },
    media: { saved: media.stats.saved, failed: media.stats.failed },
    replay: {
      delivered: replay.stats.delivered,
      fetched: replay.stats.fetched,
      skipped: replay.stats.skipped,
      failed: replay.stats.failed,
      homeDelivered: replayCounters.homeDelivered,
      legacyDelivered: replayCounters.legacyDelivered,
      dupSkipped: replayCounters.dupSkipped,
      selfSkipped: replay.stats.selfSkipped,
      skippedAnswered: replay.stats.skippedAnswered,
      alreadyReplied: replay.stats.alreadyReplied,
    },
    db: { path: cfg.dbPath, ...c },
  }
}
