# -*- coding: utf-8 -*-
"""本地图片 → 公网链接。

模型截屏、画图会把图存在本机；微信那头拿不到本机路径，所以发之前传到图床换成链接。
路径是否允许由 Hermes 自己的 ``validate_media_delivery_path`` 把关（调用方传进来），
这里只再加两道：只认图片后缀、不超过 10MB，别让它顺手把别的文件传出去。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from typing import Any, Callable, Dict, Optional
from urllib.parse import unquote, urlencode, urlparse
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

UPLOAD_LINK_URL = "https://upfile.live/api/file/getUploadLink/"
FILE_ACCESS_PREFIX = "https://file.upfile.live/"
MAX_BYTES = 10 * 1024 * 1024
UPLOAD_TIMEOUT = 15
UPLOAD_FAILED_LINE = "图没发出去，再试下"

IMAGE_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

_IMAGE_LINE = re.compile(r"^([ \t]*image:[ \t]*)(.+?)[ \t]*$", re.IGNORECASE | re.MULTILINE)
_REMOTE = re.compile(r"^(?:https?:|data:)", re.IGNORECASE)

Uploader = Callable[[bytes, str, str], str]


def is_remote(value: str) -> bool:
    return bool(_REMOTE.match(value.strip()))


def to_file_path(value: str) -> Optional[str]:
    raw = value.strip().strip("\"'`")
    if raw.lower().startswith("file://"):
        try:
            path = unquote(urlparse(raw).path)
        except ValueError:
            return None
        return re.sub(r"^/(?=[A-Za-z]:)", "", path)
    return raw or None


def check_image(path: str) -> Optional[str]:
    """通过返回 content-type；后缀不对、不是文件、空文件、太大都返回 None。"""
    content_type = IMAGE_TYPES.get(os.path.splitext(path)[1].lower())
    if not content_type:
        return None
    try:
        if not os.path.isfile(path):
            return None
        size = os.path.getsize(path)
    except OSError:
        return None
    if size <= 0 or size > MAX_BYTES:
        return None
    return content_type


def upload_to_upfile(data: bytes, file_name: str, content_type: str) -> str:
    """传到 upfile.live（Worker 入站转存用的是同一个），返回直链。"""
    link_req = Request(
        UPLOAD_LINK_URL,
        data=urlencode({"vipCode": "", "file_name": file_name}).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "Accept": "application/json, text/plain, */*",
            "User-Agent": BROWSER_UA,  # Python 默认的 UA 会被图床 403
        },
    )
    with urlopen(link_req, timeout=UPLOAD_TIMEOUT) as resp:
        payload: Dict[str, Any] = json.loads(resp.read().decode("utf-8"))
    info = payload.get("data") or {}
    upload_url = str(info.get("upload_url") or "").strip()
    file_key = str(info.get("file_key") or "").strip()
    if not upload_url or not file_key:
        raise RuntimeError("getUploadLink 缺字段")
    put_req = Request(
        upload_url,
        data=data,
        method="PUT",
        headers={"Content-Type": content_type, "User-Agent": BROWSER_UA},
    )
    with urlopen(put_req, timeout=UPLOAD_TIMEOUT):
        pass
    return FILE_ACCESS_PREFIX + file_key.lstrip("/")


def _publish_sync(path: str, content_type: str, upload: Uploader) -> Optional[str]:
    last: Optional[Exception] = None
    for _ in range(2):  # 图床偶尔会抖一下，补传一次
        try:
            with open(path, "rb") as handle:
                data = handle.read()
            name = f"xbot-{int(time.time() * 1000)}{os.path.splitext(path)[1].lower()}"
            return upload(data, name, content_type)
        except Exception as exc:  # noqa: BLE001
            last = exc
    logger.warning("xbot: image upload failed (%s): %s", os.path.basename(path), last)
    return None


async def publish_image_file(path: str, *, upload: Uploader = upload_to_upfile) -> Optional[str]:
    """已通过路径校验的本地图片 → 链接。不合规或传失败返回 None。"""
    content_type = check_image(path)
    if not content_type:
        logger.warning("xbot: not a sendable image: %s", os.path.basename(path))
        return None
    return await asyncio.to_thread(_publish_sync, path, content_type, upload)


async def publish_local_images(
    text: str,
    *,
    validate: Callable[[str], Optional[str]],
    upload: Uploader = upload_to_upfile,
) -> str:
    """把回复里 ``image:<本地路径>`` 换成 ``image:<链接>``。

    路径不合规或上传失败的那一行换成一句人话，绝不把本机路径原样发出去。
    ``validate`` 返回安全的绝对路径，不放行返回 None。
    """
    matches = list(_IMAGE_LINE.finditer(text or ""))
    if not matches:
        return text

    replacements: Dict[str, Optional[str]] = {}
    for match in matches:
        value = match.group(2).strip()
        if value in replacements or is_remote(value):
            continue
        candidate = to_file_path(value)
        safe = validate(candidate) if candidate else None
        replacements[value] = await publish_image_file(safe, upload=upload) if safe else None

    def swap(match: "re.Match[str]") -> str:
        value = match.group(2).strip()
        if value not in replacements:
            return match.group(0)
        url = replacements[value]
        return f"{match.group(1)}{url}" if url else UPLOAD_FAILED_LINE

    return _IMAGE_LINE.sub(swap, text)
