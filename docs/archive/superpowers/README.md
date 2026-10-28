# docs/archive/superpowers — 历史流程文档归档

> **本目录已退役**（Linear [YUK-1575](https://linear.app/yukoval-studios/issue/YUK-1575)，2026-10-28）。
> 原位置 `docs/archive/superpowers/`（2026-05-08 ~ 2026-08 期间约 242 篇流程文档：specs / plans / brainstorms / research / audits + status.md）用 `git mv` 整体迁入此处，**git 历史完整保留**（`git log --follow <file>` 可查）。

## 这是什么、不是什么

- **是**：superpowers 工作流时期的历史语料——spec、实施 plan、brainstorm、research、closeout audit 的原始载体，与滚动状态总览 `status.md`。
- **不是**：默认工作上下文。agent 日常决策以 `AGENTS.md`、`docs/adr/`（ADR-0001 起）、根 `CONTEXT.md`、`docs/modules/`、`docs/agents/` 为准；本目录仅供溯源查证，**旧设计不得据此对抗现行 ADR**。
- 退役时经四路独立提取审（specs / plans-2026-05 / plans-2026-06+ / ADR 覆盖基线），仍有效的 owner 决定已按「宁少勿滥」并入现行 ADR 与领域文档，各条均注明本目录内的归档原文路径；其余内容或已录于现行 ADR，或已随后续架构演进失效。

## 旧路径 → 新路径

映射是纯前缀替换：`docs/archive/superpowers/<rel>` → `docs/archive/superpowers/<rel>`。全量索引如下（标题取自各文件首个一级标题）：

| 旧路径 (= `docs/archive/superpowers/<rel>`) | 归档路径 (= `docs/archive/superpowers/<rel>`) | 标题 |
|---|---|---|
| `docs/archive/superpowers/audits/2026-05-14-phase1-pre-1c-audit.md` | `docs/archive/superpowers/audits/2026-05-14-phase1-pre-1c-audit.md` | Phase 1 Pre-1c 审查 |
| `docs/archive/superpowers/audits/2026-05-29-v1-closeout.md` | `docs/archive/superpowers/audits/2026-05-29-v1-closeout.md` | v1 Closeout Audit — scenario A 达成（2026-05-29） |
| `docs/archive/superpowers/audits/2026-05-31-p5-chain-closeout.md` | `docs/archive/superpowers/audits/2026-05-31-p5-chain-closeout.md` | P5 Chain Closeout — brainstorm-open-questions chain 达成（2026-05-31） |
| `docs/archive/superpowers/audits/2026-06-01-data-activation-closeout.md` | `docs/archive/superpowers/audits/2026-06-01-data-activation-closeout.md` | Data-Activation Drive Closeout — Layer-8 lit up + validated (2026-06-01) |
| `docs/archive/superpowers/audits/2026-06-05-strategy-d-kickoff-briefing.md` | `docs/archive/superpowers/audits/2026-06-05-strategy-d-kickoff-briefing.md` | Strategy D 开工决策简报 |
| `docs/archive/superpowers/brainstorms/2026-05-14-phase1c-encounter-session-ui.md` | `docs/archive/superpowers/brainstorms/2026-05-14-phase1c-encounter-session-ui.md` | Phase 1c Brainstorm — Encounter / Session 抽象 + UI 闭环 |
| `docs/archive/superpowers/brainstorms/2026-05-17-agent-context-tools-docs.md` | `docs/archive/superpowers/brainstorms/2026-05-17-agent-context-tools-docs.md` | Agent Context Tools — Brainstorm + Doc Map |
| `docs/archive/superpowers/brainstorms/2026-05-17-phase2b-learning-intent.md` | `docs/archive/superpowers/brainstorms/2026-05-17-phase2b-learning-intent.md` | Phase 2B Learning Intent Orchestrator — Brainstorm + Scope Fence |
| `docs/archive/superpowers/brainstorms/2026-05-17-phase2c-active-teaching.md` | `docs/archive/superpowers/brainstorms/2026-05-17-phase2c-active-teaching.md` | Phase 2C — Active Teaching Session MVP brainstorm |
| `docs/archive/superpowers/plans/2026-05-08-phase1-pr1-infrastructure.md` | `docs/archive/superpowers/plans/2026-05-08-phase1-pr1-infrastructure.md` | Phase 1 PR 1 (基础设施) Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-08-phase1-pr2-ai-runner.md` | `docs/archive/superpowers/plans/2026-05-08-phase1-pr2-ai-runner.md` | Phase 1 PR 2 (AI 接通) Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-08-phase1-pr3-observability-docs.md` | `docs/archive/superpowers/plans/2026-05-08-phase1-pr3-observability-docs.md` | Phase 1 PR 3 (观测 + 文档收尾) Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-09-ingestion-pipeline-foundation.md` | `docs/archive/superpowers/plans/2026-05-09-ingestion-pipeline-foundation.md` | Phase 1.5 Implementation Plan — Ingestion Pipeline Foundation |
| `docs/archive/superpowers/plans/2026-05-09-phase1a-sub1-pr-a.md` | `docs/archive/superpowers/plans/2026-05-09-phase1a-sub1-pr-a.md` | Phase 1a Sub 1 PR A — 知识图谱基础 + propose_new mutation Implementation |
| `docs/archive/superpowers/plans/2026-05-09-phase1a-sub1-pr-b.md` | `docs/archive/superpowers/plans/2026-05-09-phase1a-sub1-pr-b.md` | Phase 1a Sub 1 PR B — 高阶 mutation + KnowledgeReviewTask Implementation Pla |
| `docs/archive/superpowers/plans/2026-05-09-phase1a-sub2.md` | `docs/archive/superpowers/plans/2026-05-09-phase1a-sub2.md` | Phase 1a Sub 2 Implementation Plan — 录入闭环 |
| `docs/archive/superpowers/plans/2026-05-09-phase1a-sub3.md` | `docs/archive/superpowers/plans/2026-05-09-phase1a-sub3.md` | Phase 1a Sub 3 Implementation Plan — AttributionTask AI 接通 |
| `docs/archive/superpowers/plans/2026-05-10-phase1a-sub4a.md` | `docs/archive/superpowers/plans/2026-05-10-phase1a-sub4a.md` | Phase 1a Sub 4A Implementation Plan — Mistake FSRS + review_event + /review |
| `docs/archive/superpowers/plans/2026-05-10-phase1a-sub4b.md` | `docs/archive/superpowers/plans/2026-05-10-phase1a-sub4b.md` | Phase 1a Sub 4B Implementation Plan — LearningItem 三态 + CompletionEvidence |
| `docs/archive/superpowers/plans/2026-05-10-phase1a-sub4c.md` | `docs/archive/superpowers/plans/2026-05-10-phase1a-sub4c.md` | Phase 1a Sub 4C Implementation Plan — Capture 流重整 + Tencent OCR Tier-1 + |
| `docs/archive/superpowers/plans/2026-05-10-phase1a-sub5.md` | `docs/archive/superpowers/plans/2026-05-10-phase1a-sub5.md` | Phase 1a Sub 5 Implementation Plan — D1 + R2 backup/restore via ZIP |
| `docs/archive/superpowers/plans/2026-05-11-sub0a-stack-migration.md` | `docs/archive/superpowers/plans/2026-05-11-sub0a-stack-migration.md` | Sub 0a Implementation Plan — Stack Migration Infrastructure |
| `docs/archive/superpowers/plans/2026-05-11-sub0b1-api-route-migration.md` | `docs/archive/superpowers/plans/2026-05-11-sub0b1-api-route-migration.md` | Sub 0b1: API Route Migration Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-11-sub0c-async-and-ocr-upgrade.md` | `docs/archive/superpowers/plans/2026-05-11-sub0c-async-and-ocr-upgrade.md` | Sub 0c: 异步 lane + Tencent OCR 升级 · Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-11-sub0d-agent-layer.md` | `docs/archive/superpowers/plans/2026-05-11-sub0d-agent-layer.md` | Sub 0d: Agent Layer · Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-14-phase1c1-encounter-session-ui-scaffold.md` | `docs/archive/superpowers/plans/2026-05-14-phase1c1-encounter-session-ui-scaffold.md` | Phase 1c.1 Implementation Plan — event 核 + learning_session + mesh + UI 脚�
plans|docs/archive/superpowers/plans/2026-05-14-phase1c2-ui-main.md|Phase 1c.2 Implementation Plan — UI 主切片（六页，loom 对齐版） |
| `docs/archive/superpowers/plans/2026-05-16-phase1c1-step12-docs-alignment.md` | `docs/archive/superpowers/plans/2026-05-16-phase1c1-step12-docs-alignment.md` | Phase 1c.1 Step 12 — docs alignment (architecture.md + CONTEXT.md final pass) |
| `docs/archive/superpowers/plans/2026-05-16-phase1c1-step3-migration.md` | `docs/archive/superpowers/plans/2026-05-16-phase1c1-step3-migration.md` | Phase 1c.1 Step 3 — TDD substeps + subagent prompt |
| `docs/archive/superpowers/plans/2026-05-16-phase1c1-step4-server-readpath.md` | `docs/archive/superpowers/plans/2026-05-16-phase1c1-step4-server-readpath.md` | Phase 1c.1 Step 4 — Server read-path rewrite (mistake → event stream) |
| `docs/archive/superpowers/plans/2026-05-16-phase1c1-step5-learning-session.md` | `docs/archive/superpowers/plans/2026-05-16-phase1c1-step5-learning-session.md` | Phase 1c.1 Step 5 — IngestionSession → src/server/session/ multi-type module |
| `docs/archive/superpowers/plans/2026-05-16-phase1c1-step6-api-routes.md` | `docs/archive/superpowers/plans/2026-05-16-phase1c1-step6-api-routes.md` | Phase 1c.1 Step 6 — API routes rewrite (mistakes-over-events + new /api/events |
| `docs/archive/superpowers/plans/2026-05-16-phase1c1-step7-ai-prompts.md` | `docs/archive/superpowers/plans/2026-05-16-phase1c1-step7-ai-prompts.md` | Phase 1c.1 Step 7 — AI prompts + registry rewrite (event-stream language + bri |
| `docs/archive/superpowers/plans/2026-05-16-phase1c1-step8-migration-wire.md` | `docs/archive/superpowers/plans/2026-05-16-phase1c1-step8-migration-wire.md` | Phase 1c.1 Step 8 — Wire migration into test setup + mastery view smoke |
| `docs/archive/superpowers/plans/2026-05-16-phase1c1-step9-drop-legacy.md` | `docs/archive/superpowers/plans/2026-05-16-phase1c1-step9-drop-legacy.md` | Phase 1c.1 Step 9 — DROP legacy tables (point of no return) + final invariant  |
| `docs/archive/superpowers/plans/2026-05-18-capability-registry-foundation.md` | `docs/archive/superpowers/plans/2026-05-18-capability-registry-foundation.md` | Capability Registry Foundation (Phase N+1) Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-18-learning-data-loop.md` | `docs/archive/superpowers/plans/2026-05-18-learning-data-loop.md` | Learning Data Loop Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-19-foundation-b-evidence-contract-bridge.md` | `docs/archive/superpowers/plans/2026-05-19-foundation-b-evidence-contract-bridge.md` | Foundation B Evidence Contract Bridge Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-19-foundation-closeout-correction-event.md` | `docs/archive/superpowers/plans/2026-05-19-foundation-closeout-correction-event.md` | Foundation Closeout + Correction Event Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-19-frontend-subject-awareness.md` | `docs/archive/superpowers/plans/2026-05-19-frontend-subject-awareness.md` | N+1 Frontend Subject Awareness Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-19-note-verify-pass2.md` | `docs/archive/superpowers/plans/2026-05-19-note-verify-pass2.md` | Note Verify Pass 2 Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-19-profile-blind-ai-tasks-closeout.md` | `docs/archive/superpowers/plans/2026-05-19-profile-blind-ai-tasks-closeout.md` | Profile-Blind AI Tasks Closeout Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-20-activity-ref-shim-closeout.md` | `docs/archive/superpowers/plans/2026-05-20-activity-ref-shim-closeout.md` | ActivityRef Shim Closeout Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-20-judge-v2-light-gap-gates.md` | `docs/archive/superpowers/plans/2026-05-20-judge-v2-light-gap-gates.md` | Judge v2 Light + Gap Prevention Gates Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-20-local-dev-db-alignment.md` | `docs/archive/superpowers/plans/2026-05-20-local-dev-db-alignment.md` | Local Dev DB Alignment Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-21-embedded-check-mvp-review-fixes.md` | `docs/archive/superpowers/plans/2026-05-21-embedded-check-mvp-review-fixes.md` | Embedded Check MVP Review Fixes Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-21-embedded-check-mvp.md` | `docs/archive/superpowers/plans/2026-05-21-embedded-check-mvp.md` | Embedded Check MVP Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-21-math-mvp-m-1-m0.md` | `docs/archive/superpowers/plans/2026-05-21-math-mvp-m-1-m0.md` | Math MVP — M-1 + M0 Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-21-test-feedback-loop-optimization.md` | `docs/archive/superpowers/plans/2026-05-21-test-feedback-loop-optimization.md` | Test Feedback Loop Optimization Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-22-foundation-closeout-p-1-preflight.md` | `docs/archive/superpowers/plans/2026-05-22-foundation-closeout-p-1-preflight.md` | Foundation 真 Closeout — P-1 Preflight + Audit + Physics Fixture Seed |
| `docs/archive/superpowers/plans/2026-05-22-foundation-true-closeout-phases.md` | `docs/archive/superpowers/plans/2026-05-22-foundation-true-closeout-phases.md` | Foundation 真 Closeout — Phase 大纲 |
| `docs/archive/superpowers/plans/2026-05-22-math-m1-drift-targets.md` | `docs/archive/superpowers/plans/2026-05-22-math-m1-drift-targets.md` | Math M1 — Drift Migration Targets |
| `docs/archive/superpowers/plans/2026-05-22-math-mvp-closeout.md` | `docs/archive/superpowers/plans/2026-05-22-math-mvp-closeout.md` | Math MVP — Closeout |
| `docs/archive/superpowers/plans/2026-05-22-math-mvp-m1.md` | `docs/archive/superpowers/plans/2026-05-22-math-mvp-m1.md` | Math MVP — M1 Foundation Cleanup Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-22-math-mvp-m2-1-steps-skeleton.md` | `docs/archive/superpowers/plans/2026-05-22-math-mvp-m2-1-steps-skeleton.md` | Math MVP — M2.1 steps@1 Capability Skeleton Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-22-math-mvp-m2-2-steps-impl.md` | `docs/archive/superpowers/plans/2026-05-22-math-mvp-m2-2-steps-impl.md` | Math MVP — M2.2 steps@1 Vision Judge Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-22-math-mvp-m2-3-katex-ui-appeal.md` | `docs/archive/superpowers/plans/2026-05-22-math-mvp-m2-3-katex-ui-appeal.md` | Math MVP — M2.3 KaTeX + UI Surfaces + Appeal Flow Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-22-math-mvp-m3-closeout.md` | `docs/archive/superpowers/plans/2026-05-22-math-mvp-m3-closeout.md` | Math MVP — M3 Closeout (Final Sweep) Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-23-foundation-closeout-p0-physics-profile.md` | `docs/archive/superpowers/plans/2026-05-23-foundation-closeout-p0-physics-profile.md` | Foundation 真 Closeout — P0 Physics Profile + Foundation B Acid Test 1 |
| `docs/archive/superpowers/plans/2026-05-23-foundation-closeout-p2-unit-dimension-impl.md` | `docs/archive/superpowers/plans/2026-05-23-foundation-closeout-p2-unit-dimension-impl.md` | Foundation 真 Closeout — P2 unit_dimension@1 Real Implementation |
| `docs/archive/superpowers/plans/2026-05-23-l1-judge-invoker.md` | `docs/archive/superpowers/plans/2026-05-23-l1-judge-invoker.md` | YUK-39 L1 JudgeInvoker Execution Plan |
| `docs/archive/superpowers/plans/2026-05-23-l2-subject-profile-validator.md` | `docs/archive/superpowers/plans/2026-05-23-l2-subject-profile-validator.md` | L2 Subject Profile Validator Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-23-l3-correction-read-model.md` | `docs/archive/superpowers/plans/2026-05-23-l3-correction-read-model.md` | L3 Correction Read Model Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-23-l4-ai-obs-admin.md` | `docs/archive/superpowers/plans/2026-05-23-l4-ai-obs-admin.md` | L4 AI Observability Admin Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-23-l5-1-proposal-union-writer.md` | `docs/archive/superpowers/plans/2026-05-23-l5-1-proposal-union-writer.md` | L5.1 Proposal Union Writer Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-23-l5-2-proposal-inbox-ui.md` | `docs/archive/superpowers/plans/2026-05-23-l5-2-proposal-inbox-ui.md` | L5.2 Proposal Inbox UI Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-23-l5-3-producers-and-signals.md` | `docs/archive/superpowers/plans/2026-05-23-l5-3-producers-and-signals.md` | L5.3 Producers And Signals Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-23-l6-allowlist-expiry.md` | `docs/archive/superpowers/plans/2026-05-23-l6-allowlist-expiry.md` | L6 audit:schema Allowlist Expiry Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-23-track2-and-foundation-closeout-phases.md` | `docs/archive/superpowers/plans/2026-05-23-track2-and-foundation-closeout-phases.md` | Track 2 起步 + Foundation 末尾收口 — Phase 大纲 |
| `docs/archive/superpowers/plans/2026-05-23-yuk-48-knowledge-maintenance-nightly.md` | `docs/archive/superpowers/plans/2026-05-23-yuk-48-knowledge-maintenance-nightly.md` | YUK-48 Knowledge Maintenance Nightly Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-24-product-track-1-closeout.md` | `docs/archive/superpowers/plans/2026-05-24-product-track-1-closeout.md` | Product Track 1 — Review / Learning Item / Teaching Loop 收口 Phase 大纲 |
| `docs/archive/superpowers/plans/2026-05-24-yuk-14-teaching-idle-impl.md` | `docs/archive/superpowers/plans/2026-05-24-yuk-14-teaching-idle-impl.md` | YUK-14 — Teaching idle state machine impl plan |
| `docs/archive/superpowers/plans/2026-05-24-yuk-15-record-proposal-loop.md` | `docs/archive/superpowers/plans/2026-05-24-yuk-15-record-proposal-loop.md` | YUK-15 — record ↔ proposal evidence loop 接通 |
| `docs/archive/superpowers/plans/2026-05-24-yuk-17-variant-double-pass.md` | `docs/archive/superpowers/plans/2026-05-24-yuk-17-variant-double-pass.md` | YUK-17 — Variant Double-Pass + variants_max=3 + draft→active Lifecycle |
| `docs/archive/superpowers/plans/2026-05-24-yuk-19-learning-item-rollback.md` | `docs/archive/superpowers/plans/2026-05-24-yuk-19-learning-item-rollback.md` | YUK-19 — Learning-item proposal rollback UI |
| `docs/archive/superpowers/plans/2026-05-24-yuk-52-note-markdown.md` | `docs/archive/superpowers/plans/2026-05-24-yuk-52-note-markdown.md` | YUK-52 Note Read UX: Markdown Rendering in Atomic Sections — Implementation Pl |
| `docs/archive/superpowers/plans/2026-05-24-yuk-56-review-judge-auto-rate.md` | `docs/archive/superpowers/plans/2026-05-24-yuk-56-review-judge-auto-rate.md` | YUK-56 — Review P2.1: connect judge router for auto-rating |
| `docs/archive/superpowers/plans/2026-05-24-yuk-57-review-skip-pause-resume.md` | `docs/archive/superpowers/plans/2026-05-24-yuk-57-review-skip-pause-resume.md` | YUK-57 — Review UX P2.2: skip + pause/resume session |
| `docs/archive/superpowers/plans/2026-05-24-yuk-58-review-attempt-timeline.md` | `docs/archive/superpowers/plans/2026-05-24-yuk-58-review-attempt-timeline.md` | YUK-58 — Review feedback attempt timeline (P2.3) |
| `docs/archive/superpowers/plans/2026-05-25-pr125-codex-fix.md` | `docs/archive/superpowers/plans/2026-05-25-pr125-codex-fix.md` | PR #125 codex review sweep — round 2 |
| `docs/archive/superpowers/plans/2026-05-25-yuk-53-note-embedded-check-inline.md` | `docs/archive/superpowers/plans/2026-05-25-yuk-53-note-embedded-check-inline.md` | YUK-53 — Note embedded check inline |
| `docs/archive/superpowers/plans/2026-05-25-yuk-54-note-section-edit-in-place.md` | `docs/archive/superpowers/plans/2026-05-25-yuk-54-note-section-edit-in-place.md` | YUK-54 Note Section Edit In Place Plan |
| `docs/archive/superpowers/plans/2026-05-25-yuk-55-note-verification-badge.md` | `docs/archive/superpowers/plans/2026-05-25-yuk-55-note-verification-badge.md` | YUK-55 — Note verification badge |
| `docs/archive/superpowers/plans/2026-05-25-yuk-59-review-session-end-cta.md` | `docs/archive/superpowers/plans/2026-05-25-yuk-59-review-session-end-cta.md` | YUK-59 — Review session-end next-step CTA |
| `docs/archive/superpowers/plans/2026-05-25-yuk-60-review-subject-switch-marker.md` | `docs/archive/superpowers/plans/2026-05-25-yuk-60-review-subject-switch-marker.md` | YUK-60 — Review subject switch marker |
| `docs/archive/superpowers/plans/2026-05-25-yuk-61-review-answer-preview.md` | `docs/archive/superpowers/plans/2026-05-25-yuk-61-review-answer-preview.md` | YUK-61 — Review answer markdown/math preview |
| `docs/archive/superpowers/plans/2026-05-25-yuk-62-review-intent-banner.md` | `docs/archive/superpowers/plans/2026-05-25-yuk-62-review-intent-banner.md` | YUK-62 ReviewIntent Banner Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-25-yuk-63-abandoned-session-resume.md` | `docs/archive/superpowers/plans/2026-05-25-yuk-63-abandoned-session-resume.md` | YUK-63 Abandoned Review Session Resume Implementation Plan |
| `docs/archive/superpowers/plans/2026-05-26-note-appeal-mark-wrong.md` | `docs/archive/superpowers/plans/2026-05-26-note-appeal-mark-wrong.md` | YUK-85 — Note 申诉 / 标错 UX (Path A: artifact + section_id 粒度) |
| `docs/archive/superpowers/plans/2026-05-26-today-kpi-inbox.md` | `docs/archive/superpowers/plans/2026-05-26-today-kpi-inbox.md` | YUK-84 — /today KPI inbox pending count |
| `docs/archive/superpowers/plans/2026-05-26-track-1-followup-phase.md` | `docs/archive/superpowers/plans/2026-05-26-track-1-followup-phase.md` | Track-1 Follow-up Phase 大纲 |
| `docs/archive/superpowers/plans/2026-05-26-wenyan-cause-migration.md` | `docs/archive/superpowers/plans/2026-05-26-wenyan-cause-migration.md` | YUK-83 — wenyan profile.causeCategories 100% migration |
| `docs/archive/superpowers/plans/2026-05-26-yuk88-autonomous-driver.md` | `docs/archive/superpowers/plans/2026-05-26-yuk88-autonomous-driver.md` | YUK-88 Block-Tree Note Rebuild — Autonomous Roadmap Driver Prompt |
| `docs/archive/superpowers/plans/2026-05-26-yuk88-block-tree-rebuild-phase.md` | `docs/archive/superpowers/plans/2026-05-26-yuk88-block-tree-rebuild-phase.md` | YUK-88 Block-Tree Note Rebuild Phase 大纲（P0-P7） |
| `docs/archive/superpowers/plans/2026-05-26-yuk88-p0-spike.md` | `docs/archive/superpowers/plans/2026-05-26-yuk88-p0-spike.md` | YUK-88 P0 — TipTap Spike (block tree fixture + mark_wrong + idle mock) |
| `docs/archive/superpowers/plans/2026-05-26-yuk88-p1-schema.md` | `docs/archive/superpowers/plans/2026-05-26-yuk88-p1-schema.md` | YUK-88 P1 — Schema + ADR-0020 Core Contract |
| `docs/archive/superpowers/plans/2026-05-26-yuk88-p2-basic.md` | `docs/archive/superpowers/plans/2026-05-26-yuk88-p2-basic.md` | YUK-88 P2-basic — TipTap Editor + BlockTreeRenderer |
| `docs/archive/superpowers/plans/2026-05-26-yuk88-p3-ai-pipeline.md` | `docs/archive/superpowers/plans/2026-05-26-yuk88-p3-ai-pipeline.md` | YUK-88 P3 — AI Pipeline Rewrite Driver |
| `docs/archive/superpowers/plans/2026-05-27-master-roadmap.md` | `docs/archive/superpowers/plans/2026-05-27-master-roadmap.md` | Master Roadmap & Autonomous Execution Driver |
| `docs/archive/superpowers/plans/2026-05-27-t37-brief-writer-driver.md` | `docs/archive/superpowers/plans/2026-05-27-t37-brief-writer-driver.md` | T-37 Brief Writer Phase B — Track Driver |
| `docs/archive/superpowers/plans/2026-05-27-t37-mem0-spike-findings.md` | `docs/archive/superpowers/plans/2026-05-27-t37-mem0-spike-findings.md` | T-37 Mem0 spike findings (Wave 1 worktree A lane subagent) |
| `docs/archive/superpowers/plans/2026-05-27-t66-teaching-ask-check-driver.md` | `docs/archive/superpowers/plans/2026-05-27-t66-teaching-ask-check-driver.md` | T-66 Teaching ask_check Artifact — Track Driver |
| `docs/archive/superpowers/plans/2026-05-27-td2-read-tools-driver.md` | `docs/archive/superpowers/plans/2026-05-27-td2-read-tools-driver.md` | T-D2 — DomainTool Registry M2 Read Tools Driver |
| `docs/archive/superpowers/plans/2026-05-27-tra-rating-advisor-driver.md` | `docs/archive/superpowers/plans/2026-05-27-tra-rating-advisor-driver.md` | T-RA RatingAdvisor — Track Driver |
| `docs/archive/superpowers/plans/2026-05-27-wave1-lane-w-a-fix.md` | `docs/archive/superpowers/plans/2026-05-27-wave1-lane-w-a-fix.md` | Wave 1 Post-Ship Lane W-A — Fix Plan |
| `docs/archive/superpowers/plans/2026-05-27-wave1-lane-w-b-fix.md` | `docs/archive/superpowers/plans/2026-05-27-wave1-lane-w-b-fix.md` | Wave 1 Lane W-B — RatingAdvisor cause wiring fix |
| `docs/archive/superpowers/plans/2026-05-27-wave1-postship-iter2-plan.md` | `docs/archive/superpowers/plans/2026-05-27-wave1-postship-iter2-plan.md` | Wave 1 Post-Ship Iter-2 — Code-Review Findings Fix Plan |
| `docs/archive/superpowers/plans/2026-05-27-wave1-ready-to-launch.md` | `docs/archive/superpowers/plans/2026-05-27-wave1-ready-to-launch.md` | Wave 1 Ready-to-Launch Artifact List — 2026-05-27 |
| `docs/archive/superpowers/plans/2026-05-27-wave2-ready-to-launch.md` | `docs/archive/superpowers/plans/2026-05-27-wave2-ready-to-launch.md` | Wave 2 Ready-to-Launch — Schema + Editor Basic + DomainTool M2 |
| `docs/archive/superpowers/plans/2026-05-27-yuk101-outbox-lane.md` | `docs/archive/superpowers/plans/2026-05-27-yuk101-outbox-lane.md` | YUK-101 — Transactional outbox for writeEvent → memory event ingest |
| `docs/archive/superpowers/plans/2026-05-28-td4-propose-write-tools-driver.md` | `docs/archive/superpowers/plans/2026-05-28-td4-propose-write-tools-driver.md` | T-D4 — DomainTool Propose/Write Tools Driver |
| `docs/archive/superpowers/plans/2026-05-28-tdr-dreaming-lane-driver.md` | `docs/archive/superpowers/plans/2026-05-28-tdr-dreaming-lane-driver.md` | T-DR — Dreaming Lane Driver |
| `docs/archive/superpowers/plans/2026-05-28-wave3-ready-to-launch.md` | `docs/archive/superpowers/plans/2026-05-28-wave3-ready-to-launch.md` | Wave 3 Ship Outcome — DomainTool Propose/Write Tools |
| `docs/archive/superpowers/plans/2026-05-28-wave4-ready-to-launch.md` | `docs/archive/superpowers/plans/2026-05-28-wave4-ready-to-launch.md` | Wave 4 Ready-to-Launch — YUK-88 P3 + T-DR Dreaming |
| `docs/archive/superpowers/plans/2026-05-29-p6-codex-deadlink-fixes.md` | `docs/archive/superpowers/plans/2026-05-29-p6-codex-deadlink-fixes.md` | Lane plan — P6 node-page dead-link fixes (Codex PR #193 review) |
| `docs/archive/superpowers/plans/2026-05-29-wave5-ready-to-launch.md` | `docs/archive/superpowers/plans/2026-05-29-wave5-ready-to-launch.md` | Wave 5 Ready-to-Launch — Drawer /today MVP + Global Coach Orchestrator |
| `docs/archive/superpowers/plans/2026-05-29-wave6-ready-to-launch.md` | `docs/archive/superpowers/plans/2026-05-29-wave6-ready-to-launch.md` | Wave 6 Ready-to-Launch — Living Note v0 + experimental:tool_use promote |
| `docs/archive/superpowers/plans/2026-05-29-wave7-ready-to-launch.md` | `docs/archive/superpowers/plans/2026-05-29-wave7-ready-to-launch.md` | Wave 7 Ready-to-Launch — Living Note 反链/cross_link/hub auto-sync + Knowled |
| `docs/archive/superpowers/plans/2026-05-29-wave8-c-review-fix.md` | `docs/archive/superpowers/plans/2026-05-29-wave8-c-review-fix.md` | Wave 8 — Lane C: 2026-05-29 deep-review fixes |
| `docs/archive/superpowers/plans/2026-05-29-wave8-ready-to-launch.md` | `docs/archive/superpowers/plans/2026-05-29-wave8-ready-to-launch.md` | Wave 8 Ready-to-Launch — YUK-88 P6/P7 + P2-polish + T-PD 收尾 + v1 closeout |
| `docs/archive/superpowers/plans/2026-05-29-wave8-review2.md` | `docs/archive/superpowers/plans/2026-05-29-wave8-review2.md` | Wave 8 review-fix-2 lane plan (against fresh main 3f8dd071) |
| `docs/archive/superpowers/plans/2026-05-29-yuk150-p2-polish-lane.md` | `docs/archive/superpowers/plans/2026-05-29-yuk150-p2-polish-lane.md` | YUK-150 P2-polish lane plan (Wave 8 / W8-2) |
| `docs/archive/superpowers/plans/2026-05-29-yuk96-p6-lane.md` | `docs/archive/superpowers/plans/2026-05-29-yuk96-p6-lane.md` | YUK-96 P6 Lane Plan — read-view deletions + mark-wrong drill + /knowledge/[id] |
| `docs/archive/superpowers/plans/2026-05-30-yuk-tar-acceptance-signal.md` | `docs/archive/superpowers/plans/2026-05-30-yuk-tar-acceptance-signal.md` | T-AR — Acceptance-rate / dismiss signal (foundation + additive Dreaming wiring |
| `docs/archive/superpowers/plans/2026-05-30-yuk143-northstar-core-lane.md` | `docs/archive/superpowers/plans/2026-05-30-yuk143-northstar-core-lane.md` | Lane plan — North-Star / Learning-Intent CORE (YUK-143, Wave-9) |
| `docs/archive/superpowers/plans/2026-05-30-yuk145-toc-slice1-lane.md` | `docs/archive/superpowers/plans/2026-05-30-yuk145-toc-slice1-lane.md` | YUK-145 T-OC Slice 1 — Generalized Capture (the MODEL fix) — Lane Plan |
| `docs/archive/superpowers/plans/2026-05-30-yuk145-toc-slice2-lane.md` | `docs/archive/superpowers/plans/2026-05-30-yuk145-toc-slice2-lane.md` | YUK-145 T-OC Slice 2 — VLM StructureTask (the structure owner) — Lane Plan |
| `docs/archive/superpowers/plans/2026-05-30-yuk145-toc-slice3-lane.md` | `docs/archive/superpowers/plans/2026-05-30-yuk145-toc-slice3-lane.md` | YUK-145 T-OC Slice 3 — TaggingTask + WorkflowJudge + flag-gated auto-enroll �
plans|docs/archive/superpowers/plans/2026-05-30-yuk148-redis-lane.md|YUK-148 — Cross-process editing presence via Redis (lane plan) |
| `docs/archive/superpowers/plans/2026-05-30-yuk165-question-part-lane.md` | `docs/archive/superpowers/plans/2026-05-30-yuk165-question-part-lane.md` | Lane plan — T-QP (YUK-165): question_part ActivityKind |
| `docs/archive/superpowers/plans/2026-05-30-yuk168-cross-subject-scheduling-lane.md` | `docs/archive/superpowers/plans/2026-05-30-yuk168-cross-subject-scheduling-lane.md` | T-CS (YUK-168) — Cross-subject scheduling v1 (round-robin) — lane plan |
| `docs/archive/superpowers/plans/2026-06-01-solve-tutor.md` | `docs/archive/superpowers/plans/2026-06-01-solve-tutor.md` | IMPLEMENTATION PLAN — 解题陪练 (Solve-Tutor), YUK-193 |
| `docs/archive/superpowers/plans/2026-06-04-redraw-wave2-plan.md` | `docs/archive/superpowers/plans/2026-06-04-redraw-wave2-plan.md` | Redraw Wave-2 — 统合计划（YUK-169 · 2026-06-04） |
| `docs/archive/superpowers/plans/2026-06-04-u4-reviewplan-pipeline.md` | `docs/archive/superpowers/plans/2026-06-04-u4-reviewplan-pipeline.md` | U4 — ReviewPlan Pipeline Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-05-strategy-d-s1-ingest-practice-bridge.md` | `docs/archive/superpowers/plans/2026-06-05-strategy-d-s1-ingest-practice-bridge.md` | Strategy D · S1 — ingest→practice 桥接 implementation plan |
| `docs/archive/superpowers/plans/2026-06-05-u5-paper-model.md` | `docs/archive/superpowers/plans/2026-06-05-u5-paper-model.md` | U5 — Paper Model + Practice Surface Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-05-u6-chat-merge.md` | `docs/archive/superpowers/plans/2026-06-05-u6-chat-merge.md` | U6 — Merge Three Chat Surfaces Into Copilot (AF S4) Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-05-u7-studio-mvp.md` | `docs/archive/superpowers/plans/2026-06-05-u7-studio-mvp.md` | U7 — Editable Profile Studio MVP Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-05-yuk216-question-source-s2.md` | `docs/archive/superpowers/plans/2026-06-05-yuk216-question-source-s2.md` | YUK-216 题源扩展（Strategy D · S2）— Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-06-yuk164-oc5-review-surface.md` | `docs/archive/superpowers/plans/2026-06-06-yuk164-oc5-review-surface.md` | YUK-164 OC-5 — Auto-enroll review surface + VisionTab AI prefill (lane plan) |
| `docs/archive/superpowers/plans/2026-06-06-yuk227-s3-image-reachability.md` | `docs/archive/superpowers/plans/2026-06-06-yuk227-s3-image-reachability.md` | YUK-227 图片素材可达性 — Strategy D S3 实施计划 |
| `docs/archive/superpowers/plans/2026-06-06-yuk250-pdf-ingest.md` | `docs/archive/superpowers/plans/2026-06-06-yuk250-pdf-ingest.md` | YUK-250 — PDF Ingest Lane Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-07-yuk253-glm-ocr-swap.md` | `docs/archive/superpowers/plans/2026-06-07-yuk253-glm-ocr-swap.md` | YUK-253 — GLM-OCR engine swap (lane plan) |
| `docs/archive/superpowers/plans/2026-06-07-yuk258-docx-ingest.md` | `docs/archive/superpowers/plans/2026-06-07-yuk258-docx-ingest.md` | YUK-258 — DOCX 试卷上传 → 文本线 / 视觉线双管线 ingestion |
| `docs/archive/superpowers/plans/2026-06-07-yuk262-copilot-quiz-skill.md` | `docs/archive/superpowers/plans/2026-06-07-yuk262-copilot-quiz-skill.md` | YUK-262 — Copilot Quiz Skill (lane plan) |
| `docs/archive/superpowers/plans/2026-06-07-yuk271-block-merge-accept.md` | `docs/archive/superpowers/plans/2026-06-07-yuk271-block-merge-accept.md` | YUK-271 — block_merge proposal accept 兑现 + inbox 接受按钮启用 |
| `docs/archive/superpowers/plans/2026-06-07-yuk280-question-bank-api.md` | `docs/archive/superpowers/plans/2026-06-07-yuk280-question-bank-api.md` | YUK-280 — P4 题库 backend API（文件级实施计划） |
| `docs/archive/superpowers/plans/2026-06-07-yuk282-variant-rotation.md` | `docs/archive/superpowers/plans/2026-06-07-yuk282-variant-rotation.md` | YUK-282 — 变式轮换探针：by-kind 选题路由 + 变式家族轮换（实 |
| `docs/archive/superpowers/plans/2026-06-08-yuk284-debt-wave.md` | `docs/archive/superpowers/plans/2026-06-08-yuk284-debt-wave.md` | YUK-284 · Copilot 清债 wave — 三 commit 实施计划 |
| `docs/archive/superpowers/plans/2026-06-08-yuk288-qbank-ui.md` | `docs/archive/superpowers/plans/2026-06-08-yuk288-qbank-ui.md` | YUK-288 — 题库 UI S1（只读侧） · 实施计划 |
| `docs/archive/superpowers/plans/2026-06-08-yuk294-agent-notes-ui.md` | `docs/archive/superpowers/plans/2026-06-08-yuk294-agent-notes-ui.md` | YUK-294 — AgentNotes 看板（"AI 观察" 只读旁观块）Lane Plan |
| `docs/archive/superpowers/plans/2026-06-08-yuk297-visual-refinement.md` | `docs/archive/superpowers/plans/2026-06-08-yuk297-visual-refinement.md` | YUK-297 视觉 refinement 实施 plan — 知识图谱 SVG 重写 + 全局精修 |
| `docs/archive/superpowers/plans/2026-06-08-yuk299-seam.md` | `docs/archive/superpowers/plans/2026-06-08-yuk299-seam.md` | YUK-299 — Agent SDK outputFormat Seam 基建 + 首个试点（文件级实施�
plans|docs/archive/superpowers/plans/2026-06-10-m0-skeleton.md|M0：新骨架示踪弹 — Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-10-m1-ingestion.md` | `docs/archive/superpowers/plans/2026-06-10-m1-ingestion.md` | M1：录入竖切 — Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-10-m2-practice-stream.md` | `docs/archive/superpowers/plans/2026-06-10-m2-practice-stream.md` | M2：练习流竖切 — Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-10-p1-kernel-agent-notes.md` | `docs/archive/superpowers/plans/2026-06-10-p1-kernel-agent-notes.md` | 架构重设计 P1：内核立柱 + agent-notes 打样首包 — Implementation  |
| `docs/archive/superpowers/plans/2026-06-10-p2a-practice-move.md` | `docs/archive/superpowers/plans/2026-06-10-p2a-practice-move.md` | P2a：practice 包等价平移 — Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-11-m3-knowledge-notes.md` | `docs/archive/superpowers/plans/2026-06-11-m3-knowledge-notes.md` | M3：知识与笔记 — Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-11-m4-agency-workbench.md` | `docs/archive/superpowers/plans/2026-06-11-m4-agency-workbench.md` | M4：能动 + 工作台 — Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-12-yuk-321-m5-plan.md` | `docs/archive/superpowers/plans/2026-06-12-yuk-321-m5-plan.md` | M5 实施计划 — Copilot 收口 + 拆除（YUK-321） |
| `docs/archive/superpowers/plans/2026-06-13-domain-tool-depth-regrounded-scope.md` | `docs/archive/superpowers/plans/2026-06-13-domain-tool-depth-regrounded-scope.md` | 领域/Copilot 工具深化 — Re-grounded 范围图（ADR-0031/0032/0033 ↔ M |
| `docs/archive/superpowers/plans/2026-06-13-yuk-321-pg-presence-subplan.md` | `docs/archive/superpowers/plans/2026-06-13-yuk-321-pg-presence-subplan.md` | PgPresenceStore 子计划（M5 gate 选项 b 前置子任务，YUK-321） |
| `docs/archive/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md` | `docs/archive/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md` | Personalized Calibration + Urnings-Lite Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-15-unified-impl-wave-sequence.md` | `docs/archive/superpowers/plans/2026-06-15-unified-impl-wave-sequence.md` | 统一实施波次序 — 跨三线（#47 copilot 全能 / #46 选题引擎 / YU |
| `docs/archive/superpowers/plans/2026-06-15-w2-selection-engine-lane-plan.md` | `docs/archive/superpowers/plans/2026-06-15-w2-selection-engine-lane-plan.md` | W2 选题引擎实施 lane plan |
| `docs/archive/superpowers/plans/2026-06-15-yuk-364-copilot-durable-run-plan.md` | `docs/archive/superpowers/plans/2026-06-15-yuk-364-copilot-durable-run-plan.md` | YUK-364 — Copilot durable run（endurance W1 L2）lane plan |
| `docs/archive/superpowers/plans/2026-06-16-phase0-retrieval-substrate-foundation.md` | `docs/archive/superpowers/plans/2026-06-16-phase0-retrieval-substrate-foundation.md` | Phase 0 — 检索底座地基（语义 embedding）Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-16-phase3-randomized-mfi-impl.md` | `docs/archive/superpowers/plans/2026-06-16-phase3-randomized-mfi-impl.md` | YUK-361 Phase 3 — 随机化 MFI 选题（档2 LLM-strong）实施计划 |
| `docs/archive/superpowers/plans/2026-06-17-inc2-poolfetch-migrate.md` | `docs/archive/superpowers/plans/2026-06-17-inc2-poolfetch-migrate.md` | inc-2 — queryExistingPool 迁 poolFetch (YUK-398) |
| `docs/archive/superpowers/plans/2026-06-17-kind-step3-answer-class-consolidation.md` | `docs/archive/superpowers/plans/2026-06-17-kind-step3-answer-class-consolidation.md` | kind Step 3（YUK-390 承重墙）— 三套词表 → 单一 answer-class 实�
plans|docs/archive/superpowers/plans/2026-06-17-phase1-matcher-increment1-pool-fetch.md|Phase 1 增量 1 — 统一 pool-fetch 算子 + hybrid 检索证明 |
| `docs/archive/superpowers/plans/2026-06-17-phase1-matcher-increment3-arbiter-core.md` | `docs/archive/superpowers/plans/2026-06-17-phase1-matcher-increment3-arbiter-core.md` | Phase 1 增量 3 — matcher 仲裁器核心 + caller-agnostic verify gate（薄 |
| `docs/archive/superpowers/plans/2026-06-18-phase0-relationship-brain.md` | `docs/archive/superpowers/plans/2026-06-18-phase0-relationship-brain.md` | Phase 0 关系脑 (Relationship Brain) Implementation Plan |
| `docs/archive/superpowers/plans/2026-06-19-p2-typed-failure-plan.md` | `docs/archive/superpowers/plans/2026-06-19-p2-typed-failure-plan.md` | P2「typed 失败层」实现规划 |
| `docs/archive/superpowers/plans/2026-06-20-axis2-wave0-calibration-harness.md` | `docs/archive/superpowers/plans/2026-06-20-axis2-wave0-calibration-harness.md` | axis-2 Wave-0 校准验证 harness 实现计划 (YUK-461) |
| `docs/archive/superpowers/plans/2026-06-26-yuk471-wave3-artifact-structured-design.md` | `docs/archive/superpowers/plans/2026-06-26-yuk471-wave3-artifact-structured-design.md` | YUK-471 Wave 3 — artifact + question_block event-sourcing（合流 YUK-358 笔 |
| `docs/archive/superpowers/plans/2026-06-27-yuk471-w3d-flip-runbook.md` | `docs/archive/superpowers/plans/2026-06-27-yuk471-w3d-flip-runbook.md` | YUK-471 Wave 3 — W3-D SoT flip runbook (owner-run prod op) |
| `docs/archive/superpowers/plans/2026-07-21-yuk-384-durable-hub-sync.md` | `docs/archive/superpowers/plans/2026-07-21-yuk-384-durable-hub-sync.md` | YUK-384 Durable Hub Sync Implementation Plan |
| `docs/archive/superpowers/plans/2026-08-02-architecture-full-phase-0-1.md` | `docs/archive/superpowers/plans/2026-08-02-architecture-full-phase-0-1.md` | Architecture Deepening FULL — Phase 0/1 execution addendum |
| `docs/archive/superpowers/plans/2026-08-08-practice-failure-learning-implementation.md` | `docs/archive/superpowers/plans/2026-08-08-practice-failure-learning-implementation.md` | Practice-owned Failure Learning — Phase 1 implementation plan |
| `docs/archive/superpowers/research/2026-06-17-kind-system-recon-step3.md` | `docs/archive/superpowers/research/2026-06-17-kind-system-recon-step3.md` | kind 两轴正交化 — kind-system 结构勘察（YUK-390/391/392 planning inp |
| `docs/archive/superpowers/research/2026-06-17-phase1-matcher-scoping.md` | `docs/archive/superpowers/research/2026-06-17-phase1-matcher-scoping.md` | Phase 1 matcher / 统一 pool-fetch 算子 — scoping note |
| `docs/archive/superpowers/research/2026-06-19-learner-profile-n1-firmup-research.md` | `docs/archive/superpowers/research/2026-06-19-learner-profile-n1-firmup-research.md` | 学习者档案 n=1 firm-up 方案调研（A1-A15 + 否决清单） |
| `docs/archive/superpowers/research/2026-06-20-axis2-calibration-math-dossier.md` | `docs/archive/superpowers/research/2026-06-20-axis2-calibration-math-dossier.md` | Axis-2 校准机制 数学/文献研究档案（A1–A12, B1） |
| `docs/archive/superpowers/specs/2026-05-08-phase1-improvements-design.md` | `docs/archive/superpowers/specs/2026-05-08-phase1-improvements-design.md` | Phase 1 改进 · 设计 spec |
| `docs/archive/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md` | `docs/archive/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md` | Learning Orchestrator 长期设计 |
| `docs/archive/superpowers/specs/2026-05-09-phase1a-design.md` | `docs/archive/superpowers/specs/2026-05-09-phase1a-design.md` | Phase 1a 设计 — 知识图谱 + 录入闭环 + AI agency 起作用 |
| `docs/archive/superpowers/specs/2026-05-09-phase1a-sub2-design.md` | `docs/archive/superpowers/specs/2026-05-09-phase1a-sub2-design.md` | Phase 1a Sub 2 设计 — 录入闭环 |
| `docs/archive/superpowers/specs/2026-05-09-phase1a-sub3-design.md` | `docs/archive/superpowers/specs/2026-05-09-phase1a-sub3-design.md` | Phase 1a Sub 3 设计 — AttributionTask AI 接通 |
| `docs/archive/superpowers/specs/2026-05-10-phase1a-sub4a-design.md` | `docs/archive/superpowers/specs/2026-05-10-phase1a-sub4a-design.md` | Phase 1a Sub 4A 设计 — Mistake FSRS 复习闭环 + review_event |
| `docs/archive/superpowers/specs/2026-05-10-phase1a-sub4b-design.md` | `docs/archive/superpowers/specs/2026-05-10-phase1a-sub4b-design.md` | Phase 1a Sub 4B 设计 — LearningItem 三态 + CompletionEvidence |
| `docs/archive/superpowers/specs/2026-05-10-phase1a-sub4c-design.md` | `docs/archive/superpowers/specs/2026-05-10-phase1a-sub4c-design.md` | Phase 1a Sub 4C 设计 — Capture 流重整 + Tencent OCR Tier-1 + 退役 /reco |
| `docs/archive/superpowers/specs/2026-05-10-phase1a-sub5-design.md` | `docs/archive/superpowers/specs/2026-05-10-phase1a-sub5-design.md` | Phase 1a Sub 5 设计 — 数据导出 / 还原 (D1 + R2 backup via ZIP) |
| `docs/archive/superpowers/specs/2026-05-11-architecture-review.md` | `docs/archive/superpowers/specs/2026-05-11-architecture-review.md` | Architecture Review — 2026-05-11 |
| `docs/archive/superpowers/specs/2026-05-11-sub0a-stack-migration-infra-design.md` | `docs/archive/superpowers/specs/2026-05-11-sub0a-stack-migration-infra-design.md` | Sub 0a — Stack Migration Infrastructure (Vercel + Next.js + Neon) |
| `docs/archive/superpowers/specs/2026-05-11-sub0b1-api-route-migration-design.md` | `docs/archive/superpowers/specs/2026-05-11-sub0b1-api-route-migration-design.md` | Sub 0b1 · API Route Migration — Workers Hono → Next.js · Design |
| `docs/archive/superpowers/specs/2026-05-11-sub0c-async-and-ocr-upgrade-design.md` | `docs/archive/superpowers/specs/2026-05-11-sub0c-async-and-ocr-upgrade-design.md` | Sub 0c · Async lane (pg-boss) + OCR Upgrade — Design |
| `docs/archive/superpowers/specs/2026-05-11-sub0c-handoffs.md` | `docs/archive/superpowers/specs/2026-05-11-sub0c-handoffs.md` | Sub 0c · Handoffs & Roadmap |
| `docs/archive/superpowers/specs/2026-05-14-phase1c-design.md` | `docs/archive/superpowers/specs/2026-05-14-phase1c-design.md` | Phase 1c Design Spec — Encounter / Session 抽象 + UI 闭环 |
| `docs/archive/superpowers/specs/2026-05-15-phase1c-loom-design-addendum.md` | `docs/archive/superpowers/specs/2026-05-15-phase1c-loom-design-addendum.md` | Phase 1c Spec Addendum — Loom Design System 对齐 |
| `docs/archive/superpowers/specs/2026-05-17-agent-context-tools-design.md` | `docs/archive/superpowers/specs/2026-05-17-agent-context-tools-design.md` | Agent Context Tools Design |
| `docs/archive/superpowers/specs/2026-05-21-math-mvp-vision-design.md` | `docs/archive/superpowers/specs/2026-05-21-math-mvp-vision-design.md` | Math MVP (Vision-as-Input) Design |
| `docs/archive/superpowers/specs/2026-05-22-foundation-true-closeout-design.md` | `docs/archive/superpowers/specs/2026-05-22-foundation-true-closeout-design.md` | Foundation 真 Closeout (Physics + Partial→FSRS) Design |
| `docs/archive/superpowers/specs/2026-05-25-foundation-b-m1-closeout.md` | `docs/archive/superpowers/specs/2026-05-25-foundation-b-m1-closeout.md` | Foundation B M1 真 Closeout — Reconciliation Phase |
| `docs/archive/superpowers/specs/2026-05-29-north-star-learning-intent-design.md` | `docs/archive/superpowers/specs/2026-05-29-north-star-learning-intent-design.md` | 学习意图 / 北极星（North-Star Learning Intent）— Design Spec |
| `docs/archive/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md` | `docs/archive/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md` | T-OC — OCR/录入 pipeline 重建 Design Spec |
| `docs/archive/superpowers/specs/2026-05-30-p5-open-questions-readiness-brief.md` | `docs/archive/superpowers/specs/2026-05-30-p5-open-questions-readiness-brief.md` | Roadmap P5 — Design-Readiness Brief |
| `docs/archive/superpowers/specs/2026-05-31-p5.1-context-budget-design.md` | `docs/archive/superpowers/specs/2026-05-31-p5.1-context-budget-design.md` | Context Budget Policy (P5.1) — Design Spec |
| `docs/archive/superpowers/specs/2026-05-31-p5.2-brief-refresh-design.md` | `docs/archive/superpowers/specs/2026-05-31-p5.2-brief-refresh-design.md` | Subject-scoped vs Global Brief Refresh (P5.2) — Design Spec |
| `docs/archive/superpowers/specs/2026-05-31-p5.3-long-term-brief-stale-design.md` | `docs/archive/superpowers/specs/2026-05-31-p5.3-long-term-brief-stale-design.md` | P5.3 — Long-term brief paragraph stale rules (design spec) |
| `docs/archive/superpowers/specs/2026-05-31-p5.4-l2-adaptive-bias-design.md` | `docs/archive/superpowers/specs/2026-05-31-p5.4-l2-adaptive-bias-design.md` | Adaptive Accept-Learned Proposal-Quality Bias — Layer 2 (P5.4-L2) — Design S |
| `docs/archive/superpowers/specs/2026-05-31-p5.4-rubric-enforcement-design.md` | `docs/archive/superpowers/specs/2026-05-31-p5.4-rubric-enforcement-design.md` | Proposal Quality Rubric Enforcement — Layer 1 (P5.4) — Design Spec |
| `docs/archive/superpowers/specs/2026-05-31-p5.5-tool-eval-fixtures-design.md` | `docs/archive/superpowers/specs/2026-05-31-p5.5-tool-eval-fixtures-design.md` | Tool-Eval Fixtures — Phase 1 (4 core scenarios, wenyan) — Design Spec |
| `docs/archive/superpowers/specs/2026-05-31-p5.6-copilot-suggestion-semantics-design.md` | `docs/archive/superpowers/specs/2026-05-31-p5.6-copilot-suggestion-semantics-design.md` | Copilot Suggestion Semantics — proactive vs corrective vs accept_suggestion (P |
| `docs/archive/superpowers/specs/2026-05-31-p5.8-wenyan-eval-fixtures-design.md` | `docs/archive/superpowers/specs/2026-05-31-p5.8-wenyan-eval-fixtures-design.md` | Subject Eval Fixtures — Wenyan only (Option A, Phase 1 of P5.8) — Design Spe |
| `docs/archive/superpowers/specs/2026-06-01-question-edit-domaintools-design.md` | `docs/archive/superpowers/specs/2026-06-01-question-edit-domaintools-design.md` | Agent-callable question structure-edit DomainTools — design note |
| `docs/archive/superpowers/specs/2026-06-01-solve-tutor-design.md` | `docs/archive/superpowers/specs/2026-06-01-solve-tutor-design.md` | DESIGN SPEC — 解题陪练 (Solve-Tutor) |
| `docs/archive/superpowers/specs/2026-06-01-station1-synthetic-seed-design.md` | `docs/archive/superpowers/specs/2026-06-01-station1-synthetic-seed-design.md` | Station 1 — Synthetic Seed (scripts/seed-synthetic.ts) |
| `docs/archive/superpowers/specs/2026-06-01-station2a-brief-writer-design.md` | `docs/archive/superpowers/specs/2026-06-01-station2a-brief-writer-design.md` | Station 2A — Brief-writer wiring (T-37) — Design Spec |
| `docs/archive/superpowers/specs/2026-06-01-station2b-goal-trigger-design.md` | `docs/archive/superpowers/specs/2026-06-01-station2b-goal-trigger-design.md` | Station 2B — Goal-Scope Trigger (Nightly Cron) — Design Spec |
| `docs/archive/superpowers/specs/2026-06-01-station3-e2e-validation-plan.md` | `docs/archive/superpowers/specs/2026-06-01-station3-e2e-validation-plan.md` | Station 3 (YUK-188) — Layer-8 flywheel end-to-end validation PLAN |
| `docs/archive/superpowers/specs/2026-06-01-toc-a2-enroll-loop-design.md` | `docs/archive/superpowers/specs/2026-06-01-toc-a2-enroll-loop-design.md` | T-OC A2/A3 — close the ingestion enroll loop (YUK-164) |
| `docs/archive/superpowers/specs/2026-06-02-blockassembly-pathb-design.md` | `docs/archive/superpowers/specs/2026-06-02-blockassembly-pathb-design.md` | BlockAssembly path-B — AI block-merge proposals (design note) |
| `docs/archive/superpowers/specs/2026-06-02-multimodal-direct-judge-design.md` | `docs/archive/superpowers/specs/2026-06-02-multimodal-direct-judge-design.md` | multimodal_direct judge — design note |
| `docs/archive/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md` | `docs/archive/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md` | Search-grounded QuizGen (T-SQ) — backend wave design |
| `docs/archive/superpowers/specs/2026-06-03-coach-led-review-engine-design.md` | `docs/archive/superpowers/specs/2026-06-03-coach-led-review-engine-design.md` | Coach-led Review Engine — dynamic paper, question profiles, knowledge scheduli |
| `docs/archive/superpowers/specs/2026-06-03-editable-profile-studio-design.md` | `docs/archive/superpowers/specs/2026-06-03-editable-profile-studio-design.md` | Editable Profile Studio — agent-managed subject policy design |
| `docs/archive/superpowers/specs/2026-06-04-agent-framework-design.md` | `docs/archive/superpowers/specs/2026-06-04-agent-framework-design.md` | Agent Framework Design - global Copilot, skills, and background agents |
| `docs/archive/superpowers/specs/2026-06-05-question-source-expansion-design.md` | `docs/archive/superpowers/specs/2026-06-05-question-source-expansion-design.md` | 题源扩展设计 — 可信外部题源接入 + 出题规范指导（YUK-216 / |
| `docs/archive/superpowers/specs/2026-06-10-architecture-redesign-design.md` | `docs/archive/superpowers/specs/2026-06-10-architecture-redesign-design.md` | 架构重设计 Design Spec — 功能逻辑先行 |
| `docs/archive/superpowers/specs/2026-06-10-flow-ui-design-handoff.md` | `docs/archive/superpowers/specs/2026-06-10-flow-ui-design-handoff.md` | 练习面（流 + 卷架）功能 Handoff — 给 claude design |
| `docs/archive/superpowers/specs/2026-06-10-functional-goal-map.md` | `docs/archive/superpowers/specs/2026-06-10-functional-goal-map.md` | 功能目标地图 + 可维护性证据（架构重设计调研产物） |
| `docs/archive/superpowers/specs/2026-06-10-p2-practice-journey-spec.md` | `docs/archive/superpowers/specs/2026-06-10-p2-practice-journey-spec.md` | P2 练习旅程 Spec — 流编排器 + 卷架 + practice 包 |
| `docs/archive/superpowers/specs/2026-06-16-acquisition-rethink-retrieval-substrate-design.md` | `docs/archive/superpowers/specs/2026-06-16-acquisition-rethink-retrieval-substrate-design.md` | 采集重想 + 检索底座设计 |
| `docs/archive/superpowers/specs/2026-06-17-matcher-form-spec.md` | `docs/archive/superpowers/specs/2026-06-17-matcher-form-spec.md` | Matcher 形态 spec — harvest-then-match 的承重墙 |
| `docs/archive/superpowers/specs/2026-06-18-inc4-owner-manual-gate-design.md` | `docs/archive/superpowers/specs/2026-06-18-inc4-owner-manual-gate-design.md` | inc-4 — owner manual gate path（draft 池审核面）设计 |
| `docs/archive/superpowers/specs/2026-06-18-jiaoyantuan-deliberative-panel-design.md` | `docs/archive/superpowers/specs/2026-06-18-jiaoyantuan-deliberative-panel-design.md` | 教研团 · 多 agent 审议 panel + 更强规划 · 设计定稿 |
| `docs/archive/superpowers/specs/2026-06-18-jiaoyantuan-integration-and-build-start.md` | `docs/archive/superpowers/specs/2026-06-18-jiaoyantuan-integration-and-build-start.md` | 教研团 · 教学法脑定稿 + 三脑合一 + SDK 原生实现 + 实施起点 |
| `docs/archive/superpowers/specs/2026-06-18-private-teaching-research-team-vision.md` | `docs/archive/superpowers/specs/2026-06-18-private-teaching-research-team-vision.md` | 私人教研团 · 产品愿景（"feel" 文档） |
| `docs/archive/superpowers/specs/2026-06-18-rethink-abandoned-directions-archive.md` | `docs/archive/superpowers/specs/2026-06-18-rethink-abandoned-directions-archive.md` | Rethink 抛弃方向 · 归档（坟场 + 复活说明） |
| `docs/archive/superpowers/status.md` | `docs/archive/superpowers/status.md` | Project Status — 滚动总览 |
