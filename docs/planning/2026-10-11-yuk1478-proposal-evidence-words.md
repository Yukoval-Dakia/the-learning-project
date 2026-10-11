# YUK-1478 proposal evidence in plain words

## Behavior

When the learner reads a proposal, the backend maps its stored reason into the
existing `reason_md` or legacy `reasoning` field. A complete known count becomes
plain Chinese. A mixed or unsafe dump becomes an explicit notice that the
proposal lacks a readable explanation. Ordinary prose is returned verbatim.

The stored proposal and original reasoning remain the evidence source. Reading
does not write an event, change a proposal decision, alter its eligibility, or
ask a model to explain the evidence.

For the reported exemplar, the public mapping is:

```text
Stored reason: recent_failure_count_30d=1
Learner reason: 提议引用的统计中，最近 30 天有 1 条失败作答记录。
```

This describes the statistic cited by the proposal. It does not independently
verify a model's claim, infer which skill failed, or claim a learning outcome.

## Source chain

These are production source paths at base `135bb18e6d2743492e590984c95f58c42404d4be`.
They are not a recorded database or browser run.

- `src/capabilities/knowledge/server/tools/knowledge-readers.ts:199` loads
  effective failure attempts and counts their knowledge references within the
  requested window. Overview cluster statistics and graph-node statistics
  expose `recent_failure_count_30d` to the agent. These are internal tool
  outputs, not learner proposal DTOs.
- `src/capabilities/knowledge/server/tools/proposal-tools.ts:554` accepts
  `reasoning`. Its mutation producer at `:751` passes that string to
  `writeKnowledgeProposeEvent`. The edge producer and the legacy review writer
  also accept free-form reasoning. The exact model output is unverified here.
- `src/capabilities/knowledge/server/proposals.ts:194` builds the typed
  proposal with `reason_md`. `src/kernel/proposals/writer.ts:112` validates it
  and stores it under `event.payload.ai_proposal`, with legacy `reasoning`
  copies for knowledge events. This write path remains unchanged. In particular,
  the producer-side reasoning rubric still sees its original input.
- `src/kernel/proposals/inbox.ts:840` derives status, signals and presentation
  from stored proposal/decision events. Its internal rows retain the original
  reason for cooldown, lifecycle and other domain callers.
- `src/kernel/proposals/presentation.ts:662` maps the judge-retraction reason
  before it becomes a change-summary excerpt. Existing math-safe truncation,
  block previews, subject notation and evidence labels keep their behavior.
- `src/capabilities/shell/server/proposal-inbox-read.ts:50` uses
  `proposalInboxRowForLearner` before both `rows` and collection `data` are
  assembled. The Hono handler calls this reader.
  `server/start/workbench-reader.ts:31` already calls the same public reader,
  so Start receives the mapping without any Start edit.
- `src/capabilities/shell/ui/inbox-api.ts:144` and `:149` consume its decision
  and observation pages. `ProposalCard.tsx:439` and `InboxPage.tsx:229` render
  the existing reason field. No UI change is needed for this backend mapping.
- `src/kernel/proposals/inbox.ts:1099` applies the legacy mapping before
  `/api/knowledge/proposals` returns rows. Recursive mapping covers duplicated
  `ai_proposal.reason_md` and nested `reasoning` copies in legacy payloads.

## Mapping limits and contracts

The known evidence schema accepts exactly one nonnegative safe integer named
`recent_failure_count_30d`. It accepts that object, its JSON encoding, or the
complete historical assignment grammar `recent_failure_count_30d=<integer>`.
An additional field, missing value, negative count, fraction, unsafe integer,
or mixed narrative is not decoded. A stored explicit zero may be described;
missing and invalid values never become zero. Counts are not reconstructed from
the number of evidence links.

Dump and safety syntax checks can withhold JSON/array dumps, fenced text,
line-leading technical assignments, the raw reported field embedded in prose,
known credential syntax, email addresses, labeled contact fields, and URLs
with query strings or embedded credentials. They replace the whole reason,
without trying to understand or partially rewrite it. This is a bounded reason
projection, not a general detector of private facts in arbitrary prose or a
sanitizer for every proposal data field.

The recursive read mapping visits `reason_md` and `reasoning` fields only.
It does not rename domain fields, rewrite IDs, or change evidence references.
Normal text is not sliced or given synthetic math delimiters. Safe public
URLs in ordinary reasons remain, and dedicated evidence links remain in every
case. Unsafe reason URLs stay in the original internal evidence.

Public field names and types, ISO timestamps, pagination and collection aliases
stay the same. Status, nullable cost, signals, target/version identities,
evidence links and history retain their values. Accept/dismiss/retract dispatch,
stale admission and explicit lossy-merge confirmation are unchanged. No schema,
DDL, Start, DBOS, assessment, ingestion, UI, provider, or dependency edit is
part of this change.

## Evidence and handoff

The focused privacy unit file constructs a validated proposal row, passes it
through the exact mapper used by the public reader, and serializes the result.
It verifies the reported raw count field is absent, the cited count is readable,
provider credentials and third-party contact data are withheld from reason
copies, source reasons remain intact, and links/stale/history values remain.
The legacy case also checks duplicated nested reasons and refuses to decode a
mixed count/credential dump. Both cases are admitted under the security
invariant, not as model-quality or wording tests.

Local evidence is retained under `.cache/yuk1478/`. The first test attempt
selected no file because the shared partition list did not include the new
file. `vitest.shared.ts` then received exactly one unit-path entry, reported
before editing. The registered attempt passed both cases. Node is 24.19.0;
pnpm is 11.13.1. Dependencies were installed with
`pnpm install --offline --frozen-lockfile`, with no downloads or lockfile edits.

Final local checks passed: the two focused privacy cases, `pnpm typecheck`,
`pnpm lint` with 172 warnings and no errors, and `pnpm build` through the SPA,
Start, server, worker and migrate bundles. The build reports chunk-size and
ineffective-dynamic-import warnings. Test-policy admission checked both new
cases without errors; the static partition audit also returned no errors.
The exact commands and outputs are retained in `privacy-unit-registered.log`,
`typecheck-final.log`, `lint-final.log`, `build-final.log`, `test-policy.log`
and `test-partition.log` in the evidence directory above.

There is no database, Docker, product-runtime, browser, provider,
actual-model-output, paid-call, deployment, or full-test acceptance from this
lane. The parent owns different-model independent review, exact-head CI,
publishing and Linear status. YUK-1478 remains subject to those gates.

No separate actionable follow-up was established by this source slice. The
outstanding review and acceptance belong to the existing YUK-1478 work, so this
lane does not create a duplicate issue or edit the shared active board.

## Prepared PR description

### Summary

Proposal reasons could expose the raw `recent_failure_count_30d=1` tool field
and technical dumps to the learner. The shared public reader now translates
complete known evidence and withholds unsafe or uninterpretable dumps while
retaining the original stored evidence.

```diff
 readProposalInbox
   listProposalInboxPage
+  proposalInboxRowForLearner
   collectionPayload(rows, data)
```

### Evidence

- Before: production source returned internal `payload.reason_md` directly;
  the legacy reader could also return its nested raw reason copies.
- After: the exact public mapper's privacy unit cases pass, including the
  reported count exemplar, withheld credentials/contact data and retained
  source evidence. Final static/build logs accompany the fixed commit.
- Product runtime, actual model output, independent review and CI remain
  parent acceptance work.

### Merge Danger

Door: two-way. The change affects read projections and never rewrites stored
proposal records.

Blast radius: proposal reasons. Public reason strings may become an explicit
notice when their content cannot be decoded safely. Decision, history and
evidence-link contracts remain in their existing paths.

Closes YUK-1478
