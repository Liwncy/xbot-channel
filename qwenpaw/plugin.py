# -*- coding: utf-8 -*-
"""QwenPaw xbot channel plugin entry."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

from qwenpaw.plugins.api import PluginApi

logger = logging.getLogger(__name__)

_ROOT = str(Path(__file__).resolve().parent)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


class XbotChannelPlugin:
    def register(self, api: PluginApi) -> None:
        from channel import XbotChannel
        from routes import router

        api.register_channel(
            channel_class=XbotChannel,
            label="Xbot",
            description="只连 xchatbot，不要开自带微信",
            config_fields=[
                {
                    "name": "xchatbotApiBaseUrl",
                    "label": "xchatbot 地址",
                    "type": "text",
                    "required": True,
                    "placeholder": "https://xbot.example.com",
                    "help": "Worker 公网根地址，不要填 Golem",
                },
                {
                    "name": "xchatbotToken",
                    "label": "xchatbot Token",
                    "type": "password",
                    "required": True,
                    "help": "与 Worker AGENT_BRIDGE_TOKEN 相同，出站 Bearer",
                },
                {
                    "name": "inboundToken",
                    "label": "入站 Token",
                    "type": "password",
                    "required": False,
                    "help": "Worker 打 /api/channels/xbot/inbound 的 Bearer。空则同 xchatbotToken",
                },
            ],
        )
        api.register_http_router(router, prefix="/channels/xbot", tags=["xbot"])
        logger.info("xbot channel plugin registered")


plugin = XbotChannelPlugin()
