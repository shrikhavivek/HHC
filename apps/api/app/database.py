from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import NullPool
from .config import get_settings


class Base(DeclarativeBase):
    pass


def database_url(url: str) -> str:
    """Supabase hands out postgres:// URLs; SQLAlchemy needs the psycopg driver named."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url.removeprefix(prefix)
    return url


def _engine():
    settings = get_settings()
    url = database_url(settings.database_url)
    if settings.database_null_pool:
        # Each serverless request opens one connection through the pooler.
        connect_args = {"prepare_threshold": None} if url.startswith("postgresql") else {}
        return create_engine(url, poolclass=NullPool, connect_args=connect_args)
    return create_engine(url, pool_pre_ping=True)


engine = _engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
