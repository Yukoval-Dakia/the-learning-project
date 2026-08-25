#!/usr/bin/env bash
# YUK-916 Green Bridge - agent pre-command hook (versioned copy).
#
# Buildkite hosted agents support job lifecycle hooks only through custom base
# images; this file is the versioned source to install there (Phase 2+ wiring,
# see .buildkite/README.md). It simply runs the repository's checkout identity
# verification before every command job in the checkout directory.
set -euo pipefail

checkout="${BUILDKITE_BUILD_CHECKOUT_PATH:-$PWD}"
cd "$checkout"
exec "$checkout/.buildkite/scripts/verify-build-context.sh"
