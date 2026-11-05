import type { XchatbotReply } from './config.ts';

/** 同一会话里，同一个媒体链接在这个时间内只发一次。 */
export const MEDIA_DEDUPE_WINDOW_MS = 10_000;

type MediaReply = Extract<XchatbotReply, { type: 'image' | 'voice' | 'video' }>;

export function isMediaReply(reply: XchatbotReply): reply is MediaReply {
  return reply.type === 'image' || reply.type === 'voice' || reply.type === 'video';
}

/**
 * agent 偶尔会在很短时间里把同一张图连发两遍（比如工具回一次、正文又带一次）。
 * 按「会话 + 媒体链接」记最近发过的时间，窗口内重复的媒体直接丢掉，文字照常保留。
 */
export function createMediaDedupe(now: () => number = Date.now) {
  const recent = new Map<string, Map<string, number>>();

  function prune(sessionKey: string, at: number) {
    const session = recent.get(sessionKey);
    if (!session) return;
    for (const [url, sentAt] of session) {
      if (at - sentAt > MEDIA_DEDUPE_WINDOW_MS) session.delete(url);
    }
    if (session.size === 0) recent.delete(sessionKey);
  }

  /**
   * 去掉窗口内重复的媒体，并把留下的媒体登记为「刚发过」。
   * 失败时调用 `release` 撤销登记，让重试还能发出去。
   */
  function claim(sessionKey: string, replies: XchatbotReply[]) {
    const at = now();
    prune(sessionKey, at);
    const session = recent.get(sessionKey) ?? new Map<string, number>();
    const kept: XchatbotReply[] = [];
    const claimed: string[] = [];
    let dropped = 0;

    for (const reply of replies) {
      if (!isMediaReply(reply)) {
        kept.push(reply);
        continue;
      }
      const url = reply.url.trim();
      if (url && session.has(url)) {
        dropped += 1;
        continue;
      }
      if (url) {
        session.set(url, at);
        claimed.push(url);
      }
      kept.push(reply);
    }

    if (session.size > 0) recent.set(sessionKey, session);
    return {
      replies: kept,
      dropped,
      release() {
        const current = recent.get(sessionKey);
        if (!current) return;
        for (const url of claimed) current.delete(url);
        if (current.size === 0) recent.delete(sessionKey);
      },
    };
  }

  return { claim };
}
