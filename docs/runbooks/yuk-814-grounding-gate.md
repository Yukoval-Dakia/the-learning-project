# YUK-814 real-owner grounding gate

This runbook prepares and scores the **real-data** shadow/blind/canary gate. It
does not enable product behavior, write proposals, or treat synthetic fixtures
as acceptance evidence.

## Safety contract

- Keep the backup and all generated artifacts under `.tmp/yuk-814/` (gitignored).
- Run with `umask 077`; never attach raw data or `private/lineage.json` to Linear
  or a PR.
- `inspect` and `shadow` restore into a new pgvector Testcontainer and remove it
  in `finally`. They never connect to `DATABASE_URL`.
- The shadow model writes task/cost provenance only into that disposable DB.
  It does **not** call the nightly writer and cannot create product
  proposal/event/rate/projection state.
- The blind reviewer must finish `blind/review.json` before seeing
  `private/lineage.json`.

## Reviewer actual-output regression (development evidence only)

When changing the intervention validator or `InterventionPackageReviewTask`, run
the production Xiaomi/Mimo route against a sanitized regression packet after
committing the exact code revision:

```bash
umask 077
pnpm grounding:gate review-intervention \
  --cases src/server/grounding-gate/fixtures/intervention-review-regressions.v1.json \
  --out .tmp/yuk-829/reviewer-regression-result.json \
  --env-file /absolute/path/to/private.env
```

The input packet has `schema_version: 1`,
`source_kind: "sanitized_regression_fixture"`, and one or more cases containing
`case_id`, `subject_id`, canonical `context`, canonical `package`,
`expected_verdict`, and `expected_failure_codes`. The checked-in packet contains
three expected-fail regressions plus two expected-pass controls, so an
always-rejecting comparator cannot pass the gate. The harness refuses a dirty
worktree, global provider overrides, an absent Xiaomi credential, or an existing
output path. It runs in a disposable pgvector Testcontainer. For every package
it runs three strict `SolutionGenerateTask` blind solves followed by the sealed
package comparator. A paid solver response that cannot satisfy the complete
output contract may retry the identical blind input once; heuristic JSON repair
is forbidden, deterministic repair is recorded, and every attempted task-run ID
remains in the audit. `expected_signals` is a bounded 1..12 atomized necessary
path; every operation is sealed by index + digest, and the comparator must return
one reference-coverage and frozen-scope decision for every operation. A package
cannot pass from one diagnostic-level self-certified boolean. DiagnosticSpec V2
also freezes `causal_direction_required`; historical V1 is read-compatible but
conservatively requires the causal check, and explicit causal language is a
defense-in-depth positive backstop. The comparator likewise retries the exact sealed input once
only after a persisted response fails the complete output contract; a valid
semantic fail is never retried. Activation re-runs deterministic checks and binds
every solver/comparator attempt to successful `ai_task_runs` rows, exact input
hashes, the current profile-rendered prompt fingerprint, and the selected
canonical result digest. Persisted crash-recovery attempts are rebound before
activation rather than trusted as checkpoints. The harness records exact blind
inputs/structured solutions and their digests, FULL diagnostic/package checks,
provider/model, usage, and exactly one finite non-negative USD success-cost row.
The actual-output harness additionally requires every audit ID to have been
observed through the current case's runner seam with the expected subject-rendered
prompt; matching replay rows cannot make a case green. A per-case operational
failure retains all task-run IDs observed before the failure (including
lifecycle timeout/adapter exception 统一绑定的 `AgentRunError.taskRunId`)
instead of discarding paid evidence. Comparator runner failure returns a closed
invalid attempt with that ID, so the enclosing package slot is durably consumed
instead of being reset by pg-boss redelivery.

The structural ceiling is eight validator calls per package (three diagnostics ×
two blind-solve attempts, plus two comparator attempts). A two-package preparation
delivery including recommendation and authoring is therefore capped at 19 task
calls; one five-case regression command is capped at 40. These are retry ceilings,
not expected steady-state spend. A durable cross-delivery aggregate budget and
per-stage checkpoint are not implemented by this change and must not be inferred
from a green fixture run.

This command verifies real model output rather than a mocked verdict, but its
artifact always records `satisfies_yuk_814_canary=false`. Sanitized regression
fixtures cannot replace the fresh prospective ten-run real lifecycle canary.

## 1. Export production data

Use the authenticated backup endpoint:

```bash
umask 077
mkdir -p .tmp/yuk-814
: "${INTERNAL_TOKEN:?INTERNAL_TOKEN is required}"
: "${LOOM_BASE_URL:?LOOM_BASE_URL is required}"
: "${LOOM_EXPECTED_HOST:?copy the exact production hostname from the Cloudflare Tunnel}"
case "${LOOM_BASE_URL%/}" in
  "https://${LOOM_EXPECTED_HOST}") ;;
  *) echo "LOOM_BASE_URL must be the pinned HTTPS production origin" >&2; exit 2 ;;
esac
curl --proto '=https' --tlsv1.2 -fsS \
  -H "x-internal-token: ${INTERNAL_TOKEN}" \
  "${LOOM_BASE_URL%/}/api/_/export?include_assets=1" \
  -o .tmp/yuk-814/loom-backup.zip
```

Set `LOOM_EXPECTED_HOST` independently from the Cloudflare Tunnel's production
Public Hostname (hostname only, no scheme or path). The guard refuses missing
credentials, plaintext HTTP, alternate hosts, ports, paths, or userinfo before
`curl` can send the token.

`include_assets=1` is the fidelity-preserving default. A text-only export
(`include_assets=0`) remains usable only when enough eligible clusters have no
image evidence; the harness fails closed and excludes image-bearing clusters
whose bytes are absent.

## 2. Inspect eligibility without model spend

```bash
pnpm grounding:gate inspect \
  --backup .tmp/yuk-814/loom-backup.zip \
  --sample-size 8
```

The 14-day window is anchored to `manifest.exported_at`, so rerunning the same
backup is deterministic. The reader reuses production correction folding,
cause×KC recurrence, pending/lifecycle gates, accountability ranking, immutable
evidence enrichment, and image limits. It additionally excludes
`payload.__synthetic=true` and `synthetic:*` evidence.

Read `private/eligibility.json`:

- `ready_for_shadow=true` requires at least the requested 6–10 fully
  reproducible, image-ready clusters.
- Eligibility is preparation evidence only; `gate_passed` remains false.
- When image-bearing clusters were excluded from a text-only archive, re-export
  with `include_assets=1`.

## 3. Run shadow induction

Shadow induction needs both production task lanes:

- `CLAUDE_CODE_OAUTH_TOKEN` for the three Opus induction samples;
- `XIAOMI_API_KEY` for semantic claim grouping when exact strings do not already
  agree.

The harness checks only presence and never prints values.
It refuses non-empty `AI_PROVIDER_OVERRIDE` or `AI_PROVIDER_MODEL` so the three
induction samples cannot inherit a global model/provider switch and semantic
claim grouping cannot leave its Mimo lane.

```bash
pnpm grounding:gate shadow \
  --backup .tmp/yuk-814/loom-backup.zip \
  --sample-size 8 \
  --env-file /absolute/path/to/private.env
```

Selection is a deterministic SHA-256 ordering seeded by the backup hash, rather
than an operator-picked subset. Output is split:

- `blind/review.json` + `blind/images/`: evidence and anonymous shadow outputs;
- `private/lineage.json`: real cluster/event/question/asset/task-run lineage,
  cost and internal calibration;
- `private/eligibility.json`: source and eligibility audit.

## 4. Owner blind review and score

For every item in `blind/review.json`, replace all four `null` labels:

- `grounded_proposal`: true only when claim, both probes and references are
  evidence-supported and usable. An abstention is false.
- `discipline_hallucination`
- `claim_probe_mismatch`
- `severe_factual_error`

Then score:

```bash
pnpm grounding:gate score-blind \
  --review .tmp/yuk-814/<gate>/blind/review.json
```

Exit codes: `0=pass`, `1=fail`, `2=incomplete`. Pass requires:

- 6–10 reviewed clusters;
- the original requested count and sealed selection digest still match (removing
  or editing a selected item fails closed);
- grounded proposals / all clusters ≥ 80%;
- all three redline counts = 0.

Any incomplete/failing score keeps expansion disabled.

## 5. Canary record (only after blind PASS)

```bash
pnpm grounding:gate init-canary \
  --blind-score .tmp/yuk-814/<gate>/blind/score.json
```

Template creation is blocked unless the blind score is PASS. Fill one
`owner_cohort_ref`, ten distinct real `intervention_ref` values, all ten
post-reviews, monitoring snapshot refs, and the stop-switch rehearsal evidence;
then run:

```bash
pnpm grounding:gate score-canary \
  --review .tmp/yuk-814/<gate>/blind/canary-review.json
```

Canary PASS requires exactly ten post-reviewed runs, complete monitoring refs,
a recorded stop-switch rehearsal that prevents new scheduling while retaining
existing audit records, and zero redlines. A redline sets
`auto_intervention_should_be_disabled=true` and fails closed.

## Evidence boundary

Unit/DB fixtures prove only that the harness selects, blinds and scores as
specified. YUK-814 remains open until the real backup produces a completed
blind score, then a completed ten-run canary score.
