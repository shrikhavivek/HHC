"""Recover incomplete Reddit galleries from an editor's local browser session."""
import re
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, File, Form, UploadFile
from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .assets import build_panel_catalog, build_render_assets
from .automation import _download_source_images, _sync_current_post_images, render_draft_collage
from .config import get_settings
from .database import get_db
from .edition_window import in_current_edition
from .editorial import locked_state
from .editor_uploads import store_editor_image, UploadValidationError
from .models import AuditEvent, Case, StoryDraft
from .security import current_actor

router = APIRouter(prefix="/api/reddit-gallery")


class GalleryInput(BaseModel):
    post_id: str = Field(pattern=r"^[a-z0-9]+$")
    images: list[str] = Field(min_length=1, max_length=20)
    expected_revision: int = Field(ge=0)

    @field_validator("images")
    @classmethod
    def reddit_images_only(cls, images):
        for image in images:
            parsed = urlparse(image)
            if (parsed.scheme != "https" or parsed.netloc != "i.redd.it"
                    or parsed.query or parsed.fragment
                    or not re.fullmatch(r"/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)", parsed.path, re.I)):
                raise ValueError("Only original Reddit image URLs are accepted")
        if len(set(images)) != len(images):
            raise ValueError("Gallery images must be unique")
        return images


def incomplete(case):
    return case.source_type == "reddit_rss" and not (case.extraction or {}).get("gallery_expanded")


@router.get("/pending")
def pending(db: Session = Depends(get_db)):
    settings = get_settings()
    cases = db.scalars(select(Case).where(Case.source_type == "reddit_rss", Case.demo_data.is_(False)).order_by(Case.event_date.desc())).all()
    result = []
    for case in cases:
        if not incomplete(case) or not in_current_edition(case, settings.reddit_daily_timezone):
            continue
        story = db.get(StoryDraft, case.id)
        if story and (story.wordpress_post_id or story.sync_state in {"sending", "uncertain", "draft_transferred"}):
            continue
        edit = (case.extraction or {}).get("collage_edit") or {}
        result.append({"id": case.id, "permalink": case.permalink, "title": case.source_title, "revision": int(edit.get("revision", 0))})
    return result


@router.post("/cases/{case_id}")
def recover(case_id: str, payload: GalleryInput, db: Session = Depends(get_db)):
    return apply_recovery(case_id, payload, db)


def apply_recovery(case_id, payload, db, captured_paths=None):
    settings = get_settings()
    locked_state(db, f"story:{case_id}", {})
    case = db.scalar(select(Case).where(Case.id == case_id).with_for_update())
    if not case or case.source_type != "reddit_rss":
        raise HTTPException(404, "Reddit post not found")
    if not in_current_edition(case, settings.reddit_daily_timezone):
        raise HTTPException(409, "This post is outside the current edition")
    if not re.search(rf"/comments/{re.escape(payload.post_id)}(?:/|$)", urlparse(case.permalink).path):
        raise HTTPException(422, "The browser gallery belongs to a different post")
    story = db.get(StoryDraft, case_id)
    if story and (story.wordpress_post_id or story.sync_state in {"sending", "uncertain", "draft_transferred"}):
        raise HTTPException(409, "This draft has a WordPress handoff; resolve it before changing its gallery")
    extraction = dict(case.extraction or {})
    edit = dict(extraction.get("collage_edit") or {})
    if payload.expected_revision != int(edit.get("revision", 0)):
        raise HTTPException(409, "The collage changed. Reload before recovering its gallery")
    previous_urls = extraction.get("source_image_urls") or []
    if extraction.get("gallery_expanded") and previous_urls == payload.images:
        return {"status": "already_complete", "images": len(previous_urls)}
    if len(payload.images) < len(previous_urls):
        raise HTTPException(409, "A partial browser result cannot replace the existing gallery")
    # A saved crop belongs to its source image. Never silently move it to another slide.
    if edit.get("panel_ids") and previous_urls and payload.images[:len(previous_urls)] != previous_urls:
        raise HTTPException(409, "The gallery order differs from the edited photos; review it before replacing them")
    urls, paths = (payload.images, captured_paths) if captured_paths is not None else _download_source_images(payload.images, settings.media_dir, settings.reddit_user_agent)
    if len(paths) != len(payload.images) or urls != payload.images:
        raise HTTPException(502, "Some gallery photos could not be downloaded; the existing collage was preserved")
    old_ids = {p["id"] for p in build_panel_catalog(case, case.candidates, include_automation_matches=True)}
    now = datetime.now(timezone.utc).isoformat()
    _sync_current_post_images(case, {"permalink": case.permalink, "author": extraction.get("author", "unknown"), "image_urls": urls, "gallery_expanded": True}, paths, now)
    new_ids = [p["id"] for p in build_panel_catalog(case, case.candidates, include_automation_matches=True) if p["id"] not in old_ids and p["role"] == "current_angle"]
    if edit.get("panel_ids"):
        edit["panel_ids"] = [*edit["panel_ids"], *new_ids]
    edit.update(revision=int(edit.get("revision", 0)) + 1, updated_at=now)
    case.extraction = {**case.extraction, "collage_edit": edit, "gallery_retry": {"status": "completed", "method": "local_browser", "checked_at": now, "found": len(urls), "downloaded": len(paths)}}
    if captured_paths is not None:
        case.extraction = {**case.extraction, "image_capture": {"kind": "browser_screenshot", "scope": "post_carousel", "photo_count": len(paths)}}
    collage = render_draft_collage(db, case, list(case.candidates), settings, str(Path(__file__).parent / "static"), editor_id=current_actor())
    count = len(build_render_assets(case, case.candidates, include_automation_matches=True, panel_ids=edit.get("panel_ids")))
    case.extraction = {**case.extraction, "automatic_collage": {"id": collage.id, "panels": count}}
    if story:
        story.reviewed_collage_id = None
    db.add(AuditEvent(entity_type="case", entity_id=case_id, action="reddit_browser_gallery_recovered", actor=current_actor(), detail={"images": len(paths), "collage_id": collage.id}))
    db.commit()
    return {"status": "completed", "images": len(paths), "panels": count}


@router.post("/cases/{case_id}/screenshots")
async def recover_screenshots(case_id: str, metadata: str = Form(..., max_length=20000), images: list[UploadFile] = File(...), db: Session = Depends(get_db)):
    try:
        raw = json.loads(metadata)
        if not isinstance(raw, dict) or raw.get("carousel_complete") is not True:
            raise ValueError("Finish every carousel slide before importing")
        payload = GalleryInput.model_validate(raw)
    except (ValueError, ValidationError) as exc:
        raise HTTPException(422, "A complete, verified Reddit carousel is required") from exc
    if len(images) != len(payload.images):
        raise HTTPException(422, "Every photo needs a matching screenshot")
    settings = get_settings()
    paths = []
    retained = False
    remaining = 22 * 1024 * 1024
    try:
        for image in images:
            content = await image.read(remaining + 1)
            remaining -= len(content)
            if remaining < 0:
                raise HTTPException(413, "The carousel exceeds the 22 MB upload limit")
            path, _ = store_editor_image(content, settings.media_dir, f"reddit-{uuid.uuid4().hex}")
            paths.append(path)
        result = apply_recovery(case_id, payload, db, captured_paths=paths)
        retained = result["status"] == "completed"
        return result
    except UploadValidationError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    except Exception:
        db.rollback()
        raise
    finally:
        for image in images:
            await image.close()
        if not retained:
            root = (Path(settings.media_dir) / "editor").resolve()
            for path in paths:
                target = root / Path(path).name
                if target.parent == root and not target.is_symlink():
                    target.unlink(missing_ok=True)
