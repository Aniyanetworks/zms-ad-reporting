"""sync_runs bookkeeping — every job writes a row; failures are surfaced in the UI."""
from datetime import UTC, datetime

from app.services import pg


def start_run(source: str, client_id: str | None) -> int:
    rows = pg.query(
        """
        insert into sync_runs (source, client_id, status, started_at)
        values (%s, %s, 'running', %s)
        returning id
        """,
        (source, client_id, datetime.now(UTC)),
    )
    return rows[0]["id"]


def finish_run(run_id: int, status: str, rows_upserted: int = 0, error: str | None = None) -> None:
    pg.execute(
        """
        update sync_runs
        set status = %s, rows_upserted = %s, error = %s, finished_at = %s
        where id = %s
        """,
        (status, rows_upserted, error[:4000] if error else None, datetime.now(UTC), run_id),
    )
