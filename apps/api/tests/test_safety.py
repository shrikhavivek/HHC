import pytest
from pydantic import ValidationError

from app.config import Settings
from app.schemas import PanelLayoutOption


def test_safe_defaults():
    settings = Settings()
    assert settings.auto_approve is False
    assert settings.wordpress_publisher_enabled is False
    assert settings.reddit_source_mode in {"manual", "rss"}


def test_manual_crop_rectangle_must_stay_inside_source_image():
    with pytest.raises(ValidationError):
        PanelLayoutOption(
            crop_mode="crop",
            crop_rect={"x": 0.8, "y": 0.1, "width": 0.4, "height": 0.5},
        )
