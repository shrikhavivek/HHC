from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "development"
    database_url: str = "sqlite:///./outfit-research.db"
    editor_api_key: str = "local-editor-key"
    cors_origins: str = "http://localhost:3000"
    output_dir: str = "./outputs"
    media_dir: str = "./media"
    # Demo images are generated here; serverless hosts need a writable folder.
    static_dir: str = ""
    # "local" keeps files on disk; "supabase" syncs MEDIA_DIR/OUTPUT_DIR with a bucket.
    storage_backend: str = "local"
    supabase_url: str = ""
    supabase_service_key: str = ""
    supabase_bucket: str = "hhc"
    storage_signed_url_seconds: int = 3600
    # Serverless: no connection pool, and no prepared statements for the
    # Supabase transaction pooler (port 6543).
    database_null_pool: bool = False
    # False when a separate migrate step (python -m app.migrate) creates tables.
    run_startup_tasks: bool = True
    # Worker runs on a schedule (GitHub Actions) instead of always on.
    worker_heartbeat_window_seconds: int = 120
    github_dispatch_repo: str = ""
    github_dispatch_token: str = ""
    github_dispatch_workflow: str = "worker.yml"
    github_dispatch_ref: str = "master"
    public_api_url: str = "http://localhost:8000"
    auto_approve: bool = False
    wordpress_publisher_enabled: bool = False
    reddit_source_mode: str = "manual"
    reddit_subreddit: str = "BollywoodFashion"
    reddit_user_agent: str = "hhc-daily-drafts/2.0 (contact: admin@highheelconfidential.com)"
    reddit_client_id: str = ""
    reddit_client_secret: str = ""
    reddit_daily_timezone: str = "Asia/Kolkata"
    reddit_listing_page_size: int = 100
    reddit_listing_max_pages: int = 50
    reddit_match_search_limit: int = 100
    source_import_user_agent: str = "Mozilla/5.0 (compatible; HHCEditorialImporter/1.0; +https://www.highheelconfidential.com)"
    public_import_allowed_domains: str = "instagram.com,threads.net,facebook.com,fb.watch,x.com,twitter.com,t.co,pinterest.com,pin.it,tiktok.com,youtube.com,youtu.be,reddit.com"
    serpapi_key: str = ""
    web_discovery_feeds: str = "https://www.highheelconfidential.com/feed/,https://www.bollywoodhungama.com/bollywood/fashion/feed/"
    designer_reference_search_enabled: bool = True
    daily_automation_enabled: bool = False
    daily_gallery_retry_budget: int = 8
    daily_remote_search_budget: int = 8
    reddit_oauth_daily_search_budget: int = 80
    daily_designer_search_budget: int = 8
    daily_automation_hour_utc: int = 3
    daily_automation_minute_utc: int = 30
    # Hourly pulls collect sources only; collages render when an editor opens a case.
    collage_render_on_pull: bool = False
    # Closed editions keep text, fingerprints and verified-look references.
    # Image deletion stays off until the archive backfill has been checked.
    archive_purge_enabled: bool = False
    archive_purge_grace_days: int = 7
    # Audit events and job runs older than this are deleted; 0 keeps them forever.
    history_retention_days: int = 0
    scheduler_in_api: bool = True
    instagram_access_token: str = ""
    instagram_account_id: str = ""
    instagram_watch_accounts: str = ""
    meta_graph_version: str = "v23.0"
    wordpress_site_url: str = "https://www.highheelconfidential.com"
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if settings.auto_approve:
        raise RuntimeError("AUTO_APPROVE must remain false in V1")
    if settings.app_env == "production":
        if len(settings.editor_api_key) < 32 or settings.editor_api_key.startswith(("local-", "replace-")):
            raise RuntimeError("Production requires a random EDITOR_API_KEY of at least 32 characters")
        if settings.reddit_source_mode != "manual" and not settings.reddit_client_id:
            raise RuntimeError("Production Reddit intake requires approved OAuth credentials")
        if settings.database_url.startswith("sqlite"):
            raise RuntimeError("Production requires PostgreSQL")
        if "change-me" in settings.database_url:
            raise RuntimeError("Replace the demonstration database password before production")
    if not 0 <= settings.daily_automation_hour_utc <= 23 or not 0 <= settings.daily_automation_minute_utc <= 59:
        raise RuntimeError("Daily automation time must be a valid UTC hour and minute")
    if settings.archive_purge_grace_days < 0:
        raise RuntimeError("ARCHIVE_PURGE_GRACE_DAYS cannot be negative")
    if settings.history_retention_days < 0:
        raise RuntimeError("HISTORY_RETENTION_DAYS cannot be negative")
    if settings.storage_backend not in {"local", "supabase"}:
        raise RuntimeError("STORAGE_BACKEND must be local or supabase")
    if settings.storage_backend == "supabase" and not (settings.supabase_url and settings.supabase_service_key):
        raise RuntimeError("Supabase storage requires SUPABASE_URL and SUPABASE_SERVICE_KEY")
    if bool(settings.reddit_client_id.strip()) != bool(settings.reddit_client_secret.strip()):
        raise RuntimeError("REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET must be configured together")
    return settings
