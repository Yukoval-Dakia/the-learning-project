# YUK-887 — bounded rollout evidence gap

Updated 2026-09-07 15:55Z. Source runtime is main `2351d5657` / candidate
`582b2e66`; deployed Mac API and worker both use that candidate. No production
code changed during this inventory. The purpose is to finish the original rollout
requirements, not to restart a general architecture cleanup.

## Seven rollout requirements

| Requirement from YUK-887 | Evidence available now | Remaining proof / next action |
| --- | --- | --- |
| Provider identity, admission, terminal, cost and run-log linkage in API/worker roles | Versioned Copilot actual-output records; production provider_attempt has four succeeded DashScope embedding rows, all dated August 15–16 with unknown costs | Old rows do not prove current rollout. Map each current live provider lane to relevant existing wire evidence before buying a missing sample; do not recreate retired wire paths merely to match historical names |
| Notes accept→generate and ready→verify crash recovery | Current note_generate/note_verify owners and durable handoff/claim implementation; scoped DB evidence | Real worker death/restart at both handoffs has not been established. A normal restart or mocked provider is insufficient |
| Memory crash after paid add, event-id reuse, no reburn | client.findByEventId and ingest recovery owner; DB/unit contracts | Need actual Mem0 add and replay across a process boundary, comparing memory IDs and provider-operation evidence; do not replay the user's existing failed ingestion/DLQ |
| Valid and intentionally invalid test-only DomainTool output | New actual Agent SDK MCP client/server canary below; real DB log/mirror linkage | Component runtime verified. This is not a model-invoked or deployed-container canary; retain that distinction when closing the broader rollout |
| A real operation per F3 capability slice, actual output and separate projection/golden judgment | Copilot, knowledge read/presentation and question generation have versioned actual records; 973/974 provide separate projection/golden evidence | Complete a per-capability coverage map, especially Notes/Ingestion/Agency; do not count an adjacent capability's tool call as blanket coverage |
| Proposal draft→accept/dismiss/retract, human approval intact | Actual proposal-only sample, owner DB lifecycle tests, and new shipped API scenario below | Representative knowledge-node lifecycle passes; no UI click or blanket assertion for all proposal kinds |
| Copilot cancellation, worker restart/reconcile, durable run/log continuity | 948/950 real HTTP→physical fetch→worker continuity; 975 real shutdown; 978 actual physical pg-boss missing-child repair and late-Stop DB regression | Reuse those named scopes. They do not prove live-model interruption followed by worker crash; enumerate the exact remaining scenario before testing |

This table is an evidence gap, not seven new implementation tasks. YUK-887 remains
In Progress and its production rollout gate remains distinct from implementation
completion. No existing actual model sample is rerun solely because its SHA differs
from today's tip. Relevant source changes determine whether a sample is stale.

## Concrete evidence anchors

- [Unified conversation](evidence/2026-09-07-unified-conversation-actual.json):
  exact a5bfa5a3, two real HTTP/pg-boss fetch/worker turns, preserved SDK session;
  not automatic polling or browser UX proof.
- [Native compaction](evidence/2026-09-06-native-compaction-actual.json): two
  accepted real manual-compaction samples; no general net-cost-saving claim.
- [Question generation](evidence/2026-09-07-learning-content-positive-actual.json):
  exact 219a1816, generate_question_candidate and present_primary_view,
  actual validators and persisted view; direct handler, not physical queue E2E.
- [Knowledge observation](evidence/2026-09-07-knowledge-observation-actual.json):
  exact 5717bcbd, query_knowledge plus presentation, explicit evidence boundaries.
- [State rollout](2026-09-07-local-production-state-cutover.md),
  [canonical writers](2026-09-07-canonical-state-writers.md),
  [shutdown](2026-09-07-api-shutdown.md), and
  [native settlement](2026-09-07-native-child-settlement.md) retain the migration,
  golden, real process and physical queue observations separately.

## New zero-cost MCP component canary

Executed the real `buildMcpServerFromRegistry` with Agent SDK 0.3.220 and MCP SDK
1.29.0, a real MCP Client, initialize/listTools/callTool protocol, and linked
InMemoryTransport endpoints. No mocked SDK tool handler or mocked DB/logger was
used. The database was the existing isolated synthetic
`loom_native_978_ba4bc7fe_verify`, never production `loom`.

Two test-only read tools return nested hits plus an explicit null unknown field.
The input and evidence include 160 repetitions of a Chinese evidence-boundary
sentence. The invalid result changes numeric hits[0].score to `uncertain`.
Valid output returns score 0.75/null. Invalid output returns only a structural
error (`output_schema_invalid: hits.0.score`), not unvalidated hits. Two real log
rows link to one success and one failure tool_use event. AI tasks and provider
attempts remain zero. The initial probe used the wrong response envelope in its
assertion and failed; the corrected run below is the accepted evidence.

- Task identity: `canary_887_real_mcp_20260907_v2`.
- Input SHA256: `5eb69e4b37fe9c38b4ef0ebb5cc90eef56e93bdef614698d8d6461a4a080847e`.
- Combined output SHA256: `c031dab02541f5496a0b04b63eab8e883c10601086737a9b14594a23dc509835`.
- Failure event: `tool_use_g9e13m4rhb76s731cpbrvzl4`.
- Success event: `tool_use_xlbbz73kqllkulibq9aqn8j4`.
- Bridge source SHA256: `6ceb80e97c97861a19a99d9ebee498ae2100d9a08a7d7cb433d5fef41c718c73`.
- Local probe `.tmp/yuk887-bridge-canary.cjs`, SHA256
  `b40ed6ec598e3ba413bad69aaa7dcee8772484316d25ad864fee1e97dcfb62b9`.

This is isolated component runtime evidence, not a paid model invocation,
network-transport test, or production rollout completion.

The two local probe scripts were subsequently formatted for the workspace lint
gate, without rerunning providers. The original hashes above identify the executed
bytes. Current formatted MCP script SHA256 is
`27ebaa914d0beb69c72ae5a75038c19a4b73a1fadda103c43d29470934af5e3e`;
proposal script SHA256 is
`8ee1d8cb6c3c3c3475736a930765fb0070ed46e2444fb242b0f610c88d40b7f0`.

## New zero-cost shipped proposal API canary

Started the clean deployed image `582b2e66` as an isolated API-only container on
loopback 18887 against the same synthetic database. No worker or provider credentials
were supplied. Two synthetic knowledge-node proposals were written through the
real proposal writer under the seeded yuwen root. The initial malformed decision
body was rejected with 400 before mutation; after correcting the test client to
send reason_md only for retract, the full scenario passed:

- Before approval, neither proposed knowledge node existed.
- Unauthenticated accept returned 401 and still created no node.
- Explicit authenticated accept returned 201 and materialized exactly one node.
  Repeating it returned 200 and the identical decision event.
- Dismiss of the second proposal returned 201 and created no node.
- Retract of the accepted proposal returned 201 and archived its materialized node,
  preserving the row/history. Repeating retract returned 200 and the same event.
- AI task/provider-attempt counts remained zero. Production counts independently
  stayed 423 events / 258 AI tasks / 4 provider attempts.

Proposal IDs: `canary_887_proposal_accept`, `canary_887_proposal_dismiss`.
Accept event `kxipbpurfa6jfg0d03wi26cc`; dismiss event `lnjwn53bt6gt26h6hq6pr1uk`;
retract event `iojv9h70swevpzs00m0jqbox`; materialized node `t6aq0h0m4eo7cboxi45lg9mj`.
The local probe is `.tmp/yuk887-proposal-canary.cjs`. Container
`tlp-proposal-887-582b2e66` was stopped after verification. No production data was
created or deleted. This is actual shipped HTTP/DB behavior with explicit test
client approval, not browser clicks, model proposal generation, or proof for every
proposal kind.

## Execution order and spending boundary

Owner approved the pending budget-transfer request on 2026-09-08: the unused
$3 historical-recovery allowance may fund the bounded Notes/Memory real recovery
acceptance instead. This is the same $3, not an additional $3. No paid call has
yet been started under that transfer; keep the original $10 reserve unchanged.

The archive was read recursively on 2026-09-08 local time: all 41 encountered
output/output_sha256 pairs match their stored text. This is an integrity check,
not 41 independent successes: nested copies and deliberately failed samples are
included. Current manifest ownership disambiguates the remaining slice coverage:

| Slice | Reusable actual evidence | Not proved by that evidence |
| --- | --- | --- |
| Copilot | Unified two-turn sample, native child, correction, compaction, presentation | Live-model crash scenario beyond the named physical recovery tests |
| Knowledge | query_knowledge and presented snapshot; representative proposal API lifecycle | Every mutation/merge variant as a production operation |
| Practice supply | QuestionAuthorTask plus four real validators in positive-content sample | Learner attempt grading and FSRS/review settlement |
| Practice judging | Existing validators validate generated content; get_attempt_context/get_review_due are Practice reads | They are not an actual learner attempt→judging→review-settlement run |
| Notes | presentation-control archive actually called author_artifact, returning artifact art_sarsg30nxr0pvpdi9pdvscv5 | Automatic note_generate/note_verify and their crash handoffs |
| Ingestion | Existing deterministic/DB and historical rollout data | No current accepted ingestion actual-output sample located in this archive |
| Agency | Existing owner/transaction/golden checks | No current accepted Agency actual-output sample located in this archive |

Neither query_events (Copilot-owned) nor get_review_due/get_attempt_context
(Practice-owned) counts as an Agency actual operation. author_artifact is
Notes-owned, but its successful interactive page must not stand in for automatic
note generation. This mapping prevents both unnecessary repeats and false coverage.

1. Reuse the now-completed MCP and representative proposal API scenarios; finish
   the per-capability actual-output coverage map without rerunning accepted cases.
2. If authorized, run only missing Notes/Memory real recovery scenarios with a
   fixed reserve per attempted call. Stop at the authorized cap or unknown spend.
3. Finish YUK-951 from actual queue expiry/retry/backoff/jitter and durable activity
   evidence. A point-in-time empty queue does not prove a continuous drain window.
4. Final business-owner acceptance uses learning intent/import/judging/review/
   proposal behavior, rule uniqueness and recovery ownership, not file/test counts.

The original $10 pool has conservative safe remaining $0.04177. The unused $3
allowance is now transferred to Notes/Memory acceptance by the approval above;
no paid call has occurred under it yet.
YUK-977 remains a deferred P2, not a new blocker. No NAS operation, historical data
deletion, or broad source-cleanup branch is part of this lane.
