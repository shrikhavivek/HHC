import hashlib
import time
from pathlib import Path
from types import SimpleNamespace
import pytest
from PIL import Image
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app import main
from app.database import Base, get_db
from app.models import AuditEvent, Candidate, Case, Collage, StoryDraft
from app.review import approval_errors, earlier_date
from app.providers import retry_seconds

@pytest.fixture()
def studio(tmp_path, monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(main.settings, "output_dir", str(tmp_path / "outputs"))
    monkeypatch.setattr(main.settings, "media_dir", str(tmp_path / "media"))
    (tmp_path / "media").mkdir()
    Image.new("RGB", (480, 720), "#706050").save(tmp_path / "media" / "test-photo.png")
    def db_override():
        with factory() as db:
            yield db
    main.app.dependency_overrides[get_db] = db_override
    with factory() as db:
        case = Case(id="editorial-case", permalink="https://www.reddit.com/r/BollywoodFashion/comments/test/post/", source_title="Deepika Padukone in Sabyasachi", celebrity="Deepika Padukone", designer="Sabyasachi", event_name="Fashion event", event_date="2026-10-06", base_image="/media-files/test-photo.png", demo_data=False)
        db.add(case)
        db.commit()
    client = TestClient(main.app)
    headers = {"X-Editor-Key": main.settings.editor_api_key, "X-Editor-Id": "real-editor"}
    yield client, headers, factory
    main.app.dependency_overrides.clear()
    engine.dispose()

def render(client, headers, revision=0):
    response = client.post("/api/cases/editorial-case/collage/edit", headers=headers, json={"panel_ids": ["current-primary"], "expected_revision": revision})
    assert response.status_code == 200, response.text
    return response.json()

def test_private_reads_and_media_require_authentication(studio):
    client, _, _ = studio
    for path in ("/api/cases", "/api/dashboard", "/outputs/anything.webp", "/media-files/a.jpg", "/static/look-1.png", "/docs", "/api/operations"):
        assert client.get(path).status_code == 401

def test_sessions_expire_and_can_be_revoked(studio):
    client, headers, _ = studio
    session_id = "a" * 64
    assert client.post("/api/internal/sessions", headers=headers, json={"id": session_id, "actor": "editor", "expires_at": int(time.time()) + 300}).status_code == 200
    assert client.get(f"/api/internal/sessions/{session_id}", headers=headers).json()["actor"] == "editor"
    assert client.delete(f"/api/internal/sessions/{session_id}", headers=headers).status_code == 200
    assert client.get(f"/api/internal/sessions/{session_id}", headers=headers).status_code == 401

def test_login_limits_are_durable(studio):
    client, headers, _ = studio
    for _ in range(10):
        assert client.post("/api/internal/login-attempt", headers=headers, json={"key": "b" * 64}).status_code == 200
    blocked = client.post("/api/internal/login-attempt", headers=headers, json={"key": "b" * 64})
    assert blocked.status_code == 429
    assert blocked.headers["retry-after"] == "900"

def test_story_conflicts_and_authenticated_audit_actor(studio):
    client, headers, factory = studio
    payload = {"title": "The repeated look", "body": "An editorial observation.", "expected_revision": 0, "editor_id": "spoofed"}
    saved = client.post("/api/cases/editorial-case/story", headers=headers, json=payload)
    assert saved.status_code == 200
    assert saved.json()["revision"] == 1
    assert client.post("/api/cases/editorial-case/story", headers=headers, json=payload).status_code == 409
    with factory() as db:
        event = db.scalar(select(AuditEvent).where(AuditEvent.action == "story_saved"))
        assert event.actor == "real-editor"

def test_renders_are_immutable_and_stale_saves_rejected(studio):
    client, headers, factory = studio
    render(client, headers)
    with factory() as db:
        first = db.scalar(select(Collage))
        path = Path(first.image_path)
        fingerprint = hashlib.sha256(path.read_bytes()).hexdigest()
    stale = client.post("/api/cases/editorial-case/collage/edit", headers=headers, json={"panel_ids": ["current-primary"], "expected_revision": 0})
    assert stale.status_code == 409
    render(client, headers, 1)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == fingerprint
    history = client.get("/api/cases/editorial-case/history", headers=headers).json()
    assert len(history["versions"]) == 2
    assert history["versions"][0]["preview_url"] != history["versions"][1]["preview_url"]

def test_algorithmic_identity_is_not_editorial_approval():
    candidate = SimpleNamespace(proposed_match_type="same_outfit_other_celebrity", checks={"identity": True, "chronology": True}, evidence=[{"grade": "A", "url": "https://example.com/source"}], rights_status="editorial_review_required")
    assert any("editor" in error.lower() for error in approval_errors(candidate))
    assert not earlier_date("2026-10-07", "2026-10-06")
    assert not earlier_date(None, "2026-10-06")
    assert earlier_date("2020-01-01", "2026-10-06")

def test_full_upstream_cooldown_is_respected():
    assert retry_seconds({"Retry-After": "600"}) == 600
    assert retry_seconds({"Retry-After": "60", "X-Ratelimit-Reset": "900"}) == 900
    from app.automation import _retry_delay, AutomationError
    with pytest.raises(AutomationError, match="600"):
        _retry_delay(SimpleNamespace(headers={"Retry-After": "600"}), 0)

def test_wordpress_handoff_is_draft_only_and_escapes_content(studio, monkeypatch):
    from app import wordpress
    client, headers, factory = studio
    monkeypatch.setattr(main.settings, "wordpress_publisher_enabled", True)
    generated = render(client, headers)
    payload = {"title": "The look", "body": '<script>alert("x")</script>', "alt_text": "An outfit comparison", "credits": "Photos: editorial licence", "expected_revision": 0, "reviewed_collage_id": generated["id"]}
    assert client.post("/api/cases/editorial-case/story", headers=headers, json=payload).status_code == 200
    calls = []
    def request(auth, method, path, **kwargs):
        calls.append((method, path, kwargs))
        if path == "users/me":
            return {"capabilities": {"edit_posts": True, "upload_files": True}}
        if method == "GET":
            return []
        if path == "media":
            return {"id": 101, "source_url": "https://example.com/collage.webp"}
        return {"id": 202, "status": "draft"}
    monkeypatch.setattr(wordpress, "wp_request", request)
    response = client.post("/api/cases/editorial-case/wordpress", headers={**headers, "X-WP-Authorization": "Basic dGVzdA=="}, json={})
    assert response.status_code == 200, response.text
    post = next(args["json"] for method, path, args in calls if method == "POST" and path == "posts")
    assert post["status"] == "draft"
    assert "<script>" not in post["content"]
    assert "&lt;script&gt;" in post["content"]
    with factory() as db:
        assert db.get(StoryDraft, "editorial-case").wordpress_post_id == 202

def test_uncertain_wordpress_handoff_is_not_blindly_retried(studio, monkeypatch):
    from app import wordpress
    client, headers, factory = studio
    monkeypatch.setattr(main.settings, "wordpress_publisher_enabled", True)
    generated = render(client, headers)
    assert client.post("/api/cases/editorial-case/story", headers=headers, json={"title": "The look", "body": "Editorial story", "alt_text": "Outfit", "credits": "Photo agency", "expected_revision": 0, "reviewed_collage_id": generated["id"]}).status_code == 200
    writes = []
    def request(auth, method, path, **kwargs):
        if path == "users/me":
            return {"capabilities": {"edit_posts": True, "upload_files": True}}
        if method == "GET":
            return []
        writes.append(path)
        raise HTTPException(502, "Timeout")
    monkeypatch.setattr(wordpress, "wp_request", request)
    headers = {**headers, "X-WP-Authorization": "Basic dGVzdA=="}
    assert client.post("/api/cases/editorial-case/wordpress", headers=headers, json={}).status_code == 502
    assert client.post("/api/cases/editorial-case/wordpress", headers=headers, json={}).status_code == 409
    assert writes == ["media"]

def test_context_corrections_are_versioned_and_invalidate_old_review(studio):
    client, headers, factory = studio
    rendered = render(client, headers)
    assert client.post("/api/cases/editorial-case/story", headers=headers, json={
        "title": "The look", "expected_revision": 0, "reviewed_collage_id": rendered["id"]
    }).status_code == 200
    correction = {"title": "An editor-corrected look", "celebrity": "Deepika Padukone", "designer": "Verified designer", "event_date": "2026-10-05", "expected_revision": 0}
    assert client.post("/api/cases/editorial-case/context", headers=headers, json=correction).status_code == 200
    assert client.post("/api/cases/editorial-case/context", headers=headers, json=correction).status_code == 409
    with factory() as db:
        assert db.get(Case, "editorial-case").designer == "Verified designer"
        assert db.get(StoryDraft, "editorial-case").reviewed_collage_id is None


def test_public_download_rejects_private_dns_and_non_https(monkeypatch):
    import socket
    import requests
    from app.safe_http import PublicHTTPSAdapter, public_get
    with pytest.raises(requests.exceptions.InvalidURL):
        public_get("http://127.0.0.1/private")
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("127.0.0.1", 443))])
    adapter = PublicHTTPSAdapter()
    request = requests.Request("GET", "https://example.com/photo.jpg").prepare()
    with pytest.raises(requests.exceptions.InvalidURL):
        adapter.get_connection_with_tls_context(request, True)
    adapter.close()


def test_public_download_pins_ip_but_verifies_original_hostname(monkeypatch):
    import socket
    import requests
    from app.safe_http import PublicHTTPSAdapter
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 443))])
    adapter = PublicHTTPSAdapter()
    request = requests.Request("GET", "https://example.com/photo.jpg").prepare()
    pool = adapter.get_connection_with_tls_context(request, True)
    assert pool.host == "93.184.216.34"
    assert pool.assert_hostname == "example.com"
    assert pool.conn_kw["server_hostname"] == "example.com"
    assert request.headers["Host"] == "example.com"
    adapter.close()


def test_instagram_business_discovery_keeps_only_daily_images(monkeypatch):
    from datetime import date
    from app import instagram
    calls = []
    def graph(settings, path, params):
        calls.append((path, params))
        return {"business_discovery": {"media": {"data": [
            {"id": "today", "timestamp": "2026-10-06T05:00:00+0000", "media_type": "CAROUSEL_ALBUM", "permalink": "https://www.instagram.com/p/today/", "children": {"data": [
                {"media_type": "IMAGE", "media_url": "https://cdn.example.com/photo.jpg"},
                {"media_type": "VIDEO", "media_url": "https://cdn.example.com/video.mp4"}]}},
            {"id": "old", "timestamp": "2026-10-05T05:00:00+0000", "media_type": "IMAGE", "media_url": "https://cdn.example.com/old.jpg", "permalink": "https://www.instagram.com/p/old/"}
        ]}}}
    monkeypatch.setattr(instagram, "graph_get", graph)
    settings = SimpleNamespace(instagram_watch_accounts="@testfashion", reddit_daily_timezone="Asia/Kolkata", instagram_account_id="123")
    posts = list(instagram.instagram_posts(settings, date(2026, 10, 6)))
    assert len(posts) == 1
    assert posts[0]["image_urls"] == ["https://cdn.example.com/photo.jpg"]
    query = calls[0][1]["fields"]
    assert query.startswith("business_discovery.username(testfashion){media.limit(100){")
    assert query.count("{") == query.count("}")


def test_high_resolution_exports_and_version_restore(studio):
    client, headers, factory = studio
    response = client.post("/api/cases/editorial-case/collage/edit", headers=headers, json={
        "panel_ids": ["current-primary"], "expected_revision": 0, "export_scale": 2,
        "canvas_format": "instagram_portrait",
        "panel_options": {"current-primary": {"rotation_degrees": 90, "caption": "Photo credit", "flip_horizontal": True}}
    })
    assert response.status_code == 200, response.text
    version = response.json()["id"]
    with factory() as db:
        collage = db.get(Collage, version)
        with Image.open(collage.image_path) as image:
            assert image.width == 2160
    render(client, headers, 1)
    restored = client.post("/api/cases/editorial-case/restore", headers=headers, json={"collage_id": version, "expected_revision": 2})
    assert restored.status_code == 200, restored.text
    assert restored.json()["id"] != version
    detail = client.get("/api/cases/editorial-case", headers=headers).json()
    assert detail["collage_editor"]["export_scale"] == 2
