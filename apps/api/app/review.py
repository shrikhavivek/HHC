"""Editorial gates shared by decisions and WordPress handoff."""
from datetime import date

ELIGIBLE_MATCHES = {"same_outfit_same_person", "same_outfit_other_celebrity", "same_item_same_person", "same_item_other_celebrity"}


def approval_errors(candidate) -> list[str]:
    checks = candidate.checks or {}
    errors = []
    if candidate.proposed_match_type not in ELIGIBLE_MATCHES:
        errors.append("This relationship is not an outfit-repeat match")
    if checks.get("same_photo") or checks.get("same_event") or checks.get("contradictions"):
        errors.append("Duplicate or contradictory evidence remains")
    if checks.get("identity") is not True or checks.get("chronology") is not True:
        errors.append("Verify garment identity and the earlier appearance date")
    if checks.get("editor_verified") is not True:
        errors.append("An editor must verify the visual details and source attribution")
    if not any(e.get("grade") in {"A", "B"} and str(e.get("url", "")).startswith("https://") for e in candidate.evidence or []):
        errors.append("Add a reliable source for the garment attribution")
    if candidate.rights_status in {"do_not_use", "blocked", "unknown_blocked"}:
        errors.append("Image usage is blocked")
    return errors


def earlier_date(previous: str | None, current: str | None) -> bool:
    try:
        return date.fromisoformat(previous or "") < date.fromisoformat(current or "")
    except ValueError:
        return False
