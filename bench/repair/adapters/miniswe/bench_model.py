"""mini-swe-agent's OpenRouter model, pointed at the bench's model gateway.

BenchModel is mini's OpenRouterModel with its request unchanged (the model id, the messages as mini keeps them with
their reasoning details, its one bash tool, usage included, no stream) and its cost read from OpenRouter's usage, as
mini does. It differs in what the bench must control:
- the endpoint is the gateway's chat completions URL and the key is the attempt's token, never OPENROUTER_API_KEY;
- the connection ignores the host's proxy settings and .netrc, so nothing but the gateway is ever reached;
- a request may take 600 s instead of mini's hard-coded 60 s, so a long generation is not cut off and paid for again;
- only what a retry can change is retried (the product's AI SDK loop retries the same: timeouts, 408, 409, 429, 5xx),
  so a gateway refusal (402) or a rejected request (another 4xx, such as an outgrown context window) ends the attempt
  at once; the number of tries is MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT, set by the adapter;
- a cost of zero is kept rather than fatal, and a bring-your-own-key request adds its upstream inference cost, as the
  gateway and the product count it; mini's cost_limit then stops on the same dollars the gateway caps.
"""

import json
import math
from typing import Any

import requests
from minisweagent.models.openrouter_model import (
    OpenRouterAPIError,
    OpenRouterAuthenticationError,
    OpenRouterModel,
    OpenRouterRateLimitError,
)
from minisweagent.models.utils.actions_toolcall import BASH_TOOL

RETRIED = {408, 409}


class BenchRefused(Exception):
    """The gateway refused the request (HTTP 402): the attempt's cap, the run's budget, its request limit or deadline."""


class BenchRejected(Exception):
    """The endpoint rejected the request itself (a 4xx other than 408, 409 and 429), which a retry cannot change."""


def dollars(value: object) -> float:
    return float(value) if type(value) in (int, float) and math.isfinite(value) and value > 0 else 0.0


class BenchModel(OpenRouterModel):
    abort_exceptions = [*OpenRouterModel.abort_exceptions, BenchRefused, BenchRejected]

    def __init__(self, *, base_url: str, token: str, request_timeout: float, **kwargs):
        super().__init__(**kwargs)
        self._api_url = f"{base_url.rstrip('/')}/chat/completions"
        self._api_key = token
        self._request_timeout = request_timeout

    def _query(self, messages: list[dict[str, str]], **kwargs):
        headers = {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}
        payload = {
            "model": self.config.model_name,
            "messages": messages,
            "tools": [BASH_TOOL],
            "usage": {"include": True},
            **(self.config.model_kwargs | kwargs),
        }
        # A fresh session per request, as mini's requests.post opens a fresh connection, without the host's proxies.
        with requests.Session() as session:
            session.trust_env = False
            try:
                response = session.post(self._api_url, headers=headers, data=json.dumps(payload), timeout=self._request_timeout)
            except requests.exceptions.RequestException as error:
                raise OpenRouterAPIError(f"Request failed: {error}") from error
        status, text = response.status_code, response.text[:2000]
        if status == 402:
            raise BenchRefused(f"HTTP 402: {text}")
        if status == 401:
            raise OpenRouterAuthenticationError(f"HTTP 401: {text}")
        if status == 429:
            raise OpenRouterRateLimitError(f"HTTP 429: {text}")
        if 400 <= status < 500 and status not in RETRIED:
            raise BenchRejected(f"HTTP {status}: {text}")
        if status >= 300:
            raise OpenRouterAPIError(f"HTTP {status}: {text}")
        try:
            body = response.json()
        except ValueError as error:
            raise OpenRouterAPIError(f"HTTP {status}: the response is not JSON.") from error
        choices = body.get("choices") if isinstance(body, dict) else None
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict) or not isinstance(choices[0].get("message"), dict):
            error = body.get("error") if isinstance(body, dict) else None
            detail = error.get("message") if isinstance(error, dict) else None
            raise OpenRouterAPIError(f"HTTP {status}: {detail if isinstance(detail, str) else 'the response has no message.'}")
        return body

    def _calculate_cost(self, response: dict[str, Any]) -> dict[str, float]:
        usage = response.get("usage") if isinstance(response.get("usage"), dict) else {}
        details = usage.get("cost_details") if isinstance(usage.get("cost_details"), dict) else {}
        return {"cost": dollars(usage.get("cost")) + dollars(details.get("upstream_inference_cost"))}
