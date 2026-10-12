# syntax=docker/dockerfile:1.7
# ZMS Ads web (Next.js) image — 3 stages: deps -> builder -> runner.
#
# Refresh the digest with:  docker buildx imagetools inspect node:22-alpine
ARG NODE_IMAGE=node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV npm_config_update_notifier=false npm_config_fund=false
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV npm_config_update_notifier=false npm_config_fund=false NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
# "production" | "staging" — staging renders the amber banner in the nav.
ARG NEXT_PUBLIC_ENVIRONMENT=production
# Git SHA of the build; reported by GET /healthz.
ARG NEXT_PUBLIC_GIT_SHA=dev
# Rewrites are baked into the build (routes-manifest.json) — API_URL must be the
# in-network address at BUILD time; the runtime env alone is not enough.
ARG API_URL=http://api:8000
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_ENVIRONMENT=$NEXT_PUBLIC_ENVIRONMENT \
    NEXT_PUBLIC_GIT_SHA=$NEXT_PUBLIC_GIT_SHA \
    API_URL=$API_URL
RUN npm run build

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    # npm's own cache/log dir must be writable when the rootfs is read-only
    npm_config_cache=/tmp/.npm \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Files are owned by root and world-readable; `node` (uid 1000, ships with the base
# image) only needs write access to .next/cache and /tmp, which compose mounts as tmpfs.
COPY --from=builder --chown=root:root /app/.next ./.next
COPY --from=builder --chown=root:root /app/node_modules ./node_modules
COPY --from=builder --chown=root:root /app/package.json ./package.json
COPY --from=builder --chown=root:root /app/public ./public
COPY --from=builder --chown=root:root /app/next.config.ts ./next.config.ts
RUN mkdir -p /app/.next/cache && chown node:node /app/.next/cache

USER node

EXPOSE 3000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz > /dev/null || exit 1

CMD ["npm", "run", "start"]
