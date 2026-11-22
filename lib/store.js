/**
 * 桥自己的 SQLite（`bridge.db`）：三张表 + 幂等迁移（v1 → v2）。
 * 只用 node:sqlite 的 DatabaseSync；不碰 persona/memory/autonomy/qq 的库。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channel_sessions (
  channel          TEXT,
  kind             TEXT,
  session_id       TEXT,
  prev_session_id  TEXT,
  cwd              TEXT,
  kinds            TEXT,
  created_at       INTEGER,
  rotated_at       INTEGER,
  briefed_at       INTEGER,
  prompt_tokens    INTEGER,
  context_window   INTEGER,
  handoff_text     TEXT,
  PRIMARY KEY (channel, kind)
);
CREATE TABLE IF NOT EXISTS channel_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER,
  channel     TEXT,
  kind        TEXT,
  contact     TEXT,
  sender_id   TEXT,
  direction   TEXT,
  text        TEXT,
  text_len    INTEGER,
  meta        TEXT,
  message_id  TEXT,
  session_id  TEXT
);
CREATE TABLE IF NOT EXISTS qq_ops (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER,
  action  TEXT,
  fields  TEXT,
  ok      INTEGER,
  error   TEXT
);
CREATE TABLE IF NOT EXISTS bridge_meta (
  key   TEXT PRIMARY KEY,
  value TEXT,
  at    INTEGER
);
CREATE TABLE IF NOT EXISTS channel_mirror (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER,
  channel     TEXT,
  kind        TEXT,
  contact     TEXT,
  session_id  TEXT,
  seg         INTEGER,
  text        TEXT
);
CREATE TABLE IF NOT EXISTS channel_contacts (
  channel        TEXT,
  contact        TEXT,
  kind           TEXT,
  name           TEXT,
  first_seen_at  INTEGER,
  last_seen_at   INTEGER,
  last_replay_id TEXT,
  msg_count      INTEGER NOT NULL DEFAULT 0,
  familiarity    REAL NOT NULL DEFAULT 0.5,
  closeness      REAL NOT NULL DEFAULT 0.5,
  trust          REAL NOT NULL DEFAULT 0.5,
  respect        REAL NOT NULL DEFAULT 0.5,
  PRIMARY KEY (channel, contact, kind)
);
CREATE TABLE IF NOT EXISTS deliveries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_id    TEXT,
  msg_key    TEXT,
  channel    TEXT,
  state      TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER,
  updated_at INTEGER
);
`

// v2 补列（一阶段建的老库也能原地升级）
const V2_COLUMNS = {
  channel_events: [
    ['kind', 'TEXT'],
    ['sender_id', 'TEXT'],
    ['text_len', 'INTEGER'],
    ['meta', 'TEXT'],
    ['message_id', 'TEXT'],
  ],
  channel_sessions: [
    ['prev_session_id', 'TEXT'],
    ['kinds', 'TEXT'],
    ['briefed_at', 'INTEGER'],
    ['rotated_at', 'INTEGER'],
    ['prompt_tokens', 'INTEGER'],
    ['context_window', 'INTEGER'],
    ['handoff_text', 'TEXT'],
  ],
  channel_contacts: [
    ['msg_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['familiarity', 'REAL NOT NULL DEFAULT 0.5'],
    ['closeness', 'REAL NOT NULL DEFAULT 0.5'],
    ['trust', 'REAL NOT NULL DEFAULT 0.5'],
    ['respect', 'REAL NOT NULL DEFAULT 0.5'],
  ],
}

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_channel_events_lookup ON channel_events(channel, direction, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_channel_events_msgid  ON channel_events(message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_channel_contacts_seen ON channel_contacts(channel, last_seen_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_peer ON deliveries(peer_id, id DESC)`,
  // 2026-11-16（方案 A14）：同 (peer,msg_key) 只允许一条「未发出」交付；
  // 已 sent/failed/interrupted 不占名额，所以同一个 key 事后仍可重发。
  `CREATE UNIQUE INDEX IF NOT EXISTS one_inflight ON deliveries(peer_id, msg_key)
     WHERE state IN ('thinking','generated','queued')`,
]

/** 交付五态（照 Anima calls.py:343-352 的 call_turns 语义；interrupted 与 failed 并列终态）。 */
export const KNOWN_STATES = new Set(['thinking', 'generated', 'queued', 'sent', 'interrupted', 'failed'])
/** 「还没发出去」的三态：同 (peer_id, msg_key) 之间互斥，由部分唯一索引兜底。 */
export const INFLIGHT = new Set(['thinking', 'generated', 'queued'])

/** 幂等：缺列才 ALTER（重复跑无副作用）。 */
/** v2 → v3：channel_sessions 从「每渠道一行」变「每渠道+kind 一行」（私聊/群分房）。 */
export function migrateSessionsKind(db) {
  let cols
  try {
    cols = db.prepare(`PRAGMA table_info(channel_sessions)`).all()
  } catch {
    return
  }
  if (cols.some((c) => c.name === 'kind')) return
  try {
    db.exec('ALTER TABLE channel_sessions RENAME TO channel_sessions_v2')
    db.exec(`CREATE TABLE channel_sessions (
      channel TEXT, kind TEXT, session_id TEXT, prev_session_id TEXT, cwd TEXT, kinds TEXT,
      created_at INTEGER, rotated_at INTEGER, briefed_at INTEGER,
      prompt_tokens INTEGER, context_window INTEGER, handoff_text TEXT, PRIMARY KEY (channel, kind))`)
    db.exec(`INSERT OR IGNORE INTO channel_sessions(channel,kind,session_id,prev_session_id,cwd,kinds,created_at,rotated_at,briefed_at)
             SELECT channel,'private',session_id,prev_session_id,cwd,kinds,created_at,rotated_at,briefed_at FROM channel_sessions_v2`)
    db.exec('DROP TABLE channel_sessions_v2')
  } catch {}
}

export function migrate(db) {
  for (const [table, cols] of Object.entries(V2_COLUMNS)) {
    if (!cols.length) continue
    let have
    try {
      have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name))
    } catch {
      continue
    }
    for (const [name, type] of cols) {
      if (have.has(name)) continue
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
      } catch {}
    }
  }
  migrateSessionsKind(db)
  for (const sql of INDEXES) {
    try {
      db.exec(sql)
    } catch {}
  }
  try {
    db.exec(`UPDATE channel_events SET kind='unknown' WHERE kind IS NULL`)
  } catch {}
}

export function openBridgeDb(path = ':memory:', { log = null } = {}) {
  if (path !== ':memory:') {
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch {}
  }
  const db = new DatabaseSync(path)
  if (path !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL')
    } catch {}
  }
  try {
    db.exec('PRAGMA busy_timeout = 3000')
  } catch {}
  db.exec(SCHEMA)
  migrate(db)

  const j = (v) => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v))

  return {
    db,
    available: () => true,
    raw: db,

    insertEvent(row = {}) {
      const info = db
        .prepare(
          `INSERT INTO channel_events(at, channel, kind, contact, sender_id, direction, text, text_len, meta, message_id, session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          Number(row.at ?? Date.now()),
          String(row.channel ?? 'qq'),
          row.kind === undefined || row.kind === null ? 'unknown' : String(row.kind),
          String(row.contact ?? ''),
          row.senderId === undefined || row.senderId === null ? null : String(row.senderId),
          String(row.direction ?? 'in'),
          row.text === undefined || row.text === null ? null : String(row.text),
          row.textLen === undefined || row.textLen === null ? null : Number(row.textLen),
          j(row.meta),
          row.messageId === undefined || row.messageId === null ? null : String(row.messageId),
          row.sessionId === undefined || row.sessionId === null ? null : String(row.sessionId),
        )
      return Number(info.lastInsertRowid)
    },

    /** 入站行回填 session_id（按 message_id 找最近一条 in）。 */
    updateEventSession(messageId, sessionId) {
      if (!messageId) return 0
      try {
        const info = db
          .prepare(
            `UPDATE channel_events SET session_id=? WHERE id=(SELECT id FROM channel_events WHERE message_id=? AND direction='in' ORDER BY id DESC LIMIT 1)`,
          )
          .run(String(sessionId), String(messageId))
        return Number(info.changes ?? 0)
      } catch {
        return 0
      }
    },

    recentInbound(channel, sinceMs, limit = 200) {
      return db
        .prepare(
          `SELECT id, at, channel, kind, contact, sender_id, text, message_id
             FROM channel_events
            WHERE channel=? AND direction='in' AND at>=?
            ORDER BY at DESC LIMIT ?`,
        )
        .all(String(channel), Number(sinceMs), Number(limit))
    },

    upsertContact({ channel = 'qq', contact, kind = 'private', name = '', at = Date.now(), isOwner = false } = {}) {
      // 2026-11-13：关系四维（熟悉/亲近/信任/尊重）；只由真实入站累积，默认仅供策略读取
      let prev = null
      try { prev = db.prepare('SELECT msg_count FROM channel_contacts WHERE channel=? AND contact=? AND kind=?').get(String(channel), String(contact), String(kind)) } catch {}
      const count = Number(prev?.msg_count ?? 0) + 1
      const familiarity = Math.min(1, 0.2 + 0.04 * count)
      const closeness = Math.min(1, (isOwner ? 0.55 : 0.25) + familiarity * 0.45)
      const trust = Math.min(1, (isOwner ? 0.85 : 0.35) + familiarity * 0.2)
      const respect = isOwner ? 0.7 : 0.5
      db.prepare(
        `INSERT INTO channel_contacts(channel, contact, kind, name, first_seen_at, last_seen_at, msg_count, familiarity, closeness, trust, respect)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, contact, kind) DO UPDATE SET
           name        = CASE WHEN excluded.name <> '' THEN excluded.name ELSE channel_contacts.name END,
           last_seen_at = MAX(channel_contacts.last_seen_at, excluded.last_seen_at),
           msg_count   = excluded.msg_count,
           familiarity = excluded.familiarity,
           closeness   = excluded.closeness,
           trust       = excluded.trust,
           respect     = excluded.respect`,
      ).run(String(channel), String(contact), String(kind), String(name ?? ''), Number(at), Number(at), count, familiarity, closeness, trust, respect)
    },

    contactOf(channel, contact, kind) {
      return (
        db
          .prepare(`SELECT * FROM channel_contacts WHERE channel=? AND contact=? AND kind=?`)
          .get(String(channel), String(contact), String(kind)) ?? null
      )
    },

    listContacts(channel) {
      return db
        .prepare(`SELECT * FROM channel_contacts WHERE channel=? ORDER BY last_seen_at DESC`)
        .all(String(channel))
    },

    /** 交接用：since 之后的入站行（只取有正文的）。 */
    listInboundSince({ channel = 'qq', sinceMs = 0, limit = 2000 } = {}) {
      try {
        return db
          .prepare(
            `SELECT id, at, kind, contact, text, message_id FROM channel_events
              WHERE channel=? AND direction='in' AND at>=? AND text IS NOT NULL AND TRIM(text)<>''
              ORDER BY at ASC LIMIT ?`,
          )
          .all(String(channel), Number(sinceMs), Number(limit))
      } catch {
        return []
      }
    },

    /** 补收去重：这个 message_id 见过没有。 */
    hasMessageId(messageId) {
      if (!messageId) return false
      try {
        return Boolean(db.prepare(`SELECT 1 AS ok FROM channel_events WHERE message_id=? LIMIT 1`).get(String(messageId)))
      } catch {
        return false
      }
    },

    /** 推进联系人游标（只增不减），并记下这次补收到的 message_id。 */
    markContactSeen({ channel = 'qq', contact, kind = 'private', at = 0, replayId = null } = {}) {
      try {
        db.prepare(
          `UPDATE channel_contacts
              SET last_seen_at   = MAX(COALESCE(last_seen_at, 0), ?),
                  last_replay_id = COALESCE(?, last_replay_id)
            WHERE channel=? AND contact=? AND kind=?`,
        ).run(Number(at) || 0, replayId === null ? null : String(replayId), String(channel), String(contact), String(kind))
      } catch {}
    },

    /** 最近 N 条入站（按时间正序返回）；必须限定单一 Conversation。 */
    recentInboundAsc({ channel, kind, contact, limit = 10 } = {}) {
      // Missing scope must never degrade to channel-wide history.
      if (!channel || !['private', 'group'].includes(String(kind)) || contact === undefined || contact === null || String(contact).trim() === '') return []
      try {
        const rows = db
          .prepare(`SELECT id, at, kind, contact, sender_id, text
                     FROM channel_events
                    WHERE channel=? AND kind=? AND contact=? AND direction='in'
                    ORDER BY at DESC, id DESC LIMIT ?`)
          .all(String(channel), String(kind), String(contact), Math.max(0, Number(limit) || 0))
        return rows.reverse()
      } catch {
        return []
      }
    },

    /** 镜像兜底：宿主 append 不可用时，把「本该显示在对话页」的原文存这儿。 */
    insertMirror({ at = Date.now(), channel = 'qq', kind = 'private', contact = '', sessionId = null, seg = 0, text = '' } = {}) {
      const info = db
        .prepare(`INSERT INTO channel_mirror(at, channel, kind, contact, session_id, seg, text) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(Number(at), String(channel), String(kind), String(contact), sessionId === null ? null : String(sessionId), Number(seg), String(text))
      return Number(info.lastInsertRowid)
    },

    listMirror(limit = 20) {
      try {
        return db.prepare(`SELECT * FROM channel_mirror ORDER BY id DESC LIMIT ?`).all(Number(limit))
      } catch {
        return []
      }
    },

    insertQqOp({ at = Date.now(), action = '', fields = '', ok = true, error = null } = {}) {
      try {
        db.prepare(`INSERT INTO qq_ops(at, action, fields, ok, error) VALUES (?, ?, ?, ?, ?)`).run(
          Number(at),
          String(action),
          String(fields),
          ok ? 1 : 0,
          error === null ? null : String(error),
        )
      } catch {}
    },

    listQqOps(limit = 20) {
      try {
        return db.prepare(`SELECT * FROM qq_ops ORDER BY id DESC LIMIT ?`).all(Number(limit))
      } catch {
        return []
      }
    },

    getMeta(key) {
      try {
        return db.prepare(`SELECT value FROM bridge_meta WHERE key=?`).get(String(key))?.value ?? null
      } catch {
        return null
      }
    },

    setMeta(key, value) {
      try {
        db.prepare(`INSERT INTO bridge_meta(key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, at=excluded.at`).run(
          String(key),
          String(value ?? ''),
          Date.now(),
        )
      } catch {}
    },

    updateUsage({ channel = 'qq', kind = 'private', promptTokens = 0, contextWindow = 0 } = {}) {
      try {
        db.prepare(`UPDATE channel_sessions SET prompt_tokens=?, context_window=? WHERE channel=? AND kind=?`).run(
          Number(promptTokens) || 0,
          Number(contextWindow) || 0,
          String(channel),
          String(kind),
        )
      } catch {}
    },

    clearHandoff({ channel = 'qq', kind = 'private' } = {}) {
      try {
        db.prepare(`UPDATE channel_sessions SET handoff_text=NULL WHERE channel=? AND kind=?`).run(String(channel), String(kind))
      } catch {}
    },

    getSession(channel, kind = 'private') {
      // 严格按 (channel, kind)：群聊绝不能落到私聊房间
      return db.prepare(`SELECT * FROM channel_sessions WHERE channel=? AND kind=?`).get(String(channel), String(kind)) ?? null
    },

    /** 列出某渠道的两行（private/group），诊断用。 */
    listSessions(channel) {
      try {
        return db.prepare(`SELECT * FROM channel_sessions WHERE channel=? ORDER BY kind`).all(String(channel))
      } catch {
        return []
      }
    },

    saveSession({ channel = 'qq', kind = 'private', sessionId, cwd, kinds = null, at = Date.now(), prevSessionId = undefined, promptTokens = undefined, contextWindow = undefined, handoffText = undefined, rotated = false } = {}) {
      const k = String(kind)
      const prev = db.prepare(`SELECT * FROM channel_sessions WHERE channel=? AND kind=?`).get(String(channel), k)
      if (prev) {
        db.prepare(
          `UPDATE channel_sessions
              SET session_id=?, cwd=?, kinds=COALESCE(?, kinds),
                  prev_session_id=COALESCE(?, prev_session_id),
                  prompt_tokens=COALESCE(?, prompt_tokens),
                  context_window=COALESCE(?, context_window),
                  handoff_text=CASE WHEN ? IS NULL THEN handoff_text ELSE ? END,
                  rotated_at=CASE WHEN ? THEN ? ELSE rotated_at END
            WHERE channel=? AND kind=?`,
        ).run(
          String(sessionId ?? prev.session_id ?? ''),
          String(cwd ?? prev.cwd ?? ''),
          kinds === null ? null : String(kinds),
          prevSessionId === undefined ? null : String(prevSessionId),
          promptTokens === undefined ? null : Number(promptTokens),
          contextWindow === undefined ? null : Number(contextWindow),
          handoffText === undefined ? null : String(handoffText ?? ''),
          handoffText === undefined ? null : String(handoffText ?? ''),
          rotated ? 1 : 0,
          at,
          String(channel),
          k,
        )
        return
      }
      db.prepare(
        `INSERT INTO channel_sessions(channel, kind, session_id, cwd, kinds, created_at, briefed_at, prev_session_id, prompt_tokens, context_window, handoff_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        String(channel),
        k,
        String(sessionId ?? ''),
        String(cwd ?? ''),
        kinds === null ? null : String(kinds),
        Number(at),
        null,
        prevSessionId === undefined ? null : String(prevSessionId),
        promptTokens === undefined ? null : Number(promptTokens),
        contextWindow === undefined ? null : Number(contextWindow),
        handoffText === undefined ? null : String(handoffText ?? ''),
      )
    },

    // ---------- 交付账本（2026-11-16，方案 P2-2 / A14） ----------
    // 语义照 Anima calls.py 的 call_turns：generated / queued / sent 是三个不同事实，
    // 「已发出」不等于「对方看到」。只记账，不改变发送路径的行为。
    /**
     * 占位一条交付。同 (peerId, msgKey) 已有「未发出」态（thinking/generated/queued）
     * → already:true 且不插新行（调用方据此不重发）；已 sent/failed 允许再插（重发语义）。
     */
    beginDelivery({ peerId = '', msgKey = '', channel = 'qq', state = 'queued', at = Date.now() } = {}) {
      const peer = String(peerId ?? '')
      const key = String(msgKey ?? '')
      const st = String(state ?? 'queued')
      if (!peer || !key) return { ok: false, code: 'E_DELIVERY_KEY' }
      if (!INFLIGHT.has(st)) return { ok: false, code: 'E_DELIVERY_STATE' }
      const live = `('thinking','generated','queued')`
      const pick = () =>
        db
          .prepare(
            `SELECT id,state FROM deliveries WHERE peer_id=? AND msg_key=? AND state IN ${live} ORDER BY id DESC LIMIT 1`,
          )
          .get(peer, key)
      const hit = pick()
      if (hit) return { ok: false, already: true, id: Number(hit.id), state: String(hit.state) }
      let attempts = 1
      try {
        const c = db.prepare(`SELECT COUNT(*) c FROM deliveries WHERE peer_id=? AND msg_key=?`).get(peer, key)
        attempts = Number(c?.c ?? 0) + 1
      } catch {}
      try {
        const info = db
          .prepare(
            `INSERT INTO deliveries(peer_id,msg_key,channel,state,attempts,last_error,created_at,updated_at)
             VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
          )
          .run(peer, key, String(channel ?? 'qq'), st, attempts, Number(at), Number(at))
        return { ok: true, id: Number(info.lastInsertRowid), already: false, state: st, attempts }
      } catch (error) {
        // 跨进程撞唯一索引：回读在途行，当作 already（绝不重发）
        const again = pick()
        if (again) return { ok: false, already: true, id: Number(again.id), state: String(again.state) }
        return { ok: false, code: 'E_DELIVERY_DB', detail: String(error?.message ?? error) }
      }
    },

    /** 原地推进一行状态；error 只在非空时覆盖 last_error（sent 不清空历史错误）。 */
    updateDelivery(id, state, { error = null, at = Date.now() } = {}) {
      const st = String(state ?? '')
      if (!KNOWN_STATES.has(st)) return { ok: false, code: 'E_DELIVERY_STATE' }
      const err = error === null || error === undefined ? '' : String(error).slice(0, 500)
      try {
        const info = db
          .prepare(
            `UPDATE deliveries SET state=?, updated_at=?,
               last_error = CASE WHEN ?='' THEN last_error ELSE ? END
             WHERE id=?`,
          )
          .run(st, Number(at), err, err, Number(id))
        return { ok: true, id: Number(id), state: st, changes: Number(info.changes ?? 0) }
      } catch (error) {
        return { ok: false, code: 'E_DELIVERY_DB', detail: String(error?.message ?? error) }
      }
    },

    /** 某 (peer,key) 的最新一条交付行（没有返回 null）。 */
    getDelivery({ peerId = '', msgKey = '' } = {}) {
      try {
        const row = db
          .prepare(`SELECT * FROM deliveries WHERE peer_id=? AND msg_key=? ORDER BY id DESC LIMIT 1`)
          .get(String(peerId ?? ''), String(msgKey ?? ''))
        return row ? { ...row } : null
      } catch {
        return null
      }
    },

    listDeliveries({ peerId = null, limit = 20 } = {}) {
      try {
        const n = Math.max(1, Math.min(200, Number(limit) || 20))
        const rows = peerId
          ? db.prepare(`SELECT * FROM deliveries WHERE peer_id=? ORDER BY id DESC LIMIT ?`).all(String(peerId), n)
          : db.prepare(`SELECT * FROM deliveries ORDER BY id DESC LIMIT ?`).all(n)
        return rows.map((r) => ({ ...r }))
      } catch {
        return []
      }
    },

    deliveryCounts() {
      const out = { total: 0 }
      for (const s of KNOWN_STATES) out[s] = 0
      try {
        for (const r of db.prepare(`SELECT state, COUNT(*) c FROM deliveries GROUP BY state`).all()) {
          const k = String(r.state ?? '')
          out[k] = Number(r.c ?? 0)
          out.total += Number(r.c ?? 0)
        }
      } catch {}
      return out
    },

    counts() {
      const one = (sql) => {
        try {
          return Number(db.prepare(sql).get()?.c ?? 0)
        } catch {
          return 0
        }
      }
      return {
        events: one(`SELECT COUNT(*) c FROM channel_events`),
        inbound: one(`SELECT COUNT(*) c FROM channel_events WHERE direction='in'`),
        out: one(`SELECT COUNT(*) c FROM channel_events WHERE direction='out'`),
        silent: one(`SELECT COUNT(*) c FROM channel_events WHERE direction='silent'`),
        contacts: one(`SELECT COUNT(*) c FROM channel_contacts`),
        sessions: one(`SELECT COUNT(*) c FROM channel_sessions`),
        mirror: one(`SELECT COUNT(*) c FROM channel_mirror`),
      }
    },

    close() {
      try {
        db.close()
      } catch {}
    },
  }
}
