"""Real owned-browser contracts on disposable loopback fixtures; no model calls."""

import asyncio
import importlib.util
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("runner", Path(__file__).with_name("runner.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner.configure_private_runtime()

REQUESTS = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        REQUESTS.append((self.server.server_port, self.path))
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{self.server.other_port}/outside")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(CREDITS if self.path == "/credits" else CHECKOUT if self.path == "/checkout" else b'<!doctype html><html><body><h1>Workspace</h1><p hidden>Secret hidden text</p><button onclick="document.querySelector(\'h1\').textContent=\'Saved workspace\'">Save</button></body></html>')


# The navigation "Credits" link sits near "Plan 2"; the balance card is closer to its label.
# "7 tokens" puts its number before the label, so a sibling's "Seats 3" must not be read as tokens.
CREDITS = b'''<!doctype html><html><body><nav><a href="/credits">Billing</a> <a href="/credits">Credits</a> <span>Plan 2</span></nav>
<section><div><span>Credits</span> <strong id="credits">1,240</strong></div><p>Balance: $12.00</p><p hidden>Usage 999</p><p>Usage <span style="display:none">999</span> 5</p>
<div><p>7 tokens</p><p>Seats 3</p></div>
<button onclick="document.getElementById('credits').textContent='1,236'">Run</button></section></body></html>'''
# A merchant-named product is not Stripe's test-mode banner.
CHECKOUT = b'<!doctype html><html><body><h2>Sandbox Pro plan</h2><p>Test mode checkout for teams</p></body></html>'


class ProtocolModelHandler(BaseHTTPRequestHandler):
    """Deterministic OpenAI-compatible fixture, not an intelligence evaluation."""

    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        latest = request["messages"][-1]["content"]
        text = latest if isinstance(latest, str) else "\n".join(part.get("text", "") for part in latest)
        observation = text.split("<browser_state>")[-1]
        self.server.observations.append(observation)
        if self.server.discovery:
            data = {"cases": [{"name": "Open workspace", "goal": "Inspect the workspace", "steps": [{"id": "enter", "title": "Enter the workspace"}, {"id": "result", "title": "Save and reopen the workspace"}], "preconditions": [], "expectedOutcomes": ["Workspace is visible"], "assertions": [{"type": "text-visible", "value": "Workspace"}], "evidence": []}], "summary": "Fixture workspace observed"}
            action = {"done": {"data": data}}
        elif "Saved workspace" in observation:
            action = {"done": {"data": {"reached": True, "evidence": "Saved workspace is visible", "outcomes": [{"outcomeIndex": 0, "status": "satisfied", "evidence": "Saved workspace visible after clicking Save"}]}}}
        else:
            match = re.search(r'\[(\d+)\][^\n]*<button', observation)
            if not match:
                match = re.search(r'(\d+)\[:\]<button', observation)
            if not match:
                self.server.missing_button = observation[:5000]
                action = {"done": {"data": {"reached": False, "evidence": "No Save button was observed"}}}
            else:
                action = {"click": {"index": int(match.group(1))}}
        content = {"evaluation_previous_goal": "Read fixture page", "memory": "Use observed page state", "next_goal": "Complete fixture goal", "action": [action]}
        response = {"id": "fixture-completion", "object": "chat.completion", "created": 1, "model": "fixture", "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": json.dumps(content)}}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        body = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class BrowserContracts(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.outside = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.other_port = cls.outside.server_port
        for server in [cls.server, cls.outside]:
            threading.Thread(target=server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for server in [cls.server, cls.outside]:
            server.shutdown()
            server.server_close()

    async def test_real_browser_stream_scope_and_independent_oracles(self):
        url = f"http://127.0.0.1:{self.server.server_port}"
        payload = {"mode": "run", "targetUrl": url, "allowedOrigins": [url]}
        events = []
        async with runner.OwnedBrowser(payload, events.append, case_id="c1") as owned:
            profile = owned.profile.name
            schema, discovery_schema = runner.output_schemas()
            self.assertIn("outcomes", schema.model_json_schema()["properties"])
            self.assertIn("cases", discovery_schema.model_json_schema()["properties"])
            with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-not-a-real-key", "PERPETUAL_MODEL": "fixture", "PERPETUAL_MODEL_BASE_URL": url}):
                agent, _ = runner.create_agent({**payload, "timeoutSeconds": 30}, owned, "Inspect the fixture", schema, "fixture", [])
            self.assertLessEqual(set(agent.tools.registry.registry.actions), runner.SAFE_ACTIONS)
            page = await owned.active_page()
            await page.get_by_role("button", name="Save").click()
            agent_page = await owned.browser.get_current_page()
            self.assertEqual(await agent_page.get_url(), url + "/")
            checks = await owned.check_assertions({"assertions": [
                {"type": "text-visible", "value": "Saved workspace"},
                {"type": "text-visible", "value": "Secret hidden text"},
                {"type": "text-absent", "value": "Secret hidden text"},
                {"type": "url-contains", "value": url},
            ]})
            self.assertEqual([entry["passed"] for entry in checks], [True, False, True, True])
            await asyncio.sleep(0.5)
            frames = [event for event in events if event["type"] == "frame"]
            self.assertTrue(any(len(event["data"]) > 1000 for event in frames))
            # The controller rejects a frame tagged with another journey.
            self.assertTrue(frames and all(event["caseId"] == "c1" for event in frames))
            await page.evaluate("url => window.open(url)", f"http://127.0.0.1:{self.outside.server_port}/popup")
            await asyncio.sleep(0.3)
            self.assertFalse(any(port == self.outside.server_port for port, _ in REQUESTS))
            try:
                await page.goto(url + "/redirect")
            except Exception:
                pass
            self.assertFalse(any(port == self.outside.server_port for port, _ in REQUESTS))
            self.assertGreaterEqual(owned.blocked_navigations, 1)
        self.assertFalse(Path(profile).exists())

    async def test_twin_urls_reach_loopback_apps_in_the_owned_browser(self):
        # The host has no host.docker.internal entry; only the owned Chromium's resolver rule reaches the app.
        url = f"http://{runner.TWIN_HOST}:{self.server.server_port}"
        payload = {"mode": "run", "targetUrl": url + "/credits", "allowedOrigins": [url]}
        async with runner.OwnedBrowser(payload, [].append, case_id="twin") as owned:
            page = await owned.active_page()
            self.assertEqual(page.url, url + "/credits")
            self.assertTrue(await owned.text_check({"type": "text-visible", "value": "Balance"}))
        self.assertIn((self.server.server_port, "/credits"), REQUESTS)

    async def test_milestone_checks_read_the_live_page_independently(self):
        from decimal import Decimal
        from journey_steps import CheckUnavailable, JourneyProgress

        url = f"http://127.0.0.1:{self.server.server_port}"
        payload = {"mode": "run", "targetUrl": url + "/credits", "allowedOrigins": [url]}
        steps = [{"id": "start", "title": "Confirm starting credits", "checks": [{"type": "read-number", "label": "Credits", "name": "before"}]},
                 {"id": "run", "title": "Run and see credits decrease", "checks": [{"type": "url-contains", "value": "/credits"}, {"type": "text-absent", "value": "Run failed"}, {"type": "compare-number", "label": "Credits", "name": "after", "op": "<", "than": "before"}]}]
        events = []
        async with runner.OwnedBrowser(payload, events.append, case_id="credits") as owned:
            self.assertEqual([await owned.read_number(label) for label in ["Credits", "Balance", "Usage", "Tokens", "Missing"]], [Decimal("1240"), Decimal("12.00"), Decimal("5"), None, None])
            self.assertTrue(await owned.payment_allowed())
            progress = JourneyProgress({"id": "credits", "steps": steps}, events.append, owned)
            await progress.report("start", "running")
            await progress.report("start", "completed", "Credits 1,240 are visible")
            await progress.report("run", "running")
            page = await owned.active_page()
            await page.get_by_role("button", name="Run").click()
            await progress.report("run", "completed", "Credits dropped after the run")
            milestones = [event for event in events if event["type"] == "journey-step"]
            self.assertEqual([(event["stepId"], event["status"]) for event in milestones], [("start", "running"), ("start", "completed"), ("run", "running"), ("run", "completed")])
            self.assertEqual([(check["passed"], check.get("observed")) for check in milestones[1]["checks"] + milestones[3]["checks"]], [(True, 1240), (True, None), (True, None), (True, 1236)])
            await page.goto(url + "/checkout")
            banner = page.get_by_text(runner.TEST_MODE_BANNER).filter(visible=True)
            self.assertEqual(await banner.count(), 0)
            await page.evaluate("() => document.body.insertAdjacentHTML('afterbegin', '<div><span> Test mode </span></div>')")
            self.assertEqual(await banner.count(), 1)
            await page.goto("about:blank")
            with self.assertRaises(CheckUnavailable):
                await owned.read_number("Credits")

    async def test_runs_use_flash_mode_and_long_journeys_tolerate_more_failures(self):
        url = f"http://127.0.0.1:{self.server.server_port}"
        steps = [{"id": f"step{index}", "title": f"Milestone {index}"} for index in range(8)]
        schema, _ = runner.output_schemas()
        for payload, flash, failures in [({"mode": "run", "case": {"steps": steps}}, True, 4), ({"mode": "run", "case": {"steps": steps[:2]}}, True, 3), ({"mode": "discover"}, False, 2)]:
            payload = {**payload, "targetUrl": url, "allowedOrigins": [url], "timeoutSeconds": 30}
            async with runner.OwnedBrowser(payload, lambda _: None, case_id="long") as owned:
                with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-not-a-real-key", "PERPETUAL_MODEL": "fixture", "PERPETUAL_MODEL_BASE_URL": url}):
                    agent, _ = runner.create_agent(payload, owned, "Inspect the fixture", schema, "long", [])
                self.assertEqual((agent.settings.flash_mode, agent.settings.max_failures), (flash, failures), payload["mode"])

    async def test_tools_have_no_files_shell_or_evaluate(self):
        report, _ = runner.output_schemas()
        tools = runner.safe_tools(report)
        names = set(tools.registry.registry.actions)
        self.assertLessEqual(names, runner.SAFE_ACTIONS)
        self.assertIn("click", names)
        self.assertIn("done", names)
        self.assertFalse(names & {"evaluate", "read_file", "write_file", "upload_file", "save_as_pdf", "search", "extract"})

    async def test_cancellation_closes_owned_browser_and_next_case_is_fresh(self):
        url = f"http://127.0.0.1:{self.server.server_port}"
        payload = {"mode": "run", "targetUrl": url, "allowedOrigins": [url]}
        started = asyncio.Event()
        captured = {}

        async def activity():
            async with runner.OwnedBrowser(payload, lambda _: None, case_id="previous") as owned:
                captured["profile"] = owned.profile.name
                captured["page"] = await owned.active_page()
                await captured["page"].evaluate("() => localStorage.setItem('fixture', 'previous-case')")
                started.set()
                await asyncio.Event().wait()

        task = asyncio.create_task(activity())
        await asyncio.wait_for(started.wait(), 20)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 15)
        self.assertTrue(captured["page"].is_closed())
        self.assertFalse(Path(captured["profile"]).exists())
        async with runner.OwnedBrowser(payload, lambda _: None, case_id="next") as owned:
            page = await owned.active_page()
            self.assertIsNone(await page.evaluate("() => localStorage.getItem('fixture')"))

    async def test_real_agent_loop_with_protocol_fixture_and_reviewable_discovery(self):
        model_server = ThreadingHTTPServer(("127.0.0.1", 0), ProtocolModelHandler)
        model_server.observations = []
        model_server.discovery = False
        model_server.missing_button = None
        threading.Thread(target=model_server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{self.server.server_port}"
        payload = runner.validate_payload({"mode": "run", "targetUrl": url, "allowedOrigins": [url], "maxSteps": 4, "timeoutSeconds": 30, "case": {"id": "save", "name": "Save workspace", "goal": "Click Save", "preconditions": [], "expectedOutcomes": ["Saved workspace visible"], "assertions": [{"type": "text-visible", "value": "Saved workspace"}], "selected": True, "needsReview": False}})
        events = []
        try:
            with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-not-a-real-key", "PERPETUAL_MODEL": "fixture", "PERPETUAL_MODEL_BASE_URL": f"http://127.0.0.1:{model_server.server_port}/v1"}), patch.object(runner, "emit", events.append):
                result = (await asyncio.wait_for(runner.run_journey(payload), 35))["result"]
                self.assertIsNone(model_server.missing_button, model_server.missing_button)
                self.assertEqual((result["stopCause"], result["agentCompleted"], result["assertions"]), ("none", True, [{"type": "text-visible", "value": "Saved workspace", "passed": True}]), result)
                self.assertGreaterEqual(len(model_server.observations), 2)
                self.assertTrue(any(event.get("actions") and event["actions"][0] == {"type": "click", "status": "passed"} for event in events))
                self.assertTrue(any(event["type"] == "frame" for event in events))
                model_server.discovery = True
                discovered = await asyncio.wait_for(runner.discover({**payload, "mode": "discover"}), 35)
                self.assertEqual(discovered["type"], "discovery")
                self.assertFalse(discovered["cases"][0]["selected"])
                self.assertTrue(discovered["cases"][0]["needsReview"])
                self.assertEqual(len(discovered["cases"][0]["steps"]), 2)
                self.assertEqual(discovered["cases"][0]["isolation"], "shared")
                self.assertIs(discovered["authenticated"], False)
        finally:
            model_server.shutdown()
            model_server.server_close()


if __name__ == "__main__":
    unittest.main()
