"""Private editorial operations. The web proxy supplies the authenticated actor."""
import json
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, HttpUrl
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from .config import get_settings
from .database import get_db
from .models import AuditEvent, Candidate, Case, Collage, EditorSession, ServiceState, StoryDraft
from .security import current_actor
from .review import earlier_date

router = APIRouter(prefix="/api")

class ContextInput(BaseModel):
    title: str = Field(min_length=4, max_length=500)
    celebrity: str = Field(min_length=2, max_length=180)
    designer: str = Field(min_length=2, max_length=180)
    event_name: str = Field(default="Unresolved", max_length=240)
    event_date: date | None = None
    expected_revision: int = Field(ge=0)

@router.post("/cases/{case_id}/context")
def edit_context(case_id: str, payload: ContextInput, db: Session = Depends(get_db)):
    locked_state(db, f"story:{case_id}", {})
    case = db.scalar(select(Case).where(Case.id == case_id).with_for_update())
    if not case:
        raise HTTPException(404, "Case not found")
    extraction = dict(case.extraction or {})
    if payload.expected_revision != extraction.get("context_revision", 0):
        raise HTTPException(409, "Another editor changed the attribution. Reopen this outfit.")
    story = db.get(StoryDraft, case_id)
    if story and story.sync_state == "sending":
        raise HTTPException(409, "Wait for the WordPress handoff to finish")
    before = {"title": case.source_title, "celebrity": case.celebrity, "designer": case.designer, "event": case.event_name, "date": case.event_date}
    case.source_title, case.celebrity, case.designer = payload.title, payload.celebrity, payload.designer
    case.event_name = payload.event_name or "Unresolved"
    case.event_date = payload.event_date.isoformat() if payload.event_date else None
    case.extraction = {**extraction, "context_verified": True, "context_revision": payload.expected_revision + 1}
    case.status = "context_review"
    for candidate in case.candidates:
        candidate.checks = {**(candidate.checks or {}), "editor_verified": False}
    if story:
        story.reviewed_collage_id = None
    db.add(AuditEvent(entity_type="case", entity_id=case.id, action="attribution_corrected", actor=current_actor(), detail={"before": before, "after": payload.model_dump(mode="json")}))
    db.commit()
    return {"context_revision": payload.expected_revision + 1}

def locked_state(db, key, default):
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert
    insert = pg_insert if db.bind.dialect.name == "postgresql" else sqlite_insert
    db.execute(insert(ServiceState).values(key=key, value=default).on_conflict_do_nothing(index_elements=["key"]))
    return db.scalar(select(ServiceState).where(ServiceState.key == key).with_for_update())

class SessionInput(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9]{64}$")
    actor: str = Field(min_length=1, max_length=120)
    expires_at: int

@router.post("/internal/sessions")
def register_session(payload: SessionInput, db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc)
    if not time.time() < payload.expires_at <= time.time() + 28860:
        raise HTTPException(422, "Invalid session expiry")
    db.execute(delete(EditorSession).where(EditorSession.expires_at <= now))
    db.add(EditorSession(id=payload.id, actor=payload.actor, expires_at=datetime.fromtimestamp(payload.expires_at, timezone.utc)))
    db.commit()
    return {"ok": True}

@router.get("/internal/sessions/{session_id}")
def active_session(session_id: str, db: Session = Depends(get_db)):
    session = db.get(EditorSession, session_id)
    if not session or session.expires_at.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
        raise HTTPException(401, "Session expired")
    return {"actor": session.actor}

@router.delete("/internal/sessions/{session_id}")
def revoke_session(session_id: str, db: Session = Depends(get_db)):
    db.execute(delete(EditorSession).where(EditorSession.id == session_id))
    db.commit()
    return {"ok": True}

class LoginAttempt(BaseModel):
    key: str = Field(pattern=r"^[a-f0-9]{64}$")

@router.post("/internal/login-attempt")
def login_attempt(payload: LoginAttempt, db: Session = Depends(get_db)):
    now = time.time()
    for key, limit in [("login:global", 100), (f"login:{payload.key}", 10)]:
        state = locked_state(db, key, {})
        value = state.value
        if value.get("reset", 0) <= now:
            value = {"count": 0, "reset": now + 900}
        if value["count"] >= limit:
            db.commit()
            raise HTTPException(429, "Too many login attempts", headers={"Retry-After": "900"})
        state.value = {**value, "count": value["count"] + 1}
    db.commit()
    return {"ok": True}

class StoryInput(BaseModel):
    title: str = Field(default="", max_length=300)
    body: str = Field(default="", max_length=20000)
    alt_text: str = Field(default="", max_length=1000)
    credits: str = Field(default="", max_length=3000)
    category_ids: list[int] = Field(default_factory=list, max_length=20)
    tag_ids: list[int] = Field(default_factory=list, max_length=30)
    expected_revision: int = Field(ge=0)
    reviewed_collage_id: str | None = None

def story_json(story):
    return {key: getattr(story, key) for key in ("case_id", "title", "body", "alt_text", "credits", "category_ids", "tag_ids", "reviewed_collage_id", "revision", "wordpress_post_id", "sync_state")}

@router.get("/cases/{case_id}/story")
def get_story(case_id: str, db: Session = Depends(get_db)):
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(404, "Case not found")
    story = db.get(StoryDraft, case_id)
    if story:
        return story_json(story)
    return {"case_id": case_id, "title": case.source_title, "body": "", "alt_text": f"{case.celebrity} wearing {case.designer}", "credits": "", "category_ids": [], "tag_ids": [], "reviewed_collage_id": None, "revision": 0, "wordpress_post_id": None, "sync_state": "not_sent"}

@router.post("/cases/{case_id}/story")
def save_story(case_id: str, payload: StoryInput, db: Session = Depends(get_db)):
    if not db.get(Case, case_id):
        raise HTTPException(404, "Case not found")
    locked_state(db, f"story:{case_id}", {})
    story = db.get(StoryDraft, case_id)
    if story and story.sync_state == "sending":
        raise HTTPException(409, "Wait for the WordPress handoff to finish")
    if payload.expected_revision != (story.revision if story else 0):
        raise HTTPException(409, "Another editor changed this story. Reopen it to load the latest revision.")
    latest = db.scalar(select(Collage).where(Collage.case_id == case_id).order_by(Collage.created_at.desc()))
    if payload.reviewed_collage_id and (not latest or latest.id != payload.reviewed_collage_id):
        raise HTTPException(409, "Review the latest collage before confirming its image rights")
    if not story:
        story = StoryDraft(case_id=case_id, revision=0)
        db.add(story)
    for key, value in payload.model_dump(exclude={"expected_revision"}).items():
        setattr(story, key, value)
    story.revision += 1
    db.add(AuditEvent(entity_type="case", entity_id=case_id, action="story_saved", actor=current_actor(), detail={"revision": story.revision, "rights_reviewed_for": story.reviewed_collage_id}))
    db.commit()
    return story_json(story)

class VerificationInput(BaseModel):
    source_url: HttpUrl
    publisher: str = Field(min_length=2, max_length=200)
    source_grade: Literal["A", "B"]
    notes: str = Field(min_length=12, max_length=3000)
    current_event_date: str
    earlier_event_date: str
    identity_confirmed: bool
    distinct_photo_and_event: bool
    rights_confirmed: bool

@router.post("/candidates/{candidate_id}/verify")
def verify_candidate(candidate_id: str, payload: VerificationInput, db: Session = Depends(get_db)):
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(404, "Candidate not found")
    if not (payload.identity_confirmed and payload.distinct_photo_and_event and earlier_date(payload.earlier_event_date, payload.current_event_date)):
        raise HTTPException(422, "Confirm garment details, distinct photograph and event, and the earlier date")
    if payload.source_url.scheme != "https":
        raise HTTPException(422, "Use an HTTPS evidence source")
    if candidate.rights_status in {"do_not_use", "blocked", "unknown_blocked"}:
        raise HTTPException(422, "This image is blocked")
    previous = dict(candidate.checks or {})
    candidate.evidence = [*(candidate.evidence or []), {"url": str(payload.source_url), "publisher": payload.publisher, "grade": payload.source_grade, "quote": payload.notes, "editor": current_actor()}]
    candidate.event_date = payload.earlier_event_date
    candidate.case.event_date = payload.current_event_date
    candidate.checks = {**previous, "identity": True, "chronology": True, "same_photo": False, "same_event": False, "contradictions": [], "editor_verified": True, "verified_by": current_actor()}
    if payload.rights_confirmed:
        candidate.rights_status = "editor_confirmed"
    db.add(AuditEvent(entity_type="candidate", entity_id=candidate.id, action="evidence_verified", actor=current_actor(), detail={"previous_checks": previous, "evidence": payload.model_dump(mode="json")}))
    db.commit()
    return {"ok": True, "detail": "Evidence recorded. An approval decision is still required."}

@router.get("/cases/{case_id}/history")
def history(case_id: str, db: Session = Depends(get_db)):
    collages = db.scalars(select(Collage).where(Collage.case_id == case_id).order_by(Collage.created_at.desc()).limit(30)).all()
    root = Path(get_settings().output_dir).resolve()
    versions = []
    seen_paths = set()
    for item in collages:
        path = Path(item.image_path).resolve()
        if root in path.parents and path.is_file() and path not in seen_paths:
            seen_paths.add(path)
            versions.append({"id": item.id, "created_at": item.created_at.isoformat(), "preview_url": "/outputs/" + path.relative_to(root).as_posix()})
    audit = db.scalars(select(AuditEvent).where(AuditEvent.entity_id == case_id).order_by(AuditEvent.id.desc()).limit(30)).all()
    return {"versions": versions, "events": [{"id": e.id, "action": e.action, "actor": e.actor, "created_at": e.created_at.isoformat()} for e in audit]}

class RestoreInput(BaseModel):
    collage_id: str
    expected_revision: int = Field(ge=0)

@router.post("/cases/{case_id}/restore")
def restore(case_id: str, payload: RestoreInput, db: Session = Depends(get_db)):
    from .main import edit_collage
    from .schemas import CollageEditInput
    collage = db.get(Collage, payload.collage_id)
    if not collage or collage.case_id != case_id:
        raise HTTPException(404, "Revision not found")
    manifest = json.loads(Path(collage.manifest_path).read_text(encoding="utf-8"))
    data = {key: manifest[key] for key in ("panel_options", "collage_adjustments", "watermark", "export_scale") if key in manifest}
    data.update(panel_ids=[str(p["id"]) for p in manifest["assets"]], expected_revision=payload.expected_revision)
    case = db.get(Case, case_id)
    if not data.get("watermark") and (case.extraction or {}).get("watermark_asset"):
        data["watermark"] = {"enabled": False}
    if manifest.get("canvas_format") in {"instagram_portrait", "instagram_landscape"}:
        data["canvas_format"] = manifest["canvas_format"]
    if manifest.get("layout") in {"balanced_grid", "hero_focus", "editorial_split", "side_by_side"}:
        data["layout_template"] = manifest["layout"]
    return edit_collage(case_id, CollageEditInput(**data), db)
