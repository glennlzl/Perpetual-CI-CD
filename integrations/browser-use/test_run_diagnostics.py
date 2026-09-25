"""Discovery's action feed and model failure counts carry fixed codes and categories, never page or provider text."""

import json
import unittest
from types import SimpleNamespace

import runner


class AgentDiagnostics(unittest.TestCase):
    def test_action_progress_only_exposes_fixed_failure_codes(self):
        private = "private-browser-error-with-page-content"
        for metadata in [{"perpetualErrorCode": private}, {"perpetualErrorCode": [private]}, None]:
            result = runner.action_progress("input", SimpleNamespace(error=private, metadata=metadata))
            self.assertEqual(result, {"type": "input", "status": "failed", "errorCode": "browser_action_failed"})
            self.assertNotIn(private, json.dumps(result))
        self.assertEqual(runner.action_progress("click", None), {"type": "click", "status": "failed", "errorCode": "action_result_missing"})
        self.assertEqual(runner.action_progress("input", SimpleNamespace(error=None, metadata={"perpetualErrorCode": private})), {"type": "input", "status": "passed"})

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
