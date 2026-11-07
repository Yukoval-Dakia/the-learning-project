# YUK-814 real-owner grounding gate

This runbook prepares and scores the **real-data** shadow/blind/canary gate. It
does not enable product behavior, write proposals, or treat synthetic fixtures
as acceptance evidence.

## Owner issue-closeout override (2026-08-01)

The owner explicitly accepted the agent-run complex mock gate as sufficient to
close YUK-814. On clean `main@931b1742`, the scoped mock suite passed 41/41 tests
across the artifact scorer, six-case intervention regression evaluator, and the
shared intervention author/validator. The regression packet is 101,764 bytes / 1,137
lines, spans math, Chinese and general reasoning, and contains three expected
rejects plus three expected-pass controls. Its SHA-256 is
`85af0488411ae2099f1a804a16a999444ce7bc11eadd09c6debae6a188106530`.

This is a narrow **issue-status waiver**. It supersedes the older real-ten-run
requirement only for closing YUK-814; it does not erase the historical failed
canary, make `satisfies_yuk_814_canary` true, authorize a production flag flip,
or prove real-lifecycle quality. The real-data procedure below remains the
historical stronger-rehearsal path; it no longer gates YUK-814 status. Any
future unattended expansion requires a separate owner authorization and the
then-current actual-product-output release evidence.

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
- `OPENCODE_API_KEY` for semantic claim grouping when exact strings do not already
  agree.

The harness checks only presence and never prints values.
It refuses non-empty `AI_PROVIDER_OVERRIDE` or `AI_PROVIDER_MODEL` so the three
induction samples cannot inherit a global model/provider switch and semantic
claim grouping cannot leave its resolved task lane.

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
specified. Under the 2026-08-01 owner override, the real-backup blind score and
ten-run canary are optional stronger rehearsal evidence and no longer gate
YUK-814 status. They also do not independently authorize a future production
expansion; that requires a fresh owner decision and then-current release
evidence.
