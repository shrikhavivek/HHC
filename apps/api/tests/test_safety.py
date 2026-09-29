from app.config import Settings


def test_safe_defaults():
    settings = Settings()
    assert settings.auto_approve is False
    assert settings.wordpress_publisher_enabled is False
    assert settings.reddit_source_mode in {"manual", "rss"}
