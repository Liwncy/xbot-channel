# -*- coding: utf-8 -*-
"""Xbot channel keys and config helpers."""

from __future__ import annotations

from typing import Any

CHANNEL_ID = "xbot"


def as_str(value: Any, fallback: str = "") -> str:
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return fallback
    return str(value).strip() or fallback


def cfg_get(config: Any, name: str, default: Any = "") -> Any:
    if config is None:
        return default
    if isinstance(config, dict):
        value = config.get(name, default)
    else:
        value = getattr(config, name, default)
    return default if value is None else value


def trim_base_url(url: str) -> str:
    return as_str(url).rstrip("/")
