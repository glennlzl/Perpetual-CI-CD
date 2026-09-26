"""One mini-swe-agent attempt of the repair bake-off, started by index.ts as `.venv/bin/python driver.py` in the
attempt's scratch folder, with an environment of its own and two extra descriptors: commands out on fd 3, their
replies in on fd 4.

The job is one JSON object on stdin: the gateway's base URL and the attempt's token, the model id, the product's prompt,
INSTRUCTIONS with the harness note, the limits and the box's uname. It is validated before use, and the token goes
nowhere but the gateway's Authorization header. mini then runs as it ships: DefaultAgent with mini.yaml's templates,
INSTRUCTIONS appended to its system template as a template variable (so their text is never read as Jinja) and the
prompt as its task; its model built by mini's get_model as BenchModel, its OpenRouterModel on the gateway; its
environment BoxEnvironment, its DockerEnvironment over the bridge. The last line on fd 3 is the result: mini's exit
status and submission, its model calls and cost, and the error that ended it, if any.
"""

import json
import math
import os
import re
import sys
from pathlib import Path
from typing import Any

import yaml
from minisweagent import __version__
from minisweagent.agents.default import DefaultAgent
from minisweagent.config import builtin_config_dir
from minisweagent.models import get_model
from minisweagent.models.openrouter_model import OpenRouterAPIError, OpenRouterAuthenticationError, OpenRouterRateLimitError

from bench_env import BoxEnvironment, Bridge, BridgeError
from bench_model import BenchRefused, BenchRejected

MAX_JOB = 16 * 1024 * 1024
UNAME = ("system", "node", "release", "version", "machine", "processor")
# What the model endpoint answered: the attempt ends at `provider` (or `context`); anything else is `error`.
PROVIDER = (BenchRefused, BenchRejected, OpenRouterAPIError, OpenRouterAuthenticationError, OpenRouterRateLimitError)


class JobError(ValueError):
    """The job on stdin is not one the adapter builds."""


def read_job(raw: bytes) -> dict[str, Any]:
    """The job, each field checked; anything else is refused before mini starts."""
    if len(raw) > MAX_JOB:
        raise JobError("The job is too large.")
    try:
        job = json.loads(raw)
    except ValueError as error:
        raise JobError("The job is not JSON.") from error
    if not isinstance(job, dict):
        raise JobError("The job is not a JSON object.")

    def text(name: str, limit: int, pattern: str | None = None) -> str:
        value = job.get(name)
        if not isinstance(value, str) or not value or len(value) > limit or "\0" in value or (pattern and not re.fullmatch(pattern, value)):
            raise JobError(f"The job has no valid {name}.")
        return value

    def whole(name: str, most: int) -> int:
        value = job.get(name)
        if type(value) is not int or not 1 <= value <= most:
            raise JobError(f"The job has no valid {name}.")
        return value

    cost, uname = job.get("costLimit"), job.get("uname")
    if type(cost) not in (int, float) or not math.isfinite(cost) or cost <= 0:
        raise JobError("The job has no valid costLimit.")
    if not isinstance(uname, dict) or any(not isinstance(uname.get(key, ""), str) or len(uname.get(key, "")) > 1000 for key in UNAME):
        raise JobError("The job has no valid uname.")
    return {
        "baseUrl": text("baseUrl", 2048, r"https?://[^\s/?#]+(?:/[^\s?#]*)?"), "token": text("token", 1000, r"[\x21-\x7e]+"),
        "model": text("model", 200), "instructions": text("instructions", MAX_JOB), "prompt": text("prompt", MAX_JOB),
        "image": text("image", 200), "root": text("root", 1024, r"/\S*"), "trajectory": text("trajectory", 4096),
        "stepLimit": whole("stepLimit", 100_000), "costLimit": float(cost), "wallSeconds": whole("wallSeconds", 86_400),
        "commandSeconds": whole("commandSeconds", 86_400), "requestSeconds": whole("requestSeconds", 86_400),
        "uname": {key: uname.get(key, "") for key in UNAME},
    }


def configure(job: dict[str, Any], mini: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """mini.yaml's agent, model and environment settings, with the attempt's inputs and limits."""
    agent = {key: value for key, value in mini["agent"].items() if key != "mode"}  # mode is InteractiveAgent's
    agent["system_template"] = agent["system_template"].rstrip() + "\n\n{{ bench_instructions }}\n"
    agent |= {
        "step_limit": job["stepLimit"], "cost_limit": job["costLimit"], "wall_time_limit_seconds": job["wallSeconds"],
        "output_path": Path(job["trajectory"]),
    }
    # model_kwargs holds drop_params, a LiteLLM switch that OpenRouterModel would send upstream as a body field.
    model = {key: value for key, value in mini["model"].items() if key != "model_kwargs"}
    model |= {
        "model_class": "bench_model.BenchModel", "model_name": job["model"], "cost_tracking": "ignore_errors",
        "base_url": job["baseUrl"], "token": job["token"], "request_timeout": job["requestSeconds"],
    }
    environment = {"image": job["image"], "cwd": job["root"], "timeout": job["commandSeconds"], "env": dict(mini.get("environment", {}).get("env", {}))}
    return agent, model, environment


def failed(error: BaseException, status: str) -> dict[str, Any]:
    kind = "provider" if isinstance(error, PROVIDER) else "bridge" if isinstance(error, BridgeError) else "error"
    return {"exitStatus": status, "errorKind": kind, "error": (str(error) or type(error).__name__)[:4000]}


def run_attempt(job: dict[str, Any], bridge: Bridge) -> dict[str, Any]:
    """mini's DefaultAgent on the job; returns the result the adapter reads."""
    mini = yaml.safe_load((builtin_config_dir / "mini.yaml").read_text(encoding="utf-8"))
    agent_config, model_config, environment_config = configure(job, mini)
    agent = DefaultAgent(get_model(config=model_config), BoxEnvironment(bridge=bridge, uname=job["uname"], **environment_config), **agent_config)
    try:
        info = agent.run(job["prompt"], bench_instructions=job["instructions"])
        result = {"exitStatus": str(info.get("exit_status") or ""), "submission": str(info.get("submission") or "")}
    except Exception as error:  # DefaultAgent records it as its exit message, then raises it again
        result = {"submission": "", **failed(error, type(error).__name__)}
    return {**result, "steps": agent.n_calls, "cost": agent.cost}


def main() -> int:
    # Buffered and blocking, so every line is written whole (Bridge flushes each) and every reply is waited for.
    for descriptor in (3, 4):
        os.set_blocking(descriptor, True)
    bridge = Bridge(os.fdopen(3, "wb"), os.fdopen(4, "rb"))
    try:
        result = run_attempt(read_job(sys.stdin.buffer.read(MAX_JOB + 1)), bridge)
    except Exception as error:
        result = {"submission": "", "steps": 0, "cost": 0.0, **failed(error, "BenchError")}
    try:
        bridge.send({"type": "result", "version": __version__, **result})
    except BridgeError:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
