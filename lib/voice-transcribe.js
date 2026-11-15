/**
 * 语音入站自动转写：只对落地的 wav 调 `dyMedia.transcribe({path})`，
 * 成功返回文字（≤maxChars），失败/服务缺失返回空并 warn（同一条消息只 warn 一次）。
 * 日志只记耗时/ok，不记音频内容或 base64。
 */
export function createVoiceTranscriber({ getMedia = () => null, maxChars = 300, timeoutMs = 20000, log = null } = {}) {
  const stats = { ok: 0, failed: 0, skipped: 0, missing: 0, lastMs: null }
  const done = new Set() // 已处理过的绝对路径，避免重复转写

  async function transcribe(path) {
    const p = String(path ?? '')
    if (!p) return ''
    if (done.has(p)) {
      stats.skipped += 1
      return ''
    }
    done.add(p)
    const service = getMedia?.()
    if (!service || typeof service.transcribe !== 'function') {
      stats.missing += 1
      log?.throttled?.('voice-no-media', '[channel-bridge] dyMedia 未提供 transcribe，语音只保留文件路径')
      return ''
    }
    const t0 = Date.now()
    try {
      const res = await service.transcribe({ path: p })
      const text = String(res?.text ?? res?.transcript ?? '').trim()
      const ms = Date.now() - t0
      stats.lastMs = ms
      if (!text) {
        stats.failed += 1
        log?.warn?.(`[channel-bridge] 语音转写失败（空结果，${ms}ms，path=${p.split('/').pop()}）`)
        return ''
      }
      stats.ok += 1
      log?.info?.(`[channel-bridge] 语音转写成功（${ms}ms，${[...text].length} 字）`)
      return [...text].slice(0, Math.max(1, Number(maxChars) || 300)).join('')
    } catch (error) {
      const ms = Date.now() - t0
      stats.lastMs = ms
      stats.failed += 1
      log?.warn?.(`[channel-bridge] 语音转写失败（${ms}ms）：${error?.code ?? error?.message ?? error}`)
      return ''
    }
  }

  return { transcribe, stats, reset: () => done.clear() }
}
