import asyncio
import os
import mimetypes
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload
from .assets import build_panel_catalog, build_render_assets, default_panel_ids, normalize_case_assets
from .automation import (
    AutomationError,
    MATCHER_VERSION,
    case_content_eligible,
    editorial_subject_eligibility,
    import_public_post_automation,
    migrate_legacy_matcher_outputs,
    refresh_existing_case_metadata,
    refresh_existing_content_policy,
    render_draft_collage,
    research_case_automation,
    run_daily_automation,
)
from .collage import ensure_demo_images, render_bundle
from .config import get_settings
from .database import Base, SessionLocal, engine, get_db
from .editor_uploads import MAX_UPLOAD_BYTES, MAX_WATERMARK_UPLOAD_BYTES, UploadValidationError, store_editor_image, store_watermark_image
from .fashion_category import case_fashion_category
from .models import AuditEvent, Candidate, Case, Collage, Decision, JobRun
from .public_sources import DuplicatePublicSourceError, PublicSourceError
from .schemas import CollageEditInput, CollageInput, DecisionInput, FashionCategoryInput, ManualIntake, SourceUrlIntake
from .seed import seed_database


settings = get_settings()
STATIC_DIR = str(Path(__file__).parent / "static")
Path(settings.output_dir).mkdir(parents=True, exist_ok=True)
Path(settings.media_dir).mkdir(parents=True, exist_ok=True)
ensure_demo_images(STATIC_DIR)
mimetypes.add_type("image/webp", ".webp")


def require_editor(x_editor_key: str = Header(default="")):
    if not x_editor_key or x_editor_key != settings.editor_api_key:
        raise HTTPException(status_code=401, detail="Invalid editor credentials")


def _visible_candidate(candidate: Candidate) -> bool:
    if candidate.status in {"automation_draft_anchor", "matcher_superseded"}:
        return False
    if candidate.status != "automation_selected":
        return True
    checks = candidate.checks if isinstance(candidate.checks, dict) else {}
    automation = checks.get("automation", {}) if isinstance(checks.get("automation", {}), dict) else {}
    return automation.get("matcher_version") == MATCHER_VERSION


def _watermark_editor_state(extraction: dict, edit: dict) -> tuple[dict | None, dict | None]:
    asset = extraction.get("watermark_asset")
    if not isinstance(asset, dict) or not isinstance(asset.get("image_path"), str):
        return None, None
    raw = edit.get("watermark") if isinstance(edit.get("watermark"), dict) else {}
    watermark = {
        "enabled": bool(raw.get("enabled", True)),
        "asset_id": asset.get("id"),
        "image_path": asset["image_path"],
        "center_x": raw.get("center_x", 0.82),
        "center_y": raw.get("center_y", 0.9),
        "width": raw.get("width", 0.2),
        "height": raw.get("height"),
        "rotation_degrees": raw.get("rotation_degrees", 0),
        "opacity": raw.get("opacity", 0.72),
        "adjustments": raw.get("adjustments") if isinstance(raw.get("adjustments"), dict) else {
            "brightness": 1.0,
            "contrast": 1.0,
            "saturation": 1.0,
            "grayscale": 0.0,
        },
    }
    return asset, watermark


def case_json(case: Case, detail=False):
    data = {
        "id": case.id, "title": case.source_title, "body": case.source_body, "permalink": case.permalink,
        "celebrity": case.celebrity, "designer": case.designer, "event_name": case.event_name, "event_date": case.event_date,
        "status": case.status, "match_type": case.match_type, "confidence": case.confidence, "risk_level": case.risk_level,
        "base_image": case.base_image, "demo_data": case.demo_data, "source_type": case.source_type,
        "fashion_category": case_fashion_category(case), "created_at": case.created_at.isoformat(),
    }
    if detail:
        data["extraction"] = case.extraction
        data["assets"] = normalize_case_assets(case)
        data["candidates"] = [
            candidate_json(c)
            for c in case.candidates
            if _visible_candidate(c)
        ]
        catalog = build_panel_catalog(case, case.candidates, include_automation_matches=True)
        defaults = default_panel_ids(catalog)
        extraction = case.extraction if isinstance(case.extraction, dict) else {}
        edit = extraction.get("collage_edit") if isinstance(extraction.get("collage_edit"), dict) else {}
        saved = edit.get("panel_ids") if isinstance(edit.get("panel_ids"), list) else None
        saved_options = edit.get("panel_options") if isinstance(edit.get("panel_options"), dict) else {}
        watermark_asset, watermark = _watermark_editor_state(extraction, edit)
        available_ids = {str(item["id"]) for item in catalog}
        selected = [str(item) for item in saved or defaults if str(item) in available_ids]
        data["collage_editor"] = {
            "panels": catalog,
            "default_ids": defaults,
            "selected_ids": selected or defaults,
            "panel_options": {
                str(panel_id): value
                for panel_id, value in saved_options.items()
                if str(panel_id) in available_ids and isinstance(value, dict)
            },
            "collage_adjustments": edit.get("collage_adjustments") if isinstance(edit.get("collage_adjustments"), dict) else {
                "brightness": 1.0,
                "contrast": 1.0,
                "saturation": 1.0,
                "grayscale": 0.0,
            },
            "watermark_asset": watermark_asset,
            "watermark": watermark,
            "customized": bool(saved or watermark),
            "updated_at": edit.get("updated_at"),
            "editor_id": edit.get("editor_id"),
        }
    return data


def candidate_json(candidate: Candidate):
    latest = max(candidate.decisions, key=lambda d: d.decided_at) if candidate.decisions else None
    return {
        "id": candidate.id, "person": candidate.person, "designer": candidate.designer, "event_name": candidate.event_name,
        "event_date": candidate.event_date, "image_path": candidate.image_path, "proposed_match_type": candidate.proposed_match_type,
        "status": candidate.status, "visual_score": candidate.visual_score, "source_grade": candidate.source_grade,
        "rights_status": candidate.rights_status, "evidence": candidate.evidence, "checks": candidate.checks,
        "decision": None if not latest else {"id": latest.id, "decision": latest.decision, "reason": latest.reason, "editor_id": latest.editor_id, "decided_at": latest.decided_at.isoformat()},
    }


def _scheduled_run():
    with SessionLocal() as db:
        run_daily_automation(db, settings, STATIC_DIR, trigger="scheduler")


async def _daily_scheduler():
    # Populate a new installation automatically, then run at the configured
    # UTC time every day. The scheduler key keeps restarts idempotent.
    await asyncio.sleep(4)
    while True:
        try:
            await asyncio.to_thread(_scheduled_run)
        except Exception:
            # Failure is persisted in JobRun/AuditEvent; the API stays healthy
            # and the next scheduled run can recover.
            pass
        now = datetime.now(timezone.utc)
        next_run = now.replace(
            hour=settings.daily_automation_hour_utc,
            minute=settings.daily_automation_minute_utc,
            second=0,
            microsecond=0,
        )
        if next_run <= now:
            next_run += timedelta(days=1)
        await asyncio.sleep(max(60, (next_run - now).total_seconds()))


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)
    if settings.reddit_source_mode == "manual":
        with SessionLocal() as db:
            seed_database(db)
    with SessionLocal() as db:
        migrate_legacy_matcher_outputs(db, settings, STATIC_DIR)
        refresh_existing_case_metadata(db)
        refresh_existing_content_policy(db)
    scheduler = asyncio.create_task(_daily_scheduler()) if settings.daily_automation_enabled else None
    try:
        yield
    finally:
        if scheduler:
            scheduler.cancel()
            try:
                await scheduler
            except asyncio.CancelledError:
                pass


app = FastAPI(title="Outfit Research API", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=[x.strip() for x in settings.cors_origins.split(",")], allow_methods=["*"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/outputs", StaticFiles(directory=settings.output_dir), name="outputs")
app.mount("/media-files", StaticFiles(directory=settings.media_dir), name="media-files")


@app.get("/health")
def health():
    return {"status": "ok", "auto_approve": False, "wordpress": False, "source_mode": settings.reddit_source_mode}


@app.get("/api/dashboard")
def dashboard(db: Session = Depends(get_db)):
    eligible_cases = [case for case in db.scalars(select(Case)).all() if case_content_eligible(case)]
    has_live = any(not case.demo_data and case.source_type == "reddit_rss" for case in eligible_cases)
    visible_cases = [case for case in eligible_cases if not case.demo_data] if has_live else eligible_cases
    counts: dict[str, int] = {}
    for case in visible_cases:
        counts[case.status] = counts.get(case.status, 0) + 1
    review_statuses = {"review_ready", "context_review", "needs_research", "research_queued"}
    archive_statuses = {"approved", "rejected", "auto_rejected", "similar_not_same"}
    visible_case_ids = [case.id for case in visible_cases]
    if visible_case_ids:
        pending_query = select(func.count(Candidate.id)).where(
            Candidate.case_id.in_(visible_case_ids),
            Candidate.rights_status == "editorial_review_required",
        )
        blocked_query = select(func.count(Candidate.id)).where(
            Candidate.case_id.in_(visible_case_ids),
            Candidate.rights_status == "do_not_use",
        )
        rights_pending = (db.scalar(pending_query) or 0) + (sum(counts.values()) if has_live else 0)
        rights_blocked = db.scalar(blocked_query) or 0
    else:
        rights_pending = 0
        rights_blocked = 0
    last_run = db.scalar(select(JobRun).where(JobRun.job_type == "daily_reddit_automation").order_by(JobRun.created_at.desc()))
    return {
        "total": sum(counts.values()),
        "status_counts": counts,
        "review_ready": counts.get("review_ready", 0),
        "needs_attention": counts.get("needs_research", 0) + counts.get("context_review", 0),
        "review_queue": sum(counts.get(item, 0) for item in review_statuses),
        "archive_total": sum(counts.get(item, 0) for item in archive_statuses),
        "rights_pending": rights_pending,
        "rights_blocked": rights_blocked,
        "source_mode": settings.reddit_source_mode,
        "auto_approve": False,
        "automation_enabled": settings.daily_automation_enabled,
        "last_run": None if not last_run else {"id": last_run.id, "status": last_run.status, "created_at": last_run.created_at.isoformat()},
    }


@app.get("/api/cases")
def list_cases(status_filter: str | None = Query(default=None, alias="status"), db: Session = Depends(get_db)):
    # event_date is the source Reddit post's published date for automated
    # cases. Missing source dates fall back to ingestion time and remain last.
    stmt = select(Case).order_by(
        Case.event_date.desc().nulls_last(),
        Case.created_at.desc(),
        Case.id.asc(),
    )
    live_cases = db.scalars(
        select(Case).where(Case.demo_data.is_(False), Case.source_type == "reddit_rss")
    ).all()
    has_live = any(case_content_eligible(case) for case in live_cases)
    if has_live:
        stmt = stmt.where(Case.demo_data.is_(False))
    if status_filter and status_filter != "all":
        stmt = stmt.where(Case.status == status_filter)
    return [case_json(row) for row in db.scalars(stmt).all() if case_content_eligible(row)]


@app.get("/api/cases/{case_id}")
def get_case(case_id: str, db: Session = Depends(get_db)):
    stmt = select(Case).where(Case.id == case_id).options(selectinload(Case.candidates).selectinload(Candidate.decisions))
    case = db.scalar(stmt)
    if not case or not case_content_eligible(case):
        raise HTTPException(404, "Case not found")
    data = case_json(case, detail=True)
    collage = db.scalar(select(Collage).where(Collage.case_id == case_id).order_by(Collage.created_at.desc()))
    preview_url = f"/outputs/case-{case.id}/collage.webp"
    base_preview_path = Path(settings.output_dir) / f"case-{case.id}" / "collage-base.webp"
    source_preview_path = Path(settings.output_dir) / f"case-{case.id}" / "collage-source.webp"
    data["latest_collage"] = None if not collage else {
        "id": collage.id,
        "preview_url": preview_url,
        "base_preview_url": f"/outputs/case-{case.id}/collage-base.webp" if base_preview_path.is_file() else preview_url,
        "source_preview_url": f"/outputs/case-{case.id}/collage-source.webp" if source_preview_path.is_file() else (f"/outputs/case-{case.id}/collage-base.webp" if base_preview_path.is_file() else preview_url),
        "bundle_url": f"/api/cases/{case.id}/bundle",
        "created_at": collage.created_at.isoformat(),
    }
    return data


@app.post("/api/intake/reddit-url", status_code=201, dependencies=[Depends(require_editor)])
def manual_intake(payload: ManualIntake, db: Session = Depends(get_db)):
    eligible, _ = editorial_subject_eligibility(payload.title, payload.body, payload.celebrity)
    if not eligible:
        raise HTTPException(
            422,
            "A clearly identified person is required. Anonymous brand or campaign creative is not added to the collage queue.",
        )
    case = Case(permalink=str(payload.reddit_url), source_title=payload.title, source_body=payload.body, celebrity=payload.celebrity, designer=payload.designer, event_name=payload.event_name, status="context_review", extraction={"needs_human_context_review": True})
    db.add(case)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "This Reddit URL is already in the research queue")
    db.refresh(case)
    db.add(AuditEvent(entity_type="case", entity_id=case.id, action="manual_intake", actor="editor", detail={"source": str(payload.reddit_url)}))
    db.commit()
    return case_json(case)


@app.post("/api/intake/source-url", status_code=201, dependencies=[Depends(require_editor)])
def source_url_intake(payload: SourceUrlIntake, db: Session = Depends(get_db)):
    try:
        return import_public_post_automation(
            db,
            payload.model_dump(mode="json"),
            settings,
            STATIC_DIR,
        )
    except DuplicatePublicSourceError as exc:
        raise HTTPException(409, str(exc)) from exc
    except PublicSourceError as exc:
        raise HTTPException(422, str(exc)) from exc
    except AutomationError as exc:
        raise HTTPException(502, str(exc)) from exc


@app.post("/api/cases/{case_id}/fashion-category", dependencies=[Depends(require_editor)])
def set_fashion_category(case_id: str, payload: FashionCategoryInput, db: Session = Depends(get_db)):
    case = db.get(Case, case_id)
    if not case or not case_content_eligible(case):
        raise HTTPException(404, "Case not found")
    extraction = case.extraction if isinstance(case.extraction, dict) else {}
    previous = case_fashion_category(case)
    case.extraction = {**extraction, "fashion_category": payload.category}
    db.add(AuditEvent(
        entity_type="case",
        entity_id=case.id,
        action="fashion_category_updated",
        actor=payload.editor_id,
        detail={"from": previous, "to": payload.category},
    ))
    db.commit()
    return {"case_id": case.id, "fashion_category": payload.category}


@app.post("/api/cases/{case_id}/research", dependencies=[Depends(require_editor)])
def queue_research(case_id: str, db: Session = Depends(get_db)):
    case = db.scalar(select(Case).where(Case.id == case_id).options(selectinload(Case.candidates)))
    if not case or not case_content_eligible(case):
        raise HTTPException(404, "Case not found")
    if case.source_type not in {"reddit_rss", "public_post_url"}:
        raise HTTPException(422, "Automated archive research requires a live Reddit or imported public-post case")
    try:
        return {"status": "completed", **research_case_automation(db, case, settings, STATIC_DIR)}
    except AutomationError as exc:
        raise HTTPException(502, f"Archive research failed: {exc}") from exc


@app.post("/api/candidates/{candidate_id}/decision", dependencies=[Depends(require_editor)])
def decide(candidate_id: str, payload: DecisionInput, db: Session = Depends(get_db)):
    stmt = select(Candidate).where(Candidate.id == candidate_id).options(selectinload(Candidate.case), selectinload(Candidate.decisions))
    candidate = db.scalar(stmt)
    if not candidate or not case_content_eligible(candidate.case):
        raise HTTPException(404, "Candidate not found")
    if payload.decision == "approved":
        strong_source = any(item.get("grade") in {"A", "B"} and item.get("url") for item in candidate.evidence)
        blocked = candidate.checks.get("same_photo") or candidate.checks.get("same_event") or candidate.checks.get("contradictions")
        if not strong_source:
            raise HTTPException(422, "Approval requires Grade A/B source evidence")
        if blocked:
            raise HTTPException(422, "Approval blocked by duplicate or contradictory evidence")
        if candidate.rights_status == "do_not_use":
            raise HTTPException(422, "Asset rights status blocks approval")
    decision = Decision(candidate_id=candidate.id, decision=payload.decision, reason=payload.reason, editor_id=payload.editor_id)
    candidate.status = payload.decision
    candidate.case.status = "approved" if payload.decision == "approved" else payload.decision
    db.add(decision)
    db.flush()
    db.add(AuditEvent(entity_type="candidate", entity_id=candidate.id, action=f"decision:{payload.decision}", actor=payload.editor_id, detail={"reason": payload.reason, "decision_id": decision.id}))
    db.commit()
    return candidate_json(candidate)


@app.post("/api/cases/{case_id}/collage", dependencies=[Depends(require_editor)])
def create_collage(case_id: str, payload: CollageInput, db: Session = Depends(get_db)):
    case = db.scalar(select(Case).where(Case.id == case_id).options(selectinload(Case.candidates).selectinload(Candidate.decisions)))
    candidate = next((item for item in case.candidates if item.id == payload.candidate_id), None) if case else None
    if not case or not case_content_eligible(case) or not candidate or candidate.case_id != case.id:
        raise HTTPException(404, "Case or candidate not found")
    decision = max(candidate.decisions, key=lambda item: item.decided_at) if candidate.decisions else None
    if not decision or decision.decision != "approved":
        raise HTTPException(422, "An approved editorial decision is required")
    approved_candidates = []
    for item in case.candidates:
        latest = max(item.decisions, key=lambda row: row.decided_at) if item.decisions else None
        if latest and latest.decision == "approved" and item.rights_status != "do_not_use":
            approved_candidates.append(item)
    extraction = case.extraction if isinstance(case.extraction, dict) else {}
    edit = extraction.get("collage_edit") if isinstance(extraction.get("collage_edit"), dict) else {}
    saved_panel_ids = [str(item) for item in edit.get("panel_ids", [])] if isinstance(edit.get("panel_ids"), list) else None
    saved_panel_options = edit.get("panel_options") if isinstance(edit.get("panel_options"), dict) else None
    saved_collage_adjustments = edit.get("collage_adjustments") if isinstance(edit.get("collage_adjustments"), dict) else None
    saved_watermark = edit.get("watermark") if isinstance(edit.get("watermark"), dict) else None
    render_assets = build_render_assets(case, approved_candidates, panel_ids=saved_panel_ids)
    if len(render_assets) < 2:
        raise HTTPException(422, "The outfit needs another approved historical, current-angle, or official designer image")
    try:
        image_path, manifest_path, bundle_path = render_bundle(
            settings.output_dir,
            STATIC_DIR,
            case,
            approved_candidates,
            decision,
            media_dir=settings.media_dir,
            panel_ids=saved_panel_ids,
            panel_options=saved_panel_options,
            collage_adjustments=saved_collage_adjustments,
            watermark_options=saved_watermark,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc
    record = Collage(case_id=case.id, decision_id=decision.id, image_path=image_path, manifest_path=manifest_path, bundle_path=bundle_path)
    db.add(record)
    db.flush()
    db.add(AuditEvent(entity_type="case", entity_id=case.id, action="collage_generated", actor=decision.editor_id, detail={"collage_id": record.id, "asset_count": len(render_assets), "candidate_ids": [item.id for item in approved_candidates], "custom_layout": bool(saved_panel_ids)}))
    db.commit()
    return {"id": record.id, "preview_url": f"/outputs/case-{case.id}/collage.webp", "base_preview_url": f"/outputs/case-{case.id}/collage-base.webp", "source_preview_url": f"/outputs/case-{case.id}/collage-source.webp", "bundle_url": f"/api/cases/{case.id}/bundle", "asset_count": len(render_assets)}


@app.post("/api/cases/{case_id}/collage/assets", status_code=201, dependencies=[Depends(require_editor)])
async def upload_collage_asset(
    case_id: str,
    image: UploadFile = File(...),
    label: str = Form("Editor-supplied image"),
    person: str = Form(""),
    source_url: str = Form(""),
    credit: str = Form(...),
    rights_confirmed: bool = Form(False),
    editor_id: str = Form("editor@atelier"),
    db: Session = Depends(get_db),
):
    case = db.get(Case, case_id)
    if not case or not case_content_eligible(case):
        raise HTTPException(404, "Case not found")
    if not rights_confirmed:
        raise HTTPException(422, "Confirm that the image may be used in an editorial draft")
    label, person, source_url, credit = label.strip(), person.strip(), source_url.strip(), credit.strip()
    if not label or len(label) > 180:
        raise HTTPException(422, "Image label must be between 1 and 180 characters")
    if len(person) > 180 or not credit or len(credit) > 300:
        raise HTTPException(422, "Add a credit of 1–300 characters")
    if source_url:
        parsed_source = urlparse(source_url)
        if parsed_source.scheme not in {"http", "https"} or not parsed_source.hostname:
            raise HTTPException(422, "Source URL must be a valid http(s) address")
    else:
        parsed_source = urlparse("")

    extraction = case.extraction if isinstance(case.extraction, dict) else {}
    raw_assets = extraction.get("collage_assets", [])
    assets = list(raw_assets) if isinstance(raw_assets, list) else []
    if sum(isinstance(item, dict) and item.get("role") == "editor_upload" for item in assets) >= 12:
        raise HTTPException(422, "This case already has the maximum of 12 editor uploads")

    try:
        content = await image.read(MAX_UPLOAD_BYTES + 1)
    finally:
        await image.close()
    file_key = f"upload-{uuid.uuid4().hex}"
    try:
        image_path, image_metadata = store_editor_image(content, settings.media_dir, file_key)
    except UploadValidationError as exc:
        raise HTTPException(422, str(exc)) from exc

    asset_id = f"editor-upload-{uuid.uuid4().hex[:16]}"
    effective_source = source_url
    asset_record = {
        "id": asset_id,
        "role": "editor_upload",
        "label": label,
        "person": person or case.celebrity,
        "designer": case.designer,
        "image_path": image_path,
        "source_url": effective_source,
        "publisher": parsed_source.hostname or "Editor upload · source URL pending",
        "credit": credit,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "rights_status": "editorial_review_required",
        "source_grade": "D",
        "official_source": False,
        "verified_source": False,
        "source_kind": "editor_upload",
        "image_source_url": source_url,
        "exact_match": False,
        "include_in_collage": True,
        "fallback_only": False,
        "notes": "Uploaded by an editor for this draft. Outfit identity, source credit, and publication rights require review.",
        "original_filename": Path(image.filename or "upload").name[:180],
        "upload_metadata": image_metadata,
    }
    case.extraction = {**extraction, "collage_assets": [*assets, asset_record]}
    db.add(AuditEvent(
        entity_type="case",
        entity_id=case.id,
        action="collage_asset_uploaded",
        actor=editor_id[:120],
        detail={"asset_id": asset_id, "image_path": image_path, "source_url": effective_source, "credit": credit},
    ))
    try:
        db.commit()
    except Exception:
        db.rollback()
        (Path(settings.media_dir) / image_path.removeprefix("/media-files/")).unlink(missing_ok=True)
        raise
    normalized = next(item for item in normalize_case_assets(case) if item["id"] == asset_id)
    return {"case_id": case.id, "asset": normalized}


@app.post("/api/cases/{case_id}/collage/watermark", status_code=201, dependencies=[Depends(require_editor)])
async def upload_collage_watermark(
    case_id: str,
    image: UploadFile = File(...),
    editor_id: str = Form("editor@atelier"),
    db: Session = Depends(get_db),
):
    case = db.get(Case, case_id)
    if not case or not case_content_eligible(case):
        raise HTTPException(404, "Case not found")
    editor_id = editor_id.strip()
    if len(editor_id) < 2 or len(editor_id) > 120:
        raise HTTPException(422, "Editor identifier must be between 2 and 120 characters")

    try:
        content = await image.read(MAX_WATERMARK_UPLOAD_BYTES + 1)
    finally:
        await image.close()
    file_key = f"watermark-{uuid.uuid4().hex}"
    try:
        image_path, image_metadata = store_watermark_image(content, settings.media_dir, file_key)
    except UploadValidationError as exc:
        raise HTTPException(422, str(exc)) from exc

    uploaded_at = datetime.now(timezone.utc).isoformat()
    asset_id = f"watermark-{uuid.uuid4().hex[:16]}"
    watermark_asset = {
        "id": asset_id,
        "image_path": image_path,
        "original_filename": Path(image.filename or "watermark").name[:180],
        "metadata": image_metadata,
        "uploaded_at": uploaded_at,
        "editor_id": editor_id,
    }
    extraction = case.extraction if isinstance(case.extraction, dict) else {}
    previous_edit = extraction.get("collage_edit") if isinstance(extraction.get("collage_edit"), dict) else {}
    previous_watermark = previous_edit.get("watermark") if isinstance(previous_edit.get("watermark"), dict) else {}
    watermark = {
        "enabled": True,
        "asset_id": asset_id,
        "image_path": image_path,
        "center_x": previous_watermark.get("center_x", 0.82),
        "center_y": previous_watermark.get("center_y", 0.9),
        "width": previous_watermark.get("width", 0.2),
        "height": previous_watermark.get("height"),
        "rotation_degrees": previous_watermark.get("rotation_degrees", 0),
        "opacity": previous_watermark.get("opacity", 0.72),
        "adjustments": previous_watermark.get("adjustments") if isinstance(previous_watermark.get("adjustments"), dict) else {
            "brightness": 1.0,
            "contrast": 1.0,
            "saturation": 1.0,
            "grayscale": 0.0,
        },
    }
    case.extraction = {
        **extraction,
        "watermark_asset": watermark_asset,
        "collage_edit": {
            **previous_edit,
            "watermark": watermark,
            "updated_at": uploaded_at,
            "editor_id": editor_id,
            "version": 4,
        },
    }
    db.add(AuditEvent(
        entity_type="case",
        entity_id=case.id,
        action="collage_watermark_uploaded",
        actor=editor_id,
        detail={"asset_id": asset_id, "image_path": image_path, "original_filename": watermark_asset["original_filename"]},
    ))
    try:
        db.commit()
    except Exception:
        db.rollback()
        (Path(settings.media_dir) / image_path.removeprefix("/media-files/")).unlink(missing_ok=True)
        raise
    return {"case_id": case.id, "asset": watermark_asset, "watermark": watermark}


@app.post("/api/cases/{case_id}/collage/edit", dependencies=[Depends(require_editor)])
def edit_collage(case_id: str, payload: CollageEditInput, db: Session = Depends(get_db)):
    case = db.scalar(
        select(Case)
        .where(Case.id == case_id)
        .options(selectinload(Case.candidates).selectinload(Candidate.decisions))
    )
    if not case or not case_content_eligible(case):
        raise HTTPException(404, "Case not found")

    catalog = build_panel_catalog(case, case.candidates, include_automation_matches=True)
    by_id = {str(item["id"]): item for item in catalog}
    unknown = [panel_id for panel_id in payload.panel_ids if panel_id not in by_id]
    if unknown:
        raise HTTPException(422, f"Unavailable collage panel: {unknown[0]}")
    selected = [by_id[panel_id] for panel_id in payload.panel_ids]
    unknown_options = [panel_id for panel_id in payload.panel_options if panel_id not in payload.panel_ids]
    if unknown_options:
        raise HTTPException(422, f"Layout settings reference an unselected panel: {unknown_options[0]}")
    if not any(item["role"] in {"current_primary", "current_angle"} for item in selected):
        raise HTTPException(422, "Keep at least one image from the current source post in the collage")

    extraction = case.extraction if isinstance(case.extraction, dict) else {}
    previous = extraction.get("collage_edit") if isinstance(extraction.get("collage_edit"), dict) else {}
    edited_at = datetime.now(timezone.utc).isoformat()
    panel_options = {
        panel_id: option.model_dump()
        for panel_id, option in payload.panel_options.items()
    }
    watermark_asset = extraction.get("watermark_asset") if isinstance(extraction.get("watermark_asset"), dict) else None
    if payload.watermark is not None:
        if not watermark_asset or not isinstance(watermark_asset.get("image_path"), str):
            raise HTTPException(422, "Upload the HHC watermark before enabling or positioning it")
        watermark = {
            **payload.watermark.model_dump(),
            "asset_id": watermark_asset.get("id"),
            "image_path": watermark_asset["image_path"],
        }
    else:
        watermark = previous.get("watermark") if isinstance(previous.get("watermark"), dict) else None
    case.extraction = {
        **extraction,
        "collage_edit": {
            "panel_ids": payload.panel_ids,
            "panel_options": panel_options,
            "collage_adjustments": payload.collage_adjustments.model_dump(),
            "watermark": watermark,
            "updated_at": edited_at,
            "editor_id": payload.editor_id,
            "version": 4,
        },
    }
    try:
        collage = render_draft_collage(
            db,
            case,
            case.candidates,
            settings,
            STATIC_DIR,
            editor_id=payload.editor_id,
            reason="Editor customized the source-backed panel selection and order; this remains a non-publishing draft.",
            decision_type="editor_draft",
        )
    except (FileNotFoundError, ValueError) as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc

    case.extraction = {
        **case.extraction,
        "automatic_collage": {"id": collage.id, "panels": len(selected)},
    }
    db.add(
        AuditEvent(
            entity_type="case",
            entity_id=case.id,
            action="collage_layout_edited",
            actor=payload.editor_id,
            detail={
                "collage_id": collage.id,
                "previous_panel_ids": previous.get("panel_ids", []),
                "panel_ids": payload.panel_ids,
                "panel_options": panel_options,
                "previous_collage_adjustments": previous.get("collage_adjustments"),
                "collage_adjustments": payload.collage_adjustments.model_dump(),
                "previous_watermark": previous.get("watermark"),
                "watermark": watermark,
                "panel_count": len(selected),
            },
        )
    )
    db.commit()
    return {
        "id": collage.id,
        "preview_url": f"/outputs/case-{case.id}/collage.webp",
        "base_preview_url": f"/outputs/case-{case.id}/collage-base.webp",
        "source_preview_url": f"/outputs/case-{case.id}/collage-source.webp",
        "bundle_url": f"/api/cases/{case.id}/bundle",
        "asset_count": len(selected),
        "selected_ids": payload.panel_ids,
        "panel_options": panel_options,
        "collage_adjustments": payload.collage_adjustments.model_dump(),
        "watermark": watermark,
        "updated_at": edited_at,
    }


@app.get("/api/cases/{case_id}/bundle")
def download_bundle(case_id: str, db: Session = Depends(get_db)):
    case = db.get(Case, case_id)
    if not case or not case_content_eligible(case):
        raise HTTPException(404, "Case not found")
    collage = db.scalar(select(Collage).where(Collage.case_id == case_id).order_by(Collage.created_at.desc()))
    if not collage or not os.path.exists(collage.bundle_path):
        raise HTTPException(404, "No collage bundle exists")
    return FileResponse(collage.bundle_path, filename=f"case-{case_id}-bundle.zip", media_type="application/zip")


@app.post("/api/runs/daily", dependencies=[Depends(require_editor)])
def daily_run(target_date: date | None = Query(default=None), db: Session = Depends(get_db)):
    if settings.reddit_source_mode not in {"rss", "live", "approved_api"}:
        raise HTTPException(status_code=409, detail="Set REDDIT_SOURCE_MODE=rss to enable daily automation")
    try:
        return run_daily_automation(db, settings, STATIC_DIR, trigger="editor", target_date=target_date)
    except AutomationError as exc:
        raise HTTPException(status_code=502, detail=f"Daily automation failed: {exc}") from exc
