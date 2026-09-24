"""Resolved model settings are validated locally; no provider requests."""

import importlib.util
import pathlib
import unittest
from unittest.mock import patch


class ResolvedModelSettingsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("browser_model_runner", pathlib.Path(__file__).with_name("runner.py"))
        cls.runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.runner)

    def test_worker_does_not_choose_a_provider_from_unresolved_environment(self):
        for values in [
            {"OPENROUTER_API_KEY": "fixture-only"},
            {"PERPETUAL_MODEL_API_KEY": "fixture-only", "PERPETUAL_MODEL": "fixture-chat"},
        ]:
            with self.subTest(values=list(values)), patch.dict("os.environ", values, clear=True):
                with self.assertRaises(ValueError):
                    self.runner.model_config()

    def test_resolved_custom_model_keeps_its_endpoint_and_only_jev_models_are_rejected(self):
        values = {"PERPETUAL_MODEL_API_KEY": "fixture-only", "PERPETUAL_MODEL": "custom/jevil-chat", "PERPETUAL_MODEL_BASE_URL": "https://models.example/v1"}
        with patch.dict("os.environ", values, clear=True):
            self.assertEqual(self.runner.model_config(), {"key": "fixture-only", "model": "custom/jevil-chat", "base": "https://models.example/v1"})
        for model in ["jev", "typesafe/jev-1"]:
            with self.subTest(model=model), patch.dict("os.environ", {**values, "PERPETUAL_MODEL": model}, clear=True):
                with self.assertRaisesRegex(ValueError, "chat model|decisions API"):
                    self.runner.model_config()


if __name__ == "__main__":
    unittest.main()
