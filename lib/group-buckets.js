/** 每个群独立的跟话窗口 + 摘要 buffer（group:<群号>）。 */
import { createFollowUpWindow } from './group-followup.js'

export function createGroupBuckets({ digest = null, log = null, messages = 8, idleMs = 600000, createWindow = createFollowUpWindow } = {}) {
  const map = new Map()

  function get(groupId, groupName = '') {
    const key = `group:${String(groupId ?? '')}`
    let b = map.get(key)
    if (!b) {
      b = { key, messages: [], meta: { groupId: String(groupId ?? ''), groupName: String(groupName ?? '') } }
      b.window = createWindow({
        messages,
        idleMs,
        log,
        onClose: ({ reason, at }) => {
          const list = b.messages.slice()
          const { groupId: gid, groupName: gname } = b.meta
          b.messages = []
          void digest?.save?.({ groupId: gid, groupName: gname, messages: list, at, reason })
        },
      })
      map.set(key, b)
    }
    if (groupName) b.meta.groupName = String(groupName)
    return b
  }

  function noteMessage(bucket, msg) {
    if (!bucket?.window?.status().open) return
    bucket.messages.push({ speaker: msg.speaker, text: msg.text, at: msg.at })
    if (bucket.messages.length > 20) bucket.messages.shift()
  }

  return {
    get,
    noteMessage,
    anyOpen: () => [...map.values()].some((b) => b.window.status().open),
    keys: () => [...map.keys()],
    size: () => map.size,
    _map: map,
  }
}
