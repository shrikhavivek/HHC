from typing import Literal
from pydantic import BaseModel, Field, HttpUrl, field_validator


DecisionType = Literal["approved", "rejected", "similar_not_same", "needs_more_research"]


class ManualIntake(BaseModel):
    reddit_url: HttpUrl
    title: str = Field(min_length=4, max_length=500)
    body: str = Field(default="", max_length=5000)
    celebrity: str = Field(default="Unresolved", max_length=180)
    designer: str = Field(default="Unresolved", max_length=180)
    event_name: str = Field(default="Unresolved", max_length=240)

    @field_validator("reddit_url")
    @classmethod
    def reddit_only(cls, value: HttpUrl):
        if value.host not in {"reddit.com", "www.reddit.com", "old.reddit.com"}:
            raise ValueError("Manual intake accepts Reddit permalinks only")
        return value


class DecisionInput(BaseModel):
    decision: DecisionType
    reason: str = Field(min_length=12, max_length=2000)
    editor_id: str = Field(min_length=2, max_length=120)


class CollageInput(BaseModel):
    candidate_id: str


class PanelLayoutOption(BaseModel):
    width_scale: float = Field(default=1.0, ge=0.65, le=1.75)
    crop_mode: Literal["fit", "crop"] = "fit"
    focal_x: float = Field(default=0.5, ge=0, le=1)
    focal_y: float = Field(default=0.5, ge=0, le=1)
    zoom: float = Field(default=1.0, ge=1, le=2.5)


class CollageEditInput(BaseModel):
    panel_ids: list[str] = Field(min_length=1, max_length=24)
    panel_options: dict[str, PanelLayoutOption] = Field(default_factory=dict)
    editor_id: str = Field(default="editor@atelier", min_length=2, max_length=120)

    @field_validator("panel_ids")
    @classmethod
    def valid_panel_ids(cls, value: list[str]):
        normalized = [item.strip() for item in value]
        if any(not item or len(item) > 120 for item in normalized):
            raise ValueError("Every panel id must be between 1 and 120 characters")
        if len(set(normalized)) != len(normalized):
            raise ValueError("A collage panel may be selected only once")
        return normalized


class FashionCategoryInput(BaseModel):
    category: Literal["women", "men", "mixed", "unclassified"]
    editor_id: str = Field(default="editor@atelier", min_length=2, max_length=120)
