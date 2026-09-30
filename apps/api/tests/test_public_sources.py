from types import SimpleNamespace

import pytest
from PIL import Image
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app import automation, public_sources
from app.assets import build_panel_catalog
from app.models import AuditEvent, Base, Case
from app.schemas import WatermarkLayout


def test_public_metadata_collects_caption_author_and_structured_images():
    markup = r"""
    <html><head>
      <meta property="og:title" content="Actor One in Example Designer at a premiere">
      <meta property="og:description" content="A blue embroidered gown by Example Designer.">
      <meta property="og:site_name" content="Instagram">
      <meta name="author" content="style_account">
      <meta property="og:image" content="https://cdn.example.com/cover.jpg">
      <script type="application/ld+json">
        {"datePublished":"2026-09-29T14:30:00Z","image":["https://cdn.example.com/two.jpg",{"url":"https://cdn.example.com/three.jpg"}]}
      </script>
      <script>{"display_url":"https:\/\/cdn.example.com\/unrelated-script-image.jpg"}</script>
    </head></html>
    """

    result = public_sources.extract_public_metadata(markup, "https://posts.example.com/fashion/example/")

    assert result["title"] == "Actor One in Example Designer at a premiere"
    assert result["description"] == "A blue embroidered gown by Example Designer."
    assert result["author"] == "style_account"
    assert result["publisher"] == "Instagram"
    assert result["published"] == "2026-09-29T14:30:00Z"
    assert result["image_urls"] == [
        "https://cdn.example.com/cover.jpg",
        "https://cdn.example.com/two.jpg",
        "https://cdn.example.com/three.jpg",
    ]


def test_instagram_embed_keeps_only_post_media():
    markup = """
    <html><head>
      <meta property="og:title" content="A public fashion post">
      <meta property="og:image" content="https://cdn.example.com/open-graph-cover.jpg">
      <script>{"display_url":"https://cdn.example.com/recommended-post.jpg"}</script>
    </head><body>
      <img src="https://cdn.example.com/profile.jpg" alt="style_account">
      <img class="EmbeddedMediaImage" src="https://cdn.example.com/actual-post.jpg" alt="Instagram post shared by style_account">
      <img src="https://cdn.example.com/unrelated-preload.jpg">
    </body></html>
    """

    result = public_sources.extract_public_metadata(
        markup,
        "https://www.instagram.com/p/example/embed/captioned/",
    )

    assert result["image_urls"] == ["https://cdn.example.com/actual-post.jpg"]


def test_instagram_post_page_does_not_collect_script_recommendations():
    markup = """
    <html><head>
      <meta property="og:image" content="https://cdn.example.com/post-cover.jpg">
      <script type="application/ld+json">{"image":["https://cdn.example.com/recommendation.jpg"]}</script>
      <script>{"display_url":"https://cdn.example.com/another-recommendation.jpg"}</script>
    </head></html>
    """

    result = public_sources.extract_public_metadata(markup, "https://www.instagram.com/p/example/")

    assert result["image_urls"] == ["https://cdn.example.com/post-cover.jpg"]


def test_source_url_validation_blocks_private_networks(monkeypatch):
    monkeypatch.setattr(
        public_sources.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(public_sources.socket.AF_INET, public_sources.socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))],
    )

    with pytest.raises(public_sources.PublicSourceError, match="Private or local"):
        public_sources._validated_url(
            "https://www.instagram.com/p/example/",
            allowed_domains={"instagram.com"},
            source_document=True,
        )


def test_source_url_validation_uses_a_controlled_platform_allowlist(monkeypatch):
    monkeypatch.setattr(
        public_sources.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(public_sources.socket.AF_INET, public_sources.socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))],
    )
    assert public_sources._validated_url(
        "https://www.instagram.com/p/example/?utm_source=test#fragment",
        allowed_domains={"instagram.com"},
        source_document=True,
    ) == "https://www.instagram.com/p/example/?utm_source=test"
    with pytest.raises(public_sources.PublicSourceError, match="not enabled"):
        public_sources._validated_url(
            "https://unknown.example/post/1",
            allowed_domains={"instagram.com"},
            source_document=True,
        )


def test_editor_public_url_import_creates_a_researchable_case(monkeypatch, tmp_path):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    media_dir = tmp_path / "media"
    imported_dir = media_dir / "imports"
    imported_dir.mkdir(parents=True)
    Image.new("RGB", (900, 1200), "#7c1738").save(imported_dir / "one.jpg")
    Image.new("RGB", (900, 1200), "#264f80").save(imported_dir / "two.jpg")

    source = {
        "title": "Actor One in Example Designer at a premiere",
        "description": "Actor One wears a blue embroidered gown by Example Designer.",
        "author": "style_account",
        "publisher": "Instagram (@style_account)",
        "published": "2026-09-29T14:30:00Z",
        "image_urls": ["https://cdn.example.com/one.jpg", "https://cdn.example.com/two.jpg"],
        "platform": "Instagram",
        "permalink": "https://www.instagram.com/p/example/",
        "post_id": "public-post-1",
    }
    monkeypatch.setattr(automation, "inspect_public_post", lambda *_args, **_kwargs: source)
    monkeypatch.setattr(
        automation,
        "download_public_images",
        lambda *_args, **_kwargs: (
            source["image_urls"],
            ["/media-files/imports/one.jpg", "/media-files/imports/two.jpg"],
            [],
        ),
    )

    def fake_research(_db, case, _settings, _static_dir):
        case.extraction = {**case.extraction, "automatic_collage": {"id": "draft-1", "panels": 2}}
        return {"matches": 0}

    monkeypatch.setattr(automation, "_research_existing_case", fake_research)
    settings = SimpleNamespace(
        source_import_user_agent="test-agent",
        public_import_allowed_domains="instagram.com",
        media_dir=str(media_dir),
    )
    payload = {
        "source_url": source["permalink"],
        "title_hint": "",
        "description_hint": "",
        "celebrity": "",
        "designer": "",
        "event_name": "",
        "editor_id": "editor@test",
    }

    with Session(engine) as db:
        result = automation.import_public_post_automation(db, payload, settings, str(tmp_path / "static"))
        case = db.scalar(select(Case).where(Case.id == result["case_id"]))
        audit = db.scalar(select(AuditEvent).where(AuditEvent.entity_id == case.id, AuditEvent.action == "public_source_imported"))

        assert case.source_type == "public_post_url"
        assert case.celebrity == "Actor One"
        assert case.designer == "Example Designer"
        assert case.event_name == "a premiere"
        assert case.event_date == "2026-09-29"
        assert case.extraction["source_platform"] == "Instagram"
        assert len(case.extraction["collage_assets"]) == 1
        assert result["source_image_count"] == 2
        assert result["asset_count"] == 2
        assert audit.detail["public_url_only"] is True
        assert build_panel_catalog(case, [])[0]["publisher"] == "Instagram (@style_account)"


def test_watermark_can_scale_to_full_collage_width_and_height_with_filters():
    layout = WatermarkLayout(
        width=1,
        height=1,
        adjustments={"brightness": 2, "contrast": 0.25, "saturation": 0, "grayscale": 1},
    )
    assert layout.width == 1
    assert layout.height == 1
    assert layout.adjustments.brightness == 2
    with pytest.raises(ValidationError):
        WatermarkLayout(width=1.01)
    with pytest.raises(ValidationError):
        WatermarkLayout(height=1.01)
