# Buildkite Green Bridge — versioned shadow scaffold (YUK-916 Phase 1)

This directory is the in-repo, versioned half of the Buildkite Green Bridge
(YUK-916). The external pipeline `the-learning-project-ci-shadow` bootstraps
from here: its only built-in step uploads `.buildkite/pipeline.yml`, and every
real job then comes from this directory plus the imported GitHub workflow
subset. The operational phase plan, current/desired external state, restore
payload location, and rollback commands live in
[`docs/runbooks/buildkite-green-bridge.md`](../docs/runbooks/buildkite-green-bridge.md).

## Layout

| File | Role |
| --- | --- |
| `pipeline.yml` | The uploaded shadow pipeline: checkout identity step + pinned `github-actions` importer for the proven-compatible job subset. |
| `pins.env` | Importer plugin pin (source, release, commit, observed date) and runtime pins, enforced by the freshness gate. |
| `pipeline-settings.json` | Desired external pipeline settings snapshot; diffed against the live pipeline before phase changes. |
| `scripts/verify-build-context.sh` | Step entry point for the checkout identity verification. |
| `scripts/pre-command.sh` | Versioned agent pre-command hook; install into a custom base image for job-wide verification (Phase 2+ wiring). |
| `../scripts/ci/verify-build-context.mjs` | The context verifier itself (identity checks, metadata emission), unit-tested in `../scripts/ci/verify-build-context.test.ts`. |
| `../scripts/ci/green-bridge-pins.mjs` | The pins policy: parsing plus the freshness gate behind `--pins`, unit-tested in the same test file. |
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
bash -n .buildkite/scripts/verify-build-context.sh .buildkite/scripts/pre-command.sh
bk pipeline validate --file .buildkite/pipeline.yml
pnpm vitest run --config vitest.unit.config.ts scripts/ci/verify-build-context.test.ts
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
