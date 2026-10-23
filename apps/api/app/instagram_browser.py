import hashlib
import json
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .automation import render_draft_collage
from .config import get_settings
from .database import get_db
from .editor_uploads import MAX_UPLOAD_BYTES, UploadValidationError, store_editor_image
from .storage import get_storage
from .uploads import staged_uploads
from .editorial import locked_state
from .models import AuditEvent, Case, Collage, ServiceState, StoryDraft
from .assets import build_render_assets
from .publication_dates import is_recent_post, publication_stamp
from .security import current_actor

router = APIRouter(prefix="/api/instagram-browser")
CONFIG_KEY = "instagram-browser:config"
RUN_KEY = "instagram-browser:run"
RUNNER_KEY = "instagram-browser:runner"


def active_run(value):
    return value.get("status") in {"queued", "awaiting_login", "running"} and time.time() - value.get("heartbeat", 0) < 180


class Celebrity(BaseModel):
    name: str = Field(min_length=2, max_length=180)
    handle: str = Field(pattern=r"^[A-Za-z0-9._]{1,30}$")
    enabled: bool = True


class Brand(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    handles: list[str] = Field(default_factory=list, max_length=10)
    aliases: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("handles")
    @classmethod
    def valid_handles(cls, values):
        if any(not re.fullmatch(r"[A-Za-z0-9._]{1,30}", value) for value in values):
            raise ValueError("Brand handles must be usernames without @")
        return values

    @field_validator("aliases")
    @classmethod
    def valid_aliases(cls, values):
        if any(not 2 <= len(value.strip()) <= 100 for value in values):
            raise ValueError("Brand aliases must be between 2 and 100 characters")
        return values


class BrowserConfig(BaseModel):
    enabled: bool = True
    celebrities: list[Celebrity] = Field(max_length=200)
    brands: list[Brand] = Field(max_length=300)

    @model_validator(mode="after")
    def unique_handles(self):
        handles = [person.handle.casefold() for person in self.celebrities]
        if len(handles) != len(set(handles)):
            raise ValueError("Celebrity handles must be unique")
        return self


def default_config():
    labels = [
        ("Manish Malhotra", ["manishmalhotra", "manishmalhotraworld"]),
        ("Sabyasachi", ["sabyasachiofficial"]), ("Saint Laurent", ["ysl"]),
        ("Gucci", ["gucci"]), ("Dior", ["dior"]), ("Chanel", ["chanelofficial"]),
        ("Louis Vuitton", ["louisvuitton"]), ("Versace", ["versace"]),
        ("Prada", ["prada"]), ("Valentino", ["maisonvalentino"]),
        ("Givenchy", ["givenchy"]), ("Armani", ["giorgioarmani", "emporioarmani"]),
        ("Anita Dongre", ["anitadongre"]), ("Tarun Tahiliani", ["taruntahiliani"]),
        ("Rahul Mishra", ["rahulmishra_7"]), ("Gaurav Gupta", ["gauravguptaofficial"]),
        ("Falguni Shane Peacock", ["falgunishanepeacockindia"]),
        ("Abu Jani Sandeep Khosla", ["abujanisandeepkhosla"]),
        ("House of CB", ["houseofcb"]), ("Uniqlo", ["uniqlo", "uniqloin"]),
        ("Zara", ["zara"]), ("H&M", ["hm"]), ("Swarovski", ["swarovski"]),
        ("Tiffany & Co", ["tiffanyandco"]), ("Bulgari", ["bulgari"]),
    ]
    celebrities = json.loads(Path(__file__).with_name("instagram_watchlist.json").read_text(encoding="utf-8"))
    return BrowserConfig(celebrities=celebrities, brands=[Brand(name=name, handles=handles) for name, handles in labels])


def config_for(db):
    state = db.get(ServiceState, CONFIG_KEY)
    return BrowserConfig.model_validate(state.value) if state else default_config()


def brand_mentions(caption, tags, brands):
    mentioned = {value.casefold() for value in re.findall(r"(?<!\w)@([A-Za-z0-9._]+)", caption)}
    tagged = {value.casefold().lstrip("@") for value in tags}
    matches = []
    for brand in brands:
        handles = {handle.casefold() for handle in brand.handles}
        evidence = [f"@{handle}" for handle in sorted(handles & (mentioned | tagged))]
        for alias in [brand.name, *brand.aliases]:
            if re.search(r"(?<![\w@])" + re.escape(alias.strip()) + r"(?!\w)", caption, re.I):
                evidence.append(alias)
        if evidence:
            matches.append({"name": brand.name, "evidence": sorted(set(evidence))})
    return matches


class BrowserPost(BaseModel):
    handle: str = Field(pattern=r"^[A-Za-z0-9._]{1,30}$")
    shortcode: str = Field(pattern=r"^[A-Za-z0-9_-]{1,32}$")
    published_at: str = Field(max_length=50)
    caption: str = Field(max_length=5000)
    tagged_handles: list[str] = Field(default_factory=list, max_length=100)
    media_type: str = Field(pattern=r"^IMAGE$")
    date_evidence: str = Field(pattern=r"^post_permalink_time$")
    image_keys: list[str] = Field(default_factory=list, max_length=20)
    carousel_complete: bool = False
    videos_skipped: int = Field(default=0, ge=0, le=20)

    @field_validator("image_keys")
    @classmethod
    def valid_image_keys(cls, values):
        if any(not re.fullmatch(r"[a-f0-9]{64}", value) for value in values):
            raise ValueError("Invalid carousel image identifier")
        if len(values) != len(set(values)):
            raise ValueError("Carousel image identifiers must be unique")
        return values


def eligible_post(payload, config, timezone_name, now=None):
    if not config.enabled:
        raise ValueError("Daily Instagram intake is paused")
    person = next((person for person in config.celebrities if person.enabled and person.handle.casefold() == payload.handle.casefold()), None)
    if not person:
        raise ValueError("Account is not enabled in the celebrity watchlist")
    _, precision = publication_stamp(payload.published_at, timezone_name)
    if precision != "time" or not is_recent_post(payload.published_at, timezone_name, now):
        raise ValueError("Only verified posts published today or yesterday qualify")
    matches = brand_mentions(payload.caption, payload.tagged_handles, config.brands)
    if not matches:
        raise ValueError("No recognized brand or designer was tagged or mentioned")
    return person, matches


@router.get("/config")
def get_config(db: Session = Depends(get_db)):
    return {**config_for(db).model_dump(), "timezone": get_settings().reddit_daily_timezone, "daily_time": "09:00", "coverage": "Editable starter watchlist; not all Bollywood accounts"}


@router.post("/config")
def save_config(payload: BrowserConfig, db: Session = Depends(get_db)):
    state = locked_state(db, CONFIG_KEY, {})
    state.value = payload.model_dump()
    db.add(AuditEvent(entity_type="instagram_browser", entity_id="config", action="watchlist_updated", actor=current_actor(), detail={"accounts": len(payload.celebrities), "brands": len(payload.brands), "enabled": payload.enabled}))
    db.commit()
    return payload


@router.get("/status")
def status(db: Session = Depends(get_db)):
    state = db.get(ServiceState, RUN_KEY)
    value = dict(state.value) if state else {"status": "not_run"}
    runner = db.get(ServiceState, RUNNER_KEY)
    value["runner_online"] = bool(runner and time.time() - runner.value.get("heartbeat", 0) < 180) or (value.get("status") in {"awaiting_login", "running"} and active_run(value))
    if value.get("status") in {"queued", "awaiting_login", "running"} and not active_run(value):
        value.update(status="interrupted", detail="The local collector stopped responding. Check that this computer and the app are running, then scan again.")
    return value


@router.post("/scan", status_code=202)
def queue_scan(db: Session = Depends(get_db)):
    config = config_for(db)
    if not config.enabled or not any(person.enabled for person in config.celebrities):
        raise HTTPException(409, "Enable intake and at least one celebrity in Watchlist settings first.")
    state = locked_state(db, RUN_KEY, {})
    if active_run(state.value):
        return state.value
    runner = db.get(ServiceState, RUNNER_KEY)
    if not runner or time.time() - runner.value.get("heartbeat", 0) >= 180:
        raise HTTPException(503, "The local Instagram collector is offline. Start the HHC Instagram Requests task in Windows Task Scheduler, with Docker running and this Windows user signed in.")
    state.value = {"run_id": str(uuid.uuid4()), "status": "queued", "heartbeat": time.time(), "updated_at": datetime.now(timezone.utc).isoformat(), "accounts_checked": 0, "posts_checked": 0, "imported": 0, "detail": "Opening Instagram in a separate window. Sign in there; the scan will start automatically.", "exclusions": {}}
    db.add(AuditEvent(entity_type="instagram_browser", entity_id=state.value["run_id"], action="scan_requested", actor=current_actor(), detail={"scope": "all_enabled_accounts"}))
    db.commit()
    return state.value


@router.post("/heartbeat")
def runner_heartbeat(db: Session = Depends(get_db)):
    runner = locked_state(db, RUNNER_KEY, {})
    runner.value = {"heartbeat": time.time()}
    db.commit()
    return {"ok": True}


@router.post("/claim")
def claim_scan(db: Session = Depends(get_db)):
    state = locked_state(db, RUN_KEY, {})
    runner = locked_state(db, RUNNER_KEY, {})
    runner.value = {"heartbeat": time.time()}
    claimed = None
    if state.value.get("status") == "queued" and active_run(state.value):
        if config_for(db).enabled:
            state.value = {**state.value, "status": "running", "heartbeat": time.time(), "detail": "Opening the signed-in Instagram browser."}
            claimed = state.value
        else:
            state.value = {**state.value, "status": "paused", "detail": "Intake was paused before collection started."}
    db.commit()
    return {"run": claimed}


@router.get("/posts")
def recent_posts(db: Session = Depends(get_db)):
    cases = db.scalars(select(Case).where(Case.external_id.like("instagram-browser:%")).order_by(Case.created_at.desc()).limit(500)).all()
    results = []
    for case in cases:
        extraction = case.extraction or {}
        if is_recent_post(extraction.get("published_at"), get_settings().reddit_daily_timezone):
            collage = db.scalar(select(Collage).where(Collage.case_id == case.id).order_by(Collage.created_at.desc()).limit(1))
            carousel = extraction.get("instagram_carousel") or {}
            preview = "/outputs/" + Path(collage.image_path).resolve().relative_to(Path(get_settings().output_dir).resolve()).as_posix() if collage else None
            results.append({"id": case.id, "celebrity": case.celebrity, "base_image": case.base_image, "collage_image": preview,
                "photo_count": carousel.get("photo_count", 1), "carousel_complete": carousel.get("complete", False),
                "permalink": case.permalink, "published_at": extraction["published_at"], "brands": [item["name"] for item in extraction.get("brand_mentions", [])]})
    results.sort(key=lambda item: item["published_at"], reverse=True)
    return {"results": results[:100]}


class RunReport(BaseModel):
    run_id: str = Field(pattern=r"^[a-zA-Z0-9-]{1,64}$")
    status: str = Field(pattern=r"^(awaiting_login|running|completed|partial|blocked|failed|paused|cancelled)$")
    accounts_checked: int = Field(default=0, ge=0, le=200)
    posts_checked: int = Field(default=0, ge=0, le=2400)
    imported: int = Field(default=0, ge=0, le=2400)
    updated: int = Field(default=0, ge=0, le=2400)
    detail: str = Field(default="", max_length=1000)
    exclusions: dict[str, int] = Field(default_factory=dict, max_length=20)
    current_account: str = Field(default="", max_length=180)
    accounts_total: int = Field(default=0, ge=0, le=200)
    dry_run: bool = False


@router.post("/runs")
def report_run(payload: RunReport, db: Session = Depends(get_db)):
    state = locked_state(db, RUN_KEY, {})
    previous = state.value
    if active_run(previous) and previous.get("run_id") != payload.run_id:
        raise HTTPException(409, "Another local collector is running")
    state.value = {**payload.model_dump(), "heartbeat": time.time(), "updated_at": datetime.now(timezone.utc).isoformat()}
    db.commit()
    return state.value


@router.post("/posts")
async def import_post(metadata: str = Form(..., max_length=15000), image: UploadFile | None = File(None), images: list[UploadFile] = File(default=[]),
        upload_keys: str = Form(""), db: Session = Depends(get_db)):
    settings = get_settings()
    uploads = [image, *images] if image is not None else staged_uploads(upload_keys)
    if not uploads:
        raise HTTPException(422, "Send at least one photo")
    try:
        payload = BrowserPost.model_validate_json(metadata)
        person, matches = eligible_post(payload, config_for(db), settings.reddit_daily_timezone)
        if len(uploads) > 20 or (payload.image_keys and len(payload.image_keys) != len(uploads)):
            raise ValueError("Supply one image identifier per photo, with at most 20 photos")
        if len(uploads) > 1 and not payload.image_keys:
            raise ValueError("Carousel photos require stable image identifiers")
    except (ValidationError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc
    permalink = f"https://www.instagram.com/p/{payload.shortcode}/"
    locked_state(db, f"instagram-post:{payload.shortcode}", {})
    case = db.scalar(select(Case).where(Case.permalink == permalink).with_for_update())
    existing = case is not None
    if case and (case.extraction or {}).get("provider") != "instagram_browser":
        return {"case_id": case.id, "duplicate": True}
    if case and not payload.image_keys:
        return {"case_id": case.id, "duplicate": True}
    if case:
        story = db.get(StoryDraft, case.id)
        if story and story.sync_state == "sending":
            raise HTTPException(409, "Wait for the WordPress handoff before expanding this collage")
    paths = []
    retained = set()
    try:
        total_bytes = 0
        captures = []
        for index, upload in enumerate(uploads):
            content = await upload.read(MAX_UPLOAD_BYTES + 1)
            total_bytes += len(content)
            if total_bytes > 22 * 1024 * 1024:
                raise UploadValidationError("Combined carousel photos must be 22 MB or smaller")
            path, info = store_editor_image(content, settings.media_dir, uuid.uuid4().hex)
            paths.append(path)
            key = payload.image_keys[index] if payload.image_keys else hashlib.sha256(content).hexdigest()
            captures.append({"key": key, "image_path": path, "metadata": info})
        stamp, _ = publication_stamp(payload.published_at, settings.reddit_daily_timezone)
        published_date = stamp.astimezone(ZoneInfo(settings.reddit_daily_timezone)).date().isoformat()
        retrieved_at = datetime.now(timezone.utc).isoformat()
        if not case:
            case = Case(source_type="public_post_url", external_id=f"instagram-browser:{payload.shortcode}", permalink=permalink,
                source_title=f"{person.name} — Instagram photo", source_body=payload.caption, celebrity=person.name,
                designer=" + ".join(match["name"] for match in matches)[:180], event_name="Instagram post — attribution needs review",
                event_date=published_date, base_image=captures[0]["image_path"], status="context_review", match_type="source_only", confidence=0.5,
                extraction={"provider": "instagram_browser", "source_platform": "Instagram", "source_author": payload.handle,
                    "source_publisher": f"Instagram / {payload.handle}", "published_at": stamp.isoformat(), "browser_observed": True,
                    "brand_mentions": matches, "attribution_status": "Mention/tag only; not a verified outfit attribution",
                    "publication": {"published_date": published_date, "date_precision": "time", "date_evidence": payload.date_evidence},
                    "rights_review_required": True, "collage_assets": []})
            db.add(case)
            db.flush()
            retained.add(case.base_image)
        extraction = dict(case.extraction or {})
        cover_refreshed = existing and bool(payload.image_keys) and (extraction.get("image_capture") or {}).get("scope") == "post_cover_only"
        if cover_refreshed:
            case.base_image = captures[0]["image_path"]
            retained.add(case.base_image)
        assets = list(extraction.get("collage_assets", []))
        previous = extraction.get("instagram_carousel") or {}
        known = list(previous.get("images", []))
        if not known:
            known.append({**captures[0], "image_path": case.base_image})
        elif payload.image_keys and (extraction.get("image_capture") or {}).get("scope") == "post_cover_only" and len(known) == 1:
            known[0] = captures[0]
        known_keys = {item["key"] for item in known}
        added_ids = []
        for capture in captures:
            if capture["key"] in known_keys:
                continue
            known_keys.add(capture["key"])
            known.append(capture)
            retained.add(capture["image_path"])
            asset_id = f"instagram-photo-{capture['key'][:24]}"
            added_ids.append(asset_id)
            assets.append({"id": asset_id, "role": "current_angle", "label": f"Instagram post / photo {len(known)}",
                "person": case.celebrity, "designer": case.designer, "image_path": capture["image_path"],
                "source_url": permalink, "publisher": f"Instagram / {payload.handle}", "credit": "Original photographer credit requires confirmation",
                "retrieved_at": retrieved_at, "rights_status": "editorial_review_required", "source_grade": "D",
                "source_kind": "instagram_source", "exact_match": True, "include_in_collage": True,
                "notes": "Photo captured from the same Instagram carousel; attribution and rights require review."})
        complete = bool(previous.get("complete")) or payload.carousel_complete
        edit = dict(extraction.get("collage_edit") or {})
        if (added_ids or cover_refreshed) and edit:
            if isinstance(edit.get("panel_ids"), list):
                edit["panel_ids"] = [*edit["panel_ids"], *added_ids]
            edit["revision"] = int(edit.get("revision", 0)) + 1
        case.extraction = {**extraction, "retrieved_at": retrieved_at, "collage_assets": assets,
            "instagram_carousel": {"images": known, "photo_count": len(known), "complete": complete,
                "videos_skipped": max(previous.get("videos_skipped", 0), payload.videos_skipped)},
            "image_capture": {**captures[0]["metadata"], "kind": "browser_screenshot", "scope": "post_carousel" if payload.image_keys else "post_cover_only"},
            **({"collage_edit": edit} if edit else {})}
        if not existing or added_ids or cover_refreshed:
            candidates = [candidate for candidate in case.candidates if candidate.status != "automation_draft_anchor"]
            panel_count = len(build_render_assets(case, candidates, include_automation_matches=True, panel_ids=edit.get("panel_ids")))
            if getattr(settings, "collage_render_on_pull", False):
                collage = render_draft_collage(db, case, candidates, settings, str(Path(__file__).parent / "static"),
                    reason="Photos captured from the same browser-observed Instagram carousel. Brand attribution, outfit identity and publication rights require review.")
                case.extraction = {**case.extraction, "automatic_collage": {"id": collage.id, "panels": panel_count}}
            else:
                case.extraction = {**case.extraction, "automatic_collage": {"id": None, "panels": panel_count, "pending": True}}
        db.add(AuditEvent(entity_type="case", entity_id=case.id, action="instagram_carousel_expanded" if existing else "instagram_browser_imported",
            actor=current_actor(), detail={"source": permalink, "photo_count": len(known), "complete": complete, "added": len(added_ids)}))
        db.commit()
        return {"case_id": case.id, "duplicate": existing and not added_ids and not cover_refreshed, "updated": existing and (bool(added_ids) or cover_refreshed), "photo_count": len(known), "carousel_complete": complete}
    except UploadValidationError as exc:
        db.rollback()
        retained.clear()
        raise HTTPException(422, str(exc)) from exc
    except Exception:
        db.rollback()
        retained.clear()
        raise
    finally:
        for path in paths:
            if path not in retained:
                get_storage().delete(Path(settings.media_dir) / "editor" / Path(path).name)
