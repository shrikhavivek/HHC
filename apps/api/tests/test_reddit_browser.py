import io
import json
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import main, reddit_browser as browser, reddit_gallery
from app.database import Base, get_db
from app.models import Case, Collage, ServiceState


@pytest.fixture
def intake(tmp_path, monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    def database():
        with Session(engine) as db:
            yield db
    main.app.dependency_overrides[get_db] = database
    monkeypatch.setattr(browser, "get_settings", lambda: SimpleNamespace(reddit_subreddit="BollywoodFashion", reddit_daily_timezone="Asia/Kolkata", media_dir=str(tmp_path), output_dir=str(tmp_path / "outputs")))
    monkeypatch.setattr(reddit_gallery, "get_settings", browser.get_settings)
    yield TestClient(main.app), {"X-Editor-Key": main.settings.editor_api_key}, engine, tmp_path
    main.app.dependency_overrides.clear()
    engine.dispose()


def test_authenticated_queue_claim_and_expiry(intake):
    client, headers, engine, _ = intake
    url = "/api/reddit-browser"
    assert client.post(url + "/scan").status_code == 401
    assert client.post(url + "/scan", headers=headers).status_code == 503
    assert client.post(url + "/heartbeat", headers=headers).status_code == 200
    run = client.post(url + "/scan", headers=headers).json()
    assert run["status"] == "queued"
    assert client.post(url + "/scan", headers=headers).json()["run_id"] == run["run_id"]
    assert client.post(url + "/claim", headers=headers).json()["run"]["run_id"] == run["run_id"]
    assert client.post(url + "/claim", headers=headers).json()["run"] is None
    assert client.post(url + "/runs", headers=headers, json={"run_id": "wrong", "status": "completed"}).status_code == 409
    assert client.post(url + "/runs", headers=headers, json={"run_id": run["run_id"], "status": "awaiting_login"}).status_code == 200
    assert client.post(url + "/runs", headers=headers, json={"run_id": run["run_id"], "status": "awaiting_attention"}).status_code == 200
    assert client.get(url + "/status", headers=headers).json()["status"] == "awaiting_attention"
    assert client.post(url + "/scan", headers=headers).json()["run_id"] == run["run_id"]
    assert client.post(url + "/claim", headers=headers).json()["run"] is None
    with Session(engine) as db:
        state = db.get(ServiceState, browser.RUN_KEY)
        state.value = {**state.value, "heartbeat": time.time() - 181}
        db.commit()
    assert client.get(url + "/status", headers=headers).json()["status"] == "interrupted"
    assert client.post(url + "/runs", headers=headers, json={"run_id": run["run_id"], "status": "running"}).status_code == 409


def upload(client, headers, **changes):
    metadata = {"post_id": "abc", "permalink": "https://www.reddit.com/r/BollywoodFashion/comments/abc/kriti/",
                "title": "Kriti Sanon in Gucci", "published_at": datetime.now(timezone.utc).isoformat(),
                "images": ["https://i.redd.it/one.jpg", "https://i.redd.it/two.jpg"], "carousel_complete": True, **changes}
    files = []
    for color in ("red", "blue"):
        photo = io.BytesIO()
        Image.new("RGB", (480, 640), color).save(photo, "JPEG")
        files.append(("images", (color + ".jpg", photo.getvalue(), "image/jpeg")))
    return client.post("/api/reddit-browser/posts", headers=headers, data={"metadata": json.dumps(metadata)}, files=files)


def test_screenshots_create_recent_draft_and_preserve_existing_edits(intake):
    client, headers, engine, _ = intake
    response = upload(client, headers)
    assert response.status_code == 200, response.text
    with Session(engine) as db:
        case = db.scalar(select(Case))
        assert case.celebrity == "Kriti Sanon"
        assert case.extraction["gallery_expanded"]
        assert case.extraction["image_capture"]["photo_count"] == 2
        assert db.scalar(select(Collage)) is not None
        case.source_title = "Editor corrected title"
        original_image = case.base_image
        db.commit()
    assert upload(client, headers).json()["duplicate"]
    with Session(engine) as db:
        assert len(db.scalars(select(Case)).all()) == 1
        assert db.scalar(select(Case)).base_image == original_image
        assert db.scalar(select(Case)).source_title == "Editor corrected title"


@pytest.mark.parametrize("changes", [
    {"permalink": "https://www.reddit.com/r/Other/comments/abc/kriti/"},
    {"permalink": "https://www.reddit.com/r/BollywoodFashion/comments/different/kriti/"},
    {"published_at": (datetime.now(timezone.utc) - timedelta(days=4)).isoformat()},
    {"published_at": datetime.now().replace(tzinfo=None).isoformat()},
    {"carousel_complete": False}, {"images": ["https://localhost/private.jpg"]},
    {"images": ["https://i.redd.it/one.jpg"]},
])
def test_invalid_or_incomplete_posts_do_not_create_cases(intake, changes):
    client, headers, engine, _ = intake
    assert upload(client, headers, **changes).status_code == 422
    with Session(engine) as db:
        assert db.scalar(select(Case)) is None


def test_invalid_image_does_not_leave_files_or_cases(intake):
    client, headers, engine, tmp_path = intake
    metadata = {"post_id": "abc", "permalink": "https://www.reddit.com/r/BollywoodFashion/comments/abc/kriti/", "title": "Kriti in Gucci", "published_at": datetime.now(timezone.utc).isoformat(), "images": ["https://i.redd.it/one.jpg"], "carousel_complete": True}
    response = client.post("/api/reddit-browser/posts", headers=headers, data={"metadata": json.dumps(metadata)}, files=[("images", ("bad.jpg", b"not an image", "image/jpeg"))])
    assert response.status_code == 422
    with Session(engine) as db:
        assert db.scalar(select(Case)) is None
    assert not list((tmp_path / "editor").glob("*"))


@pytest.mark.parametrize("title", ["Kriti Sanon at an event", "Kriti Sanon in a red dress"])
def test_reddit_posts_require_a_brand_credit(intake, title):
    client, headers, engine, _ = intake
    response = upload(client, headers, title=title)
    assert response.status_code == 200
    assert response.json()["excluded"] == "no_brand_credit"
    with Session(engine) as db:
        assert db.scalar(select(Case)) is None


def test_large_scan_coverage_is_retained(intake):
    client, headers, _, _ = intake
    client.post("/api/reddit-browser/heartbeat", headers=headers)
    run = client.post("/api/reddit-browser/scan", headers=headers).json()
    coverage = {"window_start": "2026-10-25", "window_end": "2026-10-26", "as_of": "2026-10-26T12:00:00Z", "targets": [{"target": "r/BollywoodFashion", "status": "partial", "checked": 150, "stop_reason": "feed_stalled"}]}
    response = client.post("/api/reddit-browser/runs", headers=headers, json={"run_id": run["run_id"], "status": "partial", "posts_checked": 150, "coverage": coverage})
    assert response.status_code == 200, response.text
    saved = client.get("/api/reddit-browser/status", headers=headers).json()
    assert saved["coverage"]["targets"][0]["checked"] == 150
    assert saved["coverage"]["targets"][0]["status"] == "partial"


def test_incomplete_existing_gallery_requires_matching_revision(intake):
    client, headers, engine, _ = intake
    assert upload(client, headers).status_code == 200
    with Session(engine) as db:
        case = db.scalar(select(Case))
        case.extraction = {**case.extraction, "gallery_expanded": False, "collage_edit": {"revision": 3}}
        db.commit()
    known = client.get("/api/reddit-browser/known", headers=headers).json()
    assert known[0]["complete"] is False
    assert known[0]["revision"] == 3
    assert upload(client, headers).status_code == 409
    assert upload(client, headers, expected_revision=2).status_code == 409
    response = upload(client, headers, expected_revision=3)
    assert response.status_code == 200, response.text
    assert response.json()["updated"]
