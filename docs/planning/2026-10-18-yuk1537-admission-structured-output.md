# Admission structured output — YUK-1537

Stage: 第一天能用. Fixed parent: PR #1777, `38446bfd254bc6375ae970bc0573c38065302c47`.
Branch: `fix/yuk-1537-admission-solve-structured-output`; draft base: `fix/yuk-1468-admission-revision`.

## Contract and payment

`QuestionAdmissionSolveTask` alone opts into `structuredOutputMode: 'tool'`.
The existing `piCustomTool` compiler advertises the Zod schema as native JSON
Schema arguments to `mcp__structured_output__submit`, wrapped as `{result: ...}`.
MiMo's OpenAI Completions payload requires that function and disables parallel
calls. Pi finishes after ONE assistant turn, even if argument validation fails.
Only one submit call with a non-truncated `toolUse` finish becomes
`structured_output`; text, duplicate calls, truncation and provider errors fail
closed. Other task definitions keep their existing execution behavior.

Each paid admission batch shares ONE deterministic normalization allowance between
solve A and solve B. Canonical output consumes no allowance. A schema failure may
normalize the SAME arguments once using #1777's capability-owned mapping; blank
strings become `{text}`, declared select IDs become `{item_ids}`, and supported
answer aliases retain the original values. Missing numeric `expected`, unknown
kinds, conflicting select keys, and malformed JSON never invent a key. Both solve
calls and the separate source crosscheck disable provider retries; there is no
paid re-ask. Parse failure stays `pending`, and the winning claim records `unknown`.

The solve contract is `question_admission@2` / paid unit `admission@2`. The frozen
input/receipt envelope remains version 1 (its storage shape did not change).
New subscriber jobs carry `admission_version:2`; their deterministic job ID also
includes contract version 2. Unversioned / version 1 queued deliveries only read
or apply existing @1 receipts: they cannot send again or initiate @2. A direct
explicit invocation uses @2. A generation change alone never creates another
paid identity within either contract version.

The shared entity gate needs one explicit, directional exception: an old
`question_admission_run` / `admission@1` **unknown**, for the **same entity and
base digest**, does not block a NEW `admission@2` claim. Old sending, another
digest, an @2 unknown, and unrelated families still block. SQL and the pure
protocol predicate agree. No existing unknown row is updated, settled or deleted.
The original family-control locks, delivery checks, send CAS and fence remain.

Readers/writers changed: `receipt.ts` chooses the paid unit; `enqueue.ts` versions
new jobs; `question_admission_run.ts` scopes historical terminal verification by
policy; `run-admission.ts` stamps @2; `source_verify.ts` preserves current-revision
C1 passes for @1, @2 and the configured policy with the original digest barrier.
An explicit environment pin to `question_admission@1` is rejected; unset it.
Published-revision grading, verbatim authored keys, no-content-change revision
reuse and digest mismatch rejection from #1777 remain in their existing paths.

## Main integration required after #1777 merges

#1774's `src/kernel/read-models/question-serving.ts` and
`src/capabilities/practice/server/serving-actions.ts` do NOT exist on the mandated
parent. The adjacent `2026-10-18-yuk1537-serving-rebase.patch` is a precise patch
against fetched main, not an activated reader on this branch. After rebasing:

```sh
git apply --check docs/planning/2026-10-18-yuk1537-serving-rebase.patch
git apply docs/planning/2026-10-18-yuk1537-serving-rebase.patch
pnpm exec biome check --write src/kernel/read-models/question-serving.ts src/capabilities/practice/server/serving-actions.ts
```

It switches BOTH applied-verdict reads to the shared `admission@2` constant and
versions the manual reverify fallback job as 2. An @2 applied withheld result is
`admission_failed` without an identical-claim reverify action. Old @1 unknown
alone remains `awaiting_admission`; an old @1 applied result does not suppress a
new @2 contract attempt. Existing lifecycle `verification_failed` remains
`admission_failed`; already admitted @1 questions remain admitted. Do not deploy
the rebase without applying this patch and rerunning the required checks.

## Lead: re-run only the five on TEST

1. Obtain the five group IDs from the private `deployment-20261018/backlog-b/`
   receipts referenced by YUK-1537. Do not put their question text in git.
2. After #1777 merge, rebase and apply the integration patch above. Independently
   review, validate, then deploy the SAME revision to TEST app and worker only.
   Confirm `xiaomi-token-plan/mimo-v2.6-pro`; remove an old policy @1 env pin.
3. Snapshot the five @1 paid-effect rows (full identity/state/fence/input/result/
   application/unresolved reason), their current revision IDs/digests and authored
   keys. Leave these rows untouched. Stop if a group is suspended/withdrawn,
   its published digest does not match schema-parsed layers, or an @2 sending /
   unknown claim already exists. An @2 unknown requires reconciliation, not a retry.
4. Re-pend using the existing **publisher**, never direct lifecycle/paid-effect
   SQL. Within one transaction, take family control then root/lifecycle locks,
   load the CURRENT published revision, parse its structure/response/scoring/
   execution/presentation with their existing Zod schemas, and check
   `contractIntegrityDigest(layers) === revision.integrity_digest`. Call
   `publishQuestionGroup(tx, {group_id, contract:{...layers, integrity_digest},
   expectedCurrentRevision, expectedAdmissionGeneration, availability,
   admission:{state:'withheld',reason:'unverified_rules'},
   actorRef:'owner:yuk1537-repend', now:new Date()})`.
   If it is already withheld/unverified_rules, publish an owner_hold dimension
   followed by unverified_rules in the SAME transaction, using each returned
   generation for the next CAS. This produces a fresh outbox event even for an
   unchanged pending state. Require `admission_updated` and the SAME revision ID
   at each step; throw/rollback on conflict, published, withdrawn or noop. If the
   presentation has custom blocks, provide the existing asset byte reader.
5. Let `practice.question-admission-enqueue` consume the final publish event.
   Confirm its job pins the same revision/digest, latest admission generation,
   current dispatch generation and `admission_version:2`. Do not replay an old
   queue job. The subscriber filters current pending state and creates one
   deterministic @2 job; duplicate publish events deduplicate to that job.
6. Let the TEST worker run once. Record both blind solves, optional crosscheck,
   calibration task-run IDs, exact input/output digests, provider/model and costs
   (catalog estimated vs unknown stays honest), @2 claim disposition and final
   per-unit reasons. Require admitted or explained withheld for each of the five;
   pending/unknown is still a failure requiring investigation. Compare the @1
   snapshot byte-for-byte; also check authored keys and revision reuse. Only the
   lead decides when the remaining 112 questions may resume.

## Validation and remaining acceptance

Offline replay uses `/tmp/yuk1537-replay.ts` (not committed). Synthetic cases are
not real model or DB acceptance. No test files were written/changed and no test
suite or paid provider was run. Local checks and replay output are recorded in
the draft PR. Independent review and exact-head CI/TEST acceptance belong to the
lead; this implementation lane does not merge, rebase or deploy.

Text-only test proposal (requires new owner approval before any test code):
- At the public admission job + real Postgres boundary, use one table-driven
  invariant case to prove @1 unknown stays byte-identical, explicit @2 same-base
  upgrade may send once, old delivery and @2 unknown may not send, and competing
  @2 deliveries preserve CAS/fence ownership. Include receipt reapplication.
- At the real dual-solve boundary, one deterministic-key case supplies malformed
  numeric/kind/conflicting-key outputs and verifies pending with no minted key;
  include the shared one-repair limit across both passes.
- At the pi execution boundary, one payment-safety case uses a synthetic provider
  stream to prove one request for valid/invalid/truncated tool outputs and zero
  SDK retries. Keep the real-model five-question TEST run as separate evidence.
