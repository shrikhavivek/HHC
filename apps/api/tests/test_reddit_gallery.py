from datetime import datetime, timezone
from types import SimpleNamespace
import io
import json
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app import main, reddit_gallery
from app.database import Base, get_db
from app.models import Case, Collage, StoryDraft


@pytest.fixture
def gallery(tmp_path, monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    media = tmp_path / "media"
    media.mkdir()
    for name, color in [("one", "red"), ("two", "blue")]:
        Image.new("RGB", (480, 640), color).save(media / f"{name}.jpg")
    settings = SimpleNamespace(media_dir=str(media), output_dir=str(tmp_path / "outputs"), reddit_daily_timezone="Asia/Kolkata", reddit_user_agent="test")
    monkeypatch.setattr(reddit_gallery, "get_settings", lambda: settings)
    monkeypatch.setattr(reddit_gallery, "_download_source_images", lambda urls, *args: (urls, [f"/media-files/{url.rsplit('/',1)[-1]}" for url in urls]))
    def database():
        with factory() as db:
            yield db
    main.app.dependency_overrides[get_db] = database
    with factory() as db:
        db.add(Case(id="gallery", source_type="reddit_rss", permalink="https://www.reddit.com/r/BollywoodFashion/comments/abc/post/", source_title="Test Actor in red", celebrity="Test Actor", base_image="/media-files/one.jpg", extraction={"published_at": datetime.now(timezone.utc).isoformat(), "source_image_urls": ["https://i.redd.it/one.jpg"], "gallery_expanded": False, "collage_edit": {"revision": 2, "panel_ids": ["current-primary"], "panel_options": {"current-primary": {"zoom": 1.2, "focal_x": .4, "focal_y": .5}}}}))
        db.commit()
    client = TestClient(main.app)
    headers = {"X-Editor-Key": main.settings.editor_api_key}
    payload = {"post_id": "abc", "expected_revision": 2, "images": ["https://i.redd.it/one.jpg", "https://i.redd.it/two.jpg"]}
    yield client, headers, payload, factory
    main.app.dependency_overrides.clear()
    engine.dispose()


def test_recover_full_gallery_preserves_crop_and_appends_new_photos(gallery):
    client, headers, payload, factory = gallery
    assert client.get("/api/reddit-gallery/pending").status_code == 401
    assert len(client.get("/api/reddit-gallery/pending", headers=headers).json()) == 1
    result = client.post("/api/reddit-gallery/cases/gallery", headers=headers, json=payload)
    assert result.status_code == 200, result.text
    assert result.json()["panels"] == 2
    with factory() as db:
        case = db.get(Case, "gallery")
        edit = case.extraction["collage_edit"]
        assert edit["panel_ids"] == ["current-primary", "current-angle-2"]
        assert edit["panel_options"]["current-primary"]["zoom"] == 1.2
        assert edit["revision"] == 3
        assert Image.open(db.scalar(select(Collage)).image_path).width > 0
        assert case.extraction["gallery_expanded"]
    assert client.get("/api/reddit-gallery/pending", headers=headers).json() == []
    assert client.post("/api/reddit-gallery/cases/gallery", headers=headers, json=payload).status_code == 409


def test_incomplete_download_keeps_cover_and_saved_edits(gallery, monkeypatch):
    client, headers, payload, factory = gallery
    monkeypatch.setattr(reddit_gallery, "_download_source_images", lambda urls, *args: (urls[:1], ["/media-files/one.jpg"]))
    assert client.post("/api/reddit-gallery/cases/gallery", headers=headers, json=payload).status_code == 502
    with factory() as db:
        case = db.get(Case, "gallery")
        assert case.extraction["collage_edit"]["revision"] == 2
        assert case.extraction["gallery_expanded"] is False
        assert db.scalar(select(Collage)) is None


@pytest.mark.parametrize("changes", [{"post_id":"different"}, {"images":["https://localhost/private.jpg"]}, {"images":["https://i.redd.it/one.jpg", "https://i.redd.it/one.jpg"]}])
def test_wrong_post_and_unsafe_or_duplicate_images_are_rejected(gallery, changes):
    client, headers, payload, _ = gallery
    assert client.post("/api/reddit-gallery/cases/gallery", headers=headers, json={**payload, **changes}).status_code == 422


def test_wordpress_draft_cannot_be_replaced(gallery):
    client, headers, payload, factory = gallery
    with factory() as db:
        db.add(StoryDraft(case_id="gallery", wordpress_post_id=123, sync_state="draft_created"))
        db.commit()
    assert client.get("/api/reddit-gallery/pending", headers=headers).json() == []
    assert client.post("/api/reddit-gallery/cases/gallery", headers=headers, json=payload).status_code == 409


def screenshots():
    result = []
    for color in ("red", "blue"):
        buffer = io.BytesIO()
        Image.new("RGB", (480, 640), color).save(buffer, "JPEG")
        result.append(("images", (f"{color}.jpg", buffer.getvalue(), "image/jpeg")))
    return result


def test_browser_screenshots_create_all_panels_without_downloading(gallery, monkeypatch):
    client, headers, payload, factory = gallery
    def no_download(*args):
        raise AssertionError("Screenshot recovery must not request Reddit media")
    monkeypatch.setattr(reddit_gallery, "_download_source_images", no_download)
    response = client.post("/api/reddit-gallery/cases/gallery/screenshots", headers=headers, data={"metadata": json.dumps({**payload, "carousel_complete": True})}, files=screenshots())
    assert response.status_code == 200, response.text
    assert response.json()["panels"] == 2
    with factory() as db:
        case = db.get(Case, "gallery")
        assert case.extraction["image_capture"]["kind"] == "browser_screenshot"
        assert case.extraction["collage_edit"]["panel_options"]["current-primary"]["zoom"] == 1.2


def test_partial_screenshot_upload_is_rejected(gallery):
    client, headers, payload, factory = gallery
    for files, complete in [(screenshots()[:1], True), (screenshots(), False)]:
        response = client.post("/api/reddit-gallery/cases/gallery/screenshots", headers=headers, data={"metadata": json.dumps({**payload, "carousel_complete": complete})}, files=files)
        assert response.status_code == 422
    with factory() as db:
        assert db.get(Case, "gallery").extraction["gallery_expanded"] is False
        assert db.scalar(select(Collage)) is None
