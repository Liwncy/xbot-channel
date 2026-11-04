/**
 * 主动连 xchatbot 的 WebSocket 邮箱（`GET {xchatbot}/agent/ws`）。
 *
 * xchatbot 把入站消息推到这条连接上，这里先去重、先回 ack，再跑 agent。
 * ack 只表示「通道收下了」，不表示 agent 答完；这样 xchatbot 不用挂着等整轮 agent。
 * 出站不走这里，仍然是 POST {xchatbot}/openclaw/outbound。
 *
 * 不依赖 openclaw SDK，只用 Node 全局 WebSocket，方便单独验证。
 */

export const MAILBOX_CLIENT_NAME = 'openclaw-xbot';
export const MAILBOX_CLIENT_VERSION = '0.1.0';

/** 另一个实例顶掉了这条连接。别马上抢回来，不然两边会来回互踢。 */
const REPLACED_CLOSE_CODE = 4000;
const REPLACED_RETRY_MS = 60_000;
const HEARTBEAT_MS = 30_000;
/** 超过这么久没收到任何东西（含 pong）就当连接已死。 */
const STALE_MS = 75_000;
/** 连上后撑过这么久才算「稳」，才重置退避。 */
const STABLE_MS = 10_000;
const CONFIG_RECHECK_MS = 30_000;
const SEEN_TTL_MS = 10 * 60 * 1000;
const SEEN_MAX = 2000;

export type MailboxClientConfig = {
  baseUrl: string;
  token: string;
  brain: string;
};

export type MailboxClientLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type MailboxClientStatus = {
  running: boolean;
  connected: boolean;
  lastConnectedAt: number | null;
  lastMessageAt: number | null;
};

type WebSocketLike = {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

export type WebSocketCtor = new (url: string, options?: unknown) => WebSocketLike;

/** http(s) → ws(s)，拼上 `/agent/ws?brain=`。地址不合法返回 null。 */
export function toMailboxUrl(baseUrl: string, brain: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol === 'https:' || url.protocol === 'wss:') url.protocol = 'wss:';
  else if (url.protocol === 'http:' || url.protocol === 'ws:') url.protocol = 'ws:';
  else return null;
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/agent/ws`;
  url.search = '';
  url.hash = '';
  const name = brain.trim();
  if (name) url.searchParams.set('brain', name);
  return url.toString();
}

/** 退避：1s、2s、4s …… 封顶，带抖动。从没连上过的封顶更长，少吵。 */
export function computeBackoffMs(attempt: number, everOpened: boolean, random = Math.random()): number {
  const cap = everOpened ? 30_000 : 120_000;
  const base = Math.min(cap, 1000 * 2 ** Math.max(0, attempt));
  return Math.floor(base * (0.5 + random * 0.5));
}

/** 近一阵子见过的消息 id。xchatbot 重发时认得出来，只回 ack，不再跑 agent。 */
export class SeenIds {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = SEEN_TTL_MS,
    private readonly max = SEEN_MAX,
  ) {}

  /** 见过返回 true；没见过就记下并返回 false。 */
  check(id: string, now = Date.now()): boolean {
    this.sweep(now);
    if (this.seen.has(id)) return true;
    this.seen.set(id, now);
    return false;
  }

  private sweep(now: number): void {
    for (const [key, at] of this.seen) {
      if (now - at <= this.ttlMs) break;
      this.seen.delete(key);
    }
    while (this.seen.size >= this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

export class XbotMailboxClient {
  private readonly seen = new SeenIds();
  private ws: WebSocketLike | null = null;
  private running = false;
  private connected = false;
  private attempt = 0;
  private everOpened = false;
  private openedAt = 0;
  private lastSeenAt = 0;
  private lastConnectedAt: number | null = null;
  private lastMessageAt: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private warnedNoWebSocket = false;

  constructor(
    private readonly options: {
      /** null 表示还没配好或被关掉；会隔一阵子再看一次。 */
      getConfig: () => MailboxClientConfig | null;
      onMessage: (payload: Record<string, unknown>, id: string) => Promise<void> | void;
      log: MailboxClientLog;
      webSocketCtor?: WebSocketCtor;
    },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    this.detach();
    this.connected = false;
  }

  status(): MailboxClientStatus {
    return {
      running: this.running,
      connected: this.connected,
      lastConnectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
    };
  }

  private connect(): void {
    if (!this.running) return;
    const config = this.options.getConfig();
    const url = config ? toMailboxUrl(config.baseUrl, config.brain) : null;
    if (!config || !url) {
      this.scheduleReconnect(CONFIG_RECHECK_MS);
      return;
    }

    const Ctor = this.options.webSocketCtor ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Ctor) {
      if (!this.warnedNoWebSocket) {
        this.warnedNoWebSocket = true;
        this.options.log.warn('[xbot] 这个 Node 没有全局 WebSocket，邮箱连接已关闭，仍走 HTTP 直推');
      }
      return;
    }

    let ws: WebSocketLike;
    try {
      ws = new Ctor(url, { headers: { Authorization: `Bearer ${config.token}` } });
    } catch (error) {
      this.options.log.warn(`[xbot] 邮箱连接建不起来: ${describe(error)}`);
      this.scheduleReconnect(computeBackoffMs(this.attempt++, this.everOpened));
      return;
    }
    this.ws = ws;
    this.openedAt = 0;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.everOpened = true;
      this.connected = true;
      this.openedAt = Date.now();
      this.lastSeenAt = this.openedAt;
      this.lastConnectedAt = this.openedAt;
      this.options.log.info(`[xbot] 已连上 xchatbot 邮箱 (brain=${config.brain})`);
      this.sendFrame({ t: 'hello', client: MAILBOX_CLIENT_NAME, version: MAILBOX_CLIENT_VERSION });
      this.startHeartbeat();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastSeenAt = Date.now();
      if (typeof event.data !== 'string') return;
      if (event.data === 'pong') return;
      this.handleFrame(event.data);
    };

    ws.onerror = () => {
      // 随后一定会有 close，在那里统一处理
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.onClosed(event?.code, config.brain);
    };
  }

  private onClosed(code: number | undefined, brain: string): void {
    const livedMs = this.openedAt ? Date.now() - this.openedAt : 0;
    const wasConnected = this.connected;
    this.ws = null;
    this.connected = false;
    this.stopHeartbeat();
    if (!this.running) return;

    if (code === REPLACED_CLOSE_CODE) {
      this.attempt = 0;
      this.options.log.warn(
        `[xbot] 邮箱连接被另一个实例顶掉了 (brain=${brain})，${REPLACED_RETRY_MS / 1000}s 后再试`,
      );
      this.scheduleReconnect(REPLACED_RETRY_MS);
      return;
    }

    if (livedMs >= STABLE_MS) this.attempt = 0;
    const delay = computeBackoffMs(this.attempt++, this.everOpened);
    if (wasConnected) {
      this.options.log.warn(`[xbot] 邮箱连接断了 (code=${code ?? '?'})，${Math.round(delay / 1000)}s 后重连`);
    } else if (this.attempt === 1 || this.attempt % 10 === 0) {
      this.options.log.warn(`[xbot] 邮箱连不上 (第 ${this.attempt} 次)，${Math.round(delay / 1000)}s 后重试`);
    }
    this.scheduleReconnect(delay);
  }

  private handleFrame(raw: string): void {
    let frame: { t?: unknown; id?: unknown; payload?: unknown };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    if (!frame || frame.t !== 'msg' || typeof frame.id !== 'string' || !frame.id) return;
    const id = frame.id;

    // 先去重、先 ack，再跑 agent；重复的只回 ack
    const duplicate = this.seen.check(id);
    this.sendFrame({ t: 'ack', id });
    if (duplicate) return;

    const payload = frame.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      this.options.log.warn(`[xbot] 邮箱消息没有正文，已跳过 (id=${id})`);
      return;
    }
    this.lastMessageAt = Date.now();
    void Promise.resolve()
      .then(() => this.options.onMessage(payload as Record<string, unknown>, id))
      .catch((error) => {
        this.options.log.warn(`[xbot] 邮箱消息处理失败 (id=${id}): ${describe(error)}`);
      });
  }

  private sendFrame(frame: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch {
      // 连接正在断，close 事件会接手
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      if (Date.now() - this.lastSeenAt > STALE_MS) {
        this.options.log.warn('[xbot] 邮箱连接很久没动静，重连');
        this.detach();
        this.onClosed(undefined, '');
        return;
      }
      try {
        ws.send('ping');
      } catch {
        // 同上
      }
    }, HEARTBEAT_MS);
    unrefTimer(this.heartbeatTimer);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(delayMs: number): void {
    if (!this.running) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    unrefTimer(this.reconnectTimer);
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** 摘掉旧连接，不再响应它的事件，然后关掉。 */
  private detach(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close(1000, 'bye');
    } catch {
      // 已经关了
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unrefTimer(timer: unknown): void {
  (timer as { unref?: () => void } | null)?.unref?.();
}
