"""Dashboard-requested collection from a user's signed-in local Reddit browser."""
import json
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .automation import _sync_current_post_images, editorial_subject_eligibility, parse_outfit, render_draft_collage
from .config import get_settings
from .database import get_db
from .editorial import locked_state
from .editor_uploads import UploadValidationError, store_editor_image
from .models import AuditEvent, Case, ServiceState
from .publication_dates import is_recent_post, publication_stamp
from .reddit_gallery import GalleryInput, apply_recovery
from .security import current_actor
from .browser_coverage import CoverageReport
from .storage import get_storage
from .uploads import staged_uploads

router = APIRouter(prefix="/api/reddit-browser")
RUN_KEY = "reddit-browser:run"
RUNNER_KEY = "reddit-browser:runner"


def active(value):
    return value.get("status") in {"queued", "awaiting_login", "awaiting_attention", "running"} and 0 <= time.time() - value.get("heartbeat", 0) < 180


@router.get("/status")
def status(db: Session = Depends(get_db)):
    state = db.get(ServiceState, RUN_KEY)
    value = dict(state.value) if state else {"status": "not_run"}
    runner = db.get(ServiceState, RUNNER_KEY)
    value["runner_online"] = bool(runner and 0 <= time.time() - runner.value.get("heartbeat", 0) < 180)
    if value.get("status") in {"queued", "awaiting_login", "awaiting_attention", "running"} and not active(value):
        value.update(status="interrupted", detail="The Reddit browser stopped responding. Sign in and collect again.")
    return value


@router.post("/scan", status_code=202)
def queue_scan(db: Session = Depends(get_db)):
    state = locked_state(db, RUN_KEY, {})
    if active(state.value):
        return state.value
    runner = db.get(ServiceState, RUNNER_KEY)
    if not runner or not 0 <= time.time() - runner.value.get("heartbeat", 0) < 180:
        raise HTTPException(503, "The local browser collector is offline. Start HHC Browser Requests in Windows Task Scheduler on the computer running HHC.")
    state.value = {"run_id": str(uuid.uuid4()), "status": "queued", "heartbeat": time.time(), "imported": 0,
                   "posts_checked": 0, "detail": "Opening Reddit. Sign in in the Edge window; photos will be collected automatically."}
    db.add(AuditEvent(entity_type="reddit_browser", entity_id=state.value["run_id"], action="scan_requested", actor=current_actor(), detail={}))
    db.commit()
    return state.value


@router.post("/heartbeat")
def heartbeat(db: Session = Depends(get_db)):
    runner = locked_state(db, RUNNER_KEY, {})
    runner.value = {"heartbeat": time.time()}
    db.commit()
    return {"ok": True}


@router.post("/claim")
def claim(db: Session = Depends(get_db)):
    state = locked_state(db, RUN_KEY, {})
    run = None
    if state.value.get("status") == "queued" and active(state.value):
        state.value = {**state.value, "status": "running", "heartbeat": time.time()}
        run = state.value
    db.commit()
    return {"run": run}


class RunReport(BaseModel):
    run_id: str = Field(pattern=r"^[a-zA-Z0-9-]{1,64}$")
    status: str = Field(pattern=r"^(awaiting_login|awaiting_attention|running|completed|partial|blocked|failed|cancelled)$")
    posts_checked: int = Field(default=0, ge=0, le=1000000)
    imported: int = Field(default=0, ge=0, le=1000000)
    detail: str = Field(default="", max_length=1000)
    exclusions: dict[str, int] = Field(default_factory=dict, max_length=20)
    coverage: CoverageReport | None = None


@router.post("/runs")
def report(payload: RunReport, db: Session = Depends(get_db)):
    state = locked_state(db, RUN_KEY, {})
    if state.value.get("run_id") != payload.run_id or not active(state.value):
        raise HTTPException(409, "This Reddit scan is no longer active")
    state.value = {**payload.model_dump(), "heartbeat": time.time(), "updated_at": datetime.now(timezone.utc).isoformat()}
    db.commit()
    return state.value


@router.get("/config")
def config():
    settings = get_settings()
    return {"subreddit": settings.reddit_subreddit, "timezone": settings.reddit_daily_timezone}


@router.get("/known")
def known_posts(db: Session = Depends(get_db)):
    return [{"permalink": case.permalink, "complete": bool((case.extraction or {}).get("gallery_expanded")),
             "revision": int(((case.extraction or {}).get("collage_edit") or {}).get("revision", 0))}
            for case in db.scalars(select(Case).where(Case.source_type == "reddit_rss", Case.demo_data.is_(False))).all()]


class BrowserPost(BaseModel):
    post_id: str = Field(pattern=r"^[a-z0-9]+$")
    permalink: str = Field(max_length=2000)
    title: str = Field(min_length=1, max_length=1000)
    description: str = Field(default="", max_length=10000)
    author: str = Field(default="unknown", max_length=120)
    published_at: str = Field(max_length=50)
    images: list[str] = Field(min_length=1, max_length=20)
    carousel_complete: bool
    expected_revision: int | None = Field(default=None, ge=0)

    @field_validator("images")
    @classmethod
    def valid_images(cls, images):
        return GalleryInput.reddit_images_only(images)


@router.post("/posts")
async def import_post(metadata: str = Form(..., max_length=20000), images: list[UploadFile] = File(default=[]),
        upload_keys: str = Form(""), db: Session = Depends(get_db)):
    # Hosted setups send storage keys instead of files (4.5 MB request cap).
    images = images or staged_uploads(upload_keys)
    settings = get_settings()
    paths = []
    retained = False
    try:
        try:
            payload = BrowserPost.model_validate_json(metadata)
            expected = rf"https://www\.reddit\.com/r/{re.escape(settings.reddit_subreddit)}/comments/{re.escape(payload.post_id)}(?:/[^?#]*)?"
            if not re.fullmatch(expected, payload.permalink, re.I):
                raise ValueError("The post must belong to the configured Reddit community")
            stamp, precision = publication_stamp(payload.published_at, settings.reddit_daily_timezone)
            if precision != "time" or not is_recent_post(payload.published_at, settings.reddit_daily_timezone):
                raise ValueError("Only verified posts from today or yesterday qualify")
            if not payload.carousel_complete or len(images) != len(payload.images):
                raise ValueError("Finish capturing every carousel photo before importing")
        except (ValidationError, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc
        locked_state(db, f"reddit-browser:post:{payload.post_id}", {})
        case = db.scalar(select(Case).where((Case.external_id == payload.post_id) | (Case.permalink == payload.permalink)))
        if case and (case.extraction or {}).get("gallery_expanded"):
            return {"case_id": case.id, "duplicate": True}
        if case and payload.expected_revision is None:
            raise HTTPException(409, "Reload the existing gallery revision before recovering its missing photos")
        outfit = parse_outfit(payload.title, payload.description)
        # Reddit commonly credits the label in its post title ("Person in Brand").
        designer = outfit["designer"].strip()
        generic_clothing = r"(?:(?:a|an|the|red|blue|black|white|pink|green|yellow|gold|silver|orange|purple|brown|beige|dress|saree|sari|suit|gown|outfit|look|shirt|jacket|jeans|skirt|pants|silk|cotton|linen|velvet)\s*)+"
        if designer.casefold() in {"unknown", "unresolved", "n/a", "none", ""} or re.fullmatch(generic_clothing, designer, re.I):
            return {"excluded": "no_brand_credit"}
        if not case and not editorial_subject_eligibility(payload.title, payload.description, outfit["celebrity"])[0]:
            return {"excluded": "individual_subject_unresolved"}
        remaining = 22 * 1024 * 1024
        for image in images:
            content = await image.read(remaining + 1)
            remaining -= len(content)
            if remaining < 0:
                raise HTTPException(413, "Combined photos must be 22 MB or smaller")
            path, _ = store_editor_image(content, settings.media_dir, uuid.uuid4().hex)
            paths.append(path)
        if case:
            result = apply_recovery(case.id, GalleryInput(post_id=payload.post_id, images=payload.images, expected_revision=payload.expected_revision), db, captured_paths=paths)
            retained = result["status"] == "completed"
            return {"case_id": case.id, "updated": True, **result}
        published_date = stamp.astimezone(ZoneInfo(settings.reddit_daily_timezone)).date().isoformat()
        case = Case(source_type="reddit_rss", external_id=payload.post_id, permalink=payload.permalink,
                    source_title=payload.title, source_body=payload.description, celebrity=outfit["celebrity"], designer=outfit["designer"],
                    event_name=outfit["event"], event_date=published_date, base_image=paths[0], status="context_review",
                    match_type="source_only", extraction={"provider": "reddit_browser", "published_at": stamp.isoformat(),
                    "source_platform": "Reddit", "browser_observed": True, "rights_review_required": True,
                    "brand_credit": {"name": designer, "evidence": payload.title + "\n" + payload.description, "attribution_verified": False},
                    "image_capture": {"kind": "browser_screenshot", "scope": "post_carousel", "photo_count": len(paths)}})
        db.add(case)
        db.flush()
        _sync_current_post_images(case, {"permalink": payload.permalink, "author": payload.author, "image_urls": payload.images, "gallery_expanded": True}, paths, datetime.now(timezone.utc).isoformat())
        collage = render_draft_collage(db, case, [], settings, getattr(settings, "static_dir", "") or str(Path(__file__).parent / "static"), editor_id=current_actor())
        case.extraction = {**case.extraction, "automatic_collage": {"id": collage.id, "panels": len(paths)}}
        db.add(AuditEvent(entity_type="case", entity_id=case.id, action="reddit_browser_imported", actor=current_actor(), detail={"photo_count": len(paths)}))
        db.commit()
        retained = True
        return {"case_id": case.id, "images": len(paths)}
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
            for path in paths:
                get_storage().delete(Path(settings.media_dir) / "editor" / Path(path).name)
