# -*- coding: utf-8 -*-
"""QwenPaw xbot channel: xchatbot inbound → agent → /openclaw/outbound."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from qwenpaw.app.channels.base import (
    BaseChannel,
    OnReplySent,
    ProcessHandler,
)
from qwenpaw.app.channels.renderer import ChannelDisplayConfig

from config import CHANNEL_ID, as_str, cfg_get, trim_base_url
from inbound import media_parts
from outbound import build_outbound_body, post_outbound, replies_from_text

logger = logging.getLogger(__name__)

_LIVE: Optional["XbotChannel"] = None


def get_live_channel() -> Optional["XbotChannel"]:
    return _LIVE


def _content_types():
    from qwenpaw.app.channels.base import (
        AudioContent,
        ContentType,
        ImageContent,
        TextContent,
        VideoContent,
    )

    return AudioContent, ContentType, ImageContent, TextContent, VideoContent


class XbotChannel(BaseChannel):
    """Push channel. HTTP inbound is mounted by the plugin router."""

    channel = CHANNEL_ID
    uses_manager_queue = True

    def __init__(
        self,
        process: ProcessHandler,
        enabled: bool = False,
        xchatbot_api_base_url: str = "",
        xchatbot_token: str = "",
        inbound_token: str = "",
        bot_prefix: str = "",
        on_reply_sent: OnReplySent = None,
        display_config: ChannelDisplayConfig | None = None,
        no_text_debounce: bool = True,
        workspace_dir: Optional[Path] = None,
        **_: Any,
    ):
        super().__init__(
            process,
            on_reply_sent=on_reply_sent,
            display_config=display_config,
            no_text_debounce=no_text_debounce,
            require_mention=False,
            access_control_dm=False,
            access_control_group=False,
        )
        self.enabled = bool(enabled)
        self.bot_prefix = bot_prefix or ""
        self._api_base = trim_base_url(xchatbot_api_base_url)
        self._token = as_str(xchatbot_token)
        self._inbound_token = as_str(inbound_token) or self._token
        self._workspace_dir = Path(workspace_dir) if workspace_dir else None
        self._started = False

    @property
    def inbound_token(self) -> str:
        return self._inbound_token

    @classmethod
    def from_env(
        cls,
        process: ProcessHandler,
        on_reply_sent: OnReplySent = None,
    ) -> "XbotChannel":
        return cls(
            process=process,
            enabled=os.getenv("XBOT_CHANNEL_ENABLED", "0") == "1",
            xchatbot_api_base_url=os.getenv("XBOT_XCHATBOT_API_BASE_URL", ""),
            xchatbot_token=os.getenv("XBOT_XCHATBOT_TOKEN", ""),
            inbound_token=os.getenv("XBOT_INBOUND_TOKEN", ""),
            bot_prefix=os.getenv("XBOT_BOT_PREFIX", ""),
            on_reply_sent=on_reply_sent,
        )

    @classmethod
    def from_config(
        cls,
        process: ProcessHandler,
        config: Any,
        on_reply_sent: OnReplySent = None,
        display_config: ChannelDisplayConfig | None = None,
        no_text_debounce: bool = True,
        workspace_dir: Optional[Path] = None,
    ) -> "XbotChannel":
        return cls(
            process=process,
            enabled=bool(cfg_get(config, "enabled", False)),
            xchatbot_api_base_url=as_str(cfg_get(config, "xchatbotApiBaseUrl")),
            xchatbot_token=as_str(cfg_get(config, "xchatbotToken")),
            inbound_token=as_str(cfg_get(config, "inboundToken")),
            bot_prefix=as_str(cfg_get(config, "bot_prefix") or cfg_get(config, "botName")),
            on_reply_sent=on_reply_sent,
            display_config=display_config or ChannelDisplayConfig.from_config(config),
            no_text_debounce=no_text_debounce,
            workspace_dir=workspace_dir,
        )

    def resolve_session_id(
        self,
        sender_id: str,
        channel_meta: Optional[Dict[str, Any]] = None,
    ) -> str:
        meta = channel_meta or {}
        return as_str(meta.get("session_id")) or f"{self.channel}:{sender_id}"

    def get_to_handle_from_request(self, request: Any) -> str:
        meta = getattr(request, "channel_meta", None) or {}
        return as_str(meta.get("to_handle")) or as_str(getattr(request, "user_id", ""))

    def build_agent_request_from_native(self, native_payload: Any) -> Any:
        payload = native_payload if isinstance(native_payload, dict) else {}
        meta = dict(payload.get("meta") or {})
        sender_id = as_str(payload.get("sender_id"))
        session_id = self.resolve_session_id(sender_id, meta)
        request = self.build_agent_request_from_user_content(
            channel_id=as_str(payload.get("channel_id")) or self.channel,
            sender_id=sender_id,
            session_id=session_id,
            content_parts=payload.get("content_parts") or [],
            channel_meta=meta,
        )
        setattr(request, "channel_meta", meta)
        return request

    async def start(self) -> None:
        global _LIVE
        if not self.enabled:
            logger.debug("xbot channel disabled")
            return
        if not self._api_base or not self._token:
            logger.warning("xbot: xchatbotApiBaseUrl / xchatbotToken missing, not started")
            return
        _LIVE = self
        self._started = True
        logger.info("xbot channel started, outbound=%s", self._api_base)

    async def stop(self) -> None:
        global _LIVE
        self._started = False
        if _LIVE is self:
            _LIVE = None
        logger.info("xbot channel stopped")

    async def health_check(self) -> Dict[str, Any]:
        ok = self.enabled and self._started and bool(self._api_base and self._token)
        return {
            "channel": self.channel,
            "status": "healthy" if ok else "unhealthy",
            "detail": "waiting for xchatbot push" if ok else "not configured",
            "xchatbotApiBaseUrl": self._api_base or None,
        }

    async def accept_inbound(self, parsed: Dict[str, Any]) -> Dict[str, Any]:
        if self._enqueue is None:
            raise RuntimeError("xbot queue is not ready")
        AudioContent, ContentType, ImageContent, TextContent, VideoContent = _content_types()
        parts: List[Any] = []
        text = as_str(parsed.get("content"))
        if text:
            parts.append(TextContent(type=ContentType.TEXT, text=text))
        for item in media_parts(parsed):
            kind = item["kind"]
            url = item["url"]
            if kind == "video":
                parts.append(VideoContent(type=ContentType.VIDEO, video_url=url))
            elif kind == "voice":
                parts.append(AudioContent(type=ContentType.AUDIO, data=url, format="silk"))
            else:
                parts.append(ImageContent(type=ContentType.IMAGE, image_url=url))
        if not parts:
            parts.append(TextContent(type=ContentType.TEXT, text=" "))

        sender_id = as_str(parsed.get("from"))
        meta = {
            "platform": parsed["platform"],
            "source": parsed["source"],
            "from": sender_id,
            "sender_name": parsed.get("senderName") or sender_id,
            "room_id": parsed.get("roomId") or "",
            "message_id": parsed.get("messageId") or "",
            "to_handle": parsed["toHandle"],
            "session_id": parsed["sessionId"],
            "is_group": parsed["kind"] == "group",
        }
        native = {
            "channel_id": self.channel,
            "sender_id": parsed["toHandle"],
            "content_parts": parts,
            "meta": meta,
        }
        self._enqueue(native)
        return {
            "dispatched": True,
            "sessionKey": parsed["sessionId"],
            "messageId": parsed["messageId"],
        }

    def _route_from(self, to_handle: str, meta: Optional[Dict[str, Any]]) -> Dict[str, str]:
        data = meta or {}
        platform = as_str(data.get("platform"))
        source = as_str(data.get("source"))
        sender_id = as_str(data.get("from"))
        room_id = as_str(data.get("room_id"))
        handle = as_str(to_handle) or as_str(data.get("to_handle"))
        if not platform and ":" in handle:
            platform, rest = handle.split(":", 1)
            if rest.startswith("group:"):
                source = "group"
                room_id = room_id or rest[6:]
            elif rest.startswith("user:"):
                sender_id = sender_id or rest[5:]
        if not source:
            source = "group" if room_id else "private"
        return {
            "platform": platform,
            "source": source,
            "from": sender_id or handle,
            "roomId": room_id,
            "messageId": as_str(data.get("message_id")),
        }

    async def _deliver(self, to_handle: str, replies: List[Dict[str, Any]], meta: Optional[Dict[str, Any]]) -> None:
        if not replies:
            return
        route = self._route_from(to_handle, meta)
        if not route["platform"]:
            raise RuntimeError("platform is required")
        body = build_outbound_body(
            platform=route["platform"],
            source=route["source"],
            sender_id=route["from"],
            room_id=route["roomId"],
            message_id=route["messageId"],
            replies=replies,
        )
        await post_outbound(
            api_base=self._api_base,
            token=self._token,
            body=body,
        )
        logger.info(
            "xbot outbound ok platform=%s source=%s",
            route["platform"],
            route["source"],
        )

    async def send(
        self,
        to_handle: str,
        text: str,
        meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not self.enabled or not self._started:
            logger.warning("xbot send skipped: enabled=%s started=%s", self.enabled, self._started)
            return
        replies = replies_from_text(text)
        try:
            await self._deliver(to_handle, replies, meta)
        except Exception:
            logger.exception("xbot outbound text failed")
