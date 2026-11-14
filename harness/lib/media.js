/**
 * 回复里的本地图片 → 公网链接。
 *
 * 模型截屏、画图之类会把文件存在本机，再写 `image:C:\...\screen.jpg`。
 * 微信那头拿不到本机路径，所以发之前由这里传到图床，换成 https 链接。
 *
 * 只认工作目录里的图片文件：群里谁都能说话，不能让人借模型把本机别的文件传出去。
 *
 * 手机在云端那台机器上时，截图存在它的 /tmp 里：配了 phoneHost 就先
 * 用 ssh 取回来再传。远端只认 /tmp/<文件名>.<图片后缀>，不认子目录、不认 ..。
 */
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

const UPLOAD_LINK_URL = 'https://upfile.live/api/file/getUploadLink/'
const FILE_ACCESS_PREFIX = 'https://file.upfile.live/'
const MAX_BYTES = 10 * 1024 * 1024
const UPLOAD_TIMEOUT_MS = 15_000

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

const IMAGE_LINE = /^([ \t]*image:[ \t]*)(.+?)[ \t]*$/gim
const PHONE_PATH = /^\/tmp\/[A-Za-z0-9._-]+\.(?:jpe?g|png|gif|webp)$/iu
const PHONE_FETCH_TIMEOUT_MS = 40_000
const UPLOAD_FAILED_LINE = '图没发出去，再试下'

/** 已经是链接的不用管。 */
function isRemote(value) {
  return /^(?:https?:|data:)/iu.test(value)
}

function toFilePath(value) {
  const raw = value.replace(/^["'`]|["'`]$/gu, '')
  if (/^file:\/\//iu.test(raw)) {
    try {
      return decodeURIComponent(new URL(raw).pathname).replace(/^\/(?=[a-zA-Z]:)/u, '')
    } catch {
      return null
    }
  }
  return raw
}

function inside(root, file) {
  const relative = path.relative(root, file)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** 通过检查返回真实路径和类型；不合格返回 null。 */
async function checkLocalImage(value, root) {
  const candidate = toFilePath(value)
  if (!candidate) return null
  const contentType = IMAGE_TYPES[path.extname(candidate).toLowerCase()]
  if (!contentType) return null
  try {
    const realRoot = await fsp.realpath(root)
    const real = await fsp.realpath(path.resolve(realRoot, candidate))
    if (!inside(realRoot, real)) return null
    const stat = await fsp.stat(real)
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) return null
    return { file: real, contentType }
  } catch {
    return null
  }
}

/** 传到 upfile.live（Worker 入站转存用的是同一个），返回直链。 */
export async function uploadToUpfile(bytes, { fileName, contentType }) {
  const link = await fetch(UPLOAD_LINK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Accept: 'application/json, text/plain, */*',
    },
    body: new URLSearchParams({ vipCode: '', file_name: fileName }).toString(),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  })
  if (!link.ok) throw new Error(`getUploadLink HTTP ${link.status}`)
  const payload = await link.json()
  const uploadUrl = String(payload?.data?.upload_url || '').trim()
  const fileKey = String(payload?.data?.file_key || '').trim()
  if (!uploadUrl || !fileKey) throw new Error('getUploadLink 缺字段')
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: new Blob([bytes], { type: contentType }),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  })
  if (!put.ok) throw new Error(`PUT HTTP ${put.status}`)
  return new URL(fileKey, FILE_ACCESS_PREFIX).toString()
}

/** 云手机上的图：只认 /tmp 下的单个图片文件（不含 ..、子目录）。 */
export function isPhonePath(value) {
  const raw = value.replace(/^["'`]|["'`]$/gu, '')
  return PHONE_PATH.test(raw) && !raw.includes('..') ? raw : null
}

/** 用 ssh 把云手机上的文件原样读回来。host 是 ~/.ssh/config 里的别名。 */
export function fetchFromPhone(host, remotePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, 'cat', remotePath],
      { encoding: 'buffer', maxBuffer: MAX_BYTES + 1024, timeout: PHONE_FETCH_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })
}

/** 传图床，失败补传一次；成功返回链接，失败返回 null。 */
async function uploadWithRetry(readBytes, ext, contentType, upload, log, label) {
  let lastError = null
  // 图床偶尔会抖一下，补传一次
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const bytes = await readBytes()
      return await upload(bytes, { fileName: `xbot-${Date.now()}${ext}`, contentType })
    } catch (error) {
      lastError = error
    }
  }
  log?.warn(`[xbot] 图片传不上去 (${label}): ${lastError?.message}`)
  return null
}

/**
 * 把回复里 `image:<本地路径>` 换成 `image:<链接>`。
 * 路径不合规或上传失败的那一行换成一句人话，绝不把本机路径原样发出去。
 *
 * @param {string} text
 * @param {{ root: string, log?: { warn: (m: string) => void }, upload?: typeof uploadToUpfile }} options
 */
export async function publishLocalImages(
  text,
  { root, log, upload = uploadToUpfile, phoneHost = '', fetchPhone = fetchFromPhone },
) {
  const matches = [...String(text || '').matchAll(IMAGE_LINE)]
  if (!matches.length) return text

  const replacements = new Map()
  for (const match of matches) {
    const value = match[2].trim()
    if (replacements.has(value) || isRemote(value)) continue
    const remotePath = phoneHost ? isPhonePath(value) : null
    if (remotePath) {
      const ext = path.posix.extname(remotePath).toLowerCase()
      const url = await uploadWithRetry(
        async () => {
          const bytes = await fetchPhone(phoneHost, remotePath)
          if (!bytes?.length || bytes.length > MAX_BYTES) throw new Error('图片为空或太大')
          return bytes
        },
        ext,
        IMAGE_TYPES[ext],
        upload,
        log,
        path.posix.basename(remotePath),
      )
      replacements.set(value, url)
      continue
    }
    const found = await checkLocalImage(value, root)
    if (!found) {
      log?.warn(`[xbot] 本地图片不在工作目录或不是图片，没发: ${path.basename(value)}`)
      replacements.set(value, null)
      continue
    }
    const url = await uploadWithRetry(
      () => fsp.readFile(found.file),
      path.extname(found.file).toLowerCase(),
      found.contentType,
      upload,
      log,
      path.basename(found.file),
    )
    replacements.set(value, url)
  }

  return String(text).replace(IMAGE_LINE, (line, prefix, rawValue) => {
    const value = rawValue.trim()
    if (!replacements.has(value)) return line
    const url = replacements.get(value)
    return url ? `${prefix}${url}` : UPLOAD_FAILED_LINE
  })
}
