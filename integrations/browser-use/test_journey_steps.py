import unittest

from journey_steps import validate_steps


STEPS = [{"id": "create", "title": "Create and save the workflow"}, {"id": "run", "title": "Run it and verify the result and credit debit"}]
CREDIT_STEPS = [
    {"id": "start", "title": "Confirm the starting credits", "checks": [{"type": "read-number", "label": "Credits", "name": "before"}]},
    {"id": "run", "title": "Run the workflow and see credits decrease", "checks": [{"type": "text-visible", "value": "Run complete"}, {"type": "compare-number", "label": "Credits", "name": "after", "op": "<", "than": "before"}]},
]


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


if __name__ == "__main__":
    unittest.main()
