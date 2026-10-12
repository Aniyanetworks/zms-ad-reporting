#!/usr/bin/env bash
# Guard against destructive SQL in new or changed Supabase migrations.
#
#   scripts/check-migrations.sh <base-ref>        e.g. origin/main
#
# Lists files added/changed under supabase/migrations/ between <base-ref> and HEAD and
# fails if any contains DROP TABLE / DROP COLUMN / TRUNCATE / DROP SCHEMA / ALTER TABLE ... DROP
# (case-insensitive, SQL `--` comment lines ignored) unless ALLOW_DESTRUCTIVE=1.
# Also warns when an already-committed migration file was modified (they should be immutable).
set -euo pipefail

[[ $# -eq 1 ]] || { echo "usage: $0 <base-ref>" >&2; exit 2; }
BASE="$1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || { echo "ERROR: unknown base ref '$BASE'" >&2; exit 2; }

# Data-destructive statements. "ALTER TABLE ... DROP" counts unless it only drops a
# constraint / default / NOT NULL / identity (schema-only, reversible).
HARD_PATTERN='drop[[:space:]]+table|drop[[:space:]]+column|truncate|drop[[:space:]]+schema'
ALTER_PATTERN='alter[[:space:]]+table[^;]*[[:space:]]drop[[:space:]]'
ALTER_BENIGN='drop[[:space:]]+(constraint|default|not[[:space:]]+null|identity)'
rc=0
found=0

while IFS=$'\t' read -r status path; do
  [[ -n "$path" ]] || continue
  found=1
  case "$status" in
    A*) kind=added ;;
    M*) kind=modified; echo "WARN: existing migration modified: $path (migrations should be immutable; add a new file instead)" >&2 ;;
    R*) kind=renamed ;;
    *)  kind="$status" ;;
  esac
  [[ -f "$path" ]] || continue
  echo "checking ($kind): $path"
  # strip -- comments, then search
  stripped=$(sed 's/--.*$//' "$path")
  # GRANT/REVOKE lines name privileges ("revoke truncate on t"), they do not run them.
  hits=$( { printf '%s\n' "$stripped" | grep -inE "$HARD_PATTERN" | grep -viE '^[0-9]+:[[:space:]]*(grant|revoke)[[:space:]]' || true; printf '%s\n' "$stripped" | grep -inE "$ALTER_PATTERN" | grep -viE "$ALTER_BENIGN" || true; } | sort -t: -k1,1n -u)
  if [[ -n "$hits" ]]; then
    echo "DESTRUCTIVE statements in $path:" >&2
    printf '%s\n' "$hits" | sed 's/^/    /' >&2
    rc=1
  fi
done < <(git diff --name-status --diff-filter=AMR "$BASE" HEAD -- 'supabase/migrations/*.sql' | awk -F'\t' '{print $1 "\t" $NF}')

if [[ $found == 0 ]]; then echo "no migration changes since $BASE"; exit 0; fi

if [[ $rc != 0 ]]; then
  if [[ "${ALLOW_DESTRUCTIVE:-0}" == 1 ]]; then
    echo "ALLOW_DESTRUCTIVE=1 set — destructive statements permitted for this run" >&2
    exit 0
  fi
  echo "FAIL: destructive migration statements found. Re-run with ALLOW_DESTRUCTIVE=1 after an owner has reviewed them." >&2
  exit 1
fi
echo "OK: no destructive statements"
