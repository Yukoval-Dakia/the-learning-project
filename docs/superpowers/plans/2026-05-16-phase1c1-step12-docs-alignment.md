# Phase 1c.1 Step 12 — docs alignment (architecture.md + CONTEXT.md final pass)

> Step 12 ("docs — architecture.md + CONTEXT.md provisional → final") expansion. Parent plan §Step 12.
>
> **Prerequisites**: Step 9 merged (DROP migration in place; codebase has zero live legacy table writes). PR chain #47-#52 merged or on `phase1c1-step9-prep`.
>
> **Scope**: Promote `event` + `learning_session` + `knowledge_mesh` to canonical entities in docs. Remove "mistake 是学习记录核心" framing. Acknowledge `echo_jobs` + `/api/echo` as pg-boss dev harness (closes issue #34 finding 2). Pure documentation work — **no code changes**.

---

## File audit (current state)

- `docs/architecture.md` — 17 legacy term references (mistake/encounter/review_event/dreaming_proposal/ingestion_session)
- `CONTEXT.md` — 8 legacy term references
- `README.md` — 0 references (no work)

---

## Per-file changes

### `docs/architecture.md`

1. **"录入会话状态机" 章节** (Section "二" likely) → rename header to "学习会话 (LearningSession) 多态状态机". Body updates:
   - Note 6 session types (ingestion / review / tutor / explore / create / conversation; Phase 1c.1 implements 2)
   - Reference `src/server/session/` single-owner module + `learning_session` table
   - Reference `src/core/schema/learning_session.ts` for per-type status state machines
   - Reference ADR-0008 + ADR-0005 evolution

2. **Add "event — first-class action log" section** (new section, likely after the knowledge graph section):
   - Equal-actor model: `user | agent | cron | system`
   - Schema reference: `event` table in `src/db/schema.ts`; Lane B Zod in `src/core/schema/event/`
   - Single-owner: `writeEvent` from `src/server/events/queries.ts`
   - parseEvent guard at write time; KnownEvent union covers 11 (action × subject_kind) shapes + ExperimentalEvent
   - Causal chain: `caused_by_event_id` (judge ← attempt, propose ← cron, etc.)
   - Reference ADR-0006 v2 + ADR-0011

3. **Add "knowledge_mesh — tree + edge" section** (after event log section):
   - `knowledge` table = tree backbone (parent_id FK)
   - `knowledge_edge` table = typed lateral mesh (per ADR-0010 — 5 relation_types: prerequisite / related_to / contrasts_with / applied_in / derived_from; experimental:* namespace)
   - Single-owner: `src/server/knowledge/edges.ts`
   - propose path: `ProposeKnowledgeEdge` event → user accept → `GenerateKnowledgeEdge` event + table INSERT
   - Reference ADR-0010

4. **Remove "mistake 是学习记录核心" framing**:
   - 17 references to scan; replace with "event (action='attempt') is the unit of attempt" framing
   - Where the word "错题" appears in user-facing context (UI / API names), preserve (user semantics stable per ADR-0006 v2 banner)
   - Where it appears in model/architecture context, replace with event-stream terminology

5. **§5.1 task table** (Step 7 already updated to event-stream framing — but verify; Step 7 redid `descriptions` only partially per its out-of-scope note)

6. **§5.x section "Sub 0c"** (if exists) — add note that `echo_jobs` + `/api/echo` are **pg-boss dev harness** (not production feature). Reference Sub 0c plan as historical context. Closes #34 finding 2.

### `CONTEXT.md`

1. **"已批准" section** — remove all "待 Phase 1c.1 落地" trailing markers (those statuses are now landed)

2. **"错题（mistake）" entry** → rewrite as:
   > **错题 / 失败 attempt**: `event WHERE action='attempt' AND subject_kind='question' AND outcome='failure'`. UI 保留"错题"称呼；底层数据模型是 event 流上的 filter view。归因 (cause) 走 chained judge event。

3. **"复习（review）" entry** → reference `event WHERE action='review' AND subject_kind='question'`; FSRS state derived to `material_fsrs_state`

4. **"归因（attribution）" entry** → reference `event WHERE action='judge' AND subject_kind='event' AND actor_kind='agent'`; chained via `caused_by_event_id` to the attempt event

5. **"梦境流 (Dreaming) / 维护流 (Maintenance)" entries** → reference `event WHERE action='propose' AND actor_kind='agent' AND actor_ref='dreaming'` (for proposals)

6. **Delete v1 dictionary entries** that are explicitly superseded (annotated as "v1 — superseded by v2" or similar in current text)

### `README.md`

No legacy term references — but verify the stack overview / commands sections still reflect post-1c.1 reality. Mostly a no-op; spot-check for outdated mentions of `mistake` as the central entity.

---

## TDD substep breakdown

4 substeps (Step 12 is mostly mechanical docs editing).

### 12.A — architecture.md "录入会话状态机" rename + LearningSession section

- **12.A.1** (red): grep `docs/architecture.md` for "录入会话状态机" → assert ZERO hits after the edit (or "已演化为 LearningSession 多态" reference instead)
- **12.A.5** (commit): `docs(1c.1 Step 12): architecture.md — LearningSession multi-type section (ADR-0008 canonical)`

### 12.B — architecture.md add event + knowledge_mesh sections + remove mistake-core framing + echo_jobs追认

- **12.B.1** (red): grep `docs/architecture.md` for:
  - new section anchors: "event — first-class action log", "knowledge_mesh"
  - removed "mistake 是" framing (should be 0 hits)
  - new `echo_jobs` mention with "pg-boss dev harness" context
- **12.B.5** (commit): `docs(1c.1 Step 12): architecture.md — event log + knowledge_mesh sections + echo_jobs harness ackn (closes #34 finding 2)`

### 12.C — CONTEXT.md final pass

- **12.C.1** (red): grep `CONTEXT.md` for:
  - "待 Phase 1c.1 落地" → 0 hits
  - "错题（mistake）" entry contains "event WHERE action='attempt'"
  - "复习" / "归因" entries reference event filters
  - v1 superseded entries removed
- **12.C.5** (commit): `docs(1c.1 Step 12): CONTEXT.md — event-stream filter views replace legacy table entries`

### 12.D — Audit: legacy terms only in historical contexts

- **12.D.1** (red): pure-Node fs walker test (mirror Step 9 pattern) that scans `docs/architecture.md` + `CONTEXT.md` + `README.md` for any remaining live use of `mistake` / `review_event` / `dreaming_proposal` / `ingestion_session` in active body text (NOT in ADR-cross-reference, footnote, or historical "v1" section). Allowed if explicitly bracketed as historical.
- **12.D.5** (commit): `test(1c.1 Step 12): docs invariant — legacy terms only in historical/ADR contexts`

---

## Locked contract

- **Pure documentation work** — no code/schema/test changes. The "tests" in 12.A-12.D are grep-style assertions on markdown content (use a single Node-based test file, e.g., `tests/integration/step12-docs-invariant.test.ts`).
- **User-facing "错题" copy preserved** in architecture sections that describe user UI. Model/architecture-level descriptions use event-stream terminology.
- **ADR references kept as historical**: when architecture.md references ADRs, the old terminology in that ADR's title (e.g., ADR-0005 "IngestionSession single-owner") stays unchanged — it's historical.
- **Closes #34 finding 1** (artifact comment — already done in Step 9.H) + **Closes #34 finding 2** (echo_jobs追认 — done in 12.B).
- 4 separate commits, conventional `docs|test(1c.1 Step 12): ...`. Each ends with:
  ```
  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  ```

---

## Subagent prompt

```markdown
You are executing Phase 1c.1 Step 12 of the-learning-project. Worktree-isolated. Pure docs work — no code changes.

## BOOTSTRAP

```bash
git fetch origin
git merge origin/phase1c1-step12-prep --ff-only
```

Verify: `ls docs/superpowers/plans/2026-05-16-phase1c1-step12-docs-alignment.md`, `ls docs/architecture.md CONTEXT.md`.

## Authoritative spec

`docs/superpowers/plans/2026-05-16-phase1c1-step12-docs-alignment.md` — read in full.

## Required reading

1. `CLAUDE.md`
2. `docs/superpowers/plans/2026-05-16-phase1c1-step12-docs-alignment.md` (authoritative)
3. `docs/architecture.md` (full read — you edit ~17 reference points)
4. `CONTEXT.md` (full read — you edit ~8 reference points)
5. `README.md` (verify no edits needed)
6. ADR-0005, 0006 v2, 0008, 0010, 0011 (cross-reference targets)
7. `src/db/schema.ts` — confirm only `event`, `learning_session`, `knowledge_edge` are the entities to promote
8. Issue #34 on GitHub — for echo_jobs追认 wording

## Locked contract

- **No code changes.** Only `docs/architecture.md`, `CONTEXT.md` (and optionally `README.md` if you find latent references).
- **User-facing "错题" copy preserved** in user-UI/API context. Model/architecture-level descriptions use event-stream terminology.
- **Don't edit ADR files** — those are historical records.
- **4 separate commits**, conventional `docs|test(1c.1 Step 12): ...`. Each ends with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

## Implementation guidance

- **Mechanical search-and-replace passes**: grep `mistake` / `encounter` / `review_event` / `dreaming_proposal` / `ingestion_session` first; categorize each hit (replace / preserve as ADR ref / preserve as user-facing copy). Hand-edit each — don't blindly sed.
- **architecture.md "event" section** should be ~30-50 lines: schema reference + parseEvent guard + chain (caused_by) + single-owner. Mirror existing section style.
- **architecture.md "knowledge_mesh" section** ~20-30 lines: tree + edge model; 5 relation_types listed.
- **CONTEXT.md "错题" entry**: keep the term in the entry header (user familiarity), then redefine as event filter.
- **12.D invariant test**: simple Node fs.readFile + regex scan; whitelist patterns: "ADR-0005", "see #34 historical", "v1 (superseded)" etc. Build the allowlist iteratively while drafting.

## Out of scope

- Code/schema/test changes
- ADR file edits
- Migration scripts
- Anything in `src/`, `app/`, `tests/` except the one new invariant test (`tests/integration/step12-docs-invariant.test.ts`)

## Verification gates

- `pnpm typecheck` green (should be no-op — no code changes)
- `pnpm test` full suite green (Step 9 baseline 635 + 1 new invariant test = 636)
- `pnpm test tests/integration/step12-docs-invariant.test.ts` green
- `pnpm lint` no new errors
- Grep audits:
  - `grep "录入会话状态机" docs/architecture.md` → 0 hits (renamed)
  - `grep "mistake 是" docs/architecture.md` → 0 hits
  - `grep "待 Phase 1c.1 落地" CONTEXT.md` → 0 hits
  - `grep "echo_jobs.*pg-boss dev harness" docs/architecture.md` → at least 1 hit (acknowledgment)
- 4 commits, conventional format

## Return (under 500 words — Step 12 is small)

1. Branch name
2. 4 commit hashes + subjects
3. Verification gate outputs (final line each)
4. Diff summary: counts of lines added/removed in each file
5. Edge cases (esp. tricky judgment calls between "replace with event-stream framing" vs "preserve as user UI copy")
6. Out-of-scope discoveries (if any)
7. Outstanding risks for Step 13 (PR + deploy)
```

---

## Risks

- **Translation drift**: docs are mixed CN/EN; preserve mode (CN-leaning per project style). Don't translate user-facing terms across languages mid-edit.
- **ADR references vs ADR content**: ADR-0005 title says "IngestionSession single-owner" (historical). When architecture.md cites it, the ADR title stays. When architecture.md describes its content, use the evolved naming (LearningSession).
- **echo_jobs追认 wording**: should match the prior drift-finding context (PR #33/34/35). Subagent should briefly grep issue #34 + the audit reports for the exact wording.
- **CONTEXT.md format**: project may have specific markdown style for entries (e.g., bold term + colon + body). Mirror the existing pattern.

---

## After Step 12

Step 13 = PR + merge sequence:
- All PR chain (#47 → #48 → #49 → #50 → #51 → #52 → #53 [Step 12]) merges to main in order
- Optional: deploy to NAS following Step 8.D runbook (manual maintenance window)

Phase 1c.1 complete after Step 13.
