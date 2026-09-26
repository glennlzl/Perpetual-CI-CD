"""The bench box as a mini-swe-agent environment, and the channel that reaches it.

mini runs on the host, but none of its commands do. BoxEnvironment is mini's own DockerEnvironment with the docker CLI
replaced by Bridge: each command goes to the Node adapter as a JSON line (fd 3), which runs it in the bench box through
the product's box.exec in /workspace, and its reply comes back as one JSON line (fd 4). Everything else stays mini's:
its config (mini.yaml's environment variables, `bash -lc`, the timeout), its output dict and its submission check. The
runner owns the box, so nothing is started or removed here, and the template variables describe the box rather than
this host, whose uname would tell the model to use macOS's `sed -i ''` in a Linux box. Every reply is validated, and a
malformed one ends the attempt.
"""

import json
from typing import Any, BinaryIO

from minisweagent.environments.docker import DockerEnvironment
from minisweagent.utils.serialize import recursive_merge

MAX_LINE = 16 * 1024 * 1024


class BridgeError(Exception):
    """The command channel to the bench runner failed; the attempt cannot go on."""


def check_reply(reply: object, expected: int) -> dict[str, Any]:
    """A reply to request `expected`: the command's output, exit code and whether it timed out, or why it could not run."""
    if not isinstance(reply, dict) or type(reply.get("id")) is not int or reply["id"] != expected:
        raise BridgeError("The bench runner answered another request.")
    if isinstance(reply.get("error"), str):
        return {"error": reply["error"]}
    output, code, timed_out = reply.get("output"), reply.get("returncode"), reply.get("timedOut")
    if not isinstance(output, str) or type(code) is not int or type(timed_out) is not bool:
        raise BridgeError("The bench runner sent a malformed reply.")
    return {"output": output, "returncode": code, "timedOut": timed_out}


class Bridge:
    """JSON lines to the Node adapter: requests out on one stream, exactly one reply per request back on the other."""

    def __init__(self, requests: BinaryIO, replies: BinaryIO):
        self._requests, self._replies, self._next = requests, replies, 0

    def send(self, message: dict[str, Any]) -> None:
        # ASCII JSON: a lone surrogate from the model's own JSON is escaped instead of failing to encode.
        try:
            self._requests.write(json.dumps(message).encode("ascii") + b"\n")
            self._requests.flush()
        except (OSError, ValueError) as error:
            raise BridgeError(f"The bench runner closed the command channel: {error}") from error

    def exec(self, command: str, *, timeout: int, env: dict[str, str], interpreter: list[str]) -> dict[str, Any]:
        self._next += 1
        self.send({"type": "exec", "id": self._next, "command": command, "timeout": timeout, "env": env, "interpreter": interpreter})
        try:
            line = self._replies.readline(MAX_LINE + 1)
        except (OSError, ValueError) as error:
            raise BridgeError(f"The bench runner closed the command channel: {error}") from error
        if not line:
            raise BridgeError("The bench runner closed the command channel.")
        if len(line) > MAX_LINE or not line.endswith(b"\n"):
            raise BridgeError("The bench runner sent an oversized reply.")
        try:
            reply = json.loads(line)
        except ValueError as error:
            raise BridgeError("The bench runner sent a malformed reply.") from error
        return check_reply(reply, self._next)


def failure(message: str, kind: str, output: str = "") -> dict[str, Any]:
    """A command that could not run, timed out or failed in the box, as DockerEnvironment reports its exceptions."""
    return {
        "output": output, "returncode": -1, "exception_info": f"An error occurred while executing the command: {message}",
        "extra": {"exception_type": kind, "exception": message},
    }


class BoxEnvironment(DockerEnvironment):
    """mini's DockerEnvironment over the bridge. cwd is the box's workspace: DefaultAgent never passes another."""

    def __init__(self, *, bridge: Bridge, uname: dict[str, str], **kwargs):
        self._bridge, self._uname = bridge, dict(uname)
        super().__init__(**kwargs)

    def _start_container(self):
        self.container_id = "bench-box"

    def cleanup(self):
        pass

    def execute(self, action: dict, cwd: str = "", *, timeout: int | None = None) -> dict[str, Any]:
        command, seconds = action.get("command", ""), timeout or self.config.timeout
        if not isinstance(command, str):
            output = failure("The command must be a string.", "TypeError")
        else:
            reply = self._bridge.exec(command, timeout=seconds, env=dict(self.config.env), interpreter=list(self.config.interpreter))
            if "error" in reply:
                output = failure(reply["error"], "BoxError")
            elif reply["timedOut"]:
                output = failure(f"Command timed out after {seconds} seconds", "TimeoutExpired", reply["output"])
            else:
                output = {"output": reply["output"], "returncode": reply["returncode"], "exception_info": ""}
        self._check_finished(output)
        return output

    def get_template_vars(self, **kwargs) -> dict[str, Any]:
        return recursive_merge(self.config.model_dump(), self._uname, kwargs)
