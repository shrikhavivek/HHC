import json
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup


def week_window(timezone_name="Asia/Kolkata", now=None):
    current = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo(timezone_name))
    start = current.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=current.weekday())
    return start, start + timedelta(days=7), current


def publication_stamp(value, timezone_name="Asia/Kolkata"):
    if not isinstance(value, str):
        raise ValueError("Publication date is missing")
    value = value.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return datetime.fromisoformat(value).replace(tzinfo=ZoneInfo(timezone_name)), "day"
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        raise ValueError("Publication timestamp has no timezone")
    return stamp, "time"


def is_current_week(value, timezone_name="Asia/Kolkata", now=None):
    try:
        stamp, _ = publication_stamp(value, timezone_name)
        start, end, current = week_window(timezone_name, now)
        return start <= stamp < end and stamp <= current
    except (ValueError, TypeError, OverflowError):
        return False


def is_recent_post(value, timezone_name="Asia/Kolkata", now=None):
    try:
        stamp, _ = publication_stamp(value, timezone_name)
        current = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo(timezone_name))
        start = current.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1)
        return start <= stamp <= current
    except (ValueError, TypeError, OverflowError):
        return False


def _page_identity(value):
    parsed = urlsplit(value)
    return (parsed.hostname or "").removeprefix("www."), parsed.path.rstrip("/")


def article_nodes(soup, url):
    allowed_types = {"Article", "NewsArticle", "BlogPosting", "SocialMediaPosting", "ImageObject", "VideoObject"}
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            value = json.loads(script.get_text())
        except (ValueError, TypeError):
            continue
        roots = value if isinstance(value, list) else [value]
        for root in roots:
            if not isinstance(root, dict):
                continue
            nodes = root.get("@graph", [root])
            if not isinstance(nodes, list):
                continue
            for node in nodes:
                if not isinstance(node, dict):
                    continue
                types = node.get("@type", [])
                types = types if isinstance(types, list) else [types]
                if not any(kind in allowed_types for kind in types if isinstance(kind, str)):
                    continue
                identity = node.get("mainEntityOfPage") or node.get("url") or node.get("@id")
                if isinstance(identity, dict):
                    identity = identity.get("@id") or identity.get("url")
                if isinstance(identity, str) and identity.startswith("http") and _page_identity(identity) != _page_identity(url):
                    continue
                yield node


def extract_publication(markup, url, timezone_name="Asia/Kolkata"):
    soup = BeautifulSoup(markup, "html.parser")
    candidates = []
    for tag in soup.find_all("meta"):
        key = str(tag.get("property") or tag.get("name") or tag.get("itemprop") or "").casefold()
        if key in {"article:published_time", "datepublished", "pubdate"}:
            candidates.append((tag.get("content"), key))
    for node in article_nodes(soup, url):
        if node.get("datePublished"):
            candidates.append((node["datePublished"], "datePublished"))
        elif node.get("@type") in ("ImageObject", "VideoObject") and node.get("uploadDate"):
            candidates.append((node["uploadDate"], "uploadDate"))
    for tag in soup.select('article time[itemprop="datePublished"], article time.published'):
        candidates.append((tag.get("datetime"), "published time element"))
    host = (urlsplit(url).hostname or "").lower()
    if not candidates and (host == "instagram.com" or host.endswith(".instagram.com")):
        header = re.compile(r"^(?:[\d.,]+\s*[KMB]?\s+likes?,\s*[\d.,]+\s*[KMB]?\s+comments?\s*-\s*)?[A-Za-z0-9._]+\s+on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})(?::|$)", re.I)
        for tag in soup.select('meta[property="og:description"], meta[name="description"]'):
            match = header.match(str(tag.get("content") or "").strip())
            if match:
                try:
                    day = datetime.strptime(match.group(1), "%B %d, %Y").date().isoformat()
                    candidates.append((day, "Instagram publication header"))
                except ValueError:
                    continue
    parsed = []
    for value, evidence in candidates:
        try:
            stamp, precision = publication_stamp(value, timezone_name)
            parsed.append((stamp, precision, evidence))
        except (ValueError, TypeError, OverflowError):
            continue
    if not parsed:
        raise ValueError("No unambiguous original publication date on the source page")
    zone = ZoneInfo(timezone_name)
    if len({stamp.astimezone(zone).date() for stamp, _, _ in parsed}) != 1 or len({stamp for stamp, precision, _ in parsed if precision == "time"}) > 1:
        raise ValueError("Conflicting publication dates on the source page")
    stamp, precision, evidence = min(parsed, key=lambda item: (item[1] != "time", item[0]))
    return {"published_at": stamp.isoformat(), "published_date": stamp.astimezone(zone).date().isoformat(), "date_precision": precision, "date_evidence": evidence}
