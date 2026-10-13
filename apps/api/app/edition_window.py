"""Daily desk visibility; historical cases remain available for outfit research."""
from datetime import datetime, timedelta, timezone, date
from zoneinfo import ZoneInfo
from .publication_dates import is_current_week, is_recent_post


def in_current_edition(case, timezone_name="Asia/Kolkata", now=None):
    zone = ZoneInfo(timezone_name)
    today = (now or datetime.now(timezone.utc)).astimezone(zone).date()
    extraction = case.extraction or {}
    published = extraction.get("published_at")
    if extraction.get("source_platform") == "Instagram" or extraction.get("provider") == "instagram_browser":
        return is_recent_post(published, timezone_name, now)
    if extraction.get("web_discovered"):
        return is_current_week(published, timezone_name, now)
    try:
        if published:
            stamp = datetime.fromisoformat(published.replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=timezone.utc)
            day = stamp.astimezone(zone).date()
        elif case.source_type in {"reddit_rss", "public_post_url", "instagram"} and case.event_date:
            # Legacy automated cases stored their source publication date here.
            day = date.fromisoformat(case.event_date[:10])
        else:
            stamp = case.created_at
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=timezone.utc)
            day = stamp.astimezone(zone).date()
    except (ValueError, TypeError, AttributeError):
        return False
    return today - timedelta(days=1) <= day <= today
