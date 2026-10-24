# -*- coding: utf-8 -*-
"""Smoke checks that do not import Hermes."""

from __future__ import annotations

import unittest

from inbound import InboundError, parse_inbound, route_from_chat_id
from outbound import build_outbound_body, http_error_detail, outbound_headers


class InboundTests(unittest.TestCase):
    def test_private(self) -> None:
        parsed = parse_inbound(
            {
                "messageId": "m1",
                "platform": "golem",
                "from": "wxid_a",
                "senderName": "张三",
                "content": "你好",
                "timestamp": 1_700_000_000,
            }
        )
        self.assertEqual(parsed["chatId"], "golem:user:wxid_a")
        self.assertEqual(parsed["timestamp"], 1_700_000_000_000)

    def test_group_requires_room(self) -> None:
        with self.assertRaises(InboundError):
            parse_inbound({"messageId": "m1", "platform": "golem", "source": "group", "from": "wxid_a"})

    def test_route_fallback(self) -> None:
        route = route_from_chat_id("golem:group:123@chatroom")
        assert route is not None
        self.assertEqual(route["roomId"], "123@chatroom")
        self.assertEqual(route["source"], "group")


class OutboundTests(unittest.TestCase):
    def test_body(self) -> None:
        body = build_outbound_body(
            platform="golem",
            source="private",
            sender_id="wxid_a",
            replies=[{"type": "text", "content": "好"}],
        )
        self.assertEqual(body["from"], "wxid_a")
        self.assertIsNone(body["roomId"])
        self.assertIn("Mozilla", outbound_headers("t")["User-Agent"])

    def test_cloudflare_1010(self) -> None:
        detail = http_error_detail(403, "error code: 1010")
        self.assertIn("1010", detail)


if __name__ == "__main__":
    unittest.main()
