# syntax=docker/dockerfile:1.7
# Tiny helper image for the backup scripts on a host with no usable Python/age/rclone:
# provides `age`, `rclone` and the PostgreSQL 17 client tools. Built on demand by
# scripts/backup-*.sh as zms-ads-tools:latest (see build_tools_image in scripts/backup-lib.sh).
#
# Refresh the digest with:  docker buildx imagetools inspect alpine:3.22
FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce
RUN apk add --no-cache age rclone postgresql17-client ca-certificates tzdata \
 && adduser -D -u 10001 tools
USER tools
WORKDIR /work
