"""Celery entry points for the tracking rollout."""
from app.celery_app import celery
from app.services import tracking


@celery.task(name="app.tasks.tracking.propose_tracking_fixes", time_limit=1500, soft_time_limit=1400)
def propose_tracking_fixes() -> dict:
    return tracking.propose_tracking_fixes()


@celery.task(name="app.tasks.tracking.execute_recommendation", time_limit=900, soft_time_limit=840, acks_late=False)
def execute_recommendation(rec_id: int, actor: str) -> dict:
    return tracking.execute_recommendation(rec_id, actor)
