import copy
from decimal import Decimal
import unittest

from journey_steps import CheckUnavailable, JourneyProgress, number_after, validate_steps


STEPS = [{"id": "create", "title": "Create and save the workflow"}, {"id": "run", "title": "Run it and verify the result and credit debit"}]
CREDIT_STEPS = [
    {"id": "start", "title": "Confirm the starting credits", "checks": [{"type": "read-number", "label": "Credits", "name": "before"}]},
    {"id": "run", "title": "Run the workflow and see credits decrease", "checks": [{"type": "text-visible", "value": "Run complete"}, {"type": "compare-number", "label": "Credits", "name": "after", "op": "<", "than": "before"}]},
]


class Page:
    """Independent page observations; the agent never supplies these values."""

    def __init__(self, numbers=(), visible=()):
        self.numbers, self.visible, self.labels = list(numbers), set(visible), []

    async def text_check(self, check):
        return check["value"] in self.visible if check["type"] == "text-visible" else check["value"] not in self.visible

    async def read_number(self, label):
        self.labels.append(label)
        value = self.numbers.pop(0) if self.numbers else None
        if isinstance(value, Exception):
            raise value
        return value


class MilestoneValidation(unittest.TestCase):
    def test_only_approved_business_milestones_and_bounded_checks_are_accepted(self):
        self.assertEqual(validate_steps([]), [])
        self.assertEqual(validate_steps(CREDIT_STEPS), CREDIT_STEPS)
        self.assertEqual(validate_steps([{**STEPS[0], "checks": []}]), [STEPS[0]])
        same_step = [{"id": "balance", "title": "Credits drop", "checks": [{"type": "read-number", "label": "Credits", "name": "before"}, {"type": "compare-number", "label": "Credits", "name": "after", "op": "!=", "than": "before"}]}]
        self.assertEqual(validate_steps(same_step), same_step)
        for value in [[{"id": "../invalid", "title": "Save"}], STEPS + STEPS, [{"id": "click", "title": "Save", "selector": "#submit"}], [{"id": "save", "title": " "}]]:
            with self.assertRaises(ValueError):
                validate_steps(value)
        read = {"type": "read-number", "label": "Credits", "name": "before"}
        invalid_checks = [
            [{"type": "execute-js", "value": "1"}], [{"type": "text-visible", "value": " "}], [{"type": "text-visible", "value": "x" * 4001}],
            [{"type": "text-visible", "value": "Done", "selector": "#x"}], [{**read, "label": "x" * 121}], [{**read, "name": "Before"}], [{**read, "name": "b" * 41}],
            [{"type": "compare-number", "label": "Credits", "name": "after", "op": "<", "than": "before"}],
            [read, {"type": "compare-number", "label": "Credits", "name": "after", "op": "<=", "than": "before"}],
            [{"type": "compare-number", "label": "Credits", "name": "after", "op": "<", "than": "after"}, read],
            [read] * 7, {"type": "text-visible", "value": "Done"},
        ]
        for checks in invalid_checks:
            with self.subTest(checks=checks), self.assertRaises(ValueError):
                validate_steps([{**STEPS[0], "checks": checks}])
        with self.assertRaises(ValueError):
            validate_steps(list(reversed(CREDIT_STEPS)))
        self.assertEqual(validate_steps([{**STEPS[0], "checks": [{"type": "text-visible", "value": "x" * 4000}]}])[0]["checks"][0]["value"], "x" * 4000)

    def test_numbers_are_parsed_after_the_label_without_page_specific_guessing(self):
        for text, expected in [("Credits 1,240", "1240"), ("Credits: 1240.5 left", "1240.5"), ("credits -3", "-3"), ("Balance $12.00", "12.00"), ("CREDITS\n\n42 remaining of 100", "42"), ("Credits - 120", "120"), ("Credits used 12, 13 left", "12"), ("Plan 2 Credits 7", "7")]:
            label = "Balance" if "Balance" in text else "Credits"
            with self.subTest(text=text):
                self.assertEqual(number_after(text, label)[0], Decimal(expected))
        for text in ["Credits", "40 Credits", "No balance", ""]:
            self.assertIsNone(number_after(text, "Credits"))
        self.assertLess(number_after("Credits 7", "Credits")[1], number_after("Credits and plan 7", "Credits")[1])
        # An ancestor's text includes its siblings, so only separators may sit between label and number.
        for text, expected in [("Credits 1,240", "1240"), ("Credits: $12.00", "12.00"), ("Credits — (−3)", "-3"), ("1,240 credits\nSeats 3", None), ("Credits used 12", None), ("Billing Credits Plan 2", None)]:
            with self.subTest(adjacent=text):
                hit = number_after(text, "Credits", adjacent=True)
                self.assertEqual(hit and hit[0], expected and Decimal(expected))


class JourneyProgressTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.events = []
        self.case = {"id": "happy", "steps": STEPS, "expectedOutcomes": ["The workflow completes and credits decrease"], "assertions": [{"type": "text-visible", "value": "Complete"}]}
        self.progress = JourneyProgress(self.case, self.events.append)

    async def test_the_runner_starts_each_milestone_and_the_agent_evidence_ends_it(self):
        before = copy.deepcopy(self.case)
        await self.progress.report("create", "running")
        await self.progress.report("create", "completed", "Created the named workflow and reopened it")
        await self.progress.report("run", "running")
        await self.progress.report("run", "completed", "Result and debit observed")
        self.assertEqual(self.case, before)
        self.assertEqual([(event["stepId"], event["status"], event.get("evidence")) for event in self.events], [("create", "running", None), ("create", "completed", "Created the named workflow and reopened it"), ("run", "running", None), ("run", "completed", "Result and debit observed")])
        self.assertTrue(all(event["caseId"] == "happy" and event["type"] == "journey-step" and "checks" not in event for event in self.events))
        with self.assertRaises(ValueError):
            await self.progress.report("run", "running")

    async def test_out_of_order_unknown_and_terminal_reports_do_not_change_progress(self):
        for step_id, status, evidence in [("invented", "running", None), ("run", "running", None), ("create", "completed", "Claim"), ("create", "blocked", "Claim"), ("create", "failed", "Claim"), ("create", "passed", "Claim")]:
            with self.subTest(step=step_id, status=status), self.assertRaises(ValueError):
                await self.progress.report(step_id, status, evidence)
        self.assertEqual(self.events, [])
        await self.progress.report("create", "running")
        for evidence in [None, "", " ", "x" * 2001]:
            with self.assertRaises(ValueError):
                await self.progress.report("create", "completed", evidence)
        await self.progress.report("create", "blocked", "No dedicated test account")
        for step_id, status in [("create", "completed"), ("create", "running"), ("run", "running")]:
            with self.assertRaises(ValueError):
                await self.progress.report(step_id, status, "Nothing follows a blocked step")
        self.assertEqual([event["status"] for event in self.events], ["running", "blocked"])

    async def test_evidence_is_kept_as_observed_up_to_2000_characters(self):
        # A twin's test account is generated local data, so evidence naming it is kept as is.
        evidence = "Signed in as owner@example.test with <secret>perpetual_test_password</secret>; saved: " + "x" * 1900
        await self.progress.report("create", "running")
        await self.progress.report("create", "blocked", evidence)
        self.assertEqual(self.events[-1]["evidence"], evidence)

    async def test_milestone_checks_are_independent_page_observations(self):
        page = Page([Decimal("1240"), Decimal("1236")], {"Run complete"})
        progress = JourneyProgress({"id": "credits", "steps": CREDIT_STEPS}, self.events.append, page)
        for step, evidence in [("start", "Credits 1,240 before the run"), ("run", "Workflow finished and credits dropped")]:
            await progress.report(step, "running")
            await progress.report(step, "completed", evidence)
        self.assertEqual([(event["stepId"], event["status"]) for event in self.events], [("start", "running"), ("start", "completed"), ("run", "running"), ("run", "completed")])
        self.assertEqual(self.events[1]["checks"], [{**CREDIT_STEPS[0]["checks"][0], "passed": True, "observed": 1240, "provenance": "independent"}])
        self.assertEqual(self.events[3]["checks"], [{**CREDIT_STEPS[1]["checks"][0], "passed": True, "provenance": "independent"}, {**CREDIT_STEPS[1]["checks"][1], "passed": True, "observed": 1236, "provenance": "independent"}])
        self.assertEqual(page.labels, ["Credits", "Credits"])

    async def test_a_failed_check_fails_the_milestone_and_nothing_follows_it(self):
        for numbers, visible, error in [([Decimal("1240"), Decimal("1240")], {"Run complete"}, None), ([Decimal("1240"), None], {"Run complete"}, "No number follows this label on the current page."), ([Decimal("1240"), CheckUnavailable("The current page is outside approved origins.")], {"Run complete"}, "The current page is outside approved origins."), ([Decimal("1240"), RuntimeError("page text")], {"Run complete"}, "The current page could not be checked."), ([Decimal("1240"), Decimal("1")], set(), None)]:
            events = []
            progress = JourneyProgress({"id": "credits", "steps": CREDIT_STEPS}, events.append, Page(numbers, visible))
            for step, evidence in [("start", "Credits observed"), ("run", "Agent claims the balance dropped")]:
                await progress.report(step, "running")
                await progress.report(step, "completed", evidence)
            with self.subTest(numbers=numbers, visible=visible):
                self.assertEqual(events[-1]["status"], "failed")
                self.assertFalse(all(check["passed"] for check in events[-1]["checks"]))
                self.assertEqual(events[-1]["checks"][1].get("error"), error)
                self.assertNotIn("page text", str(events))
                with self.assertRaises(ValueError):
                    await progress.report("run", "running")
        events = []
        unobserved = JourneyProgress({"id": "unobserved", "steps": CREDIT_STEPS}, events.append)
        await unobserved.report("start", "running")
        await unobserved.report("start", "completed", "No page observer")
        self.assertEqual(events[-1]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
