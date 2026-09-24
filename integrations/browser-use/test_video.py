"""Journey recordings from the owned Chromium, against a disposable application."""

import asyncio
import re
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from playwright.async_api import BrowserType

import runner

PAGE = b"""<!doctype html><title>Recorded</title><h1 id="count">0</h1>
<button onclick="window.open('/popup', '_blank')">Open popup</button>
<script>let n = 0; setInterval(() => { document.getElementById('count').textContent = ++n; }, 100);</script>"""
VIDEO_NAME = re.compile(r"^page@[0-9a-f]{32}\.webm$")


class Application(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)


class JourneyRecording(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        runner.configure_private_runtime()
        self.app = ThreadingHTTPServer(("127.0.0.1", 0), Application)
        threading.Thread(target=self.app.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.app.server_port}"
        self.addCleanup(self.app.server_close)
        self.addCleanup(self.app.shutdown)
        folder = tempfile.TemporaryDirectory(prefix="perpetual-video-")
        self.addCleanup(folder.cleanup)
        self.videos = Path(folder.name)

    def payload(self, mode="run"):
        return {"mode": mode, "targetUrl": self.url + "/", "allowedOrigins": [self.url], "videoDir": str(self.videos)}

    async def test_every_tab_is_recorded_and_reported_after_close(self):
        events = []
        async with runner.OwnedBrowser(self.payload(), events.append, case_id="video") as owned:
            first = await owned.active_page()
            async with owned.context.expect_page() as opened:
                await first.get_by_role("button", name="Open popup").click()
            await (await opened.value).wait_for_load_state()
            # A tab the agent opens through browser-use's own CDP connection records too.
            tab = await owned.browser.new_page(self.url + "/agent-tab")
            for _ in range(100):
                if tab._target_id in owned.targets:
                    break
                await asyncio.sleep(0.05)
            self.assertIn(tab._target_id, owned.targets)
            await asyncio.sleep(1)
            self.assertEqual(len(owned.videos), 3)
            # Unfinished until their pages close, so nothing is reported yet.
            self.assertTrue(all((path.stat().st_size if path.exists() else 0) == 0 for path in owned.videos))
            self.assertFalse([event for event in events if event["type"] == "video"])
            tracked = [path.name for path in owned.videos]
        videos = [event for event in events if event["type"] == "video"]
        self.assertEqual(videos, [{"type": "video", "caseId": "video", "files": tracked}])
        for name in tracked:
            self.assertRegex(name, VIDEO_NAME)
            data = (self.videos / name).read_bytes()
            self.assertGreater(len(data), 0)
            self.assertTrue(data.startswith(b"\x1a\x45\xdf\xa3"), name)
            self.assertIn(b"V_VP8", data)
        # Live frames keep streaming while every tab records.
        self.assertTrue(any(event["type"] == "frame" for event in events))
        self.assertFalse([event for event in events if event["type"] == "error"])

    async def test_recording_failure_runs_the_journey_unrecorded(self):
        original, events = BrowserType.launch_persistent_context, []

        async def launch(self, *args, **kwargs):
            if "record_video_dir" in kwargs:
                raise RuntimeError("Video rendering requires ffmpeg binary")
            return await original(self, *args, **kwargs)

        with patch.object(BrowserType, "launch_persistent_context", launch):
            async with runner.OwnedBrowser(self.payload(), events.append, case_id="video") as owned:
                self.assertEqual(await (await owned.active_page()).title(), "Recorded")
                self.assertIsNone(owned.video_dir)
        self.assertFalse([event for event in events if event["type"] in {"video", "error"}])
        self.assertEqual(list(self.videos.iterdir()), [])

    async def test_discovery_is_not_recorded(self):
        events = []
        async with runner.OwnedBrowser(self.payload("discover"), events.append) as owned:
            self.assertEqual(await (await owned.active_page()).title(), "Recorded")
            self.assertEqual(owned.videos, [])
        self.assertFalse([event for event in events if event["type"] in {"video", "error"}])
        self.assertEqual(list(self.videos.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
