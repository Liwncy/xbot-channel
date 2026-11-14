# -*- coding: utf-8 -*-
"""Smoke checks that do not import Hermes."""

from __future__ import annotations

import unittest

from inbound import InboundError, media_parts, parse_inbound, route_from_chat_id
from invoke import parse_invokes
from media import UPLOAD_FAILED_LINE, check_image, is_remote, publish_local_images, to_file_path
from outbound import build_outbound_body, http_error_detail, is_background_notice, outbound_headers


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

    def test_addressed_is_only_an_explicit_boolean(self) -> None:
        base = {"messageId": "m1", "platform": "golem", "source": "group", "roomId": "r@chatroom", "from": "wxid_a"}
        self.assertIsNone(parse_inbound(base)["addressed"])
        self.assertIs(parse_inbound({**base, "addressed": False})["addressed"], False)
        self.assertIs(parse_inbound({**base, "addressed": True})["addressed"], True)
        self.assertIsNone(parse_inbound({**base, "addressed": "false"})["addressed"])

    def test_media_parts(self) -> None:
        parsed = parse_inbound(
            {
                "messageId": "m1",
                "platform": "golem",
                "from": "wxid_a",
                "type": "video",
                "mediaUrl": "https://x/cover.jpg",
                "mediaKind": "emoji",
                "videoUrl": "https://x/v.mp4",
            }
        )
        parts = media_parts(parsed)
        self.assertEqual([p["cacheKind"] for p in parts], ["image", "video"])
        self.assertEqual(media_parts(parse_inbound({"messageId": "m2", "platform": "golem", "from": "a"})), [])

    def test_route_fallback(self) -> None:
        route = route_from_chat_id("golem:group:123@chatroom")
        assert route is not None
        self.assertEqual(route["roomId"], "123@chatroom")
        self.assertEqual(route["source"], "group")


class InvokeTests(unittest.TestCase):
    def test_lifts_a_bare_invoke(self) -> None:
        calls = parse_invokes(
            '<invoke name="mcp__cf_mcp_tools__web_search">\n'
            '<parameter name="query">潍坊</parameter>\n'
            '<parameter name="max_results">8</parameter>\n'
            "</invoke>"
        )
        assert calls is not None
        self.assertEqual(calls[0][0], "mcp__cf_mcp_tools__web_search")
        self.assertEqual(calls[0][1], {"query": "潍坊", "max_results": 8})

    def test_ignores_prose(self) -> None:
        self.assertIsNone(parse_invokes('查好了\n<invoke name="x"></invoke>'))


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

    def test_background_notice_needs_both_marker_and_prefix(self) -> None:
        notice = "💾 Self-improvement review: User profile updated"
        self.assertTrue(is_background_notice(notice, {"_interim_send": True}))
        self.assertTrue(is_background_notice("💾 自我改进回顾：记忆已更新", {"_interim_send": True}))
        self.assertFalse(is_background_notice(notice, None))
        self.assertFalse(is_background_notice(notice, {}))
        self.assertFalse(is_background_notice("好的 💾", {"_interim_send": True}))
        self.assertFalse(is_background_notice("查好了", {"_interim_send": True}))

    def test_cloudflare_1010(self) -> None:
        detail = http_error_detail(403, "error code: 1010")
        self.assertIn("1010", detail)


PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c63f8cfc0f01f0005850180"
    "84a98c210000000049454e44ae426082"
)


class MediaTests(unittest.TestCase):
    def setUp(self) -> None:
        import os
        import tempfile

        self.dir = tempfile.mkdtemp(prefix="xbot-media-")
        self.png = os.path.join(self.dir, "screen.png")
        self.txt = os.path.join(self.dir, "note.txt")
        with open(self.png, "wb") as handle:
            handle.write(PNG)
        with open(self.txt, "w", encoding="utf-8") as handle:
            handle.write("x")

    def _run(self, text: str, allowed: set) -> tuple:
        import asyncio

        calls: list = []

        def upload(data: bytes, name: str, content_type: str) -> str:
            calls.append((name, content_type))
            return f"https://file.example/{len(calls)}.png"

        def validate(path: str):
            return path if path in allowed else None

        out = asyncio.run(publish_local_images(text, validate=validate, upload=upload))
        return out, calls

    def test_helpers(self) -> None:
        self.assertTrue(is_remote("https://a/b.png"))
        self.assertFalse(is_remote("C:\\a\\b.png"))
        self.assertEqual(to_file_path("file:///C:/a/b.png"), "C:/a/b.png")
        self.assertEqual(check_image(self.png), "image/png")
        self.assertIsNone(check_image(self.txt))
        self.assertIsNone(check_image(self.png + ".missing"))

    def test_local_image_becomes_a_link(self) -> None:
        out, calls = self._run(f"截好了\nimage:{self.png}", {self.png})
        self.assertEqual(out.split("\n"), ["截好了", "image:https://file.example/1.png"])
        self.assertEqual(calls[0][1], "image/png")

    def test_refused_paths_never_leak(self) -> None:
        text = "\n".join([f"image:{self.png}", f"image:{self.txt}", "image:https://x.com/a.jpg"])
        out, calls = self._run(text, {self.txt})  # png 没过 Hermes 校验；txt 过了但不是图片
        lines = out.split("\n")
        self.assertEqual(lines[0], UPLOAD_FAILED_LINE)
        self.assertEqual(lines[1], UPLOAD_FAILED_LINE)
        self.assertEqual(lines[2], "image:https://x.com/a.jpg")
        self.assertEqual(calls, [])
        self.assertNotIn(self.dir, out)

    def test_upload_failure_is_a_chat_line(self) -> None:
        import asyncio

        def boom(data: bytes, name: str, content_type: str) -> str:
            raise RuntimeError("boom")

        out = asyncio.run(
            publish_local_images(f"image:{self.png}", validate=lambda p: p, upload=boom)
        )
        self.assertEqual(out, UPLOAD_FAILED_LINE)


if __name__ == "__main__":
    unittest.main()
