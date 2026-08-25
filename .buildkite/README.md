# Buildkite Green Bridge — versioned shadow scaffold (YUK-916 Phase 1 + YUK-918 native DB lane)

This directory is the in-repo, versioned half of the Buildkite Green Bridge
(YUK-916). The external pipeline `the-learning-project-ci-shadow` bootstraps
from here: its only built-in step uploads `.buildkite/pipeline.yml`, and every
real job then comes from this directory plus the imported GitHub workflow
subset. The operational phase plan, current/desired external state, restore
payload location, and rollback commands live in
[`docs/runbooks/buildkite-green-bridge.md`](../docs/runbooks/buildkite-green-bridge.md).

The DB lane (YUK-918 Phase 2) is native Buildkite: it never goes through the
GitHub importer's `upload-artifact`/`download-artifact` (which cannot see
files produced by native steps). Instead the selector step seals the affected
DB selection into a digest-covered manifest and uploads it with
`buildkite-agent artifact upload`; every shard downloads it with
`buildkite-agent artifact download --step db-select` and re-verifies schema,
SHA-256 digest, freshness, and the shard plan before running.

## Layout

| File | Role |
| --- | --- |
| `pipeline.yml` | The uploaded shadow pipeline: checkout identity step + pinned `github-actions` importer for the proven-compatible job subset, plus the Phase 2 native usability lane step. |
| `pins.env` | Importer plugin pin (source, release, commit, observed date), runtime pins, and the CI image pin block (`CI_IMAGE_*` incl. the pending-publication state), enforced by the freshness gate. |
| `ci-image/Dockerfile` | Digest-pinned custom `green-bridge-linux-large` runner image: Playwright `v1.62.1-noble` base (amd64 manifest digest, matches the repo `@playwright/test` pin and carries Chromium + its OS dependencies), Node 24.0.0 (checksum-verified tarball), pnpm 11.13.1, Bun 1.3.14, git/jq, and a build-time `chrome --version` assertion so a broken browser fails the image build, not 13 scenarios. |
| `pipeline-settings.json` | Desired external pipeline settings snapshot; diffed against the live pipeline before phase changes. |
| `scripts/verify-build-context.sh` | Step entry point for the checkout identity verification. |
| `scripts/db-select-upload.sh` | YUK-918 native DB selector step: run the DB selector once, build the digest-covered manifest, upload it via `buildkite-agent artifact upload`. |
| `scripts/db-shard-run.sh` | YUK-918 native DB shard step: download/verify the selector manifest via `buildkite-agent artifact download --step db-select`, then run this shard through `db-affected.mjs run`. |
| `scripts/run-usability-lane.sh` | Phase 2 native usability step: boots the built server, proves a real headless Chromium launch, runs the real 13-scenario `shipped-container` suite, and fails unless the manifest gate passes. |
| `scripts/pre-command.sh` | Versioned agent pre-command hook; install into a custom base image for job-wide verification (Phase 2+ wiring). |
| `../scripts/ci/verify-build-context.mjs` | The context verifier itself (identity checks, metadata emission), unit-tested in `../scripts/ci/verify-build-context.test.ts`. |
| `../scripts/ci/green-bridge-pins.mjs` | The pins policy: parsing plus the freshness gate behind `--pins` (including the `CI_IMAGE_*` lifecycle), unit-tested in the same test file. |
| `../scripts/ci/db-artifact-manifest.mjs` | YUK-918 selector-side manifest module: builds the schema-validated, SHA-256-covered DB selection manifest (absolute workspace paths, source HEAD/tree, shard assignments, expiry), unit-tested in `../scripts/ci/db-artifact-manifest.test.ts`. |
| `../scripts/ci/db-artifact-shard.mjs` | YUK-918 shard-side runner: downloads the manifest through `buildkite-agent`, fails closed on corruption/tamper, deterministically falls back to the full DB suite when the manifest is missing/stale/expired, and merges the selector digest into each shard's execution report; unit/CLI-tested in `../scripts/ci/db-artifact-shard.test.ts`. |
| `../scripts/ci/usability-probe.mjs` | Launches real headless Chromium and emits one JSON probe record (version, launched, error). |
| `../scripts/ci/usability-lane.mjs` | The manifest gate: parses the Playwright JSON report, requires Chromium launched + exactly 13/13 executed (0 skipped/failed/flaky), and writes `test-results/usability-gate/manifest.json` carrying `image.state` + `cutover_ready`. |
| `../.github/workflows/buildkite-shadow-subset.yml` | The imported workflow subset: only the `migration` and `build` jobs, verbatim from `ci-gate.yml`. |
| `../.github/workflows/buildkite-ci-image.yml` | Builds/pushes `ci-image/Dockerfile` to GHCR using only the ephemeral `GITHUB_TOKEN` (`packages: write`); emits the pushed digest as artifact + job summary. Deploys nothing. |

## What the pipeline runs

1. `verify-build-context` (queue `green-bridge-linux-large`) — asserts `BUILDKITE_COMMIT`
   equals the checked-out `git rev-parse HEAD`, resolves the HEAD tree and the
   merge-base against the default branch (and the PR base branch on PR builds),
   compares `GITHUB_SHA` / `GITHUB_EVENT_BEFORE` when the environment provides
   them, runs the pins freshness gate, emits exactly one JSON record, and stores
   it as Buildkite metadata `green-bridge-context`. Any violation fails the step.
2. `github-actions-import` (queue `green-bridge-linux-large`) — imports
   `.github/workflows/buildkite-shadow-subset.yml` through the pinned
   `github-actions` plugin, mapping `ubuntu-latest` to `green-bridge-linux-large`, and only
   after the identity step passed. No deploy or production credentials are used.
3. `db-select` (queue `green-bridge-linux-large`, YUK-918) — after the identity step, runs
   `scripts/ci/db-affected.mjs select` against the merge-base with the default
   branch, seals the result into `.cache/ci/db-manifest.json` via
   `scripts/ci/db-artifact-manifest-cli.mjs build` (schema v1: source HEAD/tree,
   absolute workspace paths, selected files, round-robin shard assignments,
   created/expiry timestamps, SHA-256 content digest over every manifest
   byte), and uploads it with `buildkite-agent artifact upload`.
4. `db-shard` (queue `green-bridge-linux-large`, `parallelism: 2`, YUK-918) — downloads the
   manifest with `buildkite-agent artifact download --step db-select` and
   verifies it before running. Policy, exercised by the unit/CLI tests:
   >=2 selected files → both shards execute and report the identical selector
   digest; exactly 1 file → shard 1 executes while shard 2 records
   `skipped_empty_shard: true` with the same digest; corrupt/tampered manifest
   (digest mismatch, schema violation, unparseable bytes) → the shard fails
   closed without running; missing/stale/expired manifest → deterministic
   fallback to the full sharded DB suite (a real non-empty suite), recorded as
   `selector.status: "fallback"`. The DB tests need Docker on the agent image
    (testcontainers Postgres, same as the GitHub lane).
5. `usability-lane` (queue `green-bridge-linux-large`, Phase 2) — runs
   `.buildkite/scripts/run-usability-lane.sh`: install → Playwright Chromium →
   `pnpm build` → boot `dist/server.cjs` on :18787 → real headless Chromium
   launch probe → the real 13-scenario `shipped-container` Playwright suite →
   the manifest gate (`node scripts/ci/usability-lane.mjs --manifest`). The step
   is green ONLY when the emitted manifest proves Chromium launched AND exactly
   13/13 scenarios executed (0 skipped/failed/flaky); job exit 0 alone never
   passes it. The queue is pinned to the published image digest in `pins.env`;
   `chromium-launch-failed` remains a hard failure rather than a skipped lane.

## Importer pin

`pins.env` records the importer release provenance and verified commit, while
`pipeline.yml` loads the plugin by the immutable commit ref
`github-actions#98159d5e696d06b70df490b9d7d9eabc32bc2b21` (release `v0.13.0`),
verified on 2026-08-25 with `git ls-remote` and a tag checkout. The originally claimed pin (`v0.6.0` @
`a8ea2f2c4af84794a4f18c93b1dc78bcbb252337`) does not exist upstream — GitHub
returns 422 for that SHA and no ref carries it — and v0.6.0 predates the
`workflows:` configuration shape that the Phase 0 shadow pipeline actually
exercised. Do not restore that pin without re-verifying against the plugin
repository. Re-observe and refresh pins at least every `PIN_MAX_AGE_DAYS`;
`node scripts/ci/verify-build-context.mjs --pins` is the freshness gate.

## CI image pin (Phase 2)

`pins.env` carries the runner-image block: the immutable base digest
(`CI_IMAGE_BASE_DIGEST`, the amd64 manifest of
`mcr.microsoft.com/playwright:v1.62.1-noble`, resolved 2026-08-25 via
`docker buildx imagetools inspect`) and the published image digest from GitHub
Actions run `32858819395`. Buildkite queue `green-bridge-linux-large`
(`bd009abf-5ca8-4d38-8e32-3cdf7b78cda5`) read-backs the same immutable GHCR
digest; the freshness bound applies to the publication observation.

## Local validation

```bash
bash -n .buildkite/scripts/verify-build-context.sh .buildkite/scripts/pre-command.sh .buildkite/scripts/db-select-upload.sh .buildkite/scripts/db-shard-run.sh .buildkite/scripts/run-usability-lane.sh
bk pipeline validate --file .buildkite/pipeline.yml
pnpm vitest run --config vitest.unit.config.ts scripts/ci/verify-build-context.test.ts scripts/ci/db-artifact-manifest.test.ts scripts/ci/db-artifact-shard.test.ts scripts/ci/usability-lane.test.ts
node scripts/ci/verify-build-context.mjs --pins
node scripts/ci/usability-probe.mjs   # needs local `pnpm test:usability:install`
```

## Troubleshooting

- `node is required on the queue image` — the identity step needs `node` on
  `PATH` of the `linux-large` image. If the hosted image lacks it, either move
  the identity checks into a `mise` bootstrap in the step or switch the queue's
  base image; record the outcome in the runbook before changing the pipeline.
- `pins-stale` — re-verify the plugin pin against
  `https://github.com/buildkite-plugins/github-actions-buildkite-plugin`,
  update `pins.env`, and note the observation in the runbook.
- `commit-head-mismatch` — the build's `BUILDKITE_COMMIT` does not match the
  checkout; this is the Build #5 failure class (a commit that never existed
  remotely). Confirm the branch head is actually pushed, then rebuild.
- `digest-mismatch` / `manifest-corrupt-json` (DB shards, YUK-918) — the
  downloaded selector manifest does not hash to its recorded SHA-256 or is
  unparseable. The shard fails closed by design; do not weaken it. Retry the
  build, and if it reproduces, inspect the `db-select` step's uploaded
  `.cache/ci/db-selection.json` plus the shard's downloaded manifest artifact.
- `selector.status: "fallback"` in a shard's `db-execution-shard-N.json` — the
  manifest was missing, stale (different `BUILDKITE_COMMIT`), or expired, so
  the shard ran the full DB suite instead. Safe but slower; frequent
  `manifest-missing` points at artifact storage/queue issues worth
  investigating before Phase 4.
- `shard-count-mismatch` — the manifest was built for a different shard count
    than the step's `parallelism`. Both live in this directory (`--shards 2` in
    `db-select-upload.sh`, `parallelism: 2` in `pipeline.yml`); change them
    together.
- `chromium-launch-failed` — the digest-pinned queue image failed to launch
  Chromium or lost an OS dependency (the Build #1 `libnspr4.so` class). The
  manifest artifact (`test-results/usability-gate/manifest.json`) carries the
  exact error; do not skip the lane or fall back to the default queue image.
