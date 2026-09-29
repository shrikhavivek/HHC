from __future__ import annotations

import calendar
import hashlib
import html
import io
import math
import re
import threading
import time
from functools import wraps
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urlparse

import feedparser
import requests
from bs4 import BeautifulSoup
from PIL import Image, ImageOps
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .assets import CURRENT_MATCHER_VERSION, build_render_assets
from .collage import render_bundle
from .designer_search import find_official_designer_reference
from .models import AuditEvent, Candidate, Case, Collage, Decision, JobRun


BLOCKED_TITLE_PREFIXES = ("[request]", "id this", "who is", "weekly thread")
UNKNOWN_VALUES = {"", "unknown", "unresolved", "not stated", "n/a"}
FIELD_BOUNDARY = re.compile(
    r"\b(?:stylist|jewell?ery|shoes?|footwear|hair|make ?up|hmu|photograph(?:er|y)|submitted by)\s*[:\-]",
    re.I,
)
STOPWORDS = {
    "about", "after", "again", "also", "and", "are", "at", "before", "black", "but", "for", "from",
    "her", "him", "his", "how", "in", "into", "its", "look", "looks", "more", "not", "of", "on", "one",
    "outfit", "she", "the", "their", "this", "to", "was", "wearing", "with", "wore", "submitted", "stylist",
}
COLLAGE_LAYOUT_VERSION = 4
MATCHER_VERSION = CURRENT_MATCHER_VERSION
MIN_SOURCE_IMAGE_EDGE = 320

GARMENT_LANDMARKS = {
    "sari": {"sari", "saree"},
    "lehenga": {"lehenga", "ghagra"},
    "gown": {"gown"},
    "dress": {"dress", "mini dress", "midi dress", "maxi dress"},
    "pantsuit": {"pantsuit", "pant suit", "power suit"},
    "jumpsuit": {"jumpsuit"},
    "anarkali": {"anarkali"},
    "sharara": {"sharara", "gharara"},
    "kurta": {"kurta", "kurti"},
    "skirt": {"skirt"},
    "trousers": {"trousers", "pants"},
    "shirt": {"shirt", "blouse"},
    "jacket": {"jacket", "blazer"},
    "cape": {"cape"},
}
COLOR_LANDMARKS = {
    "black": {"black"}, "white": {"white", "ivory", "cream"},
    "red": {"red", "scarlet", "crimson", "maroon", "burgundy"},
    "pink": {"pink", "blush", "fuchsia", "magenta"},
    "orange": {"orange", "tangerine", "rust"}, "yellow": {"yellow", "mustard"},
    "green": {"green", "emerald", "mint", "olive"},
    "blue": {"blue", "navy", "cobalt", "turquoise", "teal"},
    "purple": {"purple", "violet", "lilac", "lavender"},
    "brown": {"brown", "tan", "beige", "camel"},
    "metallic": {"gold", "golden", "silver", "metallic"},
}
DETAIL_LANDMARKS = {
    "embroidered": {"embroidered", "embroidery"}, "embellished": {"embellished", "beaded"},
    "sequinned": {"sequin", "sequins", "sequinned"}, "floral": {"floral", "flowers"},
    "striped": {"stripe", "striped", "stripes"}, "polka-dot": {"polka dot", "polka dots"},
    "printed": {"print", "printed"}, "sheer": {"sheer", "transparent"},
    "lace": {"lace"}, "velvet": {"velvet"}, "satin": {"satin"}, "silk": {"silk"},
    "denim": {"denim"}, "leather": {"leather"}, "organza": {"organza"},
    "chiffon": {"chiffon"}, "brocade": {"brocade"}, "ruffled": {"ruffle", "ruffled"},
    "fringed": {"fringe", "fringed"}, "draped": {"drape", "draped"},
    "cut-out": {"cutout", "cut out", "cut-out"}, "strapless": {"strapless"},
    "off-shoulder": {"off shoulder", "off-shoulder"}, "one-shoulder": {"one shoulder", "one-shoulder"},
    "halter": {"halter"}, "corset": {"corset", "corseted"}, "peplum": {"peplum"},
    "pleated": {"pleat", "pleated"}, "asymmetric": {"asymmetric", "asymmetrical"},
}


class AutomationError(RuntimeError):
    pass


_AUTOMATION_LOCK = threading.Lock()


def _serialized(function):
    @wraps(function)
    def wrapper(*args, **kwargs):
        with _AUTOMATION_LOCK:
            return function(*args, **kwargs)
    return wrapper


def _request(url: str, user_agent: str) -> requests.Response:
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            response = requests.get(
                url,
                headers={"User-Agent": user_agent, "Accept": "application/atom+xml,application/xml,text/html;q=0.8"},
                timeout=20,
            )
            if response.status_code == 429 and attempt == 0:
                time.sleep(2)
                continue
            response.raise_for_status()
            return response
        except requests.RequestException as exc:
            last_error = exc
    raise AutomationError(f"Reddit request failed: {last_error}")


def _largest_srcset(value: str) -> str | None:
    choices: list[tuple[int, str]] = []
    for item in value.split(","):
        bits = item.strip().split()
        if not bits:
            continue
        try:
            width = int(bits[1].rstrip("w")) if len(bits) > 1 else 0
        except ValueError:
            width = 0
        choices.append((width, bits[0]))
    return max(choices)[1] if choices else None


def _prefer_original(url: str | None) -> str | None:
    if not url:
        return None
    url = html.unescape(url.strip())
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return None
    if parsed.hostname in {"preview.redd.it", "external-preview.redd.it"}:
        filename = parsed.path.rsplit("/", 1)[-1]
        if filename and "." in filename:
            return f"https://i.redd.it/{filename}"
    return url


def _entry_media(content_html: str, entry: dict) -> list[str]:
    soup = BeautifulSoup(content_html or "", "html.parser")
    found: list[str] = []
    for image in soup.find_all("img"):
        candidate = _largest_srcset(image.get("srcset", "")) or image.get("data-src") or image.get("src")
        if candidate:
            found.append(candidate)
    for anchor in soup.find_all("a", href=True):
        path = urlparse(anchor["href"]).path.lower()
        if path.endswith((".jpg", ".jpeg", ".png", ".webp")):
            found.append(anchor["href"])
    for media in entry.get("media_content", []) or []:
        if media.get("url"):
            found.append(media["url"])

    clean: list[str] = []
    seen: set[str] = set()
    for raw in found:
        candidate = _prefer_original(raw)
        if not candidate or candidate in seen:
            continue
        host = (urlparse(candidate).hostname or "").lower()
        if host.endswith("redditstatic.com") or "emoji" in candidate.lower():
            continue
        seen.add(candidate)
        clean.append(candidate)
    # Preserve the complete Reddit gallery (Reddit currently permits up to 20
    # gallery items); the renderer fits them into one adaptive collage image.
    return clean[:20]


def _post_page_media(content_html: str) -> list[str]:
    """Extract ordered, full-resolution media from a Reddit post page."""
    soup = BeautifulSoup(content_html or "", "html.parser")
    post = soup.find("shreddit-post")
    if post is None:
        return []
    direct: list[str] = []
    previews: list[str] = []
    for image in post.find_all("img"):
        raw_candidate = _largest_srcset(image.get("srcset", "")) or image.get("data-src") or image.get("src")
        if not raw_candidate:
            continue
        raw_candidate = html.unescape(raw_candidate.strip())
        parsed = urlparse(raw_candidate)
        host = (parsed.hostname or "").lower()
        path = parsed.path.lower()
        if host not in {"i.redd.it", "preview.redd.it", "external-preview.redd.it"}:
            continue
        if "/cms/" in path or "avatar" in path or "emoji" in path:
            continue
        if host == "i.redd.it":
            direct.append(raw_candidate)
        else:
            candidate = _prefer_original(raw_candidate)
            if candidate:
                previews.append(candidate)

    clean: list[str] = []
    seen: set[str] = set()
    # Gallery pages include a cropped preview cover and then the actual
    # full-resolution i.redd.it sequence. Prefer that direct sequence so the
    # cover is not duplicated or mistaken for a separate gallery item.
    for candidate in direct or previews:
        if candidate in seen:
            continue
        seen.add(candidate)
        clean.append(candidate)
    return clean[:20]


def _expand_reddit_post_media(permalink: str, user_agent: str) -> list[str]:
    """Load a post page and resolve Reddit's no-JavaScript gallery challenge.

    Reddit RSS commonly contains only the gallery cover. The post page embeds
    every gallery image, but may first return a lightweight challenge whose
    script doubles a nonce and submits it. Replaying that deterministic form
    keeps ingestion credential-free and falls back safely when Reddit changes.
    """
    if not permalink:
        return []
    headers = {"User-Agent": user_agent, "Accept": "text/html"}
    session = requests.Session()
    try:
        response = session.get(permalink, headers=headers, timeout=25)
        response.raise_for_status()
        for _ in range(4):
            media = _post_page_media(response.text)
            if media:
                return media
            soup = BeautifulSoup(response.text, "html.parser")
            form = soup.find("form")
            if form is None or form.find("input", attrs={"name": "js_challenge"}) is None:
                return []
            scripts = " ".join(script.get_text(" ", strip=True) for script in soup.find_all("script"))
            nonce = re.search(r'\)\("([0-9a-f]+)"\)', scripts)
            if nonce is None:
                return []
            parameters = {
                field.get("name"): field.get("value", "")
                for field in form.find_all("input")
                if field.get("name")
            }
            parameters["solution"] = nonce.group(1) * 2
            response = session.get(
                permalink,
                headers={**headers, "Referer": response.url},
                params=parameters,
                timeout=25,
            )
            response.raise_for_status()
        return _post_page_media(response.text)
    except (requests.RequestException, ValueError):
        return []


def _description(content_html: str) -> str:
    soup = BeautifulSoup(content_html or "", "html.parser")
    for tag in soup.find_all(["img", "a"]):
        tag.decompose()
    value = " ".join(soup.get_text(" ", strip=True).split())
    return re.sub(r"\s+submitted by\s*$", "", value, flags=re.I)[:3000]


def _parse_feed(content: bytes, limit: int) -> list[dict]:
    feed = feedparser.parse(content)
    posts: list[dict] = []
    for entry in feed.entries[: max(1, min(limit, 25))]:
        content_html = ""
        if entry.get("content"):
            content_html = entry["content"][0].get("value", "")
        elif entry.get("summary"):
            content_html = entry["summary"]
        title = " ".join(entry.get("title", "").split())
        if not title or title.casefold().startswith(BLOCKED_TITLE_PREFIXES):
            continue
        media = _entry_media(content_html, entry)
        if not media:
            continue
        published = None
        if entry.get("published_parsed"):
            published = datetime.fromtimestamp(calendar.timegm(entry.published_parsed), tz=timezone.utc)
        posts.append(
            {
                "post_id": entry.get("id") or entry.get("link"),
                "title": title,
                "description": _description(content_html),
                "permalink": entry.get("link", ""),
                "author": str(entry.get("author", "unknown")).replace("/u/", "").strip(),
                "published": published,
                "image_urls": media,
            }
        )
    return posts


def fetch_reddit_feed(subreddit: str, limit: int, user_agent: str) -> list[dict]:
    response = _request(f"https://www.reddit.com/r/{subreddit}/new/.rss", user_agent)
    posts = _parse_feed(response.content, limit)
    for post in posts:
        expanded = _expand_reddit_post_media(post["permalink"], user_agent)
        if expanded:
            post["image_urls"] = expanded
            post["gallery_expanded"] = True
        else:
            post["gallery_expanded"] = False
    return posts


def search_reddit_feed(subreddit: str, query: str, limit: int, user_agent: str) -> list[dict]:
    parameters = urlencode({"q": query, "restrict_sr": "on", "sort": "relevance", "t": "all"})
    response = _request(f"https://www.reddit.com/r/{subreddit}/search.rss?{parameters}", user_agent)
    return _parse_feed(response.content, limit)


def _clean_field(value: str, limit: int = 180) -> str:
    value = FIELD_BOUNDARY.split(value, maxsplit=1)[0]
    return re.sub(r"^[\s:|\-–—]+|[\s:|\-–—]+$", "", " ".join(value.split()))[:limit]


def _clean_designer(value: str) -> str:
    candidate = _clean_field(value).replace("@", "").strip()
    candidate = re.sub(r"\s*(?:,|&)\s*", " + ", candidate)
    candidate = re.sub(r"\s*\+\s*", " + ", candidate)
    known_handles = {"manishmalhotra": "Manish Malhotra"}
    return known_handles.get(candidate.casefold(), candidate)


def _designer_from_description(description: str) -> str:
    # Preserve separate garment labels instead of pretending that a multi-brand
    # ensemble came from one designer.
    shirt = re.search(
        r"\bshirt\s+is\s+from\s+.*?\bbrand\s+(.+?)\s+(?=(?:pants?|trousers?)\b)",
        description,
        re.I,
    )
    lower = re.search(
        r"\b(?:pants?|trousers?)\s+designer\s*[:\-–—]?\s*([^.;\n]+)",
        description,
        re.I,
    )
    if shirt and lower:
        names = [_clean_designer(shirt.group(1)), _clean_designer(lower.group(1))]
        return " + ".join(name for name in names if name)

    patterns = (
        r"\bclothing\s+designers?\s*[:\-–—]+\s*([^.;\n]+)",
        r"\bwearing\s+designer\s*[:\-–—]?\s*@?([^.;\n]+)",
        r"\b(?:wearing|designer|outfit(?:\s+by)?|entire\s+look\s+worn\s+by)\s*[:\-–—]+\s*([^.;\n]+)",
        r"\b(?:wears?|wore)\s+(?:an?\s+)?(?:full\s+)?(?:look\s+)?(?:by|from)\s+([^.;\n]+)",
    )
    for pattern in patterns:
        match = re.search(pattern, description, re.I)
        if match:
            candidate = _clean_designer(match.group(1))
            if candidate:
                return candidate
    return "Unknown"


def parse_outfit(title: str, description: str) -> dict[str, str]:
    clean = re.sub(r"\s+", " ", title.replace("|", " ")).strip()
    person = "Unresolved"
    designer = "Unknown"
    event = "Unresolved"

    question = re.match(r"^how\s+does\s+(.+?)\s+make\b", clean, re.I)
    campaign = re.match(r"^(.+?)(?:'s|’s)\s+(?:latest\s+)?campaign(?:\s+for\s+(.+))?$", clean, re.I)
    if question:
        person = _clean_field(question.group(1))
    elif campaign:
        person = _clean_field(campaign.group(1))
        if campaign.group(2):
            event = _clean_field(campaign.group(2), 240)

    match = re.match(r"^(.+?)\s+(?:in|wearing)\s+(.+?)(?:\s+(?:for|at|during)\s+(.+))?$", clean, re.I)
    if match:
        person = _clean_field(match.group(1))
        proposed_designer = _clean_field(match.group(2))
        if not re.match(r"^(?:a|an|the)\s+", proposed_designer, re.I):
            designer = proposed_designer
        if match.group(3):
            event = _clean_field(match.group(3), 240)
    elif person == "Unresolved":
        boundary = re.split(r"\s+(?:for|at)\s+", clean, maxsplit=1, flags=re.I)
        person = _clean_field(boundary[0])
        if len(boundary) > 1:
            event = _clean_field(boundary[1], 240)

    body_designer = _designer_from_description(description)
    if designer.casefold() in UNKNOWN_VALUES and body_designer.casefold() not in UNKNOWN_VALUES:
        designer = body_designer
    return {
        "celebrity": person or "Unresolved",
        "designer": designer or "Unknown",
        "event": event or "Unresolved",
    }


def _refresh_case_metadata(case: Case) -> dict[str, dict[str, str]]:
    """Repair unresolved metadata as parsing improves without overwriting edits."""
    parsed = parse_outfit(case.source_title, case.source_body)
    changes: dict[str, dict[str, str]] = {}
    malformed_person = (
        case.celebrity.casefold().startswith("how does ")
        or "latest campaign" in case.celebrity.casefold()
        or case.celebrity.casefold() in UNKNOWN_VALUES
    )
    if malformed_person and parsed["celebrity"].casefold() not in UNKNOWN_VALUES:
        changes["celebrity"] = {"from": case.celebrity, "to": parsed["celebrity"]}
        case.celebrity = parsed["celebrity"]
    if case.designer.casefold() in UNKNOWN_VALUES and parsed["designer"].casefold() not in UNKNOWN_VALUES:
        changes["designer"] = {"from": case.designer, "to": parsed["designer"]}
        case.designer = parsed["designer"]
    if case.event_name.casefold() in UNKNOWN_VALUES and parsed["event"].casefold() not in UNKNOWN_VALUES:
        changes["event"] = {"from": case.event_name, "to": parsed["event"]}
        case.event_name = parsed["event"]

    if changes:
        extraction = case.extraction if isinstance(case.extraction, dict) else {}
        case.extraction = {
            **extraction,
            "metadata_refresh": {
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "changes": changes,
                "title_and_description_used": True,
            },
        }
        if case.status == "context_review" and case.designer.casefold() not in UNKNOWN_VALUES:
            case.status = "review_ready"
            case.confidence = max(case.confidence, 0.78)
    return changes


def _usable_image_file(path: Path) -> bool:
    """Reject icons, badges and thumbnails before they can become panels."""
    try:
        with Image.open(path) as image:
            width, height = image.size
            image.verify()
        return width >= MIN_SOURCE_IMAGE_EDGE and height >= MIN_SOURCE_IMAGE_EDGE
    except (OSError, ValueError):
        return False


def _download_image(url: str, media_dir: str, user_agent: str, *, subfolder: str = "reddit") -> str | None:
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
    destination_dir = Path(media_dir) / subfolder
    destination_dir.mkdir(parents=True, exist_ok=True)
    for existing in destination_dir.glob(f"{digest}.*"):
        if _usable_image_file(existing):
            return f"/media-files/{subfolder}/{existing.name}"
    try:
        response = requests.get(url, headers={"User-Agent": user_agent}, timeout=25)
        response.raise_for_status()
        if len(response.content) > 25 * 1024 * 1024:
            return None
        with Image.open(io.BytesIO(response.content)) as probe:
            width, height = probe.size
            image_format = (probe.format or "JPEG").upper()
            probe.verify()
        if width < MIN_SOURCE_IMAGE_EDGE or height < MIN_SOURCE_IMAGE_EDGE:
            return None
        extension = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif"}.get(image_format, ".jpg")
        destination = destination_dir / f"{digest}{extension}"
        destination.write_bytes(response.content)
        return f"/media-files/{subfolder}/{destination.name}"
    except (requests.RequestException, OSError, ValueError):
        return None


def _download_source_images(urls: list[str], media_dir: str, user_agent: str) -> tuple[list[str], list[str]]:
    """Download source media while keeping URL and local-path order aligned."""
    valid_urls: list[str] = []
    downloaded: list[str] = []
    for url in urls:
        path = _download_image(url, media_dir, user_agent)
        if not path:
            continue
        valid_urls.append(url)
        downloaded.append(path)
    return valid_urls, downloaded


def _canonical(value: str) -> str:
    value = value.casefold().replace("’", "'")
    value = re.sub(r"^custom\s+", "", value)
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def _text_tokens(title: str, body: str, celebrity: str, designer: str) -> set[str]:
    text = _canonical(f"{title} {body}")
    excluded = STOPWORDS | set(_canonical(celebrity).split()) | set(_canonical(designer).split())
    return {token for token in text.split() if len(token) >= 3 and token not in excluded and not token.isdigit()}


def _tokens(case: Case) -> set[str]:
    return _text_tokens(case.source_title, case.source_body, case.celebrity, case.designer)


def _landmark_hits(text: str, vocabulary: dict[str, set[str]]) -> set[str]:
    canonical = f" {_canonical(text)} "
    hits: set[str] = set()
    for label, variants in vocabulary.items():
        if any(f" {_canonical(variant)} " in canonical for variant in variants):
            hits.add(label)
    return hits


def _outfit_signature(title: str, description: str) -> dict[str, set[str]]:
    text = f"{title} {description}"
    return {
        "garments": _landmark_hits(text, GARMENT_LANDMARKS),
        "colors": _landmark_hits(text, COLOR_LANDMARKS),
        "details": _landmark_hits(text, DETAIL_LANDMARKS),
    }


def _outfit_match_assessment(
    current_title: str,
    current_description: str,
    candidate_title: str,
    candidate_description: str,
    *,
    text_score: float,
    visual_score: float,
    same_person: bool,
) -> dict:
    """Apply a conservative exact-outfit gate before creating a candidate.

    A shared designer is necessary but never sufficient. At least one garment
    family and one supporting colour/construction landmark must agree for a
    normal match. Exceptionally strong imagery may substitute for one detail
    only when the garment family still agrees.
    """
    current = _outfit_signature(current_title, current_description)
    candidate = _outfit_signature(candidate_title, candidate_description)
    shared = {key: current[key] & candidate[key] for key in current}
    contradictions: list[str] = []
    if current["garments"] and candidate["garments"] and not shared["garments"]:
        contradictions.append("conflicting garment category")
    if current["colors"] and candidate["colors"] and not shared["colors"]:
        contradictions.append("conflicting outfit colour")

    construction_identity = bool(shared["garments"] and shared["details"])
    colour_identity = bool(shared["garments"] and shared["colors"])
    exceptional_identity = bool(colour_identity and visual_score >= 0.92 and text_score >= 0.20)
    if same_person:
        accepted = not contradictions and (
            (visual_score >= 0.80 and construction_identity)
            or (visual_score >= 0.87 and colour_identity and text_score >= 0.14)
        )
    else:
        accepted = (
            not contradictions
            and text_score >= 0.16
            and ((visual_score >= 0.84 and construction_identity) or exceptional_identity)
        )

    all_current = set().union(*current.values())
    all_candidate = set().union(*candidate.values())
    all_shared = set().union(*shared.values())
    landmark_score = len(all_shared) / len(all_current | all_candidate) if (all_current | all_candidate) else 0.0
    combined = visual_score * 0.52 + text_score * 0.23 + landmark_score * 0.25 + (0.02 if same_person else 0.0)
    landmarks = [
        *[f"garment: {item}" for item in sorted(shared["garments"])],
        *[f"colour: {item}" for item in sorted(shared["colors"])],
        *[f"detail: {item}" for item in sorted(shared["details"])],
    ]
    if not contradictions and not (construction_identity or exceptional_identity):
        contradictions.append("insufficient shared garment landmarks")
    return {
        "accepted": accepted,
        "combined": round(min(combined, 0.99), 4),
        "landmarks": landmarks,
        "contradictions": contradictions,
        "signature": {
            side: {key: sorted(values) for key, values in signature.items()}
            for side, signature in {"current": current, "candidate": candidate}.items()
        },
        "matcher_version": MATCHER_VERSION,
    }


def _cosine(left: list[float], right: list[float]) -> float:
    product = sum(a * b for a, b in zip(left, right))
    norms = math.sqrt(sum(a * a for a in left) * sum(b * b for b in right))
    return product / norms if norms else 0.0


def _image_descriptor(path: Path) -> tuple[list[float], int] | None:
    try:
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            sample = ImageOps.fit(image, (96, 96), method=Image.Resampling.LANCZOS)
            histogram = sample.histogram()
            reduced = [sum(histogram[channel * 256 + index * 32: channel * 256 + (index + 1) * 32]) for channel in range(3) for index in range(8)]
            gray = image.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
            pixels = list(gray.getdata())
            dhash = 0
            for row in range(8):
                for column in range(8):
                    dhash = (dhash << 1) | int(pixels[row * 9 + column] > pixels[row * 9 + column + 1])
            return reduced, dhash
    except OSError:
        return None


def _local_media_path(image_path: str, media_dir: str) -> Path | None:
    if not image_path.startswith("/media-files/"):
        return None
    root = Path(media_dir).resolve()
    path = (root / image_path.removeprefix("/media-files/")).resolve()
    return path if root in path.parents and path.is_file() else None


def _usable_media_asset(image_path: str, media_dir: str) -> bool:
    path = _local_media_path(image_path, media_dir)
    return bool(path and _usable_image_file(path))


def _visual_similarity(left_path: str, right_path: str, media_dir: str) -> float:
    left = _local_media_path(left_path, media_dir)
    right = _local_media_path(right_path, media_dir)
    if not left or not right:
        return 0.0
    left_descriptor, right_descriptor = _image_descriptor(left), _image_descriptor(right)
    if not left_descriptor or not right_descriptor:
        return 0.0
    histogram_score = max(0.0, min(1.0, _cosine(left_descriptor[0], right_descriptor[0])))
    hash_score = 1 - ((left_descriptor[1] ^ right_descriptor[1]).bit_count() / 64)
    return round(histogram_score * 0.68 + hash_score * 0.32, 4)


def _historical_matches(db: Session, case: Case, media_dir: str, limit: int = 3) -> list[tuple[Case, float, float, float, dict]]:
    if _canonical(case.designer) in UNKNOWN_VALUES:
        return []
    archive = db.scalars(select(Case).where(Case.id != case.id, Case.source_type == "reddit_rss")).all()
    current_tokens = _tokens(case)
    scored: list[tuple[Case, float, float, float, dict]] = []
    for prior in archive:
        if _canonical(prior.designer) != _canonical(case.designer):
            continue
        prior_tokens = _tokens(prior)
        union = current_tokens | prior_tokens
        text_score = len(current_tokens & prior_tokens) / len(union) if union else 0.0
        visual_score = _visual_similarity(case.base_image, prior.base_image, media_dir)
        same_person = _canonical(case.celebrity) == _canonical(prior.celebrity)
        assessment = _outfit_match_assessment(
            case.source_title,
            case.source_body,
            prior.source_title,
            prior.source_body,
            text_score=text_score,
            visual_score=visual_score,
            same_person=same_person,
        )
        same_event = (
            _canonical(case.event_name) not in UNKNOWN_VALUES
            and _canonical(case.event_name) == _canonical(prior.event_name)
            and (not case.event_date or not prior.event_date or case.event_date == prior.event_date)
        )
        if assessment["accepted"] and not same_event:
            scored.append((prior, assessment["combined"], text_score, visual_score, assessment))
    return sorted(scored, key=lambda item: item[1], reverse=True)[:limit]


def _collage_assets(post: dict, downloaded: list[str], outfit: dict, retrieved_at: str) -> list[dict]:
    return [
        {
            "id": f"current-angle-{index}",
            "role": "current_angle",
            "label": f"Current post / image {index}",
            "person": outfit["celebrity"],
            "designer": outfit["designer"],
            "image_path": image_path,
            "source_url": post["permalink"],
            "publisher": f"r/BollywoodFashion (u/{post['author']})",
            "credit": "Original photographer/agency credit requires confirmation",
            "retrieved_at": retrieved_at,
            "rights_status": "editorial_review_required",
            "source_grade": "D",
            "official_source": False,
            "exact_match": True,
            "include_in_collage": True,
            "fallback_only": False,
            "notes": "Automatically extracted from the same Reddit post and always included in its collage.",
        }
        for index, image_path in enumerate(downloaded[1:], start=2)
    ]


def _sync_current_post_images(
    case: Case,
    post: dict,
    downloaded: list[str],
    retrieved_at: str,
) -> bool:
    """Refresh one case with every image currently exposed by its Reddit post."""
    if not downloaded:
        return False
    extraction = case.extraction if isinstance(case.extraction, dict) else {}
    raw_assets = extraction.get("collage_assets", [])
    existing_assets = raw_assets if isinstance(raw_assets, list) else []
    retained_assets = [
        asset for asset in existing_assets
        if isinstance(asset, dict) and asset.get("role") != "current_angle"
    ]
    current_assets = _collage_assets(
        post,
        downloaded,
        {"celebrity": case.celebrity, "designer": case.designer},
        retrieved_at,
    )
    previous_paths = [
        case.base_image,
        *[
            str(asset.get("image_path") or "")
            for asset in existing_assets
            if isinstance(asset, dict) and asset.get("role") == "current_angle"
        ],
    ]
    next_paths = [downloaded[0], *[asset["image_path"] for asset in current_assets]]
    changed = (
        previous_paths != next_paths
        or extraction.get("collage_layout_version") != COLLAGE_LAYOUT_VERSION
    )
    case.base_image = downloaded[0]
    case.extraction = {
        **extraction,
        "author": post.get("author") or extraction.get("author"),
        "retrieved_at": retrieved_at,
        "source_image_urls": post.get("image_urls", []),
        "gallery_expanded": bool(post.get("gallery_expanded", False)),
        "collage_assets": [*current_assets, *retained_assets],
        "collage_layout_version": COLLAGE_LAYOUT_VERSION,
    }
    return changed


def _refresh_case_post_images(case: Case, settings, retrieved_at: str) -> bool:
    """Retry full Reddit gallery discovery for a case created from an RSS cover.

    A failed Reddit page challenge must never shrink an existing gallery.  A
    successful page read, including a genuine one-photo post, is recorded so
    the daily job does not retry it forever.
    """
    extraction = case.extraction if isinstance(case.extraction, dict) else {}
    checked_at = datetime.now(timezone.utc).isoformat()
    expanded = _expand_reddit_post_media(case.permalink, settings.reddit_user_agent)
    if not expanded:
        case.extraction = {
            **extraction,
            "gallery_retry": {"status": "unavailable", "checked_at": checked_at},
        }
        return False

    valid_urls, downloaded = _download_source_images(
        expanded,
        settings.media_dir,
        settings.reddit_user_agent,
    )
    existing_assets = extraction.get("collage_assets", [])
    existing_paths = [
        case.base_image,
        *[
            str(asset.get("image_path") or "")
            for asset in existing_assets
            if isinstance(asset, dict) and asset.get("role") == "current_angle"
        ],
    ]
    existing_count = sum(_usable_media_asset(path, settings.media_dir) for path in existing_paths)
    if not downloaded or len(downloaded) < existing_count:
        case.extraction = {
            **extraction,
            "gallery_retry": {
                "status": "incomplete_download",
                "checked_at": checked_at,
                "found": len(expanded),
                "downloaded": len(downloaded),
                "retained": existing_count,
            },
        }
        return False

    post = {
        "permalink": case.permalink,
        "author": extraction.get("author") or "unknown",
        "image_urls": valid_urls,
        "gallery_expanded": True,
    }
    changed = _sync_current_post_images(case, post, downloaded, retrieved_at)
    refreshed = case.extraction if isinstance(case.extraction, dict) else {}
    case.extraction = {
        **refreshed,
        "gallery_retry": {
            "status": "completed",
            "checked_at": checked_at,
            "found": len(expanded),
            "downloaded": len(downloaded),
        },
    }
    return changed


def _add_official_designer_reference(case: Case, settings) -> dict:
    extraction = case.extraction if isinstance(case.extraction, dict) else {}
    assets = list(extraction.get("collage_assets", []))
    if any(
        isinstance(asset, dict)
        and asset.get("role") == "designer_reference"
        and asset.get("exact_match")
        and (asset.get("verified_source") or asset.get("official_source"))
        for asset in assets
    ):
        return {"status": "already_present", "selected": 1}
    result = find_official_designer_reference(
        designer=case.designer,
        celebrity=case.celebrity,
        title=case.source_title,
        description=case.source_body,
        api_key=settings.serpapi_key,
        user_agent=settings.reddit_user_agent,
    )
    if result.get("status") == "found":
        image_path = _download_image(
            result["image_url"],
            settings.media_dir,
            settings.reddit_user_agent,
            subfolder="designer",
        )
        if image_path:
            assets.append(
                {
                    "id": f"designer-{hashlib.sha256(result['source_url'].encode('utf-8')).hexdigest()[:12]}",
                    "role": "designer_reference",
                    "label": str(result.get("label") or f"Official {case.designer} reference")[:180],
                    "person": result.get("person") or (
                        "Designer model"
                        if result.get("source_kind") in {"official_designer_product", "authorized_retailer_product"}
                        else case.celebrity
                    ),
                    "designer": case.designer,
                    "image_path": image_path,
                    "source_url": result["source_url"],
                    "publisher": result.get("publisher") or result.get("official_domain"),
                    "credit": f"{result.get('publisher') or case.designer} source imagery; publication rights require confirmation",
                    "retrieved_at": datetime.now(timezone.utc).isoformat(),
                    "rights_status": "editorial_review_required",
                    "source_grade": result.get("source_grade", "A"),
                    "official_source": bool(result.get("official_source", True)),
                    "verified_source": bool(result.get("verified_source", True)),
                    "source_kind": result.get("source_kind", "official_designer_product"),
                    "image_source_url": result.get("image_source_url") or result.get("image_url"),
                    "exact_match": True,
                    "include_in_collage": True,
                    "fallback_only": True,
                    "notes": result.get("verification_basis") or "Exact product context verified against the source page.",
                }
            )
            if case.match_type == "source_only":
                case.match_type = "exact_designer_reference"
                case.confidence = max(case.confidence, 0.92)
        else:
            result = {**result, "status": "image_download_failed", "selected": 0}
    case.extraction = {**extraction, "collage_assets": assets, "designer_reference": result}
    return result


def _same_file(left_path: str, right_path: str, media_dir: str) -> bool:
    left = _local_media_path(left_path, media_dir)
    right = _local_media_path(right_path, media_dir)
    if not left or not right or left.stat().st_size != right.stat().st_size:
        return False
    return hashlib.sha256(left.read_bytes()).digest() == hashlib.sha256(right.read_bytes()).digest()


def _remote_reddit_matches(db: Session, case: Case, settings, *, limit: int = 3) -> tuple[list[Candidate], dict]:
    designer_key = _canonical(case.designer)
    if designer_key in UNKNOWN_VALUES:
        return [], {"status": "skipped", "reason": "designer_unresolved", "selected": 0}

    signature = _outfit_signature(case.source_title, case.source_body)
    signature_terms = sorted(set().union(*signature.values()))
    context_terms = [*signature_terms, *sorted(_tokens(case))]
    # Do not put the current celebrity in the query: doing so suppresses the
    # very "same outfit, other celebrity" posts this workflow must discover.
    query = " ".join([case.designer, *context_terms[:8]])[:420]
    try:
        # Reddit rate-limits anonymous RSS search. One bounded query per outfit
        # with a pause is reliable and respectful enough for the daily job.
        time.sleep(1.25)
        posts = search_reddit_feed(settings.reddit_subreddit, query, 12, settings.reddit_user_agent)
    except AutomationError as exc:
        return [], {"status": "unavailable", "query": query, "error": str(exc)[:240], "selected": 0}

    expected_designer_terms = {
        token for token in designer_key.split()
        if len(token) >= 3 and token not in {"custom", "couture", "label", "labels", "the", "and", "for"}
    }
    candidate_rows = db.scalars(select(Candidate).where(Candidate.case_id == case.id)).all()
    existing_urls = {
        evidence.get("url")
        for candidate in candidate_rows
        if candidate.status != "matcher_superseded"
        for evidence in (candidate.evidence or [])
        if isinstance(evidence, dict) and evidence.get("url")
    }
    current_tokens = _tokens(case)
    selected: list[Candidate] = []
    for post in posts:
        if post["permalink"] == case.permalink or post["permalink"] in existing_urls or not post["image_urls"]:
            continue
        search_text = _canonical(f"{post['title']} {post['description']}")
        if expected_designer_terms and not expected_designer_terms.issubset(set(search_text.split())):
            continue
        outfit = parse_outfit(post["title"], post["description"])
        result_tokens = _text_tokens(post["title"], post["description"], outfit["celebrity"], case.designer)
        union = current_tokens | result_tokens
        text_score = len(current_tokens & result_tokens) / len(union) if union else 0.0
        if text_score < 0.10:
            continue
        image_path = _download_image(post["image_urls"][0], settings.media_dir, settings.reddit_user_agent)
        if not image_path or _same_file(case.base_image, image_path, settings.media_dir):
            continue
        visual_score = _visual_similarity(case.base_image, image_path, settings.media_dir)
        same_person = _canonical(case.celebrity) == _canonical(outfit["celebrity"])
        assessment = _outfit_match_assessment(
            case.source_title,
            case.source_body,
            post["title"],
            post["description"],
            text_score=text_score,
            visual_score=visual_score,
            same_person=same_person,
        )
        published_date = post["published"].date().isoformat() if post["published"] else None
        same_event = (
            _canonical(case.event_name) not in UNKNOWN_VALUES
            and _canonical(case.event_name) == _canonical(outfit["event"])
            and (not case.event_date or not published_date or case.event_date == published_date)
        )
        if not assessment["accepted"] or same_event:
            continue
        candidate = Candidate(
            case_id=case.id,
            person=outfit["celebrity"],
            designer=case.designer,
            event_name=outfit["event"],
            event_date=published_date,
            image_path=image_path,
            proposed_match_type="same_outfit_same_person" if same_person else "same_outfit_other_celebrity",
            status="automation_selected",
            visual_score=assessment["combined"],
            source_grade="D",
            rights_status="editorial_review_required",
            evidence=[{
                "publisher": f"r/BollywoodFashion (u/{post['author']})",
                "url": post["permalink"],
                "grade": "D",
                "quote": post["title"],
                "credit": "Original photographer/agency credit requires confirmation",
            }],
            checks={
                "same_photo": False,
                "same_event": same_event,
                "chronology": True,
                "identity": True,
                "contradictions": [],
                "landmarks": ["same designer attribution", *assessment["landmarks"]],
                "automation": {
                    "combined": assessment["combined"],
                    "text": round(text_score, 4),
                    "visual": visual_score,
                    "matcher_version": MATCHER_VERSION,
                    "signature": assessment["signature"],
                    "source_description": post["description"],
                },
            },
        )
        db.add(candidate)
        selected.append(candidate)
        if len(selected) >= limit:
            break
    db.flush()
    return selected, {"status": "completed", "query": query, "results": len(posts), "selected": len(selected)}


def _add_matches(db: Session, case: Case, media_dir: str) -> list[Candidate]:
    created: list[Candidate] = []
    candidate_rows = db.scalars(select(Candidate).where(Candidate.case_id == case.id)).all()
    existing_urls = {
        evidence.get("url")
        for candidate in candidate_rows
        if candidate.status != "matcher_superseded"
        for evidence in (candidate.evidence or [])
        if isinstance(evidence, dict) and evidence.get("url")
    }
    for prior, score, text_score, visual_score, assessment in _historical_matches(db, case, media_dir):
        if prior.permalink in existing_urls:
            continue
        same_person = _canonical(case.celebrity) == _canonical(prior.celebrity)
        candidate = Candidate(
            case_id=case.id,
            person=prior.celebrity,
            designer=prior.designer,
            event_name=prior.event_name,
            event_date=prior.event_date,
            image_path=prior.base_image,
            proposed_match_type="same_outfit_same_person" if same_person else "same_outfit_other_celebrity",
            status="automation_selected",
            visual_score=score,
            source_grade="D",
            rights_status="editorial_review_required",
            evidence=[
                {
                    "publisher": "r/BollywoodFashion archive",
                    "url": prior.permalink,
                    "grade": "D",
                    "quote": prior.source_title,
                    "credit": "Original photographer/agency credit requires confirmation",
                }
            ],
            checks={
                "same_photo": False,
                "same_event": False,
                "chronology": True,
                "identity": True,
                "contradictions": [],
                "landmarks": ["same designer attribution", *assessment["landmarks"]],
                "automation": {
                    "combined": score,
                    "text": round(text_score, 4),
                    "visual": visual_score,
                    "matcher_version": MATCHER_VERSION,
                    "signature": assessment["signature"],
                    "source_description": prior.source_body,
                },
            },
        )
        db.add(candidate)
        created.append(candidate)
    db.flush()
    return created


def _supersede_legacy_matches(db: Session, case: Case) -> int:
    """Remove permissive matcher output from future drafts and UI results."""
    rows = db.scalars(
        select(Candidate).where(
            Candidate.case_id == case.id,
            Candidate.status == "automation_selected",
        )
    ).all()
    superseded = 0
    for candidate in rows:
        automation = candidate.checks.get("automation", {}) if isinstance(candidate.checks, dict) else {}
        if automation.get("matcher_version") == MATCHER_VERSION:
            continue
        candidate.status = "matcher_superseded"
        superseded += 1
    if superseded:
        db.flush()
    return superseded


def _research_existing_case(db: Session, case: Case, settings, static_dir: str, *, allow_remote: bool = True) -> dict:
    metadata_changes = _refresh_case_metadata(case)
    superseded_matches = _supersede_legacy_matches(db, case)
    reference = {"status": "skipped", "reason": "designer_unresolved", "selected": 0}
    if settings.designer_reference_search_enabled and _canonical(case.designer) not in UNKNOWN_VALUES:
        reference = _add_official_designer_reference(case, settings)

    local_candidates = _add_matches(db, case, settings.media_dir)
    if allow_remote:
        remote_candidates, remote_meta = _remote_reddit_matches(db, case, settings)
    else:
        remote_candidates, remote_meta = [], {"status": "deferred", "reason": "daily_search_budget", "selected": 0}
    new_candidates = [*local_candidates, *remote_candidates]
    extraction = case.extraction if isinstance(case.extraction, dict) else {}
    case.extraction = {
        **extraction,
        "archive_search": {
            **remote_meta,
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "local_selected": len(local_candidates),
            "title_and_description_used": True,
            "matcher_version": MATCHER_VERSION,
            "superseded_legacy_matches": superseded_matches,
        },
    }
    selected = db.scalars(
        select(Candidate).where(Candidate.case_id == case.id, Candidate.status == "automation_selected")
    ).all()
    has_verified_reference = any(
        isinstance(asset, dict)
        and asset.get("role") == "designer_reference"
        and asset.get("exact_match")
        and (asset.get("verified_source") or asset.get("official_source"))
        for asset in case.extraction.get("collage_assets", [])
    )
    if selected:
        best = max(selected, key=lambda item: item.visual_score)
        case.match_type = best.proposed_match_type
        case.confidence = best.visual_score
    elif has_verified_reference:
        case.match_type = "exact_designer_reference"
        case.confidence = 0.92
    else:
        case.match_type = "source_only"
        case.confidence = 0
    collage = _render_automatic_draft(db, case, selected, settings, static_dir)
    panel_count = len(build_render_assets(
        case,
        selected,
        include_automation_matches=True,
        panel_ids=_saved_panel_ids(case),
    ))
    case.extraction = {
        **case.extraction,
        "automatic_collage": {"id": collage.id, "panels": panel_count},
    }
    db.add(
        AuditEvent(
            entity_type="case",
            entity_id=case.id,
            action="automatic_archive_research_completed",
            actor="daily-automation",
            detail={
                "local_matches": len(local_candidates),
                "remote_matches": len(remote_candidates),
                "query_status": remote_meta.get("status"),
                "designer_reference": reference.get("status"),
                "metadata_changes": metadata_changes,
                "superseded_legacy_matches": superseded_matches,
            },
        )
    )
    return {
        "case_id": case.id,
        "matches": len(new_candidates),
        "collage_id": collage.id if collage else None,
        "search": remote_meta,
        "designer_reference": reference,
        "metadata_changes": metadata_changes,
        "superseded_legacy_matches": superseded_matches,
    }


@_serialized
def research_case_automation(db: Session, case: Case, settings, static_dir: str) -> dict:
    try:
        result = _research_existing_case(db, case, settings, static_dir)
        db.commit()
        return result
    except Exception as exc:
        db.rollback()
        raise AutomationError(str(exc)) from exc


def _saved_panel_ids(case: Case) -> list[str] | None:
    extraction = case.extraction if isinstance(case.extraction, dict) else {}
    edit = extraction.get("collage_edit")
    if not isinstance(edit, dict) or not isinstance(edit.get("panel_ids"), list):
        return None
    panel_ids = [str(item) for item in edit["panel_ids"] if isinstance(item, str)]
    return panel_ids or None


def _saved_panel_options(case: Case) -> dict[str, dict] | None:
    extraction = case.extraction if isinstance(case.extraction, dict) else {}
    edit = extraction.get("collage_edit")
    if not isinstance(edit, dict) or not isinstance(edit.get("panel_options"), dict):
        return None
    options = {
        str(panel_id): value
        for panel_id, value in edit["panel_options"].items()
        if isinstance(panel_id, str) and isinstance(value, dict)
    }
    return options or None


def render_draft_collage(
    db: Session,
    case: Case,
    candidates: list[Candidate],
    settings,
    static_dir: str,
    *,
    editor_id: str = "daily-automation",
    reason: str = "Automatically assembled from downloaded Reddit source media and bounded archive matches; publication review remains optional.",
    decision_type: str = "automation_draft",
) -> Collage:
    anchor = db.scalar(select(Candidate).where(Candidate.case_id == case.id, Candidate.status == "automation_draft_anchor"))
    if not anchor:
        anchor = Candidate(
            case_id=case.id,
            person=case.celebrity,
            designer=case.designer,
            event_name=case.event_name,
            event_date=case.event_date,
            image_path=case.base_image,
            proposed_match_type="source_only",
            status="automation_draft_anchor",
            visual_score=0,
            source_grade="D",
            rights_status="not_applicable",
            evidence=[],
            checks={"identity": False, "automation_anchor": True},
        )
        db.add(anchor)
        db.flush()
    decision = Decision(
        candidate_id=anchor.id,
        decision=decision_type,
        reason=reason,
        editor_id=editor_id,
    )
    db.add(decision)
    db.flush()
    image_path, manifest_path, bundle_path = render_bundle(
        settings.output_dir,
        static_dir,
        case,
        candidates,
        decision,
        media_dir=settings.media_dir,
        include_automation_matches=True,
        panel_ids=_saved_panel_ids(case),
        panel_options=_saved_panel_options(case),
    )
    collage = Collage(case_id=case.id, decision_id=decision.id, image_path=image_path, manifest_path=manifest_path, bundle_path=bundle_path)
    db.add(collage)
    db.flush()
    return collage


def _render_automatic_draft(db: Session, case: Case, candidates: list[Candidate], settings, static_dir: str) -> Collage:
    return render_draft_collage(db, case, candidates, settings, static_dir)


def migrate_legacy_matcher_outputs(db: Session, settings, static_dir: str) -> int:
    """Retire permissive matcher results before the API begins serving them."""
    case_ids = db.scalars(
        select(Candidate.case_id)
        .where(Candidate.status == "automation_selected")
        .distinct()
    ).all()
    migrated = 0
    for case_id in case_ids:
        case = db.scalar(
            select(Case)
            .where(Case.id == case_id)
            .options(selectinload(Case.candidates))
        )
        if not case:
            continue
        superseded = _supersede_legacy_matches(db, case)
        if not superseded:
            continue
        try:
            selected = [item for item in case.candidates if item.status == "automation_selected"]
            case_extraction = case.extraction if isinstance(case.extraction, dict) else {}
            has_verified_reference = any(
                isinstance(asset, dict)
                and asset.get("role") == "designer_reference"
                and asset.get("exact_match")
                and (asset.get("verified_source") or asset.get("official_source"))
                for asset in case_extraction.get("collage_assets", [])
            )
            if selected:
                best = max(selected, key=lambda item: item.visual_score)
                case.match_type = best.proposed_match_type
                case.confidence = best.visual_score
            elif has_verified_reference:
                case.match_type = "exact_designer_reference"
                case.confidence = 0.92
            else:
                case.match_type = "source_only"
                case.confidence = 0
            collage = _render_automatic_draft(db, case, selected, settings, static_dir)
            panel_count = len(build_render_assets(
                case,
                selected,
                include_automation_matches=True,
                panel_ids=_saved_panel_ids(case),
            ))
            extraction = case.extraction if isinstance(case.extraction, dict) else {}
            case.extraction = {
                **extraction,
                "collage_layout_version": COLLAGE_LAYOUT_VERSION,
                "automatic_collage": {"id": collage.id, "panels": panel_count},
                "matcher_migration": {
                    "version": MATCHER_VERSION,
                    "superseded": superseded,
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                },
            }
            db.add(AuditEvent(
                entity_type="case",
                entity_id=case.id,
                action="legacy_matcher_output_retired",
                actor="system-migration",
                detail={"matcher_version": MATCHER_VERSION, "superseded": superseded, "panel_count": panel_count},
            ))
            db.commit()
            migrated += superseded
        except Exception:
            db.rollback()
    return migrated


@_serialized
def run_daily_automation(db: Session, settings, static_dir: str, *, trigger: str = "editor") -> dict:
    key = f"daily-reddit:{datetime.now(timezone.utc).strftime('%Y-%m-%d')}:{trigger}"
    existing_run = db.scalar(select(JobRun).where(JobRun.idempotency_key == key))
    if existing_run and trigger == "scheduler" and existing_run.status == "completed":
        return {"job_id": existing_run.id, "status": "completed", "already_ran": True, "created": 0, "case_ids": []}

    if existing_run:
        run = existing_run
        run.status = "running"
        run.attempts += 1
    else:
        if trigger != "scheduler":
            key = f"{key}:{datetime.now(timezone.utc).strftime('%H%M%S%f')}"
        run = JobRun(job_type="daily_reddit_automation", idempotency_key=key, status="running", attempts=1)
        db.add(run)
    db.commit()

    summary = {"job_id": run.id, "status": "running", "found": 0, "created": 0, "skipped": 0, "failed": 0, "researched": 0, "matches": 0, "collages": 0, "case_ids": []}
    try:
        posts = fetch_reddit_feed(settings.reddit_subreddit, settings.daily_automation_limit, settings.reddit_user_agent)
        summary["found"] = len(posts)
        retrieved_at = datetime.now(timezone.utc).isoformat()
        remote_searches_used = 0
        remote_search_budget = max(0, settings.daily_remote_search_budget)
        designer_searches_used = 0
        designer_search_budget = max(0, settings.daily_designer_search_budget)
        for post in posts:
            existing = db.scalar(select(Case).where((Case.external_id == post["post_id"]) | (Case.permalink == post["permalink"])))
            if existing:
                summary["skipped"] += 1
                existing_extraction = existing.extraction if isinstance(existing.extraction, dict) else {}
                # A Reddit challenge can fail transiently. Never replace a
                # previously expanded gallery with the one-image RSS cover.
                if existing_extraction.get("gallery_expanded") and not post.get("gallery_expanded"):
                    continue
                post["image_urls"], downloaded = _download_source_images(
                    post["image_urls"],
                    settings.media_dir,
                    settings.reddit_user_agent,
                )
                if _sync_current_post_images(existing, post, downloaded, retrieved_at):
                    selected = db.scalars(
                        select(Candidate).where(
                            Candidate.case_id == existing.id,
                            Candidate.status == "automation_selected",
                        )
                    ).all()
                    collage = _render_automatic_draft(db, existing, selected, settings, static_dir)
                    panel_count = len(build_render_assets(existing, selected, include_automation_matches=True, panel_ids=_saved_panel_ids(existing)))
                    existing.extraction = {
                        **existing.extraction,
                        "automatic_collage": {"id": collage.id, "panels": panel_count},
                    }
                    db.add(
                        AuditEvent(
                            entity_type="case",
                            entity_id=existing.id,
                            action="complete_reddit_gallery_collage_refreshed",
                            actor="daily-automation",
                            detail={"source_image_count": len(downloaded), "panel_count": panel_count},
                        )
                    )
                    db.commit()
                    summary["collages"] += 1
                continue
            post["image_urls"], downloaded = _download_source_images(
                post["image_urls"],
                settings.media_dir,
                settings.reddit_user_agent,
            )
            if not downloaded:
                summary["failed"] += 1
                continue
            outfit = parse_outfit(post["title"], post["description"])
            published = post["published"]
            extraction = {
                "automated": True,
                "provider": "reddit_rss",
                "author": post["author"],
                "retrieved_at": retrieved_at,
                "search_basis": {"title": post["title"], "description": post["description"]},
                "source_image_urls": post["image_urls"],
                "gallery_expanded": bool(post.get("gallery_expanded", False)),
                "collage_assets": _collage_assets(post, downloaded, outfit, retrieved_at),
                "collage_layout_version": COLLAGE_LAYOUT_VERSION,
                "designer_reference": {"status": "pending", "rule": "Official sources only; no placeholder is inserted."},
            }
            known_designer = _canonical(outfit["designer"]) not in UNKNOWN_VALUES
            case = Case(
                source_type="reddit_rss",
                external_id=post["post_id"][:120],
                permalink=post["permalink"],
                source_title=post["title"],
                source_body=post["description"],
                celebrity=outfit["celebrity"],
                designer=outfit["designer"],
                event_name=outfit["event"],
                event_date=published.date().isoformat() if published else None,
                status="review_ready" if known_designer else "context_review",
                match_type="source_only",
                confidence=0.84 if known_designer else 0.56,
                risk_level="medium",
                base_image=downloaded[0],
                extraction=extraction,
                demo_data=False,
            )
            db.add(case)
            db.flush()
            if settings.designer_reference_search_enabled and known_designer:
                if not settings.serpapi_key:
                    _add_official_designer_reference(case, settings)
                elif designer_searches_used < designer_search_budget:
                    _add_official_designer_reference(case, settings)
                    designer_searches_used += 1
                else:
                    case.extraction = {
                        **case.extraction,
                        "designer_reference": {"status": "deferred", "reason": "daily_search_budget", "selected": 0},
                    }
            local_candidates = _add_matches(db, case, settings.media_dir)
            candidates = local_candidates
            case.extraction = {
                **case.extraction,
                "archive_search": {
                    "status": "deferred" if known_designer else "skipped",
                    "reason": "daily_search_queue" if known_designer else "designer_unresolved",
                    "local_selected": len(local_candidates),
                    "title_and_description_used": True,
                },
            }
            if candidates:
                best = max(candidates, key=lambda item: item.visual_score)
                case.match_type = best.proposed_match_type
                case.confidence = best.visual_score
            collage = _render_automatic_draft(db, case, candidates, settings, static_dir)
            panel_count = len(build_render_assets(case, candidates, include_automation_matches=True, panel_ids=_saved_panel_ids(case)))
            case.extraction = {
                **case.extraction,
                "automatic_collage": {"id": collage.id, "panels": panel_count},
            }
            db.add(
                AuditEvent(
                    entity_type="case",
                    entity_id=case.id,
                    action="automatic_draft_created",
                    actor="daily-automation",
                    detail={"trigger": trigger, "candidate_count": len(candidates), "source_image_count": len(downloaded)},
                )
            )
            db.commit()
            summary["created"] += 1
            summary["researched"] += 1
            summary["matches"] += len(candidates)
            summary["collages"] += 1
            summary["case_ids"].append(case.id)

        # Recheck source-only cases as the retained Reddit archive grows. A
        # successful search is cached in extraction JSON so ordinary reruns do
        # not hammer Reddit's anonymous search endpoint.
        research_cases = db.scalars(
            select(Case)
            .where(Case.source_type == "reddit_rss", Case.demo_data.is_(False))
            .options(selectinload(Case.candidates))
            .order_by(Case.created_at.asc())
        ).all()
        gallery_retries_used = 0
        gallery_retry_budget = min(max(2, settings.daily_automation_limit), 8)
        for case in research_cases:
            metadata_changes = _refresh_case_metadata(case)
            extraction = case.extraction if isinstance(case.extraction, dict) else {}
            needs_layout_refresh = extraction.get("collage_layout_version") != COLLAGE_LAYOUT_VERSION
            gallery_attempted = False
            gallery_changed = False
            gallery_needs_retry = (
                not extraction.get("gallery_expanded")
                or not _usable_media_asset(case.base_image, settings.media_dir)
            )
            if gallery_needs_retry and gallery_retries_used < gallery_retry_budget:
                gallery_attempted = True
                gallery_retries_used += 1
                gallery_changed = _refresh_case_post_images(case, settings, retrieved_at)
                extraction = case.extraction if isinstance(case.extraction, dict) else {}
            if needs_layout_refresh or gallery_changed:
                selected = db.scalars(
                    select(Candidate).where(
                        Candidate.case_id == case.id,
                        Candidate.status == "automation_selected",
                    )
                ).all()
                collage = _render_automatic_draft(db, case, selected, settings, static_dir)
                panel_count = len(build_render_assets(case, selected, include_automation_matches=True, panel_ids=_saved_panel_ids(case)))
                case.extraction = {
                    **extraction,
                    "collage_layout_version": COLLAGE_LAYOUT_VERSION,
                    "automatic_collage": {"id": collage.id, "panels": panel_count},
                }
                extraction = case.extraction
                summary["collages"] += 1
                db.add(
                    AuditEvent(
                        entity_type="case",
                        entity_id=case.id,
                        action="complete_reddit_gallery_collage_refreshed",
                        actor="daily-automation",
                        detail={
                            "panel_count": panel_count,
                            "layout_version": COLLAGE_LAYOUT_VERSION,
                            "gallery_changed": gallery_changed,
                        },
                    )
                )
                db.commit()
            elif gallery_attempted:
                db.commit()
            previous_search = extraction.get("archive_search") if isinstance(extraction.get("archive_search"), dict) else None
            if previous_search and previous_search.get("matcher_version") == MATCHER_VERSION:
                resolved_now = "designer" in metadata_changes
                if previous_search.get("status") == "completed" or (
                    previous_search.get("status") == "skipped" and not resolved_now
                ):
                    continue
                checked_at = previous_search.get("checked_at")
                if checked_at:
                    try:
                        checked = datetime.fromisoformat(checked_at)
                        if datetime.now(timezone.utc) - checked < timedelta(hours=20):
                            continue
                    except (TypeError, ValueError):
                        pass
            if _canonical(case.designer) not in UNKNOWN_VALUES and remote_searches_used >= remote_search_budget:
                continue
            result = _research_existing_case(db, case, settings, static_dir)
            db.commit()
            if result["search"].get("status") != "skipped":
                remote_searches_used += 1
            summary["researched"] += 1
            summary["matches"] += result["matches"]
            if result["collage_id"]:
                summary["collages"] += 1

        # Verified post-specific references work without a paid provider key;
        # SerpAPI remains the scalable discovery path for new, uncatalogued
        # outfits once credentials are configured.
        if settings.designer_reference_search_enabled:
            for case in research_cases:
                _refresh_case_metadata(case)
                extraction = case.extraction if isinstance(case.extraction, dict) else {}
                assets = extraction.get("collage_assets", []) if isinstance(extraction.get("collage_assets", []), list) else []
                if any(
                    isinstance(asset, dict)
                    and asset.get("role") == "designer_reference"
                    and asset.get("exact_match")
                    and (asset.get("verified_source") or asset.get("official_source"))
                    for asset in assets
                ):
                    continue
                if _canonical(case.designer) in UNKNOWN_VALUES:
                    continue
                if settings.serpapi_key and designer_searches_used >= designer_search_budget:
                    continue
                reference = _add_official_designer_reference(case, settings)
                if settings.serpapi_key:
                    designer_searches_used += 1
                if reference.get("status") == "found":
                    selected = db.scalars(
                        select(Candidate).where(Candidate.case_id == case.id, Candidate.status == "automation_selected")
                    ).all()
                    collage = _render_automatic_draft(db, case, selected, settings, static_dir)
                    panel_count = len(build_render_assets(case, selected, include_automation_matches=True, panel_ids=_saved_panel_ids(case)))
                    case.extraction = {
                        **case.extraction,
                        "automatic_collage": {
                            "id": collage.id,
                            "panels": panel_count,
                        },
                    }
                    summary["collages"] += 1
                    db.add(
                        AuditEvent(
                            entity_type="case",
                            entity_id=case.id,
                            action="official_designer_reference_added",
                            actor="daily-automation",
                            detail={"official_domain": reference.get("official_domain")},
                        )
                    )
                db.commit()

        run.status = "completed" if summary["failed"] == 0 else "completed_with_warnings"
        summary["status"] = run.status
        db.add(
            AuditEvent(
                entity_type="job_run",
                entity_id=run.id,
                action=run.status,
                actor=f"daily-automation:{trigger}",
                detail={key: value for key, value in summary.items() if key != "case_ids"},
            )
        )
        db.commit()
        return summary
    except Exception as exc:
        db.rollback()
        persisted_run = db.get(JobRun, run.id)
        if persisted_run:
            persisted_run.status = "failed"
            db.add(
                AuditEvent(
                    entity_type="job_run",
                    entity_id=run.id,
                    action="failed",
                    actor=f"daily-automation:{trigger}",
                    detail={"error": str(exc)[:500]},
                )
            )
            db.commit()
        raise AutomationError(str(exc)) from exc
