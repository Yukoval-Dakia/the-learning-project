# Audit — Foundation D M1 Copilot Tools Foundation closeout

**Date**: 2026-05-26
**Phase**: Foundation D M1 (YUK-78) — DomainTool Registry foundation
**Status**: ✅ All 4 lanes ship

## 1. Lane summary

| Lane | Issue | PR | Status |
|---|---|---|---|
| A — DomainTool interface + `tool_call_log` extension | YUK-79 | #139 | ✅ Merged commit `5c357a3` |
| B — `query_mistakes` + debug endpoint | YUK-80 | #140 | ✅ Merged commit `be28527` |
| C — in-process MCP bridge + `query_events` + `get_attempt_context` | YUK-81 | #141 | ✅ Merged commit `a4e18c6` |
| D — `experimental:tool_use` event mirror + audit doc (this) | YUK-82 | (this PR) | ✅ |

Foundation D M1 phase issue YUK-78 closes when this PR lands.

## 2. Spec sequence progress

`docs/superpowers/specs/2026-05-17-agent-context-tools-design.md` §"Engineering Sequence" L1171-1206 enumerates 8 steps. M1 advances the counter from step 0 → step 5:

| Step | Description | Status pre-M1 | Status post-M1 |
|---|---|---|---|
| 1 | LearningRecord migration | ✅ | ✅ |
| 2 | doc alignment | 🟡 partial | 🟡 partial |
| 3 | Read-only registry (read tools) | ⬜ | ✅ 13/13 after M2 (M1 3 + M2 10) |
| 4 | in-process MCP bridge over registry | ⬜ | ✅ |
| 5 | context-specific readers | ⬜ | ✅ get_attempt_context + record/question/review/item/memory composites |
| 6 | proposal tools | ⬜ | ⬜ |
| 7 | Copilot trace UI using `summarize()` | ⬜ | ⬜ |
| 8 | remote MCP only if needed | ⬜ (Non-Goal) | ⬜ (Non-Goal) |

M2 completed step 3 read coverage (10 more read tools) + step 5 expansion. M3 lands step 7 Copilot drawer.

## 3. Read tool contract matrix (13 read tools registered after M2)

| Tool | input shape (filters) | output highlights | summarize sample | mirrorEvent | costClass |
|---|---|---|---|---|---|
| `query_mistakes` | `causeCategoryId? / knowledgeId? / dueWithinDays? / sinceDays? / limit? / includeVariants? / includeAttribution?` | mistake rows with cause + review_state + variants | `mistakes · 8 rows · 3 due · cause=concept` | when_user_visible | local |
| `query_events` | `actorKind? / actorRef? / action? / subjectKind? / subjectId? / outcome? / causedByEventId? / sinceDays? / limit?` | event rows with `caused_by_event_id` for chain walking | `events · 12 rows · action=propose · since≤7d` | when_user_visible | local |
| `get_subject_graph_overview` / `query_knowledge` / `expand_knowledge_subgraph` / `find_knowledge_paths` | subject / node / relation bounded graph filters | tree path + typed mesh summaries + local evidence | `knowledge · 之 · 1 nodes · 1 edges` | when_user_visible | local |
| `query_records` / `get_record_context` / `get_question_context` | record/question/item ids + bounded include lists | LearningRecord, question lifecycle, attempt/review links | `record context · rec_x · mistake` | when_user_visible | local |
| `get_review_due` / `get_learning_item_context` / `query_memory_brief` | due filters, learning_item id, memory scope | deterministic due queue, item context, derived memory brief | `review due · 2 rows · 1 new · 1 overdue` | when_user_visible | local |
| `get_attempt_context` | `attemptEventId / timelineLimit?` | attempt + question + cause + per-question timeline + linked records | `attempt att_abcd · q=q_xx · cause=concept · timeline=4 · records=1` | when_user_visible | local |

All three are Zod-guarded both ways (input + output). All three reuse existing readers (`getFailureAttempts`, raw `event` select, `getFailureAttemptById`, `getQuestionTimeline`, `listLearningRecords`) — zero new SQL.

## 4. Bridge contract

`buildMcpServerFromRegistry({ ctx, serverName, toolNames, taskKind? })` produces an SDK MCP server. Per-tool handler flow:

1. Zod-parse raw args (re-parse on TS side for typed Input).
2. `tool.execute(ctx, input)` — soft-fail returns valid Output; hard-fail caught and recorded.
3. Write `tool_call_log` row with `effect / error_reason / input_json / output_json / latency_ms / cost`.
4. Resolve `mirrorEvent` policy. If fires + caller is agent: write `experimental:tool_use` event mirror with `{ tool_name, args, result_summary, error_reason? }` payload; back-fill `tool_call_log.mirrored_event_id`.
5. Return SDK-shaped `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`.

### 4.1 mirror policy resolution (Lane D `__resolveMirrorPolicy`)

| policy | caller=user | caller=cron | caller=system | caller=agent:misc | caller=agent:copilot | caller=agent:teaching:* | caller=agent:dreaming:* |
|---|---|---|---|---|---|---|---|
| `never` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `always` | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| `when_user_visible` | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `when_causal` (effect=read) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `when_causal` (effect=propose/write) | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |

Non-agent callers never mirror because `ToolUseExperimental` schema locks `actor_kind='agent'` (`src/core/schema/event/experimental.ts` L21).

### 4.2 outcome mapping

- `success` (including soft-fail "0 found" — schema-valid empty result) → `outcome='success'`, `result_summary` set
- hard-fail (exception caught in `execute()`) → `outcome='failure'`, `payload.error_reason` set, **does not crash the tool loop** (per design brief v2.1 §1.6 #5)

## 5. `experimental:tool_use` promotion counter (ADR-0011 §1)

ADR-0011 requires **3 distinct tools producing valid mirror events + 2 weeks stable shape** before promoting `experimental:tool_use` to a KnownEvent.

| Criterion | Status |
|---|---|
| Tools registered | 3 (query_mistakes / query_events / get_attempt_context) ✅ |
| Tools observed mirroring in prod | 0 — only test fixtures so far. Counter starts on first prod call. |
| Days stable shape | 0 — payload schema landed 2026-05-26. |
| Earliest promotion eligibility | 2026-06-09 (provided shape stays stable + production calls happen) |

Promotion task = M6 in the project. Until then, `experimental:tool_use` lives in `RESERVED_EXPERIMENTAL_ACTIONS` (`src/core/schema/event/experimental.ts` L138-143) so the generic `ExperimentalEvent` escape hatch can't silently accept a malformed payload.

## 6. Deferred / known follow-ups

- **KnowledgeReviewTask bridge migration**: Lane C deliberately did not refactor `KnowledgeReviewTask`'s custom `write_proposal` MCP server to use the new bridge. Its dispatcher contains inline routing for tree-shape vs mesh-shape mutations that don't map cleanly to a single DomainTool. Followup: register two DomainTools (`propose_knowledge_edge`, `propose_knowledge_mutation`) and switch the task when Lane M4 (propose tool registry) lands.
- **Read tools M2**: `get_subject_graph_overview` / `query_knowledge` / `expand_knowledge_subgraph` / `find_knowledge_paths` (graph readers) + `get_review_due` / `query_records` / `get_record_context` / `get_question_context` / `get_learning_item_context` / `query_memory_brief` now registered via `registerCoreTools`; DB coverage lives in `src/server/ai/tools/read-tools-m2.test.ts`.
- **Propose / write tools** (M4): `propose_knowledge_edge`, `propose_knowledge_mutation`, `attribute_mistake`, `propose_variant`, `propose_learning_item_completion`, `propose_learning_item_relearn`, `propose_record_links`, `propose_record_promotion`.
- **Cost / latency budget**: `costClass` is declared but no enforcement layer reads it yet. Add budget caps when M3 Copilot drawer needs per-turn cost ceiling.
- **soft-fail flag**: spec brief §1.6 #5 distinguishes soft-fail (`0 found`) from success in UI. Bridge currently treats both as `outcome='success'` with summary as the only differentiator. M3 ToolUseCard primitive should rely on `result_count`/`result_summary` to render distinctly.

## 7. v0.4 roadmap progress

`docs/planning/v0.4-complete-form-roadmap.md` §7 第一波 4 项全部 ship. Pre-M1 was the project's largest standing缺口 (5+ weeks no progress on the spec). Lane sequence:

```
Lane A (foundation) → Lane B (1st tool) → Lane C (bridge + 2 tools) → Lane D (mirror)
   ↓ unblocks
M2 (read tool full coverage)
   ↓ unblocks
M3 (Copilot drawer MVP) + M4 (propose/write tools)
   ↓ unblocks
M5 (Phase 3 Global Coach Orchestrator MVP)
   ↓ unblocks
M6 (drawer rolled out across all 6 routes + experimental:tool_use → KnownEvent promotion)
```

Dreaming agent + ADR-0017 Phase B (YUK-37 brief writer) both consume the read tools landed here, so M2 unblocks both.
