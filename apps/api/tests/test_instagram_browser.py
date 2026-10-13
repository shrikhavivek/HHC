import io
import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import instagram_browser as browser, main
from app.database import get_db
from app.edition_window import in_current_edition
from app.models import Base, Case, Collage
from app.publication_dates import is_recent_post

NOW = datetime(2026, 10, 13, 8, tzinfo=timezone.utc)


@pytest.mark.parametrize("stamp,expected", [("2026-10-11T18:30:00Z", True), ("2026-10-11T18:29:59Z", False), ("2026-10-13T08:00:01Z", False), ("2026-10-12T12:00:00", False), (None, False)])
def test_recent_dates(stamp, expected):
    assert is_recent_post(stamp, now=NOW) is expected


def test_instagram_edition_expires_even_with_week_flag():
    case = SimpleNamespace(extraction={"source_platform": "Instagram", "web_discovered": True, "published_at": "2026-10-11T08:00:00Z"})
    assert not in_current_edition(case, now=NOW)
    case.extraction["published_at"] = "2026-10-12T08:00:00Z"
    assert in_current_edition(case, now=NOW)


def test_brand_evidence_is_not_any_mention():
    brands = [browser.Brand(name="Gucci", handles=["gucci"])]
    assert browser.brand_mentions("Wearing @GUCCI", [], brands)
    assert browser.brand_mentions("A Gucci dress", [], brands)
    assert browser.brand_mentions("My look", ["gucci"], brands)
    assert not browser.brand_mentions("@guccifan @stylist", [], brands)
    assert not browser.brand_mentions("Guccified", [], brands)


def test_unwatched_old_video_and_no_brand_posts_are_rejected():
    config = browser.default_config()
    valid = {"handle": "kritisanon", "shortcode": "abc", "published_at": NOW.isoformat(), "caption": "Wearing @gucci", "media_type": "IMAGE", "date_evidence": "post_permalink_time"}
    assert browser.eligible_post(browser.BrowserPost(**valid), config, "Asia/Kolkata", NOW)[0].name == "Kriti Sanon"
    for changes in [{"handle": "unknown_account"}, {"published_at": "2026-10-10T01:00:00Z"}, {"caption": "@stylist"}, {"media_type": "VIDEO"}, {"published_at": "2026-10-13"}]:
        with pytest.raises(ValueError):
            browser.eligible_post(browser.BrowserPost(**{**valid, **changes}), config, "Asia/Kolkata", NOW)
    config.enabled = False
    with pytest.raises(ValueError, match="paused"):
        browser.eligible_post(browser.BrowserPost(**valid), config, "Asia/Kolkata", NOW)


def test_browser_import_auth_duplicate_date_brand_and_image_validation(monkeypatch, tmp_path):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    def database():
        with Session(engine) as db:
            yield db
    main.app.dependency_overrides[get_db] = database
    monkeypatch.setattr(browser, "get_settings", lambda: SimpleNamespace(reddit_daily_timezone="Asia/Kolkata", media_dir=str(tmp_path), output_dir=str(tmp_path / "outputs")))
    metadata = {"handle": "kritisanon", "shortcode": "abc", "published_at": datetime.now(timezone.utc).isoformat(), "caption": "Wearing @gucci", "media_type": "IMAGE", "date_evidence": "post_permalink_time"}
    photo = io.BytesIO()
    Image.new("RGB", (400, 600)).save(photo, "PNG")
    client = TestClient(main.app)
    headers = {"X-Editor-Key": main.settings.editor_api_key}
    try:
        assert client.get("/api/instagram-browser/config").status_code == 401
        assert client.get("/api/instagram-browser/config", headers=headers).json()["celebrities"]
        def submit(values, image=photo.getvalue()):
            return client.post("/api/instagram-browser/posts", headers=headers, data={"metadata": json.dumps(values)}, files={"image": ("photo.png", image, "image/png")})
        assert submit({**metadata, "caption": "@photographer"}).status_code == 422
        assert submit({**metadata, "published_at": "2020-01-01T00:00:00Z"}).status_code == 422
        assert submit(metadata, b"not an image").status_code == 422
        result = submit(metadata)
        assert result.status_code == 200
        assert result.json()["duplicate"] is False
        assert submit(metadata).json()["duplicate"] is True
        with Session(engine) as db:
            cases = db.scalars(select(Case)).all()
            assert len(cases) == 1
            assert cases[0].extraction["published_at"]
            assert cases[0].extraction["brand_mentions"][0]["name"] == "Gucci"
            assert cases[0].status == "context_review"
            assert cases[0].extraction["automatic_collage"]["panels"] == 1
            assert list(Path(tmp_path / "outputs").rglob("*.png"))
        feed = client.get("/api/instagram-browser/posts", headers=headers).json()["results"]
        assert len(feed) == 1
        assert feed[0]["brands"] == ["Gucci"]
        assert feed[0]["published_at"]
        with Session(engine) as db:
            case = db.scalar(select(Case))
            case.extraction = {**case.extraction, "published_at": "2020-01-01T00:00:00Z"}
            db.commit()
        assert client.get("/api/instagram-browser/posts", headers=headers).json()["results"] == []
    finally:
        main.app.dependency_overrides.pop(get_db, None)
        engine.dispose()


@pytest.fixture
def browser_client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    def database():
        with Session(engine) as db:
            yield db
    main.app.dependency_overrides[get_db] = database
    try:
        yield TestClient(main.app), {"X-Editor-Key": main.settings.editor_api_key}, engine
    finally:
        main.app.dependency_overrides.pop(get_db, None)
        engine.dispose()


@pytest.mark.parametrize("legacy", [False, True])
def test_carousel_import_expands_existing_draft_without_duplicate_or_lost_edits(browser_client, monkeypatch, tmp_path, legacy):
    client, headers, engine = browser_client
    monkeypatch.setattr(browser, "get_settings", lambda: SimpleNamespace(reddit_daily_timezone="Asia/Kolkata", media_dir=str(tmp_path), output_dir=str(tmp_path / "outputs")))
    metadata = {"handle": "ananyapanday", "shortcode": "carousel", "published_at": datetime.now(timezone.utc).isoformat(), "caption": "Wearing @chanelofficial", "media_type": "IMAGE", "date_evidence": "post_permalink_time"}
    photos = []
    for color in ["red", "blue", "green"]:
        buffer = io.BytesIO()
        Image.new("RGB", (400, 600), color).save(buffer, "PNG")
        photos.append(buffer.getvalue())
    def submit(values, files):
        return client.post("/api/instagram-browser/posts", headers=headers, data={"metadata": json.dumps(values)}, files=[("image" if index == 0 else "images", (f"photo{index}.png", content, "image/png")) for index, content in enumerate(files)])
    if legacy:
        assert submit(metadata, photos[:1]).status_code == 200
        with Session(engine) as db:
            case = db.scalar(select(Case))
            case.extraction = {**case.extraction, "collage_edit": {"panel_ids": ["current-primary"], "panel_options": {}, "revision": 3, "collage_adjustments": {"brightness": 0.8}}}
            db.commit()
    values = {**metadata, "image_keys": ["a" * 64, "b" * 64, "c" * 64], "carousel_complete": True}
    result = submit(values, photos)
    assert result.status_code == 200, result.text
    assert result.json()["photo_count"] == 3
    assert result.json()["updated"] is legacy
    assert result.json()["carousel_complete"] is True
    with Session(engine) as db:
        cases = db.scalars(select(Case)).all()
        assert len(cases) == 1
        case = cases[0]
        assert len(case.extraction["collage_assets"]) == 2
        assert case.extraction["automatic_collage"]["panels"] == 3
        if legacy:
            assert case.extraction["collage_edit"]["collage_adjustments"]["brightness"] == 0.8
            assert case.extraction["collage_edit"]["revision"] == 4
        count = len(db.scalars(select(Collage)).all())
    manifests = [json.loads(path.read_text()) for path in (tmp_path / "outputs").rglob("manifest.json")]
    assert any(manifest["panel_count"] == 3 and manifest["spacing_px"] == 0 and manifest["border_px"] == 0 for manifest in manifests)
    stored = set((tmp_path / "editor").glob("*.webp"))
    assert submit(values, photos).json()["duplicate"] is True
    assert submit({**values, "image_keys": values["image_keys"][:1], "carousel_complete": False}, photos[:1]).json()["photo_count"] == 3
    assert set((tmp_path / "editor").glob("*.webp")) == stored
    with Session(engine) as db:
        assert len(db.scalars(select(Collage)).all()) == count
    feed = client.get("/api/instagram-browser/posts", headers=headers).json()["results"][0]
    assert feed["photo_count"] == 3
    assert feed["collage_image"].startswith("/outputs/")
    assert feed["carousel_complete"] is True


def test_carousel_invalid_upload_rolls_back_all_photos(browser_client, monkeypatch, tmp_path):
    client, headers, engine = browser_client
    monkeypatch.setattr(browser, "get_settings", lambda: SimpleNamespace(reddit_daily_timezone="Asia/Kolkata", media_dir=str(tmp_path), output_dir=str(tmp_path / "outputs")))
    photo = io.BytesIO()
    Image.new("RGB", (400, 600)).save(photo, "PNG")
    metadata = {"handle": "ananyapanday", "shortcode": "invalid", "published_at": datetime.now(timezone.utc).isoformat(), "caption": "@gucci", "media_type": "IMAGE", "date_evidence": "post_permalink_time", "image_keys": ["a" * 64, "b" * 64]}
    response = client.post("/api/instagram-browser/posts", headers=headers, data={"metadata": json.dumps(metadata)}, files=[("image", ("one.png", photo.getvalue(), "image/png")), ("images", ("two.png", b"broken", "image/png"))])
    assert response.status_code == 422
    assert not list((tmp_path / "editor").glob("*.webp"))
    with Session(engine) as db:
        assert not db.scalars(select(Case)).all()


def test_scan_queue_auth_offline_idempotence_and_exclusive_claim(browser_client):
    client, headers, _ = browser_client
    root = "/api/instagram-browser"
    assert client.post(root + "/scan").status_code == 401
    assert client.post(root + "/claim").status_code == 401
    assert client.get(root + "/posts").status_code == 401
    assert client.post(root + "/scan", headers=headers).status_code == 503
    assert client.post(root + "/claim", headers=headers).json() == {"run": None}
    assert client.get(root + "/status", headers=headers).json()["runner_online"]
    queued = client.post(root + "/scan", headers=headers)
    assert queued.status_code == 202
    assert queued.json()["status"] == "queued"
    assert client.post(root + "/scan", headers=headers).json()["run_id"] == queued.json()["run_id"]
    report = {"run_id": "other", "status": "running"}
    assert client.post(root + "/runs", headers=headers, json=report).status_code == 409
    claimed = client.post(root + "/claim", headers=headers).json()["run"]
    assert claimed["run_id"] == queued.json()["run_id"]
    assert claimed["status"] == "running"
    assert client.post(root + "/claim", headers=headers).json() == {"run": None}
    report.update(run_id=claimed["run_id"], status="completed", accounts_total=16, accounts_checked=16)
    assert client.post(root + "/runs", headers=headers, json=report).status_code == 200
    assert client.get(root + "/status", headers=headers).json()["status"] == "completed"


def test_scan_queue_expiry_and_paused_intake(browser_client, monkeypatch):
    client, headers, _ = browser_client
    root = "/api/instagram-browser"
    moment = [1000]
    monkeypatch.setattr(browser.time, "time", lambda: moment[0])
    client.post(root + "/claim", headers=headers)
    queued = client.post(root + "/scan", headers=headers).json()
    moment[0] += 181
    assert client.get(root + "/status", headers=headers).json()["status"] == "interrupted"
    assert client.post(root + "/claim", headers=headers).json() == {"run": None}
    assert client.post(root + "/scan", headers=headers).json()["run_id"] != queued["run_id"]
    config = browser.default_config().model_dump()
    config["enabled"] = False
    client.post(root + "/config", headers=headers, json=config)
    assert client.post(root + "/claim", headers=headers).json() == {"run": None}
    assert client.get(root + "/status", headers=headers).json()["status"] == "paused"
    assert client.post(root + "/scan", headers=headers).status_code == 409
    config.update(enabled=True, celebrities=[])
    client.post(root + "/config", headers=headers, json=config)
    assert client.post(root + "/scan", headers=headers).status_code == 409
