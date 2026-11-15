/** 关系四维与沉默策略（2026-11-13，默认关）：只是策略函数，不写库。 */
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))

export function deriveRelationship(row = {}, { isOwner = false, now = Date.now() } = {}) {
  const count = Math.max(0, Number(row?.msg_count) || 0)
  const familiarity = clamp01(row?.familiarity ?? 0.2 + 0.04 * count)
  const closeness = clamp01(row?.closeness ?? (isOwner ? 0.55 : 0.25) + familiarity * 0.45)
  const trust = clamp01(row?.trust ?? (isOwner ? 0.85 : 0.35) + familiarity * 0.2)
  const respect = clamp01(row?.respect ?? (isOwner ? 0.7 : 0.5))
  return { familiarity, closeness, trust, respect, msgCount: count, lastSeenAt: Number(row?.last_seen_at) || 0 }
}

export function classifyTier(dims, { isOwner = false } = {}) {
  if (isOwner) return 'owner'
  if (dims.closeness >= 0.75 && dims.trust >= 0.65) return 'close'
  if (dims.closeness >= 0.5 && dims.trust >= 0.45) return 'friend'
  if (dims.familiarity >= 0.35) return 'acquaintance'
  return 'stranger'
}

/**
 * 沉默策略：返回是否不回。
 * 只在 cfg.enabled && cfg.silence.enabled 时生效；主人永不沉默。
 */
export function silenceDecision({ row = null, isOwner = false, kind = 'private', mentioned = false, cfg = {}, now = Date.now() } = {}) {
  const c = cfg?.silence ?? cfg ?? {}
  if (cfg?.enabled !== true || c.enabled !== true) return { silent: false, reason: 'off' }
  if (isOwner) return { silent: false, reason: 'owner' }
  const dims = deriveRelationship(row, { isOwner, now })
  const tier = classifyTier(dims, { isOwner })
  if (kind === 'group') {
    if (mentioned) return { silent: false, reason: 'mentioned', tier }
    if (dims.closeness < Number(c.groupClosenessMin ?? 0.45)) return { silent: true, reason: 'group-cold', tier }
    return { silent: false, reason: 'group-warm', tier }
  }
  if (dims.trust < Number(c.privateTrustMin ?? 0.35)) return { silent: true, reason: 'private-low-trust', tier }
  return { silent: false, reason: 'private-ok', tier }
}
