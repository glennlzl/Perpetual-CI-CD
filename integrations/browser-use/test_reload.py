"""reload_page against a disposable application in the owned Chromium."""

import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit

from pydantic import BaseModel

import runner

# A rename moves the client to a new address without a navigation, as a router's replace does.
PAGE = """<!doctype html><title>Workspace</title><h1 id="loaded">Loaded {count} at {path}</h1>
<button onclick="history.replaceState(null, '', '/workspace/renamed')">Rename</button>"""


class Application(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        path = urlsplit(self.path).path
        self.server.gets.append(path)
        body = PAGE.format(count=len(self.server.gets), path=path).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ReloadPage(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        runner.configure_private_runtime()
        self.app = ThreadingHTTPServer(("127.0.0.1", 0), Application)
        self.app.gets = []
        threading.Thread(target=self.app.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.app.server_port}"
        self.addCleanup(self.app.server_close)
        self.addCleanup(self.app.shutdown)

    async def test_reloads_the_current_address_not_the_one_first_opened(self):
        payload = {"mode": "run", "targetUrl": self.url + "/workspace/original", "allowedOrigins": [self.url]}
        async with runner.OwnedBrowser(payload, [].append, case_id="reload") as owned:
            page = await owned.active_page()
            await page.goto(self.url + "/workspace/original")
            await page.get_by_role("button", name="Rename").click()
            before = len(self.app.gets)
            self.assertTrue(await owned.reload())
            self.assertEqual(self.app.gets[before:], ["/workspace/renamed"])
            self.assertEqual(await page.text_content("#loaded"), f"Loaded {before + 1} at /workspace/renamed")
            # A blank tab has no approved address to reload.
            await page.goto("about:blank")
            self.assertFalse(await owned.reload())
            self.assertEqual(len(self.app.gets), before + 1)


class ReloadTool(unittest.IsolatedAsyncioTestCase):
    async def test_only_runs_offer_the_action_and_a_refusal_is_an_action_error(self):
        from browser_use import Tools
        report, _ = runner.output_schemas()
        self.assertNotIn("reload_page", runner.safe_tools(report).registry.registry.actions)
        outcomes = []

        async def reload():
            return outcomes[-1]

        tools = runner.safe_tools(report, reload=reload)
        self.assertLessEqual(set(tools.registry.registry.actions), runner.SAFE_ACTIONS)

        class Action(BaseModel):
            reload_page: dict | None = None

        async def execute(self_tools, action, _browser, *_, **__):
            return await self_tools.registry.execute_action("reload_page", action.model_dump(exclude_none=True)["reload_page"])

        for reloaded, status in [(True, "passed"), (False, "failed")]:
            with self.subTest(reloaded=reloaded):
                outcomes.append(reloaded)
                with patch.object(Tools, "act", execute):
                    result = await tools.act(Action(reload_page={}), SimpleNamespace())
                self.assertEqual(runner.action_progress("reload_page", result)["status"], status)


if __name__ == "__main__":
    unittest.main()
