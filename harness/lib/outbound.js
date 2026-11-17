/** 把回复 POST 回 xchatbot `/openclaw/outbound`。网络抖就按 OpenClaw 同款间隔重试。 */

// Worker 前面的 Cloudflare 会拦没有浏览器 UA 的请求（error 1010）。
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const SILENCE = /^\s*NO_REPLY\s*$/gim

/** 第一次失败后依次等 3 秒、10 秒、30 秒再试，共 4 次。 */
export const OUTBOUND_RETRY_DELAYS_MS = [3_000, 10_000, 30_000]

/** 网络错误、超时、限流、5xx 和「同一条正在发送」可以重试；4xx 是请求本身有问题，重试没用。 */
export function isRetryableOutboundStatus(status) {
  return status === 409 || status === 429 || status >= 500
}

/** 去掉静默标记，整理空行。剩下空串就是「不用回」。 */
export function cleanReply(text) {
  return String(text || '')
    .replace(SILENCE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * @param {{
 *   url: string,
 *   token: string,
 *   body: string,
 *   timeoutMs?: number,
 *   delaysMs?: number[],
 *   onWarn?: (message: string) => void,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 * }} args
 */
export async function postOutboundWithRetry(args) {
  const delays = args.delaysMs ?? OUTBOUND_RETRY_DELAYS_MS
  const doFetch = args.fetchImpl ?? fetch
  const sleep = args.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const timeoutMs = args.timeoutMs ?? 30_000
  let lastError = 'unknown'

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) await sleep(delays[attempt - 1])
    let retryable = true
    try {
      const response = await doFetch(args.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.token}`,
          'Content-Type': 'application/json',
          'User-Agent': BROWSER_UA,
          Accept: 'application/json, text/plain, */*',
        },
        body: args.body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const rawText = await response.text()
      let parsed = null
      try {
        parsed = rawText ? JSON.parse(rawText) : null
      } catch {
        // 不是 JSON，下面按状态码报
      }
      if (response.ok && parsed?.ok === true) return parsed
      lastError =
        typeof parsed?.error === 'string' ? parsed.error : `HTTP ${response.status}: ${rawText.slice(0, 200) || 'failed'}`
      retryable = isRetryableOutboundStatus(response.status)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    args.onWarn?.(`[xbot] 出站没送成 (${attempt + 1}/${delays.length + 1}): ${lastError}`)
    if (!retryable) break
  }
  throw new Error(lastError)
}

/**
 * @param {{ baseUrl: string, token: string, timeoutMs: number, log?: { warn: (m: string) => void } }} target
 * @param {{ platform: string, source: string, from: string, roomId: string, messageId: string }} route
 * @param {string} text
 */
export async function postText(target, route, text) {
  const base = String(target.baseUrl || '').trim().replace(/\/+$/u, '')
  if (!base || !target.token) throw new Error('xchatbot address or token is not configured')
  const body = JSON.stringify({
    platform: route.platform,
    source: route.source === 'group' ? 'group' : 'private',
    from: route.from,
    roomId: route.roomId || null,
    messageId: route.messageId || null,
    replies: [{ type: 'text', content: text }],
  })
  return postOutboundWithRetry({
    url: `${base}/openclaw/outbound`,
    token: target.token,
    body,
    timeoutMs: target.timeoutMs,
    onWarn: target.log?.warn,
  })
}
