from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "sqlite:///./outfit-research.db"
    editor_api_key: str = "local-editor-key"
    cors_origins: str = "http://localhost:3000"
    output_dir: str = "./outputs"
    media_dir: str = "./media"
    public_api_url: str = "http://localhost:8000"
    auto_approve: bool = False
    wordpress_publisher_enabled: bool = False
    reddit_source_mode: str = "manual"
    reddit_subreddit: str = "BollywoodFashion"
    reddit_user_agent: str = "hhc-daily-drafts/2.0 (contact: admin@highheelconfidential.com)"
    source_import_user_agent: str = "Mozilla/5.0 (compatible; HHCEditorialImporter/1.0; +https://www.highheelconfidential.com)"
    public_import_allowed_domains: str = "instagram.com,threads.net,facebook.com,fb.watch,x.com,twitter.com,t.co,pinterest.com,pin.it,tiktok.com,youtube.com,youtu.be,reddit.com"
    serpapi_key: str = ""
    designer_reference_search_enabled: bool = True
    daily_automation_enabled: bool = False
    daily_automation_limit: int = 6
    daily_remote_search_budget: int = 2
    daily_designer_search_budget: int = 2
    daily_automation_hour_utc: int = 3
    daily_automation_minute_utc: int = 30
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if settings.auto_approve:
        raise RuntimeError("AUTO_APPROVE must remain false in V1")
    if settings.wordpress_publisher_enabled:
        raise RuntimeError("WordPress publishing is disabled in V1")
    return settings
