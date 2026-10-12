"""Shared test setup: settings need env; nothing here touches a real database."""
import os

os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "sb_publishable_test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-hs256-secret-long-enough-32-bytes!")
os.environ.setdefault("SUPABASE_DB_URL", "postgresql://x:x@localhost/x")
os.environ.setdefault("DASHBOARD_URL", "https://adbuildout.contractorscalingblueprint.com")
os.environ.setdefault("RATE_LIMIT_STORAGE_URI", "memory://")
os.environ.setdefault("PLUGIN_API_TOKEN", "test-plugin-token")
