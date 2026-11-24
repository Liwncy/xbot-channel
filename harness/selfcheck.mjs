// node selfcheck.mjs  —— 只测不依赖 dsh 的纯函数
import assert from 'node:assert/strict'
import { parseInbound, modelText } from './lib/inbound.js'
import { composeMemory, emptyMemoryCache, MemoryBook, needsMemoryFetch, projectMemory, takeMemoryFetch } from './lib/memory.js'
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
assert.equal(group.logSessionId, '')
assert.equal(group.roomRev, '')

const remembered = parseInbound({
  messageId: 'm3', platform: 'golem', source: 'group', from: 'u1', roomId: 'r1',
  content: '在吗', logSessionId: 'r1@chatroom', roomRev: 'aaa', speakerRev: 'bbb',
})
assert.equal(remembered.logSessionId, 'r1@chatroom')
assert.equal(remembered.roomRev, 'aaa')
assert.equal(remembered.speakerRev, 'bbb')
assert.equal(modelText(remembered).includes('记得'), false)
assert.equal(composeMemory('【记得】\n房间', '【眼前这位】\n小王'), '【记得】\n房间\n\n【眼前这位】\n小王')
assert.equal(composeMemory('', ''), '')

const cache = emptyMemoryCache()
cache.roomRev = 'aaa'
cache.roomText = '房间'
cache.speakers.u1 = { rev: 'bbb', text: '小王' }
cache.applied = ''
assert.equal(needsMemoryFetch(cache, { logSessionId: 'r1', roomRev: 'aaa', speakerId: 'u1', speakerRev: 'bbb' }), false)
assert.equal(needsMemoryFetch(cache, { logSessionId: 'r1', roomRev: 'aaa', speakerId: 'u2', speakerRev: 'ccc' }), true)
assert.equal(needsMemoryFetch(cache, { logSessionId: 'r1', roomRev: 'aaa', speakerId: 'u2', speakerRev: '' }), false)
const same = projectMemory(cache, 'u1')
assert.equal(same.series, true)
assert.equal(same.text.includes('小王'), true)
const again = projectMemory(cache, 'u1')
assert.equal(again.series, false)
takeMemoryFetch(cache, 'u2', { roomRev: 'aaa', roomText: '房间', speakerRev: 'ccc', speakerText: '小李' })
const swapped = projectMemory(cache, 'u2')
assert.equal(swapped.series, true)
assert.equal(swapped.text.includes('小李'), true)
assert.equal(swapped.text.includes('小王'), false)

{
  // 取卡失败、或入站没带会话 id 时，不能把上一位发言人的卡留给下一位
  const warns = []
  let down = false
  const book = new MemoryBook(async (sessionId, speakerId) => {
    if (down) throw new Error('fetch failed')
    return { roomRev: 'r1', roomText: '房间', speakerRev: `s-${speakerId}`, speakerText: `只关于${speakerId}` }
  }, { warn: (m) => warns.push(m) })
  const first = await book.prepare('chat', { logSessionId: 'room', roomRev: 'r1', speakerId: 'u1', speakerRev: 's-u1' })
  assert.equal(first.series, true)
  assert.equal(first.text, '房间\n\n只关于u1')
  const steady = await book.prepare('chat', { logSessionId: 'room', roomRev: 'r1', speakerId: 'u1', speakerRev: 's-u1' })
  assert.equal(steady.series, false)
  down = true
  const failed = await book.prepare('chat', { logSessionId: 'room', roomRev: 'r1', speakerId: 'u2', speakerRev: 's-u2' })
  assert.equal(failed.text, '房间')
  assert.equal(failed.series, true)
  assert.equal(warns.length, 1)
  const legacy = await book.prepare('chat', { speakerId: 'u3' })
  assert.equal(legacy.text, '房间')
  const back = await book.prepare('chat', { logSessionId: 'room', roomRev: 'r1', speakerId: 'u1', speakerRev: 's-u1' })
  assert.equal(back.text, '房间\n\n只关于u1')
  assert.equal(warns.length, 1)
  // 另一个聊天从空开始，不会看见这个聊天的卡
  const other = await book.prepare('other', { speakerId: 'u1' })
  assert.equal(other.text, '')
}

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
