"""Celery entry point for the Campaign Builder executor."""
from app.celery_app import celery
from app.services.builder.executor import execute_build as _execute


@celery.task(name="app.tasks.builds.execute_build", time_limit=1800, soft_time_limit=1700, acks_late=False)
def execute_build(build_id: str) -> dict:
    return _execute(build_id)
