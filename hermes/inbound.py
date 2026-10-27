# -*- coding: utf-8 -*-
"""Parse xchatbot inbound JSON. No Hermes imports."""

from __future__ import annotations

from typing import Any, Dict, List

MEDIA_KINDS = ("image", "video", "emoji", "voice")

# Hermes cache kinds: image / video / audio.
_CACHE_KINDS = {"image": "image", "emoji": "image", "video": "video", "voice": "audio"}


class InboundError(ValueError):
    """Bad inbound payload."""


def as_str(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    return str(value).strip()


def _source(raw: Any) -> str:
    value = as_str(raw).lower()
    if value in {"group", "chatroom"}:
        return "group"
    return "private"


def parse_inbound(params: Any) -> Dict[str, Any]:
    data = params if isinstance(params, dict) else {}
    message_id = as_str(data.get("messageId") or data.get("msgId") or data.get("id"))
    source = _source(data.get("source"))
    sender_id = as_str(data.get("from") or data.get("senderId"))
    sender_name = as_str(data.get("senderName") or sender_id)
    room_id = as_str(data.get("roomId") or data.get("groupId"))
    conversation_id = as_str(data.get("conversationId"))
    platform = as_str(data.get("platform"))
    msg_type = as_str(data.get("type") or "text").lower() or "text"
    content = as_str(data.get("content") or data.get("text"))
    media_url = as_str(data.get("mediaUrl"))
    video_url = as_str(data.get("videoUrl"))
    media_kind = as_str(data.get("mediaKind")).lower()
    if media_kind not in MEDIA_KINDS:
        media_kind = ""

    try:
        timestamp = int(data.get("timestamp") or 0)
    except (TypeError, ValueError):
        timestamp = 0
    if timestamp <= 0:
        import time

        timestamp = int(time.time() * 1000)
    elif timestamp < 1_000_000_000_000:
        timestamp *= 1000

    kind = "group" if source == "group" else "direct"
    peer_id = room_id or conversation_id if kind == "group" else sender_id
    if not message_id:
        raise InboundError("messageId is required")
    if not sender_id:
        raise InboundError("from is required")
    if not platform:
        raise InboundError("platform is required")
    if kind == "group" and not peer_id:
        raise InboundError("roomId is required for group messages")

    chat_id = f"{platform}:group:{peer_id}" if kind == "group" else f"{platform}:user:{sender_id}"
    return {
        "messageId": message_id,
        "platform": platform,
        "source": source,
        "kind": kind,
        "from": sender_id,
        "senderName": sender_name,
        "roomId": room_id,
        "conversationId": conversation_id or peer_id,
        "chatId": chat_id,
        "type": msg_type,
        "content": content or f"[{msg_type}]",
        "mediaUrl": media_url,
        "mediaKind": media_kind,
        "videoUrl": video_url,
        "timestamp": timestamp,
    }


def media_parts(parsed: Dict[str, Any]) -> List[Dict[str, str]]:
    """Remote media to download, with the Hermes cache kind for each."""
    parts: List[Dict[str, str]] = []
    media_url = parsed.get("mediaUrl") or ""
    video_url = parsed.get("videoUrl") or ""
    kind = parsed.get("mediaKind") or "image"
    if media_url:
        parts.append({"url": media_url, "kind": kind, "cacheKind": _CACHE_KINDS.get(kind, "image")})
    if video_url and video_url != media_url:
        parts.append({"url": video_url, "kind": "video", "cacheKind": "video"})
    return parts


def route_from_chat_id(chat_id: str) -> Dict[str, str] | None:
    """Fallback when a send has no remembered inbound route."""
    raw = as_str(chat_id)
    kind_at = raw.find(":group:")
    kind = "group"
    if kind_at < 0:
        kind_at = raw.find(":user:")
        kind = "direct"
    if kind_at <= 0:
        return None
    platform = raw[:kind_at]
    ident = raw[kind_at + len(":group:" if kind == "group" else ":user:") :]
    if not platform or not ident:
        return None
    if kind == "group":
        return {"platform": platform, "source": "group", "from": ident, "roomId": ident, "messageId": ""}
    return {"platform": platform, "source": "private", "from": ident, "roomId": "", "messageId": ""}
