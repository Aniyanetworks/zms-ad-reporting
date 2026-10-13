# syntax=docker/dockerfile:1.7
# Tiny helper image for the backup scripts on a host with no usable Python/age/rclone:
# provides `age`, `rclone` and the PostgreSQL 17 client tools. Built on demand by
# scripts/backup-*.sh as zms-ads-tools:latest (see build_tools_image in scripts/backup-lib.sh).
#
# Refresh the digest with:  docker buildx imagetools inspect alpine:3.22
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN apk add --no-cache age rclone postgresql17-client ca-certificates tzdata \
 && adduser -D -u 10001 tools
USER tools
WORKDIR /work
