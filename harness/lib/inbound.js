/** 解析 xchatbot 入站 JSON。字段见 xbot-channel README「入站」。 */

function str(value) {
  if (typeof value === 'string') return value.trim()
  if (value == null) return ''
  return String(value).trim()
}

/**
 * @param {unknown} params
 * @returns {{
 *   messageId: string, platform: string, source: 'group' | 'private',
 *   from: string, senderName: string, roomId: string, chatId: string,
 *   type: string, text: string, mediaUrl: string, videoUrl: string,
 *   addressed: boolean | null,
 * }}
 */
export function parseInbound(params) {
  const data = params && typeof params === 'object' ? params : {}
  const messageId = str(data.messageId ?? data.msgId ?? data.id)
  const platform = str(data.platform)
  const from = str(data.from ?? data.senderId)
  const rawSource = str(data.source).toLowerCase()
  const source = rawSource === 'group' || rawSource === 'chatroom' ? 'group' : 'private'
  const roomId = str(data.roomId ?? data.groupId)
  const conversationId = str(data.conversationId)
  const type = str(data.type || 'text').toLowerCase() || 'text'
  const content = str(data.content ?? data.text)

  if (!messageId) throw new Error('messageId is required')
  if (!from) throw new Error('from is required')
  if (!platform) throw new Error('platform is required')
  const peer = roomId || conversationId
  if (source === 'group' && !peer) throw new Error('roomId is required for group messages')

  const chatId = source === 'group' ? `${platform}:group:${peer}` : `${platform}:user:${from}`
  return {
    messageId,
    platform,
    source,
    from,
    senderName: str(data.senderName) || from,
    roomId,
    chatId,
    type,
    text: content || `[${type}]`,
    mediaUrl: str(data.mediaUrl),
    videoUrl: str(data.videoUrl),
    // 只有明确的布尔才算；没带就是「不知道」
    addressed: typeof data.addressed === 'boolean' ? data.addressed : null,
  }
}

/** 给模型的正文：媒体只有公网 URL，直接写在后面。 */
export function modelText(parsed) {
  const lines = [parsed.text]
  if (parsed.mediaUrl) lines.push(`[媒体] ${parsed.mediaUrl}`)
  if (parsed.videoUrl && parsed.videoUrl !== parsed.mediaUrl) lines.push(`[视频] ${parsed.videoUrl}`)
  return lines.join('\n')
}
