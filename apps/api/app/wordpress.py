"""Explicit, review-gated WordPress draft handoff with duplicate recovery."""
import html
import json
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
import requests
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session
from .config import get_settings
from .database import get_db
from .editorial import locked_state
from .models import AuditEvent, Candidate, Case, Collage, EditorSession, ServiceState, StoryDraft
from .review import approval_errors
from .security import current_actor

router = APIRouter(prefix="/api")

def wp_request(authorization, method, path, **kwargs):
    settings = get_settings()
    site = settings.wordpress_site_url.rstrip("/")
    parsed = urlparse(site)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise HTTPException(503, "WordPress must be configured with an HTTPS site URL")
    if not authorization.startswith("Basic "):
        raise HTTPException(401, "Sign in with your WordPress Application Password to connect")
    try:
        response = requests.request(method, f"{site}/wp-json/wp/v2/{path}", headers={"Authorization": authorization}, timeout=(10, 45), allow_redirects=False, **kwargs)
    except requests.RequestException:
        raise HTTPException(502, "WordPress did not confirm the request. Check its status before retrying.") from None
    if not response.ok or 300 <= response.status_code < 400:
        raise HTTPException(502, f"WordPress returned HTTP {response.status_code}; no retry was sent")
    try:
        return response.json()
    except ValueError:
        raise HTTPException(502, "WordPress returned an invalid response") from None

@router.get("/wordpress/connection")
def connection(x_wp_authorization: str = Header(default="")):
    if not x_wp_authorization:
        return {"connected": False, "enabled": get_settings().wordpress_publisher_enabled, "detail": "Sign in on WordPress when you send your draft."}
    user = wp_request(x_wp_authorization, "GET", "users/me", params={"context": "edit"})
    if not user.get("capabilities", {}).get("edit_posts") or not user.get("capabilities", {}).get("upload_files"):
        raise HTTPException(403, "WordPress edit_posts and upload_files permissions are required")
    return {"connected": True, "enabled": get_settings().wordpress_publisher_enabled, "site": get_settings().wordpress_site_url, "name": user.get("name")}

@router.get("/wordpress/taxonomy")
def taxonomy(search: str = "", x_wp_authorization: str = Header(default="")):
    params = {"per_page": 100, "search": search[:100], "hide_empty": False}
    return {kind: [{"id": item["id"], "name": html.unescape(item["name"])} for item in wp_request(x_wp_authorization, "GET", kind, params=params)] for kind in ("categories", "tags")}

def handoff_manifest(db, case_id):
    case = db.get(Case, case_id)
    story = db.get(StoryDraft, case_id)
    collage = db.scalar(select(Collage).where(Collage.case_id == case_id).order_by(Collage.created_at.desc()))
    if not case or not story or not collage:
        raise HTTPException(422, "Save the story and render its collage first")
    if case.demo_data or case.base_image.startswith("/static/"):
        raise HTTPException(422, "Demonstration cases cannot be sent to WordPress")
    if not story.title.strip() or not story.body.strip() or not story.alt_text.strip() or not story.credits.strip():
        raise HTTPException(422, "Add a title, story, image description and photo credits")
    if story.reviewed_collage_id != collage.id:
        raise HTTPException(422, "Confirm the sources and usage rights for the latest collage")
    manifest = json.loads(Path(collage.manifest_path).read_text(encoding="utf-8"))
    if manifest.get("outfit", {}).get("designer") != case.designer or manifest.get("outfit", {}).get("celebrity") != case.celebrity:
        raise HTTPException(422, "Attribution changed. Re-render this collage before sending it.")
    for panel in manifest["assets"]:
        if panel.get("rights_status") in {"do_not_use", "blocked", "unknown_blocked"}:
            raise HTTPException(422, "A selected image has blocked usage rights")
        if panel["role"].startswith("historical_"):
            candidate = db.get(Candidate, panel["id"])
            latest = max(candidate.decisions, key=lambda d: d.decided_at) if candidate and candidate.decisions else None
            if not candidate or not latest or latest.decision != "approved" or approval_errors(candidate):
                raise HTTPException(422, "Approve each historical match before the WordPress handoff")
    return story, collage, manifest


class HandoffInput(BaseModel):
    case_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,128}$")
    session_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    reconcile: bool = False


def require_handoff_session(db, session_id):
    session = db.get(EditorSession, session_id)
    if not session or session.expires_at.replace(tzinfo=timezone.utc).timestamp() <= time.time():
        raise HTTPException(401, "Your studio session expired. Return to the editor.")
    return session


@router.post("/internal/wordpress-handoffs")
def prepare_handoff(payload: HandoffInput, db: Session = Depends(get_db)):
    if not get_settings().wordpress_publisher_enabled:
        raise HTTPException(409, "WordPress draft sending is not enabled")
    require_handoff_session(db, payload.session_id)
    if payload.reconcile:
        story = db.get(StoryDraft, payload.case_id)
        if not story:
            raise HTTPException(404, "Save your story first")
        collage_id = story.reviewed_collage_id
    else:
        story, collage, _ = handoff_manifest(db, payload.case_id)
        collage_id = collage.id
        if story.sync_state in {"sending", "uncertain"}:
            raise HTTPException(409, "Use Check previous handoff before sending again")
    identifier = secrets.token_hex(32)
    expires_at = int(time.time()) + 900
    db.add(ServiceState(key=f"wordpress-handoff:{identifier}", value={
        "case_id": payload.case_id, "session_id": payload.session_id,
        "revision": story.revision, "collage_id": collage_id,
        "reconcile": payload.reconcile, "expires_at": expires_at, "used": False,
    }))
    db.commit()
    return {"id": identifier, "expires_at": expires_at}


@router.post("/internal/wordpress-handoffs/{identifier}/complete")
def complete_handoff(identifier: str, x_wp_authorization: str = Header(default=""), db: Session = Depends(get_db)):
    state = db.scalar(select(ServiceState).where(ServiceState.key == f"wordpress-handoff:{identifier}").with_for_update())
    if not state or state.value.get("used") or state.value.get("expires_at", 0) <= time.time():
        raise HTTPException(409, "This WordPress handoff expired or has already been used")
    flow = state.value
    require_handoff_session(db, flow["session_id"])
    locked_state(db, f"story:{flow['case_id']}", {})
    if not flow["reconcile"]:
        story, collage, _ = handoff_manifest(db, flow["case_id"])
        if story.revision != flow["revision"] or collage.id != flow["collage_id"]:
            raise HTTPException(409, "The story changed during sign-in. Review it and send again.")
    state.value = {**flow, "used": True}
    # The draft operation commits this single-use claim along with its sending
    # state, while holding the story lock. Replayed callbacks cannot send twice.
    return reconcile(flow["case_id"], x_wp_authorization, db) if flow["reconcile"] else send_draft(flow["case_id"], x_wp_authorization, db)

@router.post("/cases/{case_id}/wordpress")
def send_draft(case_id: str, x_wp_authorization: str = Header(default=""), db: Session = Depends(get_db)):
    settings = get_settings()
    if not settings.wordpress_publisher_enabled:
        raise HTTPException(409, "Enable WORDPRESS_PUBLISHER_ENABLED after connecting the client site")
    if not connection(x_wp_authorization).get("connected"):
        raise HTTPException(401, "Sign in with your WordPress Application Password before sending a draft")
    locked_state(db, f"story:{case_id}", {})
    story, collage, manifest = handoff_manifest(db, case_id)
    site = settings.wordpress_site_url.rstrip("/")
    if story.wordpress_site and story.wordpress_site != site:
        raise HTTPException(409, "This story belongs to a different WordPress site")
    slug = f"hhc-research-{case_id}"
    if story.sync_state in {"sending", "uncertain"}:
        raise HTTPException(409, "A previous handoff may have reached WordPress. Use Check handoff before trying again.")
    story.sync_state = "sending"
    story.wordpress_site = site
    db.commit()
    try:
        existing = wp_request(x_wp_authorization, "GET", "posts", params={"slug": slug, "status": "any", "context": "edit"})
        if existing:
            story.wordpress_post_id = existing[0]["id"]
            if existing[0]["status"] not in {"draft", "pending"}:
                raise HTTPException(409, "This story has been published or scheduled in WordPress. Edit it there.")
        media_slug = f"hhc-collage-{collage.id}"
        media = wp_request(x_wp_authorization, "GET", "media", params={"slug": media_slug, "context": "edit"})
        if media:
            attachment = media[0]
        else:
            image_path = Path(collage.image_path)
            with image_path.open("rb") as source:
                attachment = wp_request(x_wp_authorization, "POST", "media", files={"file": (f"{media_slug}.webp", source, "image/webp")}, data={"slug": media_slug, "alt_text": story.alt_text, "caption": story.credits})
        story.wordpress_media_id = int(attachment["id"])
        db.commit()
        paragraphs = "\n".join(f"<p>{html.escape(p).replace(chr(10), '<br>')}</p>" for p in story.body.split("\n\n") if p.strip())
        image_url = html.escape(attachment["source_url"], quote=True)
        content = f'<figure class="wp-block-image"><img src="{image_url}" alt="{html.escape(story.alt_text, quote=True)}"/><figcaption>{html.escape(story.credits)}</figcaption></figure>\n{paragraphs}'
        payload = {"slug": slug, "title": story.title, "content": content, "status": "draft", "featured_media": attachment["id"], "categories": story.category_ids, "tags": story.tag_ids}
        target = f"posts/{story.wordpress_post_id}" if story.wordpress_post_id else "posts"
        post = wp_request(x_wp_authorization, "POST", target, json=payload)
        story.wordpress_post_id = int(post["id"])
        story.sync_state = "draft_created"
        db.add(AuditEvent(entity_type="case", entity_id=case_id, action="wordpress_draft_sent", actor=current_actor(), detail={"post_id": post["id"], "collage_id": collage.id, "story_revision": story.revision}))
        db.commit()
        return {"post_id": post["id"], "status": "draft", "edit_url": f"{site}/wp-admin/post.php?post={post['id']}&action=edit"}
    except Exception:
        db.rollback()
        story = db.get(StoryDraft, case_id)
        story.sync_state = "uncertain"
        db.commit()
        raise

@router.post("/cases/{case_id}/wordpress/reconcile")
def reconcile(case_id: str, x_wp_authorization: str = Header(default=""), db: Session = Depends(get_db)):
    locked_state(db, f"story:{case_id}", {})
    story = db.get(StoryDraft, case_id)
    if not story:
        raise HTTPException(404, "Story not found")
    if story.sync_state == "sending" and (datetime.now(timezone.utc) - story.updated_at.replace(tzinfo=timezone.utc)).total_seconds() < 300:
        raise HTTPException(409, "The handoff is still running. Allow it to finish before checking again.")
    posts = wp_request(x_wp_authorization, "GET", "posts", params={"slug": f"hhc-research-{case_id}", "status": "any", "context": "edit"})
    if not posts:
        raise HTTPException(409, "No matching post found. Check WordPress media and drafts before an administrator resets this handoff.")
    story.wordpress_post_id = posts[0]["id"]
    story.sync_state = "draft_created" if posts[0]["status"] in {"draft", "pending"} else "managed_in_wordpress"
    db.commit()
    return {"post_id": story.wordpress_post_id, "status": story.sync_state, "edit_url": f"{get_settings().wordpress_site_url.rstrip('/')}/wp-admin/post.php?post={story.wordpress_post_id}&action=edit"}
