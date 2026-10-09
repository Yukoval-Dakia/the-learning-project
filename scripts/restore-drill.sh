#!/bin/bash
# Scratch-only full Postgres restore parity. Imports do not start any transport.
# Full: --dump=<file> --source-manifest=<file> --out=<receipt>
# Legacy: --restore-only --dump=<file> --image=<image> --out=<receipt>
# --list-only validates TOC only; --keep retains scratch; --overwrite archives old receipt.
# Full parity only: --keep --scratch-loopback-port=<1024..65535> --scratch-database=test_fork_<digits>
# Both --key=value options are required together. Creates a new owned scratch; collision fails.
# Default remains network=none. A failed retained scratch never authorizes worker reopen.
set -uo pipefail
RESTORE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
TSX_TSCONFIG_PATH="$RESTORE_REPO/tsconfig.json" node --import "$RESTORE_REPO/node_modules/tsx/dist/loader.mjs" "$RESTORE_REPO/scripts/cutover-backup.ts" --operation=restore-drill "$@"
exit $?
