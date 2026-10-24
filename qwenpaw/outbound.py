# -*- coding: utf-8 -*-
"""Map QwenPaw replies onto xchatbot /openclaw/outbound. No QwenPaw imports."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Dict, Iterable, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from config import as_str, trim_base_url

# Cloudflare 1010 会拦 Python-urllib 指纹；出站按浏览器头发。
_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

_HTTP = re.compile(r"^https?://", re.I)
_IMAGE_EXT = ("jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "avif")
_VIDEO_EXT = ("mp4", "mov", "m4v", "webm", "mkv")
_VOICE_EXT = ("mp3", "wav", "m4a", "aac", "ogg", "opus", "amr", "silk", "slk")
_MARKER = re.compile(r"^\[(Image|Video|File|Audio):\s*(.*?)]\s*$", re.I)


def is_http_url(value: str) -> bool:
    return bool(_HTTP.match(as_str(value)))


def _ext(url: str) -> str:
    path = as_str(url).split("?", 1)[0]
    base = path.rsplit("/", 1)[-1]
    if "." not in base:
        return ""
    return base.rsplit(".", 1)[-1].lower()


def kind_from_hint(
    url: str,
    *,
    mime_type: str = "",
    hinted: str = "",
) -> str:
    hint = as_str(hinted).lower()
    if hint in {"voice", "audio"}:
        return "voice"
    if hint in {"video", "image", "file", "emoji"}:
        return "image" if hint == "emoji" else hint
    mime = as_str(mime_type).lower()
    if mime.startswith("image/"):
        return "image"
    if mime.startswith("video/"):
        return "video"
    if mime.startswith("audio/"):
        return "voice"
    ext = _ext(url)
    if ext in _IMAGE_EXT:
        return "image"
    if ext in _VIDEO_EXT:
        return "video"
    if ext in _VOICE_EXT:
        return "voice"
    if ext:
        return "file"
    return "image"


def map_media_url(url: str, *, mime_type: str = "", hinted: str = "") -> Optional[Dict[str, str]]:
    href = as_str(url)
    if not is_http_url(href):
        return None
    kind = kind_from_hint(href, mime_type=mime_type, hinted=hinted)
    if kind == "voice":
        ext = _ext(href)
        return {"type": "voice", "url": href, "format": "4" if ext in {"silk", "slk"} else "2"}
    if kind == "video":
        return {"type": "video", "url": href}
    if kind == "file":
        return {"type": "link", "title": "文件", "url": href}
    return {"type": "image", "url": href}


def strip_internal_markers(text: str) -> str:
    s = str(text)
    s = re.sub(
        r"\[Advisor consultation #\d+][\s\S]*?\[End of advisor consultation #\d+]",
        "\n",
        s,
        flags=re.I,
    )
    s = re.sub(r"\[Advisor[^\]]*]", "", s, flags=re.I)
    return s


def normalize_outbound_text(text: str) -> str:
    """Keep agent text as-is, including newlines and protocol lines."""
    if not text:
        return ""
    s = str(text).replace("\r\n", "\n").replace("\r", "\n")
    return strip_internal_markers(s).strip("\n")


def split_send_text(text: str) -> tuple[str, List[Dict[str, str]]]:
    """Drop BaseChannel `[Image: url]` markers; keep spoken text."""
    replies: List[Dict[str, str]] = []
    kept: List[str] = []
    for line in str(text or "").replace("\r\n", "\n").split("\n"):
        match = _MARKER.match(line.strip())
        if not match:
            kept.append(line)
            continue
        mapped = map_media_url(match.group(2))
        if mapped:
            replies.append(mapped)
    spoken = normalize_outbound_text("\n".join(kept))
    return spoken, replies


def replies_from_text(text: str) -> List[Dict[str, str]]:
    spoken, media = split_send_text(text)
    out = list(media)
    if spoken:
        out.append({"type": "text", "content": spoken})
    return out


def replies_from_media_part(part: Any) -> List[Dict[str, str]]:
    if part is None:
        return []
    hinted = as_str(getattr(part, "type", None) or (part.get("type") if isinstance(part, dict) else ""))
    url = ""
    mime = ""
    if isinstance(part, dict):
        url = as_str(part.get("image_url") or part.get("video_url") or part.get("file_url") or part.get("data") or part.get("url"))
        mime = as_str(part.get("mime_type") or part.get("format"))
        hinted = as_str(part.get("kind") or hinted)
    else:
        url = as_str(
            getattr(part, "image_url", None)
            or getattr(part, "video_url", None)
            or getattr(part, "file_url", None)
            or getattr(part, "data", None)
            or getattr(part, "url", None)
        )
        mime = as_str(getattr(part, "format", None))
    mapped = map_media_url(url, mime_type=mime, hinted=hinted)
    return [mapped] if mapped else []


def build_outbound_body(
    *,
    platform: str,
    source: str,
    sender_id: str,
    room_id: str = "",
    message_id: str = "",
    replies: Iterable[Dict[str, Any]],
) -> Dict[str, Any]:
    items = [item for item in replies if item]
    return {
        "platform": platform,
        "source": "group" if source == "group" else "private",
        "from": sender_id,
        "roomId": room_id or None,
        "messageId": message_id or None,
        "replies": items,
    }


def outbound_headers(token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": _BROWSER_UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }


def http_error_detail(status: int, body: str) -> str:
    text = body or ""
    lowered = text.lower()
    if "1010" in text or "error code: 1010" in lowered:
        return (
            f"HTTP {status} Cloudflare 1010 "
            "(edge blocked this client; not a token mismatch)"
        )
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        return as_str(parsed.get("error")) or f"HTTP {status}"
    stripped = text.strip()
    if stripped:
        return stripped[:300]
    return f"HTTP {status}"


def _parse_outbound_ok(raw: str) -> Dict[str, Any]:
    parsed = json.loads(raw) if raw else {}
    if not isinstance(parsed, dict) or parsed.get("ok") is not True:
        raise RuntimeError(
            as_str(parsed.get("error") if isinstance(parsed, dict) else parsed) or "outbound failed"
        )
    return parsed


def _post_outbound_urllib(
    *,
    url: str,
    token: str,
    payload: bytes,
    timeout: float,
) -> Dict[str, Any]:
    req = Request(url, data=payload, method="POST", headers=outbound_headers(token))
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return _parse_outbound_ok(raw)
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(http_error_detail(exc.code, detail)) from exc
    except URLError as exc:
        raise RuntimeError(str(exc.reason or exc)) from exc


async def post_outbound(
    *,
    api_base: str,
    token: str,
    body: Dict[str, Any],
    timeout: float = 30,
) -> Dict[str, Any]:
    base = trim_base_url(api_base)
    if not base:
        raise RuntimeError("xchatbotApiBaseUrl is not configured")
    if not token:
        raise RuntimeError("xchatbotToken is not configured")
    url = f"{base}/openclaw/outbound"
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    try:
        import aiohttp
    except ImportError:
        return await asyncio.to_thread(
            _post_outbound_urllib,
            url=url,
            token=token,
            payload=payload,
            timeout=timeout,
        )

    client_timeout = aiohttp.ClientTimeout(total=timeout)
    async with aiohttp.ClientSession(timeout=client_timeout) as session:
        async with session.post(url, data=payload, headers=outbound_headers(token)) as resp:
            raw = await resp.text()
            if resp.status >= 400:
                raise RuntimeError(http_error_detail(resp.status, raw))
            return _parse_outbound_ok(raw)
