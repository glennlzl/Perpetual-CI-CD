"""Reject an entire multi-action response before Browser Use can truncate it."""

import asyncio
import io
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import runner

runner.configure_private_runtime()


class Application(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path.startswith("/must-not-visit"):
            self.server.unexpected_visits += 1
        body = b"<!doctype html><html><body><h1>Observed workspace</h1></body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ProtocolModel(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append(request)
        if len(self.server.requests) == 1:
            action = [{"navigate": {"url": self.server.origin + "/must-not-visit-" + str(index)}} for index in range(3)]
        else:
            action = [{"done": {"data": {"reached": True, "evidence": "Observed workspace is visible.", "outcomes": [{"outcomeIndex": 0, "status": "satisfied", "evidence": "Observed workspace is visible."}]}}}]
        content = json.dumps({"evaluation_previous_goal": "Observe the actual page", "memory": "No prior action is assumed complete", "next_goal": "Observe workspace", "action": action})
        response = {"id": "fixture", "object": "chat.completion", "created": 1, "model": "fixture", "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        body = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class SingleActionContract(unittest.IsolatedAsyncioTestCase):
    async def test_multi_action_response_dispatches_nothing_and_valid_response_recovers(self):
        application = ThreadingHTTPServer(("127.0.0.1", 0), Application)
        application.unexpected_visits = 0
        model = ThreadingHTTPServer(("127.0.0.1", 0), ProtocolModel)
        model.requests = []
        model.origin = f"http://127.0.0.1:{application.server_port}"
        for server in [application, model]:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        payload = runner.validate_payload({"mode": "run", "targetUrl": model.origin, "maxSteps": 4, "timeoutSeconds": 20, "case": {"id": "fixture", "name": "Observe workspace", "goal": "Observe workspace", "expectedOutcomes": ["Observed workspace is visible"], "assertions": [{"type": "text-visible", "value": "Observed workspace"}], "selected": True, "needsReview": False}})
        try:
            output = io.StringIO()
            with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-only-key", "PERPETUAL_MODEL": "fixture", "PERPETUAL_MODEL_BASE_URL": f"http://127.0.0.1:{model.server_port}/v1"}), patch.object(runner, "STDOUT", output):
                result = (await asyncio.wait_for(runner.run_journey(payload), 25))["result"]
            self.assertEqual(application.unexpected_visits, 0, "A rejected multi-action response executed its first navigation")
            self.assertEqual((result["stopCause"], result["agentCompleted"], result["assertions"]), ("none", True, [{"type": "text-visible", "value": "Observed workspace", "passed": True}]))
            # Model time and token totals vary; they are counted, never sent as prompts.
            usage = {key: result["diagnostics"].pop(key) for key in ("modelMs", "inputTokens", "outputTokens")}
            self.assertTrue(all(isinstance(value, int) and value >= 0 for value in usage.values()), usage)
            self.assertEqual(result["diagnostics"], {"modelCalls": 2, "modelFailures": {"timeout": 0, "invalid_output": 1, "provider": 0, "other": 0}, "stepsWithoutActions": 1, "forcedFinalization": False, "actionCount": 1})
            progress = [event for line in output.getvalue().splitlines() if (event := json.loads(line)).get("type") == "case"]
            self.assertEqual(progress[-1]["actions"], [{"type": "done", "status": "passed"}])
            for request in model.requests:
                action_schema = request["response_format"]["json_schema"]["schema"]["properties"]["action"]
                self.assertEqual(action_schema["maxItems"], 1)
        finally:
            for server in [application, model]:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
