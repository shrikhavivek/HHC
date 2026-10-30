from datetime import datetime, timedelta, timezone
import io
from pathlib import Path
from types import SimpleNamespace
import pytest
from PIL import Image
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app import automation, main
from app.archive import keep_verified_look, purge_closed_editions, trim_history
from app.database import Base, get_db
from app.models import ArchiveEntry, AuditEvent, Candidate, Case, Collage, JobRun, StoryDraft
from app.public_sources import SOURCE_MAX_EDGE, compact_source_image

NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)
TITLE = "Deepika Padukone in Sabyasachi red embroidered lehenga with velvet cape"


@pytest.fixture()
def archive(tmp_path, monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    media = tmp_path / "media"
    (media / "reddit").mkdir(parents=True)
    monkeypatch.setattr(main.settings, "output_dir", str(tmp_path / "outputs"))
    monkeypatch.setattr(main.settings, "media_dir", str(media))
    settings = SimpleNamespace(media_dir=str(media), output_dir=str(tmp_path / "outputs"), reddit_daily_timezone="Asia/Kolkata",
        archive_purge_enabled=False, archive_purge_grace_days=7)
    yield factory, settings, media, tmp_path
    main.app.dependency_overrides.clear()
    engine.dispose()


def photo(media: Path, name: str, color: str) -> str:
    Image.new("RGB", (480, 720), color).save(media / "reddit" / name)
    return f"/media-files/reddit/{name}"


def reddit_case(case_id: str, day: str, image: str, **values) -> Case:
    return Case(id=case_id, source_type="reddit_rss", permalink=f"https://www.reddit.com/r/BollywoodFashion/comments/{case_id}/", source_title=TITLE,
        celebrity="Deepika Padukone", designer="Sabyasachi", event_name=f"Event {case_id}", event_date=day, base_image=image, demo_data=False, **values)


def test_pending_collage_renders_once_on_first_open(archive):
    factory, _, media, tmp_path = archive
    image = photo(media, "today.png", "#806040")
    with factory() as db:
        db.add(reddit_case("today", "2026-10-22", image, extraction={"automatic_collage": {"id": None, "panels": 1, "pending": True}}))
        db.commit()
    def db_override():
        with factory() as db:
            yield db
    main.app.dependency_overrides[get_db] = db_override
    client = TestClient(main.app)
    headers = {"X-Editor-Key": main.settings.editor_api_key, "X-Editor-Id": "editor"}
    first = client.get("/api/cases/today", headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["latest_collage"]
    assert client.get("/api/cases/today", headers=headers).json()["latest_collage"]["id"] == first.json()["latest_collage"]["id"]
    with factory() as db:
        assert len(db.scalars(select(Collage)).all()) == 1
        case = db.get(Case, "today")
        assert "pending" not in case.extraction["automatic_collage"]
        assert db.scalar(select(AuditEvent).where(AuditEvent.action == "automatic_draft_rendered_on_open"))
    for path in (tmp_path / "outputs").rglob("collage.webp"):
        path.unlink()
    purged = client.get("/api/cases/today", headers=headers).json()
    assert purged["latest_collage"] is None and purged["assets_purged"] is True


def test_closed_edition_is_archived_then_purged_without_touching_desk_or_held_work(archive):
    factory, settings, media, tmp_path = archive
    shared = photo(media, "shared.png", "#804060")
    held_image = photo(media, "held.png", "#406080")
    approved_image = photo(media, "approved.png", "#608040")
    own = photo(media, "own.png", "#202020")
    case_output = tmp_path / "outputs" / "case-old"
    case_output.mkdir(parents=True)
    (case_output / "collage.webp").write_bytes(b"render")
    with factory() as db:
        db.add_all([
            reddit_case("old", "2026-10-10", shared, extraction={"collage_assets": [{"image_path": own, "role": "current_angle"}]}),
            reddit_case("approved", "2026-10-11", approved_image, status="approved"),
            reddit_case("held", "2026-10-12", held_image, extraction={"collage_edit": {"revision": 1}}),
            reddit_case("desk", "2026-10-22", photo(media, "desk.png", "#a0a0a0")),
        ])
        db.flush()
        # Today's desk case shows the old case's photo as an archive match.
        db.add(Candidate(case_id="desk", person="Deepika Padukone", designer="Sabyasachi", event_name="Earlier", image_path=shared, proposed_match_type="same_outfit_same_person"))
        db.add(StoryDraft(case_id="held", title="Work in progress", updated_at=NOW - timedelta(days=1)))
        db.commit()
        db.get(Case, "held").updated_at = NOW - timedelta(days=1)
        db.commit()

        dry = purge_closed_editions(db, settings, now=NOW)
        assert dry == {"archived": 2, "references": 1, "purged": 0, "files": 0, "held": 2, "enabled": False}
        entry = db.get(ArchiveEntry, "old")
        assert entry.fingerprint and "lehenga" in entry.signature["garments"] and "embroidered" in entry.keywords
        assert db.get(ArchiveEntry, "approved").reference_image == "/media-files/reference/approved.webp"
        assert (media / "reddit" / "own.png").is_file()

        settings.archive_purge_enabled = True
        result = purge_closed_editions(db, settings, now=NOW)
        assert result["purged"] == 2 and result["references"] == 0
        assert not (media / "reddit" / "own.png").exists()
        assert not (media / "reddit" / "approved.png").exists()
        assert (media / "reddit" / "shared.png").is_file()
        assert (media / "reddit" / "held.png").is_file()
        assert (media / "reference" / "approved.webp").is_file()
        assert not case_output.exists()
        assert db.get(ArchiveEntry, "old").purged_at
        assert db.get(Case, "old") is not None
        assert purge_closed_editions(db, settings, now=NOW)["purged"] == 0


def test_matcher_uses_fingerprint_and_reference_for_purged_archive_case(archive, monkeypatch):
    factory, _, media, _ = archive
    monkeypatch.setattr(automation, "_expand_reddit_post_media", lambda *args: pytest.fail("reference image should be used before re-fetching"))
    prior_image = photo(media, "prior.png", "#904030")
    current_image = photo(media, "current.png", "#904030")
    with factory() as db:
        prior = reddit_case("prior", "2026-09-01", prior_image, status="approved")
        current = reddit_case("current", "2026-10-22", current_image)
        db.add_all([prior, current])
        db.commit()
        keep_verified_look(db, prior, str(media))
        db.commit()
        entry = db.get(ArchiveEntry, "prior")
        entry.fingerprint = automation.image_fingerprint(prior_image, str(media))
        entry.purged_at = NOW
        db.commit()
        (media / "reddit" / "prior.png").unlink()

        candidates = automation._add_matches(db, current, str(media))
        assert len(candidates) == 1
        assert candidates[0].image_path == "/media-files/reference/prior.webp"
        assert candidates[0].checks["automation"]["archive_image"] == "reference"
        assert candidates[0].checks["automation"]["visual"] > 0.9


def test_purged_archive_case_without_any_image_is_not_offered(archive, monkeypatch):
    factory, _, media, _ = archive
    monkeypatch.setattr(automation, "_expand_reddit_post_media", lambda *args: [])
    with factory() as db:
        db.add_all([reddit_case("gone", "2026-09-01", "/media-files/reddit/gone.png"), reddit_case("current", "2026-10-22", photo(media, "now.png", "#904030"))])
        db.add(ArchiveEntry(case_id="gone", permalink="https://www.reddit.com/r/BollywoodFashion/comments/gone/", fingerprint={"histogram": [1.0] * 24, "dhash": 0}))
        db.commit()
        assert automation._add_matches(db, db.get(Case, "current"), str(media)) == []


def test_automatic_draft_defers_unless_render_on_pull(archive):
    factory, settings, media, _ = archive
    with factory() as db:
        case = reddit_case("pull", "2026-10-22", photo(media, "pull.png", "#706050"), extraction={})
        db.add(case)
        db.flush()
        collage, panels = automation._automatic_draft(db, case, [], settings, str(Path(automation.__file__).parent / "static"))
        assert collage is None and panels == 1
        assert case.extraction["automatic_collage"] == {"id": None, "panels": 1, "pending": True}
        assert db.scalars(select(Collage)).all() == []


def test_downloaded_sources_are_stored_as_bounded_webp():
    original = io.BytesIO()
    Image.new("RGB", (4000, 6000), "#806040").save(original, "PNG")
    compact = compact_source_image(original.getvalue())
    with Image.open(io.BytesIO(compact)) as image:
        assert image.format == "WEBP" and max(image.size) == SOURCE_MAX_EDGE and image.size[0] < image.size[1]
    assert len(compact) < len(original.getvalue())


def test_history_trim_keeps_lasting_events_and_unfinished_runs(archive):
    factory, settings, _, _ = archive
    old = NOW - timedelta(days=120)
    with factory() as db:
        db.add_all([
            AuditEvent(entity_type="case", entity_id="x", action="collage_layout_edited", actor="editor", detail={}, created_at=old),
            AuditEvent(entity_type="case", entity_id="x", action="wordpress_draft_sent", actor="editor", detail={}, created_at=old),
            AuditEvent(entity_type="case", entity_id="x", action="collage_layout_edited", actor="editor", detail={}, created_at=NOW),
            JobRun(job_type="edition_refresh", idempotency_key="old-done", status="completed", created_at=old),
            JobRun(job_type="edition_refresh", idempotency_key="old-queued", status="queued", created_at=old),
        ])
        db.commit()
        settings.history_retention_days = 0
        assert trim_history(db, settings, now=NOW) == {"audit_events": 0, "job_runs": 0}
        settings.history_retention_days = 90
        assert trim_history(db, settings, now=NOW) == {"audit_events": 1, "job_runs": 1}
        assert {event.action for event in db.scalars(select(AuditEvent)).all()} == {"wordpress_draft_sent", "collage_layout_edited"}
        assert [run.idempotency_key for run in db.scalars(select(JobRun)).all()] == ["old-queued"]
