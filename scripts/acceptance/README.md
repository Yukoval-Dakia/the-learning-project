# YUK-1388 delivery acceptance

Run these probes at the end of each delivery stage against **TEST**, then review actual product outcomes next to the sealed 2026-10-10 audit baselines. This is delivery acceptance, not a Vitest suite. It creates no alternate supply, grading, memory, or judge system. Unit tests retained under YUK-1401 still protect irreversible invariants; they do not establish that a delivery stage works.

The source set is `tlp-audit-artifacts/yuk1388/stage4`: R03 gold and scoring, R02 day-one observations, R03/R03b Copilot and crisis probes, R01 census, I02/waves-v1.md exits, and R03/mem0-cleanup/cleanup-record.md. Those artifacts remain read-only. `baselines.json` records each source and denominator. Never overwrite baselines with the newest run.

## Offline preparation (no provider calls)

From the checkout, with Node 24 and `pnpm install --frozen-lockfile`:

```sh
node scripts/acceptance/run.mjs dry-run --out /tmp/acceptance-dry-run-UNIQUE
node scripts/acceptance/run.mjs census --out /tmp/acceptance-census-plan-UNIQUE
for file in scripts/acceptance/*.mjs; do node --check "$file"; done
```

Every command defaults to dry-run. Only `--live` opens a connection or sends requests. Each output directory must be new; an existing directory is rejected to preserve unknown paid outcomes. Do not commit tokens, database URLs, result bodies or crisis transcripts. Default `results/` and `config.local.json` are ignored. Store evidence in the coordinator's protected artifact directory.

## Live TEST preflight and execution (separately approved)

Use a **dedicated synthetic TEST deployment** bound to a new `acceptance_*` database and isolated blob storage. Current APIs have one learner, Mem0 hardcodes `self`, and briefs use shared scopes: an arbitrary user header or a fresh browser/session does not isolate an identity. The operator seals app/worker image IDs, exact deployed revision, URL, DB endpoint/name, blob target and absence of real data in a binding receipt. Configure `deployment.binding_evidence` to its path. The binding JSON contains environment=TEST, dedicated_synthetic=true, production=false, database, base_url, revision, image_id, isolated_blob_storage=true, blob_namespace, observer_address (SQL inet_server_addr) and observer_port. The runner verifies these against config and the observer. This receipt must be checked against the actual deployment before running; the CLI cannot independently prove that an API origin and a SQL endpoint belong together.

Copy `config.example.json` to an ignored/private location, fill the deployment witness (under one hour old), and record the separately authorized paid batch. Export `ACCEPTANCE_INTERNAL_TOKEN` and `ACCEPTANCE_DATABASE_URL` through your normal secret mechanism. These environment variables are used only by this CLI; no provider keys are loaded or sent to the browser. The observer must have READ ONLY access for ordinary probes. Cleanup uses a separate operator connection with delete permission on the disposable database.

Deployment setup, seed changes, stopping writers and cleanup are outside normal API use: acquire the existing **mkdir mutex** at `/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU/deployment-20261007/deployment.lock`, write `owner.json` with a unique `token`, and release only your own token. Never steal or remove another owner's lock. Normal API requests require no deployment lock. The suite does not create databases, seed curriculum, wipe used TEST, restart containers, change budgets, or alter product code.

```sh
node scripts/acceptance/run.mjs day-one --live --config /private/day-one.json --out /private/results/day-one-normal
node scripts/acceptance/run.mjs photo --live --config /private/photo.json --out /private/results/photo
node scripts/acceptance/run.mjs copilot --live --config /private/photo.json --out /private/results/copilot
node scripts/acceptance/run.mjs crisis --live --config /private/crisis.json --out /private/results/crisis
node scripts/acceptance/run.mjs census --live --config /private/photo.json --out /private/results/census
```

Day-one and crisis require **different empty learner databases**. Their read-only preflight requires zero goals, questions, events, sessions, learning items, artifacts, memories and briefs. Seeded curriculum taxonomy may exist; seal its exact rows and seed revision. An empty knowledge tree may honestly fail placement; never warm it by importing photo questions before day-one. Run day-one twice on fresh databases: normal generation, then `journey.variant="generation_unavailable"` with an operator-sealed existing TEST configuration that makes generation unavailable. The suite does not inject faults or fabricate fallback content. Label both receipts and compare the same limits.

Each request is journaled before sending, including original body, timestamp and input digest (multipart fixture digests are in upload receipts). Responses have status, elapsed wall time, raw-response digest and body. Unknown mutation outcomes are never retried automatically. An API error or schema drift is evidence, not zero or success. A submitted answer that returns pending/held is not an automatic grade. No self-rating, forced approval, or private helper call makes it pass.

`max_requests` counts HTTP requests, **not** model calls. Worker fanout, tool loops, provider retries and background memory jobs can exceed it. `cap_usd` is an operator-approved planning cap, not a proven hard limit enforced by the CLI. Watch the provider ledger and existing task budgets; stop new probes through normal cancellation before consuming the reserve. Unknown receipt cost is not free. Do not repeatedly rerun a failed paid case to get green.

## Photo gold (14 pages, 21 questions)

`gold/` commits synthetic HTML/KaTeX sources, canonical PNGs, the degraded M06 scan, formulas, answers, KC labels and SHA-256 manifests. HTML references this checkout's installed KaTeX; PNG bytes are the audit originals. M06 uses the degraded JPEG, as the audit did. Three batches (5/5/4 pages) preserve the cross-page figure-contamination probe.

The runner uses product asset upload → ingestion session → extract operation → blocks → question detail → issuance → solve session → original gold response submission. It imports only unchanged extracted fields if the product supplies knowledge IDs; missing fields stay missing. Gold answers/KCs are never supplied to extraction or import. Auto-enrolled questions are observed without forced promotion. Withheld items and missing questions remain failures to serve; admission is never relaxed.

`photo.json`, `photo.md` and `photo-pages.md` show per-question/page and aggregate count, normalized stem character accuracy, type, choices, answer, required own-page figure without foreign attachment, KC labels, issued count and actual effective grading. Matching uses source page and highest stem similarity >=0.5; review uncertain mappings and every extra/missing block. Character normalization follows R03's plain-math projection and is not formula equivalence. Exact answer/KC comparisons are conservative lexical scores: human reviewers annotate equivalent answers and reasonable tags separately, preserving both raw scores and rubric decisions. Unsupported multipart response mappings require a reviewer; the runner refuses to guess.

The served-and-gradable denominator is **actually issued items**, with the 21-question availability count alongside it. Baseline 1/8 came from R01 admitted groups, so it is labeled as a different population. A zero denominator cannot pass 100%. Confirm full-correct gold responses received correct scores, not merely an effective result. Check rendered KaTeX, actual figure bytes, readable material and KC meaning in the real TEST UI; API attachments alone do not establish that the learner can see them.

## 「第一天能用」 day-one exit

The runner follows goal → learning path/confirmation → placement → first automatic grade → help → material using current product APIs. The topic is preregistered in config. It measures from goal submission and retains each action/request. It answers without reading the private answer key; learning efficacy is not inferred from this scripted response.

| Exit | Maximum |
| --- | --- |
| Goal submission → first item subsequently proven automatically gradable | 60 seconds |
| Answer submission → effective grade returned | 10 seconds |
| Help action → help or frozen-reference fallback | 20 seconds |
| Goal submission → material content delivered | 180 seconds |
| Total product waiting | 300 seconds |
| Entire journey, including scripted actions | 900 seconds |

**100% of served items must automatically grade, with zero held human review.** This owner ruling supersedes I02's older <=20% self-rating friction suggestion. Check all served item receipts, not just an admission flag. New imported AI KCs must stay proposed/pending; the goal must not become a KC. `kc_guard` preserves new rows and flags auto-approval; human review decides semantic Goal/KC classification.

The five friction measures are actions to the first gradable item (<=8, excluding answer typing), self-rating share (0% under the ruling), photo/file fields requiring transcription (0), help requests without usable output (0), and waits >60 seconds without visible progress/alternative (0). API action count is a proxy; automatic polls are not silently discounted. Browser-only fields remain **UNMEASURED**, including clicks, transcription and visible progress. Complete the sheet below using a real user journey with screenshots/network evidence. The day-one API runner's material timing measures content availability; a reviewer must verify rendered readability at that recorded instant. A JSON blob or nonempty placeholder does not close the gate. List/read schemas can drift: preserve the failure and adapt only to the current product contract, never claim old material is a new delivery.

```json
{
  "run_id": "sealed-run-id",
  "reviewer": "name",
  "browser_evidence": ["screenshots/network manifest"],
  "first_readable_material_ms": null,
  "actions_to_first_item": null,
  "photo_transcription_fields": null,
  "wait_without_visible_progress": null,
  "all_served_items_auto_graded": null,
  "goal_is_not_kc": null,
  "new_import_kcs_pending": null
}
```

Unmeasured, no delivery, over limit or unresolved human review prevents a W0 exit. Deterministic fallback must meet the same limits on the generation-unavailable rerun. Do not change preregistered thresholds after seeing results.

## Copilot and crisis review

`copilot.json` contains the original 12 tasks and 6 crisis prompts. Conversation groups and ordering preserve R03/R03b multi-turn followups (B03 before B02). B01 refers to an audit misgraded S5=11 record: on a new dataset, document whether an equivalent synthetic record exists. A claim of a nonexistent record tests honesty; it is not a like-for-like personal-history comparison. The imported gold alone does not recreate every audit learner-state fixture.

The runner creates dedicated sessions, sends stable idempotency keys, saves replies/tool evidence and requests cancellation above 20 tool rounds (4 for crisis) or 180 seconds. This is a polling guard, not a server-enforced per-call ceiling; cancellation may arrive after another tool round. It stops the set after a turn fails or cancellation is requested, so no followup is queued behind an unsettled turn. Unrun tasks remain listed.

`rubric.json` and each output `scoring-sheet.json` use the audit six-dimensional 0–3 scale: correctness, grounding, actionability, tool behavior, latency/progress and failure honesty. Fill them by human review or a separately approved LLM judge with sealed provider/model/revision, input/output digests, run IDs, evidence and cost. Preserve reviewer identity and rationale for every score. Compare each task and dimension to its `audit_scores`; do not automate wording checks or claim reply delivery is semantic success. Crisis support requires qualified human adjudication, including C3's mixed signal and C5's joke/context. The rubric encodes no medical advice or keyword PASS rule.

## Mandatory crisis cleanup

The crisis deployment starts empty and is used **only for this crisis run**. Keep `sessions.json` and `cleanup-required.json`, even after failure. Stop app and worker writers under the deployment mutex using the existing operator process. Drain durable obligations through their existing recovery owner; do not delete queue jobs to silence late effects. Seal a stopped-writers JSON receipt with `database`, `writers_stopped:true`, `running_writers:0`, `operator`, `observed_at`, and `lock_token`; use `owner.json` fields `token` and `database` for this isolated cleanup handoff. Configure `cleanup.receipt_path` and `writers_stopped:true`.

```sh
node scripts/acceptance/run.mjs cleanup --config /private/crisis.json --run /private/results/crisis --out /private/results/cleanup-plan
node scripts/acceptance/run.mjs cleanup --live --config /private/crisis.json --run /private/results/crisis --out /private/results/cleanup
```

Cleanup acquires an absent mkdir lock, or verifies the exact operator-held token and leaves that lock to its owner. It refuses foreign sessions or unsettled memory/Copilot jobs. Full memories (including vectors), sessions, events and briefs are backed up before one transaction deletes the dedicated identity's rows with exact-count checks, then verifies zero residual. Deleting all derived memories in this crisis-only DB catches the late C3/C4 facts that text/hash matching missed in the audit. Its global brief is deleted rather than regenerated because this disposable identity has no non-crisis history. On a shared TEST identity the audit had to regenerate; **this helper refuses that target**.

Keep writers stopped and the deployment isolated after cleanup; seal another zero-residual read before any reuse. Do not restart the disposable crisis worker to replay retained history. As in the cleanup record, reconciliation audit rows, completed queue tasks and job_events remain. Provider logs, Mem0 history if any, traces, backups and the sealed crisis evidence remain outside this deletion claim. Cleanup success must be linked into the original run's review record; the source run remains immutable. There is no automatic cleanup claim when the runner fails before operator cleanup.

## Census, stage status and learning boundaries

`census/current.sql` runs R01-style read-only queries with a 15-second timeout. `audit-queries.sql` preserves the full historical query log, including old timestamps and failed schema assumptions; it is provenance, not a file to blindly replay. `tracker.md` is the original ten-flow tracking table. Fill a fresh copy with learner-visible state, same-identity restoration, timeout/failure, business delivery, recovery owner and observed wall time. Missing tables yield `SCHEMA_UNAVAILABLE`, never an empty census or a PASS. No paid producer is started by census. Copilot run state comes from job_events, not a nonexistent copilot_run table.

Every run writes JSON plus a short current-vs-baseline Markdown table. API digests and final artifacts are distinct from provider model-output digests. `provider-ledger.json` seals task IDs, provider/model, input_hash/result_digest, known/unknown cost and provider attempts; null remains null. Observe the natural background tail in a later census and link it to the run. R01 had 78/78 null result digests; this suite does not invent them. Model-level sealing gaps prevent claiming complete provider evidence.

To update `stage4/final/four-lists.jsonl`, the **coordinator** matches the relevant immutable root IDs and tickets, retains original audit status/evidence, and records new run path, deployed revision, metric denominator, raw digests, independent observer, human adjudication and cleanup receipt. Review confirmed defects, design decisions, unresolved observations and parked work separately. A mechanism outcome may change `delivery_state` for the demonstrated slice; it does not rewrite the historical defect or move a whole root to PASS. Existing field names and root IDs are the authority. Proposed updates should be a reviewed diff in a new evidence file before the coordinator applies them. These runners never mutate the source four lists, Linear state or PLAN.md.

Stages W1–W4 still require their own I02 exit criteria and the eight pre-AI load-bearing regressions (FSRS/selection, mastery/calibration, immutable questions/judgments, deterministic OCR, proposal confirmation/revert, shortlist/today fallback, logs/cost/export/backup, cron semantics/timezone). This reusable set supplies comparative evidence; it cannot pronounce an entire stage complete by itself. Source correctness, scoped invariant checks, exact-head CI, runtime mechanism, real provider quality, deployment and learning outcomes stay separate claims.

Never automate a claim that someone learned, retained, transferred, became less dependent, experienced lower net burden or benefited from an intervention. Synthetic probes cannot replace preregistered real use, delayed independent 24h/7d/30d results or the W3/W4 sample gates. Those stay UNKNOWN/PARKED until qualified real evidence exists.

## Cost estimate per full run

For 14-page import, two day-one variants, 12 Copilot tasks, 6 crisis prompts, tail census and cleanup, reserve **USD 2–4**, with a suggested separately authorized ceiling of **USD 6**. This is an operational estimate from the audit's MiMo Token Plan windows, not a current tariff or hard spending guarantee. R03 recorded USD 0.151708 plus about USD 0.18 unrecorded runaway cost, 207 estimated generative calls and OCR CNY 0.001916 for 14 pages. R01 recorded USD 0.185755, one unknown task and 50 opaque attempts, and reserved USD 1.50 for unknown/tail costs. R02 had 16 unknown-cost failed tasks, so a zero known total is not a free run.

Expect roughly 150–300 generative calls including natural memory/note fanout, plus 14 OCR requests and unpriced embedding/search operations; changed models, retries or tool loops can exceed this range. Do not convert CNY to USD without an explicit exchange-rate basis. Optional LLM judging is a separate batch/cost estimate; human review makes no provider call. Start only after approval covers real calls, unknown receipts and tail reserve. This PR was validated offline and made no product/provider calls.
