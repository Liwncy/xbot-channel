# -*- coding: utf-8 -*-
"""Hermes gateway platform: xchatbot inbound → agent → /openclaw/outbound."""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import uuid
from collections import deque
from datetime import datetime
from typing import Any, Dict, Optional

from gateway.config import Platform
from gateway.platforms._shared import extra_or_secret, seed_extra_from_env
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent, MessageType
from gateway.session import SessionSource

from .inbound import InboundError, media_parts, parse_inbound, route_from_chat_id
from .invoke import parse_invokes
from .outbound import BROWSER_UA, build_outbound_body, post_outbound, trim_base_url

logger = logging.getLogger(__name__)

_MEDIA_TYPES = {
    "image": MessageType.PHOTO,
    "emoji": MessageType.STICKER,
    "video": MessageType.VIDEO,
    "voice": MessageType.VOICE,
}


_MAX_MEDIA_BYTES = 128 * 1024 * 1024


async def _download(url: str) -> tuple[bytes, str]:
    import aiohttp

    timeout = aiohttp.ClientTimeout(total=60)
    async with aiohttp.ClientSession(timeout=timeout, headers={"User-Agent": BROWSER_UA}) as session:
        async with session.get(url) as resp:
            resp.raise_for_status()
            # read(n) returns the first buffered chunk, not the whole body.
            chunks = []
            total = 0
            async for chunk in resp.content.iter_chunked(65536):
                total += len(chunk)
                if total > _MAX_MEDIA_BYTES:
                    raise ValueError("media too large")
                chunks.append(chunk)
            return b"".join(chunks), (resp.headers.get("Content-Type") or "").split(";")[0].strip()


def _pick(extra: dict, *keys: str, env: str = "", default: str = "") -> str:
    for key in keys:
        value = extra_or_secret(extra, key, env if key == keys[0] else "", default="")
        if str(value).strip():
            return str(value).strip()
    return default


class XbotAdapter(BasePlatformAdapter):
    def __init__(self, config, **kwargs):
        super().__init__(config=config, platform=Platform("xbot"))
        extra = getattr(config, "extra", {}) or {}
        self._api_base = trim_base_url(
            _pick(extra, "xchatbot_api_base_url", "xchatbotApiBaseUrl", env="XBOT_XCHATBOT_API_BASE_URL")
        )
        self._token = _pick(extra, "token", "xchatbotToken", env="XBOT_XCHATBOT_TOKEN")
        self._inbound_token = _pick(extra, "inbound_token", "inboundToken", env="XBOT_INBOUND_TOKEN") or self._token
        self._host = _pick(extra, "host", env="XBOT_HOST", default="127.0.0.1")
        try:
            self._port = int(_pick(extra, "port", env="XBOT_PORT", default="8642"))
        except ValueError:
            self._port = 8642
        self._routes: Dict[str, Dict[str, str]] = {}
        self._seen: deque[str] = deque(maxlen=200)
        self._seen_set: set[str] = set()
        self._tasks: set[asyncio.Task] = set()
        self._runner = None

    @property
    def name(self) -> str:
        return "Xbot"

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not self._api_base or not self._token or not self._inbound_token:
            logger.error("xbot: xchatbot url and token are required")
            return False
        from aiohttp import web
        from gateway.platforms.tcp_site import start_tcp_site

        app = web.Application(client_max_size=1_048_576)
        app.router.add_get("/health", self._health)
        app.router.add_post("/api/channels/xbot/inbound", self._handle_inbound)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        try:
            await start_tcp_site(self._runner, self._host, self._port, log_tag="xbot")
        except OSError as exc:
            await self._runner.cleanup()
            self._runner = None
            logger.error("xbot: could not bind %s:%s: %s", self._host, self._port, exc)
            return False
        self._mark_connected(listener_base=f"http://{self._host}:{self._port}")
        self._wire_plugin_handlers(None)
        logger.info("xbot: listening on %s:%s", self._host, self._port)
        return True

    async def disconnect(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        self._mark_disconnected()

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> SendResult:
        text = (content or "").strip()
        if not text:
            return SendResult(success=True)
        return await self._deliver(chat_id, [{"type": "text", "content": text}])

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> SendResult:
        return await self._deliver_url(chat_id, "image", image_url, caption)

    async def send_animation(
        self,
        chat_id: str,
        animation_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> SendResult:
        return await self.send_image(chat_id, animation_url, caption, reply_to, metadata)

    async def send_voice(
        self,
        chat_id: str,
        audio_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        **kwargs,
    ) -> SendResult:
        return await self._deliver_url(chat_id, "voice", audio_path, caption)

    async def send_video(
        self,
        chat_id: str,
        video_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        **kwargs,
    ) -> SendResult:
        return await self._deliver_url(chat_id, "video", video_path, caption)

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        route = self._routes.get(chat_id) or route_from_chat_id(chat_id) or {}
        return {"name": route.get("from") or chat_id, "type": "group" if route.get("source") == "group" else "dm"}

    async def _health(self, _request):
        from aiohttp import web

        return web.json_response({"ok": True, "channel": "xbot"})

    async def _handle_inbound(self, request):
        from aiohttp import web

        if not self._authorized(request.headers.get("Authorization") or ""):
            return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid json"}, status=400)
        try:
            parsed = parse_inbound(payload)
        except InboundError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)
        if self._duplicate(parsed["messageId"]):
            return web.json_response({"ok": True, "accepted": False, "duplicate": True})
        self._routes[parsed["chatId"]] = {
            "platform": parsed["platform"],
            "source": parsed["source"],
            "from": parsed["from"],
            "roomId": parsed["roomId"],
            "messageId": parsed["messageId"],
        }
        task = asyncio.create_task(self._dispatch(parsed))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return web.json_response({"ok": True, "accepted": True})

    def _authorized(self, header: str) -> bool:
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        expected = self._inbound_token
        if not token or not expected:
            return False
        return hmac.compare_digest(token, expected)

    def _duplicate(self, message_id: str) -> bool:
        if message_id in self._seen_set:
            return True
        if len(self._seen) == self._seen.maxlen:
            self._seen_set.discard(self._seen[0])
        self._seen.append(message_id)
        self._seen_set.add(message_id)
        return False

    async def _cache_media(self, parsed: Dict[str, Any]) -> list:
        """Hermes reads media_urls as local paths with MIME media_types, so download first."""
        from gateway.platforms.base import cache_media_bytes_async

        cached = []
        for part in media_parts(parsed):
            try:
                data, mime = await _download(part["url"])
                item = await cache_media_bytes_async(data, mime_type=mime, default_kind=part["cacheKind"])
            except Exception as exc:
                logger.warning("xbot: media download failed for %s: %s", parsed["messageId"], exc)
                continue
            if item is not None:
                cached.append((part["kind"], item))
        return cached

    def _event(self, parsed: Dict[str, Any], cached: list) -> MessageEvent:
        return MessageEvent(
            text=parsed["content"],
            message_type=_MEDIA_TYPES.get(cached[0][0], MessageType.TEXT) if cached else MessageType.TEXT,
            user_id=parsed["from"],
            user_name=parsed["senderName"],
            source=SessionSource(
                platform=self.platform,
                chat_id=parsed["chatId"],
                chat_type="group" if parsed["kind"] == "group" else "dm",
                user_id=parsed["from"],
                user_name=parsed["senderName"] or None,
                message_id=parsed["messageId"],
            ),
            message_id=parsed["messageId"],
            media_urls=[item.path for _, item in cached],
            media_types=[item.media_type for _, item in cached],
            timestamp=datetime.fromtimestamp(parsed["timestamp"] / 1000),
        )

    async def _dispatch(self, parsed: Dict[str, Any]) -> None:
        try:
            await self.handle_message(self._event(parsed, await self._cache_media(parsed)))
        except Exception:
            logger.exception("xbot: inbound dispatch failed for %s", parsed["messageId"])

    async def _deliver_url(self, chat_id: str, kind: str, url: str, caption: Optional[str]) -> SendResult:
        href = (url or "").strip()
        if not href.lower().startswith(("http://", "https://")):
            return SendResult(success=False, error=f"{kind} needs an http url")
        replies = [{"type": kind, "url": href}]
        if caption and caption.strip():
            replies.append({"type": "text", "content": caption.strip()})
        return await self._deliver(chat_id, replies)

    async def _deliver(self, chat_id: str, replies: list) -> SendResult:
        route = self._routes.get(chat_id) or route_from_chat_id(chat_id)
        if not route:
            return SendResult(success=False, error="unknown chat")
        body = build_outbound_body(
            platform=route["platform"],
            source=route["source"],
            sender_id=route["from"],
            room_id=route.get("roomId") or "",
            message_id=route.get("messageId") or "",
            replies=replies,
        )
        try:
            await post_outbound(api_base=self._api_base, token=self._token, body=body)
        except Exception as exc:
            logger.warning("xbot: outbound failed: %s", exc)
            return SendResult(success=False, error=str(exc), retryable=True)
        return SendResult(success=True, message_id=route.get("messageId") or None)


def check_requirements() -> bool:
    return True


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    base = _pick(extra, "xchatbot_api_base_url", "xchatbotApiBaseUrl", env="XBOT_XCHATBOT_API_BASE_URL")
    token = _pick(extra, "token", "xchatbotToken", env="XBOT_XCHATBOT_TOKEN")
    return bool(base and token)


def _env_enablement():
    seeded = seed_extra_from_env(
        (
            ("XBOT_XCHATBOT_API_BASE_URL", "xchatbot_api_base_url", None),
            ("XBOT_XCHATBOT_TOKEN", "token", None),
            ("XBOT_INBOUND_TOKEN", "inbound_token", None),
            ("XBOT_HOST", "host", None),
            ("XBOT_PORT", "port", None),
        )
    )
    return seeded or None


def _lift_invoke_xml(**kwargs):
    """dots3 writes <invoke> as the reply. Promote it to a tool call so the loop runs it."""
    message = kwargs.get("assistant_message")
    if message is None or getattr(message, "tool_calls", None):
        return None
    calls = parse_invokes(getattr(message, "content", None) or "")
    if not calls:
        return None
    from agent.transports.types import ToolCall

    message.tool_calls = [
        ToolCall(id=f"call_{uuid.uuid4().hex[:24]}", name=name, arguments=json.dumps(args, ensure_ascii=False))
        for name, args in calls
    ]
    message.content = ""
    message.finish_reason = "tool_calls"
    logger.info("xbot: lifted %d invoke block(s) into tool calls", len(calls))
    return None


def register(ctx) -> None:
    ctx.register_hook("post_api_request", _lift_invoke_xml)
    ctx.register_platform(
        name="xbot",
        label="Xbot",
        adapter_factory=XbotAdapter,
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=["XBOT_XCHATBOT_API_BASE_URL", "XBOT_XCHATBOT_TOKEN"],
        install_hint="Uses Hermes's aiohttp. No extra packages.",
        env_enablement_fn=_env_enablement,
        trusted_inbound=True,
        max_message_length=0,
        emoji="💬",
        platform_hint=(
            "You are replying through xchatbot. Plain text is sent back to the original chat. "
            "Image, video, and voice replies must be http(s) URLs."
        ),
    )
