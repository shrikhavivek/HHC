"""Case-specific Instagram research; hashtag hits are leads, never collage panels."""
import hashlib
import json
import re
import time
import unicodedata
import uuid
from datetime import datetime, timezone
from urllib.parse import urlencode, urlsplit

import requests
from bs4 import BeautifulSoup
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .automation import GARMENT_LANDMARKS, COLOR_LANDMARKS, DETAIL_LANDMARKS, UNKNOWN_VALUES
from .database import get_db
from .config import get_settings
from .editorial import locked_state
from .instagram_browser import RUN_KEY, RUNNER_KEY, active_run, brand_mentions, config_for
from .models import AuditEvent, Case, ServiceState
from .security import current_actor
from .public_sources import MAX_DOCUMENT_BYTES, PublicSourceError, _fetch_limited, extract_public_metadata

router = APIRouter(prefix="/api/instagram-browser")
MAX_TAGS = 6
MAX_LEADS = 24


def compact(value):
    value = unicodedata.normalize("NFKD", value).casefold()
    return re.sub(r"[^a-z0-9]", "", value)


def identity_terms(case, config):
    names = [case.celebrity]
    handles = []
    for person in config.celebrities:
        if compact(person.name) == compact(case.celebrity):
            names.append(person.name)
            handles.append(person.handle)
    tokens = [token for name in names for token in re.findall(r"[a-z]+", name.casefold()) if len(token) >= 3]
    return sorted({compact(value) for value in [*names, *handles, *tokens] if compact(value)})


def mentions_identity(value, excluded, hashtag=False):
    normalized = compact(value)
    words = {compact(word) for word in re.findall(r"[\w.-]+", value)}
    compounds = [normalized] if hashtag else [compact(word) for word in re.findall(r"[#@]([\w.-]+)", value)]
    # Short names need word boundaries: 'Alia' must not exclude 'Italian silk'.
    return any(term in words or (len(term) >= 6 and term in normalized)
        or any(word.startswith(term) or word.endswith(term) for word in compounds) for term in excluded)


def context_fingerprint(case):
    return hashlib.sha256(json.dumps(["all-hashtags-v2", case.celebrity, case.designer, case.source_title, case.source_body,
        (case.extraction or {}).get("context_revision", 0)], ensure_ascii=False).encode()).hexdigest()


def contains_all_hashtags(caption, required):
    text = re.sub(r"https?://\S+", "", unicodedata.normalize("NFKC", caption))
    observed = {tag.casefold() for tag in re.findall(r"(?<![\w#])#(\w+)", text)}
    return bool(required) and all(tag.casefold() in observed for tag in required)


def validate_hashtags(values, excluded):
    hashtags = []
    for value in values:
        value = value.strip().lstrip("#")
        if not re.fullmatch(r"[A-Za-z0-9_]{2,80}", value) or value.isdigit():
            raise HTTPException(422, "Use hashtags with 2–80 letters, numbers or underscores, without spaces.")
        if mentions_identity(value, excluded, hashtag=True):
            raise HTTPException(422, "Remove the source celebrity's name or handle from the hashtags.")
        if value.casefold() not in hashtags:
            hashtags.append(value.casefold())
    return hashtags


def combined_google_query(hashtags, excluded):
    return 'site:instagram.com/p/ ' + " ".join('"#' + tag + '"' for tag in hashtags) + " " + " ".join('-"' + term + '"' for term in excluded)


def public_post_caption(url, settings):
    final_url, content, content_type = _fetch_limited(url, user_agent=settings.source_import_user_agent,
        allowed_domains={"instagram.com"}, source_document=True, maximum_bytes=MAX_DOCUMENT_BYTES,
        accept="text/html,application/xhtml+xml", timeout=8)
    final = urlsplit(final_url)
    original = urlsplit(url)
    if final.hostname not in {"instagram.com", "www.instagram.com"} or final.path.strip("/") != original.path.strip("/") or content_type not in {"text/html", "application/xhtml+xml"}:
        raise PublicSourceError("Post caption could not be verified")
    markup = content.decode("utf-8", "replace")
    soup = BeautifulSoup(markup, "html.parser")
    if soup.select('input[type="password"], form[action*="challenge"], form[action*="captcha"], meta[property="og:video"], video'):
        raise PublicSourceError("Post caption could not be verified")
    metadata = extract_public_metadata(markup, final_url)
    header = re.match(r'^(?:[\d.,]+\s*[KMB]?\s+likes?,\s*[\d.,]+\s*[KMB]?\s+comments?\s*-\s*)?([A-Za-z0-9._]+)\s+on\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}:\s*([\s\S]*)', metadata["description"], re.I)
    if not header or not metadata["image_urls"]:
        raise PublicSourceError("Post caption could not be verified")
    return {"author": header[1], "caption": header[2].strip().strip('"')[:5000]}


def hashtag_plan(case, config):
    excluded = identity_terms(case, config)
    text = re.sub(r"https?://\S+", "", f"{case.source_title}\n{case.source_body}")
    # Names must not accidentally become garment/colour evidence.
    text = re.sub(re.escape(case.celebrity), " ", text, flags=re.I)
    tags = []

    def add(term, reason):
        tag = compact(term)
        if 2 <= len(tag) <= 80 and not tag.isdigit() and not mentions_identity(tag, excluded, hashtag=True) and not any(item["tag"] == tag for item in tags):
            tags.append({"tag": tag, "reason": reason, "url": f"https://www.instagram.com/explore/tags/{tag}/"})

    designers = []
    for term in re.split(r"\s*(?:\+|,)\s*", case.designer):
        if term.strip().casefold() not in UNKNOWN_VALUES and not mentions_identity(term, excluded, hashtag=True):
            designers.append(term.strip())
            add(term, "Designer / maker recorded for this look")
    for brand in brand_mentions(text, [], config.brands):
        designers.append(brand["name"])
        add(brand["name"], "Brand / maker mentioned in the source")

    def hits(vocabulary):
        matches = {}
        for variants in vocabulary.values():
            for variant in sorted(variants):
                match = re.search(r"(?<!\w)" + re.escape(variant) + r"(?!\w)", text, re.I)
                if match:
                    matches[variant] = match.start()
        return sorted(matches, key=lambda variant: (matches[variant], -len(variant), variant))

    garments = hits(GARMENT_LANDMARKS)
    colours = hits(COLOR_LANDMARKS)
    details = hits(DETAIL_LANDMARKS)
    # Focused combinations first, with broad garment tags available afterwards.
    for garment in garments[:3]:
        for designer in designers[:2]:
            add(designer + garment, "Designer + garment")
        for detail in details[:2]:
            add(detail + garment, "Fabric / construction + garment")
        for colour in colours[:2]:
            add(colour + garment, "Colour + garment")
        add(garment, "Garment mentioned in the source")
    for detail in details[:3]:
        add(detail, "Fabric / construction mentioned in the source")
    defaults = []
    for reason in ("Designer / maker recorded for this look", "Brand / maker mentioned in the source", "Garment mentioned in the source"):
        match = next((item["tag"] for item in tags if item["reason"] == reason), None)
        if match and match not in defaults:
            defaults.append(match)
    defaults = defaults[:2] or [item["tag"] for item in tags[:2]]
    queries = [combined_google_query(defaults, [case.celebrity, *excluded])] if defaults else []
    return {"hashtags": tags[:18], "google_queries": [{"query": query, "url": "https://www.google.com/search?" + urlencode({"q": query})} for query in queries],
        "excluded_celebrity": case.celebrity, "excluded_terms": excluded, "default_hashtags": defaults, "match_mode": "all",
        "context_fingerprint": context_fingerprint(case), "max_selected": MAX_TAGS,
        "time_scope": "all_available", "note": "Only posts whose captions contain every selected hashtag are shown. Results still need outfit and rights review."}


def get_case(db, case_id):
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(404, "Outfit case not found")
    if case.celebrity.strip().casefold() in UNKNOWN_VALUES:
        raise HTTPException(422, "Identify the celebrity first so their name can be excluded from searches.")
    return case


def result_key(case_id):
    return "instagram-hashtags:" + case_id


@router.get("/cases/{case_id}/hashtags")
def suggestions(case_id: str, db: Session = Depends(get_db)):
    case = get_case(db, case_id)
    plan = hashtag_plan(case, config_for(db))
    state = db.get(ServiceState, result_key(case_id))
    search = dict(state.value) if state else None
    if search and search.get("context_fingerprint") != plan["context_fingerprint"]:
        search = {"status": "outdated", "results": [], "detail": "The outfit context changed. Run a new search."}
    elif search and search.get("status") in {"queued", "running"} and not active_run(search):
        search = {**search, "status": "interrupted", "detail": "The collector stopped responding. Start it and search again."}
    google = db.get(ServiceState, result_key(case_id) + ":google")
    google_search = google.value if google and google.value.get("context_fingerprint") == plan["context_fingerprint"] else None
    return {**plan, "search": search, "google_search": google_search, "google_configured": bool(get_settings().serpapi_key)}


class HashtagSearch(BaseModel):
    hashtags: list[str] = Field(min_length=1, max_length=MAX_TAGS)
    context_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")


@router.post("/cases/{case_id}/hashtags/google")
def google_search(case_id: str, payload: HashtagSearch, db: Session = Depends(get_db)):
    case = get_case(db, case_id)
    plan = hashtag_plan(case, config_for(db))
    if payload.context_fingerprint != plan["context_fingerprint"]:
        raise HTTPException(409, "The outfit context changed. Reload the suggestions before searching.")
    hashtags = validate_hashtags(payload.hashtags, plan["excluded_terms"])
    query = combined_google_query(hashtags, [case.celebrity, *plan["excluded_terms"]])
    settings = get_settings()
    if not settings.serpapi_key:
        raise HTTPException(503, "Google results inside the studio require the search provider key. Open the generated Google searches directly instead.")
    saved = locked_state(db, result_key(case.id) + ":google", {})
    if saved.value.get("context_fingerprint") == plan["context_fingerprint"] and saved.value.get("match_mode") == "all" and sorted(saved.value.get("hashtags", [])) == sorted(hashtags) and time.time() - saved.value.get("checked_at", 0) < 900:
        return saved.value
    leads = {}
    warnings = []
    for entry in [{"query": query}]:
        try:
            response = requests.get("https://serpapi.com/search.json", params={"engine": "google", "q": entry["query"], "api_key": settings.serpapi_key},
                headers={"User-Agent": settings.source_import_user_agent}, timeout=(10, 25), allow_redirects=False)
            if not response.ok:
                raise ValueError("Search provider rejected the request")
            data = response.json()
            if not isinstance(data, dict) or data.get("error") or not isinstance(data.get("organic_results", []), list):
                raise ValueError("Search provider could not complete the query")
        except (requests.RequestException, ValueError):
            warnings.append("A Google search could not complete. Check the search provider connection or open the Google link directly.")
            break
        for item in data.get("organic_results", [])[:10]:
            if not isinstance(item, dict):
                continue
            try:
                target = urlsplit(str(item.get("link", "")))
                match = re.fullmatch(r"/(?:[A-Za-z0-9._]+/)?p/([A-Za-z0-9_-]{1,32})/?", target.path)
                if target.scheme != "https" or target.hostname not in {"instagram.com", "www.instagram.com"} or target.username or target.password or target.port not in {None, 443} or not match:
                    continue
            except ValueError:
                continue
            title = str(item.get("title", ""))[:500]
            caption = str(item.get("snippet", ""))[:5000]
            if mentions_identity(title + " " + caption, plan["excluded_terms"]):
                continue
            url = f"https://www.instagram.com/p/{match[1]}/"
            if url == case.permalink:
                continue
            leads.setdefault(url, {"permalink": url, "title": title, "caption": caption, "query": entry["query"],
                "published_at": None, "review_required": True, "provider": "google_index"})
    candidates = list(leads.values())[:10]
    exclusions = {}

    def verify(lead):
        try:
            post = public_post_caption(lead["permalink"], settings)
        except (PublicSourceError, ValueError):
            return None, "caption_unverified"
        if mentions_identity(post["author"], plan["excluded_terms"], hashtag=True) or mentions_identity(post["caption"], plan["excluded_terms"]):
            return None, "source_celebrity"
        if not contains_all_hashtags(post["caption"], hashtags):
            return None, "missing_required_hashtags"
        return {**lead, **post, "matched_hashtags": hashtags, "match_mode": "all"}, None

    with ThreadPoolExecutor(max_workers=3) as pool:
        checked = list(pool.map(verify, candidates))
    verified = []
    for lead, reason in checked:
        if lead:
            verified.append(lead)
        else:
            exclusions[reason] = exclusions.get(reason, 0) + 1
    result = {"status": "partial" if warnings and leads else "unavailable" if warnings else "completed",
        "context_fingerprint": plan["context_fingerprint"], "checked_at": time.time(), "results": verified, "warnings": warnings,
        "hashtags": hashtags, "match_mode": "all", "exclusions": exclusions, "posts_checked": len(candidates),
        "detail": "Only posts with every selected hashtag in the verified public caption are shown. Inaccessible captions are excluded. Outfit identity, dates and rights still need review."}
    # A context edit may have happened while the search provider was responding.
    db.refresh(case)
    if context_fingerprint(case) != plan["context_fingerprint"]:
        raise HTTPException(409, "The outfit context changed during search. Reload and search again.")
    if not warnings:
        saved.value = result
    db.add(AuditEvent(entity_type="case", entity_id=case.id, action="instagram_google_search", actor=current_actor(), detail={"hashtags": hashtags, "match_mode": "all", "results": len(verified)}))
    db.commit()
    return result


@router.post("/cases/{case_id}/hashtags/search", status_code=202)
def queue_search(case_id: str, payload: HashtagSearch, db: Session = Depends(get_db)):
    case = get_case(db, case_id)
    config = config_for(db)
    plan = hashtag_plan(case, config)
    if payload.context_fingerprint != plan["context_fingerprint"]:
        raise HTTPException(409, "The outfit context changed. Reload the suggestions before searching.")
    hashtags = validate_hashtags(payload.hashtags, plan["excluded_terms"])
    state = locked_state(db, RUN_KEY, {})
    if active_run(state.value):
        raise HTTPException(409, "An Instagram collection is already queued or running. Wait for it to finish.")
    if not config.enabled:
        raise HTTPException(409, "Enable the local Instagram collector in Watchlist settings first.")
    runner = db.get(ServiceState, RUNNER_KEY)
    if not runner or time.time() - runner.value.get("heartbeat", 0) >= 180:
        raise HTTPException(503, "The local Instagram collector is offline. Start the Instagram Requests task or run instagram:daily -- --queued, then retry. You can also open the hashtag links directly.")
    state.value = {"run_id": str(uuid.uuid4()), "kind": "hashtag_search", "case_id": case.id,
        "status": "queued", "heartbeat": time.time(), "updated_at": datetime.now(timezone.utc).isoformat(),
        "hashtags": hashtags, "match_mode": "all", "excluded_terms": plan["excluded_terms"], "context_fingerprint": plan["context_fingerprint"],
        "results": [], "tags_checked": 0, "posts_checked": 0, "exclusions": {},
        "detail": "Waiting for the signed-in browser to search designer and outfit hashtags."}
    saved = locked_state(db, result_key(case.id), {})
    saved.value = state.value
    db.add(AuditEvent(entity_type="case", entity_id=case.id, action="instagram_hashtag_search_queued", actor=current_actor(), detail={"hashtags": hashtags}))
    db.commit()
    return state.value


class HashtagLead(BaseModel):
    shortcode: str = Field(pattern=r"^[A-Za-z0-9_-]{1,32}$")
    hashtag: str = Field(pattern=r"^[A-Za-z0-9_]{2,80}$")
    author: str = Field(pattern=r"^[A-Za-z0-9._]{1,30}$")
    caption: str = Field(max_length=5000)
    published_at: str | None = Field(default=None, max_length=50)


class SearchReport(BaseModel):
    run_id: str = Field(pattern=r"^[a-zA-Z0-9-]{1,64}$")
    status: str = Field(pattern=r"^(running|completed|partial|blocked|failed|paused)$")
    tags_checked: int = Field(default=0, ge=0, le=MAX_TAGS)
    posts_checked: int = Field(default=0, ge=0, le=48)
    detail: str = Field(default="", max_length=1000)
    exclusions: dict[str, int] = Field(default_factory=dict, max_length=20)
    results: list[HashtagLead] = Field(default_factory=list, max_length=MAX_LEADS)


@router.post("/hashtag-search/runs")
def report_search(payload: SearchReport, db: Session = Depends(get_db)):
    state = locked_state(db, RUN_KEY, {})
    previous = state.value
    if previous.get("kind") != "hashtag_search" or previous.get("run_id") != payload.run_id or previous.get("status") not in {"queued", "running"}:
        raise HTTPException(409, "This hashtag search is no longer active.")
    case = get_case(db, previous["case_id"])
    if context_fingerprint(case) != previous["context_fingerprint"]:
        state.value = {**previous, "status": "outdated", "results": [], "detail": "Outfit context changed; search stopped."}
        saved = locked_state(db, result_key(case.id), {})
        saved.value = state.value
        db.commit()
        raise HTTPException(409, "Outfit context changed; search stopped. Reload and search again.")
    leads = {}
    filtered = 0
    missing_tags = 0
    for lead in payload.results:
        if lead.hashtag.casefold() not in previous["hashtags"]:
            raise HTTPException(422, "The result did not come from a selected hashtag.")
        if mentions_identity(lead.author, previous["excluded_terms"], hashtag=True) or mentions_identity(lead.caption, previous["excluded_terms"]):
            filtered += 1
            continue
        if not contains_all_hashtags(lead.caption, previous["hashtags"]):
            missing_tags += 1
            continue
        url = f"https://www.instagram.com/p/{lead.shortcode}/"
        if url == case.permalink:
            filtered += 1
            continue
        stamp = None
        if lead.published_at:
            try:
                parsed = datetime.fromisoformat(lead.published_at.replace("Z", "+00:00"))
                if parsed.tzinfo and parsed <= datetime.now(timezone.utc):
                    stamp = parsed.isoformat()
            except ValueError:
                pass
        if url not in leads:
            leads[url] = {**lead.model_dump(), "permalink": url, "published_at": stamp, "review_required": True,
                "matched_hashtags": previous["hashtags"], "match_mode": "all"}
    state.value = {**previous, **payload.model_dump(exclude={"results"}), "results": list(leads.values()),
        "heartbeat": time.time(), "updated_at": datetime.now(timezone.utc).isoformat(),
        "exclusions": {**payload.exclusions, "source_celebrity_filtered": filtered, "missing_required_hashtags_reported": missing_tags}}
    saved = locked_state(db, result_key(case.id), {})
    saved.value = state.value
    db.commit()
    return {"status": state.value["status"], "results": len(leads)}
