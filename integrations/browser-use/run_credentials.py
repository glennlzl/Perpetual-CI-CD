"""Ephemeral test-account values, never part of a persisted business case."""

import copy
import re

ALIASES = {"username": "perpetual_test_username", "password": "perpetual_test_password"}
# Each value fills only its own kind of login field.
FIELD_TYPES = {"username": {"text", "email"}, "password": {"password"}}


def credential_field_error(name, same_origin, agent_tab, top_frame, tag, input_type):
    """One rule for every credential fill: the application's exact origin, the agent's tab, its top frame and a matching input."""
    if not same_origin:
        return "credential_origin_mismatch"
    if not agent_tab:
        return "credential_target_mismatch"
    if not top_frame:
        return "credential_frame_mismatch"
    if str(tag).lower() != "input" or str(input_type or "text").lower() not in FIELD_TYPES[name]:
        return "credential_field_type_mismatch"
    return None


def validate_credentials(raw, mode):
    if raw is None:
        return None
    if mode != "discover" or not isinstance(raw, dict) or set(raw) != set(ALIASES):
        raise ValueError("Test credentials are available only for discovery.")
    for name, maximum in [("username", 320), ("password", 1024)]:
        value = raw[name]
        if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\x00" in value:
            raise ValueError("Enter a valid test username and password.")
    return dict(raw)


def redact(text, credentials):
    """Account values in text the model receives, longest first, become [REDACTED]."""
    if not credentials:
        return text
    secrets = sorted(set(credentials.values()), key=len, reverse=True)
    return re.sub("|".join(re.escape(item) for item in secrets), "[REDACTED]", text)


def credential_alias(text):
    for name, alias in ALIASES.items():
        if text in (alias, f"<secret>{alias}</secret>"):
            return name
    return None


def contains_reference(value):
    if isinstance(value, str):
        return "<secret" in value.lower() or "</secret" in value.lower() or any(alias in value for alias in ALIASES.values())
    if isinstance(value, dict):
        return any(contains_reference(child) for child in value.values())
    if isinstance(value, (tuple, list)):
        return any(contains_reference(child) for child in value)
    return False


def redact_messages(messages, credentials):
    if not credentials:
        return messages
    messages = copy.deepcopy(messages)
    for message in messages:
        if isinstance(message.content, str):
            message.content = redact(message.content, credentials)
        elif isinstance(message.content, list):
            for part in message.content:
                if getattr(part, "type", None) != "text":
                    raise ValueError("Test-account runs cannot send browser images to the model.")
                part.text = redact(part.text, credentials)
    return messages
