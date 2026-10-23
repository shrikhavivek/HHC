"""Instagram Business Discovery via the official Graph API, for configured accounts."""
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import requests
from sqlalchemy import select
from .automation import _add_matches, _automatic_draft, _collage_assets, editorial_subject_eligibility, parse_outfit
from .models import AuditEvent, Case
from .providers import before_request, observe_response, ProviderDeferred
from .public_sources import download_public_images
from .publication_dates import is_recent_post

class InstagramError(RuntimeError):
    pass

def graph_get(settings, path, params):
    if not re.fullmatch(r"v\d+\.\d+", settings.meta_graph_version) or not re.fullmatch(r"\d+", settings.instagram_account_id):
        raise InstagramError("Configure a valid Graph version and Instagram professional account ID")
    try:
        before_request("instagram", spacing=2.0)
        response = requests.get(f"https://graph.facebook.com/{settings.meta_graph_version}/{path}", params=params, headers={"Authorization": f"Bearer {settings.instagram_access_token}"}, timeout=(10, 30), allow_redirects=False)
        observe_response("instagram", response)
        if not response.ok:
            raise InstagramError(f"Instagram returned HTTP {response.status_code}; check token permissions and account access")
        return response.json()
    except (requests.RequestException, ValueError):
        raise InstagramError("Instagram could not be reached") from None
    except ProviderDeferred as exc:
        raise InstagramError(str(exc)) from None

def instagram_posts(settings, target_date):
    fields = "id,caption,media_type,media_url,permalink,timestamp,children{media_type,media_url}"
    accounts = [x.strip().lstrip("@") for x in settings.instagram_watch_accounts.split(",") if x.strip()] or [""]
    zone = ZoneInfo(settings.reddit_daily_timezone)
    for account in accounts[:20]:
        if account and not re.fullmatch(r"[A-Za-z0-9_.]{1,30}", account):
            raise InstagramError("Instagram watch accounts must be valid usernames")
        cursor = None
        seen = set()
        for _ in range(20):
            if account:
                paging = f".after({cursor})" if cursor else ""
                discovery_fields = "business_discovery.username(" + account + "){media.limit(100)" + paging + "{" + fields + "}}"
                data = graph_get(settings, settings.instagram_account_id, {"fields": discovery_fields})
                listing = data.get("business_discovery", {}).get("media", {})
            else:
                params = {"fields": fields, "limit": 100}
                if cursor:
                    params["after"] = cursor
                listing = graph_get(settings, f"{settings.instagram_account_id}/media", params)
            crossed = False
            for item in listing.get("data", []):
                try:
                    published = datetime.fromisoformat(item["timestamp"].replace("Z", "+00:00"))
                except (KeyError, ValueError):
                    continue
                day = published.astimezone(zone).date()
                if day < target_date:
                    crossed = True
                if day != target_date:
                    continue
                images = [child["media_url"] for child in item.get("children", {}).get("data", []) if child.get("media_type") == "IMAGE" and child.get("media_url")]
                if item.get("media_type") == "IMAGE" and item.get("media_url"):
                    images.insert(0, item["media_url"])
                if images and item.get("permalink"):
                    yield {**item, "image_urls": images, "published": published, "account": account or "connected account"}
            cursor = listing.get("paging", {}).get("cursors", {}).get("after")
            if crossed or not listing.get("paging", {}).get("next") or not cursor or cursor in seen:
                break
            if not re.fullmatch(r"[A-Za-z0-9_+/=.-]+", cursor):
                raise InstagramError("Instagram returned an invalid pagination cursor")
            seen.add(cursor)

def run_instagram(db, settings, static_dir, target_date):
    from .instagram_browser import brand_mentions, config_for
    if not settings.instagram_access_token or not settings.instagram_account_id:
        return {"status": "not_configured", "created": 0}
    summary = {"status": "completed", "created": 0, "skipped": 0, "failed": 0, "case_ids": []}
    for post in instagram_posts(settings, target_date):
        if not is_recent_post(post["published"].isoformat(), settings.reddit_daily_timezone):
            summary["skipped"] += 1
            continue
        if db.scalar(select(Case.id).where(Case.permalink == post["permalink"])):
            summary["skipped"] += 1
            continue
        caption = post.get("caption", "")
        if not brand_mentions(caption, [], config_for(db).brands):
            summary["skipped"] += 1
            continue
        title = caption.split("\n")[0][:500] or f"Instagram post by {post['account']}"
        outfit = parse_outfit(title, caption)
        eligible, _ = editorial_subject_eligibility(title, caption, outfit["celebrity"])
        if not eligible:
            summary["skipped"] += 1
            continue
        urls, images, _ = download_public_images(post["image_urls"], media_dir=settings.media_dir, user_agent=settings.source_import_user_agent, referer=post["permalink"])
        if not images:
            summary["failed"] += 1
            continue
        retrieved = datetime.now(timezone.utc).isoformat()
        asset_post = {"permalink": post["permalink"], "author": post["account"], "publisher": f"Instagram / {post['account']}", "image_urls": urls, "source_kind": "instagram_api"}
        case = Case(source_type="public_post_url", external_id=f"instagram:{post['id']}", permalink=post["permalink"], source_title=title, source_body=caption, celebrity=outfit["celebrity"], designer=outfit["designer"], event_name=outfit["event"], event_date=target_date.isoformat(), base_image=images[0], status="context_review", match_type="source_only", extraction={"source_platform": "Instagram", "source_publisher": asset_post["publisher"], "provider": "instagram_graph", "retrieved_at": retrieved, "source_image_urls": urls, "collage_assets": _collage_assets(asset_post, images, outfit, retrieved)})
        db.add(case)
        case.extraction = {**case.extraction, "published_at": post["published"].isoformat()}
        db.flush()
        candidates = _add_matches(db, case, settings.media_dir)
        _automatic_draft(db, case, candidates, settings, static_dir)
        db.add(AuditEvent(entity_type="case", entity_id=case.id, action="instagram_imported", actor="daily-automation", detail={"account": post["account"]}))
        db.commit()
        summary["created"] += 1
        summary["case_ids"].append(case.id)
    if summary["failed"]:
        summary["status"] = "completed_with_warnings"
    return summary
