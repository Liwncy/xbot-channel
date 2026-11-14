// node selfcheck.mjs  —— 只测不依赖 dsh 的纯函数
import assert from 'node:assert/strict'
import { parseInbound, modelText } from './lib/inbound.js'
import { backoffMs, SeenIds, toMailboxUrl } from './lib/mailbox.js'
import { cleanReply } from './lib/outbound.js'

assert.equal(toMailboxUrl('https://x.example.com/', 'harness'), 'wss://x.example.com/agent/ws?brain=harness')
assert.equal(toMailboxUrl('http://127.0.0.1:8787', 'harness'), 'ws://127.0.0.1:8787/agent/ws?brain=harness')
assert.equal(toMailboxUrl('ftp://x', 'h'), null)
assert.equal(toMailboxUrl('not a url', 'h'), null)

assert.ok(backoffMs(0, true, 1) <= 1000)
assert.ok(backoffMs(20, true, 1) <= 30_000)
assert.ok(backoffMs(20, false, 1) <= 120_000)

const seen = new SeenIds(1000, 10)
assert.equal(seen.check('a', 0), false)
assert.equal(seen.check('a', 500), true)
assert.equal(seen.check('a', 2000), false)

const group = parseInbound({
  messageId: 'm1', platform: 'golem', source: 'group', from: 'u1', roomId: 'r1',
  content: '在吗', mediaUrl: 'https://a/b.png', addressed: false,
})
assert.equal(group.chatId, 'golem:group:r1')
assert.equal(group.addressed, false)
assert.equal(modelText(group), '在吗\n[媒体] https://a/b.png')

const dm = parseInbound({ messageId: 'm2', platform: 'web', source: 'private', from: 'u2', content: 'hi' })
assert.equal(dm.chatId, 'web:user:u2')
assert.equal(dm.addressed, null)

assert.throws(() => parseInbound({ platform: 'web', from: 'u' }), /messageId/)
assert.throws(() => parseInbound({ messageId: 'x', platform: 'web', source: 'group', from: 'u' }), /roomId/)

assert.equal(cleanReply('NO_REPLY'), '')
assert.equal(cleanReply('  好了\n\n\n\n嗯  '), '好了\n\n嗯')

console.log('✓ harness channel')
