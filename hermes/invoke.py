# -*- coding: utf-8 -*-
"""Turn a model-written <invoke> block into a real tool call. No Hermes imports."""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Tuple

_INVOKE = re.compile(r'<invoke\s+name="([^"]+)">\s*(.*?)\s*</invoke>', re.DOTALL)
_PARAM = re.compile(r'<parameter\s+name="([^"]+)">\s*(.*?)\s*</parameter>', re.DOTALL)
_INT = re.compile(r"-?\d+")


def _value(raw: str) -> Any:
    text = raw.strip()
    if text in {"true", "false"}:
        return text == "true"
    if _INT.fullmatch(text):
        return int(text)
    if text[:1] in "[{":
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text
    return text


def parse_invokes(content: str) -> List[Tuple[str, Dict[str, Any]]] | None:
    """Calls when the whole message is one or more <invoke> blocks, else None."""
    text = (content or "").strip()
    if not text:
        return None
    matches = list(_INVOKE.finditer(text))
    if not matches:
        return None
    if _INVOKE.sub("", text).strip():
        return None
    calls: List[Tuple[str, Dict[str, Any]]] = []
    for match in matches:
        name = match.group(1).strip()
        if not name:
            return None
        args = {param.group(1): _value(param.group(2)) for param in _PARAM.finditer(match.group(2))}
        calls.append((name, args))
    return calls or None
