"""Code-driven milestones through the real Agent loop, owned Chromium and a protocol model; no paid calls."""

import asyncio
import contextlib
import io
import json
import re
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import runner

runner.configure_private_runtime()


class Application(BaseHTTPRequestHandler):
    """Each action changes the page, so a milestone's checks pass only on the page its done left."""

    def log_message(self, *_):
        pass

    def do_GET(self):
        body = b'''<!doctype html><html><body><h1>Workflows</h1><div><span>Credits</span> <strong id="credits">1,240</strong></div><p id="status">Ready</p>
<button onclick="document.getElementById('credits').textContent='1,236';document.getElementById('status').textContent='Run complete'">Run workflow</button>
<button onclick="document.getElementById('status').textContent='Result reopened'">Reopen result</button></body></html>'''
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def element(observation, label):
    """The index of the button whose text is label."""
    lines = observation.splitlines()
    for number, line in enumerate(lines):
        found = re.search(r"\[(\d+)\]<button|(\d+)\[:\]<button", line)
        if found and label in (line + (lines[number + 1] if number + 1 < len(lines) else "")):
            return int(found.group(1) or found.group(2))
    raise AssertionError(f"No {label} button in the observation")


class ProtocolModel(BaseHTTPRequestHandler):
    """Deterministic decisions from the actual observation; not an intelligence evaluation."""

    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        script, calls = self.server.script, self.server.calls
        action = script[min(len(calls), len(script) - 1)]
        calls.append(request)
        latest = request["messages"][-1]["content"]
        observation = (latest if isinstance(latest, str) else "\n".join(part.get("text", "") for part in latest)).split("<browser_state>")[-1]
        if isinstance(action, tuple):
            action = {"click": {"index": element(observation, action[1])}}
        content = "not a decision" if action == "invalid" else json.dumps({"memory": "Follow the current milestone", "action": [action]})
        body = json.dumps({"id": "fixture", "object": "chat.completion", "created": 1, "model": "fixture", "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def done(evidence, reached=True, blockers=(), outcomes=()):
    return {"done": {"data": {"reached": reached, "evidence": evidence, "blockers": list(blockers), "outcomes": list(outcomes)}}}


SATISFIED = [{"outcomeIndex": 0, "status": "satisfied", "evidence": "Run complete and reopened; credits went from 1,240 to 1,236"}]
JOURNEY = [done("Credits 1,240 and Ready are visible"), ("click", "Run workflow"), done("Run complete; credits 1,236"), ("click", "Reopen result"), done("The result reopened", outcomes=SATISFIED)]
STEPS = [
    # Ready and 1,240 are visible only before the run, so these checks prove they ran when this milestone's done arrived.
    {"id": "start", "title": "Confirm the starting credits", "checks": [{"type": "read-number", "label": "Credits", "name": "before"}, {"type": "text-visible", "value": "Ready"}]},
    # Run complete is replaced when the result is reopened.
    {"id": "run", "title": "Run the workflow and see credits decrease", "checks": [{"type": "text-visible", "value": "Run complete"}, {"type": "compare-number", "label": "Credits", "name": "after", "op": "<", "than": "before"}]},
    {"id": "reopen", "title": "Reopen the result", "checks": [{"type": "text-visible", "value": "Result reopened"}]},
]


@contextlib.contextmanager
def failing_context(once):
    """Browser Use fails to read the page at milestone 2's first step (once) or every step, before it records the step."""
    from browser_use.agent.service import Agent
    original, faults = Agent._prepare_context, []

    async def prepare(agent, step_info=None):
        if "Current milestone 2/3" in agent.task and not (once and faults):
            faults.append(agent.state.n_steps)
            raise RuntimeError("No browser state yet")
        return await original(agent, step_info)

    with patch.object(Agent, "_prepare_context", prepare):
        yield faults


class MilestoneJourneys(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.application = ThreadingHTTPServer(("127.0.0.1", 0), Application)
        self.model = ThreadingHTTPServer(("127.0.0.1", 0), ProtocolModel)
        for server in [self.application, self.model]:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        self.origin = f"http://127.0.0.1:{self.application.server_port}"

    async def asyncTearDown(self):
        for server in [self.application, self.model]:
            server.shutdown()
            server.server_close()

    async def run_journey(self, script, steps=STEPS, assertion="Result reopened", timeout=30, max_steps=10):
        self.model.script, self.model.calls = script, []
        case = {"id": "happy", "name": "Run a workflow", "goal": "Run a workflow, reopen its result and see credits decrease", "steps": steps, "expectedOutcomes": ["Credits decrease after the run"], "assertions": [{"type": "text-visible", "value": assertion}], "selected": True, "needsReview": False}
        payload = runner.validate_payload({"mode": "run", "targetUrl": self.origin, "maxSteps": max_steps, "timeoutSeconds": timeout, "case": case})
        output = io.StringIO()
        with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-only-key", "PERPETUAL_MODEL": "fixture", "PERPETUAL_MODEL_BASE_URL": f"http://127.0.0.1:{self.model.server_port}/v1"}), patch.object(runner, "STDOUT", output):
            result = (await asyncio.wait_for(runner.run_journey(payload), runner.request_seconds(payload) + 20))["result"]
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertNotIn("status", result, "The controller alone decides a journey's status.")
        milestones = [event for event in events if event["type"] == "journey-step"]
        return result, [(event["stepId"], event["status"]) for event in milestones], milestones, [event for event in events if event["type"] == "case"][-1]

    def asked(self):
        """The latest milestone request each model call received."""
        return [(re.findall(r"Current milestone \d/\d", json.dumps(request["messages"])) or [None])[-1] for request in self.model.calls]

    async def test_the_runner_drives_each_milestone_and_checks_it_when_its_done_arrives(self):
        result, milestones, events, progress = await self.run_journey(JOURNEY)
        self.assertEqual(milestones, [("start", "running"), ("start", "completed"), ("run", "running"), ("run", "completed"), ("reopen", "running"), ("reopen", "completed")])
        # The capture and the text checks read the page before the next milestone's click changed it.
        self.assertEqual([(check["type"], check["passed"], check.get("observed")) for event in events if event["status"] == "completed" for check in event["checks"]], [("read-number", True, 1240), ("text-visible", True, None), ("text-visible", True, None), ("compare-number", True, 1236), ("text-visible", True, None)])
        self.assertEqual([event.get("evidence") for event in events], [None, "Credits 1,240 and Ready are visible", None, "Run complete; credits 1,236", None, "The result reopened"])
        # The last milestone's done carries the observations of the fixed outcomes.
        self.assertEqual((result["stopCause"], result["agentCompleted"], [item["status"] for item in result["outcomes"]], result["assertions"]), ("none", True, ["satisfied"], [{"type": "text-visible", "value": "Result reopened", "passed": True}]))
        self.assertEqual(progress["actions"], [{"type": "done", "status": "passed"}, {"type": "click", "status": "passed"}] * 2 + [{"type": "done", "status": "passed"}])
        self.assertEqual(result["diagnostics"]["modelCalls"], 5)
        self.assertFalse(result["diagnostics"]["forcedFinalization"])
        # One agent keeps its history: each later milestone arrives as a follow-up request.
        self.assertEqual(self.asked(), ["Current milestone 1/3", "Current milestone 2/3", "Current milestone 2/3", "Current milestone 3/3", "Current milestone 3/3"])
        self.assertIn("<follow_up_user_request> Current milestone 3/3, stepId reopen: Reopen the result.", json.dumps(self.model.calls[-1]["messages"]))
        # Flash mode: the model answers with memory and one action, without per-step reasoning fields.
        self.assertNotIn("next_goal", self.model.calls[0]["response_format"]["json_schema"]["schema"]["properties"])
        self.assertNotIn("report_journey_step", json.dumps(self.model.calls))

    async def test_missing_outcomes_leave_the_agent_incomplete(self):
        result, milestones, _, _ = await self.run_journey(JOURNEY[:-1] + [done("The result reopened")])
        self.assertEqual(milestones[-1], ("reopen", "completed"))
        self.assertEqual((result["stopCause"], result["agentCompleted"], result["outcomes"]), ("none", False, []))

    async def test_a_blocked_milestone_reports_its_blockers_and_nothing_follows_it(self):
        blocker = {"stepId": "run", "kind": "account", "evidence": "owner@example.test has no paid plan"}
        result, milestones, events, _ = await self.run_journey([JOURNEY[0], done("Running needs a paid plan", reached=False, blockers=[blocker])])
        self.assertEqual(milestones, [("start", "running"), ("start", "completed"), ("run", "running"), ("run", "blocked")])
        self.assertEqual(events[-1]["evidence"], "Running needs a paid plan")
        # The test account's details are kept as the agent reported them.
        self.assertEqual((result["stopCause"], result["agentCompleted"], result["blockers"]), ("none", False, [blocker]))
        self.assertEqual(result["assertions"], [{"type": "text-visible", "value": "Result reopened", "passed": False}])
        self.assertEqual(len(self.model.calls), 2)
        self.assertNotIn("Current milestone 3/3", json.dumps(self.model.calls))

    async def test_a_failed_check_stops_the_journey(self):
        # The agent claims the run finished without running it; the page still shows Ready and 1,240.
        result, milestones, events, _ = await self.run_journey([JOURNEY[0], done("Run complete")])
        self.assertEqual(milestones, [("start", "running"), ("start", "completed"), ("run", "running"), ("run", "failed")])
        self.assertEqual([(check["passed"], check.get("observed")) for check in events[-1]["checks"]], [(False, None), (False, 1240)])
        self.assertEqual((result["stopCause"], result["agentCompleted"]), ("none", False))
        self.assertEqual(len(self.model.calls), 2)

    async def test_an_unreached_milestone_without_blockers_stays_unconfirmed(self):
        failed = [{"outcomeIndex": 0, "status": "failed", "evidence": "The run failed, yet credits dropped"}]
        result, milestones, _, _ = await self.run_journey([JOURNEY[0], done("The run failed", reached=False, outcomes=failed)])
        self.assertEqual(milestones, [("start", "running"), ("start", "completed"), ("run", "running")])
        # Its reported failed outcome reaches the controller, which fails the journey.
        self.assertEqual((result["stopCause"], result["agentCompleted"], [item["status"] for item in result["outcomes"]]), ("none", False, ["failed"]))
        self.assertNotIn("blockers", result)

    async def test_a_forced_report_stops_at_its_milestone(self):
        # Three invalid decisions in a row make Browser Use force a final report, which never confirms the milestone.
        result, milestones, _, _ = await self.run_journey([JOURNEY[0], "invalid", "invalid", "invalid", done("Run complete; credits 1,236")])
        self.assertEqual(milestones, [("start", "running"), ("start", "completed"), ("run", "running")])
        self.assertEqual((result["stopCause"], result["agentCompleted"]), ("forced", False))
        self.assertTrue(result["diagnostics"]["forcedFinalization"])
        self.assertEqual(result["diagnostics"]["modelFailures"]["invalid_output"], 3)
        self.assertNotIn("Current milestone 3/3", json.dumps(self.model.calls))

    async def test_the_milestones_share_the_journey_step_budget(self):
        # Milestone 1 spends one of three steps, so Browser Use forces milestone 2's report at the third.
        result, milestones, _, _ = await self.run_journey([JOURNEY[0], ("click", "Run workflow"), done("Run complete; credits 1,236")], max_steps=3)
        self.assertEqual(milestones, [("start", "running"), ("start", "completed"), ("run", "running")])
        self.assertEqual((result["stopCause"], result["agentCompleted"]), ("forced", False))
        self.assertTrue(result["diagnostics"]["forcedFinalization"])
        self.assertEqual(self.asked(), ["Current milestone 1/3", "Current milestone 2/3", "Current milestone 2/3"])
        self.assertIn("You reached max_steps", json.dumps(self.model.calls[-1]["messages"]))
        self.assertNotIn("Current milestone 3/3", json.dumps(self.model.calls))

    async def test_a_later_milestone_retries_a_step_that_failed_before_browser_use_recorded_it(self):
        # Without browser state, Browser Use records no history item, which must not leave milestone 1's done as this run's.
        with failing_context(once=True) as faults:
            result, milestones, _, _ = await self.run_journey(["invalid", *JOURNEY])
        self.assertEqual(len(faults), 1)
        self.assertEqual(milestones, [("start", "running"), ("start", "completed"), ("run", "running"), ("run", "completed"), ("reopen", "running"), ("reopen", "completed")])
        # The recovered invalid decision in milestone 1 is not the journey's stop cause.
        self.assertEqual((result["stopCause"], result["agentCompleted"], result["diagnostics"]["modelFailures"]["invalid_output"]), ("none", True, 1))

    async def test_only_the_latest_model_failure_explains_a_journey_without_a_report(self):
        # Milestone 2 never gets browser state, so Browser Use stops after its failure limit without any model call.
        with failing_context(once=False):
            result, milestones, _, _ = await self.run_journey(["invalid", JOURNEY[0]])
        self.assertEqual(milestones, [("start", "running"), ("start", "completed"), ("run", "running")])
        self.assertEqual((result["stopCause"], result["agentCompleted"], result["diagnostics"]["modelFailures"]["invalid_output"]), ("none", False, 1))
        self.assertNotIn("error", result)

    async def test_a_journey_deadline_is_its_stop_cause_and_still_reports_final_checks(self):
        result, milestones, _, _ = await self.run_journey([JOURNEY[0], {"wait": {"seconds": 3}}], assertion="Credits", timeout=8)
        self.assertEqual((result["stopCause"], result["agentCompleted"], result["outcomes"]), ("deadline", False, []))
        self.assertEqual(result["assertions"], [{"type": "text-visible", "value": "Credits", "passed": True}])
        self.assertEqual(milestones, [("start", "running"), ("start", "completed"), ("run", "running")])
        self.assertIn("diagnostics", result)
        self.assertNotIn("error", result)
        self.assertNotIn("Current milestone 3/3", json.dumps(self.model.calls))

    async def test_a_journey_without_milestones_is_one_request(self):
        result, milestones, _, progress = await self.run_journey([("click", "Run workflow"), done("Run complete", outcomes=SATISFIED)], steps=[], assertion="Run complete")
        self.assertEqual(milestones, [])
        self.assertEqual((result["stopCause"], result["agentCompleted"], result["assertions"]), ("none", True, [{"type": "text-visible", "value": "Run complete", "passed": True}]))
        self.assertEqual(progress["actions"], [{"type": "click", "status": "passed"}, {"type": "done", "status": "passed"}])
        self.assertIn("Complete the journey.", json.dumps(self.model.calls[0]["messages"]))
        self.assertNotIn("Current milestone", json.dumps(self.model.calls))

    async def test_the_request_backstop_reports_a_deadline_instead_of_an_error(self):
        self.model.script, self.model.calls = [JOURNEY[0], {"wait": {"seconds": 3}}], []
        case = {"id": "happy", "name": "Run a workflow", "goal": "Run a workflow", "steps": STEPS, "expectedOutcomes": ["Credits decrease after the run"], "assertions": [], "selected": True, "needsReview": False}
        payload = runner.validate_payload({"mode": "run", "targetUrl": self.origin, "maxSteps": 10, "timeoutSeconds": 60, "case": case})
        output = io.StringIO()
        # The backstop fires first only when a journey overran its own deadline, such as in a stuck cleanup.
        with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-only-key", "PERPETUAL_MODEL": "fixture", "PERPETUAL_MODEL_BASE_URL": f"http://127.0.0.1:{self.model.server_port}/v1"}), patch.object(runner, "STDOUT", output), patch.object(runner, "request_seconds", lambda _: 10):
            await asyncio.wait_for(runner.execute(payload), 40)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertNotIn("error", [event["type"] for event in events])
        self.assertEqual([(event["stepId"], event["status"]) for event in events if event["type"] == "journey-step"], [("start", "running"), ("start", "completed"), ("run", "running")])
        # The end state was never checked; the controller combines this with the milestones it accepted.
        self.assertEqual(events[-1], {"type": "result", "result": {"caseId": "happy", "stopCause": "deadline", "agentCompleted": False, "outcomes": [], "assertions": []}})


class StuckBrowser:
    """Owned Chromium stand-in whose page shows the starting plan."""

    def __init__(self, payload, emit_event=None, case_id=None):
        self.diagnostics = {"modelCalls": 1, "modelFailures": {"timeout": 0, "invalid_output": 0, "provider": 0, "other": 0}, "stepsWithoutActions": 0, "forcedFinalization": False, "actionCount": 1}
        self.model_error = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        pass

    async def text_check(self, check):
        return True


class RequestBackstop(unittest.IsolatedAsyncioTestCase):
    """The request-wide bound fires only when a journey overruns its own deadline; no browser or model."""

    CASE = {"id": "stuck", "name": "Journey stuck", "goal": "Complete the journey", "steps": [{"id": "plan", "title": "Confirm the starting plan", "checks": [{"type": "text-visible", "value": "Pro plan"}]}, {"id": "run", "title": "Run the workflow"}], "expectedOutcomes": ["The journey completes"], "assertions": [{"type": "text-visible", "value": "Complete"}], "selected": True, "needsReview": False}

    async def execute(self, stuck, mode="run"):
        """stuck(index) is the journey's actor until the backstop fires."""
        class Actor:
            def __init__(self, *_):
                pass

            async def reach(self, index):
                return await stuck(index)

        async def ready():
            return {"status": "ready"}

        payload = runner.validate_payload({"mode": mode, "targetUrl": "http://127.0.0.1:9/", "timeoutSeconds": 30, **({"case": self.CASE} if mode == "run" else {})})
        output = io.StringIO()
        with patch.object(runner, "preflight", ready), patch.object(runner, "OwnedBrowser", StuckBrowser), patch.object(runner, "BrowserUseActor", Actor), patch.object(runner, "request_seconds", lambda _: 0.5), patch.object(runner, "STDOUT", output):
            await asyncio.wait_for(runner.execute(payload), 10)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_one_journey_gets_its_deadline_and_a_grace_period_for_its_final_report(self):
        payload = runner.validate_payload({"mode": "run", "targetUrl": "http://127.0.0.1:9/", "timeoutSeconds": 60, "case": self.CASE})
        self.assertEqual(runner.request_seconds(payload), 60 + runner.RESULT_GRACE_SECONDS)
        # The grace covers the final checks and finishing recordings, with room for the rest of cleanup.
        self.assertGreater(runner.RESULT_GRACE_SECONDS, runner.FINAL_CHECK_SECONDS + runner.VIDEO_FINISH_SECONDS)
        self.assertEqual(runner.request_seconds({**payload, "mode": "discover"}), 60)

    async def test_a_milestone_recorded_before_the_backstop_still_reaches_the_controller(self):
        async def reach_then_hang(index):
            if index == 0:
                return {"reached": True, "evidence": "The plan badge is visible", "blockers": [], "outcomes": []}
            await asyncio.sleep(3600)

        events = await self.execute(reach_then_hang)
        self.assertNotIn("error", [event["type"] for event in events])
        self.assertEqual([(event["stepId"], event["status"]) for event in events if event["type"] == "journey-step"], [("plan", "running"), ("plan", "completed"), ("run", "running")])
        self.assertEqual(events[-1], {"type": "result", "result": {"caseId": "stuck", "stopCause": "deadline", "agentCompleted": False, "outcomes": [], "assertions": []}})

    async def test_upstream_cleanup_cannot_turn_the_backstop_into_an_exception(self):
        async def replace_cancellation(index):
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                raise RuntimeError("private upstream cleanup detail") from None

        events = await self.execute(replace_cancellation)
        self.assertEqual(events[-1]["result"]["stopCause"], "deadline")
        self.assertNotIn("private upstream cleanup detail", json.dumps(events))

    async def test_discovery_still_reports_its_time_limit_as_an_error(self):
        async def discover(payload):
            await asyncio.sleep(3600)

        with patch.object(runner, "discover", discover), self.assertRaises(TimeoutError):
            await self.execute(None, mode="discover")


if __name__ == "__main__":
    unittest.main()
