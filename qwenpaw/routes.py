# -*- coding: utf-8 -*-
"""FastAPI routes mounted at /api/channels/xbot."""

from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from inbound import InboundError, parse_inbound

logger = logging.getLogger(__name__)

router = APIRouter()


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return (request.headers.get("x-qwenpaw-runtime-token") or "").strip()


def _authorized(request: Request, expected: str) -> bool:
    token = _bearer(request)
    if expected:
        return bool(token) and hmac.compare_digest(token, expected)
    return bool(getattr(request.state, "user", None))


@router.post("/connect")
async def connect() -> JSONResponse:
    return JSONResponse({"ok": True, "channel": "xbot"})


@router.post("/inbound")
async def inbound(request: Request) -> JSONResponse:
    from channel import get_live_channel

    channel = get_live_channel()
    if channel is None or not channel.enabled:
        return JSONResponse({"ok": False, "error": "xbot channel is not started"}, status_code=503)
    if not _authorized(request, channel.inbound_token):
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "invalid json"}, status_code=400)
    try:
        parsed = parse_inbound(payload)
        result = await channel.accept_inbound(parsed)
    except InboundError as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
    except Exception as exc:
        logger.exception("xbot inbound failed")
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)
    return JSONResponse({"ok": True, "accepted": True, **result})
