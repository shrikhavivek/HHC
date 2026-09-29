from sqlalchemy import select
from sqlalchemy.orm import Session
from .models import Case, Candidate


CASES = [
    {
        "title": "Priyanka Chopra in Sabyasachi for the Heritage Gala",
        "celebrity": "Priyanka Chopra Jonas", "designer": "Sabyasachi", "event": "Heritage Gala, Mumbai",
        "date": "2026-09-24", "status": "review_ready", "match_type": "same_item_other_celebrity",
        "confidence": .91, "risk": "low", "base": "/static/look-1.png", "candidate": {
            "person": "Deepika Padukone", "designer": "Sabyasachi", "event": "Maison Preview, Delhi", "date": "2023-11-14",
            "image": "/static/look-2.png", "score": .94, "grade": "A", "type": "same_item_other_celebrity",
            "checks": {"same_photo": False, "same_event": False, "chronology": True, "identity": True, "contradictions": [], "landmarks": ["border motif", "blouse construction", "gold thread placement"]},
        }
    },
    {
        "title": "Alia Bhatt in custom Gucci at the Cinema Awards",
        "celebrity": "Alia Bhatt", "designer": "Gucci", "event": "Cinema Awards, London",
        "date": "2026-09-22", "status": "needs_research", "match_type": "insufficient_evidence",
        "confidence": .63, "risk": "high", "base": "/static/look-3.png", "candidate": {
            "person": "Editorial archive lead", "designer": "Gucci", "event": "Unknown editorial", "date": None,
            "image": "/static/look-4.png", "score": .76, "grade": "C", "type": "similar_not_same",
            "checks": {"same_photo": False, "same_event": False, "chronology": None, "identity": False, "contradictions": ["neckline construction differs"], "landmarks": ["silver surface treatment"]},
        }
    },
    {
        "title": "Sobhita Dhulipala in Raw Mango for the Jaipur premiere",
        "celebrity": "Sobhita Dhulipala", "designer": "Raw Mango", "event": "Jaipur Premiere",
        "date": "2026-09-20", "status": "context_review", "match_type": "same_item_same_celebrity",
        "confidence": .82, "risk": "medium", "base": "/static/look-5.png", "candidate": {
            "person": "Sobhita Dhulipala", "designer": "Raw Mango", "event": "Literary Festival", "date": "2021-02-06",
            "image": "/static/look-6.png", "score": .88, "grade": "B", "type": "same_item_same_celebrity",
            "checks": {"same_photo": False, "same_event": False, "chronology": True, "identity": True, "contradictions": [], "landmarks": ["woven temple border", "pallu geometry"]},
        }
    },
    {
        "title": "Kareena Kapoor Khan in archival Manish Malhotra",
        "celebrity": "Kareena Kapoor Khan", "designer": "Manish Malhotra", "event": "Studio Dinner",
        "date": "2026-09-18", "status": "auto_rejected", "match_type": "same_event_duplicate",
        "confidence": .98, "risk": "low", "base": "/static/look-2.png", "candidate": {
            "person": "Kareena Kapoor Khan", "designer": "Manish Malhotra", "event": "Studio Dinner", "date": "2026-09-18",
            "image": "/static/look-2.png", "score": .99, "grade": "B", "type": "same_event_duplicate",
            "checks": {"same_photo": True, "same_event": True, "chronology": False, "identity": True, "contradictions": ["same press image hash"], "landmarks": []},
        }
    },
]


DEMO_ASSETS = [
    ("/static/look-4.png", "/static/look-3.png"),
    ("/static/look-6.png", "/static/look-5.png"),
    ("/static/look-2.png", "/static/look-1.png"),
    ("/static/look-3.png", "/static/look-6.png"),
]


def _demo_collage_assets(index: int, row: dict) -> list[dict]:
    current_angle, designer_reference = DEMO_ASSETS[index - 1]
    return [
        {
            "id": f"demo-current-angle-{index}",
            "role": "current_angle",
            "label": "Alternate angle from today's source set",
            "person": row["celebrity"],
            "designer": row["designer"],
            "image_path": current_angle,
            "source_url": f"https://example.com/demo/reddit-angle/{index}",
            "publisher": "r/BollywoodFashion source set (demo)",
            "credit": "Demonstration asset - replace with original photographer credit",
            "retrieved_at": "2026-09-27",
            "rights_status": "editorial_review_required",
            "source_grade": "D",
            "exact_match": True,
            "include_in_collage": True,
            "fallback_only": True,
            "notes": "Used only when no approved historical appearance is available.",
        },
        {
            "id": f"demo-designer-reference-{index}",
            "role": "designer_reference",
            "label": "Official designer model reference",
            "person": "Brand model",
            "designer": row["designer"],
            "image_path": designer_reference,
            "source_url": f"https://example.com/demo/designer-lookbook/{index}",
            "publisher": f"{row['designer']} official lookbook (demo)",
            "credit": f"Courtesy {row['designer']} - demonstration placeholder",
            "retrieved_at": "2026-09-27",
            "rights_status": "editorial_review_required",
            "source_grade": "A",
            "official_source": True,
            "exact_match": True,
            "include_in_collage": True,
            "fallback_only": False,
            "notes": "The live workflow must verify the exact garment and collection before inclusion.",
        },
    ]


def _demo_extraction(index: int, row: dict) -> dict:
    return {
        "celebrity": {"value": row["celebrity"], "confidence": row["confidence"], "evidence": "title"},
        "designer": {"value": row["designer"], "confidence": row["confidence"], "evidence": "title"},
        "needs_human_context_review": row["status"] == "context_review",
        "collage_assets": _demo_collage_assets(index, row),
    }


def seed_database(db: Session):
    if db.scalar(select(Case.id).limit(1)):
        # Safe data-only backfill so existing demo volumes gain the new per-outfit
        # source board without resetting editor decisions or audit history.
        for index, row in enumerate(CASES, start=1):
            permalink = f"https://www.reddit.com/r/BollywoodFashion/comments/demo{index}"
            case = db.scalar(select(Case).where(Case.permalink == permalink))
            extraction = case.extraction if case and isinstance(case.extraction, dict) else {}
            if case and case.demo_data:
                case.extraction = {**extraction, "collage_assets": _demo_collage_assets(index, row)}
        db.commit()
        return
    for index, row in enumerate(CASES, start=1):
        case = Case(
            permalink=f"https://www.reddit.com/r/BollywoodFashion/comments/demo{index}", source_title=row["title"], source_body="Demonstration record. Replace with source-backed editorial evidence.",
            celebrity=row["celebrity"], designer=row["designer"], event_name=row["event"], event_date=row["date"], status=row["status"], match_type=row["match_type"],
            confidence=row["confidence"], risk_level=row["risk"], base_image=row["base"], demo_data=True,
            extraction=_demo_extraction(index, row),
        )
        c = row["candidate"]
        case.candidates.append(Candidate(
            person=c["person"], designer=c["designer"], event_name=c["event"], event_date=c["date"], image_path=c["image"], proposed_match_type=c["type"],
            status="auto_rejected" if c["type"] == "same_event_duplicate" else "review_required", visual_score=c["score"], source_grade=c["grade"],
            evidence=[{"publisher": "Designer archive" if c["grade"] == "A" else "Editorial source", "url": f"https://example.com/evidence/{index}", "grade": c["grade"], "quote": "Demonstration evidence — replace before production use."}], checks=c["checks"],
        ))
        db.add(case)
    db.commit()
