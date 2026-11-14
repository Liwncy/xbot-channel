import assert from 'node:assert/strict';
import { parseXbotInboundParams } from '../src/inbound.ts';
import {
  isRetryableOutboundStatus,
  looksLikeToolDraft,
  mapOpenClawPayloadToReplies,
  normalizeOutboundText,
  postOutboundWithRetry,
} from '../src/outbound.ts';
import { createMediaDedupe, MEDIA_DEDUPE_WINDOW_MS } from '../src/media-dedupe.ts';
import { isLocalImagePath, localizeReplies, UPLOAD_FAILED_LINE } from '../src/media.ts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isContextOverflowAlreadyReset,
  isContextOverflowError,
  isContextOverflowNotice,
} from '../src/overflow.ts';
import {
  computeBackoffMs,
  SeenIds,
  toMailboxUrl,
  XbotMailboxClient,
  type WebSocketCtor,
} from '../src/ws-client.ts';

{
  const parsed = parseXbotInboundParams({
    messageId: '1',
    platform: 'golem',
    source: 'private',
    from: 'wxid_owner',
    content: '你好',
  });
  assert.equal(parsed.peer.kind, 'direct');
  assert.equal(parsed.platform, 'golem');
  assert.equal(parsed.senderId, 'wxid_owner');
  assert.equal(parsed.rawBody, '你好');
}

{
  const parsed = parseXbotInboundParams({
    messageId: '2',
    platform: 'web',
    source: 'group',
    from: 'wxid_a',
    roomId: '123@chatroom',
    content: '@小聪明儿 在吗',
    mediaUrl: 'https://cdn.example.com/a.jpg',
    mediaKind: 'image',
  });
  assert.equal(parsed.peer.kind, 'group');
  assert.equal(parsed.route.platform, 'web');
  assert.equal(parsed.route.groupId, '123@chatroom');
  assert.equal(parsed.mediaKind, 'image');
}

assert.throws(() => parseXbotInboundParams({ source: 'private', from: 'wxid_a', platform: 'golem' }));
assert.throws(() => parseXbotInboundParams({ messageId: '3', source: 'private', from: 'wxid_a' }));
console.log('✓ inbound parse');

{
  const replies = mapOpenClawPayloadToReplies({
    text: '看看',
    mediaUrl: 'https://cdn.example.com/a.jpg',
    type: 'image',
  });
  assert.equal(replies[0]?.type, 'image');
  assert.equal(replies[1]?.type, 'text');
}

{
  const replies = mapOpenClawPayloadToReplies({
    mediaUrl: 'C:\\tmp\\a.mp3',
    type: 'voice',
  });
  assert.equal(replies.length, 0);
}

{
  const replies = mapOpenClawPayloadToReplies({
    mediaUrl: 'https://cdn.example.com/v.mp3',
    audioAsVoice: true,
  });
  assert.equal(replies[0]?.type, 'voice');
}
console.log('✓ map replies (http only)');

{
  // 本地图片：mediaUrl 是图片路径时放行（发送前再转链接），别的本地文件仍然不要
  const local = mapOpenClawPayloadToReplies({ mediaUrl: 'C:\\ws\\screen.jpg', type: 'image' });
  assert.deepEqual(local, [{ type: 'image', url: 'C:\\ws\\screen.jpg' }]);
  assert.equal(mapOpenClawPayloadToReplies({ mediaUrl: 'C:\\ws\\secret.txt' }).length, 0);
  assert.equal(isLocalImagePath('C:\\ws\\screen.jpg'), true);
  assert.equal(isLocalImagePath('https://x/a.jpg'), false);
  assert.equal(isLocalImagePath('C:\\ws\\a.txt'), false);

  const base = mkdtempSync(path.join(tmpdir(), 'xbot-media-'));
  const root = path.join(base, 'work');
  mkdirSync(root);
  writeFileSync(path.join(root, 'screen.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(path.join(root, 'note.txt'), 'x');
  writeFileSync(path.join(base, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));

  let uploads = 0;
  const warns: string[] = [];
  const out = await localizeReplies(
    [
      { type: 'text', content: `截好了\nimage:${path.join(root, 'screen.png')}` },
      { type: 'image', url: path.join(root, 'screen.png') },
      { type: 'image', url: path.join(base, 'secret.png') }, // 目录外
      { type: 'text', content: `image:${path.join(root, 'note.txt')}` }, // 不是图片
      { type: 'text', content: `image:${path.join(root, '..', 'secret.png')}` }, // .. 绕出去
      { type: 'image', url: 'https://x.com/a.jpg' },
    ],
    {
      roots: [root],
      onWarn: (m) => warns.push(m),
      upload: async () => `https://file.example/${++uploads}.png`,
    },
  );
  assert.deepEqual(out, [
    { type: 'text', content: '截好了\nimage:https://file.example/1.png' },
    { type: 'image', url: 'https://file.example/2.png' },
    { type: 'text', content: UPLOAD_FAILED_LINE },
    { type: 'text', content: UPLOAD_FAILED_LINE },
    { type: 'text', content: UPLOAD_FAILED_LINE },
    { type: 'image', url: 'https://x.com/a.jpg' },
  ]);
  assert.equal(uploads, 2);
  assert.ok(!JSON.stringify(out).includes(base), '不能把本机路径发出去');

  // 上传失败也不泄露路径
  const failed = await localizeReplies([{ type: 'image', url: path.join(root, 'screen.png') }], {
    roots: [root],
    upload: async () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(failed, [{ type: 'text', content: UPLOAD_FAILED_LINE }]);

  // 云手机：只认 /tmp/<文件名>.<图片后缀>，其余不去云端取
  const fetched: string[] = [];
  const phoneOpts = {
    roots: [root],
    phoneHost: 'xbot-phone',
    upload: async () => `https://file.example/${++uploads}.png`,
    fetchPhone: async (host: string, remote: string) => {
      fetched.push(`${host}:${remote}`);
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
    },
  };
  const phoneOk = await localizeReplies([{ type: 'text', content: 'image:/tmp/screen.jpg' }], phoneOpts);
  assert.match((phoneOk[0] as { content: string }).content, /^image:https:\/\/file\.example\//);
  assert.deepEqual(fetched, ['xbot-phone:/tmp/screen.jpg']);
  fetched.length = 0;
  for (const bad of [
    '/etc/passwd',
    '/tmp/sub/a.jpg',
    '/tmp/../etc/a.jpg',
    '/tmp/a.txt',
    '/tmp/a b.jpg',
    '/tmp/$(id).jpg',
  ]) {
    const res = await localizeReplies([{ type: 'text', content: `image:${bad}` }], phoneOpts);
    assert.deepEqual(res, [{ type: 'text', content: UPLOAD_FAILED_LINE }], bad);
  }
  assert.equal(fetched.length, 0, '不合规的路径不能去云端取');
  const noHost = await localizeReplies([{ type: 'image', url: '/tmp/screen.jpg' }], { ...phoneOpts, phoneHost: '' });
  assert.deepEqual(noHost, [{ type: 'text', content: UPLOAD_FAILED_LINE }]);
  const brokenFetch = await localizeReplies([{ type: 'image', url: '/tmp/screen.jpg' }], {
    ...phoneOpts,
    fetchPhone: async () => {
      throw new Error('ssh: timeout');
    },
  });
  assert.deepEqual(brokenFetch, [{ type: 'text', content: UPLOAD_FAILED_LINE }]);
}
console.log('✓ local images → links');

assert.equal(normalizeOutboundText('**你好**'), '**你好**');
assert.equal(
  normalizeOutboundText('画好了\nimage:https://cdn.example.com/a.jpg'),
  '画好了\nimage:https://cdn.example.com/a.jpg',
);
assert.equal(
  normalizeOutboundText('喊她了\nat:wxid_abc|@火 发个老牛子的表情'),
  '喊她了\nat:wxid_abc|@火 发个老牛子的表情',
);
assert.equal(normalizeOutboundText('吃了吗\n在吗'), '吃了吗\n在吗');
assert.equal(
  normalizeOutboundText('<invoke name="emoji_get"><parameter name="md5">abc</parameter></invoke>'),
  '',
);
assert.equal(
  normalizeOutboundText('吃了吗\n<invoke name="read"><parameter name="file_path">x</parameter></invoke>'),
  '吃了吗',
);
assert.equal(
  normalizeOutboundText('<tool_use name="emoji_get"><parameter name="md5">abc</parameter></tool_use>'),
  '',
);
assert.equal(
  normalizeOutboundText('[Advisor review]\nThe assistant should: call the tool.\n吃了吗'),
  '吃了吗',
);
assert.equal(
  normalizeOutboundText('[系统提示：群聊随机接话] 不要输出 NO_REPLY [/系统提示]\n在吗'),
  '在吗',
);
assert.equal(normalizeOutboundText('NO_REPLY'), '');
assert.equal(normalizeOutboundText('[ERROR] TypeError: x'), '');
assert.equal(normalizeOutboundText('⚠️ Agent run failed (model: askdiandian/dots3-note-prev).'), '');
assert.equal(normalizeOutboundText('voice-clip.silk'), '');
assert.equal(looksLikeToolDraft('<invoke name="emoji_get"></invoke>'), true);
assert.equal(looksLikeToolDraft('NO_REPLY'), false);
console.log('✓ text normalize');

assert.equal(
  isContextOverflowNotice(
    '⚠️ Context is too large and auto-compaction could not recover this turn. Try again, use /compact, or use /new to start a fresh session.',
  ),
  true,
);
assert.equal(
  isContextOverflowNotice(
    '⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session.',
  ),
  true,
);
assert.equal(isContextOverflowNotice('好了，撤了'), false);
assert.equal(
  isContextOverflowAlreadyReset(
    "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.",
  ),
  true,
);
assert.equal(
  isContextOverflowError(new Error('Context is too large and auto-compaction could not recover this turn.')),
  true,
);
console.log('✓ overflow notice detect');

assert.equal(toMailboxUrl('https://xbot.example.com', 'openclaw'), 'wss://xbot.example.com/agent/ws?brain=openclaw');
assert.equal(toMailboxUrl('http://127.0.0.1:8787/', 'a b'), 'ws://127.0.0.1:8787/agent/ws?brain=a+b');
assert.equal(toMailboxUrl('https://x.example.com/base/', ''), 'wss://x.example.com/base/agent/ws');
assert.equal(toMailboxUrl('not a url', 'openclaw'), null);
assert.equal(toMailboxUrl('ftp://x.example.com', 'openclaw'), null);
assert.equal(computeBackoffMs(0, true, 1), 1000);
assert.equal(computeBackoffMs(3, true, 1), 8000);
assert.equal(computeBackoffMs(20, true, 1), 30_000);
assert.equal(computeBackoffMs(20, false, 1), 120_000);
assert.equal(computeBackoffMs(2, true, 0), 2000);
{
  const seen = new SeenIds(1000, 3);
  assert.equal(seen.check('a', 0), false);
  assert.equal(seen.check('a', 10), true);
  assert.equal(seen.check('a', 5000), false); // 过期后重新算
  seen.check('b', 5001);
  seen.check('c', 5002);
  seen.check('d', 5003); // 超上限，挤掉最老的 a
  assert.equal(seen.check('a', 5004), false);
}
console.log('✓ mailbox helpers');

{
  type Fake = {
    readyState: number;
    onopen: ((e: unknown) => void) | null;
    onmessage: ((e: { data: unknown }) => void) | null;
    onclose: ((e: { code?: number }) => void) | null;
    onerror: ((e: unknown) => void) | null;
    sent: string[];
    url: string;
    options: unknown;
    send: (data: string) => void;
    close: () => void;
  };
  const sockets: Fake[] = [];
  const FakeWebSocket = function (this: Fake, url: string, options?: unknown) {
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.sent = [];
    this.url = url;
    this.options = options;
    this.send = (data: string) => {
      this.sent.push(data);
    };
    this.close = () => {};
    sockets.push(this);
  } as unknown as WebSocketCtor;

  const received: string[] = [];
  const logs: string[] = [];
  const client = new XbotMailboxClient({
    getConfig: () => ({ baseUrl: 'https://xbot.example.com', token: 'secret', brain: 'openclaw' }),
    onMessage: (payload, id) => {
      received.push(`${id}:${String(payload.content)}`);
    },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    webSocketCtor: FakeWebSocket,
  });
  client.start();
  const ws = sockets[0]!;
  assert.equal(ws.url, 'wss://xbot.example.com/agent/ws?brain=openclaw');
  assert.deepEqual(ws.options, { headers: { Authorization: 'Bearer secret' } });

  ws.onopen?.({});
  assert.equal(client.status().connected, true);
  assert.deepEqual(JSON.parse(ws.sent[0]!), { t: 'hello', client: 'openclaw-xbot', version: '0.1.0' });

  const frame = JSON.stringify({ t: 'msg', id: 'm1', payload: { messageId: 'm1', content: '你好' } });
  ws.onmessage?.({ data: frame });
  ws.onmessage?.({ data: 'pong' });
  ws.onmessage?.({ data: frame }); // 重发：只回 ack，不再处理
  ws.onmessage?.({ data: JSON.stringify({ t: 'msg', id: 'm2', payload: 'bad' }) }); // 没正文：回 ack，跳过
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(received, ['m1:你好']);
  const acks = ws.sent.slice(1).map((raw) => JSON.parse(raw) as { t: string; id: string });
  assert.deepEqual(acks, [
    { t: 'ack', id: 'm1' },
    { t: 'ack', id: 'm1' },
    { t: 'ack', id: 'm2' },
  ]);

  client.stop();
  assert.equal(client.status().running, false);
  assert.equal(client.status().connected, false);
}
console.log('✓ mailbox client');

{
  assert.equal(isRetryableOutboundStatus(500), true);
  assert.equal(isRetryableOutboundStatus(502), true);
  assert.equal(isRetryableOutboundStatus(409), true);
  assert.equal(isRetryableOutboundStatus(429), true);
  assert.equal(isRetryableOutboundStatus(400), false);
  assert.equal(isRetryableOutboundStatus(401), false);

  const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const run = async (script: Array<() => Response | Promise<Response>>) => {
    const calls: Array<{ body: unknown; auth: string | null }> = [];
    const sleeps: number[] = [];
    let index = 0;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      calls.push({
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get('authorization'),
      });
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      return next();
    }) as typeof fetch;
    const warns: string[] = [];
    const outcome = await postOutboundWithRetry({
      url: 'https://x.test/openclaw/outbound',
      token: 't',
      body: JSON.stringify({ outboundId: 'o1' }),
      delaysMs: [3, 10, 30],
      fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
      onWarn: (m) => warns.push(m),
    }).then((raw) => ({ raw }), (error: Error) => ({ error: error.message }));
    return { calls, sleeps, warns, ...outcome };
  };

  // 一次成功：不重试，带 token。
  let result = await run([() => jsonResponse(200, { ok: true, sentCount: 2 })]);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].auth, 'Bearer t');
  assert.deepEqual(result.sleeps, []);
  assert.equal((result as { raw: { sentCount: number } }).raw.sentCount, 2);

  // 502 两次后成功：等 3、10，三次请求共用同一个 outboundId。
  result = await run([
    () => jsonResponse(502, { ok: false, error: 'send failed' }),
    () => { throw new Error('network down'); },
    () => jsonResponse(200, { ok: true, sentCount: 1 }),
  ]);
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.sleeps, [3, 10]);
  assert.deepEqual(result.calls.map((call) => (call.body as { outboundId: string }).outboundId), ['o1', 'o1', 'o1']);
  assert.equal(result.warns.length, 2);

  // 409（同一条正在发送）会重试，最后拿到 duplicate 视为成功。
  result = await run([
    () => jsonResponse(409, { ok: false, error: 'sending' }),
    () => jsonResponse(200, { ok: true, sentCount: 1, duplicate: true }),
  ]);
  assert.equal(result.calls.length, 2);
  assert.equal((result as { raw: { duplicate: boolean } }).raw.duplicate, true);

  // 4xx 不重试。
  result = await run([() => jsonResponse(400, { ok: false, error: 'replies is required' })]);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.sleeps, []);
  assert.equal((result as { error: string }).error, 'replies is required');

  // 一直失败：共 4 次，最后抛出最后一次的原因。
  result = await run([() => jsonResponse(503, { ok: false, error: 'unavailable' })]);
  assert.equal(result.calls.length, 4);
  assert.deepEqual(result.sleeps, [3, 10, 30]);
  assert.equal((result as { error: string }).error, 'unavailable');
}
console.log('✓ outbound retry');

{
  let clock = 1_000;
  const dedupe = createMediaDedupe(() => clock);
  const image = { type: 'image' as const, url: 'https://x.test/a.png' };
  const text = { type: 'text' as const, content: '好了' };

  // 首次：全部保留。
  let first = dedupe.claim('golem:group:r1', [image, text]);
  assert.equal(first.replies.length, 2);
  assert.equal(first.dropped, 0);

  // 10 秒内同会话同链接：只丢图，文字保留。
  clock += 5_000;
  const second = dedupe.claim('golem:group:r1', [image, text]);
  assert.deepEqual(second.replies, [text]);
  assert.equal(second.dropped, 1);

  // 别的会话不受影响。
  assert.equal(dedupe.claim('golem:group:r2', [image]).replies.length, 1);

  // 超过窗口：可以再发。
  clock += MEDIA_DEDUPE_WINDOW_MS + 1;
  first = dedupe.claim('golem:group:r1', [image]);
  assert.equal(first.replies.length, 1);

  // 发送失败后 release：重试不会被当成重复。
  first.release();
  assert.equal(dedupe.claim('golem:group:r1', [image]).replies.length, 1);
}
console.log('✓ media dedupe');
