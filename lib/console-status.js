/** 汐控制台状态（只读）：读 persona/memory/autonomy SQLite，拼给 GUI。 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const open = (p) => {
  try { if (!existsSync(p)) return null; return new DatabaseSync(p, { readOnly: true }) } catch { return null }
}
const safe = (fn, fallback = null) => { try { return fn() } catch { return fallback } }

export function collectStatus({ dataRoot = '/sdcard/DSHA' } = {}) {
  const persona = open(join(dataRoot, '人格/数据/persona.db'))
  const memory = open(join(dataRoot, '记忆/数据/memory.db'))
  const autonomy = open(join(dataRoot, '生活/数据/autonomy.db'))
  const out = { at: Date.now(), persona: null, memory: null, life: null }
  try {
    if (persona) {
      const st = safe(() => persona.prepare('SELECT valence,arousal,label,intensity,energy,social,dominance,mood_valence,mood_arousal,updated_at FROM emotion_state LIMIT 1').get())
      const eps = safe(() => persona.prepare("SELECT emotion,intensity,target,cause,at,expires_at FROM emotion_episodes WHERE expires_at > ? ORDER BY at DESC LIMIT 5").all(Date.now()))
      const axes = safe(() => persona.prepare('SELECT axis,value FROM character_axes LIMIT 8').all())
      const grievances = safe(() => persona.prepare("SELECT id,cause,severity,repeat_count FROM grievances WHERE status='open' LIMIT 5").all())
      out.persona = { state: st ?? null, episodes: eps ?? [], axes: axes ?? [], grievances: grievances ?? [] }
      persona.close()
    }
    if (memory) {
      const count = safe(() => memory.prepare("SELECT count(*) c FROM memories WHERE status='active'").get()?.c, 0)
      const shortterm = safe(() => memory.prepare('SELECT kind,content,importance,expires_at FROM shortterm ORDER BY importance DESC LIMIT 5').all())
      const profile = safe(() => memory.prepare('SELECT speaker_id,summary FROM profiles LIMIT 1').get())
      const lastRun = safe(() => memory.prepare("SELECT v FROM meta WHERE k='consolidate.lastRun'").get()?.v)
      out.memory = { active: Number(count) || 0, shortterm: shortterm ?? [], profile: profile ?? null, lastConsolidate: lastRun ?? null }
      memory.close()
    }
    if (autonomy) {
      const drives = safe(() => autonomy.prepare('SELECT name,value FROM drives').all())
      const home = safe(() => autonomy.prepare('SELECT home_session_id,prompt_tokens,context_window FROM home_sessions LIMIT 1').get())
      const lastWake = safe(() => autonomy.prepare("SELECT value FROM meta WHERE key='home.lastWake'").get()?.value)
      const actions = safe(() => autonomy.prepare('SELECT kind,created_at,status FROM actions ORDER BY id DESC LIMIT 5').all())
      out.life = { drives: drives ?? [], home: home ?? null, lastWake: lastWake ?? null, actions: actions ?? [] }
      autonomy.close()
    }
  } catch {}
  return out
}
