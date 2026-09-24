"""A forced final report cannot hide earlier model failures, and the runner reports it as its stop cause."""

import asyncio
import io
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from types import SimpleNamespace

import runner
from test_run_credentials import Application


class FailingModel(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        self.server.calls += 1
        if self.server.calls <= getattr(self.server, "invalid_count", 2):
            content = "invalid-json-from-model"
        else:
            content = json.dumps({"evaluation_previous_goal": "End fixture", "memory": "Fixture", "next_goal": "Finish", "action": [{"done": {"data": {"reached": True, "evidence": "Sign in is visible", "outcomes": [{"outcomeIndex": 0, "status": self.server.outcome_status, "evidence": "Sign in is visible"}]}}}]})
        response = {"id": "fixture", "object": "chat.completion", "created": 1, "model": "fixture", "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        body = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ForcedFinalization(unittest.IsolatedAsyncioTestCase):
    def test_action_progress_only_exposes_fixed_failure_codes(self):
        private = "private-browser-error-with-page-content"
        for metadata in [{"perpetualErrorCode": private}, {"perpetualErrorCode": [private]}, None]:
            result = runner.action_progress("input", SimpleNamespace(error=private, metadata=metadata))
            self.assertEqual(result, {"type": "input", "status": "failed", "errorCode": "browser_action_failed"})
            self.assertNotIn(private, json.dumps(result))
        self.assertEqual(runner.action_progress("click", None), {"type": "click", "status": "failed", "errorCode": "action_result_missing"})
        self.assertEqual(runner.action_progress("input", SimpleNamespace(error=None, metadata={"perpetualErrorCode": private})), {"type": "input", "status": "passed"})

    async def test_hidden_model_failures_are_counted_and_forced_done_is_reported_as_forced(self):
        application = ThreadingHTTPServer(("127.0.0.1", 0), Application)
        model = ThreadingHTTPServer(("127.0.0.1", 0), FailingModel)
        for server in [application, model]:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f"http://127.0.0.1:{application.server_port}"
        payload = runner.validate_payload({"mode": "run", "targetUrl": origin, "maxSteps": 6, "timeoutSeconds": 30, "case": {"id": "fixture", "name": "Observed sign-in", "goal": "Inspect sign-in", "expectedOutcomes": ["Sign in is visible"], "assertions": [{"type": "text-visible", "value": "Sign in"}], "selected": True, "needsReview": False}})
        # A journey forces a final report after three consecutive failures, and stops after a fourth.
        limit = runner.failure_limit("run")
        self.assertEqual(limit, 3)
        try:
            for invalid_count, outcome_status, stop_cause in [(limit, "satisfied", "forced"), (limit, "failed", "forced"), (limit + 1, "satisfied", "exception"), (limit - 1, "satisfied", "none")]:
                model.calls = 0
                model.invalid_count = invalid_count
                model.outcome_status = outcome_status
                with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-only-key", "PERPETUAL_MODEL": "fixture", "PERPETUAL_MODEL_BASE_URL": f"http://127.0.0.1:{model.server_port}/v1"}), patch.object(runner, "STDOUT", io.StringIO()):
                    result = (await asyncio.wait_for(runner.run_journey(payload), 35))["result"]
                self.assertEqual(result["stopCause"], stop_cause)
                self.assertNotIn("status", result)
                # Model time and token totals vary; they are counted, never sent as prompts.
                usage = {key: result["diagnostics"].pop(key) for key in ("modelMs", "inputTokens", "outputTokens")}
                self.assertTrue(all(isinstance(value, int) and value >= 0 for value in usage.values()), usage)
                self.assertEqual(result["diagnostics"], {"modelCalls": min(invalid_count + 1, limit + 1), "modelFailures": {"timeout": 0, "invalid_output": invalid_count, "provider": 0, "other": 0}, "stepsWithoutActions": invalid_count, "forcedFinalization": invalid_count >= limit, "actionCount": int(invalid_count <= limit)})
                if stop_cause == "exception":
                    # The agent never reported, so only the sanitized model failure explains the stop.
                    self.assertEqual((result["agentCompleted"], result["outcomes"], result["assertions"]), (False, [], []))
                    self.assertIn("error", result)
                else:
                    self.assertNotIn("error", result)
                    self.assertEqual([item["status"] for item in result["outcomes"]], [outcome_status])
                    self.assertEqual(result["assertions"], [{"type": "text-visible", "value": "Sign in", "passed": True}])
                self.assertNotIn("invalid-json-from-model", json.dumps(result))
        finally:
            for server in [application, model]:
                server.shutdown()
                server.server_close()

    def test_classification_uses_types_without_retaining_error_payloads(self):
        from pydantic import BaseModel, ValidationError
        class Value(BaseModel):
            number: int
        try:
            Value(number="private-provider-payload")
        except ValidationError as cause:
            wrapper = RuntimeError("private-provider-payload")
            wrapper.__cause__ = cause
            self.assertEqual(runner.model_failure_kind(wrapper), "invalid_output")
        self.assertEqual(runner.model_failure_kind(TimeoutError("private")), "timeout")
        self.assertEqual(runner.model_failure_kind(ValueError("private")), "other")


if __name__ == "__main__":
    unittest.main()
