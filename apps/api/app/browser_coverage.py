from pydantic import BaseModel, Field


class CoverageTarget(BaseModel):
    target: str = Field(max_length=180)
    status: str = Field(pattern=r"^(not_started|scanning|complete|partial)$")
    stop_reason: str = Field(default="", max_length=100)
    discovered: int = Field(default=0, ge=0, le=1000000)
    checked: int = Field(default=0, ge=0, le=1000000)
    recent: int = Field(default=0, ge=0, le=1000000)
    qualifying: int = Field(default=0, ge=0, le=1000000)
    collected: int = Field(default=0, ge=0, le=1000000)
    existing: int = Field(default=0, ge=0, le=1000000)
    failures: int = Field(default=0, ge=0, le=1000000)
    oldest_published_at: str | None = Field(default=None, max_length=50)


class CoverageReport(BaseModel):
    window_start: str = Field(max_length=10)
    window_end: str = Field(max_length=10)
    as_of: str = Field(max_length=50)
    timezone: str = Field(default="Asia/Kolkata", max_length=80)
    targets: list[CoverageTarget] = Field(default_factory=list, max_length=200)
