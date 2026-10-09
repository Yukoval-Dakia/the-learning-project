#!/bin/bash
# Final capture within an externally held maintenance boundary; never stop/restart writers.
# --strict is artifact presence. --require-restore-parity is the separate restore gate.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
TARGET="${LOOM_CUTOVER_TARGET:-${DATABASE_URL:-}}"
OUT_DIR="cutover-backup-$(date +%Y%m%d-%H%M%S)"
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --target=*) TARGET="${arg#--target=}" ;;
    --out=*) OUT_DIR="${arg#--out=}" ;;
    --dry-run) echo 'capture requires explicit target and quiescence evidence; dry-run performs no transport' >&2; exit 0 ;;
    --skip-*) echo 'partial capture is unsupported; use the manifest operation for historical artifacts' >&2; exit 2 ;;
    *) ARGS+=("$arg") ;;
  esac
done
node --import tsx scripts/cutover-backup.ts --operation=capture-parity \
  --out="$OUT_DIR" --target="$TARGET" \
  --container="${LOOM_PG_CONTAINER:-the-learning-project-postgres-1}" \
  --user="${LOOM_DB_USER:-loom}" --database="${LOOM_DB_NAME:-loom}" "${ARGS[@]}"
exit $?
