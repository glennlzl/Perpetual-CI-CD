"""Validate resolved controller settings; provider selection belongs to Node."""

import os
import re
from urllib.parse import urlsplit


class ModelConfigurationError(ValueError):
    """A non-secret, actionable configuration diagnostic."""


def model_config(environ=None):
    values = os.environ if environ is None else environ
    key = values.get("PERPETUAL_MODEL_API_KEY", "")
    model = values.get("PERPETUAL_MODEL", "")
    base = values.get("PERPETUAL_MODEL_BASE_URL", "")
    if not isinstance(key, str) or not key.strip():
        raise ModelConfigurationError("Configure a model API key to use the browser agent.")
    if len(key) > 4096 or re.search(r"\s", key):
        raise ModelConfigurationError("Enter a valid model API key.")
    if not isinstance(model, str) or not model.strip() or len(model.encode("utf-16-le")) // 2 > 200 or re.search(r"[\s\x00-\x1f]", model):
        raise ModelConfigurationError("Enter a model ID.")
    if re.search(r"(?:^|/)jev(?:-|$)", model, re.I):
        raise ModelConfigurationError("Choose a chat model; Jev uses a separate decisions API.")
    try:
        if not isinstance(base, str) or len(base.encode("utf-16-le")) // 2 > 2048:
            raise ValueError()
        url = urlsplit(base)
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
            raise ValueError()
        url.port  # Invalid ports must not reach the provider client.
    except ValueError:
        raise ModelConfigurationError("Enter a valid model API URL without embedded credentials.") from None
    return {"key": key, "model": model, "base": base}
