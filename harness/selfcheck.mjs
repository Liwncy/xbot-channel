// node selfcheck.mjs  —— 只测不依赖 dsh 的纯函数
import assert from 'node:assert/strict'
import { parseInbound, modelText } from './lib/inbound.js'
import { backoffMs, SeenIds, toMailboxUrl } from './lib/mailbox.js'
import { cleanReply, isRetryableOutboundStatus, postOutboundWithRetry, postText } from './lib/outbound.js'

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

assert.equal(isRetryableOutboundStatus(409), true)
assert.equal(isRetryableOutboundStatus(429), true)
assert.equal(isRetryableOutboundStatus(502), true)
assert.equal(isRetryableOutboundStatus(400), false)
assert.equal(isRetryableOutboundStatus(401), false)

{
  let calls = 0
  const warns = []
  const slept = []
  const ok = await postOutboundWithRetry({
    url: 'https://example.test/openclaw/outbound',
    token: 't',
    body: '{}',
    delaysMs: [1, 1],
    timeoutMs: 1000,
    onWarn: (m) => warns.push(m),
    sleep: async (ms) => {
      slept.push(ms)
    },
    fetchImpl: async () => {
      calls += 1
      if (calls < 3) throw new Error('fetch failed')
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, sentCount: 1 }),
      }
    },
  })
  assert.equal(ok.sentCount, 1)
  assert.equal(calls, 3)
  assert.deepEqual(slept, [1, 1])
  assert.equal(warns.length, 2)

  let badCalls = 0
  await assert.rejects(
    () =>
      postOutboundWithRetry({
        url: 'https://example.test/openclaw/outbound',
        token: 't',
        body: '{}',
        delaysMs: [1, 1],
        onWarn: () => {},
        sleep: async () => {},
        fetchImpl: async () => {
          badCalls += 1
          return {
            ok: false,
            status: 401,
            text: async () => JSON.stringify({ ok: false, error: 'unauthorized' }),
          }
        },
      }),
    /unauthorized/,
  )
  assert.equal(badCalls, 1, '4xx 不重试')
}

{
  const ids = []
  await postText(
    {
      baseUrl: 'https://example.test',
      token: 't',
      timeoutMs: 1000,
      delaysMs: [1],
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        ids.push(JSON.parse(init.body).outboundId)
        if (ids.length === 1) throw new Error('fetch failed')
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, sentCount: 1 }) }
      },
    },
    { platform: 'golem', source: 'group', from: 'u', roomId: 'r', messageId: 'm' },
    '好了',
  )
  assert.equal(ids.length, 2)
  assert.ok(ids[0] && ids[0] === ids[1], '重试必须带同一个 outboundId')
}

console.log('✓ harness channel')
