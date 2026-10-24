# -*- coding: utf-8 -*-
"""POST replies to xchatbot /openclaw/outbound."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def _as_str(value: object) -> str:
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    return str(value).strip()


def trim_base_url(url: str) -> str:
    return _as_str(url).rstrip("/")


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
    if "1010" in text or "error code: 1010" in text.lower():
        return f"HTTP {status} Cloudflare 1010 (edge blocked this client)"
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        return _as_str(parsed.get("error")) or f"HTTP {status}"
    stripped = text.strip()
    return stripped[:300] if stripped else f"HTTP {status}"


def _parse_ok(raw: str) -> Dict[str, Any]:
    parsed = json.loads(raw) if raw else {}
    if not isinstance(parsed, dict) or parsed.get("ok") is not True:
        raise RuntimeError(_as_str(parsed.get("error") if isinstance(parsed, dict) else parsed) or "outbound failed")
    return parsed


def _post_urllib(*, url: str, token: str, payload: bytes, timeout: float) -> Dict[str, Any]:
    req = Request(url, data=payload, method="POST", headers=outbound_headers(token))
    try:
        with urlopen(req, timeout=timeout) as resp:
            return _parse_ok(resp.read().decode("utf-8"))
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
        raise RuntimeError("xchatbot api base is not configured")
    if not token:
        raise RuntimeError("xchatbot token is not configured")
    url = f"{base}/openclaw/outbound"
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    return await asyncio.to_thread(_post_urllib, url=url, token=token, payload=payload, timeout=timeout)
