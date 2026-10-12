from datetime import datetime, timezone
from types import SimpleNamespace
from app.edition_window import in_current_edition
from app.fashion_category import case_fashion_category

NOW = datetime(2026, 10, 12, 1, tzinfo=timezone.utc)

def case(day, **kwargs):
    return SimpleNamespace(source_type="reddit_rss", event_date=day, created_at=NOW, extraction={}, **kwargs)

def test_old_posts_do_not_become_recent_when_reimported():
    assert not in_current_edition(case("2026-10-05"), now=NOW)
    assert in_current_edition(case("2026-10-11"), now=NOW)
    assert in_current_edition(case("2026-10-12"), now=NOW)
    assert not in_current_edition(case("2026-10-13"), now=NOW)

def test_midnight_boundary_uses_indian_calendar_day():
    row = case(None)
    row.extraction = {"published_at": "2026-10-10T18:30:00Z"}
    assert in_current_edition(row, now=NOW)
    row.extraction = {"published_at": "2026-10-10T18:29:59Z"}
    assert not in_current_edition(row, now=NOW)

def test_unclassified_legacy_male_post_is_reclassified():
    row = case(None, celebrity="Abhay Verma", source_title="Abhay Verma in Dior", source_body="")
    row.extraction = {"fashion_category": "unclassified"}
    assert case_fashion_category(row) == "men"
