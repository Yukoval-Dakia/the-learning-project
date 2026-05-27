# Wave 1 Closeout Drift Audit — 2026-05-27 (EOD)

**Scope**：Wave 1 全周期 closeout 状态确认 —— 4 主 track ship + PR #163 closeout (YUK-99/100) + PR #165 iter2 (YUK-101 band-aids) 全部 squash 到 `main`（HEAD `d4d68864`）后的 incremental audit。
**Run by**：Claude Code（manual /audit-drift, Wave 1 master-roadmap §5.1 wave gate item 2）。
**Companion**：
- `docs/audit/2026-05-27-pre-yuk88-baseline-drift.md`（Wave 1 启动前 15 findings baseline）
- `docs/audit/2026-05-27-wave1-postship-drift.md`（Wave 1 三主 ship 后 audit，但**不含** PR #163/#165 closeout fix）

本 audit 的目的：确认 `wave1-postship-drift.md` 列出的 P1 已被 PR #163/#165 修掉，并圈出 Wave 1 真实剩余 open follow-up。

## Summary

| 类别 | 项数 | 备注 |
|---|---|---|
| ✅ Resolved by PR #163 (YUK-99/100) | 3 | W-01 / W-04 / W-05 (postship audit P1 全部) |
| ✅ Resolved (cascade) | 1 | W-06 (W-01 同根因) |
| 🟡 Architectural follow-up | 1 | YUK-101 transactional outbox（PR #165 是 band-aid，真正重写未做）|
| ⏳ Phase-deferred | 2 | W-02 driver templates 路径 mismatch；W-07 Chinese embedding 召回 |
| 🟡 Baseline carry-over | 7 | F-01/F-02/F-03/F-08/F-12..F-15（YUK-88 P1/P4 phase 范围）|

**Top-line**：Wave 1 三个主 ship 暴露的 silent-dead-path 已在同日合 closeout PR 修完；唯一真实 open architectural follow-up 是 **YUK-101 transactional outbox**（iter2 是 band-aid）。无 P1 阻塞 Wave 2 启动。

---

## ✅ Resolved（postship findings → 已修，code-level evidence）

### W-01 → ✅ Resolved by YUK-99 (PR #163)
- **原 finding**：ADR-0017 §"Write triggers" #1 event-ingest 没 wire；`enqueueEventMemoryIngest` 0 caller
- **当前 main 状态**：`src/server/events/queries.ts:976` `await triggersModule.enqueueEventMemoryIngest(boss, eventId)` —— event INSERT 之后正常 enqueue（dynamic-import via `getStartedBoss` 走 SKIP_BOSS_INGEST escape hatch，per iter2 F6/F7）
- **Verification**：`grep -n "enqueueEventMemoryIngest" src/server/events/queries.ts` 命中 L9 注释 + L943 dynamic-import 注释 + L976 实调
- **Cascade**：W-06（meta:orchestrator_self chat-derived scope）同根因，随 W-01 自动 active

### W-04 → ✅ Resolved by YUK-99 (PR #163)
- **原 finding**：`.env.example` 缺 `OPENAI_API_KEY` + 6 个 `MEM0_*`
- **当前 main 状态**：`.env.example:21 OPENAI_API_KEY=` + L24-30 注释列 6 个 `MEM0_*` default + L31-32 起 placeholder 行
- **Verification**：`grep "OPENAI_API_KEY\|MEM0_" .env.example` 11 行命中

### W-05 → ✅ Resolved by YUK-100 (PR #163)
- **原 finding**：`advice` + `submit` route 不传 `causeCategory` → `causeLean` 永远 0 → carelessness / conceptual lean 死代码
- **当前 main 状态**：
  - `app/api/review/advice/route.ts:82-83` `const causeCategory = await resolveAdviceCauseForQuestion(db, questionId);` → 传入 `judgeResultToRatingAdvice(result, { causeCategory })`
  - `app/api/review/submit/route.ts:273` `causeCategory: adviceCauseCategory` 透传
  - 新增 `src/server/review/cause-context.ts` (`resolveAdviceCauseForQuestion`) 收口 cause SoT 单 owner
- **Verification**：`grep -n "causeCategory" app/api/review/{advice,submit}/route.ts` 命中

---

## 🟡 Open architectural follow-up

### YUK-101 — Transactional outbox for `writeEvent` → memory event ingest
- **Source**：PR #163 post-ship `/code-review` 15 findings；iter2 PR #165 fix 了 13 项 surface 问题但**没有**做真正的 outbox 重写
- **当前 main 状态**：`writeEvent` 内 `enqueueEventMemoryIngest` 通过 fire-and-forget + `singletonKey` dedupe + cold-start pre-createQueue + `SKIP_BOSS_INGEST` escape 跑得起来；但仍是 "enqueue commits independently of caller tx"。若 caller tx rollback (FSRS torn state / 23505 / FK violation)，`event` 行没了但 `pgboss.job` 留 orphan
- **Severity**：**P1 architectural**（功能跑得通，但 ADR-0005 single-owner INSERT contract 仍被违反；Mem0 fact 层在 rollback 场景下永久 miss）
- **建议**：进 Wave 2 buffer，或独立 mini-wave 处理（YUK-101 issue body 已含完整 design）

---

## ⏳ Phase-deferred (informational)

### W-02 — Driver T-37 §4 templates 路径与实装 mismatch
- 5 个 brief template 仍 inline 在 `BRIEF_TEMPLATES` const（per `src/server/memory/brief.ts:6-17`），未拆 `src/server/memory/templates/*.md`
- 处理：等 template 长出来时拆；driver doc 更新留 P4.8 sweep（合并到 status.md / module doc sweep）

### W-07 — Chinese embedding recall validation
- 仍 deferred 到 has-OPENAI_API_KEY host；spike-findings §Q1 已显式标 not-executed
- W-04 修完后，下次 worker 启动时手动跑一次 recall probe，结果回 spike-findings

---

## 🟡 Baseline carry-over（不重审，期 YUK-88 phase）

| ID | 状态 | 期 phase |
|---|---|---|
| F-01 notes.md ADR-0020 冲突 | 仍 live | YUK-88 P3 rewrite |
| F-02 artifact 表 pre-ADR-0020 schema | 仍 live | YUK-88 P1 改 |
| F-03 CorrectArtifactEvent.section_id | 仍 live | YUK-88 P1 改名 |
| F-08 YUK-62/63 plan checkbox | 仍 stale | P4.8 doc sweep |
| F-12..F-15 module docs disclaimer | 仍 live | P4.8 doc sweep |

---

## Severity 总览

| Severity | 项 | 描述 |
|---|---|---|
| P1 architectural | 1 (YUK-101) | outbox 重写，已建 issue |
| P3 / Phase-deferred | 2 (W-02 / W-07) | 不阻塞 |
| Baseline carry | 7 | 期 YUK-88 / P4.8 |
| Resolved | 4 (W-01/04/05/06) | PR #163 / #165 ✓ |

## 推荐 follow-up（report-only，已建 Linear 不重复开）

- **YUK-101** ✅ 已建（priority High，状态 In Progress；不 close 直到真正 outbox 重写 ship）
- W-02 / W-07 → P4.8 doc sweep 内一起处理（不开独立 issue）
- Baseline 7 项 → 跟 YUK-88 phase / P4 sweep 走（不开独立 issue）

---

**结束。Wave 1 closeout audit 结论：✅ 可启 Wave 2**。
**Evidence trail**：
- main HEAD `d4d68864 (#165) iter2 13 findings`，前置 `f1d5d9d2 (#163) closeout YUK-99/100`
- W-01: `src/server/events/queries.ts:976`
- W-04: `.env.example:21-32`
- W-05: `app/api/review/advice/route.ts:82-83` / `app/api/review/submit/route.ts:273` / `src/server/review/cause-context.ts`
- YUK-101: `https://linear.app/yukoval-studios/issue/YUK-101` (architectural follow-up)
