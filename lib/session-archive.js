/** 读宿主会话档案（多帧 zstd 的 session.v4.jsonl.zstd，或未压缩的 session.v4.jsonl）。 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function splitFrames(buf) {
  const out = []
  let i = 0
  while (i < buf.length - 4) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      let j = i + 4
      while (j < buf.length - 4 && !(buf[j] === MAGIC[0] && buf[j + 1] === MAGIC[1] && buf[j + 2] === MAGIC[2] && buf[j + 3] === MAGIC[3])) j += 1
      out.push(buf.subarray(i, j))
      i = j
    } else i += 1
  }
  return out
}

export function decodeSessionFile(file, { readFile = readFileSync } = {}) {
  const buf = readFile(file)
  if (file.endsWith('.zstd')) {
    let text = ''
    for (const frame of splitFrames(buf)) {
      try {
        text += zlib.zstdDecompressSync(frame).toString('utf8')
      } catch {}
    }
    return text
  }
  return buf.toString('utf8')
}

/** 在 sessionsRoot 下按 sessionId 找档案并解析成事件数组。 */
export function readSessionEvents({ sessionsRoot = '/root/.dsh/sessions', sessionId, fs = null, log = null } = {}) {
  const io = fs ?? { readdirSync, existsSync, readFileSync, join }
  try {
    if (!sessionId || !io.existsSync(sessionsRoot)) return []
    for (const group of io.readdirSync(sessionsRoot)) {
      const dir = join(sessionsRoot, group, sessionId)
      if (!io.existsSync(dir)) continue
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const file = join(dir, name)
        if (!io.existsSync(file)) continue
        const text = decodeSessionFile(file, { readFile: io.readFileSync })
        return text
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line)
            } catch {
              return null
            }
          })
          .filter((e) => e && typeof e === 'object')
      }
    }
  } catch (error) {
    log?.warn?.(`[channel-bridge] 读会话档案失败：${error?.message ?? error}`)
  }
  return []
}
