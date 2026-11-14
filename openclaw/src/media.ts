import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { XchatbotReply } from './config.ts';

/**
 * 回复里的本地图片 → 公网链接。
 *
 * 模型截屏、画图会把图存在本机，再写 `image:C:\...\screen.jpg` 或把本地路径放进 mediaUrl。
 * 微信那头拿不到本机路径，所以发之前传到图床，换成 https 链接。
 *
 * 只认指定目录里的图片文件：群里谁都能说话，不能让人借模型把本机别的文件传出去。
 *
 * 手机在云端那台机器上时，截图存在它的 /tmp 里：配了 phoneHost 就先用 ssh 取回来再传。
 * 远端只认 /tmp/<文件名>.<图片后缀>，不认子目录、不认 ..。
 */

const UPLOAD_LINK_URL = 'https://upfile.live/api/file/getUploadLink/';
const FILE_ACCESS_PREFIX = 'https://file.upfile.live/';
const MAX_BYTES = 10 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 15_000;

export const UPLOAD_FAILED_LINE = '图没发出去，再试下';

const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const IMAGE_LINE = /^([ \t]*image:[ \t]*)(.+?)[ \t]*$/gim;
const PHONE_PATH = /^\/tmp\/[A-Za-z0-9._-]+\.(?:jpe?g|png|gif|webp)$/i;
const PHONE_FETCH_TIMEOUT_MS = 40_000;

export type Uploader = (
  bytes: Buffer,
  meta: { fileName: string; contentType: string },
) => Promise<string>;

export type LocalizeOptions = {
  /** 只认这些目录里的文件。 */
  roots: string[];
  onWarn?: (message: string) => void;
  upload?: Uploader;
  /** ~/.ssh/config 里云手机的别名；留空则不取云端文件。 */
  phoneHost?: string;
  /** 取云手机上的文件，测试时可替换。 */
  fetchPhone?: (host: string, remotePath: string) => Promise<Buffer>;
};

/** 云手机上的图：只认 /tmp 下的单个图片文件。 */
export function phonePath(value: string): string | null {
  const raw = value.trim().replace(/^["'`]|["'`]$/g, '');
  return PHONE_PATH.test(raw) && !raw.includes('..') ? raw : null;
}

/** 用 ssh 把云手机上的文件原样读回来。 */
export function fetchFromPhone(host: string, remotePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, 'cat', remotePath],
      { encoding: 'buffer', maxBuffer: MAX_BYTES + 1024, timeout: PHONE_FETCH_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** 默认只认 OpenClaw 的工作区；要放开别的目录在 channels.xbot.mediaRoots 里配。 */
export function defaultMediaRoots(): string[] {
  return [path.join(os.homedir(), '.openclaw', 'workspace')];
}

export function isRemoteUrl(value: string): boolean {
  return /^(?:https?:|data:)/i.test(value.trim());
}

function toFilePath(value: string): string | null {
  const raw = value.trim().replace(/^["'`]|["'`]$/g, '');
  if (/^file:\/\//i.test(raw)) {
    try {
      return decodeURIComponent(new URL(raw).pathname).replace(/^\/(?=[a-zA-Z]:)/, '');
    } catch {
      return null;
    }
  }
  return raw || null;
}

/** 看着像本地图片路径（后缀是图片、不是链接）。是否放行另看目录。 */
export function isLocalImagePath(value: string): boolean {
  const candidate = toFilePath(value);
  if (!candidate || isRemoteUrl(candidate)) return false;
  return path.extname(candidate).toLowerCase() in IMAGE_TYPES;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function checkLocalImage(
  value: string,
  roots: string[],
): Promise<{ file: string; contentType: string } | null> {
  const candidate = toFilePath(value);
  if (!candidate) return null;
  const contentType = IMAGE_TYPES[path.extname(candidate).toLowerCase()];
  if (!contentType) return null;
  for (const root of roots) {
    try {
      const realRoot = await fsp.realpath(root);
      const real = await fsp.realpath(path.resolve(realRoot, candidate));
      if (!inside(realRoot, real)) continue;
      const stat = await fsp.stat(real);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) return null;
      return { file: real, contentType };
    } catch {
      // 这个目录里没有，试下一个
    }
  }
  return null;
}

/** 传到 upfile.live（Worker 入站转存用的是同一个），返回直链。 */
export const uploadToUpfile: Uploader = async (bytes, { fileName, contentType }) => {
  const link = await fetch(UPLOAD_LINK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      accept: 'application/json, text/plain, */*',
    },
    body: new URLSearchParams({ vipCode: '', file_name: fileName }).toString(),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!link.ok) throw new Error(`getUploadLink HTTP ${link.status}`);
  const payload = (await link.json()) as { data?: { upload_url?: string; file_key?: string } };
  const uploadUrl = String(payload?.data?.upload_url ?? '').trim();
  const fileKey = String(payload?.data?.file_key ?? '').trim();
  if (!uploadUrl || !fileKey) throw new Error('getUploadLink 缺字段');
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Blob([new Uint8Array(bytes)], { type: contentType }),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!put.ok) throw new Error(`PUT HTTP ${put.status}`);
  return new URL(fileKey, FILE_ACCESS_PREFIX).toString();
};

/** 一个本地图片值 → 链接；不合规或传失败返回 null。 */
export async function publishLocalImage(value: string, options: LocalizeOptions): Promise<string | null> {
  const upload = options.upload ?? uploadToUpfile;
  const remote = options.phoneHost ? phonePath(value) : null;

  let label: string;
  let ext: string;
  let contentType: string;
  let readBytes: () => Promise<Buffer>;
  if (remote) {
    const host = options.phoneHost as string;
    const fetchPhone = options.fetchPhone ?? fetchFromPhone;
    label = path.posix.basename(remote);
    ext = path.posix.extname(remote).toLowerCase();
    contentType = IMAGE_TYPES[ext];
    readBytes = async () => {
      const bytes = await fetchPhone(host, remote);
      if (!bytes?.length || bytes.length > MAX_BYTES) throw new Error('图片为空或太大');
      return bytes;
    };
  } else {
    const found = await checkLocalImage(value, options.roots);
    if (!found) {
      options.onWarn?.(`[xbot] 本地图片不在允许的目录或不是图片，没发: ${path.basename(value)}`);
      return null;
    }
    label = path.basename(found.file);
    ext = path.extname(found.file).toLowerCase();
    contentType = found.contentType;
    readBytes = () => fsp.readFile(found.file);
  }

  let lastError: unknown = null;
  // 图床偶尔会抖一下，补传一次
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const bytes = await readBytes();
      return await upload(bytes, { fileName: `xbot-${Date.now()}${ext}`, contentType });
    } catch (error) {
      lastError = error;
    }
  }
  options.onWarn?.(
    `[xbot] 图片传不上去 (${label}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
  return null;
}

/** 把文字里 `image:<本地路径>` 换成 `image:<链接>`；失败的那行换成一句人话，绝不把本机路径发出去。 */
export async function publishLocalImagesInText(text: string, options: LocalizeOptions): Promise<string> {
  const matches = [...String(text || '').matchAll(IMAGE_LINE)];
  if (!matches.length) return text;

  const replacements = new Map<string, string | null>();
  for (const match of matches) {
    const value = match[2].trim();
    if (replacements.has(value) || isRemoteUrl(value)) continue;
    replacements.set(value, await publishLocalImage(value, options));
  }
  return String(text).replace(IMAGE_LINE, (line, prefix: string, rawValue: string) => {
    const value = rawValue.trim();
    if (!replacements.has(value)) return line;
    const url = replacements.get(value);
    return url ? `${prefix}${url}` : UPLOAD_FAILED_LINE;
  });
}

/** 发之前统一处理：文字里的 image: 行，以及 url 还是本地路径的 image 回复。 */
export async function localizeReplies(
  replies: XchatbotReply[],
  options: LocalizeOptions,
): Promise<XchatbotReply[]> {
  const out: XchatbotReply[] = [];
  for (const reply of replies) {
    if (reply.type === 'text') {
      const content = (await publishLocalImagesInText(reply.content, options)).trim();
      if (content) out.push({ type: 'text', content });
      continue;
    }
    if (reply.type === 'image' && !isRemoteUrl(reply.url)) {
      const url = await publishLocalImage(reply.url, options);
      out.push(url ? { type: 'image', url } : { type: 'text', content: UPLOAD_FAILED_LINE });
      continue;
    }
    out.push(reply);
  }
  return out;
}
