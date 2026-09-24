"""Approved business milestones, their recorded progress and independent milestone checks."""

from decimal import Decimal
import re

from case_results import observation_text

TEXT_CHECKS = {"url-contains", "text-visible", "text-absent"}
CHECK_FIELDS = {**dict.fromkeys(TEXT_CHECKS, {"type", "value"}), "read-number": {"type", "label", "name"}, "compare-number": {"type", "label", "name", "op", "than"}}
OPERATORS = {"<": lambda value, than: value < than, ">": lambda value, than: value > than, "=": lambda value, than: value == than, "!=": lambda value, than: value != than}
# A sign or currency symbol must touch its digits, so "Credits - 120" reads 120.
NUMBER = re.compile(r"(?<![\d.,])([-−]?)(?:[$€£]\s?)?(\d{1,3}(?:,\d{3})+(?![\d,])|\d+)(\.\d+)?")


class CheckUnavailable(Exception):
    """A fixed, page-free reason why an independent milestone check could not run."""


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


def number_after(text, label, adjacent=False):
    """Return (value, gap) for the first number after a visible label: 1,240, 1240.5, -3 or $12.00.

    adjacent: only separators may sit between them, so an ancestor's sibling text is never read.
    """
    text, label = " ".join(text.split()), " ".join(label.split())
    found = re.search(re.escape(label), text, re.IGNORECASE) if label else None
    match = NUMBER.search(text, found.end()) if found else None
    if not match or adjacent and re.search(r"[^\W_]", text[found.end():match.start()]):
        return None
    sign, whole, fraction = match.groups()
    return Decimal(("-" if sign else "") + whole.replace(",", "") + (fraction or "")), match.start() - found.end()


def json_number(value):
    return int(value) if value == value.to_integral_value() else float(value)


class JourneyProgress:
    """The runner records each approved milestone in order; the agent's evidence never changes the plan or its checks. The controller owns the verdict."""

    def __init__(self, case, emit, page=None):
        self.case_id = case["id"]
        self.steps = validate_steps(case.get("steps", []))
        self.states = {step["id"]: "pending" for step in self.steps}
        self.captures = {}
        self.emit = emit
        self.page = page

    def current(self):
        return next((step for step in self.steps if self.states[step["id"]] != "completed"), None)

    async def report(self, step_id, status, evidence=None):
        """Start the current milestone (running), then end it completed, which runs its checks, or blocked, with the agent's evidence."""
        step = self.current()
        if step is None or step["id"] != step_id or status not in {"running", "completed", "blocked"} or self.states[step_id] != ("pending" if status == "running" else "running"):
            raise ValueError("Milestones run in the approved order: running, then completed or blocked; nothing follows a blocked or failed one.")
        if status == "running":
            return self.record(step_id, "running")
        if not bounded(evidence, 2000):
            raise ValueError("Report concrete evidence using 1–2000 characters.")
        if status == "blocked":
            return self.record(step_id, "blocked", observation_text(evidence))
        checks = await self.evaluate(step.get("checks", []))
        return self.record(step_id, "completed" if all(check["passed"] for check in checks) else "failed", observation_text(evidence), checks)

    async def evaluate(self, checks):
        results = []
        for check in checks:
            result = {**check, "passed": False}
            try:
                if self.page is None:
                    raise CheckUnavailable("Independent milestone checks are unavailable.")
                if check["type"] in TEXT_CHECKS:
                    result["passed"] = await self.page.text_check(check) is True
                else:
                    value = await self.page.read_number(check["label"])
                    if value is None:
                        raise CheckUnavailable("No number follows this label on the current page.")
                    result["observed"] = json_number(value)
                    if check["type"] == "read-number":
                        self.captures[check["name"]] = value
                        result["passed"] = True
                    elif check["than"] not in self.captures:
                        raise CheckUnavailable("The earlier value was not captured.")
                    else:
                        result["passed"] = OPERATORS[check["op"]](value, self.captures[check["than"]])
            except CheckUnavailable as error:
                result["error"] = str(error)
            except Exception:
                # Browser errors can contain page text; keep only a fixed reason.
                result["error"] = "The current page could not be checked."
            results.append({**result, "provenance": "independent"})
        return results

    def record(self, step_id, status, evidence=None, checks=None):
        event = {"type": "journey-step", "caseId": self.case_id, "stepId": step_id, "status": status, **({"evidence": evidence} if evidence else {}), **({"checks": checks} if checks else {})}
        self.states[step_id] = status
        self.emit(event)
        return event
