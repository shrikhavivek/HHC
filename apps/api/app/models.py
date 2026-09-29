import uuid
from datetime import datetime, timezone
from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .database import Base


def new_id() -> str:
    return str(uuid.uuid4())


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class Case(Base):
    __tablename__ = "cases"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    source_type: Mapped[str] = mapped_column(String(32), default="manual_reddit_url")
    external_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    permalink: Mapped[str] = mapped_column(Text, unique=True)
    source_title: Mapped[str] = mapped_column(Text)
    source_body: Mapped[str] = mapped_column(Text, default="")
    celebrity: Mapped[str] = mapped_column(String(180), default="Unresolved")
    designer: Mapped[str] = mapped_column(String(180), default="Unresolved")
    event_name: Mapped[str] = mapped_column(String(240), default="Unresolved")
    event_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(String(40), default="context_review")
    match_type: Mapped[str] = mapped_column(String(64), default="insufficient_evidence")
    confidence: Mapped[float] = mapped_column(Float, default=0)
    risk_level: Mapped[str] = mapped_column(String(16), default="medium")
    base_image: Mapped[str] = mapped_column(Text, default="/static/look-1.png")
    extraction: Mapped[dict] = mapped_column(JSON, default=dict)
    demo_data: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)
    candidates: Mapped[list["Candidate"]] = relationship(back_populates="case", cascade="all, delete-orphan")


class Candidate(Base):
    __tablename__ = "candidates"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    person: Mapped[str] = mapped_column(String(180))
    designer: Mapped[str] = mapped_column(String(180))
    event_name: Mapped[str] = mapped_column(String(240))
    event_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
    image_path: Mapped[str] = mapped_column(Text)
    proposed_match_type: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(40), default="review_required")
    visual_score: Mapped[float] = mapped_column(Float, default=0)
    source_grade: Mapped[str] = mapped_column(String(4), default="D")
    rights_status: Mapped[str] = mapped_column(String(40), default="editorial_review_required")
    evidence: Mapped[list] = mapped_column(JSON, default=list)
    checks: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    case: Mapped[Case] = relationship(back_populates="candidates")
    decisions: Mapped[list["Decision"]] = relationship(back_populates="candidate", cascade="all, delete-orphan")


class Decision(Base):
    __tablename__ = "decisions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    candidate_id: Mapped[str] = mapped_column(ForeignKey("candidates.id", ondelete="CASCADE"), index=True)
    decision: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str] = mapped_column(Text)
    editor_id: Mapped[str] = mapped_column(String(120))
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    candidate: Mapped[Candidate] = relationship(back_populates="decisions")


class Collage(Base):
    __tablename__ = "collages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    decision_id: Mapped[str] = mapped_column(ForeignKey("decisions.id"))
    image_path: Mapped[str] = mapped_column(Text)
    manifest_path: Mapped[str] = mapped_column(Text)
    bundle_path: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str] = mapped_column(String(36), index=True)
    action: Mapped[str] = mapped_column(String(80))
    actor: Mapped[str] = mapped_column(String(120))
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class JobRun(Base):
    __tablename__ = "job_runs"
    __table_args__ = (UniqueConstraint("idempotency_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    job_type: Mapped[str] = mapped_column(String(60))
    idempotency_key: Mapped[str] = mapped_column(String(180))
    status: Mapped[str] = mapped_column(String(32), default="queued")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

