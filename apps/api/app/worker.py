"""Durable daily refresh and manual-run queue. Run: python -m app.worker."""
import hashlib
import logging
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from fastapi import APIRouter, Depends
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from .automation import run_daily_automation
from .config import get_settings
from .database import Base, SessionLocal, engine, get_db
from .editorial import locked_state
from .instagram import run_instagram
from .models import AuditEvent, JobRun, ServiceState
from .security import current_actor

router = APIRouter(prefix="/api")
logger = logging.getLogger(__name__)
_local_lock = threading.Lock()
STATIC_DIR = str(Path(__file__).parent / "static")

@contextmanager
def refresh_lock():
    if engine.dialect.name == "postgresql":
        with engine.connect() as connection:
            key = 7214060601
            acquired = connection.scalar(text("SELECT pg_try_advisory_lock(:key)"), {"key": key})
            try:
                yield bool(acquired)
            finally:
                if acquired:
                    connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": key})
    else:
        acquired = _local_lock.acquire(blocking=False)
        try:
            yield acquired
        finally:
            if acquired:
                _local_lock.release()

def run_sources(settings, target):
    results = {}
    if settings.reddit_source_mode != "manual":
        try:
            with SessionLocal() as db:
                results["reddit"] = run_daily_automation(db, settings, STATIC_DIR, trigger="refresh", target_date=target)
        except Exception:
            # The detailed error is in the research audit, never expose credentials.
            results["reddit"] = {"status": "failed", "detail": "Intake failed; inspect the run log or provider cooldown"}
            logger.exception("Reddit daily refresh failed")
    else:
        results["reddit"] = {"status": "not_configured"}
    try:
        with SessionLocal() as db:
            results["instagram"] = run_instagram(db, settings, STATIC_DIR, target)
    except Exception:
        results["instagram"] = {"status": "failed", "detail": "Check Instagram token permissions and provider cooldown"}
        logger.exception("Instagram daily refresh failed")
    return results

def tick():
    settings = get_settings()
    with refresh_lock() as acquired:
        if not acquired:
            return
        now = datetime.now(timezone.utc)
        today = now.astimezone(ZoneInfo(settings.reddit_daily_timezone)).date()
        with SessionLocal() as db:
            # A terminated worker never leaves an indefinitely running manual job.
            stale = db.scalars(select(JobRun).where(JobRun.job_type == "edition_refresh", JobRun.status == "running")).all()
            for job in stale:
                job.status = "queued"
            # Resume unfinished recent editions after restarts, including jobs
            # marked interrupted by older worker versions.
            recent_keys = [f"%:{day}:%" for day in (today, today - timedelta(days=1))]
            job = db.scalar(select(JobRun).where(JobRun.job_type == "edition_refresh",
                (JobRun.status == "queued") | ((JobRun.status == "interrupted") &
                    (JobRun.idempotency_key.like(recent_keys[0]) | JobRun.idempotency_key.like(recent_keys[1]))))
                .order_by(JobRun.created_at).limit(1))
            state_key = None
            target = today
            if job:
                target = date.fromisoformat(job.idempotency_key.split(":")[1])
            elif settings.daily_automation_enabled:
                for candidate in (today, today - timedelta(days=1)):
                    final = candidate < today
                    key = f"schedule:{candidate.isoformat()}:{'final' if final else 'live'}"
                    state = db.get(ServiceState, key)
                    if state and (state.value.get("finalized") or state.value.get("next_at", 0) > time.time()):
                        continue
                    scheduled = now.replace(hour=settings.daily_automation_hour_utc, minute=settings.daily_automation_minute_utc, second=0, microsecond=0)
                    if not final and now < scheduled:
                        continue
                    state_key, target = key, candidate
                    job = JobRun(job_type="edition_refresh", idempotency_key=f"scheduled:{target}:{uuid.uuid4().hex}", status="queued")
                    db.add(job)
                    break
            if not job:
                db.commit()
                return
            job.status = "running"
            job.attempts = (job.attempts or 0) + 1
            db.commit()
            job_id = job.id
        results = run_sources(settings, target)
        active = [v for v in results.values() if v["status"] != "not_configured"]
        successful = bool(active) and all(v["status"] == "completed" for v in active)
        status = "completed" if successful else "needs_configuration" if not active else "completed_with_warnings"
        with SessionLocal() as db:
            job = db.get(JobRun, job_id)
            job.status = status
            db.add(AuditEvent(entity_type="job_run", entity_id=job_id, action=status, actor="daily-worker", detail={"target_date": str(target), "sources": results}))
            if state_key:
                state = locked_state(db, state_key, {})
                attempts = state.value.get("failures", 0) + 1 if not successful else 0
                state.value = {"next_at": time.time() + (3600 if successful else min(3600, 300 * 2 ** min(attempts, 4))), "failures": attempts, "finalized": successful and target < today, "last_job_id": job_id}
            db.commit()

@router.post("/runs/refresh", status_code=202)
def queue_refresh(target_date: date | None = None, db: Session = Depends(get_db)):
    settings = get_settings()
    day = target_date or datetime.now(ZoneInfo(settings.reddit_daily_timezone)).date()
    locked_state(db, "refresh-queue", {})
    existing = db.scalar(select(JobRun).where(JobRun.job_type == "edition_refresh", JobRun.status.in_(["queued", "running"]), JobRun.idempotency_key.like(f"%:{day}:%")).order_by(JobRun.created_at.desc()))
    if existing:
        return {"job_id": existing.id, "status": existing.status}
    job = JobRun(job_type="edition_refresh", idempotency_key=f"manual:{day}:{uuid.uuid4().hex}", status="queued")
    db.add(job)
    db.flush()
    db.add(AuditEvent(entity_type="job_run", entity_id=job.id, action="queued", actor=current_actor(), detail={"target_date": str(day)}))
    db.commit()
    return {"job_id": job.id, "status": "queued"}

@router.get("/operations")
def operations(db: Session = Depends(get_db)):
    settings = get_settings()
    jobs = db.scalars(select(JobRun).where(JobRun.job_type == "edition_refresh").order_by(JobRun.created_at.desc()).limit(12)).all()
    states = db.scalars(select(ServiceState).where(ServiceState.key.like("provider:%"))).all()
    heartbeat = db.get(ServiceState, "worker:heartbeat")
    return {
        "timezone": settings.reddit_daily_timezone,
        "daily_time_utc": f"{settings.daily_automation_hour_utc:02}:{settings.daily_automation_minute_utc:02}",
        "automatic": settings.daily_automation_enabled,
        "worker_online": bool(heartbeat and heartbeat.value.get("at", 0) > time.time() - 120),
        "reddit": {"configured": settings.reddit_source_mode != "manual", "mode": "Public feeds" if settings.reddit_source_mode == "rss" else "OAuth" if settings.reddit_client_id else "Manual"},
        "instagram": {"configured": bool(settings.instagram_access_token and settings.instagram_account_id), "accounts": [x.strip() for x in settings.instagram_watch_accounts.split(",") if x.strip()]},
        "wordpress": {"enabled": settings.wordpress_publisher_enabled, "site": settings.wordpress_site_url},
        "cooldowns": [{"provider": s.key.split(":")[1], "retry_at": s.value.get("next_at")} for s in states if s.value.get("next_at", 0) > time.time() + 2],
        "runs": [{"id": j.id, "status": j.status, "created_at": j.created_at.isoformat()} for j in jobs],
    }

def heartbeat():
    with SessionLocal() as db:
        state = locked_state(db, "worker:heartbeat", {})
        state.value = {"at": time.time()}
        db.commit()

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    Base.metadata.create_all(engine)
    def keep_alive():
        while True:
            try:
                heartbeat()
            except Exception:
                logger.exception("Worker heartbeat failed")
            time.sleep(30)
    threading.Thread(target=keep_alive, daemon=True).start()
    while True:
        try:
            tick()
        except Exception:
            logger.exception("Daily worker recovered after a failure")
        time.sleep(30)
