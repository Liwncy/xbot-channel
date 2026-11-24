/**
 * 每个聊天一个长期 agent，有记忆；同一个聊天里的消息排队，一条跑完再跑下一条。
 * 驱动方式照官方 `@deepseek-ai/dsh-headless`：agents.create → followup → whenIdle → 读日志取最后一段回复。
 */
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { fetchMemoryCard, MemoryBook } from './memory.js'
const SESSION_VERSION = 'v2'

function safeId(id) {
  return String(id || 'chat').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
}

/** 取这一轮最后一段 assistant 文本，以及这一轮结束的原因。 */
export function summarize(session, firstSeq) {
  let started = false
  let text = ''
  let reason
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (event.type === 'turn/start') {
      started = true
      reason = undefined
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

export class Chats {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{ approvalPolicy: string, permissionMode?: string, idleTimeoutMs: number, turnTimeoutMs: number,
   *           log: { info: (m: string) => void, warn: (m: string) => void },
   *           memory?: { baseUrl: string, token: string, timeoutMs?: number } }} options
   */
  constructor(ctx, options) {
    this.ctx = ctx
    this.options = options
    this.entries = new Map() // chatId -> { handle, agent, queue, lastUsed }
    this.memoryCells = new Map() // chatId -> { text, series }
    this.memoryAttached = new WeakSet()
    const memory = options.memory
    this.book = memory?.baseUrl && memory.token
      ? new MemoryBook(
          (sessionId, speakerId) => fetchMemoryCard({
            baseUrl: memory.baseUrl,
            token: memory.token,
            sessionId,
            speakerId,
            timeoutMs: memory.timeoutMs || 8000,
            fetchImpl: (url, init) => fetch(url, init),
          }),
          options.log,
        )
      : null
    this.reaper = setInterval(() => this.#reap(), 60_000)
    this.reaper.unref?.()
    this.disposed = false
  }

  /**
   * 在这个聊天里问一句，返回 agent 的回复文本。
   * @returns {Promise<string>}
   */
  ask(chatId, text, hint = {}) {
    const entry = this.entries.get(chatId) ?? this.#placeholder(chatId)
    const run = entry.queue.then(() => this.#turn(chatId, text, hint))
    // 队列不能被一次失败卡住
    entry.queue = run.catch(() => {})
    return run
  }

  #placeholder(chatId) {
    const entry = { handle: null, agent: null, queue: Promise.resolve(), lastUsed: Date.now() }
    this.entries.set(chatId, entry)
    return entry
  }

  async #create(chatId) {
    const agents = this.ctx.get('agents')
    const defaultModel = this.ctx.get('agentDefaultModel')
    if (!agents || !defaultModel) throw new Error('agents service is not ready')
    const selection = defaultModel.currentSelection()
    const fs = this.ctx.get('fs')
    const cwd = fs ? fs.processPath(await fs.resolve('.')) : process.cwd()
    // 一个聊天固定一个会话 id：重启、闲置收掉之后接着原来的记忆聊，不会在后台冒出一串新会话。
    // 后缀是会话版本：早期没选预设的会话已经开过话，选不了预设，只能换 id 重开。
    const sessionId = `xbot-${safeId(chatId)}-${SESSION_VERSION}`
    const common = {
      agentOptions: { ...selection },
      // setup 的返回值会被当成 { commit() } 调用；installModelSelection 返回的是销毁函数，不能直接 return
      setup: (agentCtx) => {
        installModelSelection(agentCtx)
      },
    }
    const persistence = this.ctx.get('sessionPersistence')
    const saved = persistence ? await persistence.stat(sessionId) : undefined
    let handle = null
    let agent = agents.get(sessionId) // 网页后台（同一个进程）可能已经把这个会话接起来了，直接用它
    let resumed = Boolean(agent)
    if (!agent && saved) {
      try {
        handle = await agents.resume({ resumeSessionId: sessionId, ...common })
        agent = handle.agent
        resumed = true
      } catch (error) {
        // 旧会话打不开（文件损坏、被占用）：不能因此整个聊天哑掉，开个新的顶上
        this.options.log.warn(`[xbot] 旧会话接不上 (${sessionId}): ${error?.message ?? error}`)
      }
    }
    if (!agent) {
      const freshId = saved ? `${sessionId}-${Date.now().toString(36)}` : sessionId
      handle = await agents.create({ sessionId: freshId, meta: { cwd }, ...common })
      agent = handle.agent
    }
    await agent.whenIdle()

    // 网页界面一进 profile，工具就跟着预设走了；不选预设的 agent 只剩 MCP 工具，读不了技能。
    // 新开的会话在第一轮之前选好专用预设；接上的旧会话，预设已记在日志里，会按日志恢复。
    const presets = this.ctx.get('agentPresets')
    const wanted = this.options.agentPreset
    if (presets && wanted && !resumed) {
      try {
        await presets.select(agent, wanted)
      } catch (error) {
        this.options.log.warn(`[xbot] 选不上预设 ${wanted}: ${error?.message ?? error}`)
      }
    } else if (presets && wanted && presets.presetForSession(agent.session) !== wanted) {
      this.options.log.warn(`[xbot] 会话 ${agent.session.id ?? sessionId} 用的不是 ${wanted} 预设，工具可能不对`)
    }

    const permissions = this.ctx.get('permissionPresets')
    if (this.options.permissionMode && permissions) {
      permissions.set(agent.session, this.options.permissionMode)
    }
    // 没有人能点「同意」，需要审批的调用直接拒掉
    setApprovalPolicy(agent.session, this.options.approvalPolicy)

    this.options.log.info(`[xbot] ${resumed ? '接上旧会话' : '新会话'} ${agent.session.id ?? sessionId} (${selection.provider}/${selection.model})`)
    return { handle, agent }
  }

  #cell(chatId) {
    let cell = this.memoryCells.get(chatId)
    if (!cell) {
      cell = { text: '', series: false }
      this.memoryCells.set(chatId, cell)
    }
    return cell
  }

  /** 闲置收掉再接上时要重新挂。这一节每次组装才读当前卡，不写进用户消息。 */
  #attachMemory(chatId, agent) {
    if (!this.book || this.memoryAttached.has(agent)) return
    this.memoryAttached.add(agent)
    const cell = this.#cell(chatId)
    try {
      agent.ctx.systemPrompt.section({
        name: 'xbot-memory',
        order: 10300,
        interpolate: false,
        text: () => cell.text || '',
      })
    } catch (error) {
      this.options.log.warn(`[xbot] 记忆卡挂不上 (${chatId}): ${error?.message ?? error}`)
      return
    }
    try {
      agent.ctx.on('agent/pre-step', async (_payload, next) => {
        const decision = typeof next === 'function' ? await next() : _payload
        if (!decision || decision.kind !== 'enter' || !cell.series) return decision
        cell.series = false
        return { ...decision, startsRequestSeries: true }
      })
    } catch (error) {
      this.options.log.warn(`[xbot] 记忆卡换不了格 (${chatId}): ${error?.message ?? error}`)
    }
  }

  async #turn(chatId, text, hint = {}) {
    if (this.disposed) throw new Error('chats disposed')
    const entry = this.entries.get(chatId)
    if (!entry) throw new Error('chat entry missing')
    if (!entry.agent) Object.assign(entry, await this.#create(chatId))
    entry.lastUsed = Date.now()
    this.#attachMemory(chatId, entry.agent)
    const cell = this.#cell(chatId)
    if (this.book) {
      try {
        const projected = await this.book.prepare(chatId, {
          logSessionId: hint.logSessionId || '',
          roomRev: hint.roomRev || '',
          speakerId: hint.speakerId || '',
          speakerRev: hint.speakerRev || '',
        })
        cell.text = projected.text
        // 上一轮要是没走到请求那一步，「该换格」还欠着，不能被这一轮的「没变」盖掉
        cell.series = cell.series || projected.series
      } catch (error) {
        this.options.log.warn(`[xbot] 记忆卡没换上 (${chatId}): ${error?.message ?? error}`)
      }
    }

    const agent = entry.agent
    let failure
    const stopErrors = this.ctx.on('agent/error', ({ agent: subject, error }) => {
      if (subject === agent) failure = error
    })
    try {
      const firstSeq = agent.session.seq
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }),
      )
      await withTimeout(agent.whenIdle(), this.options.turnTimeoutMs, () => agent.cancel({ kind: 'user' }))
      if (failure) throw failure
      const { text: reply, reason } = summarize(agent.session, firstSeq)
      if (reason?.kind === 'error') throw new Error('turn ended with error')
      return reply
    } finally {
      stopErrors()
      entry.lastUsed = Date.now()
    }
  }

  #reap() {
    const now = Date.now()
    for (const [chatId, entry] of this.entries) {
      if (!entry.agent || now - entry.lastUsed < this.options.idleTimeoutMs) continue
      // 收会话要等它真正放手，下一条消息排在后面再接上；不然会话还被占着，接不上又会另开新的
      const disposing = Promise.resolve()
        .then(() => entry.handle?.dispose?.())
        .catch(() => {})
      this.entries.set(chatId, { handle: null, agent: null, queue: disposing, lastUsed: now })
      this.options.log.info(`[xbot] 会话闲置已收掉 (${chatId})`)
    }
  }

  dispose() {
    this.disposed = true
    clearInterval(this.reaper)
    for (const entry of this.entries.values()) {
      try {
        entry.handle?.dispose?.()
      } catch {
        // 已经没了
      }
    }
    this.entries.clear()
  }
}

function withTimeout(promise, ms, onTimeout) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.()
      } catch {
        // 停不下来也要报超时
      }
      reject(new Error(`turn timed out after ${ms}ms`))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
