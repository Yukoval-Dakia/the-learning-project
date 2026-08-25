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
| `pipeline.yml` | The uploaded shadow pipeline: checkout identity step + pinned `github-actions` importer for the proven-compatible job subset. |
| `pins.env` | Importer plugin pin (source, release, commit, observed date) and runtime pins, enforced by the freshness gate. |
| `pipeline-settings.json` | Desired external pipeline settings snapshot; diffed against the live pipeline before phase changes. |
| `scripts/verify-build-context.sh` | Step entry point for the checkout identity verification. |
| `scripts/db-select-upload.sh` | YUK-918 native DB selector step: run the DB selector once, build the digest-covered manifest, upload it via `buildkite-agent artifact upload`. |
| `scripts/db-shard-run.sh` | YUK-918 native DB shard step: download/verify the selector manifest via `buildkite-agent artifact download --step db-select`, then run this shard through `db-affected.mjs run`. |
| `scripts/pre-command.sh` | Versioned agent pre-command hook; install into a custom base image for job-wide verification (Phase 2+ wiring). |
| `../scripts/ci/verify-build-context.mjs` | The context verifier itself (identity checks, metadata emission), unit-tested in `../scripts/ci/verify-build-context.test.ts`. |
| `../scripts/ci/green-bridge-pins.mjs` | The pins policy: parsing plus the freshness gate behind `--pins`, unit-tested in the same test file. |
| `../scripts/ci/db-artifact-manifest.mjs` | YUK-918 selector-side manifest module: builds the schema-validated, SHA-256-covered DB selection manifest (absolute workspace paths, source HEAD/tree, shard assignments, expiry), unit-tested in `../scripts/ci/db-artifact-manifest.test.ts`. |
| `../scripts/ci/db-artifact-shard.mjs` | YUK-918 shard-side runner: downloads the manifest through `buildkite-agent`, fails closed on corruption/tamper, deterministically falls back to the full DB suite when the manifest is missing/stale/expired, and merges the selector digest into each shard's execution report; unit/CLI-tested in `../scripts/ci/db-artifact-shard.test.ts`. |
| `../.github/workflows/buildkite-shadow-subset.yml` | The imported workflow subset: only the `migration` and `build` jobs, verbatim from `ci-gate.yml`. |

## What the pipeline runs

1. `verify-build-context` (queue `linux-large`) — asserts `BUILDKITE_COMMIT`
   equals the checked-out `git rev-parse HEAD`, resolves the HEAD tree and the
   merge-base against the default branch (and the PR base branch on PR builds),
   compares `GITHUB_SHA` / `GITHUB_EVENT_BEFORE` when the environment provides
   them, runs the pins freshness gate, emits exactly one JSON record, and stores
   it as Buildkite metadata `green-bridge-context`. Any violation fails the step.
2. `github-actions-import` (queue `linux-large`) — imports
   `.github/workflows/buildkite-shadow-subset.yml` through the pinned
   `github-actions` plugin, mapping `ubuntu-latest` to `linux-large`, and only
   after the identity step passed. No deploy or production credentials are used.
3. `db-select` (queue `linux-large`, YUK-918) — after the identity step, runs
   `scripts/ci/db-affected.mjs select` against the merge-base with the default
   branch, seals the result into `.cache/ci/db-manifest.json` via
   `scripts/ci/db-artifact-manifest-cli.mjs build` (schema v1: source HEAD/tree,
   absolute workspace paths, selected files, round-robin shard assignments,
   created/expiry timestamps, SHA-256 content digest over every manifest
   byte), and uploads it with `buildkite-agent artifact upload`.
4. `db-shard` (queue `linux-large`, `parallelism: 2`, YUK-918) — downloads the
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

## Local validation

```bash
bash -n .buildkite/scripts/verify-build-context.sh .buildkite/scripts/pre-command.sh .buildkite/scripts/db-select-upload.sh .buildkite/scripts/db-shard-run.sh
bk pipeline validate --file .buildkite/pipeline.yml
pnpm vitest run --config vitest.unit.config.ts scripts/ci/verify-build-context.test.ts scripts/ci/db-artifact-manifest.test.ts scripts/ci/db-artifact-shard.test.ts
node scripts/ci/verify-build-context.mjs --pins
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
