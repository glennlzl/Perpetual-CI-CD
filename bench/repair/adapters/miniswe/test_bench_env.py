"""mini's side of the adapter without Docker or a model: BoxEnvironment and Bridge against a fake channel, BenchModel
against a local HTTP stub in place of the gateway, and the driver's job, configuration and whole attempt.

Run from adapters/miniswe: uv run --frozen python -B -m unittest -v test_bench_env
"""

import http.server
import io
import json
import os
import tempfile
import threading
import unittest

# mini reads these: no banner, a global config folder (and .env) of the test's own, and one try per request unless a
# test asks for more.
os.environ["MSWEA_SILENT_STARTUP"] = "1"
os.environ["MSWEA_GLOBAL_CONFIG_DIR"] = tempfile.mkdtemp(prefix="bench-miniswe-config-")
os.environ["MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT"] = "1"
os.environ.pop("OPENROUTER_API_KEY", None)

import yaml  # noqa: E402
from jinja2 import StrictUndefined, Template  # noqa: E402
from minisweagent.config import builtin_config_dir  # noqa: E402
from minisweagent.exceptions import Submitted  # noqa: E402
from minisweagent.models.openrouter_model import OpenRouterAPIError  # noqa: E402

import driver  # noqa: E402
from bench_env import BoxEnvironment, Bridge, BridgeError  # noqa: E402
from bench_model import BenchModel, BenchRefused, BenchRejected  # noqa: E402

MINI = yaml.safe_load((builtin_config_dir / "mini.yaml").read_text(encoding="utf-8"))
BOX = {"system": "Linux", "node": "box", "release": "6.10.14-linuxkit", "version": "#1 SMP PREEMPT", "machine": "aarch64", "processor": ""}
MARKER = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"


class FakeBridge:
    """Answers each command with the next scripted reply and records what was asked."""

    def __init__(self, *replies: dict):
        self.replies, self.calls = list(replies), []

    def exec(self, command, *, timeout, env, interpreter):
        self.calls.append({"command": command, "timeout": timeout, "env": env, "interpreter": interpreter})
        return self.replies.pop(0)


def box_environment(bridge) -> BoxEnvironment:
    return BoxEnvironment(bridge=bridge, uname=BOX, image="node:22-bookworm", cwd="/workspace", timeout=300, env=MINI["environment"]["env"])


def completion(command: str | None = None, cost=0.01, upstream=None):
    message = {"role": "assistant", "content": "Working on it."}
    if command is not None:
        message["tool_calls"] = [{"id": "call_1", "type": "function", "function": {"name": "bash", "arguments": json.dumps({"command": command})}}]
    usage = {"prompt_tokens": 100, "completion_tokens": 10, "cost": cost, "cost_details": {"upstream_inference_cost": upstream}}
    return 200, {"id": "gen-1", "choices": [{"index": 0, "finish_reason": "tool_calls" if command else "stop", "message": message}], "usage": usage}


class Upstream:
    """A local stand-in for the gateway: scripted (status, body) replies, and every request it saw."""

    def __init__(self, *replies):
        self.replies, self.seen = list(replies), []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                outer.seen.append({"path": self.path, "authorization": self.headers.get("Authorization"), "body": json.loads(body)})
                status, payload = outer.replies.pop(0) if outer.replies else (500, {"error": {"message": "No reply scripted."}})
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class BoxEnvironmentTest(unittest.TestCase):
    def test_the_marker_line_with_exit_zero_submits_what_follows(self):
        env = box_environment(FakeBridge({"output": f"{MARKER}\nFixed the tier boundary.\n", "returncode": 0, "timedOut": False}))
        with self.assertRaises(Submitted) as raised:
            env.execute({"command": f"echo {MARKER} && echo 'Fixed the tier boundary.'"})
        self.assertEqual(raised.exception.messages[0]["extra"], {"exit_status": "Submitted", "submission": "Fixed the tier boundary.\n"})

    def test_a_failed_or_later_marker_is_not_a_submission(self):
        env = box_environment(FakeBridge(
            {"output": f"{MARKER}\n", "returncode": 1, "timedOut": False},
            {"output": f"npm test\n{MARKER}\n", "returncode": 0, "timedOut": False},
        ))
        self.assertEqual(env.execute({"command": "false"})["returncode"], 1)
        self.assertEqual(env.execute({"command": "true"})["exception_info"], "")

    def test_commands_carry_mini_yaml_variables_bash_lc_and_the_timeout(self):
        bridge = FakeBridge({"output": "ok\n", "returncode": 0, "timedOut": False})
        self.assertEqual(box_environment(bridge).execute({"command": "npm test"}), {"output": "ok\n", "returncode": 0, "exception_info": ""})
        self.assertEqual(bridge.calls, [{"command": "npm test", "timeout": 300, "env": MINI["environment"]["env"], "interpreter": ["bash", "-lc"]}])
        self.assertEqual(MINI["environment"]["env"]["PAGER"], "cat")

    def test_timeouts_box_errors_and_non_string_commands_are_exceptions(self):
        bridge = FakeBridge({"output": "partial\n", "returncode": 124, "timedOut": True}, {"error": "The command contains a NUL byte."})
        env = box_environment(bridge)
        timed_out = env.execute({"command": "sleep 999"}, timeout=5)
        self.assertEqual([timed_out["output"], timed_out["returncode"], timed_out["extra"]["exception_type"]], ["partial\n", -1, "TimeoutExpired"])
        self.assertIn("timed out after 5 seconds", timed_out["exception_info"])
        self.assertEqual(env.execute({"command": "x"})["extra"]["exception_type"], "BoxError")
        self.assertEqual(env.execute({"command": ["ls"]})["extra"]["exception_type"], "TypeError")
        self.assertEqual(len(bridge.calls), 2)

    def test_the_templates_describe_the_box_not_this_host(self):
        variables = box_environment(FakeBridge()).get_template_vars()
        self.assertEqual([variables["system"], variables["machine"], variables["cwd"]], ["Linux", "aarch64", "/workspace"])
        rendered = Template(MINI["agent"]["instance_template"], undefined=StrictUndefined).render(task="Fix it.", **variables)
        self.assertIn("Linux 6.10.14-linuxkit #1 SMP PREEMPT aarch64", rendered)
        self.assertNotIn("MacOS", rendered)


class BridgeTest(unittest.TestCase):
    def test_a_request_and_its_reply_are_one_json_line_each(self):
        requests, replies = io.BytesIO(), io.BytesIO(b'{"id": 1, "output": "ok\\n", "returncode": 0, "timedOut": false}\n')
        reply = Bridge(requests, replies).exec("ls", timeout=300, env={"PAGER": "cat"}, interpreter=["bash", "-lc"])
        self.assertEqual(reply, {"output": "ok\n", "returncode": 0, "timedOut": False})
        self.assertEqual(json.loads(requests.getvalue()), {"type": "exec", "id": 1, "command": "ls", "timeout": 300, "env": {"PAGER": "cat"}, "interpreter": ["bash", "-lc"]})

    def test_anything_but_the_expected_reply_fails_closed(self):
        for raw in [
            b"", b"not json\n", b'{"id": 2, "output": "", "returncode": 0, "timedOut": false}\n',
            b'{"id": true, "output": "", "returncode": 0, "timedOut": false}\n', b'{"id": 1, "output": 1, "returncode": 0, "timedOut": false}\n',
            b'{"id": 1, "output": "", "returncode": "0", "timedOut": false}\n', b'{"id": 1, "output": "", "returncode": 0}\n', b"[1]\n",
        ]:
            with self.subTest(raw=raw), self.assertRaises(BridgeError):
                Bridge(io.BytesIO(), io.BytesIO(raw)).exec("ls", timeout=1, env={}, interpreter=["bash", "-lc"])
        self.assertEqual(Bridge(io.BytesIO(), io.BytesIO(b'{"id": 1, "error": "gone"}\n')).exec("ls", timeout=1, env={}, interpreter=["bash"]), {"error": "gone"})


class BenchModelTest(unittest.TestCase):
    def model(self, upstream: Upstream) -> BenchModel:
        config = {key: value for key, value in MINI["model"].items() if key != "model_kwargs"}
        return BenchModel(base_url=upstream.url, token="attempt-token", request_timeout=30, model_name="fake/coder", cost_tracking="ignore_errors", **config)

    def test_requests_reach_the_gateway_with_the_token_and_mini_s_own_body(self):
        upstream = Upstream(completion("ls -la", cost=0.01, upstream=0.002))
        self.addCleanup(upstream.close)
        message = self.model(upstream).query([{"role": "system", "content": "System."}, {"role": "user", "content": "Task."}])
        self.assertEqual([action["command"] for action in message["extra"]["actions"]], ["ls -la"])
        self.assertAlmostEqual(message["extra"]["cost"], 0.012)
        [seen] = upstream.seen
        self.assertEqual([seen["path"], seen["authorization"]], ["/api/v1/chat/completions", "Bearer attempt-token"])
        self.assertEqual(seen["body"]["model"], "fake/coder")
        self.assertEqual([tool["function"]["name"] for tool in seen["body"]["tools"]], ["bash"])
        self.assertEqual(seen["body"]["usage"], {"include": True})
        self.assertNotIn("drop_params", seen["body"])
        self.assertNotIn("stream", seen["body"])

    def test_a_gateway_refusal_or_a_rejected_request_is_never_retried(self):
        os.environ["MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT"] = "3"
        self.addCleanup(os.environ.__setitem__, "MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT", "1")
        for status, error in [(402, BenchRefused), (400, BenchRejected)]:
            upstream = Upstream((status, {"error": {"code": status, "message": "Bench limit: the attempt reached its cost cap."}}), completion("ls"))
            self.addCleanup(upstream.close)
            with self.subTest(status=status), self.assertRaises(error) as raised:
                self.model(upstream).query([{"role": "user", "content": "Task."}])
            self.assertIn(f"HTTP {status}", str(raised.exception))
            self.assertEqual(len(upstream.seen), 1)

    def test_an_error_body_is_a_provider_error_and_a_zero_cost_is_kept(self):
        upstream = Upstream((200, {"error": {"message": "Provider returned error"}}), completion("ls", cost=0))
        self.addCleanup(upstream.close)
        model = self.model(upstream)
        with self.assertRaisesRegex(OpenRouterAPIError, "Provider returned error"):
            model.query([{"role": "user", "content": "Task."}])
        self.assertEqual(model.query([{"role": "user", "content": "Task."}])["extra"]["cost"], 0.0)


def job(**changes):
    base = {
        "baseUrl": "http://127.0.0.1:9/api/v1", "token": "attempt-token", "model": "fake/coder", "instructions": "Fix it. {{ not a template }}",
        "prompt": "Repository acme/app. Fix the build.", "image": "node:22-bookworm", "root": "/workspace", "uname": BOX,
        "trajectory": os.path.join(tempfile.mkdtemp(prefix="bench-miniswe-"), "trajectory.json"),
        "stepLimit": 100, "costLimit": 0.5, "wallSeconds": 900, "commandSeconds": 300, "requestSeconds": 600,
    }
    return json.dumps(base | changes).encode()


class DriverTest(unittest.TestCase):
    def test_the_job_is_checked_field_by_field(self):
        self.assertEqual(driver.read_job(job())["stepLimit"], 100)
        for changes in [{"token": ""}, {"token": "a b"}, {"baseUrl": "file:///etc"}, {"stepLimit": True}, {"costLimit": 0}, {"uname": []}, {"prompt": None}]:
            with self.subTest(changes=changes), self.assertRaises(driver.JobError):
                driver.read_job(job(**changes))
        with self.assertRaises(driver.JobError):
            driver.read_job(b"[]")

    def test_mini_yaml_runs_with_instructions_appended_verbatim_and_the_attempt_s_limits(self):
        agent, model, environment = driver.configure(driver.read_job(job()), MINI)
        system = Template(agent["system_template"], undefined=StrictUndefined).render(bench_instructions="Fix it. {{ not a template }}")
        self.assertEqual(system, f"{MINI['agent']['system_template'].rstrip()}\n\nFix it. {{{{ not a template }}}}")
        self.assertEqual(agent["instance_template"], MINI["agent"]["instance_template"])
        self.assertEqual([agent["step_limit"], agent["cost_limit"], agent["wall_time_limit_seconds"]], [100, 0.5, 900])
        self.assertNotIn("mode", agent)
        self.assertNotIn("model_kwargs", model)
        self.assertEqual([model["model_class"], model["model_name"], model["token"]], ["bench_model.BenchModel", "fake/coder", "attempt-token"])
        self.assertEqual(environment, {"image": "node:22-bookworm", "cwd": "/workspace", "timeout": 300, "env": MINI["environment"]["env"]})

    def test_a_whole_attempt_reproduces_and_submits_through_the_bridge(self):
        upstream = Upstream(completion("npm test"), completion(f"echo {MARKER} && echo 'Fixed it.'"))
        self.addCleanup(upstream.close)
        bridge = FakeBridge({"output": "# fail 1\n", "returncode": 1, "timedOut": False}, {"output": f"{MARKER}\nFixed it.\n", "returncode": 0, "timedOut": False})
        result = driver.run_attempt(driver.read_job(job(baseUrl=upstream.url)), bridge)
        self.assertEqual(result, {"exitStatus": "Submitted", "submission": "Fixed it.\n", "steps": 2, "cost": 0.02})
        self.assertEqual([call["command"] for call in bridge.calls], ["npm test", f"echo {MARKER} && echo 'Fixed it.'"])
        first = upstream.seen[0]["body"]["messages"]
        self.assertEqual([message["role"] for message in first], ["system", "user"])
        self.assertTrue(first[0]["content"].endswith("\n\nFix it. {{ not a template }}"))
        self.assertIn("Please solve this issue: Repository acme/app. Fix the build.", first[1]["content"])

    def test_a_refusal_ends_the_attempt_as_a_provider_error(self):
        upstream = Upstream((402, {"error": {"code": 402, "message": "Bench limit: the attempt reached its cost cap."}}))
        self.addCleanup(upstream.close)
        result = driver.run_attempt(driver.read_job(job(baseUrl=upstream.url)), FakeBridge())
        self.assertEqual([result["exitStatus"], result["errorKind"], result["steps"]], ["BenchRefused", "provider", 1])
        self.assertIn("cost cap", result["error"])


if __name__ == "__main__":
    unittest.main()
