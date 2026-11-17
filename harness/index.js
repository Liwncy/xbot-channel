/**
 * dsh-xbot-channel — DeepSeek Harness 的 xchatbot 频道。
 *
 *   xchatbot ──WebSocket 邮箱──▶ 本插件 ──▶ Harness agent
 *   xchatbot ◀──POST /openclaw/outbound── 本插件
 *
 * 只连出去，不开端口，不需要隧道。xchatbot 侧要把 `agent_brain.harness` 的 transport 设成 `ws`。
 */
import Schema from '@deepseek-ai/schemastery'
import { Chats } from './lib/chats.js'
import { modelText, parseInbound } from './lib/inbound.js'
import { MailboxClient } from './lib/mailbox.js'
import { publishLocalImages } from './lib/media.js'
import { cleanReply, postText } from './lib/outbound.js'

export const name = 'xbot-channel'

export const Config = Schema.object({
  xchatbotApiBaseUrl: Schema.string().required(),
  xchatbotToken: Schema.string().role('secret').required(),
  brain: Schema.string().default('harness'),
  approvalPolicy: Schema.union(['never', 'ask']).default('never'),
  permissionMode: Schema.string(),
  /** profile 里 agent 预设的 id：决定小聪明儿有哪些工具。xbot 是完整工具，xbot-lite 只能读技能。 */
  agentPreset: Schema.string().default('xbot'),
  idleTimeoutMs: Schema.number().default(30 * 60 * 1000),
  turnTimeoutMs: Schema.number().default(5 * 60 * 1000),
  outboundTimeoutMs: Schema.number().default(30_000),
  /** 回复里的本地图片只认这个目录里的文件，默认是 dsh 的启动目录（工作区）。 */
  mediaRoot: Schema.string(),
  /** 手机在云端时，截图存在那台机器的 /tmp；填 ~/.ssh/config 里的别名就会先取回再传。留空不取。 */
  phoneHost: Schema.string(),
})

/** 出了岔子，私聊或被点名时像聊天一样说一句；群里没点名就不吭声。 */
const FAILURE_REPLY = '没弄成，再试下'

export function apply(ctx, config) {
  const log = {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
  }
  const target = {
    baseUrl: config.xchatbotApiBaseUrl,
    token: config.xchatbotToken,
    timeoutMs: config.outboundTimeoutMs,
    log,
  }

  ctx.effect(() => {
    let stopped = false
    let client = null
    const chats = new Chats(ctx, {
      approvalPolicy: config.approvalPolicy,
      permissionMode: config.permissionMode,
      agentPreset: config.agentPreset,
      idleTimeoutMs: config.idleTimeoutMs,
      turnTimeoutMs: config.turnTimeoutMs,
      log,
    })

    const onMessage = async (payload, id) => {
      let parsed
      try {
        parsed = parseInbound(payload)
      } catch (error) {
        log.warn(`[xbot] 入站格式不对 (id=${id}): ${error.message}`)
        return
      }
      const route = {
        platform: parsed.platform,
        source: parsed.source,
        from: parsed.from,
        roomId: parsed.roomId,
        messageId: parsed.messageId,
      }
      const mustReply = parsed.source === 'private' || parsed.addressed !== false

      let reply = ''
      try {
        reply = cleanReply(await chats.ask(parsed.chatId, modelText(parsed)))
      } catch (error) {
        log.warn(`[xbot] 这一轮没跑成 (${parsed.chatId}): ${error.message}`)
        if (!mustReply) return
        reply = FAILURE_REPLY
      }
      if (!reply) return
      try {
        reply = await publishLocalImages(reply, {
          root: config.mediaRoot || process.cwd(),
          phoneHost: config.phoneHost || '',
          log,
        })
        await postText(target, route, reply)
      } catch (error) {
        log.warn(`[xbot] 回复没送出去 (${parsed.chatId}): ${error.message}`)
      }
    }

    // 同级插件并发挂载，等整个应用组好再开始收消息，免得 agent 缺工具
    void (async () => {
      await ctx.get('loader')?.await()
      if (stopped) return
      client = new MailboxClient({
        baseUrl: config.xchatbotApiBaseUrl,
        token: config.xchatbotToken,
        brain: config.brain,
        onMessage,
        log,
      })
      client.start()
    })().catch((error) => log.warn(`[xbot] 启动失败: ${error.message}`))

    return () => {
      stopped = true
      client?.stop()
      chats.dispose()
    }
  })
}
