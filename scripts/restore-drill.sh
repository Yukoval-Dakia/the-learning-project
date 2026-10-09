#!/bin/bash
# Scratch-only full Postgres restore parity. Imports do not start any transport.
# Full: --dump=<file> --source-manifest=<file> --out=<receipt>
# Legacy: --restore-only --dump=<file> --image=<image> --out=<receipt>
# --list-only validates TOC only; --keep retains scratch; --overwrite archives old receipt.
set -uo pipefail
RESTORE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
node --import tsx "$RESTORE_REPO/scripts/cutover-backup.ts" --operation=restore-drill "$@"
exit $?
