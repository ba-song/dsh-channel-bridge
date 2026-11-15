import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBridgeStatus } from '../lib/status.js'
import { createHealth } from '../lib/health.js'

const T0 = Date.parse('2026-11-06T04:00:00Z')
function deps({ opened = true, silent = false } = {}) {
  let t = T0
  const health = createHealth({ now: () => t, hasHistory: () => true, forceReconnect: () => true })
  health.noteMessage()
  if (silent) t += 31 * 60 * 1000
  return {
    clientStatus: { opened, connects: 1, messages: 2, lastEventAt: T0 },
    mode: { current: () => 'send' },
    cfg: { agentPreset: 'standard', outboxFile: '/tmp/o.log', dbPath: '/tmp/b.db' },
    log: { counters: { events: 5, inbound: 2, echoSkipped: 1, groupMentionSkipped: 3, cardSkipped: 2 } },
    router: { stats: { delivered: 1, deliverFail: 0 }, pending: () => 0 },
    store: {
      counts: () => ({ out: 3, inbound: 2, events: 5 }),
      getSession: () => ({ session_id: 'S1' }),
    },
    media: { stats: { saved: 0, failed: 0 } },
    replay: { stats: { delivered: 0, fetched: 0, skipped: 0, failed: 0, selfSkipped: 0, skippedAnswered: 0, alreadyReplied: 0 } },
    replayCounters: { homeDelivered: 0, legacyDelivered: 0, dupSkipped: 0 },
    handover: { alreadyDone: () => false, stats: { chars: 0, error: null } },
    unified: { stats: { delivered: 0 } },
    mirror: { stats: { hostOk: true, lastReason: null, host: 0, db: 0, failed: 0 } },
    auto: null,
    sessions: { stats: { lastPreset: 'standard' } },
    health,
    reconcile: { runs: 2, delivered: 1, skipped: 0, failed: 0, lastAt: T0, lastError: null },
    followUp: { open: true },
    sessionKeys: ['group:***0948', 'private:***0080'],
  }
}

test('status 含 health 四字段', () => {
  const s = buildBridgeStatus(deps())
  assert.ok(s.health, 'health 字段必须存在')
  assert.deepEqual(Object.keys(s.health).sort(), ['forcedReconnects', 'lastMessageAt', 'silentSince', 'status'].sort())
  assert.equal(s.health.status, 'OK')
  assert.equal(s.health.forcedReconnects, 0)
  assert.equal(s.health.lastMessageAt, T0)
  assert.equal(s.health.silentSince, T0 + 30 * 60 * 1000)
})

test('未连 → health.status = DOWN', () => {
  assert.equal(buildBridgeStatus(deps({ opened: false })).health.status, 'DOWN')
})

test('静默 31 分钟 → health.status = SILENT', () => {
  const s = buildBridgeStatus(deps({ silent: true }))
  assert.equal(s.health.status, 'SILENT')
  assert.equal(s.health.lastMessageAt, T0)
})

test('原有字段仍在（防回归）', () => {
  const s = buildBridgeStatus(deps())
  for (const k of ['mode', 'opened', 'events', 'messages', 'delivered', 'outSent', 'sessions', 'replay', 'db', 'unifiedStats', 'handover']) {
    assert.ok(k in s, `缺字段 ${k}`)
  }
  assert.equal(s.sessions.private, 'S1')
  assert.equal(s.echoSkipped, 1)
  assert.equal(s.groupMentionSkipped, 3)
  assert.equal(s.cardSkipped, 2)
  assert.equal(s.reconcile.delivered, 1)
  assert.equal(s.reconcile.lastAt, T0)
  assert.equal(s.groupFollowUpOpen, true)
  assert.deepEqual(s.sessions.keys, ['group:***0948', 'private:***0080'])
})
