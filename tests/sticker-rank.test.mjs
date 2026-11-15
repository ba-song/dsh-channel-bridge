import test from 'node:test'
import assert from 'node:assert/strict'
import { rankStickers, STICKER_EMOTIONS, EMOTION_NEIGHBORS } from '../lib/stickers.js'

const items = [
  { name: '委屈要饭.png', emotion: '委屈', scene: '撒娇', tags: ['哭'], desc: '抱着碗眼泪汪汪', lastUsedAt: Date.now() - 86400000 },
  { name: '开心摇尾巴.png', emotion: '开心', scene: '聊天', tags: ['可爱'], desc: '摇尾巴', lastUsedAt: 0 },
  { name: '无语.png', emotion: '无语', scene: '吐槽', tags: [], desc: '' },
]

test('情绪排序：同情绪 > 相邻情绪 > 无关', () => {
  assert.equal(rankStickers(items, { moods: ['委屈'] })[0].emotion, '委屈')
  assert.equal(rankStickers(items, { moods: ['难过'] })[0].emotion, '委屈', '难过→委屈是相邻')
  const no = rankStickers(items, { moods: ['开心'] })[0]
  assert.equal(no.emotion, '开心')
})

test('内容排序 + 18 情绪表完整', () => {
  assert.equal(rankStickers(items, { text: '眼泪 碗' })[0].emotion, '委屈')
  assert.equal(STICKER_EMOTIONS.length, 18)
  for (const e of STICKER_EMOTIONS) assert.ok(Array.isArray(EMOTION_NEIGHBORS[e]), e)
})
