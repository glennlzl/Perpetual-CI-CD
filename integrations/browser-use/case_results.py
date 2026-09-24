"""Bounded facts about one reviewed journey. The controller alone decides its status and message."""

import os
import re

BLOCKERS = {"account", "fixture", "integration", "permission", "environment"}


def observation_text(value):
    text = value.strip()
    for name in ("PERPETUAL_MODEL_API_KEY", "OPENROUTER_API_KEY"):
        secret = os.environ.get(name)
        if secret:
            text = text.replace(secret, "[REDACTED]")
    text = re.sub(r"\bBearer\s+\S+", "Bearer [REDACTED]", text, flags=re.IGNORECASE)
    text = re.sub(r"(https?://[^\s?#]+)[?#][^\s]*", r"\1", text)
    # 2000 UTF-16 code units, as the controller counts evidence; a split or lone surrogate is dropped.
    return text.encode("utf-16-le", "surrogatepass")[:4000].decode("utf-16-le", "ignore")


def observations(case, report):
    count = len(case.get("expectedOutcomes", []))
    received = report.get("outcomes") if isinstance(report, dict) else None
    if not count or count > 50 or not isinstance(received, list) or len(received) != count:
        return []
    seen = set()
    for item in received:
        if not isinstance(item, dict):
            return []
        index = item.get("outcomeIndex")
        if type(index) is not int or not 0 <= index < count or index in seen or item.get("status") not in {"satisfied", "failed", "uncertain"} or not isinstance(item.get("evidence"), str):
            return []
        seen.add(index)
    return sorted([{"outcomeIndex": item["outcomeIndex"], "status": item["status"], "evidence": observation_text(item["evidence"]), "provenance": "agent"} for item in received], key=lambda item: item["outcomeIndex"])


def blockers(case, report):
    """Agent-reported missing prerequisites: never a product failure or a pass."""
    received = report.get("blockers") if isinstance(report, dict) else None
    if not isinstance(received, list):
        return []
    steps = {step.get("id") for step in case.get("steps", []) if isinstance(step, dict)}
    result = []
    for item in received[:10]:
        if isinstance(item, dict) and isinstance(item.get("kind"), str) and item["kind"] in BLOCKERS and isinstance(item.get("evidence"), str) and item["evidence"].strip():
            step = {"stepId": item["stepId"]} if isinstance(item.get("stepId"), str) and item["stepId"] in steps else {}
            result.append({**step, "kind": item["kind"], "evidence": observation_text(item["evidence"])})
    return result


def journey_facts(case, stop_cause, report=None, checks=()):
    """stop_cause: none (the agent finished its report), deadline, forced (Browser Use forced a final report) or exception."""
    reported = blockers(case, report)
    return {"caseId": case["id"], "stopCause": stop_cause, "agentCompleted": isinstance(report, dict) and report.get("completed") is True, "outcomes": observations(case, report), "assertions": list(checks), **({"blockers": reported} if reported else {})}
