/** 把回复 POST 回 xchatbot `/openclaw/outbound`。 */

// Worker 前面的 Cloudflare 会拦没有浏览器 UA 的请求（error 1010）。
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const SILENCE = /^\s*NO_REPLY\s*$/gim

/** 去掉静默标记，整理空行。剩下空串就是「不用回」。 */
export function cleanReply(text) {
  return String(text || '')
    .replace(SILENCE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * @param {{ baseUrl: string, token: string, timeoutMs: number }} target
 * @param {{ platform: string, source: string, from: string, roomId: string, messageId: string }} route
 * @param {string} text
 */
export async function postText(target, route, text) {
  const base = String(target.baseUrl || '').trim().replace(/\/+$/u, '')
  if (!base || !target.token) throw new Error('xchatbot address or token is not configured')
  const body = {
    platform: route.platform,
    source: route.source === 'group' ? 'group' : 'private',
    from: route.from,
    roomId: route.roomId || null,
    messageId: route.messageId || null,
    replies: [{ type: 'text', content: text }],
  }
  const response = await fetch(`${base}/openclaw/outbound`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.token}`,
      'Content-Type': 'application/json',
      'User-Agent': BROWSER_UA,
      Accept: 'application/json, text/plain, */*',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(target.timeoutMs),
  })
  const raw = await response.text()
  let parsed = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    // 不是 JSON，下面按状态码报
  }
  if (!response.ok || parsed?.ok !== true) {
    const detail = typeof parsed?.error === 'string' ? parsed.error : raw.slice(0, 200)
    throw new Error(`outbound HTTP ${response.status}: ${detail || 'failed'}`)
  }
}
