# -*- coding: utf-8 -*-
"""Parse xchatbot inbound JSON. No QwenPaw imports."""

from __future__ import annotations

from typing import Any, Dict, List

from config import as_str

MEDIA_KINDS = ("image", "video", "emoji", "voice")


class InboundError(ValueError):
    """Bad inbound payload."""


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

    ts_raw = data.get("timestamp")
    try:
        timestamp = int(ts_raw) if ts_raw is not None else 0
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

    to_handle = (
        f"{platform}:group:{peer_id}" if kind == "group" else f"{platform}:user:{sender_id}"
    )
    return {
        "messageId": message_id,
        "platform": platform,
        "source": source,
        "kind": kind,
        "from": sender_id,
        "senderName": sender_name,
        "roomId": room_id,
        "conversationId": conversation_id or peer_id,
        "toHandle": to_handle,
        "type": msg_type,
        "content": content or f"[{msg_type}]",
        "mediaUrl": media_url,
        "mediaKind": media_kind,
        "videoUrl": video_url,
        "timestamp": timestamp,
        "sessionId": f"xbot:{to_handle}",
    }


def media_parts(parsed: Dict[str, Any]) -> List[Dict[str, str]]:
    parts: List[Dict[str, str]] = []
    media_url = parsed.get("mediaUrl") or ""
    video_url = parsed.get("videoUrl") or ""
    kind = parsed.get("mediaKind") or "image"
    if media_url:
        parts.append({"url": media_url, "kind": kind if kind in MEDIA_KINDS else "image"})
    if video_url and video_url != media_url:
        parts.append({"url": video_url, "kind": "video"})
    return parts
