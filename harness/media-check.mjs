// 本地图片转链接的规则自检：node harness/media-check.mjs [--real]
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { publishLocalImages } from './lib/media.js'

const base = mkdtempSync(path.join(tmpdir(), 'xbot-media-'))
const root = path.join(base, 'work')
mkdirSync(root)
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
writeFileSync(path.join(root, 'screen.png'), png)
writeFileSync(path.join(root, 'note.txt'), 'x')
writeFileSync(path.join(base, 'secret.png'), png) // 工作目录外

const warns = []
const log = { warn: (m) => warns.push(m) }
let uploads = 0
const fake = async () => `https://file.example/${++uploads}.png`

const out = await publishLocalImages(
  [
    '截好了',
    `image:${path.join(root, 'screen.png')}`,
    'image:screen.png',
    `image:${path.join(base, 'secret.png')}`,
    `image:${path.join(root, 'note.txt')}`,
    'image:https://x.com/a.jpg',
    `image:${path.join(root, '..', 'secret.png')}`,
  ].join('\n'),
  { root, log, upload: fake },
)
const lines = out.split('\n')
assert.equal(lines[0], '截好了')
assert.equal(lines[1], 'image:https://file.example/1.png')
assert.equal(lines[2], 'image:https://file.example/2.png')
assert.equal(lines[3], '图没发出去，再试下') // 目录外
assert.equal(lines[4], '图没发出去，再试下') // 不是图片
assert.equal(lines[5], 'image:https://x.com/a.jpg') // 链接原样
assert.equal(lines[6], '图没发出去，再试下') // .. 绕出去
assert.equal(uploads, 2)
assert.ok(!out.includes(base), '不能把本机路径发出去')

// 上传失败也不泄露路径
const failed = await publishLocalImages(`image:${path.join(root, 'screen.png')}`, {
  root,
  log,
  upload: async () => {
    throw new Error('boom')
  },
})
assert.equal(failed, '图没发出去，再试下')

// 云手机：只认 /tmp/<文件名>.<图片后缀>，其余一律不取
{
  const fetched = []
  const fetchPhone = async (host, remote) => {
    fetched.push(`${host}:${remote}`)
    return png
  }
  const run = (text, extra = {}) =>
    publishLocalImages(text, { root, log, upload: fake, phoneHost: 'xbot-phone', fetchPhone, ...extra })

  const ok = await run('image:/tmp/screen.jpg')
  assert.match(ok, /^image:https:\/\/file\.example\//)
  assert.deepEqual(fetched, ['xbot-phone:/tmp/screen.jpg'])

  fetched.length = 0
  for (const bad of [
    'image:/etc/passwd',
    'image:/tmp/sub/a.jpg',
    'image:/tmp/../etc/a.jpg',
    'image:/tmp/a.txt',
    'image:/tmp/a b.jpg',
    'image:/tmp/$(id).jpg',
  ]) {
    assert.equal(await run(bad), '图没发出去，再试下', bad)
  }
  assert.equal(fetched.length, 0, '不合规的路径不能去云端取')

  // 没配 phoneHost 时 /tmp 路径当普通本地路径处理（不在工作目录，不发）
  fetched.length = 0
  assert.equal(await run('image:/tmp/screen.jpg', { phoneHost: '' }), '图没发出去，再试下')
  assert.equal(fetched.length, 0)

  // 取不回来 / 取回空文件 → 一句人话，不泄露路径
  const broken = await run('image:/tmp/screen.jpg', {
    fetchPhone: async () => {
      throw new Error('ssh: timeout')
    },
  })
  assert.equal(broken, '图没发出去，再试下')
  assert.equal(await run('image:/tmp/screen.jpg', { fetchPhone: async () => Buffer.alloc(0) }), '图没发出去，再试下')
}

if (process.argv.includes('--real')) {
  const real = await publishLocalImages(`image:${path.join(root, 'screen.png')}`, { root, log })
  console.log('real:', real)
  assert.match(real, /^image:https:\/\/file\.upfile\.live\//)
}
console.log('media ok', warns.length, 'warns')
