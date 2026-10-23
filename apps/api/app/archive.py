"""Text archive, verified-look references and closed-edition retention.

Source images and collage renders are kept only while a case is on the desk.
Once its edition closes, the case keeps a text archive entry (keywords, outfit
signature and an image fingerprint) so it can still be matched. Approved or
sent looks also keep one compressed reference image so they can be shown.
"""
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from PIL import Image, ImageOps
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from .automation import _local_media_path, _outfit_signature, _tokens, image_fingerprint
from .edition_window import in_current_edition
from .models import ArchiveEntry, AuditEvent, Case, StoryDraft

REFERENCE_DIR = "reference"
REFERENCE_EDGE = 1080
SENT_STATES = {"draft_created", "managed_in_wordpress"}
IN_FLIGHT_STATES = {"sending", "uncertain"}


def _now(now: datetime | None) -> datetime:
    return now or datetime.now(timezone.utc)


def _aware(stamp: datetime | None) -> datetime | None:
    if stamp is None:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def record_archive_entry(db: Session, case: Case, media_dir: str, entry: ArchiveEntry | None = None) -> ArchiveEntry:
    """Capture the text needed to match this case once its images are gone."""
    entry = entry or db.get(ArchiveEntry, case.id)
    if entry is None:
        entry = ArchiveEntry(case_id=case.id, permalink=case.permalink)
        db.add(entry)
    entry.permalink = case.permalink
    entry.keywords = sorted(_tokens(case))
    entry.signature = {key: sorted(values) for key, values in _outfit_signature(case.source_title, case.source_body or "").items()}
    if not entry.fingerprint:
        entry.fingerprint = image_fingerprint(case.base_image, media_dir)
    return entry


def save_reference_image(db: Session, case: Case, image_path: str, media_dir: str) -> str | None:
    """Keep one compressed photo of a verified look for future collages."""
    source = _local_media_path(image_path, media_dir)
    if source is None:
        return None
    target_dir = Path(media_dir) / REFERENCE_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{case.id}.webp"
    try:
        with Image.open(source) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
        image.thumbnail((REFERENCE_EDGE, REFERENCE_EDGE), Image.Resampling.LANCZOS)
        image.save(target, "WEBP", quality=80, method=6)
        image.close()
    except (OSError, ValueError, Image.DecompressionBombError):
        return None
    entry = record_archive_entry(db, case, media_dir)
    entry.reference_image = f"/media-files/{REFERENCE_DIR}/{target.name}"
    return entry.reference_image


def keep_verified_look(db: Session, case: Case, media_dir: str, candidate=None) -> None:
    """On approval, keep the current look and the earlier look it matched."""
    save_reference_image(db, case, case.base_image, media_dir)
    if candidate is None:
        return
    url = next((item.get("url") for item in candidate.evidence or [] if isinstance(item, dict) and item.get("url")), None)
    prior = db.scalar(select(Case).where(Case.permalink == url)) if url else None
    if prior is not None and prior.id != case.id:
        save_reference_image(db, prior, candidate.image_path, media_dir)


def remember_wordpress_collage(db: Session, case: Case, media_url: str, media_dir: str) -> None:
    entry = record_archive_entry(db, case, media_dir)
    entry.wordpress_media_url = media_url
    if not entry.reference_image:
        save_reference_image(db, case, case.base_image, media_dir)


def _media_paths(value) -> set[str]:
    """Every local media path referenced anywhere in a case's JSON."""
    if isinstance(value, str):
        return {value} if value.startswith("/media-files/") else set()
    if isinstance(value, dict):
        return set().union(*(_media_paths(item) for item in value.values())) if value else set()
    if isinstance(value, list):
        return set().union(*(_media_paths(item) for item in value)) if value else set()
    return set()


def _case_media(case: Case) -> set[str]:
    paths = _media_paths(case.base_image) | _media_paths(case.extraction or {})
    for candidate in case.candidates:
        paths |= _media_paths(candidate.image_path)
    return {path for path in paths if not path.startswith(f"/media-files/{REFERENCE_DIR}/")}


def _held(case: Case, story: StoryDraft | None, now: datetime, grace: timedelta) -> bool:
    """Work in progress survives the edition close for the grace period."""
    if story and story.sync_state in IN_FLIGHT_STATES:
        return True
    edited = bool((case.extraction or {}).get("collage_edit")) or bool(story and (story.title or story.body))
    sent = bool(story and story.sync_state in SENT_STATES)
    touched = max(filter(None, [_aware(case.updated_at), _aware(story.updated_at) if story else None]), default=None)
    return edited and not sent and touched is not None and now - touched < grace


def purge_closed_editions(db: Session, settings, *, now: datetime | None = None) -> dict:
    """Archive closed cases as text and, when enabled, delete their images."""
    now = _now(now)
    grace = timedelta(days=settings.archive_purge_grace_days)
    stories = {story.case_id: story for story in db.scalars(select(StoryDraft)).all()}
    entries = {entry.case_id: entry for entry in db.scalars(select(ArchiveEntry)).all()}
    kept: list[Case] = []
    closing: list[Case] = []
    for case in db.scalars(select(Case).options(selectinload(Case.candidates))).all():
        entry = entries.get(case.id)
        if entry and entry.purged_at:
            continue
        if case.demo_data or in_current_edition(case, settings.reddit_daily_timezone, now) or _held(case, stories.get(case.id), now, grace):
            kept.append(case)
        else:
            closing.append(case)
    # Desk cases may show photos that belong to an older case.
    retained = set().union(*(_case_media(case) for case in kept)) if kept else set()
    output_root = Path(settings.output_dir).resolve()
    summary = {"archived": 0, "references": 0, "purged": 0, "files": 0, "held": len(kept), "enabled": settings.archive_purge_enabled}
    for case in closing:
        story = stories.get(case.id)
        entry = record_archive_entry(db, case, settings.media_dir, entries.get(case.id))
        summary["archived"] += 1
        if not entry.reference_image and (case.status == "approved" or (story and story.sync_state in SENT_STATES)):
            if save_reference_image(db, case, case.base_image, settings.media_dir):
                summary["references"] += 1
        if not settings.archive_purge_enabled:
            continue
        removed = 0
        for image_path in _case_media(case) - retained:
            path = _local_media_path(image_path, settings.media_dir)
            if path:
                path.unlink(missing_ok=True)
                removed += 1
        case_dir = (output_root / f"case-{case.id}").resolve()
        if case_dir.parent == output_root and case_dir.is_dir():
            shutil.rmtree(case_dir, ignore_errors=True)
        entry.purged_at = now
        summary["purged"] += 1
        summary["files"] += removed
        db.add(AuditEvent(entity_type="case", entity_id=case.id, action="edition_assets_purged", actor="archive-retention",
            detail={"media_files": removed, "reference_image": entry.reference_image, "wordpress_media_url": entry.wordpress_media_url}))
    db.commit()
    return summary
