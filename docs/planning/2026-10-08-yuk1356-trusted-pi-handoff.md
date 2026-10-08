# YUK-1356 trusted Pi review-answer consumer handoff

This is the implementation artifact for the parent to inspect and accept. It does not mark YUK-1356 or the non-UI migration complete. The writer stayed in `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk1356-review-operation`, branch `feat/yuk-1356-review-operation`. No DB/container/runtime/provider/paid call, replay job, deployment, push, PR, watch, Linear action, independent review or child delegation was performed.

## Preserved work and main integration

The starting HEAD was `2f45f62cb5941b284046f4207fcab15212c35bf1`, with exactly 26 modified/untracked paths. Before editing, every path was archived in `docs/planning/evidence/yuk1356-resume-20261008/initial-files.tar.gz`, with the complete binary HEAD diff, initial status and per-file SHA256 manifest alongside it. Existing ignored task caches remain untouched. The archive contains the original bytes, including the five untracked task files. `6c96ea236` committed that WIP and its archive. Nothing was reset, stashed or dropped.

`78a046bb3` normally merged fetched main `caeb959fd726e34b2e8554bd0e95b54778cbff41`. Main won conflicts in PLAN/.remember, the lockfile and PR1602 due-query tests/adapter. The Practice port kept the trusted binding exports and main's removal of obsolete learning-content exports. A subsequent integration fix removed duplicate public due-query exports. The typed due query remains main's implementation. PR1592 Start, PR1603 summary, PR1595 DBOS prune, immediate prose SSE/YUK1365 and frozen probe/YUK1364 remain inherited. No assessment scoring truth writer, solve owner, queue recovery owner or UI was rewritten. `startReviewSession` and `queryReviewDue` remain their existing operations.

## Actual input trust boundary and live code path

The Hono `/api/copilot/chat` internal-token gate authenticates the request. Its strict optional `review_answer` attachment requires `authorize_submission:true`, the served issuance/evaluation-group/retry identity and the user's original response/evidence. It is allowed only on ordinary chat, without a skill or correction target. Prose is never authorization. Neither the attachment nor the tool accepts actor, independence, self-report or replacement-answer flags.

The acceptance transaction calls `writeCopilotInputEvent` → `captureReviewAnswerBinding` → `prepareFormalAttemptSubmission` → the existing `saveSubmission`. It checks standalone question/issuance/revision membership and an optional started review session. Other occurrence-bound entries, including probe, ingestion, paper and placement, keep their own adapters. The evaluation-group lock and original writer retain immutable bytes, draft cleanup and idempotency conflicts. A separate turn/session cannot reuse the same original retry identity as fresh authority.

New chat originals receive a server-classified `chat_context/unknown` assistance exposure before the original's snapshot. Existing accepted originals retain their prior snapshot. This conservatively excludes newly attached chat originals from independent mastery/FSRS evidence. An original previously accepted at `/api/submissions` can retain its independently recorded provenance; Pi cannot change that snapshot. `recordFormalAttemptCapture` still records the real user original with the existing user/self semantics, while Pi `tool_use` events and logs retain agent identity. No model output becomes an independent learner response.

The ask stores coordinates, permission, an original digest and a server-clock expiry, without copying response_set/group_evidence. The QUEUED marker seals the full binding digest. Authorization lasts 30 minutes from capture; waiting does not extend it. Missing expiry or accepted-run evidence fails closed.

The production execution owner calls `resolveCopilotReviewAnswer` using its actual session/source event, replacing any supplied run-input reference. The resolver requires a user/self accepted ask in that session. It passes only `{original_ref}` to the model and a server-owned submit closure to the real domain Pi mount. Practice's manifest loads `submit_review_answer`, the Copilot allowlist grants it, and `buildPiDomainAgentTools` → `AgentTool.execute` → `executeDomainToolCall` executes that closure. The input schema accepts only the current original_ref. The closure reconstructs the original from immutable `assessment_submission`, verifies frozen coordinates and digest, then calls the shared `submitReviewAnswer` operation. Tool output is only a pending/committed receipt, not pinned grading context.

Every capability check holds the existing Copilot settlement and correction locks, checks the accepted ask/QUEUED digests, correction state, conversation/review state, cancellation/terminal events, server-clock expiry and combined run/Pi abort signal. Synchronous activation rechecks with the already-existing `beforeActivate` hook after grading. Durable admission holds those locks through existing dispatch, without a model call under the locks. After an accepted durable intent exists, its worker retains ownership and may finish after the chat settles or expires. Stop/retraction denies further consumption; it does not delete accepted originals or replay an unknown operation. An incomplete grading result can retain the existing review-required original/candidate receipt without applying learning effects.

The submission tool and acceptance attachment are materializing, so the existing checkpoint/revert machinery cannot falsely offer compensable retraction. Repeated calls while the same authority is active use the existing original/pending/final identities. A settled, cancelled, expired or retracted authority cannot be consumed again. Reposting the identical chat request may recover its existing 202 receipt; it never renews authorization or starts fresh work.

## Permitted local evidence

Node `24.19.0` is selected by adding `/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin` to PATH. The adjacent `2026-10-08-yuk1356-trusted-pi.evidence.json` records exact commands, exit codes, SHA256 values and a source-tree digest. Logs are also preserved in the bounded evidence directory. Unit tests exercise the real Pi bridge with substituted server receipts/logging, plus execution input replacement, cold/resume context and capability inventory. This is consumer-contract evidence, not business-table or real-model acceptance. Typecheck includes both application and Start server configuration; build includes Vite, Start and app/worker/migrate bundles.

Postman and the generated API schema are updated. The earlier `2026-10-07-yuk1356-review-operation.api-client.patch` remains archived provenance; current generated output is in `src/ui/lib/api-schema.generated.ts`.

## Exact parent DB commands

These commands are prepared, not executed by this writer. The parent must coordinate the disposable testcontainer and ports, retain Node 24.19 and run from this worktree. Do not use production data or full `pnpm test`.

```bash
cd /Volumes/YukovalSBak/yukoval-projects/tlp-yuk1356-review-operation
export PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH
pnpm vitest run --config vitest.db.config.ts \
  src/capabilities/copilot/api/review-answer.db.test.ts \
  src/capabilities/practice/server/review-operation.db.test.ts \
  src/capabilities/practice/api/submit-durable.db.test.ts \
  src/capabilities/practice/api/submit-native-diagnostic.db.test.ts \
  src/capabilities/practice/api/submit-late-arrival.db.test.ts \
  src/capabilities/practice/server/assessment/submission-persistence.db.test.ts \
  src/capabilities/practice/jobs/judge_run.db.test.ts \
  src/capabilities/practice/jobs/judge_run-terminal.db.test.ts
pnpm vitest run --config vitest.db.config.ts \
  src/capabilities/copilot/server/durable-session-queue.db.test.ts \
  src/capabilities/copilot/server/subagent-mailbox.db.test.ts \
  src/capabilities/practice/server/due-list-query.db.test.ts
```

`review-answer.db.test.ts` prepares an authenticated route → real execution owner → actual Pi AgentTool → shared operation positive path, deterministic prior-capture positive learning, unknown/assisted no-mastery behavior, immutable image/long-text originals, pending native dispatch/worker replay, cross-question/session/turn rejection, missing permission/auth, forged actor/answer flags, changed originals/bindings, expiry, missing QUEUED evidence, settled replay and cancellation/retraction/review closure during grading. Queue delivery and model execution are offline substitutes; real original/evaluation/activation/learning tables are used. The pending case verifies one recorded model execution and one final effect across worker replay. The parent must observe these assertions passing; prepared tests alone prove none of those DB outcomes.

## Parent runtime and acceptance obligations

- Independently inspect the real diff against main and run the DB commands above. This writer's tracing and local checks are author evidence only.
- On the parent's Agent TEST ONLY candidate with automation disabled, use an authenticated request carrying an actual user original and explicit permission. Exercise the real Pi tool invocation, verify immutable bytes/digests and the correct session/turn/question/issuance, and inspect tool-call log, assistance snapshot, evaluation provenance and final learning effects. New chat capture must not add independent mastery or FSRS evidence. A prior independently accepted original must apply its valid effects once.
- Verify the existing pending/backfill HTTP statuses/headers and worker path, cancellation before acceptance and before synchronous activation, expired/retracted/settled/cross-turn authority, same-key receipt recovery and changed-input conflict. An accepted durable obligation remains owned by the existing worker. Do not blindly replay failed/DLQ or unknown external results.
- Preserve ordinary incremental SSE with no keyword gate, Start/summary/due/prune, frozen probe provenance, native mistakes and deterministic behavior when the model is unavailable. The browser has no attachment UI in this non-UI lane; the authenticated structured consumer is implemented. UI consumer migration remains a separate owner obligation.
- If the parent elects real-model acceptance, keep the product MiMo binding and seal exact revision, input/output digests, task-run ID, provider/model/cost. No paid-output evidence is present here. Exact-head CI and any delivery/deployment/recovery acceptance remain parent-owned.

No Linear action or global-board update was performed because the parent explicitly reserved those operations. Outstanding acceptance is still part of YUK-1356, not a newly invented follow-up or a completion claim.

## Owner merge-policy amendment

The exact owner instruction in this task was: "Newowner mergepolicy: fixes>one round and latestround noP1 may waive17min window, allothergatesunchanged."

The applicable root AGENTS.md merge-window rule now records the 2026-10-08 amendment: when fixes have gone through more than one round and the latest round has no P1, the ~17-minute wait may also be waived. Local verification, independent review, exact-head CI and disposition of existing P0/P1 remain required. This changes only the time condition, and does not initiate an extra review round. The existing review budget and unrelated rules remain intact. This writer did not push, review, merge a PR or deploy.

## Parent DB verification, 2026-10-08

Parent verified35 source and13 check-log hashes. Eleven scoped suites first returned158 passing and one failed new assertion: mastery_state includes both the existing knowledge and ability_global partitions (hierarchical Elo is enabled). The test now asserts both exact subjects and one evidence count each, retaining full row equality after Pi and HTTP retries. All20 tests in that suite then passed; the other139 passed on identical product source. No product logic changed for this correction. The adjacent parent DB evidence records commands, logs, hashes and cleanup. Both disposable PG runs exited, all four original container IDs/images/start/health and current-release bytes stayed unchanged. Owner/token-checked locks were released10:43:33Z and10:45:39Z. Real model output and deployment remain unproven.

## Final independent review and CI repair

The final R2 review returned P0/P1 NONE for source0d9360487 and verified parent83d7727f3 changed only tests/docs. It traced actual authenticated capture, Pi consumer, HTTP and worker paths, locks/revocation, immutable originals, assistance and replay. This exhausts the two-round review budget.

CI37765828244 on83d7727f3 failed DB shards1/4 and4/4 on two exact assertions: the proposal-tool inventory omitted the now-registered submit_review_answer; ordinary worker input gained a review_answer own property with value undefined. The fix adds the intended registered tool to the inventory and first removes the untrusted input reference, then conditionally adds only a resolved server reference. Ordinary input retains its previous shape, and the unit contract now explicitly rejects the property when authority is absent. No authorization, grading or recovery rule is relaxed. Related scoped revalidation is recorded in the CI-repair evidence. No third independent review or advisory bot retry is initiated.

CI-repair local evidence: three scoped DB files103/103 passed; unit/typecheck/lint/build passed. Normal merge of PR1604/main6150f01a9 only conflicted in PLAN/.remember, with both handoffs retained and six cost source/test blobs identical to main. Related unit plus application/Start typecheck, lint and full build passed again after integration. New exact-head GitHub CI remains required. Temporary DB teardown and owner-token lock release10:56:11Z left the original four containers and release unchanged.
