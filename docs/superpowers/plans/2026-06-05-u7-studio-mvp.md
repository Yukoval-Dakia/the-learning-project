# U7 — Editable Profile Studio MVP Implementation Plan

> **Issue**: YUK-203 (U-sequence final lane) + **Closes YUK-206** (audit:profile registry-traversal fix).
> **Branch**: `yuk-203-u7` @ `cbe57d33`.
> **Inputs**: Map 统合 (`/tmp/u7-map.md`), PS spec (`docs/superpowers/specs/2026-06-03-editable-profile-studio-design.md` §0/§3/§4/§5/§8/§9/§9a), U0 决议 (`docs/design/2026-06-04-u0-decisions.md` §D6/§D9).
> **Orchestrator rulings applied**: Q1 (Critic via CLI w/ real db) · Q2 (D6 = readiness, not impl) · Q4/Q5 (serialize-to-ts only, plain literal, no version) · Q6 (RSC direct-read slim) · Q7 (no auto-bump) · Q8/YUK-172 (OUT) · Q9 (optional cleanup).
> **Cross-统合 status (2026-06-05)**: critic verdict was **REVISE**; all items (M1 / M2 / S1-S3 / N1 / G1-G3) reverified against source and folded in — see the «Cross-统合修订记录» table at the end (§13). Verdict now **APPROVE**.

---

## 0. Background

U7 is the final lane of the YUK-203 U-sequence: the **Editable Profile Studio MVP** spine, sliced by the U0 grill session (`ADR-0029`, reading A = "MVP knife + zero CUT, full DEFER"). The spec §9 amended MVP KEEP list is the **authoritative ship surface** — seven items, ordered. Everything else in the PS spec is DEFERRED behind explicit triggers (§5 of this plan records the gate).

This is a deliberately small spine that validates the product loop (draft → validate → diff → critic → read-only view) **without** migrating runtime profile resolution out of TypeScript files (spec §5 V1 = file-backed). No DB tables, no Studio write UI, no agent generation — just the authoring/review primitives + a read-only admin surface.

### 0.1 Verified-at-plan-time facts (code spot-checks, not Map-trust)

These were re-read against source at plan time (not inherited from Map):

| Fact | Source anchor | Bearing |
|---|---|---|
| `audit-profile.ts` `auditSubjectProfiles` is a hardcoded `Record` (`:28-32`); `runCli()` calls `auditProfiles()` with **no args** (`:103`) → default = hardcoded 3 | `scripts/audit-profile.ts:28-32,44-46,102-110` | YUK-206 fix target |
| `getDefaultSubjectRegistry()` exists (`:155-157`); `listProfiles(): SubjectProfile[]` exists (`:138-140`); `toProfileList` already handles `readonly SubjectProfile[]` (`:40-42`) | `src/subjects/profile.ts` / `scripts/audit-profile.ts:40-42` | YUK-206 fix is ~5 lines; no new registry API |
| `audit-profile.test.ts` `'passes for all built-in profiles'` (`:31-37`) calls `auditProfiles()` **with no args** (`:32`) → hits the hardcoded `auditSubjectProfiles` default (`:45`), then asserts `.toEqual(['math','physics','wenyan'])` (`:36`). Does **not** import `auditSubjectProfiles` directly anywhere in the file (imports only `auditProfiles`, `formatProfileAuditReport`). | `scripts/audit-profile.test.ts:31-37` | Q2/RL2 (M1): test:32 no-arg means a `runCli`-only fix leaves the registry path UNtested → must also fix test:32 to pass `listProfiles()` + dynamic-ize `:36` + add synthetic-4th case |
| `validateProfile()` = 6 checks in order: Zod first-fail-return → version non-empty guard → causeCategories (dup id) → judgeCapabilities (registry + preferredRoutes ⊆ declared) → renderConfig parse → schedulingHints parse + scheduler supports `question` | `src/core/capability/validate-profile.ts:136-178` | compile CLI + serializer write-back gate (RL7) |
| Three `profile.ts` literal form = **plain `export const xProfile: SubjectProfile = {…}`** (NOT `satisfies`, NOT `as const`), single `import type { SubjectProfile } from '../profile'` header, explanatory `//` comments before `judgeCapabilities` | `src/subjects/{wenyan,math,physics}/profile.ts:1-3` | Q4/Q5: serializer emits plain literal |
| `runTask()` writes DB **unconditionally** (`writeAiTaskRunStarted` `:288`, `writeCostLedger` `:360`); `runAgentTask` is an identical alias (`:415-421`); `RunTaskCtx = { db: Db, …, allowedTools?, subjectProfile? }` (`:79-100`) | `src/server/ai/runner.ts` | Q1: Critic via CLI passes real db → ai-run trace preserved (evidence-first) |
| task-prompts `getTaskSystemPrompt` switch is `assertNever`-terminated (`:779-780`); subject-neutral tasks join the **pass-through group** returning `tasks[task].systemPrompt` (`:762-778`, e.g. `MemoryBriefTask`/`ReviewPlanTask`/`CoachTask`) | `src/ai/task-prompts.ts:702-781` | Q3: ProfileCriticTask is subject-neutral → pass-through (registry-inline systemPrompt = runtime SoT) |
| `(admin)` layout: `'use client'` shell with `ADMIN_NAV`/`ROUTE_MAP`/`activeFromPath` (`:8-25`), `TopNav` + `TokenGate` + legacy `.app-shell` chrome; admin pages are thin RSC wrappers → `@/ui/admin/*` surface using `<main className="page wide">` + `PageHeader` | `app/(admin)/layout.tsx` / `app/(admin)/admin/runs/page.tsx` / `src/ui/admin/observability.tsx:226-227` | Q6 + design pre-flight (§7) |
| `SlimSubjectProfile = Pick<…,'id'\|'displayName'\|'renderConfig'>` + `toSlimSubjectProfile()` already exist | `src/subjects/profile-schema.ts:75` / `profile.ts:159-165` | Q6: slim view extends this; adds `version` + capability count |
| env-guard precedent: `seed-synthetic.ts` = explicit opt-in env + loopback `DATABASE_URL` host check, first-import fence | `scripts/seed-synthetic.ts:71-97` | R9: `--critic` path env fence |

### 0.2 D6 readiness account (Q2 — confirmation, NOT implementation)

Per the orchestrator Q2 ruling, D6 judge-event version stamping is **already landed**. U7 does **not** re-build it (RL3 "built once"). Verified at plan time across the three stamping paths + payload declaration:

- **Payload schema** — `src/core/schema/event/known.ts:71-73`: optional `profile_version` / `capability_ref` / `judge_route` declared (historical events need no backfill).
- **Path 1 (invoker)** — `src/server/judge/invoker.ts:108` (`capability_ref.version`) + `:121` (`profile_version`) from `subjectProfile.version`; test `invoker.test.ts:64,88-89`.
- **Path 2 (attribution)** — `src/server/knowledge/attribute.ts:172` `profile_version: profileVersion`; tests `attribute.test.ts:210,234,259` (incl. default-profile fallback).
- **Path 3 (paper-submit)** — `src/server/review/paper-submit.ts:447` `profile_version: subjectProfile.version`.

**U7 obligation on D6 = do-not-regress.** Item 1 in §4 is a readiness gate (run the three stamping tests, confirm green), not a code change. If CO's slice altered payload shape, PS aligns rather than re-stamps (RL3); current shape is stable.

---

## 1. Scope (the seven MVP KEEP items — spec §9 authoritative)

1. **D6 judge-event version stamping** — *readiness confirmation only* (§0.2; landed).
2. **`audit:profile` registry-traversal fix (YUK-206)** — ~5-line fix + dynamic test assertion. **Closes YUK-206** (own commit).
3. **`SubjectProfileDraft` + `ProfileImpactReport` Zod schemas** — two new core schemas.
4. **draft-JSON → `validateProfile` → diff CLI compile script** — `scripts/compile-profile.ts` (+ `--critic` flag for item 6).
5. **profile → TS-literal serializer** — `src/subjects/serialize.ts` (serialize-to-ts only, round-trip to `profile.ts`).
6. **`ProfileCriticTask`** — the only MVP agent; single-shot, `allowedTools:[]`, proposal-only, invoked via the compile CLI `--critic` flag with real db (Q1).
7. **read-only `/admin/subjects` page** — RSC direct-read slim subset; nav wired (Q6); design pre-flight in §7.

### Non-goals (explicit — do NOT build; trigger-gated DEFER per RL1)

- **No 4 `subject_profile_*` DB tables** (trigger = git-backed flow proves insufficient).
- **No due-queue impact preview** (trigger = a *second* scheduler policy exists; today only `fsrs`, delta structurally empty).
- **No cause-taxonomy board, no subject_id rename/alias/fork classifier** (trigger = first real rename/split need).
- **No ProfileAuthorTask / FixtureGeneratorTask / ProfileImpactTask** (the latter's near-term substitute = route-resolution diff, itself DEFERRED, "可先做不挡 MVP").
- **No route-resolution diff preview** (DEFERRED; not on MVP critical path).
- **No Studio write UI / no Server Action writes** (RL5).
- **No serialize-to-JSON path** (Q4/Q5: only serialize-to-ts this slice; draft input is already JSON).
- **No version auto-bump in the CLI** (Q7: impact report *suggests*, author hand-fills).
- **No cause-id lint (YUK-172)** — **OUT of U7** (Q8 ruling; §5 records the boundary). Independent ticket.
- **No 3 uncovered invariants** (prompt-section-reference / fallback-family / pipeline-schema-compat) — **OUT** (Map §5(B); publish-gate long-term home; logged as R7 known-gap, no new ticket).

---

## 2. Red lines (plan may not cross — Map §4 verbatim)

> These are hard, non-negotiable constraints. Each implementation step is checked against the relevant RLs in its acceptance.

- **RL1 — DEFER 项不许偷做进 MVP.** The DEFERRED set (4 `subject_profile_*` DB 表 / due-queue impact 预览 / cause-taxonomy board / subject_id rename·alias·fork 分类器 / ProfileAuthorTask / FixtureGeneratorTask / ProfileImpactTask 专用 agent / route-resolution diff 预览) each has an explicit trigger; trigger 未到不做. Anchor: u0-decisions §D9 L46; spec §3/§4/§5/§7. Failure ⇒ 范围爆炸，违背 grill 裁定.

- **RL2 — `audit:profile` 不回归.** YUK-206 fix 后第 4 学科必须自动入审；`audit-profile.test.ts` 断言改动态；保留 `pnpm audit:profile` 作为既有 gate 的 superset（spec §8 "extends not replaces"）. Anchor: spec §8 L313; CLAUDE.md. Failure ⇒ CI gate 对新学科静默失效.

- **RL3 — D6 stamping 不动 / built once.** D6 是 CO/PS 共享 slice，U7 不重复造 stamp 机制；若 CO 先落地 payload shape，PS 对齐不另造. rejudge = 新 event 不改旧结果. 三路（invoker/attribute/paper-submit）已落地，U7 不回归. Anchor: u0-decisions §D6; spec §8 L319-328. Failure ⇒ 双重 stamp / 历史结果被改写.

- **RL4 — §0 不反转.** 高影响编辑保持"允许但强 gate"；Studio UI 暂无入口 = **排期非政策**. **不得把 "no edit entry" 实现成字段不可变（field immutability）** —— 任何注释 / 类型 / schema **不得暗示字段不可变**. Anchor: spec §0; u0-decisions §D9 L47. Failure ⇒ 政策性反转，违背 §0 invariant.

- **RL5 — admin 写操作禁 page Server Action.** read-only 页只 client/RSC 读 compiled profile；任何未来写**必走 `/api/admin/*`** 继承 `x-internal-token` gate（middleware 只 match `/api/:path*`，page route 无 server token）. 本期 read-only —— 注释里必须写明"未来写必走 `/api/admin/*`，禁 page Server Action". Anchor: spec §9a L370-389. Failure ⇒ 写路径绕过整个 trust boundary，未授权运行.

- **RL6 — proposal-only 不变量.** ProfileCriticTask 只产评审/patch 提议，**无 silent publish** —— CLI `--critic` 把评审/patch 写 stdout/JSON，**不落库、不改文件**. Anchor: ADR-0025 ND-5 + ADR-0004; spec §4 L219-227. Failure ⇒ AI 越权直改全局策略.

- **RL7 — 不破坏启动期校验路径.** serializer/compile 写回 `profile.ts` 后，坏 profile 会在 route 加载期炸服务（`SubjectRegistry` 模块级实例化 + `validateProfile`，`profile.ts:143`）—— **写回前必须先过 `validateProfile`，禁止跳过 gate 直接写文件**. Anchor: profile-infra R1; spec §9 步骤序（validate 在 serialize 之前）. Failure ⇒ 启动期服务崩溃.

---

## 3. Design forks — orchestrator rulings + this plan's adjudications

### 3.1 Q1 — ProfileCriticTask call path = **CLI with real db** (orchestrator-fixed)

Critic is invoked through the compile CLI via a `--critic` flag (chosen over a standalone `scripts/critic-profile.ts` — keeps the draft-load + parse path single-sourced; the CLI already reads & validates the draft, Critic just adds an LLM pass on the same parsed object). The CLI calls `runAgentTask('ProfileCriticTask', { draft }, { db, allowedTools: [], subjectProfile: defaultSubjectProfile })` (G3: draft travels in the input, `ctx.subjectProfile` is the registered `defaultSubjectProfile` for provider/trace context only — never the unregistered draft) with:
- **real db** — preserves the ai-run trace (`task_run_log` + `cost_ledger`), per evidence-first (`runTask` writes both unconditionally; §0.1). **The Map C1 "no DB" tension dissolves on reverification**: spec §4 prose contains **no "no DB" phrase** (the only spec "no DB" is §5 `:254`, about `profile.ts` round-tripping so "no DB *row* is needed to author profiles" — the table-DEFER rationale, not a Critic constraint). The "无 DB" phrasing was a **Map paraphrase with no spec basis**. So preserving the trace is the correct, spec-consistent call: standard `runTask` *must* write the trace rows, and the project's AI-traceability principle wants them. No no-log runner fork.
- `allowedTools: []` — single-shot, no tool loop (`needsToolCall:false`, `maxIterations:1`, `timeout:60_000`). **Timeout precedent = `TeachingTurnTask`** (`registry.ts:405` — `{ ...DEFAULT_BUDGET, maxIterations:1, timeout:60_000 }`, text-only, `needsToolCall:false`, `allowedTools:[]`, `mimo-v2.5-pro`): the cleanest 60s single-shot text-only sibling (N1, Cross-统合). Note `SolutionGenerateTask` uses `timeout:90_000` (`:576`) — do NOT cite it for the 60s budget; cite TeachingTurnTask. `MemoryBriefTask`/`ReviewPlanTask` confirm the subject-neutral pass-through prompt pattern (`:541-549`/`:660-665`).
- **proposal-only output** — the task result (review prose + patch suggestions) is parsed and written to **stdout / `--json`**, never to the DB domain rows and never back to `profile.ts` (RL6). The only DB writes are the runner's own ai-run-log rows (trace), not profile mutations.

### 3.2 Q2 — D6 = readiness, not implementation (orchestrator-fixed)

Item 1 is a do-not-regress gate (§0.2). No stamping code changes. Acceptance = the three stamping tests run green in the gate.

### 3.3 Q3 — ProfileCriticTask prompt = subject-neutral pass-through

The Critic reviews a *draft profile* (overbroad taxonomy / missing capability / route ambiguity / prompt-template drift / fixture gap) — the subject angle is **in the input draft**, not in the prompt voice. So it joins the `getTaskSystemPrompt` **pass-through group** (registry-inline `systemPrompt` IS the runtime SoT, same as `MemoryBriefTask`/`ReviewPlanTask`). No `buildProfileCriticPrompt(profile)` builder. The new `case 'ProfileCriticTask':` is added to the pass-through fall-through block before `return tasks[task].systemPrompt`. (TS exhaustiveness: adding the registry entry without the switch case fails `tsc` via `assertNever` — caught in the gate, not silent.)

### 3.4 Q4/Q5 — serializer = serialize-to-ts only, plain literal, no version (orchestrator-fixed)

`serialize.ts` emits a **plain object literal** matching the verified `profile.ts` form (`export const ${id}Profile: SubjectProfile = {…}` with the `import type { SubjectProfile } from '../profile'` header) — **not** `satisfies`, **not** `as const` (verified §0.1). String values wrapped via `JSON.stringify` (handles the Chinese long strings in `languageStyle`/`promptFragments` without escape-precision loss). Only serialize-to-ts this slice — no serialize-to-json (draft input is already JSON).

**Cross-统合 M2 serializer contract (reverified)** — two rules the round-trip depends on:
- **Omit absent/undefined optional keys** — never emit `key: undefined`, never inject a default. (`CauseCategoryDeclaration` has 4 heterogeneously-used optional fields; live wenyan fixture proves the mix.)
- **Emit `null` as-is** — `renderConfig.notation`/`code_highlight` are nullable; `null` is a real value, distinct from absent. wenyan `null` stays null, physics `'katex'` stays string.

**Version handling — pass-through, never bump (settles §10 weak-spot #1)**: the serialized literal **DOES include `version`** from the input profile, but the CLI **never computes or bumps** it. This reconciliation is now **fixed, not open**: `SubjectProfileSchema.version` is `z.string().trim().min(1)` (required non-empty, `profile-schema.ts:40`), so a literal that omits `version` would fail `SubjectProfileSchema.parse` AND `validateProfile` — i.e. the version-excluding alternative is self-defeating against RL7. Therefore the serializer stays a pure total function `SubjectProfile → string` that passes through the validated draft's `version`, and Q7 "no auto-bump" is honored by the CLI never *mutating* version. **The round-trip test asserts version-INCLUDED equality** (the literal carries the input version).

### 3.5 Q6 — admin data read = RSC direct-read slim subset (orchestrator-fixed)

`/admin/subjects` is an RSC page that reads `getDefaultSubjectRegistry().listProfiles()` directly (zero round-trip; registry has no DB dependency; read-only). It renders a **slim subset** — `id` / `displayName` / `version` / a `renderConfig` summary + a capability count (`judgeCapabilities.length`) — **not** the full blob (R11 over-exposure). Reuses/extends `toSlimSubjectProfile` shape (`profile.ts:159-165`, currently `Pick<…,'id'|'displayName'|'renderConfig'>`; adds `version` + capability count). Nav wired in **three** places in `(admin)/layout.tsx`: `ADMIN_NAV` (`:8-12`), `ROUTE_MAP` (`:14-19`), `activeFromPath` (`:21-25`).

**Cross-统合 S2 clarification (reverified) — two distinct "mirror" relationships, do not conflate**:
- **Page wrapper** (`subjects/page.tsx`) mirrors **`runs/page.tsx`'s SERVER form** — a thin 5-line RSC wrapper that imports the surface and returns `<SubjectsSurface />`. Verified `runs/page.tsx` is exactly that.
- **Surface visual form** borrows **`observability.tsx`'s VISUAL shell only** (`<main className="page wide">` + `PageHeader` + `Card`, `:226-227`) — but **NOT** its data flow. `observability.tsx` is a **`'use client'`** component using **`useQuery`/`apiJson` against `/api/admin/*`** (`:1-8`); the new Subjects surface is a **pure-read RSC** reading the registry directly (Q6), with **no** `'use client'`, no TanStack Query, no `/api/admin/subjects` endpoint. Borrow the look, not the client fetch. (An implementer who copies `observability.tsx` wholesale would wrongly inherit `'use client'` + a non-existent API call — explicitly avoid.)

### 3.6 Q7 — version bump = author-filled, CLI suggests only (orchestrator-fixed)

The CLI does **not** auto-bump. The `ProfileImpactReport` includes a `suggested_bump` hint line (e.g. "high-impact change → suggest minor/major bump"); the author hand-edits the `version` string. Consistent with Q4/Q5 (serializer omits version).

### 3.7 Q9 — low-risk cleanup = optional, marked (planner-adjudicated)

`validate-profile.ts:152-154` (version non-empty redundant guard, already enforced by `SubjectProfileSchema` `version: z.string().trim().min(1)` at profile-schema.ts:40) and `:62-63` (judgeCapabilities empty-id guard, redundant with Zod) are redundant-but-harmless. **Optional cleanup, NOT required for U7 acceptance.** If touched, it is a defensive-redundancy removal with a one-line comment; if not, it is left as belt-and-suspenders. **Default: leave as-is** (the redundant guards cost nothing and `validateProfile` is a hot start-up path where defensive checks are cheap insurance). Listed here so a reviewer does not flag it as an oversight.

---

## 4. Implementation steps (single lane, ordered — file manifest + acceptance)

> **Lane structure**: single lane, sequential (see §8 for the double-lane comparison and why single wins). Each step's acceptance is machine-decidable.

### Step 1 — D6 readiness confirmation (NO code change)

- **Touch**: none.
- **Action**: run the three stamping tests; confirm payload schema declaration intact.
- **Acceptance (machine)**: `pnpm vitest run --config vitest.db.config.ts src/server/judge/invoker.test.ts src/server/knowledge/attribute.test.ts -t 'profile_version'` is **green**, AND `grep -n 'profile_version' src/core/schema/event/known.ts` shows `:71` present. RL3 held (no diff to stamping paths — `git diff --stat` shows zero changes under `src/server/judge/`, `src/server/knowledge/`, `src/server/review/paper-submit.ts`).

### Step 2 — YUK-206 audit:profile registry-traversal fix  *(own commit — Closes YUK-206)*

> **Cross-统合 M1 lockdown (critic REVISE, reverified)**: changing only the `runCli` call-site is **insufficient** to prove RL2, because `audit-profile.test.ts:32` ALSO calls `auditProfiles()` with **no args** → still exercises the hardcoded `auditSubjectProfiles` default (`:45`), so the registry-traversal path stays untested and the `:36` `.toEqual([...])` assertion still passes against the static 3. A 4th-subject regression would slip through `pnpm audit:profile` only if `runCli` is fixed, but the test would NOT catch a re-broken `runCli`. The fix is therefore a three-part lock — all three required:

- **Modify** `scripts/audit-profile.ts`:
  - `runCli()` (`:103`) changes `auditProfiles()` → `auditProfiles(getDefaultSubjectRegistry().listProfiles())` (import `getDefaultSubjectRegistry` from `@/subjects/profile`). The fix is at the `runCli` call-site, not the `auditProfiles` default param — keeps `auditSubjectProfiles` const + `auditProfiles()` default arg as backward-compat for the existing unit tests that call `auditProfiles([profile], registry)` with explicit args.
  - Keep the `auditSubjectProfiles` const export (no test imports it directly — verified §0.1; safe to retain as backward-compat, but it is no longer the `runCli` source of truth).
- **Modify** `scripts/audit-profile.test.ts` — the `'passes for all built-in profiles'` case (`:31-37`), **two changes**:
  1. **`:32`** — change the call from `auditProfiles()` (no-arg, hits the hardcoded default) to `auditProfiles(getDefaultSubjectRegistry().listProfiles())`, so the test actually exercises the registry-traversal path the `runCli` fix relies on.
  2. **`:36`** — change `.toEqual(['math', 'physics', 'wenyan'])` to a **dynamic assertion against the registry's actual ids**: `expect(result.entries.map((e) => e.id).sort()).toEqual(getDefaultSubjectRegistry().listIds().sort())` (import `getDefaultSubjectRegistry` from `@/subjects/profile`). No hardcoded id list remains.
- **Add** a **synthetic 4th-profile registry test** (new case in the same file): construct a fresh `new SubjectRegistry()` (or reuse `makeAuditProfile` to build a valid synthetic profile), `register()` a 4th subject, then assert `auditProfiles(registry.listProfiles())`'s `entries` include the 4th id AND the audit stays `valid:true`. This is the **positive proof** that a 4th subject auto-enters the audit — the actual RL2 invariant, not just "no hardcoded 3 remain."
- **Acceptance (machine)**: (a) `pnpm audit:profile` exits 0 and its output lists exactly the registry's `listIds()`; (b) `pnpm vitest run --config vitest.unit.config.ts scripts/audit-profile.test.ts` green; (c) the synthetic-4th-profile test asserts the 4th id appears in `entries` (positive RL2 proof, registry path exercised by test:32 + the new case — no reliance on the hardcoded default anywhere in the exercised path). RL2 held.
- **Commit**: `fix(audit): audit:profile walks SubjectRegistry not hardcoded 3 (Closes YUK-206)` + Co-Authored-By trailer.

### Step 3 — `SubjectProfileDraft` + `ProfileImpactReport` Zod schemas (core)

- **Create** `src/core/schema/profile-studio.ts` (sits beside the existing `profile-decl.ts`; core layer, no IO):
  - `SubjectProfileDraftSchema` — a Zod schema for the draft-JSON wire format. **Distinct from `SubjectProfileSchema`**, but the divergence is **scoped tightly (Cross-统合 G2)**: the draft is `SubjectProfileSchema` with **`version` made optional** (Q7 — publish/author assigns it) and **nothing else changed**. Do NOT relax other fields' optionality, types, or `.min(1)` constraints — a broader "draft-appropriate optionality" invites schema drift from the published shape and weakens the compile gate. Concretely: derive via `SubjectProfileSchema.extend({ version: z.string().trim().min(1).optional() })` (or `.partial({ version: true })`-equivalent) so the only delta is `version` optionality. Inferred type `SubjectProfileDraft`.
  - `ProfileImpactReportSchema` — the compile-script output: `{ subject_id, valid: boolean, errors: string[], warnings: string[], diff: <field-level delta>, suggested_bump?: string }`. Inferred type `ProfileImpactReport`. **The `diff` granularity is locked at the TOP-LEVEL key level (Cross-统合 G1)**: `{ changed: string[], added: string[], removed: string[] }` where each entry is a top-level `SubjectProfile` key name (e.g. `causeCategories`, `renderConfig`, `judgeCapabilities`). It does **NOT** drill into nested structures — a changed `causeCategories` array reports as the single key `causeCategories` in `changed`, not a per-cause-id sub-diff. (Deeper diffing is DEFERRED; the per-cause taxonomy diff belongs to the cause-taxonomy board, RL1.) JSON-serializable for `--json`.
- **Export convention (Cross-统合 S1 correction, reverified)**: the profile-schema domain does **NOT** route through the `src/core/schema/index.ts` barrel. That barrel re-exports only `./business` and `./proposal` (verified `index.ts:5-6`); profile-domain schemas are consumed via **direct-path import** — `profile-decl.ts` is imported as `@/core/schema/profile-decl` (e.g. by `profile-schema.ts:1-5`), and `SubjectProfileSchema` lives in `@/subjects/profile-schema`, imported directly (e.g. `audit-profile.ts:8`). So `profile-studio.ts` follows the **profile-domain direct-path convention**: export `SubjectProfileDraftSchema` / `ProfileImpactReportSchema` from the module itself and import them by direct path (`@/core/schema/profile-studio`). Do **not** add them to the `index.ts` barrel.
- **Acceptance (machine)**: new `src/core/schema/profile-studio.test.ts` (unit, no DB) — `SubjectProfileDraftSchema.parse(<valid draft>)` succeeds; a draft missing `version` parses (Q7); `ProfileImpactReportSchema.parse(<sample report>)` succeeds; a malformed report (e.g. `valid` not boolean) rejects. `pnpm test:unit` green.

### Step 4 — draft-JSON → validateProfile → diff CLI compile script

- **Create** `scripts/compile-profile.ts`:
  - Reads a draft JSON file (arg path or stdin) → `SubjectProfileDraftSchema.parse` → fill/confirm against `SubjectProfileSchema.parse` → `validateProfile(parsed, getDefaultRegistry())` → compute field-level `diff` vs the current compiled profile of the same `id` (from the registry) → emit a `ProfileImpactReport`.
  - **Operates on the unsubmitted draft** (distinct from `audit:profile` which audits already-committed profiles).
  - Flags: `--json` (emit `ProfileImpactReport` JSON), `--write` (serialize → write back to `src/subjects/<id>/profile.ts` — **only after `validateProfile` passes**, RL7), `--critic` (additionally run ProfileCriticTask — Step 6).
  - **`--write` is RL7-gated**: the script MUST call `validateProfile` and refuse to write if `!result.valid`. The write path delegates to the Step-5 serializer.
  - CLI structure follows the repo convention (`audit-profile.ts:116`): business logic exported, `runCli()` parses + logs + sets exit code; entry guard `resolve(process.argv[1]) === fileURLToPath(import.meta.url)`.
  - **env fence** (R9): the bare compile/validate/diff path is pure TS (no IO, like `audit-profile`). Only the `--critic` and `--write` paths touch external resources — `--critic` needs `DATABASE_URL` + provider env (it calls the runner), `--write` touches the filesystem. Add a **scoped env guard**: `--critic` asserts `DATABASE_URL` present (and, mirroring `seed-synthetic.ts:71-97`, that it is not a prod host unless an explicit opt-in env is set) **before** invoking the runner. The default (no-flag) path requires no env.
- **Add** `pnpm` script alias in `package.json`: `compile:profile` → `tsx scripts/compile-profile.ts`.
- **Acceptance (machine)**: new `scripts/compile-profile.test.ts` (unit, no DB — Critic path mocked/skipped): (a) a valid draft → report with `valid:true`, empty errors, correct `diff` vs current; (b) an invalid draft (e.g. unknown judge capability) → `valid:false` with the registry error surfaced; (c) `--write` on an **invalid** draft refuses to write (no file mutation — assert `profile.ts` unchanged) — proves RL7; (d) `--write` on a valid draft round-trips (Step 5 covers the serializer assertion). `pnpm test:unit` green.

### Step 5 — profile → TS-literal serializer

- **Create** `src/subjects/serialize.ts` (core-adjacent pure function, no IO — same shape as `src/server/export/csv.ts`; the file-write is the caller's, here in the `--write` path of Step 4):
  - `serializeProfileToTs(profile: SubjectProfile): string` → returns the full `profile.ts` source text: the `import type { SubjectProfile } from '../profile';` header + `export const ${profile.id}Profile: SubjectProfile = ${literal};` with **plain object literal** (Q4/Q5 — verified form §0.1).
  - **String values via `JSON.stringify`** (round-trip fidelity for Chinese long strings; R6).
  - **Optional-key handling (Cross-统合 M2, reverified against `profile-decl.ts:5-21` + the wenyan/physics fixtures)**: the serializer **omits any optional key whose value is `undefined` or absent** — it must NOT emit `key: undefined` and must NOT inject a default. This is load-bearing because `CauseCategoryDeclaration` has four optional fields (`description`, `review_priority`, `variant_targetable`, `source_pack`, all `.optional()`) and the live profiles use them **heterogeneously**: `wenyanProfile.causeCategories` mixes entries with no `variant_targetable` (e.g. `concept`), `variant_targetable:true` (`grammar`), `variant_targetable:false` (`carelessness`), and one entry (`other`) that omits `description` entirely. Emitting `variant_targetable: undefined` for the entries that lack it would break strict round-trip equality. **`null` is a distinct value and must be emitted as-is** (not omitted): `renderConfig.notation` / `renderConfig.code_highlight` are `z.string().nullable()` — `wenyan` has `notation: null`, `physics` has `notation: 'katex'`; both must round-trip exactly (null stays null, string stays string).
  - **Version = pass-through, never bump (RESOLVED — see §3.4)**: the serialized literal **includes** `version` from the input profile; the CLI never computes/bumps it. This is fixed (not open): a `version`-less literal fails `SubjectProfileSchema.parse`/`validateProfile` (`version` is required non-empty at `profile-schema.ts:40`), so the version-excluding read-modify-write alternative is self-defeating against RL7. Q7 "no auto-bump" is honored by the CLI never *mutating* version. Round-trip test asserts version-included equality.
  - **RL7**: serializer is pure (produces a string); the *write* (Step 4 `--write`) is gated on `validateProfile`. The serializer itself does not write files.
- **Acceptance (machine)**: new `src/subjects/serialize.test.ts` (unit): **round-trip with `toStrictEqual`** (NOT `toEqual` — `toStrictEqual` is required so an accidentally-emitted `key: undefined` is caught; `toEqual` treats `{a: undefined}` and `{}` as equal and would mask the M2 bug). Two named fixtures, chosen to exercise the optional-key matrix:
  - **wenyan** — `notation: null` + a `causeCategories` array that mixes present/absent `variant_targetable` and one entry (`other`) missing `description`. Proves null round-trips as null and absent optionals are omitted (not `undefined`).
  - **physics** — `notation: 'katex'`. Proves a non-null nullable string round-trips as the string.
  - For each fixture, `serializeProfileToTs(profile)` produces source whose re-evaluated literal (parse via a dynamic import of a temp file, or eval-equivalent) **`toStrictEqual`** the original `profile` (strict equality on every field incl. Chinese strings). Also serialize the third profile (math) as a regression smoke. RL7: serializer touches no filesystem (assert it returns a string and writes nothing). `pnpm test:unit` green.

### Step 6 — ProfileCriticTask (the only MVP agent)

- **Modify** `src/ai/registry.ts`: add `ProfileCriticTask` entry — `needsToolCall:false`, `allowedTools:[]`, `budget:{...DEFAULT_BUDGET, maxIterations:1, timeout:60_000}`, `isMultimodal:false`, provider `xiaomi`/`mimo-v2.5-pro` (budget shape mirrors `TeachingTurnTask` `:405` — the 60s text-only single-shot precedent; N1). The `systemPrompt` is the **runtime SoT** (subject-neutral, inline — Q3), instructing: review a draft `SubjectProfile` for overbroad taxonomy / missing capability / route ambiguity / prompt-template drift / fixture gap; output strict JSON `{ review_md, patches: [{field, suggestion, impact}], blocking: boolean }`; **propose only, never publish** (RL6 restated in the prompt).
- **Modify** `src/ai/task-prompts.ts`: add `case 'ProfileCriticTask':` to the **pass-through fall-through block** (Q3 — before `return tasks[task].systemPrompt`). No builder.
- **Wire** the `--critic` flag in `scripts/compile-profile.ts` (Step 4) to call `runAgentTask('ProfileCriticTask', { draft }, { db, allowedTools: [], subjectProfile: defaultSubjectProfile })` and emit the parsed review to stdout/`--json` (RL6 — no DB domain write, no file write; only the runner's own trace rows). **`ctx.subjectProfile` = `defaultSubjectProfile` (Cross-统合 G3)** — it is consumed only by the provider/prompt-render + trace path, and ProfileCriticTask is subject-neutral pass-through (Q3) so the profile does not shape the prompt. Do **NOT** pass the unvalidated/unregistered draft here: `ctx.subjectProfile` is meant to be a registered runtime profile; the draft under review travels in the **input** (`{ draft }`), which is exactly where a subject-neutral Critic expects its subject angle (Q3). Passing the draft as `ctx.subjectProfile` would conflate "the profile providing runtime context" with "the artifact being reviewed."
- **Acceptance (machine)**: (a) `pnpm typecheck` passes — proves the switch case + registry entry are consistent (omitting either fails `assertNever`/exhaustiveness); (b) new `src/ai/profile-critic.test.ts` (unit) asserts the registry entry shape (`allowedTools:[]`, `needsToolCall:false`, `maxIterations:1`, `timeout:60_000`) and that `getTaskSystemPrompt('ProfileCriticTask', anyProfile)` returns the **same** string for two different profiles (proves subject-neutral pass-through, Q3); (c) **RL6 + trace-written (Cross-统合 M ruling)** — the `--critic` path, with the runner's SDK boundary mocked, makes **zero** writes to `profile.ts` and **zero** domain-row inserts (assert via spies on the serializer + domain write fns) **AND positively asserts the runner's own trace rows are written** — `writeAiTaskRunStarted`/`writeCostLedger`/`writeAiTaskRunFinished` each invoked once (the ai-run trace is the evidence-first record, not a domain mutation; this is the affirmative side of "trace-written, not no-DB"). The review JSON is parsed to stdout/`--json`. `pnpm test:unit` green.

### Step 7 — read-only `/admin/subjects` page (design pre-flight in §7)

- **Create** `app/(admin)/admin/subjects/page.tsx` — thin RSC wrapper (mirrors `runs/page.tsx`) delegating to a new surface.
- **Create** `src/ui/admin/subjects.tsx` — RSC surface (no `'use client'`; see S2): reads `getDefaultSubjectRegistry().listProfiles()` directly (Q6), maps each to the **slim subset** `{ id, displayName, version, notation: renderConfig.notation, capabilityCount: judgeCapabilities.length }`, renders `<main className="page wide">` + `PageHeader` + a `Card`/table of subjects (existing primitives; no full blob — R11). **Comment block at the top of the surface** must encode three points precisely (Cross-统合 S3 + RL5 + RL4):
  - **RL5** — read-only; any future write MUST go through `/api/admin/*` (inherits the `x-internal-token` middleware gate); **no page Server Action** (verbatim authority: spec §9a `:379-384`).
  - **S3 / TokenGate semantics** — the `(admin)` layout's `TokenGate` is a **client-side `localStorage` render-gate, NOT a server-enforced auth gate**; the middleware matcher only covers `/api/:path*`, so the page route renders with no server token (spec §9a `:374-377`). A **slim, non-sensitive** read RSC is acceptable directly off the registry; but any **sensitive read or any write** must move behind `/api/admin/*`. State this so no future slice mistakes the client gate for server protection.
  - **RL4** — the comment must NOT imply fields are immutable: "no write *entry point* yet (scheduled), not a policy that fields are fixed."
- **Modify** `app/(admin)/layout.tsx` — add `{ id: 'subjects', label: 'Subjects' }` to `ADMIN_NAV` (`:8-12`); add `subjects: '/admin/subjects'` to `ROUTE_MAP` (`:14-19`); add `if (pathname.startsWith('/admin/subjects')) return 'subjects';` to `activeFromPath` (`:21-25`).
- **Acceptance (machine)**: (a) `pnpm build` compiles the new route (Next route export validation — per YUK-67 this catches what tsc/biome/vitest bypass); (b) `pnpm typecheck` green; (c) the surface contains **no** Server Action (`grep -L "'use server'" src/ui/admin/subjects.tsx` — assert absent; RL5); (d) no full-blob exposure — grep the surface for `promptFragments`/`noteTemplate`/`causeCategories` serialization to client (assert absent; R11). Visual ring per §7.

---

## 5. Scope gate — RL1 + YUK-172 go/no-go (explicit, not default)

Per the orchestrator and Map §5, two boundary decisions are recorded here as **explicit go/no-go**, not silent defaults:

- **YUK-172 cause-id lint = OUT of U7** (Q8 ruling). Evidence: spec §9 MVP KEEP (the grill-authoritative ship list) does **not** include it; §8's "foundation gate" framing is vision-layer, not ship-layer. It is an independent, separable lint with no serializer/Critic dependency → **independent ticket, single-走**. This plan does not build it. (If the user later wants the file-backed cause-id route productionized immediately, it can be picked up cheaply alongside `audit:profile` — but that is a separate decision, not U7.)
- **3 uncovered invariants (prompt-section-reference / fallback-family / pipeline-schema-compat) = OUT** (Map §5(B), orchestrator照单). Source = `2026-05-30-drift.md` §D-ii roadmap-vs-impl gap (not an ADR contradiction); current 3 profiles all green; gap only surfaces at 4th-subject onboard. Publish-gate long-term home. Logged as **R7 known-gap**; **no new ticket** (already in drift audit).

**RL1 restated**: none of the DEFERRED items (§1 Non-goals) is built. Each has a trigger; no trigger has fired.

---

## 6. Risk coverage (Map R1-R11 — each has an action or is accepted/deferred)

| Risk | Disposition |
|---|---|
| **R1** (bad `profile.ts` → start-up crash) | **Mitigated by RL7**: `--write` gated on `validateProfile`; serializer never writes unvalidated. |
| **R2** (audit static-fail on 4th subject) | **Fixed by Step 2** (YUK-206) + dynamic test assertion (RL2). |
| **R3** (all versions `'1.0.0'`, no bump enforcement) | **Accepted/deferred**: Q7 — no auto-bump; impact report *suggests*, author fills. No lint forces bump (out of MVP). Logged. |
| **R4** (orphan knowledge_id → silent fallback wrong version) | **Out of U7 scope** (version-semantics runtime path; not touched by Studio MVP). Logged as known-gap. |
| **R5** (runner bypasses invoker → `'1.0.0'`) | **Avoided**: ProfileCriticTask reviews a *draft*, does not judge — it never reads a judge runner's module-level VERSION. Not on the invoker path. |
| **R6** (serializer round-trip fidelity) | **Mitigated**: `JSON.stringify` string wrapping + round-trip test (Step 5 acceptance). |
| **R7** (no protection net for 3 invariants) | **Accepted/deferred** (§5(B)): publish-gate home; known-gap, no ticket. |
| **R8** (admin legacy chrome inconsistency) | **Accepted + declared** in §7 design pre-flight (legacy `.app-shell`/`TopNav`, not loom shell — explicit). |
| **R9** (compile CLI DB/env misfire) | **Mitigated**: scoped env fence on `--critic`/`--write` only; bare path is pure TS (Step 4). |
| **R10** (Critic/validate boundary not formalized) | **Mitigated**: Critic = LLM qualitative (proposal-only, RL6); validateProfile = hard gate. Distinct outputs (`ProfileImpactReport` vs review JSON); impl does not conflate (Steps 4/6). |
| **R11** (admin data over-exposure) | **Mitigated**: slim subset only (Q6); acceptance greps for blob fields (Step 7). |

---

## 7. Step 7 — design-doc pre-flight (mandatory before any component code — CLAUDE.md UI Design Compliance)

> Per CLAUDE.md "UI Design Compliance" + the user's UI pre-flight rule: this pre-flight is embedded **inline** and must be approved before `/admin/subjects` component code is written.

### 7.1 Design-doc verbatim citation + authority

- **There is NO loom design doc covering `/admin/subjects`.** Verified at plan time: the nearest reference is `docs/design/loom-prototype/screen-admin.jsx`, which covers only the Runs / Cost / Failures observability surfaces, not a Subjects surface. **No new visual design稿 exists for this page** (Map §1.5 裁定 confirmed).
- **Style authority (explicitly declared, since no loom doc applies)**: the existing `(admin)` page convention is the sole style authority for this page:
  - **Chrome**: legacy `.app-shell` + `TopNav` shell (`app/(admin)/layout.tsx:32-50`) — **NOT** the loom sidebar shell. The three existing admin pages (runs/cost/failures) share this pre-loom chrome; `/admin/subjects` continues this pattern. **This is an explicit, declared acceptance of the legacy chrome** (R8), not an oversight.
  - **Page shell**: `<main className="page wide">` + `<PageHeader …>` — the **visual form** from `src/ui/admin/observability.tsx:226-227` (`AdminRunsSurface` etc.). **Borrow the visual shell only (S2)**: `observability.tsx` is a `'use client'` + TanStack-Query surface; the Subjects surface takes its `page wide`/`PageHeader`/`Card` look but stays a pure-read RSC (no `'use client'`, no `useQuery`, no API endpoint).
  - **Primitives + tokens**: `Card` / `Badge` / `Button` / `PageHeader` from `@/ui/primitives/*`; design tokens (no hardcoded colors/spacing). Same primitive set the observability surfaces use.

### 7.2 Component type declaration

- **Component type = RSC page** (React Server Component, server-rendered, read-only). Mounted under the existing `(admin)` route group → inherits `TokenGate` + `.app-shell` from `(admin)/layout.tsx`. **Not** a drawer, modal, or client component, and explicitly **not** a `'use client'` surface (unlike the sibling `observability.tsx`; see §3.5 S2 — borrow its visual shell, not its client/TanStack data flow). No client interactivity beyond the layout's existing nav (the surface is a static read-only table).
- **TokenGate is not a server guard (S3)**: the inherited `TokenGate` is a client `localStorage` render-gate, not a server auth check; the page renders with no server-enforced token (spec §9a). This is acceptable for a slim, non-sensitive read-only registry view; it does NOT license any write or sensitive read on the page route (those go to `/api/admin/*`, RL5).

### 7.3 File manifest (create vs modify)

| File | Action | Note |
|---|---|---|
| `app/(admin)/admin/subjects/page.tsx` | **CREATE** | thin RSC wrapper → `SubjectsSurface` |
| `src/ui/admin/subjects.tsx` | **CREATE** | RSC surface; `page wide` + `PageHeader` + slim table; RL5/RL4/R11 comment block |
| `app/(admin)/layout.tsx` | **MODIFY** | `ADMIN_NAV` + `ROUTE_MAP` + `activeFromPath` (3 sites) |

### 7.4 UI acceptance

- Renders the slim subset (id / displayName / version / notation / capability count) for all registry profiles, in the legacy admin chrome.
- No full-blob fields rendered (R11 — grep acceptance in Step 7).
- No Server Action (RL5 — grep acceptance).
- Comment block present, RL4-safe wording (does not imply field immutability).
- Visual ring (§9): playwright screenshot of `/admin/subjects` compared against the legacy admin chrome baseline (runs/cost/failures pages as the chrome reference, since no loom稿 exists).

---

## 8. Lane partition — single PR (orchestrator U-sequence convention)

**Single lane, sequential** (orchestrator-sanctioned for U7's small body: 1 readiness + 1 fix + 2 schema + 1 CLI + 1 serializer + 1 task + 1 page). One PR, single independent review pass.

**Double-lane comparison (why single wins)**: a plausible split is L-A (foundation: D6 readiness + YUK-206 + core schemas + serializer + CLI — all backend/core, no UI) and L-B (Critic + admin page — agent + UI). But: (a) the CLI `--critic` flag couples Step 4 ↔ Step 6, so L-B's Critic depends on L-A's CLI → not independent; (b) the admin page (Step 7) is the only UI work and is tiny; (c) the total diff is small enough that parallel-merge coordination overhead exceeds the wall-clock saving. **Single lane, ordered Steps 1→7, is more stable** — each step builds on the prior, one review sees the whole coherent slice. Commit granularity: **Step 2 is its own commit** (`Closes YUK-206`); the rest may be grouped or per-step but all under `YUK-203`.

---

## 9. Gate checklist (pre-PR, per CLAUDE.md + visual ring + double-bot)

This PR has **no DDL** (no new migration beyond the standard gate) and **builds one new route page** (`/admin/subjects`) + modifies the admin layout → **visual ring required**.

- `pnpm typecheck` — `tsc --noEmit` (catches the `assertNever` exhaustiveness for ProfileCriticTask).
- `pnpm lint` — `biome check .` (touched files).
- `pnpm audit:schema` — schema write-path drift (no new schema fields here, but run it).
- `pnpm audit:partition` — `*.test.ts` unit/db partition correctness (new tests are unit; assert they're in the unit config).
- `pnpm audit:profile` — **must exit 0 AND list the registry's `listIds()`** (RL2 — proves the YUK-206 fix in the gate).
- `pnpm test` — full gate (profile audit + unit + DB + migration-smoke). Includes the D6 stamping tests (Step 1 readiness), the YUK-206 dynamic assertion, the new schema/CLI/serializer/critic unit tests.
- `pnpm build` — **Next.js route export validation** for `/admin/subjects` (per YUK-67, catches production-only checks tsc/biome/vitest bypass). *(Worktree note: bare `pnpm build` fails at page-data stage on missing `DATABASE_URL` — pass a placeholder `DATABASE_URL` env; the compile-time route validation completes before page-data, so the relevant check still runs.)*

### Visual ring (per the user's "边做边看" rule)

- Playwright navigate `/admin/subjects` on a local dev server (check `:3000` occupancy first — OrbStack container may hold it, `pnpm dev` falls to `:3001`; curl/navigate the actual dev port, not the stale container build).
- Screenshot the rendered page; compare against the **legacy admin chrome baseline** (`/admin/runs` or `/admin/cost` as the chrome reference — no loom稿 exists for Subjects, so the existing admin pages ARE the visual reference).
- Run `/oh-my-claudecode:visual-verdict` on the screenshot-vs-baseline comparison: PASS criteria = same `.app-shell` chrome, `page wide` layout, `PageHeader`, token-consistent table; no decorative hero, no off-palette colors, no full-blob dump.

### Double-bot convergence criteria

- After gate-green + independent code review, request both review bots (CodeRabbit + Vercel/coderabbit per repo convention).
- **Convergence判据**: both bots report no MAJOR/blocking finding on (a) RL5 (no Server Action), (b) RL6 (Critic proposal-only, no domain write), (c) RL7 (serializer write gated on validate), (d) RL2 (audit dynamic). MINOR/nit findings triaged but non-blocking. Re-run after fixes until both converge clean on the four red-line surfaces.

---

## 10. Weakest two spots — RESOLVED (critic REVISE adjudicated + Cross-统合 reverified)

Both spots are now closed rulings, not open questions. Recorded here for the implementer and reviewer.

1. **Serializer `version` handling (Step 5 / §3.4) — RESOLVED: pass-through, version-included.** The serializer emits a literal that **includes** the input profile's `version`; the CLI never computes/bumps it. The version-excluding alternative (read-modify-write preserving the on-disk version line) is **rejected** because `SubjectProfileSchema.version` is required non-empty (`profile-schema.ts:40`) — a version-less literal fails `validateProfile`, defeating RL7. Q7 "no auto-bump" is satisfied by the CLI never mutating version. **Round-trip test asserts version-INCLUDED `toStrictEqual` equality.** No remaining ambiguity.

2. **ProfileCriticTask DB-trace vs the "no DB" claim (Step 6 / §3.1, Map C1) — RESOLVED: trace-written.** The orchestrator ruling (Critic via CLI with **real db**) preserves the ai-run trace (`task_run_log` + `cost_ledger`), which `runTask` writes **unconditionally** (`runner.ts:288/360/382`, verified; `runAgentTask` is a literal alias `:415-421`). **Cross-统合 reverification of the spec removes the supposed conflict**: the spec §4 prose contains **no "no DB" / "无 DB" phrase** — the only "no DB" in the entire spec is at §5 `:254` ("`profile.ts` round-trips as pure data, so **no DB row is needed to author profiles**"), which is the file-backed-vs-DB-tables DEFER rationale, NOT a constraint on the Critic task. The "single-shot 无工具无 DB" phrasing originated in the **Map** (§1.2 row), a paraphrase with no spec basis. So "trace-written" does not contradict the spec; it honors evidence-first (project AI-traceability principle) and RL6 (no *domain/profile* DB write, no `profile.ts` write). **Acceptance asserts: `task_run_log` +1 row AND `cost_ledger` +1 row AND zero domain/profile-row writes AND zero `profile.ts` write** (see Step 6 (c), updated). The `--critic` env fence (Step 4) is therefore **necessary** (the path needs `DATABASE_URL`).

---

## 11. Linear issue capture gate

- **Closes YUK-206** — the audit:profile registry-traversal fix (Step 2, own commit). Already an existing Linear issue; this plan's Step 2 + commit closes it.
- **YUK-203** — the umbrella U-sequence issue; U7 is its final lane. PR title + commits carry `YUK-203`.
- **YUK-172 (cause-id lint)** — **explicitly NOT closed/touched here** (§5 go/no-go = OUT). It remains an independent open ticket; no follow-up issue needed (already tracked).
- **R3/R4/R7 known-gaps** — already logged in `2026-05-30-drift.md` / this plan §6; **no new Linear issue** (deferred to publish-gate long-term home per §5(B) and Map §5). Stated explicitly per the capture gate: no new actionable follow-up issue is required beyond the existing YUK-206 / YUK-172 / drift-audit entries.

---

## 12. Q-ruling implementation map (one-line trace)

| Q | Ruling | Where in plan |
|---|---|---|
| **Q1** | Critic via CLI `--critic`, real db (trace), `allowedTools:[]`, single-shot, proposal-only stdout/JSON | §3.1, Step 4, Step 6 |
| **Q2** | D6 = readiness confirmation, not impl | §0.2, §3.2, Step 1 |
| **Q3** | ProfileCriticTask subject-neutral → pass-through, no builder | §3.3, Step 6 |
| **Q4/Q5** | serialize-to-ts only; plain literal (verified); `JSON.stringify` strings; no version bump | §3.4, Step 5 |
| **Q6** | RSC direct-read slim subset; 3-site nav wiring | §3.5, Step 7 |
| **Q7** | no auto-bump; impact report suggests, author fills | §3.6, Step 4/5 |
| **Q8** | YUK-172 cause-id lint OUT (independent ticket) | §1 Non-goals, §5 |
| **Q9** | low-risk cleanup optional, default leave-as-is | §3.7 |
| **(B) 3 invariants** | OUT (publish-gate home, known-gap) | §5(B), §6 R7 |

---

## 13. Cross-统合修订记录 (2026-06-05)

Critic verdict **REVISE** → all items reverified against source by the Cross-统合 agent and folded in. Verdict now **APPROVE**. The reverification confirmed every critic evidence point and additionally caught that the Map's "single-shot 无工具无 DB" phrasing is a **Map paraphrase with no spec basis** (spec §4 has no "no DB" — the only spec "no DB" is §5:254 about table-DEFER), which strengthens (not weakens) the trace-written ruling.

| # | Critic item | Reverified evidence | Plan change |
|---|---|---|---|
| **M1** | YUK-206 fix must lock 3 sites; `runCli`-only is insufficient because `audit-profile.test.ts:32` is ALSO no-arg | `audit-profile.ts:45,103` (default→hardcoded); `audit-profile.test.ts:31-37` (`:32` no-arg, `:36` static `.toEqual`); `package.json:17` (`audit:profile` is first in `pnpm test` gate → CI dimension) | Step 2 rewritten: (1) `runCli` → `listProfiles()`; (2) test:32 → `auditProfiles(listProfiles())` + `:36` dynamic vs `listIds()`; (3) NEW synthetic-4th-profile test asserting the 4th id auto-enters `entries`. §0.1 row tightened. |
| **M2** | Serializer must omit absent/undefined optionals + emit null as-is; round-trip `toStrictEqual`, wenyan + physics fixtures | `profile-decl.ts:5-21` (4 optional cause fields, `notation`/`code_highlight` nullable); `wenyan/profile.ts:44-111` (mixed `variant_targetable`, `other` omits `description`, `notation:null`); `physics/profile.ts:102` (`notation:'katex'`) | §3.4 + Step 5 add the two serializer rules; acceptance switched to `toStrictEqual` with the two named fixtures (+ math regression). |
| **薄弱点1** | Serializer = pass-through version (round-trip asserts version-included) | `profile-schema.ts:40` (`version` required non-empty → version-less literal fails validate, RL7 self-defeat) | §3.4 + Step 5 + §10#1: ruling fixed to pass-through-version; alternative rejected on RL7 grounds; test asserts version-included. |
| **薄弱点2** | ProfileCriticTask = trace-written (assert `task_run_log` + `cost_ledger` each +1, zero domain/profile.ts write) | `runner.ts:288/360/382` (unconditional trace writes), `:415-421` (`runAgentTask` alias); **spec §4 has NO "no DB" — only §5:254** | §3.1 + Step 6(c) + §10#2: acceptance positively asserts trace rows AND zero domain/file write; "Map paraphrase, no spec basis" recorded. |
| **S1** | Barrel misstated — profile domain uses direct-path import, not `index.ts` barrel | `core/schema/index.ts:5-6` (re-exports only `./business`/`./proposal`); `profile-schema.ts:1-5` + `audit-profile.ts:8` (direct-path) | Step 3 export line corrected to direct-path convention; do not add to `index.ts`. |
| **S2** | Admin surface — page wrapper mirrors `runs/page.tsx` SERVER form; surface borrows `observability.tsx` VISUAL form not its client data flow | `runs/page.tsx` (5-line RSC wrapper); `observability.tsx:1-8` (`'use client'` + `useQuery`/`apiJson`), `:226-227` (visual shell) | §3.5 + §7.1 + §7.2 + Step 7: two-mirror distinction made explicit; surface is pure-read RSC, no `'use client'`/TanStack/API. |
| **S3** | TokenGate = client localStorage render-gate, NOT server protection; slim non-sensitive read acceptable; sensitive read/write → `/api/admin/*` | `(admin)/layout.tsx:1,33` (`'use client'` TokenGate); spec §9a:374-384 | Step 7 comment-block spec + §7.2 encode the TokenGate semantic note alongside RL5/RL4. |
| **N1** | Timeout precedent → cite `TeachingTurnTask` (60s) not `SolutionGenerateTask` (90s) | `registry.ts:405` (TeachingTurn 60s single-shot text), `:576` (SolutionGenerate 90s) | §3.1 + Step 6: budget precedent re-pointed to TeachingTurnTask; SolutionGenerate's 90s flagged as wrong cite. |
| **G1** | diff granularity locked to TOP-LEVEL key level (changed/added/removed; `causeCategories` whole-field, no sub-drill) | `SubjectProfile` top-level keys; per-cause diff = cause-taxonomy board (DEFERRED, RL1) | Step 3 `ProfileImpactReportSchema.diff` spec locked to `{changed,added,removed: string[]}` of top-level keys. |
| **G2** | draft schema = "only `version` optional, else unchanged" | `profile-schema.ts:38-73` (the published shape) | Step 3 `SubjectProfileDraftSchema` = `SubjectProfileSchema.extend({version: …optional()})`, no other relaxation. |
| **G3** | `ctx.subjectProfile` = `defaultSubjectProfile` (provider/trace only); draft travels in input, never as ctx profile | `runner.ts:98-99` (`subjectProfile` is runtime ctx); Q3 subject-neutral (draft angle in input) | §3.1 + Step 6 wire: `subjectProfile: defaultSubjectProfile`; draft passed as `{ draft }` input. |
