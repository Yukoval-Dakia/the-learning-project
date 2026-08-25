# Buildkite Green Bridge runbook (YUK-916)

Operational runbook for the GitHub → Buildkite required-gate migration. The
versioned scaffold lives in [`.buildkite/`](../../.buildkite/); this file owns
the external state, the phase plan, and the rollback paths. Rollback is always
executed exactly as written here — never improvise a variant during an incident.

## Current vs desired external state

| Field | Current (verified 2026-08-25) | Desired at end of Phase 1 |
| --- | --- | --- |
| Pipeline name / slug | `the-learning-project-ci-shadow` (renamed from `bili-record`) | unchanged |
| Repository | `https://github.com/Yukoval-Dakia/the-learning-project.git` | unchanged |
| Bootstrap configuration | one step: `buildkite-agent pipeline upload .buildkite/pipeline.yml` on queue `linux-small` | unchanged |
| Versioned pipeline | `.buildkite/pipeline.yml` on branch `codex/yuk-916-ci-buildkite-shadow` | same, merged forward with the branch |
| Step queues | `linux-large` for the identity step and imported jobs | unchanged |
| `branch_configuration` | `codex/yuk-916-ci-buildkite-shadow` only | unchanged until Phase 4 cutover |
| PR auto-trigger | off (`build_pull_requests: false`) | stays off until Phase 4 |
| Imported GitHub jobs | `migration`, `build` (`.github/workflows/buildkite-shadow-subset.yml`) | unchanged until Phase 2 lane sign-off |
| Native steps | `verify-build-context`, `usability-lane` (YUK-917 Phase 2, manifest-gated 13/13) | `usability-lane` stays expected-red on the hosted image until the CI image is published |
| Runner image | hosted `linux-large` image (`agent_image_ref` null) | custom `.buildkite/ci-image` published to GHCR, digest recorded in `pins.env` |
| Importer plugin pin | immutable ref `github-actions#98159d5e696d06b70df490b9d7d9eabc32bc2b21` (release provenance `v0.13.0`, observed 2026-08-25) | unchanged; re-observe at least every 30 days |

The authoritative desired snapshot is [`.buildkite/pipeline-settings.json`](../../.buildkite/pipeline-settings.json).
Before every phase change, diff the live pipeline against it:

```bash
bk pipeline view the-learning-project-ci-shadow --json | jq 'del(.badge_url, .builds_url, .cluster_id, .cluster_url, .created_at, .id, .graphql_id, .scheduled_builds_count, .running_builds_count, .url, .web_url, .provider_settings.id)' > /tmp/live-pipeline.json
diff <(jq -S . /tmp/live-pipeline.json) <(jq -S 'del(."$comment")' .buildkite/pipeline-settings.json)
```

Any drift outside the phase plan is either a phase action (recorded below) or an
incident (roll back).

## Local external restore payload

The pre-Phase-0 external pipeline (name `bili-record`, direct
`github-actions#latest` import of `ci-gate.yml`) is preserved verbatim at:

- `/private/tmp/buildkite-green-bridge-20260825/external/pipeline-restore.json`

The Phase 0 ruleset artifacts (original, seal, and restore payloads for ruleset
`16494930`, with SHA-256 sums) live under
`/private/tmp/buildkite-green-bridge-20260825/phase0/`. The canary evidence lives
under `/private/tmp/buildkite-green-bridge-20260825/phase0-canary/` and the
fingerprints under `/private/tmp/buildkite-green-bridge-20260825/fingerprints/`.

## Exact rollback commands

### Rollback A — GitHub ruleset 16494930 (drop the required checks)

Restores the original three rules (deletion, non_fast_forward,
required_linear_history) and removes the Phase 0 `pull_request` +
`required_status_checks` rules:

```bash
gh api --method PUT repos/Yukoval-Dakia/the-learning-project/rulesets/16494930 \
  --input /private/tmp/buildkite-green-bridge-20260825/phase0/ruleset-16494930.restore.json
```

Verify the readback contains only the three original rules and `enforcement:
"active"`:

```bash
gh api repos/Yukoval-Dakia/the-learning-project/rulesets/16494930 | jq '.enforcement, [.rules[].type]'
```

### Rollback B — Buildkite pipeline (restore the pre-Phase-0 pipeline)

Restores the original `bili-record` pipeline definition from the restore
payload (direct `github-actions#latest` import, no branch restriction):

```bash
bk api --method PATCH /pipelines/the-learning-project-ci-shadow \
  --data "$(cat /private/tmp/buildkite-green-bridge-20260825/external/pipeline-restore.json)"
```

Verify the renamed endpoint and original inline importer were restored:

```bash
bk api /pipelines/bili-record | jq -e '
  .name == "bili-record" and
  .slug == "bili-record" and
  (.configuration | contains("github-actions#latest"))
'
```

### Rollback C — stop the shadow without restoring the importer

If only the versioned pipeline misbehaves (for example another Build #5-style
nonexistent-commit failure), pause at the source instead of editing the
pipeline: stop pushing/rebuilding the branch and set the external pipeline's
branch configuration to an unused branch via `bk pipeline update`, keeping the
restore payloads untouched for a full Rollback B afterwards.

## Phase plan — triggers and cancellation

| Phase | Trigger change | Cancellation change |
| --- | --- | --- |
| 1 (now) | Branch pushes to `codex/yuk-916-ci-buildkite-shadow` only; PR auto-trigger off | `cancel_running_branch_builds: false` |
| 2 | unchanged; DB lands as native selector/artifact/shards (no importer handoff) and runner/usability lands as a native manifest-gated step | enable `skip_queued_branch_builds: true` with filter `codex/yuk-916-ci-buildkite-shadow` once queue pressure appears |

Phase 2 runner sub-lane (YUK-917, in-repo only — nothing external mutated yet):

1. `.buildkite/ci-image/Dockerfile` pins the immutable Playwright `v1.62.1-noble`
   base digest (amd64 manifest, resolved 2026-08-25 via
   `docker buildx imagetools inspect`), installs Node 24.0.0 / pnpm 11.13.1 /
   Bun 1.3.14, and asserts `chrome --version` at build time.
2. `.github/workflows/buildkite-ci-image.yml` (lead-operated) builds + pushes it
   to `ghcr.io/<repo>/buildkite-ci` with only the ephemeral `GITHUB_TOKEN`
   (`packages: write`); the digest lands in a job summary + artifact. No deploy.
3. The lead records that digest in `.buildkite/pins.env`
   (`CI_IMAGE_STATE=image_digest_published`, `CI_IMAGE_DIGEST`,
   `CI_IMAGE_PUBLISHED_AT`) — while the state stays
   `image_digest_pending_publication` the pins gate rejects any claimed digest
   and every usability manifest reports `cutover_ready=false`, so required /
   cutover use is impossible by construction.
4. The `usability-lane` pipeline step runs the real 13-scenario suite behind a
   manifest gate (Chromium launch + 13/13 executed proven; exit 0 alone never
   passes). On the hosted image it fails closed with
   `chromium-launch-failed` — leave it red until the image + queue wiring land.
| 3 | unchanged; HEAD+tree+base+PR parity harness runs inside the verify step | `cancel_running_branch_builds: true` with filter `codex/yuk-916-ci-buildkite-shadow` to mirror the GitHub `concurrency` group |
| 4 | open the real PR; enable `build_pull_requests: true` (keep `skip_pull_request_builds_for_existing_commits: false`); after both required canaries pass, make the Buildkite check required and drop the GitHub required check from ruleset 16494930 (additive edit, not Rollback A) | keep Phase 3 cancellation |

Cancellation never applies to `main` builds: `cancel_running_branch_builds_filter`
stays scoped to the migration branch until Phase 4 review.

## Native DB lane (YUK-918 Phase 2)

The DB lane runs as native Buildkite steps (`db-select` → `db-shard` ×2 in
`.buildkite/pipeline.yml`), not through the `github-actions` importer: the
importer's `upload-artifact`/`download-artifact` mapping cannot transfer files
produced by native steps (Build #1 observed `.cache/ci/db-selection.json`
being invisible to it), so the lane hands off through Buildkite's own
artifacts instead.

Flow: `db-select` runs `scripts/ci/db-affected.mjs select` once, seals the
selection into `.cache/ci/db-manifest.json` (schema v1: source HEAD/tree,
absolute workspace paths, selected files, round-robin shard assignments,
created/expiry timestamps, and a SHA-256 digest over every manifest byte
except the digest itself), and uploads it via `buildkite-agent artifact
upload`. Each `db-shard` job downloads it via `buildkite-agent artifact
download --step db-select` and re-verifies schema, digest, freshness
(`BUILDKITE_COMMIT` match + 24h expiry), and shard-count before running
`scripts/ci/db-affected.mjs run`.

Acceptance semantics (executable in
`scripts/ci/db-artifact-manifest.test.ts` / `db-artifact-shard.test.ts`):

- >=2 selected files — both shards execute and report the identical selector
  digest (`selector.status: "verified"`).
- exactly 1 selected file — shard 1 executes; shard 2 records the same digest
  plus `skipped_empty_shard: true`.
- corrupt/tampered manifest (digest mismatch, schema violation, unparseable
  bytes) — the shard fails closed without running tests; never an empty green.
- missing/stale/expired manifest — deterministic fallback to the full sharded
  DB suite (a real non-empty suite), recorded as `selector.status: "fallback"`
  with the reason.

A runner/manifest skip disagreement (`skip-consistency-drift`) also fails the
shard. Rollback for this lane is a repo change: remove the two `db-*` steps
from `.buildkite/pipeline.yml` (and optionally the two scripts) — no external
pipeline state is involved. DB shards need Docker on the `linux-large` image
for testcontainers Postgres, same requirement as the GitHub `db` job.

## Bridge invariants

- No deploy or production credentials are referenced by any scaffold file; the
  `build` job keeps the placeholder `DATABASE_URL` it uses on GitHub today.
- The GitHub `CI Gate` workflow remains the required gate and the source of
  truth until Phase 4; the shadow never blocks a merge by itself.
- Every phase change records the exact SHAs, check/build URLs, API readbacks,
  and rollback receipts on YUK-916 before the next phase starts.
- Pins in `.buildkite/pins.env` must be re-observed within `PIN_MAX_AGE_DAYS`
  (30) — the `verify-build-context` step enforces this on every build.
