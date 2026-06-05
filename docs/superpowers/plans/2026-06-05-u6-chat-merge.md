# U6 — Merge Three Chat Surfaces Into Copilot (AF S4) Implementation Plan

> Authority chain: `docs/superpowers/specs/2026-06-04-agent-framework-design.md` §1.1/§1.3/§3.1 + S4 (:516-536) + `docs/design/2026-06-04-u0-decisions.md` D10 (:49-53). Conflicts with spec prose resolve to u0-decisions (u0-decisions:4).
> Snapshot: `/tmp/u6` = `yuk-203-u6` @ `6a399760` (deps installed). Every `file:line` below was re-verified against this snapshot at plan time — **not trusted from the Map alone** (the Map carries two stale anchors, corrected in §0.1).
> Map input: `/tmp/u6-map.md` (five-dimension recon — red-lines R1-R8, three-surface table, five design forks, fourteen OQs).
> Orchestrator rulings: OQ1=C, OQ2=B2, OQ3=explicit-minimal-ref, OQ4=entry re-point, OQ5=budget-untouched, OQ6=backend-only solve absorption, OQ10/OQ11 out of scope. This plan adjudicates OQ7/8/9/12/13/14 (§9) and may not reopen the orchestrator's rulings.
> Scope guard: **zero net-new tables; zero new DomainTool; zero change to `COPILOT_TOOLS` / surface allowlists (R5)**. One additive optional field on the chat request schema (`skill_context`). One stale system-prompt rewrite. One UI entry re-point. Legacy teaching/solve routes stay live in parallel (R3).

---

## 0. Background

AF S4 is the **last** and **XL** slice of the agent-framework sequence. Its job is not to build new infrastructure — it is to make **Copilot the single user-facing conversational agent** (AF §1.1) by absorbing the *turn behaviors* of two other chat surfaces (Active Teaching + SolveTutor) as **Copilot skills** (AF §1.3 — behavior packs, not tool switches), moving the user-facing entry to Copilot, while three protective constraints keep the KPI accounting, the raw `ask_check` INSERT, and the legacy routes intact (AF S4 :527/:529/:531).

The merge target is **three** chat surfaces, not two (AF S4 :518-522, D10 :52):

1. **Active Teaching** — `TeachingTurnTask` single-turn structured JSON (`explain`/`ask_check`/`end` + `structured_question` payload), per-page `TeachingDrawer`, sole entry at `learning-items/[id]/page.tsx:331` 「对话教学」.
2. **SolveTutor** (YUK-193) — reuses `TeachingTurnTask` for escalating hints (`planSolveHint`, `src/server/orchestrator/solve.ts`), `type='tutor'` session with the heavier `active→submitted→judged` state machine; `SolveTutorPanel` is an orphan component with no live mount.
3. **Copilot** — `CopilotTask`, the only agentic tool-loop chat; global `CopilotDock` (S0 composer, shipped U3); `type='conversation', entrypoint='copilot'` session.

### 0.1 R8 readiness check — landed account (corrected against source)

U6 has a hard prerequisite gate (AF S0 + D10 + Map R8): U3 + U4 must both ship and the S0 composer must be real. **All satisfied** as of `6a399760`:

- **U3 ✅ shipped** (PR #297/#294/#296, status.md:16,270) — Copilot de-Today-ified into `CopilotDock`; `learning_session(type='conversation', entrypoint='copilot')` envelope + `experimental:copilot_reply` + `GET /api/copilot/turns` replay; `findOrCreateCopilotConversation` reuse predicate landed.
- **U4 ✅ shipped** (PR #298, status.md:17,271) — `search_memory_facts` DomainTool (granted `coach`/`dreaming`/`copilot`) + D6 judge version stamping.
- **S0 composer = real** ✅ — **the Map's anchor is stale.** Map §0/§7/R8 cite a placeholder at `TodayCopilotDrawer.tsx:107-109`. **Verified at plan time: `TodayCopilotDrawer` no longer exists anywhere in the repo** (`grep -rn TodayCopilotDrawer` → zero hits). The S0 composer shipped as `src/ui/copilot/CopilotDock.tsx` (header comment: `AF Slice 0 / YUK-169 — global Copilot drawer with live chat`; real `textarea` composer + message list + live POST `/api/copilot/chat`, lines 251-274). **Ruling (R8 stale-placeholder disposition):** there is nothing to "delete vs leave for cut-over" — the placeholder is already gone. The orchestrator's "TodayCopilotDrawer 占位是 stale legacy" instruction is **resolved by prior work**; this plan records the correction and touches no such file.
- **`active_ref` channel (S2b) — NOT landed.** Verified: `grep -rn 'active_ref\|CurrentUserContext'` over `src/` returns zero hits. S2b's full `CurrentUserContext` envelope was never built. **This is expected** and is exactly why OQ3 is ruled "explicit minimal ref" (§3.3) rather than "consume S2b active_ref": U6 ships the **forward-compatible seed** of S2b's `active_ref`, not the full envelope.

### 0.2 Map anchor corrections (verified at plan time)

| Map claim | Verified reality | Source |
|---|---|---|
| placeholder at `TodayCopilotDrawer.tsx:107-109` | file deleted; S0 composer = `CopilotDock.tsx` | grep zero-hits + `CopilotDock.tsx:1-13` |
| `ask_check` INSERT at `turn/route.ts:99-153` | INSERT at `turn/route.ts:99-110` (`if turn.kind==='ask_check' && turn.structured_question` → `tx.insert(question)`) | `app/api/teaching-sessions/[id]/turn/route.ts:99-110` |
| stale `/today drawer` text at `registry.ts:468,488` | confirmed exact | `src/ai/registry.ts:468,488` |
| learning-items button at `:329` | button label at `:331`, RED-LINE comment at `:329` | `app/(app)/learning-items/[id]/page.tsx:329,331,574` |

The rest of the Map's anchors (conversation.ts reuse predicate `:113-159`, `COPILOT_TOOLS` `:97-208`, accept-chip route, `getActiveQuestionState`) were spot-checked and verified accurate.

---

## 1. Scope

In scope for U6:

1. **Teaching skill (service-layer composition, OQ2=B2)** — a `teaching-skill` module under `src/server/copilot/skills/` that, for a teaching-context turn, **composes** a call to the existing `TeachingTurnTask` (preserving its single structured `ask_check`/`explain`/`end` contract + `structured_question` carrier) and renders the structured output as a Copilot reply + chips. `TeachingTurnTask` stays a **narrow internal task**; it does **not** enter the `CopilotTask` LLM tool loop and does **not** enter the tool surface (R2/R5 double-guard).
2. **Solve skill (backend-only behavior absorption, OQ6)** — a `solve-skill` path that provides the escalating-hint capability (`planSolveHint`-equivalent: question face + reference solution + prior-attempt summary as context) inside a Copilot turn. **No `SolveTutorPanel` mount, no `/questions` UI, no change to the tutor state machine** (`type='tutor'` untouched, R3). Orphan-panel disposition deferred to cut-over (§2 non-goals).
3. **Chat request `skill_context` (OQ3=explicit-minimal-ref)** — `CopilotChatRequest` (`src/server/copilot/chat.ts:60`) gains an optional `skill_context: { skill: 'teaching' | 'solve', ref: { kind, id } }`. This is the **forward-compatible seed** of S2b's `active_ref` (documented as such inline). `runCopilotChat` routes to the matching skill when `skill_context` is present; absent → unchanged free-form Copilot behavior.
4. **Session model (OQ1=C)** — the merged teaching/solve behavior runs **inside Copilot's own `conversation` session** (`entrypoint='copilot'`, `goal_id=null` invariant unchanged). The per-turn `skill_context` carries the ref; the session goal is **not** repointed. Legacy teaching routes continue to write their own `entrypoint=null, goal_id=learning_item_id` conversation session in parallel (R3). The isolation guardrail (the reuse predicate's `entrypoint='copilot'` filter) gets **zero change** — this is the deliberate avoidance of HIGH risk #3.
5. **UI entry re-point (OQ4)** — `learning-items/[id]/page.tsx:331` 「对话教学」 button changes from opening `TeachingDrawer` to opening `CopilotDock` with a `teaching` `skill_context` (the learning_item id as ref). `TeachingDrawer` and its routes stay in parallel, **not deleted, not edited** this phase (R3).
6. **Stale prompt-identity rewrite** — `CopilotTask` `description`/`systemPrompt` (`registry.ts:468,488`) rewritten from `/today drawer` framing to the global teach/solve/explain agent identity.

### Non-goals (explicit — do not build)

- **No new tables, no schema migration.** U6 is behavior + entry + one optional Zod field. (If the impl lane finds it wants a new column, that is a signal it has left scope — stop and surface.)
- **No new DomainTool; no change to `COPILOT_TOOLS` or the surface allowlist map** (R5 — skills are behavior packs, not tool switches). `ask_check` INSERT and corrective-chip stay off the Copilot tool surface (R2/R1).
- **No tutor state-machine change; no `type='tutor'` retirement** (R3). Solve absorption is backend-only (OQ6).
- **No `SolveTutorPanel` mount and no `/questions/[id]` route build.** The orphan panel's disposition (mount-then-merge vs delete) is **deferred to cut-over** (OQ6 ruling; orphan stays as-is).
- **No legacy teaching/solve route deletion** (R3, AF §8 non-goal "Replacing all existing routes at once"). The 「对话教学」 NavItem/route stays in `ROUTE_MAP`; only the button's *target* changes.
- **No cut-over retirement standard** (OQ11 = defer; D10/AF leaves the migration-window length undefined — a closeout Linear issue, §11).
- **YUK-211 (beacon 401)** out of scope (OQ10 = YUK-211 fixes it independently).
- **No streaming / tool-card surfacing rebuild** (Map MED risk — `/api/copilot/chat` stays non-streaming; the teaching structured turn renders as a final reply, see §4.1 envelope ruling). Step-by-step tool-card visibility stays deferred per the existing Copilot stage gate.
- **No history backfill** — the `conversation` envelope does not retroactively absorb old Active Teaching sessions (Map OQ14; out of scope, §9).
- **No per-skill budget axis** (OQ5 = budget untouched; `COPILOT_CONTEXT_BUDGET` stays surface-keyed, and the teaching-skill `TeachingTurnTask` call is a **service-layer call, not a tool call**, so it does not consume the tool-call budget — see §4.4).

---

## 2. Red lines (plan may not cross — Map §7 verified against source at plan time)

- **R1 — corrective-chip stays on its own endpoint; KPI accounting separated.** The `accept-chip` writer (`app/api/teaching-sessions/[id]/accept-chip/route.ts`, writes `action='accept_suggestion'`, KPI-excluded per the §5.2 reader) is **not** moved onto Copilot chat and **not** edited. When teaching runs inside a Copilot turn, an accept-chip click still posts to this endpoint with the **teaching session id the skill resolves** (§4.5 OQ8). Verified: the route keys session by `[id]` path param + `Conversation.assertActive`.
- **R2 — `ask_check` raw INSERT keeps a narrow service path, off the Copilot tool surface.** `tx.insert(question)` (`turn/route.ts:99-110`) stays a service-layer DB write reachable only through the teaching-skill's `TeachingTurnTask` composition, **never** registered as a DomainTool, **never** in `COPILOT_TOOLS`. Raw DB mutation is an AF §1.2 non-capability. Verified the INSERT is gated on `turn.kind==='ask_check' && turn.structured_question`.
- **R3 — legacy routes run in parallel during the migration window.** `teaching-sessions/*` (5 routes) + `questions/[id]/solve/*` (3 routes) stay live and **unedited**; the `TeachingDrawer` component stays mounted-capable; the merge re-points only the *user-facing entry*. No cut-over this phase (AF §8 non-goal).
- **R4 — memory never biases judgement; never directly mutates due/mastery/FSRS.** Solve judging stays on the memory-denied `invoker.ts` path (`createDefaultJudgeInvoker`), **not** inside a memory-bearing Copilot turn. The solve-skill provides *hints* (memory-eligible context) but **must not** route grading through the Copilot turn. Verified: judge runs via the routed invoker; memory tools (`search_memory_facts`/`query_memory_brief`) are denied to evaluator paths (`allowlists.ts:158-164`).
- **R5 — skills do NOT change the Copilot tool permission boundary.** `COPILOT_TOOLS` (`allowlists.ts:97-110`) and the `DomainToolSurface` map (`allowlists.ts:207-208`) are **byte-for-byte unchanged**. A `skill_context` selects a *prompt/context pack*, never a different tool allowlist (AF §1.3). The surface stays `'copilot'` for chat / `'copilot_user_suggested_mistake_action'` for chip — `skill_context` does not add a surface.
- **R6 — `search_memory_facts` stays coach/dreaming/copilot only.** Granting teaching/solve memory access happens **only** because they now run *as the copilot surface* (which already holds it). No teaching/solve-specific memory grant; the deny-list (`allowlists.ts:158-164`, judge/tagging/structure/attribution/verification + ReviewPlan/QuizGen/KnowledgeReview) is unchanged and its `.not.toContain` tests stay green. The teaching-skill `TeachingTurnTask` call runs with `allowedTools:[]` (registry.ts:408) — it gets **no** memory even inside the copilot turn (it is a separate narrow task invocation, §4.4).
- **R7 — ADR-0005 single-owner.** `conversation.ts` owns `learning_session(type='conversation')` writes; `tutor.ts` owns `type='tutor'`. The merge writes **only** through `conversation.ts` (the copilot session) for the merged surface; it does **not** cross-write a tutor session from the copilot path, and does **not** have the copilot path write a teaching `entrypoint=null` session. Verified: `conversation.ts:159` `findOrCreateCopilotConversation` is the sole copilot-session writer.
- **R8 (prerequisite gate) — satisfied** (§0.1): U3 + U4 shipped; S0 composer real; S2b `active_ref` deliberately not required (OQ3 seeds it).

---

## 3. Design forks — orchestrator rulings + this plan's adjudications

### 3.1 Session model (OQ1 = C) — orchestrator-fixed

The merged teaching/solve behavior runs **inside Copilot's own `conversation` session** (`entrypoint='copilot'`, `goal_id=null`), carrying the ref **per-turn** via `skill_context` rather than repointing the session goal. Legacy teaching writes its own parallel `entrypoint=null, goal_id=learning_item_id` session (R3). **The reuse predicate (`conversation.ts:113-159`) gets zero change** — its `entrypoint='copilot'` filter + `goal_id=null` invariant continue to isolate Copilot reuse from teaching sessions, dodging HIGH risk #3 (silent wrong-session capture) entirely. Solve's `type='tutor'` state machine is untouched (it is the heaviest, and migration-window parallelism (R3) requires it live anyway).

### 3.2 Task kind (OQ2 = B2) — orchestrator-fixed

`TeachingTurnTask` is **retained as a narrow internal task**. The teaching-skill **composes** a call to it at the **service layer** (preserving the single structured `ask_check`/`explain`/`end` contract + `structured_question` carrier + the solve hint reuse), and renders the structured output as a Copilot reply + chips. It does **not** enter the `CopilotTask` LLM tool loop and does **not** enter the tool surface (R2/R5). This dodges CRIT risk #2 (the task-kind-convergence trap: `needsToolCall:false/maxIterations:1` structured JSON has no natural home in the `maxIterations:6` free-form tool loop).

### 3.3 Skill discrimination (OQ3 = explicit minimal ref) — orchestrator-fixed

No full S2b `CurrentUserContext`. `CopilotChatRequest` gains optional `skill_context: { skill: 'teaching'|'solve', ref: { kind, id } }`. The entry button opens the Dock with this parameter. **This is the forward-compatible seed of S2b's `active_ref`** (the future `CurrentUserContext.active_ref` will subsume it) — documented inline with that note. This plan **names the field** `skill_context` (orchestrator left naming to the planner); the `ref` shape `{ kind, id }` matches the existing `leave_agent_note` ref shape (`AF §4` `refs: Array<{kind, id}>`) for vocabulary consistency.

### 3.4 UI absorption (OQ4 = entry re-point) — orchestrator-fixed

`learning-items/[id]/page.tsx:331` button re-points to open `CopilotDock` + `teaching` `skill_context` (learning_item id as ref). `TeachingDrawer` + its routes stay in parallel (R3, untouched this phase). No drawer-in-drawer component merge.

### 3.5 Solve range (OQ6 = backend-only) — orchestrator-fixed

solve-skill provides hint capability (question face + reference + prior-attempt summary as context). No `SolveTutorPanel`, no `/questions` UI, no tutor state-machine change. Orphan panel left for cut-over.

### 3.6 Budget (OQ5 = untouched) — orchestrator-fixed

`COPILOT_CONTEXT_BUDGET` unchanged; the teaching-skill's `TeachingTurnTask` call is a **service-layer call, not a tool call**, so it does not consume the tool-call budget. **Lightweight-cap flag for critic (§10):** the teaching-skill composes a *second* model call per Copilot turn (the `TeachingTurnTask` invocation) on top of the copilot turn's own budget. This is a *cost/latency* concern, not a tool-budget concern — see §4.4 for the proposed soft guard.

---

## 4. Lane partition + file manifest + acceptance

Two lanes, chain-merged into `yuk-203-u6` (single PR — U-sequence convention).

- **L-copilot-skills [backend]** — `skill_context` Zod field on `CopilotChatRequest`; the `teaching-skill` + `solve-skill` service modules (compose `TeachingTurnTask` / `planSolveHint` context); `runCopilotChat` skill routing; the stale prompt-identity rewrite; the structured-turn → reply+chips render contract. Owns all `src/server/copilot/**`, `src/server/orchestrator/**` (read-only reuse), `src/ai/registry.ts` (prompt rewrite only). **Ships first** — it is the contract the UI lane's entry button targets.
- **L-teaching-entry [frontend]** — re-point `learning-items/[id]/page.tsx:331` button to open `CopilotDock` + `skill_context`; thread the open-with-skill-context affordance through `CopilotDock` (it is currently zero-param, `CopilotDock.tsx:94`). Depends on L-copilot-skills' chat-request contract. **Ships second**, rebased on merged L-copilot-skills. **UI action is small** — see §5 design pre-flight (no new loom page; reuses existing Dock chrome).

**Sequencing**: L-copilot-skills → L-teaching-entry. Non-overlap: L-teaching-entry touches only `app/(app)/learning-items/[id]/page.tsx`, `src/ui/copilot/CopilotDock.tsx`, and any small open-Dock state glue; L-copilot-skills touches `src/server/copilot/**`, `src/server/copilot/skills/**` (new), `src/ai/registry.ts`. The only shared concern is the `skill_context` request shape — **defined in L-copilot-skills** (it is the backend contract; the UI lane consumes it), so zero file-overlap chain-merge conflict.

### 4.1 `skill_context` request field + structured-turn envelope (OQ3, R5)
- **MODIFY** `src/server/copilot/chat.ts:60` (`CopilotChatRequest`) — add `skill_context: z.object({ skill: z.enum(['teaching','solve']), ref: z.object({ kind: z.string().min(1).max(40), id: z.string().min(1).max(120) }) }).optional()`. Verified current schema = `{ user_message, triggered_by, chip_kind? }` (`chat.ts:60-67`). Additive optional → every existing request still parses (back-compat).
  - **Inline comment (mandatory)**: document that `skill_context` is the **forward-compatible seed of S2b's `active_ref`** (AF §1.4 `CurrentUserContext`), to be subsumed when S2b lands; and that it selects a **prompt/context pack only, never a tool surface** (R5).
- **Envelope ruling (OQ-related, structured-turn rendering)**: the non-streaming `/api/copilot/chat` returns `{ reply, surface, triggered_by, ... }` text-only (`CopilotChatResponse`, `chat.ts:59-67`). The teaching skill's structured turn (`{kind, text_md, suggested_next}`) renders as: `reply = text_md`; the `ask_check` `structured_question` + `suggested_next` chips ride an **additive optional** response field `skill_turn?: { kind, structured_question?, suggested_next? }` so the existing text-only consumers are unaffected and the Dock can render chips when present. **No streaming, no tool-card rebuild** (non-goal). This is the minimal structured carrier; it does **not** make the structured turn a tool call.
- **Acceptance**: a chat request with no `skill_context` is byte-for-byte unchanged behavior; a request with `skill_context.skill='teaching'` routes to the teaching skill; a malformed `skill_context` (bad `skill` enum) is rejected by Zod. `skill_turn` is absent for free-form chat replies.

### 4.2 Teaching skill (service-layer composition, OQ2=B2, R2/R5)
- **NEW** `src/server/copilot/skills/teaching-skill.ts` — given the teaching `skill_context.ref` (learning_item id) + the copilot session + the user message, it:
  1. loads the teaching context (`loadTeachingContext()` reuse — learning_item + first knowledge node + artifact body_blocks + parent hub summary; verified it exists in the teaching server module);
  2. composes a `TeachingTurnTask` call via `runAgentTask` (the same runner `runCopilotChat` already imports, `chat.ts:30`) with `allowedTools:[]` (registry.ts:408 — the task carries no tools, so **no memory, no tool budget consumed**, R6/OQ5);
  3. returns the structured turn `{kind, text_md, suggested_next, structured_question?}` to `runCopilotChat`, which renders it per §4.1.
- **`ask_check` narrow service path (R2, OQ7 ruling §9)**: when the structured turn is `ask_check` with a `structured_question`, the **question INSERT stays the existing narrow service path**. **OQ7 ruling: extract the INSERT into a service-layer function** `materializeAskCheckQuestion(tx, structured_question, ...)` co-located with the teaching server module and called by **both** the legacy `turn/route.ts:99-110` (refactor-in-place, behavior-identical) **and** the teaching-skill — **not** a new route, **not** a Copilot tool. Rationale: a shared service fn keeps one INSERT implementation (DRY) while keeping it off the tool surface (R2); a new route would fork the implementation; a Copilot tool would violate R2/R5. **Refactor discipline**: the legacy route's behavior must be byte-for-byte preserved (the extraction is pure motion); a regression test asserts the legacy turn route still INSERTs identically.
- **Corrective-chip session resolution (OQ8 ruling §9, R1)**: the teaching-skill, when running inside a Copilot turn, **does not move accept-chip onto Copilot**. The accept-chip click still posts to `accept-chip/route.ts` with a **teaching session id**. **OQ8 ruling**: the teaching-skill resolves/holds a teaching `learning_session(type='conversation', entrypoint=null, goal_id=learning_item_id)` session for the `ask_check` lineage (it must, because `ask_check` questions + corrective-failure counting + accept-chip KPI all live on the teaching session's event stream, R1/R2), **separate from** the Copilot `entrypoint='copilot'` session that carries the chat envelope. So a teaching turn inside Copilot writes to **two** sessions: the Copilot session (chat envelope, R7 via `conversation.ts`) and the teaching session (ask_check INSERT + accept_suggestion lineage, R1/R2 via the narrow service path). **This is the deliberate consequence of R1+R2+R3**: the KPI/INSERT machinery stays on its own session exactly as today; only the *chat reply surface* moves to Copilot. Both sessions are `type='conversation'` so R7 single-owner (`conversation.ts`) is not violated — both go through `conversation.ts` writers.
- **Active-question tracking (OQ9 ruling §9)**: `getActiveQuestionState` + `TEACHING_CORRECTIVE_FAILURE_N` + corrective chip live in **teaching-skill-internal state on the teaching session** (the event-derived `active_question_id` mechanism, `src/server/teaching/active-question.ts` — verified: no DB column, derived from turn/GET responses), **not** Copilot session-level state. **OQ9 ruling**: Copilot has no such mechanism and gains none; the teaching-skill reads it off its teaching session exactly as the legacy drawer does. This keeps the corrective-chip KPI accounting (R1) on the teaching session's event stream untouched.
- **Acceptance**: a teaching turn through the skill produces (a) a Copilot reply (`text_md`), (b) for `ask_check`, a real `question` row via `materializeAskCheckQuestion` on the teaching session, (c) `suggested_next` chips on the response. The legacy `turn/route.ts` INSERT is unchanged (refactor-equivalent regression test). No memory tool is invoked by the `TeachingTurnTask` call (`allowedTools:[]`).

### 4.3 Solve skill (backend-only absorption, OQ6, R4)
- **NEW** `src/server/copilot/skills/solve-skill.ts` — given the solve `skill_context.ref` (question id) + the user message, it provides the escalating-hint behavior:
  1. loads solve context — **question face (`prompt_md`) + reference solution (`reference_md`/`worked_solution`) + prior-attempt summary** (OQ12 ruling §9 — this is the context裁定: face + reference + prior attempts, matching what `planSolveHint` seeds today, `solve.ts`; **no knowledge-graph injection** in MVP — keep it minimal);
  2. composes a `TeachingTurnTask` hint call (the same reuse `planSolveHint` already does, verified `solve.test.ts:111` "returns a non-revealing hint via TeachingTurnTask") with `allowedTools:[]`;
  3. returns the hint as a Copilot reply.
- **R4 guard (load-bearing)**: the solve-skill provides **hints only**. **Grading/judging is NOT routed through the Copilot turn** — it stays on the memory-denied `invoker.ts` path on the tutor session. If the user wants to *submit* a solve attempt, that goes through the existing `questions/[id]/solve/submit` route (R3 parallel), **not** the Copilot turn. The solve-skill must not call the judge invoker. **Acceptance asserts** the solve-skill writes no judge event and invokes no grading path.
- **OQ6 non-goal restated**: no `SolveTutorPanel` mount, no tutor state-machine change. The `type='tutor'` session and its `planSolveHint` route stay live in parallel (R3).
- **Acceptance**: a solve `skill_context` turn returns a non-revealing hint (reuses the `solve.test.ts` non-reveal assertion shape); no judge event is written; no tutor session is mutated from the Copilot path (R7).

### 4.4 Skill routing in `runCopilotChat` (OQ5 budget, R5)
- **MODIFY** `src/server/copilot/chat.ts:195` (`runCopilotChat`) — after parsing `skill_context`, branch: `skill_context?.skill === 'teaching'` → `teaching-skill`; `'solve'` → `solve-skill`; else → existing free-form path (`chat.ts:237` `triggered_by==='chat'` branch, unchanged). The skill branches **do not** change `surface = selectSurface(req.triggered_by)` (`chat.ts:211`) — surface stays `'copilot'` (R5: skill ≠ surface). The `ContextBudgetTracker` (`chat.ts:291`) is constructed identically; the `TeachingTurnTask` service call inside a skill is **outside** the tool-call loop so it does not draw down the tool budget (OQ5).
- **OQ5 lightweight-cap proposal (flag for critic, §10)**: the teaching/solve skill composes a second model call per turn. Propose a **soft latency/cost guard**: the skill call inherits the task's own `budget.timeout` (registry.ts:405, 60_000ms) — no new budget axis, but document that a teaching skill turn = one copilot-envelope write + one `TeachingTurnTask` model call, so worst-case latency ≈ 2× a free-form turn. **Ruling: no per-skill budget (OQ5 untouched)**; this is a documented characteristic, not a new mechanism. If the critic deems it material, a follow-up YUK issue caps it — not this PR.
- **Acceptance**: `skill_context.skill='teaching'` routes through `teaching-skill` with `surface` still `'copilot'` (assert the allowlist is unchanged — `resolveDomainToolNames('copilot')` returns the same set); free-form chat (no `skill_context`) is unchanged.

### 4.5 Stale prompt-identity rewrite (Map LOW risk, R5)
- **MODIFY** `src/ai/registry.ts:468` (`CopilotTask.description`) — rewrite from `'Wave 5 / T-D3 — Copilot Drawer on /today...'` to the global teach/solve/explain/critique/plan/inspect agent identity (AF §1.1). Keep the two-surface allowlist note (it is still accurate).
- **MODIFY** `src/ai/registry.ts:488` (`CopilotTask.systemPrompt`) — rewrite the `'你是 Copilot 助手，在 /today drawer 内辅助用户'` opening to the global-agent framing. **Discipline**: the prompt's substantive policy (propose-only, proposal_feedback handling, suggestion_kind corrective/proactive rules) is **load-bearing and must be preserved verbatim** — only the `/today drawer` *identity framing* changes. Verify against `task-prompts.ts` (the comment at `registry.ts:483-486` says runtime renders via `getTaskSystemPrompt`; confirm whether the live prompt is here or in `task-prompts.ts` and edit the live one).
- **Acceptance**: no `/today` or `/today drawer` string remains in `registry.ts` Copilot entries (grep the diff); the propose-only + proposal_feedback + suggestion_kind policy text is unchanged (diff shows only identity-framing lines changed).

---

## 5. L-teaching-entry — design-doc pre-flight + file manifest + acceptance

### 5.1 Design-doc pre-flight (mandatory before any component code — CLAUDE.md UI Design Compliance)

**This phase's UI action is small** (Map: button re-point + Dock receives `skill_context` + teaching output renders). **Verbatim design-source citations**:

- **Entry re-point is the S4 absorption mechanism** — AF spec `2026-06-04-agent-framework-design.md:524-525` §S4:
  > "Convert their turn behaviors into Copilot skills and move the user-facing entry to Copilot..."
  and §1.1 (:56,60-62):
  > "replace the separate 'Active Teaching' user-facing chat surface" … "Teaching is a Copilot skill/state, not a separate product face."

- **The button to re-point** — `app/(app)/learning-items/[id]/page.tsx:329-331` (verified):
  > line 329: `{/* RED-LINE: teaching wiring preserved verbatim — AF S4 absorbs it. */}` ; line 331: `对话教学` button. This plan executes the "AF S4 absorbs it" the RED-LINE comment anticipated. The `TeachingDrawer` import (`:11`) and mount (`:574`) **stay** (R3 — legacy parallel); only the button's onClick target changes from open-TeachingDrawer to open-CopilotDock-with-skill_context.

- **The Dock to open into** — `src/ui/copilot/CopilotDock.tsx` (verified, S0 composer, `:1` `AF Slice 0 / YUK-169 — global Copilot drawer with live chat`): existing chrome = header + message list + quick-chips + composer (`:13` footer comment; `:251-274` composer). **Component-type: existing global drawer (route-less, app-shell mounted at `layout.tsx`).** No new loom page — **this re-uses the existing Dock chrome and styling; no new design稿 / no new visual page is needed**. The only new affordance is "open the Dock pre-seeded with a `skill_context` (and optionally a prefill message)". `CopilotDock()` is currently zero-param (`:94`) — the open-with-context channel is the only new wiring.

- **Teaching output rendering inside the Dock** — reuses the existing Dock message-list rendering (`:298` `copilot-loom` chat container) + quick-chips region (`:238` `chat-chips`). The `ask_check` `structured_question` + `suggested_next` chips render through the existing chip affordance (`skill_turn` response field, §4.1). **No new visual primitive** — chips already exist in the Dock footer.

**Component-type declarations**:
- The 「对话教学」 entry = **button re-point** (modify existing button in a route page; not a new component).
- `CopilotDock` open-with-`skill_context` = **prop/state addition to an existing drawer** (not a new drawer, not a new route, not a modal).
- Teaching turn rendering = **existing message-list + chips** (no new component).

**Files — CREATE vs MODIFY**:
- **MODIFY** `app/(app)/learning-items/[id]/page.tsx` — button `:331` onClick re-points to open `CopilotDock` + `skill_context={ skill:'teaching', ref:{kind:'learning_item', id} }`. `TeachingDrawer` import + mount **unchanged** (R3). Update the RED-LINE comment (`:329`) to record the absorption is now done (entry re-pointed; legacy drawer still parallel).
- **MODIFY** `src/ui/copilot/CopilotDock.tsx` — add the open-with-`skill_context` channel (zero-param → accepts an external open trigger carrying `skill_context` + optional prefill; the prefill path already exists per the `:26` comment "in-memory-only behaviour (no error surfaced for the prefill path)"). Thread `skill_context` into the `/api/copilot/chat` POST body (`:167-169`). Render `skill_turn` chips when present.
- **NEW (if needed)** a tiny shared open-Dock signal (e.g. a Zustand slice or context) if `CopilotDock` and the learning-items button are not already in a shared tree — **impl lane confirms** whether an existing open-Dock mechanism exists (the Dock is app-shell mounted; the button is in a route page, so a cross-tree open signal is likely needed). Keep it minimal (one store action `openCopilotWith(skill_context, prefill?)`).

### 5.2 UI acceptance
- The 「对话教学」 button opens `CopilotDock` (not `TeachingDrawer`) with a `teaching` `skill_context`; the Dock's first turn runs the teaching skill and renders the structured reply + chips.
- `TeachingDrawer` is still importable/mountable (R3 — grep the diff: no deletion of the import or mount).
- Free-form Copilot chat (open the Dock without the button) is unchanged.
- No `/today` framing visible in the Dock (covered by §4.5 prompt rewrite).

---

## 6. Risk coverage (Map CRIT/HIGH/MED — each has an action or is accepted/deferred)

| Level | Risk (Map §8) | Plan action |
|---|---|---|
| CRIT | Prerequisite-chain slip (S0/S2b/U3/U4) | **Resolved at readiness**: U3+U4 shipped, S0 composer real (§0.1); S2b not required — OQ3 seeds `active_ref` instead of consuming it. |
| CRIT | task-kind convergence trap (TeachingTurnTask vs CopilotTask loop) | **Resolved by OQ2=B2** (§3.2/§4.2): TeachingTurnTask stays a narrow internal task, composed at the service layer, never in the tool loop. Structured contract + `structured_question` carrier preserved. |
| HIGH | session isolation guardrail collapse (`entrypoint='copilot'` filter) | **Resolved by OQ1=C** (§3.1/§4.2): zero change to the reuse predicate; teaching/solve run in the Copilot session per-turn via `skill_context`, `goal_id=null` invariant intact; the teaching `ask_check` lineage stays on its own teaching session (§4.2 OQ8). |
| HIGH | first-time memory grant to teach/solve touching grading (R4) | **Resolved** (§4.2/§4.3, R4/R6): the `TeachingTurnTask` skill call runs `allowedTools:[]` (no memory even inside copilot turn); solve grading stays on the memory-denied `invoker.ts`, **not** in the Copilot turn; solve-skill writes no judge event. |
| HIGH | R1/R2 load-bearing paths mis-moved onto Copilot tool surface | **Resolved** (§4.2/§4.5, R1/R2/R5): `ask_check` INSERT extracted to a **service fn** (off the tool surface, shared with legacy route); accept-chip endpoint untouched; `COPILOT_TOOLS` byte-for-byte unchanged. |
| MED | three hand-rolled session lifecycles / double-own | **Accepted/bounded** (R7): the merge writes only through `conversation.ts` for the copilot session and the teaching session (both `type='conversation'`); it does **not** double-own a review/tutor session. No `useSessionLifecycle` extraction (not gated by S4 per Map §5). YUK-211 (beacon 401) is OQ10 = out of scope. |
| MED | "chip" concept conflation (§6.2) | **Resolved by design**: corrective `accept-chip` (KPI-excluded teaching endpoint, R1) is **not** the Copilot `triggered_by:'chip'` mistake-action surface. §4.2 keeps accept-chip on the teaching session/endpoint; §4.4 keeps the copilot surface routing on `triggered_by`. The `skill_turn` chips (§4.1) are UI suggestion chips, a third distinct thing — documented inline. |
| MED | submit/hint concurrency (`planSolveHint` session-not-active guard) | **Avoided** (OQ6/§4.3): solve absorption is hint-only; submit stays on the legacy route (R3). The Copilot turn never races the tutor `active→submitted` transition because it never submits. |
| MED | non-streaming text-only vs tool-card spec | **Accepted/deferred** (non-goal): `/api/copilot/chat` stays non-streaming; the structured teaching turn rides the additive `skill_turn` field (§4.1), not a tool-card rebuild. Step-by-step visibility stays deferred. |
| LOW | `SOLVE_MASTERY_THRESHOLD=0.7` hardcode | **Accepted** (policy gap, out of scope): solve-skill is hint-only and does not touch the mastery threshold; no change. |
| LOW | stale `/today drawer` copy | **Resolved** (§4.5): `CopilotTask` description/systemPrompt rewritten; policy text preserved. |
| LOW | practice page has no solve entry | **Out of scope** (non-goal): "做卷中途求助 Copilot" needs practice architecture change, not in S4. |

CRIT/HIGH coverage is complete; every Map risk has an action, accepted, or deferred line.

---

## 7. Gate checklist (pre-PR, per CLAUDE.md)

This PR has **no DDL** (no migration smoke needed beyond the standard gate) and builds **no new route page** but **modifies a route page + a global drawer** → visual ring required.

- `pnpm typecheck` — green.
- `pnpm lint` (biome) — green; touched-file format.
- `pnpm audit:schema` — **zero-delta** (no new table/column; no new allowlist entry; no `COPILOT_TOOLS` change).
- `pnpm audit:partition` — new `*.test.ts` in correct partition (skill service unit tests → unit when AI runner mocked; chat-route/teaching-skill DB tests → db).
- `pnpm audit:profile` — **zero-delta** (no new capability, no profile change — §9 OQ13).
- `pnpm test` — full gate (profile audit + unit + DB + migration-smoke).
- `pnpm build` — Next route export validation for the modified `learning-items/[id]` page + `/api/copilot/chat` route.
- **Visual ring** — playwright screenshot of: (1) the 「对话教学」 button opening `CopilotDock` (not `TeachingDrawer`); (2) **the teaching conversation flow inside the Dock** (a teaching turn rendered as a Copilot reply + `ask_check` chips), compared against the existing Dock chrome (no new loom source — the reference is the live Dock per §5.1) via visual-verdict. Per the dev-server port note: confirm which process holds :3000 before screenshotting (OrbStack container may serve a stale build on :3000; `pnpm dev` falls to :3001).
- **Dual-bot convergence criterion (now in process)**: P1 cleared to zero + final round all-P2 (edge nits) = converge; do not chase zero-findings (user correction 2026-06-05, recorded in status.md:18).

---

## 8. Lane partition: single PR (orchestrator U-sequence convention)

Single PR, two lanes chain-merged into `yuk-203-u6` (matching U3/U4/U5). L-copilot-skills (backend, the chat-request + skill contract) ships first; L-teaching-entry (frontend, the button re-point) rebases on it and ships second. A two-PR split buys nothing here — there is no DDL to isolate (the highest-risk artifact in U5); the backend skill contract is browser-testable only with the UI consumer, so splitting would make L-copilot-skills write-only-untestable (the same R11 problem U5 cited). **Single PR.**

---

## 9. OQ7/8/9/12/13/14 adjudications (planner's core value — one line each + rationale)

- **OQ7 (ask_check service shape)**: **extract a service-layer fn `materializeAskCheckQuestion(tx, structured_question)`** shared by the legacy `turn/route.ts:99-110` (refactor-in-place, behavior-identical) and the teaching-skill. NOT a new route (would fork the impl), NOT a Copilot tool (violates R2/R5). Rationale: one INSERT impl, off the tool surface, regression-tested for legacy equivalence. (§4.2)
- **OQ8 (corrective-chip session resolution)**: the teaching-skill holds/resolves a **teaching `learning_session(entrypoint=null, goal_id=learning_item_id)`** for the `ask_check`/accept-chip lineage, **separate from** the Copilot `entrypoint='copilot'` chat session. accept-chip still posts to its own endpoint with the teaching session id (R1). A teaching turn inside Copilot writes two `type='conversation'` sessions (both via `conversation.ts`, R7-safe). Rationale: KPI/INSERT machinery stays exactly where it is; only the reply surface moves. (§4.2)
- **OQ9 (active-question tracking ownership)**: `getActiveQuestionState` + corrective-failure counting stay **teaching-skill-internal on the teaching session** (the event-derived `active_question_id`, no DB column, `src/server/teaching/active-question.ts`); Copilot session-level state gains nothing. Rationale: corrective-chip KPI (R1) lives on the teaching session's event stream; do not pollute the Copilot session. (§4.2)
- **OQ12 (solve context)**: inject **question face (`prompt_md`) + reference solution (`reference_md`/`worked_solution`) + prior-attempt summary** — exactly what `planSolveHint` seeds today (`solve.ts`/`solve.test.ts`). **No knowledge-graph injection in MVP** (minimal; matches current hint behavior; avoids first-time-memory creep). Rationale: keep the absorbed behavior behavior-identical to the existing hint; widen later if a product need appears. (§4.3)
- **OQ13 (new capability?)**: **none.** U6 registers no new `judgeCapability`, no new task. `TeachingTurnTask`/`CopilotTask` are reused as-is (only the Copilot prompt *identity* changes). `audit:profile` zero-delta. Rationale: skills are prompt/context packs (AF §1.3), not capabilities. (§7)
- **OQ14 (history migration)**: **out of scope.** The `conversation` envelope does **not** retroactively absorb old Active Teaching sessions; legacy teaching event streams stay on their own sessions (R3 parallel). Rationale: history backfill is a migration with no MVP product need; legacy sessions remain readable via legacy routes during the migration window. A cut-over closeout issue (§11) owns any future backfill decision. (non-goal)

---

## 10. Weakest two spots (for critic focus)

1. **The two-session write for a teaching turn inside Copilot (§4.2 OQ8) is the load-bearing structural decision, and I have NOT verified the teaching session is cleanly resolvable from inside a Copilot turn.** The plan says a teaching turn writes both the Copilot `entrypoint='copilot'` session (chat envelope) AND a teaching `entrypoint=null, goal_id=learning_item_id` session (ask_check INSERT + accept-chip lineage). But the legacy teaching flow *creates* its teaching session via `startConversation` (the teaching drawer's start call); inside a Copilot turn driven only by `skill_context.ref={learning_item}`, **does the teaching-skill find an existing teaching session, or must it create/own one?** If it must create one, that is a second `conversation.ts` write per teaching turn (R7-owned but adds lifecycle surface — when does it idle/end? who closes it?), and the accept-chip `Conversation.assertActive` check (`accept-chip/route.ts`) needs that session to be `active`. **Critic should verify**: (a) whether `loadTeachingContext` + the teaching session creation can be driven from `skill_context.ref` alone; (b) whether the teaching session's lifecycle (idle/end) inside a Copilot turn collides with the Copilot session's own idle clock (Map MED risk: double-own); (c) whether accept-chip's `assertActive` still holds when the teaching session is created lazily by the skill. This is the single most likely place for a silent session-lifecycle bug.

2. **The `materializeAskCheckQuestion` extraction (§4.2 OQ7) claims "byte-for-byte behavior preservation" of the legacy `turn/route.ts:99-110` INSERT, but I read only the INSERT's *trigger condition*, not its full transaction context.** The INSERT sits inside the turn route's transaction with surrounding logic (the `:169` comment references "ask_check question that question has 0 attempts, so the failure total" — there is failure-counting logic coupled to the INSERT). If the INSERT is not cleanly separable from the corrective-failure-counting in the same `tx`, the extraction either (a) drags that counting into the shared fn (scope creep, and the counting may be teaching-session-specific), or (b) leaves it behind and the teaching-skill's `ask_check` path silently lacks failure-count wiring. **Critic should verify** the full `turn/route.ts` transaction body around `:99-169` to confirm the INSERT is extractable without splitting the corrective-failure-count logic, and decide whether the shared fn should be just-the-INSERT or INSERT+counting. This determines whether OQ7's "service fn" is a clean 10-line extraction or a riskier transaction refactor.

---

## 11. Linear issue capture gate

This task is the U6 implementation **plan** (a planning document + commit). Follow-ups discovered:

- **Cut-over retirement standard (OQ11 / OQ14)** — the legacy-route migration-window length and the history-backfill decision are deliberately deferred (D10 leaves them undefined). **Action: a closeout Linear issue should be opened at U6 ship** ("AF S4 cut-over: retire legacy teaching/solve routes + decide history backfill") — recorded here for the closeout, not opened now (no code yet).
- **OQ5 latency characteristic (§4.4)** — the teaching skill's 2× model-call-per-turn latency is documented, not capped; if the critic deems it material, a follow-up caps it. Recorded for the critic, not opened now.
- No new Linear issue is needed **for this plan-authoring task itself** — all in-scope follow-ups land in the same U6 PR, and the two deferred items are explicitly recorded above for the closeout pass to open at ship time (per the YUK-203 sequence convention where closeout opens the cut-over issue).
