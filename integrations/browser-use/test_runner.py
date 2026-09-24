import copy
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).parent


class RuntimeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("perpetual_browser_runner", HERE / "runner.py")
        cls.runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.runner)

    def payload(self):
        return {"mode": "run", "targetUrl": "http://127.0.0.1:3010/", "allowedOrigins": ["http://127.0.0.1:3010"],
                "case": {"id": "one", "name": "Open workspace", "goal": "Open the workspace", "preconditions": [],
                         "expectedOutcomes": ["Workspace is visible"], "assertions": [{"type": "text-visible", "value": "Workspace"}],
                         "selected": True, "needsReview": False}}

    def test_private_runtime_never_probes_the_desktop_display(self):
        import os
        import sys
        saved = {name: sys.modules.pop(name, "missing") for name in ("AppKit", "screeninfo")}
        try:
            with patch.dict(os.environ, {}, clear=False):
                self.runner.configure_private_runtime()
            for name in ("AppKit", "screeninfo"):
                with self.assertRaises(ImportError):
                    __import__(name)
        finally:
            for name, module in saved.items():
                if module == "missing":
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module
            import logging
            logging.disable(logging.NOTSET)

    def test_navigation_origin_is_exact_not_a_prefix_or_another_port(self):
        allowed = {"http://127.0.0.1:3010", "https://example.com"}
        self.assertTrue(self.runner.navigation_allowed("https://example.com/other", allowed))
        for url in ["http://127.0.0.1:30100/", "https://example.com.evil.test/", "https://example.com:8443/", "file:///tmp/private", "data:text/html,hi"]:
            self.assertFalse(self.runner.navigation_allowed(url, allowed))

    def test_unreviewed_or_unselected_cases_are_rejected(self):
        for field, value in [("selected", False), ("needsReview", True)]:
            payload = self.payload()
            payload["case"][field] = value
            with self.assertRaises(ValueError):
                self.runner.validate_payload(payload)

    def test_input_and_assertions_are_copied_and_goal_is_required(self):
        original = self.payload()
        validated = self.runner.validate_payload(original)
        original["case"]["assertions"][0]["value"] = "tampered"
        self.assertEqual(validated["case"]["assertions"][0]["value"], "Workspace")
        original["case"]["goal"] = ""
        with self.assertRaises(ValueError):
            self.runner.validate_payload(original)

    def test_reviewed_business_steps_survive_input_validation_and_scripts_are_rejected(self):
        original = self.payload()
        original["case"]["steps"] = [{"id": "entry", "title": "Enter workspace"}, {"id": "result", "title": "Complete the workspace task and verify its result"}]
        validated = self.runner.validate_payload(original)
        self.assertEqual(validated["case"]["steps"], original["case"]["steps"])
        original["case"]["steps"][0]["title"] = "Changed after approval"
        self.assertEqual(validated["case"]["steps"][0]["title"], "Enter workspace")
        self.assertEqual(validated["case"]["isolation"], "shared")
        original["case"]["steps"] = [{"type": "click", "selector": "#submit"}]
        with self.assertRaises(ValueError):
            self.runner.validate_payload(original)

    def test_milestone_checks_and_journey_budget_survive_input_validation(self):
        original = self.payload()
        original["maxSteps"] = 112
        original["case"]["steps"] = [{"id": "start", "title": "Confirm starting credits", "checks": [{"type": "read-number", "label": "Credits", "name": "before"}]}, {"id": "run", "title": "Run and see credits decrease", "checks": [{"type": "compare-number", "label": "Credits", "name": "after", "op": "<", "than": "before"}, {"type": "url-contains", "value": "/runs/"}]}]
        validated = self.runner.validate_payload(original)
        self.assertEqual(validated["maxSteps"], 112)
        self.assertEqual(validated["case"]["steps"], original["case"]["steps"])
        original["case"]["steps"][1]["checks"][0]["than"] = "later"
        with self.assertRaises(ValueError):
            self.runner.validate_payload(original)
        with self.assertRaises(ValueError):
            self.runner.validate_payload({**self.payload(), "maxSteps": 113})

    def test_discovery_accepts_run_only_credentials_and_same_host_sign_in_endpoints(self):
        account = {"username": "ephemeral@example.invalid", "password": "fixture-only-password"}
        payload = {"mode": "discover", "targetUrl": "http://127.0.0.1:55887/login", "allowedOrigins": ["http://127.0.0.1:55887"], "credentials": account, "authEndpoints": ["http://127.0.0.1:55888/auth/v1/token", "HTTP://127.0.0.1:55887/login?next=/"]}
        validated = self.runner.validate_payload(payload)
        self.assertEqual(validated["credentials"], account)
        self.assertEqual(validated["authEndpoints"], ["http://127.0.0.1:55888/auth/v1/token", "http://127.0.0.1:55887/login?next=/"])
        allowed = self.runner.endpoint_allowed
        self.assertTrue(allowed("http://127.0.0.1:55888/auth/v1/token?grant_type=password", validated["authEndpoints"]))
        self.assertTrue(allowed("http://127.0.0.1:55887/login?next=/workflows", validated["authEndpoints"]))
        self.assertTrue(allowed("http://127.0.0.1:55888/auth/v1/token/refresh", validated["authEndpoints"]))
        # Endpoints match whole path segments, never a sibling path that shares a prefix.
        for url in ["http://127.0.0.1:558880/auth/v1/token", "http://127.0.0.1:55888/auth/v1/user", "http://127.0.0.1:55888/auth/v1/token-revoke", "http://127.0.0.1:55888/auth/v1/tokens?grant_type=password", "http://localhost:55888/auth/v1/token", "https://127.0.0.1:55888/auth/v1/token", "http://127.0.0.1:55887/login", "http://127.0.0.1:55887/login-admin?next=/", "not a url"]:
            self.assertFalse(allowed(url, validated["authEndpoints"]), url)
        # A bare origin would admit every POST on that port.
        for endpoints in ["http://127.0.0.1:55888/auth", ["http://127.0.0.1:55888"], ["http://127.0.0.1:55888/"], ["http://127.0.0.1:55888/?next=/"], ["http://127.0.0.1:55888/a"] * 4, ["http://example.com/auth"], ["http://user:pass@127.0.0.1:55888/auth"], ["/auth/v1/token"], ["ftp://127.0.0.1/auth"], ["http://127.0.0.1:55888/auth#token"], [1]]:
            with self.subTest(endpoints=endpoints), self.assertRaises(ValueError):
                self.runner.validate_payload({**payload, "authEndpoints": endpoints})

    def test_discovery_permits_only_the_configured_sign_in_post_with_an_account(self):
        import asyncio
        from types import SimpleNamespace

        account = {"username": "ephemeral@example.invalid", "password": "fixture-only-password"}
        base = {"mode": "discover", "targetUrl": "http://127.0.0.1:55887/", "allowedOrigins": ["http://127.0.0.1:55887"], "authEndpoints": ["http://127.0.0.1:55888/auth/v1/token"]}

        class Route:
            def __init__(self, method, url):
                self.request = SimpleNamespace(method=method, url=url, is_navigation_request=lambda: False)
                self.outcome = None

            async def abort(self, *_):
                self.outcome = "blocked"

            async def continue_(self):
                self.outcome = "sent"

        def outcome(payload, method, url):
            route = Route(method, url)
            asyncio.run(self.runner.OwnedBrowser(self.runner.validate_payload(payload)).route_initial_request(route))
            return route.outcome

        token = "http://127.0.0.1:55888/auth/v1/token?grant_type=password"
        self.assertEqual(outcome({**base, "credentials": account}, "POST", token), "sent")
        self.assertEqual(outcome({**base, "credentials": account}, "GET", "http://127.0.0.1:55887/workflows"), "sent")
        for payload, method, url in [(base, "POST", token), ({**base, "credentials": account}, "PUT", token), ({**base, "credentials": account}, "POST", "http://127.0.0.1:55888/rest/v1/workflows"), ({**base, "credentials": account}, "DELETE", "http://127.0.0.1:55887/api/workflows/1")]:
            self.assertEqual(outcome(payload, method, url), "blocked", (method, url))
        run = {**base, "mode": "run", "credentials": account, "case": self.payload()["case"]}
        route = Route("POST", "http://127.0.0.1:55887/api/workflows")
        asyncio.run(self.runner.OwnedBrowser(self.runner.validate_payload(run), case_id="one").route_initial_request(route))
        self.assertEqual(route.outcome, "sent")

    def test_run_browsers_are_scoped_to_one_journey(self):
        with self.assertRaises(ValueError):
            self.runner.OwnedBrowser(self.runner.validate_payload(self.payload()))
        self.assertEqual(self.runner.OwnedBrowser({"mode": "discover"}).case_id, "discovery")

    def test_run_instructions_cover_business_state_and_stripe_test_mode_only_when_approved(self):
        payload = self.runner.validate_payload({**self.payload(), "scope": "Only the billing area", "requirements": "Never email real customers"})
        task = self.runner.run_task(payload, payload["case"])
        for phrase in ["starting state", "restoring it", "asynchronous", "blockers", "Stripe test mode", "Never email real customers"]:
            self.assertIn(phrase, task)
        self.assertNotIn("report_journey_step", task)
        # Discovery scope chose the journeys; a run follows the approved case and requirements only.
        self.assertNotIn("Only the billing area", task)
        self.assertNotIn('"scope"', task)
        # A successful result comes before any credit milestone, and a debit after a failed run is no pass.
        self.assertIn("Observe the completed, successful result of the work before completing any credit or usage milestone.", task)
        self.assertIn("A credit decrease after a failed run is a failure to report, not a pass", task)
        self.assertIn("observes the completed, successful result of that work before any credit or usage milestone; a credit decrease after a failed run is a failure, not a pass.", self.runner.DISCOVERY_INSTRUCTIONS)
        self.assertIn("a compare-number check only in a milestone after the one whose checks confirm the successful result", self.runner.DISCOVERY_INSTRUCTIONS)
        self.assertNotIn("4242 4242 4242 4242", task)
        stripe = self.runner.validate_payload({**self.payload(), "allowedOrigins": ["http://127.0.0.1:3010", "https://checkout.stripe.com", "https://billing.stripe.com"]})
        task = self.runner.run_task(stripe, stripe["case"])
        for phrase in ["4242 4242 4242 4242", "4000 0000 0000 0002", "future expiry", "CVC", "ZIP"]:
            self.assertIn(phrase, task)
        self.assertIn('"case":', task)
        for value, expected in [("https://checkout.stripe.com/c/pay/cs_live_1", True), ("https://stripe.com", True), ("https://stripe.com.evil.test", False), ("https://notstripe.com", False), ("http://127.0.0.1:3010", False), ("about:blank", False)]:
            self.assertEqual(self.runner.stripe_origin(value), expected, value)
        self.assertIn("read-number", self.runner.DISCOVERY_INSTRUCTIONS)
        self.assertIn("compare-number", self.runner.DISCOVERY_INSTRUCTIONS)

    def test_unavailable_twin_services_become_integration_blockers_only_when_present(self):
        stripe = {"id": "stripe", "title": "Stripe", "missing": ["secretKey"]}
        payload = self.runner.validate_payload({**self.payload(), "unavailableServices": [stripe]})
        task = self.runner.run_task(payload, payload["case"])
        self.assertIn(self.runner.UNAVAILABLE_SERVICES, task)
        self.assertIn('"unavailableServices": [{"id": "stripe", "title": "Stripe", "missing": ["secretKey"]}]', task)
        for phrase in ["kind integration", "stepId", "blocked", "never makes a milestone or outcome failed"]:
            self.assertIn(phrase, self.runner.UNAVAILABLE_SERVICES)
        for payload in [self.runner.validate_payload(self.payload()), self.runner.validate_payload({**self.payload(), "unavailableServices": []})]:
            task = self.runner.run_task(payload, payload["case"])
            self.assertNotIn(self.runner.UNAVAILABLE_SERVICES, task)
            self.assertNotIn("unavailableServices", task)
        for invalid in [{}, [{"id": "stripe", "title": "Stripe"}], [{**stripe, "url": "http://x"}], [{**stripe, "title": " "}], [{**stripe, "missing": "secretKey"}], [{**stripe, "missing": [""]}], [stripe] * 51]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.runner.validate_payload({**self.payload(), "unavailableServices": invalid})

    def test_each_milestone_is_one_request_and_the_last_asks_for_every_outcome(self):
        payload = self.payload()
        payload["case"]["steps"] = [{"id": "entry", "title": "Enter workspace"}, {"id": "result", "title": "Save and reopen the workspace"}]
        case = self.runner.validate_payload(payload)["case"]
        first, last = (self.runner.milestone_task(case, index) for index in range(2))
        self.assertTrue(first.startswith("Current milestone 1/2, stepId entry: Enter workspace. Work only toward this milestone; do not start the next one."), first)
        self.assertIn("call done with reached=false and blockers", first)
        self.assertNotIn("outcomeIndex", first)
        self.assertTrue(last.startswith("Current milestone 2/2, stepId result: Save and reopen the workspace."), last)
        self.assertIn("This is the last milestone. Either way, that done also returns an observation of every fixed expected outcome", last)
        # A journey without milestones is one request for its goal.
        legacy = self.runner.milestone_task(self.runner.validate_payload(self.payload())["case"], 0)
        self.assertTrue(legacy.startswith("Complete the journey."), legacy)
        self.assertIn("outcomeIndex", legacy)
        self.assertNotIn("milestone", legacy)

    def test_owned_chromium_resolves_the_twin_host_to_loopback(self):
        import asyncio
        launched = {}

        class Chromium:
            async def launch_persistent_context(self, **options):
                launched.update(options)
                raise RuntimeError("fixture stops after launch")

        class Playwright:
            chromium = Chromium()

            async def stop(self):
                pass

        class Starter:
            async def start(self):
                return Playwright()

        with patch("playwright.async_api.async_playwright", Starter), self.assertRaises(RuntimeError):
            asyncio.run(self.runner.OwnedBrowser({"mode": "discover"}, emit_event=[].append).__aenter__())
        self.assertIn("--host-resolver-rules=MAP host.docker.internal 127.0.0.1", launched["args"])
        self.assertIn("--remote-debugging-address=127.0.0.1", launched["args"])

    def test_journeys_tolerate_more_consecutive_failures_than_discovery(self):
        steps = [{"id": f"step{index}", "title": f"Milestone {index}"} for index in range(12)]
        for mode, count, expected in [("discover", 0, 2), ("discover", 12, 2), ("run", 0, 3), ("run", 2, 3), ("run", 7, 3), ("run", 8, 4), ("run", 12, 4)]:
            self.assertEqual(self.runner.failure_limit(mode, steps[:count]), expected, (mode, count))
        self.assertEqual(self.runner.failure_limit("run"), 3)

    def test_live_payments_have_a_controlled_code(self):
        from types import SimpleNamespace

        self.assertIn("payment_live_mode_rejected", self.runner.ACTION_FAILURES)
        rejected = SimpleNamespace(error="Payment pages accept input only in Stripe test mode.", metadata={"perpetualErrorCode": "payment_live_mode_rejected"})
        self.assertEqual(self.runner.action_progress("click", rejected), {"type": "click", "status": "failed", "errorCode": "payment_live_mode_rejected"})

    def test_one_invalid_proposal_does_not_discard_a_paid_discovery(self):
        class Proposal:
            def __init__(self, **value):
                self.value, self.name = value, value["name"]

            def model_dump(self):
                return copy.deepcopy(self.value)
        base = {"goal": "Sign in and reopen saved work", "preconditions": [], "expectedOutcomes": ["Saved work is visible"], "assertions": [], "evidence": []}
        good = Proposal(name="Reopen saved work", steps=[{"id": "open", "title": "Open"}, {"id": "reopen", "title": "Reopen"}], **base)
        bad = Proposal(name="Out of order", steps=[{"id": "a", "title": "Compare", "checks": [{"type": "compare-number", "label": "Credits", "name": "after", "op": "<", "than": "before"}]}, {"id": "b", "title": "Read", "checks": [{"type": "read-number", "label": "Credits", "name": "before"}]}], **base)
        payload = {**self.payload(), "mode": "discover", "sourceContext": "{}"}
        cases, summary = self.runner.accepted_proposals(payload, [bad, good], "Observed the dashboard.")
        self.assertEqual([case["name"] for case in cases], ["Reopen saved work"])
        self.assertTrue(summary.startswith("Observed the dashboard.\nOmitted \"Out of order\": "))
        with self.assertRaises(self.runner.InputError):
            self.runner.accepted_proposals(payload, [bad], "Observed")
        self.assertEqual(self.runner.accepted_proposals(payload, [], "Nothing supported")[0], [])

    def test_agent_reports_blockers_and_discovery_proposes_milestone_checks(self):
        report, discovery = self.runner.output_schemas()
        base = {"reached": False, "evidence": "Checkout never opened"}
        self.assertEqual(report.model_validate(base).model_dump(), {**base, "blockers": [], "outcomes": []})
        for invalid in [{"completed": False, "evidence": "x"}, {"reached": "false", "evidence": "x"}, {"reached": True}, {"reached": True, "evidence": " "}, {"reached": True, "evidence": "x" * 2001}]:
            with self.subTest(report=invalid), self.assertRaises(ValueError):
                report.model_validate(invalid)
        parsed = report.model_validate({**base, "blockers": [{"stepId": "pay", "kind": "integration", "evidence": "Stripe test keys are not configured"}, {"stepId": None, "kind": "account", "evidence": "No paid-plan account"}]})
        self.assertEqual([item.kind for item in parsed.blockers], ["integration", "account"])
        for blockers in [[{"kind": "database", "evidence": "x"}], [{"kind": "account", "evidence": ""}], [{"kind": "account", "evidence": "x"}] * 11, [{"stepId": "../x", "kind": "account", "evidence": "x"}]]:
            with self.subTest(blockers=blockers), self.assertRaises(ValueError):
                report.model_validate({**base, "blockers": blockers})
        steps = [{"id": "start", "title": "Confirm starting credits", "checks": [{"type": "read-number", "label": "Credits", "name": "before"}]}, {"id": "run", "title": "Run and see credits decrease", "checks": [{"type": "compare-number", "label": "Credits", "name": "after", "op": "<", "than": "before"}, {"type": "text-visible", "value": "Run complete"}]}]
        candidate = {"name": "Run a workflow", "goal": "Sign in, run a workflow and see credits decrease", "steps": steps, "preconditions": [], "expectedOutcomes": ["Credits decrease after the run"], "assertions": [], "evidence": []}
        parsed = discovery.model_validate({"cases": [candidate, {**candidate, "steps": [{"id": "a", "title": "Open"}, {"id": "b", "title": "Close"}]}], "summary": "Observed"})
        cases = [self.runner.discovered_case(item, {}) for item in parsed.cases]
        self.assertEqual(cases[0]["steps"], steps)
        self.assertEqual(cases[1]["steps"], [{"id": "a", "title": "Open"}, {"id": "b", "title": "Close"}])
        self.assertTrue(all(case["needsReview"] and not case["selected"] and case["isolation"] == "shared" for case in cases))
        for invalid in [[dict(steps[1]), dict(steps[0])], [{**steps[0], "checks": steps[0]["checks"] * 7}, steps[1]], [{**steps[0], "checks": [{"type": "read-number", "label": "Credits", "name": "before", "value": "1"}]}, steps[1]]]:
            with self.subTest(steps=invalid), self.assertRaises(ValueError):
                discovery.model_validate({"cases": [{**candidate, "steps": invalid}], "summary": "Observed"})
        # OpenAI strict structured output accepts anyOf unions, not oneOf discriminators.
        import json
        from browser_use.llm.schema import SchemaOptimizer
        encoded = json.dumps(SchemaOptimizer.create_optimized_json_schema(discovery))
        self.assertIn("compare-number", encoded)
        self.assertNotIn("oneOf", encoded)
        self.assertNotIn("discriminator", encoded)

    def test_a_run_has_exactly_one_case_and_rejects_unknown_assertions_and_excessive_bounds(self):
        payload = self.payload()
        for value in [None, [], [payload["case"]]]:
            with self.subTest(case=value), self.assertRaises(ValueError):
                self.runner.validate_payload({**payload, "case": value})

        payload = self.payload()
        payload["case"]["assertions"][0]["type"] = "execute-js"
        with self.assertRaises(ValueError):
            self.runner.validate_payload(payload)
        payload = self.payload()
        payload["maxSteps"] = 10000
        with self.assertRaises(ValueError):
            self.runner.validate_payload(payload)

    def test_a_run_records_only_into_an_absolute_video_folder(self):
        self.assertEqual(self.runner.validate_payload({**self.payload(), "videoDir": "/data/browser/videos/run"})["videoDir"], "/data/browser/videos/run")
        self.assertNotIn("videoDir", self.runner.validate_payload(self.payload()))
        for value in ["videos/run", "", 1, ["/videos"], "/" + "a" * 4000]:
            with self.subTest(videoDir=value), self.assertRaises(ValueError):
                self.runner.validate_payload({**self.payload(), "videoDir": value})

    def test_exception_bodies_are_not_exposed(self):
        error = ValueError("Invalid request containing sk-fixture-secret")
        self.assertNotIn("sk-fixture-secret", self.runner.safe_error(error))
        error = type("AuthenticationError", (Exception,), {})("Bearer sk-fixture-secret")
        self.assertEqual(self.runner.safe_error(error), "Model authentication failed. Check the configured model API key and access.")

    def test_failed_browser_cleanup_emits_structured_ownership_uncertainty(self):
        import asyncio

        class BrokenBrowser:
            async def stop(self):
                raise RuntimeError("fixture cleanup failure")

        events = []
        owned = self.runner.OwnedBrowser({}, emit_event=events.append)
        owned.browser = BrokenBrowser()
        asyncio.run(owned.close())
        self.assertEqual(events, [{"type": "error", "error": "Cleanup incomplete: browser agent connection", "cleanupIncomplete": True}])

    def test_discovery_schema_rejects_invalid_evidence_and_oversized_candidates(self):
        _, schema = self.runner.output_schemas()
        valid = {"cases": [{"name": "Open workspace", "goal": "Inspect workspace", "steps": [{"id": "enter", "title": "Enter the workspace"}, {"id": "result", "title": "Save and reopen the workspace"}], "preconditions": [], "expectedOutcomes": ["Workspace is visible"], "assertions": [{"type": "text-visible", "value": "Workspace"}], "evidence": [{"path": "frontend/page.tsx", "line": 2}]}], "summary": "Workspace observed"}
        self.assertEqual(schema.model_validate(valid).cases[0].evidence[0].line, 2)
        for line in [0, -1, 1000001, "2", 2.5, True]:
            invalid = copy.deepcopy(valid)
            invalid["cases"][0]["evidence"][0]["line"] = line
            with self.subTest(line=line), self.assertRaises(ValueError):
                schema.model_validate(invalid)
        for field, value in [("name", "x" * 121), ("goal", "x" * 4001), ("steps", []), ("steps", [{"id": "same", "title": "Milestone"}] * 2), ("steps", [{"id": "../outside", "title": "Milestone"}, {"id": "valid", "title": "Outcome"}]), ("expectedOutcomes", []), ("expectedOutcomes", ["x"] * 21), ("preconditions", ["x" * 2001]), ("assertions", [{"type": "text-visible", "value": "x"}] * 21), ("evidence", [{"path": "frontend/page.tsx", "line": 2}] * 41)]:
            invalid = copy.deepcopy(valid)
            invalid["cases"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                schema.model_validate(invalid)
        for path in ["../outside.ts", "/root/private", "AGENTS.md", "secrets.json", "src/.env", "C:\\private"]:
            invalid = copy.deepcopy(valid)
            invalid["cases"][0]["evidence"][0]["path"] = path
            with self.subTest(path=path), self.assertRaises(ValueError):
                schema.model_validate(invalid)
        invalid = copy.deepcopy(valid)
        invalid["cases"] *= 7
        with self.assertRaises(ValueError):
            schema.model_validate(invalid)

    def test_discovery_output_matches_backend_schema_without_invented_evidence(self):
        import json
        import subprocess

        _, schema = self.runner.output_schemas()
        # Line 3, a blank line 4 and another file were never supplied; line 2 was.
        cited = [{"path": "frontend/page.tsx", "line": 2}, {"path": "frontend/page.tsx", "line": 3}, {"path": "frontend/page.tsx", "line": 4}, {"path": "frontend/other.tsx", "line": 2}]
        result = schema.model_validate({"cases": [{"name": "Open workspace", "goal": "Inspect workspace", "steps": [{"id": "enter", "title": "Enter the workspace"}, {"id": "result", "title": "Save and reopen the workspace"}], "preconditions": [], "expectedOutcomes": ["Workspace is visible"], "assertions": [{"type": "text-visible", "value": "Workspace"}], "evidence": cited}, {"name": "Page observation", "goal": "Inspect page title", "steps": [{"id": "enter", "title": "Enter the workspace"}, {"id": "result", "title": "Save and reopen the workspace"}], "preconditions": [], "expectedOutcomes": ["Title visible"], "assertions": [], "evidence": []}], "summary": "Two drafts"})
        script = "import { validateDiscoveredBrowserCases } from './src/business/browser-cases.mjs'; let s=''; for await (const chunk of process.stdin) s+=chunk; const value=JSON.parse(s); const cases=validateDiscoveredBrowserCases(value.cases,value.context); process.stdout.write(JSON.stringify(cases));"
        context = json.dumps({"scope": "Workspace", "files": [{"path": "frontend/page.tsx", "source": "1: import React from 'react';\n2: export const title = 'Workspace';\n4:   "}]})
        self.assertEqual(self.runner.supplied_lines(context), {"frontend/page.tsx": {1, 2}})
        self.assertEqual([self.runner.supplied_lines(value) for value in ["", "[]", "{}", '{"files": [{"path": "a.ts", "source": 1}]}']], [{}, {}, {}, {}])
        drafts = [self.runner.discovered_case(item, self.runner.supplied_lines(context)) for item in result.cases]
        self.assertEqual(drafts[0]["evidence"], [{"path": "frontend/page.tsx", "line": 2}])

        completed = subprocess.run(["node", "--input-type=module", "-e", script], cwd=HERE.parent.parent, input=json.dumps({"cases": drafts, "context": context}), text=True, capture_output=True)
        self.assertEqual(completed.returncode, 0, "Generated Python cases did not pass the Node contract")
        cases = json.loads(completed.stdout)
        self.assertEqual(cases[0]["evidence"], [{"path": "frontend/page.tsx", "line": 2}])
        self.assertEqual(cases[1]["evidence"], [])
        self.assertTrue(all(case["needsReview"] and not case["selected"] for case in cases))


class PaymentGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_stripe_pages_accept_input_only_in_test_mode(self):
        from types import SimpleNamespace
        from pydantic import BaseModel

        spec = importlib.util.spec_from_file_location("perpetual_payment_runner", HERE / "runner.py")
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        runner.configure_private_runtime()
        from browser_use import Tools

        class Banner:
            def __init__(self, count):
                self.visible = count

            def filter(self, visible):
                return self

            async def count(self):
                return self.visible

        def page(url, texts=()):
            # Each text is one visible element's own text, matched as Playwright matches a pattern.
            async def active():
                return SimpleNamespace(url=url, get_by_text=lambda pattern: Banner(sum(bool(pattern.search(text)) for text in texts)))
            return active

        owned = runner.OwnedBrowser({"mode": "run"}, case_id="pay")
        for url, texts, expected in [("http://127.0.0.1:3010/billing", (), True), ("https://checkout.stripe.com/c/pay/cs_test_a1", (), True), ("https://billing.stripe.com/p/session/test_YWNj", (), True),
                                     ("https://checkout.stripe.com/c/pay/cs_live_a1", (), False), ("https://checkout.stripe.com/c/pay/cs_live_a1?next=/test_x#cs_test_", (), False),
                                     ("https://buy.stripe.com/aB3", ("Test mode",), True), ("https://buy.stripe.com/aB3", ("Sandbox Pro plan",), False),
                                     # A live session is never test mode, whatever the merchant names its products.
                                     ("https://checkout.stripe.com/c/pay/cs_live_a1", ("Sandbox Pro", "Sandbox"), False), ("https://checkout.stripe.com/c/pay/cs_live_a1/cs_test_a1", (), False),
                                     ("https://billing.stripe.com/p/session/live_YWNj", ("TEST MODE",), False)]:
            owned.active_page = page(url, texts)
            self.assertEqual(await owned.payment_allowed(), expected, (url, texts))

        async def closed():
            raise RuntimeError("The agent closed all browser pages.")
        owned.active_page = closed
        self.assertFalse(await owned.payment_allowed())
        for text, expected in [("Test mode", True), ("TEST MODE", True), ("Sandbox", True), (" Sandbox ", True), ("test mode", False), ("Not a Sandboxed page", False), ("Sandbox Pro plan", False), ("Test mode card", False)]:
            self.assertEqual(bool(runner.TEST_MODE_BANNER.search(text)), expected, text)

        report, _ = runner.output_schemas()
        owned.active_page = page("https://checkout.stripe.com/c/pay/cs_live_a1")
        tools = runner.safe_tools(report, ["http://127.0.0.1:3010", "https://checkout.stripe.com"], payment=owned.payment_allowed)

        class Action(BaseModel):
            click: dict | None = None
            input: dict | None = None
            send_keys: dict | None = None
            scroll: dict | None = None

        async def accepted(*_, **__):
            return SimpleNamespace(error=None)

        with patch.object(Tools, "act", accepted):
            for action in [Action(click={"index": 1}), Action(input={"index": 2, "text": "4242 4242 4242 4242"}), Action(send_keys={"keys": "Enter"})]:
                result = await tools.act(action, SimpleNamespace())
                self.assertEqual(result.metadata["perpetualErrorCode"], "payment_live_mode_rejected")
                self.assertEqual(runner.action_progress("click", result)["errorCode"], "payment_live_mode_rejected")
            self.assertIsNone((await tools.act(Action(scroll={"down": True}), SimpleNamespace())).error)
            owned.active_page = page("https://checkout.stripe.com/c/pay/cs_test_a1")
            self.assertIsNone((await runner.safe_tools(report, ["https://checkout.stripe.com"], payment=owned.payment_allowed).act(Action(click={"index": 1}), SimpleNamespace())).error)


class LargeDiscoveryContextTests(unittest.IsolatedAsyncioTestCase):
    async def test_large_source_is_preserved_as_untrusted_data_across_steps(self):
        import asyncio
        import json
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        spec = importlib.util.spec_from_file_location("browser_fixture", HERE / "test_browser.py")
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        runner = fixture.runner
        source = json.dumps({"files": [{"path": "frontend/app/page.tsx", "source": "1: // reference " + "x" * 135000 + "\n2: export const title = 'Workspace';"}]})
        references = []
        token_limits = []

        class ModelHandler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                references.append(request["messages"])
                token_limits.append(request.get("max_completion_tokens"))
                if len(references) == 1:
                    action = {"wait": {"seconds": 3}}
                else:
                    action = {"done": {"data": {"cases": [{"name": "Open workspace", "goal": "Inspect workspace", "steps": [{"id": "enter", "title": "Enter the workspace"}, {"id": "result", "title": "Save and reopen the workspace"}], "preconditions": [], "expectedOutcomes": ["Workspace is visible"], "assertions": [{"type": "text-visible", "value": "Workspace"}], "evidence": [{"path": "frontend/app/page.tsx", "line": 2}, {"path": "frontend/app/page.tsx", "line": 3}]}], "summary": "Workspace observed"}}}
                content = {"evaluation_previous_goal": "Observed fixture", "memory": "Retain source reference", "next_goal": "Complete discovery", "action": [action]}
                response = {"id": "fixture-completion", "object": "chat.completion", "created": 1, "model": "fixture", "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": json.dumps(content)}}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
                body = json.dumps(response).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        application = ThreadingHTTPServer(("127.0.0.1", 0), fixture.Handler)
        model = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        for server in [application, model]:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{application.server_port}"
        payload = runner.validate_payload({"mode": "discover", "targetUrl": url, "allowedOrigins": [url], "sourceContext": source, "maxSteps": 4, "timeoutSeconds": 30})
        events = []
        try:
            with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "fixture-not-a-real-key", "PERPETUAL_MODEL": "openai/gpt-5.4-mini", "PERPETUAL_MODEL_BASE_URL": f"http://127.0.0.1:{model.server_port}/v1"}), patch.object(runner, "emit", events.append):
                try:
                    result = await asyncio.wait_for(runner.discover(payload), 35)
                except Exception as error:
                    self.fail(f"Large discovery failed: {type(error).__name__}")
            # Line 3 was never supplied, so its citation is dropped rather than failing the batch.
            self.assertEqual(result["cases"][0]["evidence"], [{"path": "frontend/app/page.tsx", "line": 2}])
            self.assertFalse(result["cases"][0]["selected"])
            self.assertTrue(result["cases"][0]["needsReview"])
            self.assertEqual(len(references), 2)
            self.assertEqual(token_limits, [8192, 8192])
            for messages in references:
                reference = [message for message in messages if isinstance(message["content"], str) and source in message["content"]]
                self.assertEqual(len(reference), 1)
                self.assertEqual(reference[0]["role"], "user")
                self.assertIn("untrusted", reference[0]["content"].lower())
                self.assertIsNot(reference[0], messages[-1])
            self.assertGreaterEqual(sum(event["type"] == "frame" for event in events), 2)
            self.assertTrue(any(event.get("actions") and event["actions"][0] == {"type": "wait", "status": "passed"} for event in events))
        finally:
            for server in [application, model]:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
