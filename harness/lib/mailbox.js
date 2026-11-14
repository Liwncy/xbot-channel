/**
 * 主动连 xchatbot 的 WebSocket 邮箱（`GET {xchatbot}/agent/ws`）。
 *
 * xchatbot 把入站消息推到这条连接上，这里先去重、先回 ack，再交给上层跑 agent。
 * ack 只表示「收下了」，不表示 agent 答完。出站不走这里，仍然 POST /openclaw/outbound。
 * 协议同 openclaw 通道，见 xchatbot `.docs/agent/design/ws-mailbox.md`。
 */

export const CLIENT_NAME = 'harness-xbot'
export const CLIENT_VERSION = '0.1.0'

/** 另一个实例顶掉了这条连接。别马上抢回来，不然两边会来回互踢。 */
const REPLACED_CLOSE_CODE = 4000
const REPLACED_RETRY_MS = 60_000
const HEARTBEAT_MS = 30_000
/** 超过这么久没收到任何东西（含 pong）就当连接已死。 */
const STALE_MS = 75_000
/** 连上后撑过这么久才算「稳」，才重置退避。 */
const STABLE_MS = 10_000
const SEEN_TTL_MS = 10 * 60 * 1000
const SEEN_MAX = 2000

/** http(s) → ws(s)，拼上 `/agent/ws?brain=`。地址不合法返回 null。 */
export function toMailboxUrl(baseUrl, brain) {
  let url
  try {
    url = new URL(String(baseUrl || '').trim())
  } catch {
    return null
  }
  if (url.protocol === 'https:' || url.protocol === 'wss:') url.protocol = 'wss:'
  else if (url.protocol === 'http:' || url.protocol === 'ws:') url.protocol = 'ws:'
  else return null
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/agent/ws`
  url.search = ''
  url.hash = ''
  const name = String(brain || '').trim()
  if (name) url.searchParams.set('brain', name)
  return url.toString()
}

/** 退避：1s、2s、4s …… 封顶，带抖动。从没连上过的封顶更长，少吵。 */
export function backoffMs(attempt, everOpened, random = Math.random()) {
  const cap = everOpened ? 30_000 : 120_000
  const base = Math.min(cap, 1000 * 2 ** Math.max(0, attempt))
  return Math.floor(base * (0.5 + random * 0.5))
}

/** 近一阵子见过的消息 id。xchatbot 重发时认得出来，只回 ack，不再跑 agent。 */
export class SeenIds {
  constructor(ttlMs = SEEN_TTL_MS, max = SEEN_MAX) {
    this.ttlMs = ttlMs
    this.max = max
    this.seen = new Map()
  }

  /** 见过返回 true；没见过就记下并返回 false。 */
  check(id, now = Date.now()) {
    this.#sweep(now)
    if (this.seen.has(id)) return true
    this.seen.set(id, now)
    return false
  }

  #sweep(now) {
    for (const [key, at] of this.seen) {
      if (now - at <= this.ttlMs) break
      this.seen.delete(key)
    }
    while (this.seen.size >= this.max) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
  }
}

export class MailboxClient {
  /**
   * @param {{
   *   baseUrl: string,
   *   token: string,
   *   brain: string,
   *   onMessage: (payload: Record<string, unknown>, id: string) => Promise<void> | void,
   *   log: { info: (m: string) => void, warn: (m: string) => void },
   * }} options
   */
  constructor(options) {
    this.options = options
    this.seen = new SeenIds()
    this.ws = null
    this.running = false
    this.connected = false
    this.attempt = 0
    this.everOpened = false
    this.openedAt = 0
    this.lastSeenAt = 0
    this.reconnectTimer = null
    this.heartbeatTimer = null
  }

  start() {
    if (this.running) return
    this.running = true
    this.#connect()
  }

  stop() {
    this.running = false
    this.#stopHeartbeat()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.#detach()
    this.connected = false
  }

  #connect() {
    if (!this.running) return
    const { baseUrl, token, brain, log } = this.options
    const url = toMailboxUrl(baseUrl, brain)
    if (!url || !token) {
      log.warn('[xbot] 邮箱地址或 token 没配好，不连')
      return
    }
    const Ctor = globalThis.WebSocket
    if (!Ctor) {
      log.warn('[xbot] 这个 Node 没有全局 WebSocket，需要 Node 24 以上')
      return
    }

    let ws
    try {
      ws = new Ctor(url, { headers: { Authorization: `Bearer ${token}` } })
    } catch (error) {
      log.warn(`[xbot] 邮箱连接建不起来: ${describe(error)}`)
      this.#scheduleReconnect(backoffMs(this.attempt++, this.everOpened))
      return
    }
    this.ws = ws
    this.openedAt = 0

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.everOpened = true
      this.connected = true
      this.openedAt = Date.now()
      this.lastSeenAt = this.openedAt
      log.info(`[xbot] 已连上 xchatbot 邮箱 (brain=${brain})`)
      this.#send({ t: 'hello', client: CLIENT_NAME, version: CLIENT_VERSION })
      this.#startHeartbeat()
    }
    ws.onmessage = (event) => {
      if (this.ws !== ws) return
      this.lastSeenAt = Date.now()
      if (typeof event.data !== 'string' || event.data === 'pong') return
      this.#handleFrame(event.data)
    }
    // error 之后一定会有 close，在那里统一处理
    ws.onerror = () => {}
    ws.onclose = (event) => {
      if (this.ws !== ws) return
      this.#onClosed(event?.code)
    }
  }

  #onClosed(code) {
    const { log, brain } = this.options
    const livedMs = this.openedAt ? Date.now() - this.openedAt : 0
    const wasConnected = this.connected
    this.ws = null
    this.connected = false
    this.#stopHeartbeat()
    if (!this.running) return

    if (code === REPLACED_CLOSE_CODE) {
      this.attempt = 0
      log.warn(`[xbot] 邮箱连接被另一个实例顶掉了 (brain=${brain})，${REPLACED_RETRY_MS / 1000}s 后再试`)
      this.#scheduleReconnect(REPLACED_RETRY_MS)
      return
    }

    if (livedMs >= STABLE_MS) this.attempt = 0
    const delay = backoffMs(this.attempt++, this.everOpened)
    if (wasConnected) {
      log.warn(`[xbot] 邮箱连接断了 (code=${code ?? '?'})，${Math.round(delay / 1000)}s 后重连`)
    } else if (this.attempt === 1 || this.attempt % 10 === 0) {
      log.warn(`[xbot] 邮箱连不上 (第 ${this.attempt} 次)，${Math.round(delay / 1000)}s 后重试`)
    }
    this.#scheduleReconnect(delay)
  }

  #handleFrame(raw) {
    let frame
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (!frame || frame.t !== 'msg' || typeof frame.id !== 'string' || !frame.id) return
    const id = frame.id

    // 先去重、先 ack，再跑 agent；重复的只回 ack
    const duplicate = this.seen.check(id)
    this.#send({ t: 'ack', id })
    if (duplicate) return

    const payload = frame.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      this.options.log.warn(`[xbot] 邮箱消息没有正文，已跳过 (id=${id})`)
      return
    }
    void Promise.resolve()
      .then(() => this.options.onMessage(payload, id))
      .catch((error) => {
        this.options.log.warn(`[xbot] 邮箱消息处理失败 (id=${id}): ${describe(error)}`)
      })
  }

  #send(frame) {
    try {
      this.ws?.send(JSON.stringify(frame))
    } catch {
      // 连接正在断，close 事件会接手
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws
      if (!ws) return
      if (Date.now() - this.lastSeenAt > STALE_MS) {
        this.options.log.warn('[xbot] 邮箱连接很久没动静，重连')
        this.#detach()
        this.#onClosed(undefined)
        return
      }
      try {
        ws.send('ping')
      } catch {
        // 同上
      }
    }, HEARTBEAT_MS)
    this.heartbeatTimer.unref?.()
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  #scheduleReconnect(delayMs) {
    if (!this.running) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.#connect()
    }, delayMs)
    this.reconnectTimer.unref?.()
  }

  /** 摘掉旧连接，不再响应它的事件，然后关掉。 */
  #detach() {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
    try {
      ws.close(1000, 'bye')
    } catch {
      // 已经关了
    }
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
