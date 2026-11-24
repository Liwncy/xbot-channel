/**
 * 记忆卡在 xchatbot。这里只按入站带来的版本号去取，拼成系统提示里的那一节。
 * 只放内存：dsh 的启动目录就是 agent 的工作区，落成文件等于把所有聊天的卡摆在它手边。
 */

/** 房间卡和眼前这个人拼成系统提示里的那一节。空的略去。 */
export function composeMemory(roomText, speakerText) {
  return [String(roomText || '').trim(), String(speakerText || '').trim()].filter(Boolean).join('\n\n')
}

/** applied 为 null 表示这个进程里还没拼过：第一次一定当成「变了」，把系统提示对齐到现在。 */
export function emptyMemoryCache() {
  return { roomRev: '', roomText: '', speakers: {}, applied: null }
}

/** 版本和本机记下的不一样，才去向 worker 要正文。 */
export function needsMemoryFetch(cached, incoming) {
  if (!incoming.logSessionId) return false
  if ((incoming.roomRev || '') !== (cached.roomRev || '')) return true
  const speakerId = incoming.speakerId || ''
  if (!speakerId) return false
  const known = cached.speakers?.[speakerId]
  return (incoming.speakerRev || '') !== (known?.rev || '')
}

export function takeMemoryFetch(cached, speakerId, fetched) {
  cached.roomRev = String(fetched?.roomRev || '')
  cached.roomText = String(fetched?.roomText || '')
  if (speakerId) {
    cached.speakers[speakerId] = {
      rev: String(fetched?.speakerRev || ''),
      text: String(fetched?.speakerText || ''),
    }
  }
}

/**
 * 用本机已有的卡拼这一轮：房间卡加这一轮发言人自己的卡，别人的不带。
 * 正文变了就要换掉系统提示那一格。
 */
export function projectMemory(cached, speakerId) {
  const speaker = speakerId ? cached.speakers?.[speakerId] : undefined
  const text = composeMemory(cached.roomText, speaker?.text)
  const series = text !== cached.applied
  cached.applied = text
  return { text, series }
}

export class MemoryBook {
  /**
   * @param {(sessionId: string, speakerId: string) => Promise<{ roomRev: string, roomText: string, speakerRev: string, speakerText: string }>} fetcher
   * @param {{ warn: (message: string) => void }} log
   */
  constructor(fetcher, log) {
    this.fetcher = fetcher
    this.log = log
    this.chats = new Map()
  }

  /** 同一个聊天的轮次本来就排着队，这里不用再加锁。 */
  async prepare(chatId, incoming) {
    let cached = this.chats.get(chatId)
    if (!cached) {
      cached = emptyMemoryCache()
      this.chats.set(chatId, cached)
    }
    const hint = {
      logSessionId: incoming.logSessionId || '',
      roomRev: incoming.roomRev || '',
      speakerId: incoming.speakerId || '',
      speakerRev: incoming.speakerRev || '',
    }
    if (needsMemoryFetch(cached, hint)) {
      try {
        takeMemoryFetch(cached, hint.speakerId, await this.fetcher(hint.logSessionId, hint.speakerId))
      } catch (error) {
        // 没取到就用手头有的：房间卡可能旧一点，这个人没有就不带。绝不沿用上一位发言人的卡。
        this.log.warn(`[xbot] 记忆卡没取到 (${chatId}): ${error?.message ?? error}`)
      }
    }
    return projectMemory(cached, hint.speakerId)
  }
}

export async function fetchMemoryCard({ baseUrl, token, sessionId, speakerId, timeoutMs, fetchImpl }) {
  const url = new URL(`${String(baseUrl || '').replace(/\/+$/u, '')}/agent/memory`)
  url.searchParams.set('sessionId', sessionId)
  if (speakerId) url.searchParams.set('speakerId', speakerId)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`memory ${response.status}`)
    const data = await response.json()
    return {
      roomRev: String(data.roomRev || ''),
      roomText: String(data.roomText || ''),
      speakerRev: String(data.speakerRev || ''),
      speakerText: String(data.speakerText || ''),
    }
  } finally {
    clearTimeout(timer)
  }
}
