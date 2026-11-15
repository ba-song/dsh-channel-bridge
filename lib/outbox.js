/**
 * 掉线兜底：发不出去的原文留底到 `/root/.dsh/dsh-channel-bridge-outbox.log`。
 * - 0600；每行 `ISO时间\tcontact\tkind\t原文`
 * - 只有「私聊主人」才留原文；群聊/他人只留长度（隐私）
 * - 5MB 轮转 `.1`（只留一份）
 */
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const oneLine = (s) => String(s ?? '').replace(/\r?\n/g, '\\n')

export function createOutbox({ file = '/root/.dsh/dsh-channel-bridge-outbox.log', maxBytes = 5 * 1024 * 1024, now = () => new Date(), io = null } = {}) {
  const fsm = io ?? { appendFileSync, chmodSync, mkdirSync, renameSync, statSync }
  let size = -1
  let disabled = false

  return {
    file,
    /** @returns {boolean} 真写进去了没有 */
    write({ contact, kind = 'private', text, ownerIds = [], code = '' } = {}) {
      if (disabled || !file) return false
      const owner = kind === 'private' && (ownerIds ?? []).map(String).includes(String(contact))
      const body = owner ? oneLine(text) : `(len=${[...String(text ?? '')].length})`
      const line = `${now().toISOString()}\t${contact}\t${kind}\t${body}${code ? `\t${code}` : ''}\n`
      try {
        const bytes = Buffer.byteLength(line)
        if (size < 0) {
          try {
            size = fsm.statSync(file).size
          } catch {
            size = 0
          }
        }
        if (size + bytes > maxBytes) {
          try {
            fsm.renameSync(file, `${file}.1`)
          } catch {}
          size = 0
        }
        try {
          fsm.mkdirSync(dirname(file), { recursive: true })
        } catch {}
        fsm.appendFileSync(file, line, { mode: 0o600 })
        try {
          fsm.chmodSync(file, 0o600)
        } catch {}
        size += bytes
        return true
      } catch {
        disabled = true
        return false
      }
    },
  }
}
