"""Unit economics: what a booked appointment is worth, so CPBA has a real ceiling."""


def max_cpba(avg_job_value, close_rate, gross_margin_pct, max_ad_cost_share) -> float | None:
    """Most we may pay per booked appointment. None until the client has a job value."""
    try:
        job = float(avg_job_value or 0)
        if job <= 0:
            return None
        return round(job * float(close_rate or 0) * float(gross_margin_pct or 0) * float(max_ad_cost_share or 0), 2)
    except (TypeError, ValueError):
        return None


def cpba_color(cpba, ceiling) -> str | None:
    """green ≤ 75% of the ceiling, yellow ≤ ceiling, red above; None without data."""
    if cpba is None or not ceiling:
        return None
    return "green" if cpba <= ceiling * 0.75 else "yellow" if cpba <= ceiling else "red"
