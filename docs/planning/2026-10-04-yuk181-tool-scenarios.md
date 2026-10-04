# YUK-181 — Tool-chain fixture coverage

The former prerequisite P5.8 / YUK-182 is delivered. Phase 1 remains in
`src/server/ai/tools/fixtures.test.ts`; Phase 2 adds six real DB/tool/service
chains in `fixtures-phase2.db.test.ts`, using the same readability contract.

| Scenario | Real handoff / protected claim |
|---|---|
| Math review queue | `get_review_due` → `get_question_context`; actionable rows, future projections and unknown totals remain distinct; an empty page does not prove an empty queue |
| Reading-note linking | `query_records` → `get_record_context` → `propose_record_links`; original Markdown and current links remain intact; proposal processing may become `linked`, but accepting the target relation remains separate; duplicate proposal is skipped |
| English variant | An authoritative user cause → `propose_variant`; original question/answer/KC reach the stub, proposal → cause → attempt references resolve; no published question is invented, and replay does not invoke the model again |
| Memory brief | Subject/global/missing scopes; fresh/stale/missing labels and nullable long-term certainty remain honest; all cited source IDs resolve |
| Math learning intent | Existing graph → `planLearningIntent` → explicit `acceptLearningIntent` → `get_learning_item_context`; no items materialize before acceptance; accepted items, knowledge and primary artifacts resolve |
| Programming prerequisites | `query_knowledge` → `expand_knowledge_subgraph`; incoming/outgoing prerequisite direction survives, and similarly named English content stays outside the returned graph |

The corpus includes nested graph paths, multiline Markdown/code, ambiguous
learner explanations, explicit null/unknown states, replay and empty results.
The shared helper gains resolvers only for the four tables actually cited by
these scenarios: learning_record, memory_brief_note, mistake_variant, artifact.
Deliberate cross-table citation corruptions prove each added resolver rejects
IDs that exist only in the wrong table; positive outputs use actual owner rows.

Learning intent currently uses an owner service/API, not a DomainTool. This
fixture calls that existing service and then the real context tool; it does not
invent a tool to satisfy an obsolete inventory count. Programming text exercises
generic graph traversal, not a code-execution judge. Reading notes remain a
record category. No new subject, route, migration, UI or production behavior is
introduced.

All model transports are stubbed, and unexpected calls reject. This verifies
structural intelligibility and handoff correctness, not real AI comprehension,
pedagogical quality, latency, provider billing or subscription quota. It needs
no paid probe. The local command is the DB config with both fixture files;
normal typecheck/lint/build/audits, independent review and exact-head CI remain
the delivery gates. Initial fixture expectation corrections are not claimed as
production bug RED evidence.

Author and independent reviewer both passed all 24 DB tests. Typecheck, lint
(299 existing warnings), build and the ten required local audits passed.
The unique independent initial review found no P0/P1 or substantive P2.
Exact-head CI and the last-push 17-minute merge window remain required.
