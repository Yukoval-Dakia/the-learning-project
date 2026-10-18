# Admission structured output — YUK-1537

Stage: 第一天能用. Draft PR #1785, branch
`fix/yuk-1537-admission-solve-structured-output`. Original fixed parent was
#1777 `38446bfd254bc6375ae970bc0573c38065302c47`; the lead now requires a NORMAL
merge of latest main and PR base `main`. Never rebase, force push, or replay the
#1777 commits. Preserve #1787's C1 comparison against the published revision's
`integrity_digest` when merging `source_verify.ts`.

## Output and repair budget

Only `QuestionAdmissionSolveTask` opts into schema tool output. `piCustomTool`
compiles the Zod schema into `mcp__structured_output__submit` arguments
`{result: ...}`. MiMo's OpenAI Completions payload forces that function and
disables parallel calls. Pi ends after ONE assistant turn, including invalid
arguments. Text-only, duplicate, truncated and provider-error output fails closed.
Numeric `expected` is required; `answer.kind` has only the four declared variants.

Pi's own `parseStreamingJson` can silently repair malformed tool-call JSON.
For this task the adapter collects the ORIGINAL `toolcall_delta` bytes and
requires a strict `JSON.parse` before accepting the terminal result. Missing
raw deltas or a syntax error rejects the output, even if pi salvaged a valid
object. Thus no pi syntax repair is accepted; it cannot consume an invisible
repair in each blind solve. Other tasks retain their existing parser behavior.

The two blind solves share ONE deterministic normalization allowance for the
SAME schema-invalid arguments. Canonical output uses none. Supported aliases
and string equivalents retain the original values; missing numbers, unknown
kinds, conflicting select keys and malformed JSON never invent a key. There is
no paid re-ask, and solve/crosscheck provider retries are disabled. A second
normalization is refused. Failures remain pending/unknown. The job captures
central runner `taskRunId` on thrown errors as well as successful `task_run_id`,
and writes all observed IDs into `paid_effect.unresolved_reason` as `task_runs=`
for later cost reconciliation; it does not claim an error is a successful receipt.

## Claim authorization and known verdicts

New policy/unit: `question_admission@2` / `admission@2`. New jobs carry
`admission_version:2`; storage envelopes retain version 1. Old queued deliveries
may reconcile existing @1 receipts but cannot send again or initiate @2.

A version bump is NOT permission to repay unknown work. Ordinary subscriber,
reverify, source promotion and hold-release jobs have NO marker, so the normal
entity gate blocks them on an open @1 unknown. Only the lead's explicit script
sets `reopen_unknown_input_digest` in a job. Together with the pinned group ID,
current base digest and old unit `admission@1`, this names the exact old effect.
The gate allows that specific same-base @1 **unknown** -> @2 transition only
when the marker equals its input digest. Wrong/absent marker, sending, another
base, @2 unknown and unrelated families still block. The marker is passed from
that delivery only, never inferred from a stored @2 input or copied by publishers.
Marked job IDs include the marker; all deliveries still share ONE @2 paid claim.

An applied verdict from EITHER `admission@1` or `admission@2` for the same base
is terminal, even on a marked job. The admission receipt check, historical policy
check and serving readers all recognize both versions. The serving command's
409 guard does too: an @1 failed verdict cannot gain a reverify button or be
paid again; @1 admitted evidence is preserved by the C1 digest barrier. Family
control, delivery equality, send CAS, fence and immutable receipts remain.

During the main merge, apply `2026-10-18-yuk1537-serving-rebase.patch` to make
both serving applied-verdict reads accept both units and to version the manual
fallback enqueue. An ordinary fallback never receives the lead-only marker.

## Lead pre-flight — BEFORE re-pending anything

The script is an explicit TEST operation, not a scheduler or another admission
path. Its only marker producer is `scripts/yuk1537-admission-reopen.ts`.
It is not executed by this implementation agent.

1. Use the SAME environment/configuration as the deployed TEST app AND worker.
   Verify `AI_PROVIDER_OVERRIDE=xiaomi-token-plan`,
   `AI_PROVIDER_MODEL=mimo-v2.6-pro`, and the Token Plan endpoint/key. Remove any
   leftover `QUESTION_ADMISSION_POLICY_ID=...@1` pin in BOTH processes.
   `QUESTION_ADMISSION_SOLVER2_PROVIDER` / `_MODEL` must both be unset, or their
   effective pair must resolve to an `openai-completions` model. The script
   checks catalog metadata, including single-field overrides, without calling
   the second model. Stop if incompatible; do not spend any of the five attempts.
2. Make ONE synthetic probe outside `paid_effect`, using the actual output
   schema, forced tool_choice and no retries:

   ```sh
   pnpm exec tsx scripts/yuk1537-admission-reopen.ts --preflight /private/audit/yuk1537-preflight.json
   ```

   The call is NOT free: it may consume provider quota, but creates no paid
   admission claim and uses no real question. It must return HTTP 200 and
   exactly one completed submit call with strict schema-valid arguments. The
   script records provider request ID/usage and the synthetic output, not keys
   or credentials. Existing receipt paths are refused BEFORE sending; a failed
   attempt also leaves a receipt. Failure stops the operation; no automatic
   second probe. Lead investigates/replans before permitting another request.
3. Prepare a PRIVATE JSON array containing exactly the five owner-approved
   identities from the original backlog-B receipts, one object each:
   `{"group_id":"...","base_digest":"sha256:...","input_digest":"sha256:..."}`.
   Do not put the manifest or question text in git. Snapshot each @1 row's full
   identity/state/fence/input/result/application/reason and authored key/revision.
   Ensure no @2 effect exists for any group; if one does, stop and reconcile.
4. Explicitly bind the intended TEST database and run the marked operation:

   ```sh
   export YUK1537_TEST_DATABASE_URL="$DATABASE_URL" # only after checking this IS TEST
   pnpm exec tsx scripts/yuk1537-admission-reopen.ts --reopen-approved-five /private/audit/yuk1537-preflight.json /private/audit/yuk1537-five.json
   ```

   The successful probe must be less than one hour old with identical routing
   and schema. This mode makes NO model call itself. Under one family-locked
   transaction for all five, it checks the exact @1 unknown, absence of @2 and
   absence of any applied verdict for the base; locks root/lifecycle; loads and
   schema-parses the CURRENT published layers; and recomputes the sealed digest.
   It publishes owner_hold then unverified_rules, with revision/generation CAS,
   requiring dimension-only `admission_updated` and the SAME revision. Custom
   presentation assets use the existing R2 byte reader. It atomically enqueues
   a pinned version-2 job bearing the exact old input-digest marker. ANY failure
   rolls back all five publications/jobs. Old paid rows are never updated.
   Ordinary publish-event jobs may also enqueue after commit; without the
   marker they remain gated. They cannot obtain another @2 send.
5. Let the TEST worker run ONCE. Record all task-run IDs, exact revisions,
   input/output digests, provider/model, honest estimated/unknown costs, @2
   claim states and per-unit reasons. Require admitted or explained withheld
   for each of the five. Pending/unknown still fails acceptance; never auto
   rerun it. Compare @1 snapshots byte-for-byte and confirm authored keys and
   unchanged-content revision reuse. Lead owns whether the remaining 112 resume.

**Retained obligation:** the five @1 unknown rows stay open even after a marked
@2 result. Because the exception is same-base only, they WILL block future
admission sends after content edits change the base digest. Do not delete,
rewrite or mislabel the old rows to unblock edits. The lead will file the
reconciliation follow-up; this PR does not solve that separate obligation.

## Evidence and approval boundary

No test code/suite, real DB, TEST provider or Docker/image operation is executed
by this implementation lane. Typecheck/lint/build, the requested audits and
uncommitted offline replay are reported in the PR. The lead supplies the R2
verification review, exact-head CI and real TEST acceptance. Both named
unapproved test files and `vitest.shared.ts` remain outside this PR's diff.

Text-only test proposal, still requiring owner approval before code:
- Public admission job + real Postgres: one table-driven payment/CAS case for
  matching/missing/wrong marker, @1/@2 applied suppression, immutable old rows,
  concurrent deliveries, @2 unknown refusal and receipt reapplication.
- Pi/dual-solve boundary: one deterministic-key case for raw JSON salvage
  rejection, one shared normalization, no fabricated key, and errored task-run
  IDs preserved in paid-effect reconciliation evidence.
