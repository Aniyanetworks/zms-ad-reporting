"""Application configuration loaded from environment variables."""
from datetime import date
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Carl 2026-09-25: the reporting site is viewable without login (read-only viewer);
    # writes (approve / execute / settings / builds) still require a signed-in role.
    public_read: bool = False
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Environment
    environment: str = Field(default="development")

    # Supabase — new-style keys: publishable (anon) + secret (service role).
    # JWTs are verified via the project's JWKS endpoint; the legacy shared
    # secret is only needed for old HS256-signed projects (and tests).
    supabase_url: str
    supabase_anon_key: str
    supabase_service_role_key: str
    supabase_jwt_secret: str = ""
    # Direct Postgres connection (Supabase pooler, session mode) — used by dlt + API reads
    supabase_db_url: str

    # Redis / Celery
    redis_url: str = Field(default="redis://redis:6379/0")
    celery_broker_url: str = Field(default="redis://redis:6379/1")
    celery_result_backend: str = Field(default="redis://redis:6379/2")

    # Meta Marketing API — System User token from ZMS Business Manager
    meta_system_user_token: str = ""

    # Google Ads API — OAuth under ZMS MCC
    google_ads_developer_token: str = ""
    google_ads_client_id: str = ""
    google_ads_client_secret: str = ""
    google_ads_refresh_token: str = ""
    google_ads_login_customer_id: str = ""  # MCC ID, digits only
    google_sheets_refresh_token: str = ""  # OAuth token for the daily Sheets export
    # Optional Google service account (JSON string or path to the key file) with
    # read-only Sheets + Drive scopes. When set it is used for the setter
    # leaderboard sync instead of the OAuth refresh token above. Both source
    # sheets must be shared (Viewer) with the service account's email.
    google_service_account_json: str = ""
    slack_webhook_url: str = ""  # incoming webhook for daily health alerts
    slack_report_webhook_url: str = ""  # incoming webhook for the 7 AM daily report channel (falls back to slack_webhook_url)
    plugin_api_token: str = ""  # bearer token for the zeal-paid-ads Claude Code plugin

    # Appointment-setter leaderboard — the two read-only source spreadsheets
    # (see app/services/setters.py). Sheet A may be a native Google Sheet or an
    # .xlsx stored in Drive; Sheet B must be a native Google Sheet.
    setter_commission_sheet_id: str = "11ypFwukW3Gj84EJFnGcaMfpASGSkAAEcGk6k3MdFFFs"
    setter_tracking_sheet_id: str = "1lnV1r09ndultnRWrQVLYTOVfWN5RnQAcgNFp-xmsWcI"
    # Active roster shown for the current month. Former setters (Dylan, left 2026-10)
    # still appear in prior months where they have data.
    setter_names: list[str] = Field(default_factory=lambda: ["Brooklyn", "Jonathan", "Matthew", "Morgan", "Natashia"])
    setter_former_names: list[str] = Field(default_factory=lambda: ["Dylan"])  # still synced for history
    setter_sync_interval_seconds: int = 60
    # Team goal = money made for Zeal Media Solutions (Carl, 2026-10-05): Σ over booked,
    # non-cancelled appointments of clients.setter_fee_per_appt (Settings → client), or
    # SETTER_DEFAULT_ZEAL_FEE for clients without one. 0 = "not set yet" (the board says
    # so instead of showing a made-up number). Both overridable at runtime via
    # app_settings keys setter_team_goal / setter_default_zeal_fee.
    setter_team_goal: float = 0
    setter_default_zeal_fee: float = 0
    # Pay rule change (Carl, 2026-10-05): from this appointment date on, every Show pays
    # the flat rate regardless of lead source (the sheet's Rate Card still has the old
    # $1 Angi split). Earlier appointments use the sheet's Commission column as-is.
    setter_flat_rate_from: date = date(2026, 10, 1)
    setter_flat_rate: float = 3.0

    # GoHighLevel — agency token (or per-location Private Integration tokens)
    ghl_agency_token: str = ""

    # App
    # Public URL of the dashboard — used in Slack links and allowed as a CORS origin.
    # Change DASHBOARD_URL in .env when the domain moves.
    dashboard_url: str = "https://ads.zealmediasolutions.com"
    cors_origins: list[str] = Field(
        default_factory=lambda: ["https://ads.zealmediasolutions.com", "http://localhost:3000"]
    )
    # Extra browser origins accepted for state-changing requests (Origin check)
    # and CORS, e.g. the staging hostname. dashboard_url + cors_origins are
    # always included.
    allowed_origins: list[str] = Field(default_factory=list)
    log_level: str = Field(default="INFO")
    # Set at build/deploy time (scripts/deploy.sh) so /api/health reports it.
    git_sha: str = ""

    # Rate limiting (slowapi). memory:// is per-process — fine for one uvicorn
    # worker; point at redis (e.g. redis://redis:6379/3) when scaling out.
    rate_limit_storage_uri: str = ""
    rate_limit_default: str = "600/minute"
    rate_limit_mutation: str = "30/minute"
    rate_limit_plugin: str = "120/minute"

    # Health: a sync source is "stale" when its last success is older than this.
    health_sync_stale_hours: int = 26

    # Campaign Builder chat model. Default: Claude API. Any provider that speaks the
    # Anthropic Messages format works by setting LLM_BASE_URL (e.g. Meta Model API:
    # https://api.meta.ai with LLM_MODEL=muse-spark-1.3). Keys live only in backend/.env.
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-opus-5"
    builder_effort: str = "high"  # Claude: low | medium | high | xhigh | max
    llm_base_url: str = ""        # empty = api.anthropic.com (full Claude features)
    llm_api_key: str = ""         # key for LLM_BASE_URL; falls back to ANTHROPIC_API_KEY
    llm_model: str = ""           # model id at LLM_BASE_URL; falls back to ANTHROPIC_MODEL
    llm_reasoning_effort: str = ""  # compat providers only, e.g. Meta: minimal|low|medium|high|xhigh

    @property
    def llm_compat_mode(self) -> bool:
        return bool(self.llm_base_url.strip())

    @property
    def allowed_origin_hosts(self) -> set[str]:
        from urllib.parse import urlsplit

        hosts = set()
        for url in [*self.cors_origins, self.dashboard_url, *self.allowed_origins]:
            netloc = urlsplit(url).netloc or url
            if netloc:
                hosts.add(netloc.split(":")[0].lower())
        return hosts


@lru_cache
def get_settings() -> Settings:
    return Settings()
