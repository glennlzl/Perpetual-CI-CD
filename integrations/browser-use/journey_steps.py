"""Business milestones a discovered journey proposes, with their independent milestone checks.

Discovery validates them as the controller does; approved Playwright code runs them and its fixture evaluates the checks.
"""

import re

TEXT_CHECKS = {"url-contains", "text-visible", "text-absent"}
CHECK_FIELDS = {**dict.fromkeys(TEXT_CHECKS, {"type", "value"}), "read-number": {"type", "label", "name"}, "compare-number": {"type", "label", "name", "op", "than"}}
OPERATORS = {"<", ">", "=", "!="}


def bounded(value, maximum):
    return isinstance(value, str) and bool(value.strip()) and len(value.encode("utf-16-le")) // 2 <= maximum and not re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value)


def capture_name(value):
    return isinstance(value, str) and re.fullmatch(r"[a-z][A-Za-z0-9]{0,39}", value) is not None


def milestone_checks(value, captured):
    if not isinstance(value, list) or len(value) > 6:
        raise ValueError("A journey step has at most 6 checks.")
    for check in value:
        kind = check.get("type") if isinstance(check, dict) else None
        if not isinstance(kind, str) or kind not in CHECK_FIELDS or set(check) != CHECK_FIELDS[kind]:
            raise ValueError("Milestone checks are url-contains, text-visible, text-absent, read-number or compare-number.")
        if kind in TEXT_CHECKS:
            valid = bounded(check["value"], 4000)
        else:
            valid = bounded(check["label"], 120) and capture_name(check["name"])
        if kind == "compare-number":
            # Only an earlier read-number capture can be compared, never a model claim.
            valid = valid and isinstance(check["op"], str) and check["op"] in OPERATORS and capture_name(check["than"]) and check["than"] in captured
        if not valid:
            raise ValueError("Milestone checks need a bounded value or label, valid names and an earlier read-number capture.")
        if kind == "read-number":
            captured.add(check["name"])
    return [dict(check) for check in value]


def validate_steps(value):
    if not isinstance(value, list) or len(value) > 12:
        raise ValueError("Provide at most 12 journey steps.")
    result, ids, captured = [], set(), set()
    for step in value:
        if not isinstance(step, dict) or not {"id", "title"} <= set(step) <= {"id", "title", "checks"}:
            raise ValueError("Journey steps contain only an ID, business milestone title and checks.")
        identifier, title = step["id"], step["title"]
        if not isinstance(identifier, str) or len(identifier) > 100 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", identifier) or identifier in ids:
            raise ValueError("Journey step IDs must be valid and unique within the case.")
        if not bounded(title, 240):
            raise ValueError("Journey step titles must contain 1–240 characters.")
        checks = milestone_checks(step["checks"], captured) if "checks" in step else []
        ids.add(identifier)
        result.append({"id": identifier, "title": title.strip(), **({"checks": checks} if checks else {})})
    return result
