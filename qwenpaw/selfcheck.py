# -*- coding: utf-8 -*-
"""No-QwenPaw smoke checks for inbound parse and outbound mapping."""

from __future__ import annotations

import unittest

from inbound import InboundError, parse_inbound
from outbound import (
    http_error_detail,
    map_media_url,
    outbound_headers,
    replies_from_text,
    split_send_text,
)


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
        self.assertEqual(parsed["toHandle"], "golem:user:wxid_a")
        self.assertEqual(parsed["sessionId"], "xbot:golem:user:wxid_a")
        self.assertEqual(parsed["source"], "private")
        self.assertEqual(parsed["timestamp"], 1_700_000_000_000)

    def test_group_requires_room(self) -> None:
        with self.assertRaises(InboundError):
            parse_inbound(
                {
                    "messageId": "m1",
                    "platform": "golem",
                    "source": "group",
                    "from": "wxid_a",
                    "content": "hi",
                }
            )

    def test_group_ok(self) -> None:
        parsed = parse_inbound(
            {
                "messageId": "m2",
                "platform": "golem",
                "source": "group",
                "from": "wxid_a",
                "roomId": "123@chatroom",
                "content": "hi",
            }
        )
        self.assertEqual(parsed["toHandle"], "golem:group:123@chatroom")


class OutboundTests(unittest.TestCase):
    def test_strip_image_marker(self) -> None:
        spoken, media = split_send_text("看这张\n[Image: https://cdn.example/a.jpg]")
        self.assertEqual(spoken, "看这张")
        self.assertEqual(media[0]["type"], "image")

    def test_voice_silk(self) -> None:
        mapped = map_media_url("https://cdn.example/a.silk", hinted="voice")
        assert mapped is not None
        self.assertEqual(mapped["type"], "voice")
        self.assertEqual(mapped["format"], "4")

    def test_local_path_dropped(self) -> None:
        self.assertIsNone(map_media_url("/tmp/a.jpg"))

    def test_replies_order(self) -> None:
        replies = replies_from_text("hello\n[Image: https://cdn.example/a.png]")
        self.assertEqual(replies[0]["type"], "image")
        self.assertEqual(replies[1], {"type": "text", "content": "hello"})

    def test_keeps_music_protocol_newline(self) -> None:
        text = (
            "找到了！搜出来一首《凤凰再现》，歌手是春娇。\n"
            "\n"
            "music:凤凰再现|春娇|https://y.qq.com/n/yqq/song/a.html"
            "|https://isure6.stream.qqmusic.qq.com/C400.m4a?guid=1"
            "|https://y.gtimg.cn/cover.jpg"
        )
        replies = replies_from_text(text)
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]["type"], "text")
        content = replies[0]["content"]
        self.assertIn("\nmusic:", content)
        self.assertTrue(any(line.startswith("music:") for line in content.splitlines()))

    def test_browser_user_agent(self) -> None:
        headers = outbound_headers("secret")
        self.assertIn("Chrome/", headers["User-Agent"])
        self.assertNotIn("Python-urllib", headers["User-Agent"])
        self.assertTrue(headers["Authorization"].startswith("Bearer "))

    def test_cloudflare_1010_detail(self) -> None:
        detail = http_error_detail(403, "error code: 1010")
        self.assertIn("1010", detail)
        self.assertIn("not a token mismatch", detail)


if __name__ == "__main__":
    unittest.main()
