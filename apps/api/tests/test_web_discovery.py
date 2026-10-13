import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app import automation, main, web_discovery
from app.edition_window import in_current_edition
from app.models import Base, Case
from app.public_sources import PublicSourceError
from app.publication_dates import extract_publication, is_current_week, week_window


NOW = datetime(2026, 10, 13, 9, tzinfo=timezone.utc)
URL = "https://fashion.example/actor-one-outfit/"


@pytest.fixture(autouse=True)
def reset_search_state(monkeypatch):
    web_discovery._search_cache.clear()
    monkeypatch.setattr(web_discovery, "_search_blocked_until", 0.0)
    yield
    web_discovery._search_cache.clear()


def page(published="2026-10-12T20:00:00Z", extra=""):
    return f'''<html><head><meta property="og:title" content="Actor One in Example Designer">
    <meta property="og:description" content="Actor One wears an embroidered gown.">
    <meta property="og:image" content="https://images.example/outfit.jpg">
    <meta property="article:published_time" content="{published}">{extra}</head></html>'''


@pytest.mark.parametrize("value,expected", [
    ("2026-10-11T18:29:59Z", False), ("2026-10-11T18:30:00Z", True),
    ("2026-10-12", True), ("2026-10-13", True), ("2026-10-14", False),
    ("2026-10-13T09:00:01Z", False), ("2026-10-19", False),
    ("2026-10-12T12:00:00", False), ("2026-02-30", False), (None, False),
])
def test_calendar_week_in_india_excludes_unknown_future_and_old_dates(value, expected):
    assert is_current_week(value, now=NOW) is expected


def test_week_crosses_year_and_resets_on_monday():
    start, end, _ = week_window(now=datetime(2027, 1, 1, tzinfo=timezone.utc))
    assert start.date().isoformat() == "2026-12-28"
    assert end.date().isoformat() == "2027-01-04"
    assert not is_current_week("2026-10-18", now=datetime(2026, 10, 18, 18, 30, tzinfo=timezone.utc))


def test_publication_uses_original_date_not_modified_date():
    markup = page("2026-10-01T12:00:00Z", '<meta property="article:modified_time" content="2026-10-13T05:00:00Z">')
    result = extract_publication(markup, URL)
    assert result["published_date"] == "2026-10-01"
    assert not is_current_week(result["published_at"], now=NOW)


def test_publication_rejects_nested_related_dates_and_modified_only():
    for node in [
        {"@type": "WebPage", "dateModified": "2026-10-13T00:00:00Z"},
        {"@type": "Article", "comment": {"datePublished": "2026-10-13"}},
        {"@type": "Article", "url": "https://fashion.example/other/", "datePublished": "2026-10-13"},
    ]:
        with pytest.raises(ValueError, match="No unambiguous"):
            extract_publication(f'<script type="application/ld+json">{json.dumps(node)}</script>', URL)


def test_structured_publication_and_date_precision():
    markup = '<script type="application/ld+json">{"@graph":[{"@type":"BlogPosting","datePublished":"2026-10-12","dateModified":"2026-10-13"}]}</script>'
    result = extract_publication(markup, URL)
    assert result["published_date"] == "2026-10-12"
    assert result["date_precision"] == "day"
    assert result["published_at"].endswith("+05:30")
    assert extract_publication(page(), URL)["published_date"] == "2026-10-13"


def test_conflicting_publication_dates_are_not_guessed():
    markup = page(extra='<script type="application/ld+json">{"@type":"Article","datePublished":"2026-10-01T10:00:00Z"}</script>')
    with pytest.raises(ValueError, match="Conflicting"):
        extract_publication(markup, URL)
    with pytest.raises(ValueError, match="Conflicting"):
        extract_publication(page(extra='<meta name="datePublished" content="2026-10-12T22:00:00Z">'), URL)


def test_weekly_inspection_requires_source_date_and_public_html(monkeypatch):
    monkeypatch.setattr(web_discovery, "accessible_document", lambda url: (url, page().encode(), "text/html"))
    result = web_discovery.inspect_weekly_post(URL + "?utm_source=instagram#tracking", now=NOW)
    assert result["permalink"] == URL
    assert result["web_discovered"] is True
    assert result["published_date"] == "2026-10-13"
    markup_with_thumbnail = page(extra='<script type="application/ld+json">{"@type":"Article","thumbnailUrl":"https://images.example/outfit-small.jpg"}</script>')
    monkeypatch.setattr(web_discovery, "accessible_document", lambda url: (url, markup_with_thumbnail.encode(), "text/html"))
    assert web_discovery.inspect_weekly_post(URL, now=NOW)["image_urls"] == ["https://images.example/outfit.jpg"]
    for markup in [page("2026-10-01"), page(""), page("2026-10-14"), page(extra='<input type="password">')]:
        monkeypatch.setattr(web_discovery, "accessible_document", lambda url: (url, markup.encode(), "text/html"))
        with pytest.raises(PublicSourceError):
            web_discovery.inspect_weekly_post(URL, now=NOW)


def test_search_challenge_is_reported_not_bypassed(monkeypatch):
    monkeypatch.setattr(web_discovery, "fetch_document", lambda url: (url, b'<form id="challenge-form"></form>', "text/html"))
    with pytest.raises(PublicSourceError, match="challenge"):
        web_discovery.search_links("Actor One")


def test_search_result_links_are_decoded(monkeypatch):
    markup = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffashion.example%2Fpost%2F">Result</a>'
    monkeypatch.setattr(web_discovery, "fetch_document", lambda url: (url, markup.encode(), "text/html"))
    assert web_discovery.search_links("Actor One") == ["https://fashion.example/post/"]


def test_search_cache_expires_and_does_not_cache_challenges(monkeypatch):
    clock = [100.0]
    calls = []
    monkeypatch.setattr(web_discovery.time, "monotonic", lambda: clock[0])
    def fetch(query):
        calls.append(query)
        return [URL]
    monkeypatch.setattr(web_discovery, "_fetch_search_links", fetch)
    assert web_discovery.search_links("Actor One") == [URL]
    assert web_discovery.search_links("  actor   one ") == [URL]
    assert len(calls) == 1
    clock[0] += web_discovery.SEARCH_CACHE_SECONDS
    assert web_discovery.search_links("Actor One") == [URL]
    assert len(calls) == 2
    def blocked(query):
        calls.append(query)
        raise PublicSourceError("Browser challenge")
    monkeypatch.setattr(web_discovery, "_fetch_search_links", blocked)
    with pytest.raises(PublicSourceError, match="challenge"):
        web_discovery.search_links("Another Actor")
    with pytest.raises(PublicSourceError, match="paused"):
        web_discovery.search_links("Third Actor")
    assert len(calls) == 3
    assert web_discovery.search_links("Actor One") == [URL]
    clock[0] += web_discovery.SEARCH_COOLDOWN_SECONDS
    monkeypatch.setattr(web_discovery, "_fetch_search_links", fetch)
    assert web_discovery.search_links("Another Actor") == [URL]
    assert len(calls) == 4


def test_blocked_discovery_is_unavailable_not_a_successful_empty_search(monkeypatch):
    settings = SimpleNamespace(reddit_daily_timezone="Asia/Kolkata")
    def blocked(query):
        raise PublicSourceError("Search provider requires a browser challenge")
    monkeypatch.setattr(web_discovery, "search_links", blocked)
    result = web_discovery.discover_weekly_posts("Kriti Sanon", settings, now=NOW)
    assert result["search_status"] == "unavailable"
    assert result["checked"] == 0
    monkeypatch.setattr(main, "before_request", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "discover_weekly_posts", lambda *args, **kwargs: result)
    response = TestClient(main.app).post("/api/discovery/web/search", headers={"X-Editor-Key": main.settings.editor_api_key}, json={"query": "Kriti Sanon"})
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "300"
    assert "no posts were checked" in response.json()["detail"]
    monkeypatch.setattr(web_discovery, "search_links", lambda query: [])
    assert web_discovery.discover_weekly_posts("Kriti Sanon", settings, now=NOW)["search_status"] == "complete"


def test_partial_search_retains_verified_results(monkeypatch):
    def search(query):
        if "/reel/" in query:
            raise PublicSourceError("Browser challenge")
        return ["https://www.instagram.com/p/current/"]
    monkeypatch.setattr(web_discovery, "search_links", search)
    monkeypatch.setattr(web_discovery, "fetch_document", lambda url: (url, page().encode(), "text/html"))
    result = web_discovery.discover_weekly_posts("Kriti Sanon", SimpleNamespace(reddit_daily_timezone="Asia/Kolkata"), now=NOW)
    assert result["search_status"] == "partial"
    assert len(result["results"]) == 1
    assert result["warnings"]


@pytest.mark.parametrize("header,day", [
    ('979K likes, 1,808 comments - aliaabhatt on October 12, 2026: &quot;A look&quot;', "2026-10-12"),
    ('style_desk on October 13, 2026: &quot;Designer credits&quot;', "2026-10-13"),
    ('294 likes, 5 comments - the_models_muse on October 9, 2026', "2026-10-09"),
    ('12.5M likes, 40 comments - actor.one on October 11, 2026: &quot;October 13, 2026 is our next event&quot;', "2026-10-11"),
])
def test_instagram_publication_header_is_parsed_not_caption_dates(header, day):
    markup = f'<meta property="og:description" content="{header}">'
    result = extract_publication(markup, "https://www.instagram.com/p/example/")
    assert result["published_date"] == day
    assert result["date_precision"] == "day"
    assert result["date_evidence"] == "Instagram publication header"


def test_instagram_caption_mentions_do_not_become_publication_dates():
    markup = '<meta property="og:description" content="A gown from the show on October 13, 2026: beautiful styling">'
    with pytest.raises(ValueError, match="No unambiguous"):
        extract_publication(markup, "https://www.instagram.com/p/example/")


def test_instagram_inspection_uses_public_post_metadata_without_login(monkeypatch):
    markup = '<meta property="og:title" content="Alia Bhatt on Instagram"><meta property="og:description" content="200 likes, 2 comments - aliaabhatt on October 12, 2026: &quot;A look&quot;"><meta property="og:image" content="https://images.example/actual-post.jpg">'
    monkeypatch.setattr(web_discovery, "fetch_document", lambda url: (url, markup.encode(), "text/html"))
    post = web_discovery.inspect_weekly_post("https://instagram.com/p/abc123/?igsh=test", now=NOW)
    assert post["platform"] == "Instagram"
    assert post["published_date"] == "2026-10-12"
    assert post["permalink"] == "https://www.instagram.com/p/abc123/"
    monkeypatch.setattr(web_discovery, "fetch_document", lambda url: ("https://www.instagram.com/accounts/login/", markup.encode(), "text/html"))
    with pytest.raises(PublicSourceError, match="redirected"):
        web_discovery.inspect_weekly_post("https://instagram.com/p/abc123/", now=NOW)


def test_instagram_search_is_targeted_and_does_not_substitute_news(monkeypatch):
    queries = []
    def search(query):
        queries.append(query)
        return [URL, "https://www.instagram.com/aliaabhatt/", "https://www.instagram.com/p/old/", "https://www.instagram.com/p/new/"]
    monkeypatch.setattr(web_discovery, "search_links", search)
    monkeypatch.setattr(web_discovery, "feed_links", lambda *args: pytest.fail("Instagram discovery must not substitute fashion feeds"))
    def fetch(url):
        markup = page("2026-10-01" if "/old/" in url else "2026-10-12")
        return url, markup.encode(), "text/html"
    monkeypatch.setattr(web_discovery, "fetch_document", fetch)
    result = web_discovery.discover_weekly_posts("Alia Bhatt", SimpleNamespace(reddit_daily_timezone="Asia/Kolkata"), now=NOW)
    assert queries == ["site:instagram.com/p/ Alia Bhatt", "site:instagram.com/reel/ Alia Bhatt"]
    assert len(result["results"]) == 1
    assert result["results"][0]["platform"] == "Instagram"
    assert result["rejected"][0]["code"] == "outside_week"
    assert result["checked"] == 2


def test_discovery_falls_back_to_feeds_and_filters_source_dates(monkeypatch):
    def blocked(query):
        raise PublicSourceError("Search unavailable")
    monkeypatch.setattr(web_discovery, "search_links", blocked)
    monkeypatch.setattr(web_discovery, "feed_links", lambda *args: [URL, URL + "?utm_source=test", "https://fashion.example/old/"])
    monkeypatch.setattr(web_discovery, "accessible_document", lambda url: (url, page("2026-10-01" if "/old/" in url else "2026-10-12T20:00:00Z").encode(), "text/html"))
    settings = SimpleNamespace(reddit_daily_timezone="Asia/Kolkata", web_discovery_feeds="https://fashion.example/feed/")
    result = web_discovery.discover_weekly_posts("", settings, now=NOW, source="web")
    assert result["checked"] == 2
    assert result["excluded"] == 1
    assert len(result["results"]) == 1
    assert result["warnings"]
    assert result["week_start"] == "2026-10-12"


def test_robots_restrictions_are_checked_before_fetch(monkeypatch):
    monkeypatch.setattr(web_discovery, "robots_rules", lambda *args: SimpleNamespace(can_fetch=lambda *args: False))
    def fetch(url, **kwargs):
        kwargs["check_access"](url)
        pytest.fail("A restricted source must not be fetched")
    monkeypatch.setattr(web_discovery, "fetch_document", fetch)
    with pytest.raises(PublicSourceError, match="does not allow"):
        web_discovery.accessible_document(URL)


@pytest.mark.parametrize("url", ["http://fashion.example/post", "https://user:password@fashion.example/post", "https://fashion.example:8080/post", "https://fashion.example/"])
def test_discovery_url_validation(url):
    with pytest.raises(PublicSourceError):
        web_discovery.canonical_url(url)


def test_web_edition_uses_saved_publication_not_editable_appearance():
    row = SimpleNamespace(extraction={"web_discovered": True, "published_at": "2026-10-12T00:00:00Z"}, event_date="2000-01-01")
    assert in_current_edition(row, now=NOW)
    assert not in_current_edition(row, now=datetime(2026, 10, 19, tzinfo=timezone.utc))
    row.extraction["published_at"] = None
    assert not in_current_edition(row, now=NOW)


def test_import_endpoint_rechecks_date_and_ignores_client_date(monkeypatch):
    monkeypatch.setattr(main, "before_request", lambda *args, **kwargs: None)
    def expired(url, zone):
        raise PublicSourceError("The source was not published in the current calendar week")
    monkeypatch.setattr(main, "inspect_weekly_post", expired)
    monkeypatch.setattr(main, "import_public_post_automation", lambda *args, **kwargs: pytest.fail("Old sources cannot reach import"))
    client = TestClient(main.app)
    assert client.post("/api/discovery/web/search", json={}).status_code == 401
    response = client.post("/api/discovery/web/import", headers={"X-Editor-Key": main.settings.editor_api_key}, json={"source_url": URL, "published_at": NOW.isoformat()})
    assert response.status_code == 422
    assert "current calendar week" in response.json()["detail"]


def test_verified_web_import_persists_publication_independently(monkeypatch, tmp_path):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    stamp = datetime.now(timezone.utc).isoformat()
    source = {"title": "Actor One in Example Designer", "description": "Actor One wears a gown.", "platform": "Web", "publisher": "Fashion desk", "permalink": URL, "post_id": "web-post", "image_urls": ["https://images.example/look.jpg"], "published": stamp, "published_at": stamp, "published_date": stamp[:10], "date_precision": "time", "date_evidence": "datePublished", "web_discovered": True}
    monkeypatch.setattr(automation, "download_public_images", lambda *args, **kwargs: (source["image_urls"], ["/media-files/imports/look.jpg"], []))
    monkeypatch.setattr(automation, "_research_existing_case", lambda *args: {"matches": 0})
    settings = SimpleNamespace(source_import_user_agent="test", media_dir=str(tmp_path), reddit_daily_timezone="Asia/Kolkata")
    with Session(engine) as db:
        result = automation.import_public_post_automation(db, {"source_url": URL}, settings, str(tmp_path), verified_source=source)
        row = db.get(Case, result["case_id"])
        assert row.extraction["published_at"] == stamp
        assert row.extraction["web_discovered"] is True
        assert row.extraction["publication"]["date_evidence"] == "datePublished"
        row.event_date = "2000-01-01"
        assert in_current_edition(row)
        with pytest.raises(PublicSourceError, match="already"):
            automation.import_public_post_automation(db, {"source_url": URL}, settings, str(tmp_path), verified_source=source)
        assert len(db.scalars(select(Case)).all()) == 1
