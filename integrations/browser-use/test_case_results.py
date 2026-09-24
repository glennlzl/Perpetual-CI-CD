import copy
import unittest
from unittest.mock import patch

from case_results import journey_facts


class JourneyFactContracts(unittest.TestCase):
    """The runner reports facts; the controller's verdict tests live in test/browser-results.test.mjs."""

    def setUp(self):
        self.case = {"id": "save", "expectedOutcomes": ["Workspace reopens", "Delivery reaches test inbox"], "assertions": [{"type": "text-visible", "value": "Saved workspace"}]}
        self.checks = [{**self.case["assertions"][0], "passed": True}]
        self.report = {"completed": True, "outcomes": [{"outcomeIndex": 1, "status": "uncertain", "evidence": "No test inbox access"}, {"outcomeIndex": 0, "status": "satisfied", "evidence": "Reopened saved workspace"}]}

    def test_facts_carry_observations_with_explicit_provenance_and_no_verdict(self):
        facts = journey_facts(self.case, "none", self.report, self.checks)
        self.assertEqual(facts, {"caseId": "save", "stopCause": "none", "agentCompleted": True, "outcomes": [{**item, "provenance": "agent"} for item in reversed(self.report["outcomes"])], "assertions": self.checks})
        # A journey that ended before any report states only why it stopped.
        self.assertEqual(journey_facts(self.case, "deadline"), {"caseId": "save", "stopCause": "deadline", "agentCompleted": False, "outcomes": [], "assertions": []})

    def test_invalid_correspondence_does_not_fabricate_observations(self):
        for outcomes in [None, [], [self.report["outcomes"][0]] * 2, [{"outcomeIndex": "0", "status": "satisfied", "evidence": "Wrong index"}, self.report["outcomes"][0]]]:
            with self.subTest(outcomes=outcomes):
                self.assertEqual(journey_facts(self.case, "none", {"completed": True, "outcomes": outcomes}, self.checks)["outcomes"], [])

    def test_reported_blockers_are_bounded_and_keep_only_approved_steps(self):
        case = {**self.case, "steps": [{"id": "inbox", "title": "Confirm delivery in the test inbox"}]}
        report = {**self.report, "blockers": [{"stepId": "inbox", "kind": "integration", "evidence": "No test inbox is connected"}, {"stepId": None, "kind": "account", "evidence": "Password reset required"}]}
        self.assertEqual(journey_facts(case, "none", report, self.checks)["blockers"], [{"stepId": "inbox", "kind": "integration", "evidence": "No test inbox is connected"}, {"kind": "account", "evidence": "Password reset required"}])
        for blockers in [None, [], [{"kind": "database", "evidence": "x"}], [{"kind": "account", "evidence": " "}], [{"stepId": ["inbox"], "kind": "account"}], "blocked"]:
            with self.subTest(blockers=blockers):
                self.assertNotIn("blockers", journey_facts(case, "none", {**self.report, "blockers": blockers}, self.checks))
        unknown = journey_facts(case, "none", {**report, "blockers": [{"stepId": "invented", "kind": "fixture", "evidence": "Seed data missing"}] * 12}, self.checks)
        self.assertEqual(unknown["blockers"], [{"kind": "fixture", "evidence": "Seed data missing"}] * 10)

    def test_observations_are_bounded_and_credentials_are_redacted(self):
        report = copy.deepcopy(self.report)
        report["outcomes"][0]["evidence"] = "private-fixture-key Bearer second-key https://example.test/?token=secret " + "x" * 5000
        with patch.dict("os.environ", {"PERPETUAL_MODEL_API_KEY": "private-fixture-key"}):
            evidence = journey_facts(self.case, "none", report, self.checks)["outcomes"][1]["evidence"]
        self.assertEqual(len(evidence), 2000)
        for private in ["private-fixture-key", "second-key", "token=secret"]:
            self.assertNotIn(private, evidence)
        # Outcome evidence keeps up to 2000 UTF-16 code units, the controller's count; a split emoji is dropped.
        for text, expected in [("Observed " + "y" * 1500, "Observed " + "y" * 1500), ("😀" * 1500, "😀" * 1000), ("a" + "😀" * 1500, "a" + "😀" * 999), ("Saved \ud800workspace", "Saved workspace")]:
            report["outcomes"][0]["evidence"] = text
            self.assertEqual(journey_facts(self.case, "none", report, self.checks)["outcomes"][1]["evidence"], expected)
