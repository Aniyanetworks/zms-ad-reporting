# syntax=docker/dockerfile:1.7
# ZMS Ads API / Celery image.
#
# Stages
#   base     python:3.12-slim pinned by digest, non-root user `app` (uid 10001)
#   builder  build toolchain (gcc, libpq-dev) + venv with the project installed
#   test     builder + dev extras; `docker build --target test` then `docker run --rm <img>`
#   runtime  (default) slim runtime: libpq5 only, copies the venv + source, USER app
#
# Refresh the digest with:  docker buildx imagetools inspect python:3.12-slim
# (Dependabot's docker ecosystem also proposes digest bumps weekly.)
ARG PYTHON_IMAGE=python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

# ---------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH

RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid 10001 --home-dir /app --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libpq-dev \
 && rm -rf /var/lib/apt/lists/*

RUN python -m venv "$VIRTUAL_ENV"

# 1) Resolve and install third-party dependencies from pyproject.toml alone so the
#    (slow) dependency layer is cached across source-only changes. Stub packages
#    satisfy setuptools' explicit `packages` list; the stub project is removed again.
COPY pyproject.toml ./
RUN mkdir -p app facebook_ads google_ads \
 && touch app/__init__.py facebook_ads/__init__.py google_ads/__init__.py \
 && pip install . \
 && pip uninstall -y zms-ads-api \
 && rm -rf app facebook_ads google_ads build ./*.egg-info

# 2) Install the real project on top (no dependency re-resolution).
COPY app ./app
COPY facebook_ads ./facebook_ads
COPY google_ads ./google_ads
COPY scripts ./scripts
COPY .dlt ./.dlt
RUN pip install --no-deps . \
 && rm -rf build ./*.egg-info

# ---------------------------------------------------------------------------
FROM builder AS test

# Dev extras come from [project.optional-dependencies].dev; the explicit list is a
# fallback for checkouts whose pyproject predates that section.
RUN pip install '.[dev]' 2>/dev/null \
 || pip install 'pytest>=8' 'pytest-asyncio>=0.24' 'ruff>=0.6' 'httpx>=0.27'
RUN rm -rf build ./*.egg-info

COPY tests ./tests
RUN chown -R app:app /app
USER app
ENV HOME=/tmp
CMD ["pytest", "-q", "-p", "no:cacheprovider"]

# ---------------------------------------------------------------------------
FROM base AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq5 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=root:root "$VIRTUAL_ENV" "$VIRTUAL_ENV"
COPY --chown=root:root pyproject.toml ./
COPY --chown=root:root app ./app
COPY --chown=root:root facebook_ads ./facebook_ads
COPY --chown=root:root google_ads ./google_ads
COPY --chown=root:root scripts ./scripts
COPY --chown=root:root .dlt ./.dlt

# The container filesystem is mounted read-only by compose; everything that must be
# written (dlt pipeline working dir, celery beat schedule, multiprocessing temp
# files) goes to the /tmp tmpfs. HOME=/tmp so `~/.dlt`, `~/.cache` etc. resolve there.
ENV HOME=/tmp \
    DLT_DATA_DIR=/tmp/dlt \
    TMPDIR=/tmp

USER app

EXPOSE 8000
STOPSIGNAL SIGTERM

# curl is not installed; probe the dependency-free liveness route with stdlib only.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health/live', timeout=3).status==200 else 1)"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
