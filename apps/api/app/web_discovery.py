import hashlib
import re
import time
from datetime import timedelta
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from threading import Lock
from urllib.parse import parse_qs, parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

import feedparser
from bs4 import BeautifulSoup

from .publication_dates import extract_publication, is_current_week, is_recent_post, publication_stamp, week_window
from .public_sources import MAX_DOCUMENT_BYTES, PublicSourceError, _fetch_limited, _image_url, extract_public_metadata


USER_AGENT = "HHCWebDiscovery/1.0 (+https://www.highheelconfidential.com)"
MAX_PAGES = 12
SEARCH_CACHE_SECONDS = 900
SEARCH_COOLDOWN_SECONDS = 300
_search_cache = OrderedDict()
_search_lock = Lock()
_search_blocked_until = 0.0


def is_instagram_post(url):
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    return (host == "instagram.com" or host.endswith(".instagram.com")) and bool(re.fullmatch(r"/(?:p|reel|tv)/[A-Za-z0-9_-]+/?", parsed.path))


def canonical_url(value):
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise PublicSourceError("Use a public HTTPS article or post URL")
    if parsed.path in ("", "/"):
        raise PublicSourceError("Use an individual article or post, not a profile or home page")
    query = [(key, item) for key, item in parse_qsl(parsed.query) if not key.lower().startswith("utm_") and key.lower() not in {"fbclid", "igsh", "igshid", "gclid"}]
    if is_instagram_post(value):
        return f"https://www.instagram.com/{parsed.path.strip('/')}/"
    return urlunsplit(("https", parsed.hostname.lower(), parsed.path, urlencode(query), ""))


def fetch_document(url, maximum_bytes=MAX_DOCUMENT_BYTES, check_access=None):
    host = urlsplit(url).hostname or ""
    return _fetch_limited(url, user_agent=USER_AGENT, allowed_domains={host.removeprefix("www.")}, source_document=True, maximum_bytes=maximum_bytes, accept="text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,text/plain", timeout=10, check_access=check_access)


@lru_cache(maxsize=128)
def robots_rules(origin, bucket):
    parser = RobotFileParser()
    try:
        _, content, _ = fetch_document(origin + "/robots.txt", 256_000)
        parser.parse(content.decode("utf-8", "replace").splitlines())
    except PublicSourceError as exc:
        parser.parse([] if "could not be found" in str(exc) else ["User-agent: *", "Disallow: /"])
    return parser


def accessible_document(url):
    def check_access(target):
        origin = f"https://{urlsplit(target).netloc}"
        if not robots_rules(origin, int(time.time() // 300)).can_fetch(USER_AGENT, target):
            raise PublicSourceError("The publisher does not allow automated browsing of this page")
    return fetch_document(url, check_access=check_access)


def inspect_weekly_post(url, timezone_name="Asia/Kolkata", now=None):
    url = canonical_url(url)
    instagram = is_instagram_post(url)
    final_url, content, content_type = fetch_document(url) if instagram else accessible_document(url)
    if instagram and (not is_instagram_post(final_url) or canonical_url(final_url) != url):
        raise PublicSourceError("Instagram redirected away from the public post; its date cannot be verified without access")
    if content_type not in {"text/html", "application/xhtml+xml"}:
        raise PublicSourceError("The source is not a public article or post page")
    markup = content.decode("utf-8", "replace")
    soup = BeautifulSoup(markup, "html.parser")
    if soup.select('input[type="password"], form[action*="challenge"], form[action*="captcha"]'):
        raise PublicSourceError("This source requires sign-in or an access challenge")
    try:
        publication = extract_publication(markup, final_url, timezone_name)
    except ValueError as exc:
        raise PublicSourceError(str(exc)) from exc
    within_window = is_recent_post if instagram else is_current_week
    if not within_window(publication["published_at"], timezone_name, now):
        raise PublicSourceError("The source was not published today or yesterday, or is future-dated" if instagram else "The source was not published in the current calendar week, or is future-dated")
    metadata = extract_public_metadata(markup, final_url)
    cover_images = [
        _image_url(tag.get("content"), final_url)
        for tag in soup.select('meta[property="og:image:secure_url"], meta[property="og:image"]')
    ]
    if any(cover_images):
        metadata["image_urls"] = list(dict.fromkeys(image for image in cover_images if image))
    if not metadata["title"] or not metadata["image_urls"]:
        raise PublicSourceError("The page does not expose a usable post title and image")
    permalink = canonical_url(final_url)
    host = urlsplit(permalink).hostname or ""
    return {
        **metadata, **publication, "published": publication["published_at"], "permalink": permalink,
        "platform": "Instagram" if host == "instagram.com" or host.endswith(".instagram.com") else "Web",
        "publisher": metadata["publisher"] or host, "post_id": hashlib.sha256(permalink.encode()).hexdigest()[:32],
        "web_discovered": True,
    }


def search_links(query):
    global _search_blocked_until
    query = " ".join(query.split()).casefold()
    with _search_lock:
        current = time.monotonic()
        cached = _search_cache.get(query)
        if cached and current - cached[0] < SEARCH_CACHE_SECONDS:
            _search_cache.move_to_end(query)
            return list(cached[1])
        if current < _search_blocked_until:
            raise PublicSourceError("Public search is paused after a browser challenge. Wait five minutes before trying again; availability is not guaranteed.")
        try:
            links = _fetch_search_links(query)
        except PublicSourceError as exc:
            if "challenge" in str(exc).lower():
                _search_blocked_until = time.monotonic() + SEARCH_COOLDOWN_SECONDS
            raise
        _search_cache[query] = (time.monotonic(), tuple(links))
        _search_cache.move_to_end(query)
        while len(_search_cache) > 128:
            _search_cache.popitem(last=False)
        return links


def _fetch_search_links(query):
    url = "https://html.duckduckgo.com/html/?" + urlencode({"q": query or "Bollywood celebrity designer fashion outfit", "df": "w"})
    _, content, _ = fetch_document(url)
    soup = BeautifulSoup(content, "html.parser")
    if soup.select("#challenge-form, .anomaly-modal, form[action*='anomaly']"):
        raise PublicSourceError("The public search provider requires a browser challenge. Automated search is paused for five minutes; availability is not guaranteed.")
    links = []
    for anchor in soup.select("a.result__a"):
        target = urljoin(url, str(anchor.get("href") or ""))
        redirect = parse_qs(urlsplit(target).query).get("uddg")
        links.append(redirect[0] if redirect else target)
    if not links and not soup.select(".no-results, .no-results__message"):
        raise PublicSourceError("Public search did not return a readable results page")
    return links[:MAX_PAGES]


def feed_links(feed_url, query):
    _, content, _ = accessible_document(feed_url)
    feed = feedparser.parse(content)
    if not feed.entries:
        raise PublicSourceError("The public fashion feed is unavailable")
    terms = re.findall(r"[\w]+", query.casefold())
    links = []
    for entry in feed.entries[:40]:
        text = BeautifulSoup(f"{entry.get('title', '')} {entry.get('summary', '')}", "html.parser").get_text(" ").casefold()
        if terms and not all(term in text for term in terms):
            continue
        links.append(entry.get("link", ""))
    return links[:MAX_PAGES]


def discover_weekly_posts(query, settings, now=None, source="instagram"):
    zone = settings.reddit_daily_timezone
    start, end, current = week_window(zone, now)
    if source == "instagram":
        start = current.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1)
        end = start + timedelta(days=2)
    warnings = []
    links = []
    completed_sources = 0
    queries = [f"site:instagram.com/p/ {query or 'Bollywood celebrity designer outfit'}", f"site:instagram.com/reel/ {query or 'Bollywood celebrity fashion'}"] if source == "instagram" else [query]
    for search_query in queries:
        try:
            links.extend(search_links(search_query))
            completed_sources += 1
        except PublicSourceError as exc:
            warnings.append(str(exc))
            break
    if source == "web":
        for feed_url in settings.web_discovery_feeds.split(",")[:4]:
            if not feed_url.strip():
                continue
            try:
                links.extend(feed_links(feed_url.strip(), query))
                completed_sources += 1
            except PublicSourceError:
                warnings.append(f"A configured fashion feed is unavailable: {urlsplit(feed_url).hostname}")
    unique = []
    for link in links:
        try:
            normalized = canonical_url(link)
            if source == "instagram" and not is_instagram_post(normalized):
                continue
            if normalized not in unique:
                unique.append(normalized)
        except (PublicSourceError, ValueError):
            continue
    selected = unique[:MAX_PAGES]

    def inspect(url):
        try:
            return inspect_weekly_post(url, zone, current), None
        except (PublicSourceError, ValueError) as exc:
            reason = str(exc)
            code = "outside_week" if "current calendar week" in reason or "today or yesterday" in reason else "date_unverified" if "date" in reason.lower() else "unavailable"
            return None, {"url": url, "reason": reason, "code": code}

    with ThreadPoolExecutor(max_workers=3) as pool:
        inspected = list(pool.map(inspect, selected))
    results = [result for result, _ in inspected if result]
    rejected = [failure for _, failure in inspected if failure]
    results = list({result["permalink"]: result for result in results}.values())
    results.sort(key=lambda result: publication_stamp(result["published_at"], zone)[0], reverse=True)
    return {
        "results": [{key: result[key] for key in ("title", "description", "publisher", "platform", "permalink", "published_at", "published_date", "date_precision", "date_evidence")} for result in results],
        "week_start": start.date().isoformat(), "week_end": (end.date()).isoformat(),
        "timezone": zone, "checked_at": current.isoformat(), "checked": len(selected),
        "excluded": len(selected) - len(results), "warnings": list(dict.fromkeys(warnings)),
        "source": source, "rejected": rejected,
        "search_status": "unavailable" if not completed_sources else "partial" if warnings else "complete",
    }
