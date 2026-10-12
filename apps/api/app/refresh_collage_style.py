"""Re-render saved collages with current styling; retain prior versions and edits."""
import json
from pathlib import Path
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from .automation import render_draft_collage, case_content_eligible
from .config import get_settings
from .collage import ensure_demo_images
from .database import SessionLocal
from .models import Case, Candidate, Collage, AuditEvent


def main():
    settings = get_settings()
    ensure_demo_images(str(Path(__file__).parent / 'static'))
    updated = 0
    failed = []
    with SessionLocal() as db:
        ids = list(db.scalars(select(Collage.case_id).distinct()))
    for case_id in ids:
        with SessionLocal() as db:
            case = db.scalar(select(Case).where(Case.id == case_id).with_for_update().options(
                selectinload(Case.candidates).selectinload(Candidate.decisions)))
            if not case or not case_content_eligible(case):
                continue
            latest = db.scalar(select(Collage).where(Collage.case_id == case_id).order_by(Collage.created_at.desc()))
            try:
                manifest = json.loads(Path(latest.manifest_path).read_text())
                if manifest.get('renderer_style') == 'edge_to_edge_v2':
                    continue
            except (OSError, ValueError):
                pass
            try:
                record = render_draft_collage(db, case, case.candidates, settings,
                    str(Path(__file__).parent / 'static'), editor_id='style-refresh',
                    reason='Regenerate saved collage without blurred fills, gaps or caption strips.',
                    decision_type='editor_draft')
                extraction = dict(case.extraction or {})
                extraction['automatic_collage'] = {**extraction.get('automatic_collage', {}), 'id': record.id}
                case.extraction = extraction
                db.add(AuditEvent(entity_type='case', entity_id=case_id, action='collage_style_refreshed',
                    actor='style-refresh', detail={'previous_collage_id': latest.id, 'collage_id': record.id}))
                db.commit()
                updated += 1
                print(json.dumps({'updated': updated, 'case': case_id, 'person': case.celebrity}), flush=True)
            except Exception as exc:
                db.rollback()
                failed.append(case_id)
                print(json.dumps({'failed': case_id, 'error': str(exc)}), flush=True)
    print(json.dumps({'complete': True, 'updated': updated, 'failed': failed}), flush=True)
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
