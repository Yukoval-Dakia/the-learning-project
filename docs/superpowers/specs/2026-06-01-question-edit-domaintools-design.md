# Agent-callable question structure-edit DomainTools — design note

> **Status**: design, 2026-06-01. **Issue**: YUK-195. **Refs**: YUK-164 (T-OC), YUK-78 (DomainTool registry), ADR-0002 §Agent 修改约束, P3.7.
> Source decision: v0.4 roadmap §6 reconciliation v2 ①(a). Layer choice confirmed by user (Design B — draft-block correction layer).

## 1. Problem

P3.7 / ADR-0002 §"Agent 修改约束" specify a domain-tool set that lets an agent **correct OCR/VLM-extracted question structure**: `updatePrompt / addOption / setQuestionType / splitStem / mergeQuestions / reassignFigure`. None exist. `StructuredQuestion.source='agent_edit'` is reserved but has **zero writers** — these tools are those writers.

## 2. Layer decision (Design B, confirmed)

Tools operate on **draft `question_block.structured` tree + `question_block.figures`** (status guard: `status='draft'`), i.e. the pre-import correction layer. Rationale (map-verified):

- `StructuredQuestion` has **no `kind` field** (only `role` = stem/sub/standalone); `question.kind` lives on the post-import `question` row and is supplied per-block by the import request (`import/route.ts:71,411`). So question-type correction has no draft-layer home → see §4.3.
- `reassignFigure`'s existing machinery is **block-level** (`app/api/question-blocks/[id]/figures/[asset_id]/route.ts`): tx + `idHasMatch` structured-tree validation + figure `attach_confidence='manual'` + `last_reassigned_at` + `block.version` bump + `writeJobEvent` (job_events + pg_notify for SSE). Reuse it.
- Draft-only edits avoid touching live `question` rows / FSRS / review projections → **low risk**.
- Consumer (registry-first, like the M4 propose tools): future **OC-5 review surface** (→ YUK-169 redraw) + the debug endpoint `POST /api/_/tools/[name]` for now.

## 3. Cross-cutting mechanics (all 6 tools)

- `effect: 'write'`, `mirrorEvent: 'when_causal'` (agent callers → bridge auto-writes `tool_use` event; matches `attribute_mistake`).
- Single-owner service module `src/server/ingestion/block-structured-edit.ts` owns all 6 mutations; the 6 DomainTools (`src/server/ai/tools/question-edit-tools.ts`) are thin wrappers.
- **Guard**: every op asserts target `question_block.status === 'draft'` (→ soft `status: 'skipped:not_draft'` output, not throw) and that node_id / asset_id exists in the block (reuse `idHasMatch`-style walk).
- **Provenance**: every touched structured node gets `source='agent_edit'` + `last_modified_by=<callerActor.ref>`.
- **Concurrency**: `block.version` bump on every write; SELECT `.for('update')` inside the tx (mirrors B1b revert).
- **SSE trail**: `writeJobEvent(tx, { event_type: 'block.structured_edited' | 'figure.reassigned', ... })` so the ingestion SSE timeline live-updates (consistent with the figures PATCH).
- Soft failures (not-draft / node-not-found / merge-cross-session) → valid Output with `status: 'skipped:*'`. Hard/unexpected → throw (bridge records `error_reason`).
- Tests live in the **db partition** (write tools use `ctx.db`); `vitest.shared.ts` fastTestInclude is NOT extended for these. `allowlists.test.ts` snapshot MUST be updated.

## 4. Tool contracts

### 4.1 updatePrompt
`{ block_id, node_id, prompt_text }` → walk block.structured, set `node.prompt_text`, provenance, version bump, jobEvent. Output `{ status: 'written'|'skipped:not_draft'|'skipped:node_not_found', block_id, node_id }`.

### 4.2 addOption
`{ block_id, node_id, option: { label, text } }` → append to `node.options` (create array if absent). Same output shape.

### 4.3 setQuestionType
`{ block_id, node_id, kind }` where `kind ∈ QuestionKind`. Adds a **new optional field** `kind?: QuestionKind` to `StructuredQuestion` (jsonb-internal — **no DDL migration, not an `audit:schema` business field**). Writes `node.kind = kind` as an **advisory hint** + provenance. **Import behavior is UNCHANGED in this PR** — the hint's consumer is the future OC-5 UI (redraw), which will pre-fill the import kind selector from it. (Keeps this PR zero-risk to the live import path.)

### 4.4 splitStem
`{ block_id, node_id }` — `node_id` must be a `stem` with ≥1 `sub_questions`. Replaces the stem in its parent position with its `sub_questions` **promoted to `role='standalone'`** (un-group), preserving order; provenance on each promoted node. Soft-skip if node is not a stem / has no subs (`status: 'skipped:not_splittable'`). Within-block only (no new block creation).

### 4.5 mergeQuestions
`{ primary_block_id, merge_block_ids: string[] }` — all blocks must share the same `ingestion_session_id` (else `skipped:cross_session`) and all be `draft`. Absorbs each merge-block's top-level structured nodes into `primary_block.structured` (appended), sets `primary.merged_from_block_ids += merge_block_ids`, marks each merge-block `status='ignored'`, version-bumps primary, jobEvents on all touched blocks. **Merges into an existing primary block — does NOT create a new block** (avoids block-lifecycle/ordering complexity).

### 4.6 reassignFigure
`{ block_id, asset_id, attached_to_index }` → the existing figures-PATCH logic as an agent-callable tool: validate `attached_to_index` exists in block.structured (`idHasMatch`), set the matching `block.figures[].{attached_to_index, attach_confidence:'manual', last_reassigned_at}`, version bump, jobEvent. Soft-skip if asset/target missing. **Refactor the route's core into the shared service and have both the PATCH route and this tool call it** (single owner; no logic duplication).

## 5. Registration

- `bootstrap.ts`: import + append 6 tools to `CORE_TOOLS`.
- `allowlists.ts`: add 6 names to `PROPOSE_WRITE_TOOLS`; add to a surface. New surface `ingestion_block_edit` (agent/user-triggered question correction) OR fold into an existing user-triggered surface. Decision: **new surface `ingestion_block_edit`** (keeps blast radius explicit; copilot/dreaming/coach do NOT get question-mutation by default).
- `allowlists.test.ts`: update `PROPOSE_WRITE_TOOLS` snapshot + add the new surface's expected set.
- registry test: prove all 6 registered + summarized.

## 6. Out of scope (this PR)

OC-5 review UI (→ YUK-169 redraw); Copilot/drawer wiring; import kind-source change; auto-enroll flag flip; cross-block split (new-block creation). setQuestionType import consumption is redraw-time.
