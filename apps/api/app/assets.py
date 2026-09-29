from __future__ import annotations

from typing import Any, Iterable, Sequence


VALID_ASSET_ROLES = {"current_angle", "designer_reference", "editor_upload"}
BLOCKED_RIGHTS_STATUSES = {"do_not_use", "blocked", "unknown_blocked"}
CURRENT_MATCHER_VERSION = 2


def normalize_case_assets(case: Any) -> list[dict[str, Any]]:
    """Return safe, predictable supplementary asset records from extraction JSON."""
    extraction = case.extraction if isinstance(case.extraction, dict) else {}
    raw_assets = extraction.get("collage_assets", [])
    if not isinstance(raw_assets, list):
        return []

    assets: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_assets):
        if not isinstance(raw, dict) or raw.get("role") not in VALID_ASSET_ROLES:
            continue
        role = raw["role"]
        image_path = str(raw.get("image_path") or "").strip()
        source_url = str(raw.get("source_url") or "").strip()
        if not image_path or (not source_url and role != "editor_upload"):
            continue
        default_label = {
            "designer_reference": "Official designer reference",
            "editor_upload": "Editor-supplied image",
            "current_angle": "Current appearance angle",
        }[role]
        assets.append(
            {
                "id": str(raw.get("id") or f"{case.id}-{role}-{index + 1}"),
                "role": role,
                "label": str(raw.get("label") or default_label),
                "person": str(raw.get("person") or case.celebrity),
                "designer": str(raw.get("designer") or case.designer),
                "image_path": image_path,
                "source_url": source_url,
                "publisher": str(raw.get("publisher") or "Source pending"),
                "credit": str(raw.get("credit") or raw.get("publisher") or "Credit pending"),
                "retrieved_at": raw.get("retrieved_at"),
                "rights_status": str(raw.get("rights_status") or "editorial_review_required"),
                "source_grade": str(raw.get("source_grade") or ("A" if role == "designer_reference" else "D" if role == "editor_upload" else "B")),
                "official_source": bool(raw.get("official_source", False)),
                "verified_source": bool(raw.get("verified_source", raw.get("official_source", False))),
                "source_kind": str(raw.get("source_kind") or ("editor_upload" if role == "editor_upload" else "official_designer_product" if raw.get("official_source") else "reddit_source")),
                "image_source_url": str(raw.get("image_source_url") or ""),
                "exact_match": bool(raw.get("exact_match", False)),
                "include_in_collage": bool(raw.get("include_in_collage", False)),
                "fallback_only": bool(raw.get("fallback_only", role == "current_angle")),
                "notes": str(raw.get("notes") or ""),
            }
        )
    return assets


def _latest_approved(candidate: Any) -> bool:
    decisions = list(getattr(candidate, "decisions", []) or [])
    if not decisions:
        return False
    latest = max(decisions, key=lambda item: item.decided_at)
    return latest.decision == "approved"


def _eligible_candidate(candidate: Any, include_automation_matches: bool) -> bool:
    if getattr(candidate, "rights_status", "") in BLOCKED_RIGHTS_STATUSES:
        return False
    if _latest_approved(candidate):
        return True
    if not include_automation_matches or getattr(candidate, "status", "") != "automation_selected":
        return False
    checks = getattr(candidate, "checks", {})
    automation = checks.get("automation", {}) if isinstance(checks, dict) else {}
    return automation.get("matcher_version") == CURRENT_MATCHER_VERSION


def build_panel_catalog(
    case: Any,
    candidates: Iterable[Any],
    *,
    include_automation_matches: bool = False,
) -> list[dict[str, Any]]:
    """Return every source-backed panel an editor may place in the collage.

    Human-created bundles require approved candidates. Automated drafts may use
    only candidates selected by the current bounded matcher. Blocked assets are
    never exposed to the editor or renderer.
    """
    approved_candidates = [
        candidate
        for candidate in candidates
        if _eligible_candidate(candidate, include_automation_matches)
    ]
    same_person: list[Any] = []
    other_people: list[Any] = []
    for candidate in approved_candidates:
        if candidate.person.strip().casefold() == case.celebrity.strip().casefold():
            same_person.append(candidate)
        else:
            other_people.append(candidate)

    supplementary = normalize_case_assets(case)
    current_angles = [
        item for item in supplementary
        if item["role"] == "current_angle"
        and item["include_in_collage"]
        and item["exact_match"]
        and item["rights_status"] not in BLOCKED_RIGHTS_STATUSES
    ]
    designer_references = [
        item for item in supplementary
        if item["role"] == "designer_reference"
        and item["include_in_collage"]
        and item["exact_match"]
        and item["verified_source"]
        and item["rights_status"] not in BLOCKED_RIGHTS_STATUSES
    ]
    editor_uploads = [
        item for item in supplementary
        if item["role"] == "editor_upload"
        and item["include_in_collage"]
        and item["rights_status"] not in BLOCKED_RIGHTS_STATUSES
    ]

    panels: list[dict[str, Any]] = [
        {
            "id": "current-primary",
            "role": "current_primary",
            "label": "Current post / primary image",
            "person": case.celebrity,
            "designer": case.designer,
            "event": case.event_name,
            "date": case.event_date,
            "image_path": case.base_image,
            "source_url": case.permalink,
            "publisher": "r/BollywoodFashion source",
            "credit": "Original publisher/photographer credit requires editorial confirmation",
            "retrieved_at": None,
            "rights_status": "editorial_review_required",
            "source_grade": "D",
        }
    ]

    # Every usable photo from this Reddit post is available to the editor.
    for asset in current_angles:
        panels.append({**asset, "event": case.event_name, "date": case.event_date})

    for candidate in [*same_person, *other_people]:
        panels.append(
            {
                "id": candidate.id,
                "role": "historical_same_person" if candidate in same_person else "historical_other_person",
                "label": "Earlier wear" if candidate in same_person else "Previously seen on",
                "person": candidate.person,
                "designer": candidate.designer,
                "event": candidate.event_name,
                "date": candidate.event_date,
                "image_path": candidate.image_path,
                "source_url": next((item.get("url") for item in candidate.evidence if item.get("url")), ""),
                "publisher": next((item.get("publisher") for item in candidate.evidence if item.get("publisher")), "Archive source"),
                "credit": next((item.get("credit") for item in candidate.evidence if item.get("credit")), "Credit requires editorial confirmation"),
                "retrieved_at": next((item.get("retrieved_at") for item in candidate.evidence if item.get("retrieved_at")), None),
                "rights_status": candidate.rights_status,
                "source_grade": candidate.source_grade,
            }
        )

    for asset in designer_references:
        panels.append({**asset, "event": "Original designer / product look", "date": None})

    # Uploads are opt-in: available in the editor catalog, never added to an
    # automatic collage until an editor explicitly selects one.
    for asset in editor_uploads:
        panels.append({**asset, "event": "Editor-supplied reference", "date": None})

    return panels


def default_panel_ids(panels: Sequence[dict[str, Any]]) -> list[str]:
    """Choose the honest automatic treatment from an editor panel catalog."""
    current = [item for item in panels if item["role"] in {"current_primary", "current_angle"}]
    historical = [item for item in panels if item["role"].startswith("historical_")]
    references = [item for item in panels if item["role"] == "designer_reference"]
    selected = [*current, *historical]
    if not historical and references:
        selected.append(references[0])
    return [str(item["id"]) for item in selected]


def build_render_assets(
    case: Any,
    candidates: Iterable[Any],
    *,
    include_automation_matches: bool = False,
    panel_ids: Sequence[str] | None = None,
) -> list[dict[str, Any]]:
    """Build an ordered render list, optionally using a saved editor layout."""
    panels = build_panel_catalog(
        case,
        candidates,
        include_automation_matches=include_automation_matches,
    )
    requested = list(panel_ids) if panel_ids is not None else default_panel_ids(panels)
    by_id = {str(item["id"]): item for item in panels}
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    for panel_id in requested:
        if panel_id in seen or panel_id not in by_id:
            continue
        seen.add(panel_id)
        selected.append(by_id[panel_id])

    # Never truncate a gallery: all panels are rendered into one output image.
    return selected
