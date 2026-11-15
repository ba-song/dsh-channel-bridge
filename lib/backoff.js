/** 指数退避 + 抖动：1s → 2s → 4s … 封顶 maxMs。 */

export function nextDelay(attempt, { baseMs = 1000, maxMs = 60000, jitter = 0.2, random = Math.random } = {}) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0))
  const safeBase = Math.max(1, Number(baseMs) || 1000)
  const safeMax = Math.max(safeBase, Number(maxMs) || 60000)
  const raw = Math.min(safeMax, safeBase * 2 ** Math.min(n, 20))
  const j = Math.min(1, Math.max(0, Number(jitter) || 0))
  const factor = 1 + (Number(random()) * 2 - 1) * j
  return Math.max(0, Math.round(raw * factor))
}
