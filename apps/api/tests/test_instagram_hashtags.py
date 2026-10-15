import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import instagram_hashtags as research, main
from app.database import get_db
from app.instagram_browser import RUN_KEY, RUNNER_KEY, default_config
from app.models import Base, Candidate, Case, ServiceState


def example(**changes):
    return SimpleNamespace(celebrity="Alia Bhatt", designer="Sabyasachi", source_title="Alia Bhatt in a red silk saree by Sabyasachi",
        source_body="Floral embroidery. #AliaBhattStyle @aliaabhatt", extraction={}, **changes)


def test_plan_searches_garment_maker_and_fabric_without_source_celebrity():
    plan = research.hashtag_plan(example(), default_config())
    tags = {item["tag"] for item in plan["hashtags"]}
    assert {"sabyasachi", "silksaree", "redsaree", "saree"} <= tags
    assert all(not research.mentions_identity(tag, plan["excluded_terms"]) for tag in tags)
    assert "aliaabhatt" in plan["excluded_terms"]
    query = plan["google_queries"][0]["query"]
    assert 'site:instagram.com/p/ "#sabyasachi" "#saree"' in query
    assert '-"Alia Bhatt"' in query and '-"aliaabhatt"' in query
    assert plan["time_scope"] == "all_available"
    assert plan["match_mode"] == "all" and plan["default_hashtags"] == ["sabyasachi", "saree"]


@pytest.mark.parametrize("caption,expected", [
    ("#Sabyasachi #SilkSaree", True), ("#silksaree\n#sabyasachi", True),
    ("#sabyasachi only", False), ("#silksaree only", False),
    ("Sabyasachi silk saree", False), ("#sabyasachi #silksareeExtra", False),
    ("#sabyasachi #silksareeé", False), ("#sabyasachi ##silksaree", False),
    ("#sabyasachi https://example.com/#silksaree", False),
])
def test_hashtags_stack_with_exact_and_semantics(caption, expected):
    assert research.contains_all_hashtags(caption, ["sabyasachi", "silksaree"]) is expected


def test_multiple_labels_and_contaminated_designer():
    case = example()
    case.designer = "AliaBhattStyle + H&M + House of CB"
    tags = {item["tag"] for item in research.hashtag_plan(case, default_config())["hashtags"]}
    assert "hm" in tags and "houseofcb" in tags
    assert all("alia" not in tag and "bhatt" not in tag for tag in tags)
    case.designer = "Unresolved"
    case.source_body = "Wearing @gucci in a silk saree"
    assert "gucci" in {item["tag"] for item in research.hashtag_plan(case, default_config())["hashtags"]}


def test_no_keywords_does_not_invent_generic_fashion_search():
    case = example()
    case.designer = "Unresolved"
    case.source_title = "Alia Bhatt at an event"
    case.source_body = ""
    plan = research.hashtag_plan(case, default_config())
    assert plan["hashtags"] == [] and plan["google_queries"] == []


def test_short_celebrity_names_do_not_discard_unrelated_words():
    excluded = research.identity_terms(example(), default_config())
    assert not research.mentions_identity("Italian silk saree", excluded)
    assert not research.mentions_identity("italiansilk", excluded, hashtag=True)
    assert research.mentions_identity("#AliaStyle", excluded)
    assert research.mentions_identity("Alia in silk", excluded)


@pytest.fixture
def studio(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    def database():
        with Session(engine) as db:
            yield db
    main.app.dependency_overrides[get_db] = database
    with Session(engine) as db:
        case = Case(id="look", permalink="https://www.reddit.com/r/BollywoodFashion/comments/original/", celebrity="Alia Bhatt", designer="Sabyasachi",
            source_title="Alia Bhatt in a red silk saree by Sabyasachi", source_body="Floral embroidery", source_type="reddit_rss")
        db.add(case)
        db.add(ServiceState(key=RUNNER_KEY, value={"heartbeat": time.time()}))
        db.commit()
    settings = SimpleNamespace(serpapi_key="test-key", source_import_user_agent="HHC-test")
    monkeypatch.setattr(research, "get_settings", lambda: settings)
    client = TestClient(main.app)
    headers = {"X-Editor-Key": main.settings.editor_api_key}
    try:
        yield client, headers, engine, settings
    finally:
        main.app.dependency_overrides.pop(get_db, None)
        engine.dispose()


def plan_for(client, headers):
    return client.get("/api/instagram-browser/cases/look/hashtags", headers=headers).json()


def queue(client, headers, tags=None):
    return client.post("/api/instagram-browser/cases/look/hashtags/search", headers=headers,
        json={"hashtags": tags or ["sabyasachi", "silksaree"], "context_fingerprint": plan_for(client, headers)["context_fingerprint"]})


def test_private_search_and_server_side_celebrity_exclusion(studio):
    client, headers, _, _ = studio
    assert client.get("/api/instagram-browser/cases/look/hashtags").status_code == 401
    for tag in ["AliaBhatt", "AliaBhattStyle", "aliaabhatt", "BhattSaree", "alia_red_saree"]:
        assert queue(client, headers, [tag]).status_code == 422
    assert queue(client, headers, ["silk saree"]).status_code == 422
    assert queue(client, headers, ["silksaree"] * 7).status_code == 422
    job = queue(client, headers).json()
    assert job["kind"] == "hashtag_search"
    assert queue(client, headers).status_code == 409
    claimed = client.post("/api/instagram-browser/claim", headers=headers, json={}).json()["run"]
    assert claimed["run_id"] == job["run_id"]


def test_offline_collector_and_stale_context(studio):
    client, headers, engine, _ = studio
    plan = plan_for(client, headers)
    with Session(engine) as db:
        db.get(ServiceState, RUNNER_KEY).value = {"heartbeat": 0}
        db.commit()
    assert queue(client, headers).status_code == 503
    with Session(engine) as db:
        db.get(Case, "look").designer = "Gucci"
        db.commit()
    assert client.post("/api/instagram-browser/cases/look/hashtags/search", headers=headers,
        json={"hashtags": ["sabyasachi"], "context_fingerprint": plan["context_fingerprint"]}).status_code == 409


def test_results_are_old_research_leads_without_automatic_collage_or_candidate(studio):
    client, headers, engine, _ = studio
    job = queue(client, headers).json()
    lead = {"shortcode": "older", "hashtag": "sabyasachi", "author": "designerarchive", "caption": "Another wearer in a red silk saree #Sabyasachi #SilkSaree", "published_at": "2020-01-01T10:00:00Z"}
    report = {"run_id": job["run_id"], "status": "completed", "tags_checked": 2, "posts_checked": 5,
        "results": [lead, lead, {**lead, "shortcode": "repost", "caption": "AliaBhattStyle in a silk saree"},
            {**lead, "shortcode": "celebrity", "author": "aliaabhatt"}, {**lead, "shortcode": "unknownDate", "published_at": "bad date"},
            {**lead, "shortcode": "partial", "caption": "#Sabyasachi"}, {**lead, "shortcode": "prefix", "caption": "#Sabyasachi #silksareeExtra"}]}
    response = client.post("/api/instagram-browser/hashtag-search/runs", headers=headers, json=report)
    assert response.status_code == 200
    results = plan_for(client, headers)["search"]["results"]
    assert len(results) == 2
    assert results[0]["published_at"].startswith("2020") and results[0]["review_required"]
    assert results[1]["published_at"] is None
    assert all(result["matched_hashtags"] == ["sabyasachi", "silksaree"] for result in results)
    assert plan_for(client, headers)["search"]["exclusions"]["missing_required_hashtags_reported"] == 2
    with Session(engine) as db:
        assert db.scalars(select(Candidate)).all() == []
        assert not db.get(Case, "look").extraction
    # A finished/stale collector cannot overwrite a newer run.
    assert client.post("/api/instagram-browser/hashtag-search/runs", headers=headers, json=report).status_code == 409


def test_context_change_stops_collector_and_hides_old_results(studio):
    client, headers, engine, _ = studio
    job = queue(client, headers).json()
    with Session(engine) as db:
        db.get(Case, "look").designer = "Gucci"
        db.commit()
    assert client.post("/api/instagram-browser/hashtag-search/runs", headers=headers,
        json={"run_id": job["run_id"], "status": "running", "results": []}).status_code == 409
    assert plan_for(client, headers)["search"]["status"] == "outdated"


def test_google_returns_only_distinct_instagram_post_leads_and_caches(studio, monkeypatch):
    client, headers, engine, _ = studio
    calls = []
    def get(url, **kwargs):
        calls.append(kwargs["params"])
        assert '-"Alia Bhatt"' in kwargs["params"]["q"]
        assert '"#sabyasachi"' in kwargs["params"]["q"]
        return SimpleNamespace(ok=True, json=lambda: {"organic_results": [
            {"link": "https://www.instagram.com/p/clone/?igsh=123", "title": "Sabyasachi red saree", "snippet": "Silk saree on another wearer"},
            {"link": "https://www.instagram.com/p/clone/", "title": "Same indexed result"},
            {"link": "https://www.instagram.com/p/original/", "title": "AliaBhattStyle"},
            {"link": "https://www.instagram.com/designer/", "title": "Designer profile"},
            {"link": "https://www.instagram.com/reel/video/", "title": "Video"},
            {"link": "https://example.com/p/post/", "title": "Other domain"},
            {"link": "https://www.instagram.com:444/p/bad/", "title": "Invalid URL"},
            {"link": "https://www.instagram.com/p/partial/", "title": "Saree", "snippet": "#sabyasachi #silksaree"},
            {"link": "https://www.instagram.com/p/locked/", "title": "Saree", "snippet": "#sabyasachi #silksaree"},
        ]})
    monkeypatch.setattr(research.requests, "get", get)
    checked = []
    def caption(url, settings):
        checked.append(url)
        if "locked" in url:
            raise research.PublicSourceError("Access unavailable")
        return {"author": "designerarchive", "caption": "#sabyasachi" if "partial" in url else "#Sabyasachi #SilkSaree"}
    monkeypatch.setattr(research, "public_post_caption", caption)
    payload = {"context_fingerprint": plan_for(client, headers)["context_fingerprint"], "hashtags": ["sabyasachi", "silksaree"]}
    response = client.post("/api/instagram-browser/cases/look/hashtags/google", headers=headers, json=payload)
    assert response.status_code == 200
    assert [lead["permalink"] for lead in response.json()["results"]] == ["https://www.instagram.com/p/clone/"]
    assert response.json()["results"][0]["published_at"] is None
    assert response.json()["results"][0]["matched_hashtags"] == ["sabyasachi", "silksaree"]
    assert response.json()["exclusions"] == {"missing_required_hashtags": 1, "caption_unverified": 1}
    assert "api_key" not in str(response.json())
    assert client.post("/api/instagram-browser/cases/look/hashtags/google", headers=headers, json=payload).status_code == 200
    assert len(calls) == 1
    assert len(checked) == 3
    # A new combination cannot reuse the old combination's cached results.
    changed = client.post("/api/instagram-browser/cases/look/hashtags/google", headers=headers,
        json={**payload, "hashtags": ["sabyasachi", "redsaree"]})
    assert changed.json()["results"] == [] and len(calls) == 2


def test_google_setup_and_provider_failures_are_explicit(studio, monkeypatch):
    client, headers, _, settings = studio
    payload = {"context_fingerprint": plan_for(client, headers)["context_fingerprint"], "hashtags": ["sabyasachi", "silksaree"]}
    settings.serpapi_key = ""
    assert client.post("/api/instagram-browser/cases/look/hashtags/google", headers=headers, json=payload).status_code == 503
    settings.serpapi_key = "test-key"
    monkeypatch.setattr(research.requests, "get", lambda *args, **kwargs: SimpleNamespace(ok=True, json=lambda: {"error": "test-key must never appear in output"}))
    result = client.post("/api/instagram-browser/cases/look/hashtags/google", headers=headers, json=payload).json()
    assert result["status"] == "unavailable" and result["warnings"]
    assert "test-key" not in str(result)


def test_public_caption_is_from_the_original_post_not_search_snippet(monkeypatch):
    settings = SimpleNamespace(source_import_user_agent="test")
    url = "https://www.instagram.com/p/photo/"
    markup = b'<meta property="og:description" content="archive on January 1, 2020: &quot;#Sabyasachi #SilkSaree&quot;"><meta property="og:image" content="https://cdn.example.com/photo.jpg">'
    monkeypatch.setattr(research, "_fetch_limited", lambda *args, **kwargs: (url, markup, "text/html"))
    assert research.public_post_caption(url, settings) == {"author": "archive", "caption": "#Sabyasachi #SilkSaree"}
    for final, content in [("https://www.instagram.com/accounts/login/", markup),
        (url, b'<title>Sign in</title>'), (url, markup + b'<input type="password">')]:
        monkeypatch.setattr(research, "_fetch_limited", lambda *args, **kwargs: (final, content, "text/html"))
        with pytest.raises(research.PublicSourceError):
            research.public_post_caption(url, settings)
