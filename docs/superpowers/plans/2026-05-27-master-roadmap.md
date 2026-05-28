# Master Roadmap & Autonomous Execution Driver

> **Single source of truth** for all remaining work across the project.
> 同时是"最大化 autonomy"执行的 driver doc。
> **Companion**：YUK-88 autonomous driver (`docs/superpowers/plans/2026-05-26-yuk88-autonomous-driver.md`) 仍是 YUK-88 track 的执行手册；本文档负责跨 track + 跨优先级的 coordination。
> 共用规则（skills / MCP / 行为标准 / hard NO）：见 YUK-88 driver §4-§6 + §11，本文档不重复，仅给 cross-track delta。

**Doc 日期**：2026-05-27
**Owner**：yukoval（single user, NAS self-host）
**State**：v1 draft，未经优先级 grill；建议读完后跑 `/grill-with-docs` 拍板 §5 推荐顺序

---

# Part 1 — Roadmap (the WHAT)

## §0 Mission + 完成定义 + 当前快照

### 0.1 一句话目标

把 "AI 不是聊天助手，是与用户对等的 first-class actor" 这个 v0.3/v0.4 承诺**全量兑现**：8 层架构 1-7 已基本 ship，**第 8 层（Global Copilot Orchestrator）整层未启动**；同时清掉 P1 学科 / P2 闭环 / P3 Track F / P4 文档债。

### 0.2 完成定义（整体项目 closeout）

| 维度 | 标准 |
|---|---|
| Layer 1-4 | 已 ship（仅余 P1.1 八个 judges / P1.2 question_part / P1.4 wenyan 100% / P1.6 3a-3b 残余） |
| Layer 5 (Artifact 多态) | YUK-88 P0-P7 全 ship + ADR-0020/0021 accepted |
| Layer 6 (AI Decision Inbox) | P2.1 acceptance ranking + P2.2 PR-level revert + Dreaming lane 实接 inbox |
| Layer 7 (Memory Layer) | ADR-0017 Phase B (YUK-37) ship + Dreaming brief refresh live |
| Layer 8 (Global Copilot Orchestrator) | 21 DomainTool 建齐 + Drawer 跨 6 routes 常驻 + Phase 3 Global Coach cron live + `experimental:tool_use` promote 到 KnownEvent |
| Track F (Source/Grounding/Multimodal) | P3.1-3.7 任选 ≥ 4 项 ship（不全做）|
| Doc / Infra 债 | P4.1-4.13 sweep；status.md / ADR / modules 一致 |
| Audit | `/audit-drift` 全绿 |

### 0.3 当前快照（2026-05-28 post-Wave 4 implementation / final gate pending）

**Shipped (从 status.md §1 + 2026-05-{20..27} commit log)**：
- Foundation A/B/C 全完，含 math + physics acid test ✓ framework diff = 0
- **Foundation D M1 ship**（2026-05-26）：DomainTool registry + 3 read tools + bridge + `experimental:tool_use` mirror
- Product Track 1 wave 1-4 ship + W5 closeout audit
- Track 1 follow-up M1: wenyan causeCategories (YUK-83) / today KPI (YUK-84) / Note 申诉 (YUK-85)
- pg-boss 12 队列在跑（含 maintenance / variant / OCR / session-summary）
- **Wave 1 ship ✅（2026-05-27）**：
  - T-37 brief writer Phase B (YUK-37) — `src/server/memory/{client,brief,scope_tagger,triggers}.ts` ship；F-04 memory side resolved
  - T-RA RatingAdvisor (YUK-98) — `rating-advisor.ts` 纯函数 + UI + submit route advisory field
  - T-66 ask_check artifact (YUK-66) — `question(source='teaching_check')` 持久化 + judge invoker 接入
  - T-88 P0 spike (YUK-90) — TipTap block tree fixture + split/merge/mark_wrong invariant 全过（PR #162）
  - Wave 1 closeout (YUK-99 brief writer event ingest wire + env doc / YUK-100 RatingAdvisor cause SoT)：PR #163 + #165 (squash) merged
- **F-04 audit baseline split**：`src/server/memory/` 目录已 ship；Dreaming runtime now lives in `src/server/boss/handlers/dreaming_nightly.ts` with DomainTool/MCP bridge rather than a separate table.
- **Wave 2 ship ✅（2026-05-27）**：
  - T-88 P1 schema + ADR-0020 block-tree contract (YUK-91)
  - T-88 P2-basic TipTap block-tree editor + ADR-0022 (YUK-92)
  - T-D2 DomainTool M2 read tools full coverage (YUK-102)
  - PR #169 merged to `main` at `709152e6`
- **YUK-101 outbox follow-up ✅**：transactional outbox landed through PR #168 / commit `72d77555`; no longer blocks Wave 3 prep

**In-flight / open**：
- **Wave 3 shipped**：T-D4 propose/write tools full through PR #170 (YUK-107 parent + YUK-108..112 lanes)；8 个 DomainTool proposal/action surface + allowlist policy + proposal schema/UI coverage landed
- **Wave 4 implementation complete（branch）**：
  - YUK-93 / T-88 P3 AI pipeline rewrite — `body_blocks` canonical note output, NoteGenerate type switch, NoteVerify structural verifier, LearningIntent 0-M long artifacts, embedded `tool_quiz` refs
  - YUK-114 / T-DR Dreaming lane — `DreamingTask`, `dreaming_nightly` pg-boss producer, DomainTool MCP bridge, dreaming allowlist, proposal inbox delta evidence
  - Final full gate / PR / Linear closeout still pending

**Audit baseline ack（per `docs/audit/2026-05-27-pre-yuk88-baseline-drift.md`, 2026-05-27）**：
- **F-01** notes.md 整篇 ADR-0020 冲突 → YUK-88 P3 implementation branch 已改 AI pipeline；module doc rewrite remains final audit item before closeout if still stale
- **F-02 / F-03** artifact 表 / `CorrectArtifactEvent.payload.section_id` pre-ADR-0020 形态 → resolved by Wave 2 YUK-91/YUK-92 body-block migration
- **F-04a** ✅ resolved by T-37 (`src/server/memory/` ship)；**F-04b** ✅ functionally resolved by T-DR runtime (`dreaming_nightly` handler; no separate Dreaming table)

**Critical 缺位（按 v0.4 §6）**：
- Layer 8 仍未全兑现；DomainTool M2/M4 + Dreaming 已落地，Drawer / Global Coach / tool_use promote 仍待
- 8 个 judges + question_part + 3a-3b LearningIntent + Subject #4
- Track 2 ranking / retraction / scheduling
- Track F Source / Grounding / Multimodal
- 13 项 P4 doc/infra 债

---

## §1 Authority sources（cross-track 必读）

按优先级。

| Pri | File / Command | Role |
|---|---|---|
| 1 | `omc ultragoal status`（每条 track 一个 ledger 或 共用 master，见 §6.3） | Roadmap state |
| 2 | `docs/planning/v0.4-complete-form-roadmap.md` | 完全体合成 SoT（§3 八层 + §6 P0-P5 priority + §10 漂移清单 + §11 风险） |
| 3 | `docs/superpowers/status.md` | Shipped baseline + 当前 phase（事实）|
| 4 | `docs/adr/0001..0022`（含 ADR-0021 outbox + ADR-0022 PM schema） | 决议层 |
| 5 | `CONTEXT.md` | 跨 agent 术语表（含 ADR-0020 新术语：block_id / body_blocks / knowledge_ids label） |
| 6 | `docs/planning/2026-05-26-note-rich-doc.md` §0 | YUK-88 post-grill 决策矩阵 |
| 7 | `docs/superpowers/plans/2026-05-26-yuk88-*.md` (3 份) | YUK-88 track 完整 plan + driver |
| 8 | `docs/superpowers/plans/2026-05-26-track-1-followup-phase.md` | Track 1 follow-up 残余（W2.1 / W2.2） |
| 9 | `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md` | 21 DomainTool 完整 spec（1241 行）|
| 10 | `docs/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md` §Phase 3 | Global Coach 形态 |
| 11 | `docs/design/2026-05-15-design-brief-v2.1.md` §1.6 + `docs/design/loom-design-v2.1/` | Copilot Drawer + Tweaks + 新 UI primitives |
| 12 | `CLAUDE.md` + `.claude/CLAUDE.md` | 项目级行为规则 |
| 13 | Linear（YUK-88 + sub-issues + YUK-37 等已建 issue） | Issue acceptance 权威 |

### 1.1 Session start ritual（master coordinator session）

```bash
# 1. Master state
ls .omc/ultragoal/  # 看有几个 ledger 在跑

# 2. 每个 active track 的 ultragoal status
for d in .omc/ultragoal/*/; do
  echo "=== $d ==="
  omc ultragoal --workdir "$d" status 2>/dev/null || omc ultragoal status
done

# 3. Git state
git status -uno && git log --oneline -10 && git worktree list

# 4. Linear scan
# mcp__claude_ai_Linear__list_issues --parentId YUK-88 + 其他 active project

# 5. Latest audit-drift（必看，>= 1 月没跑就立即跑一次）
ls -lt docs/audit/*drift* 2>/dev/null | head -3
```

任一异常 → 报告 + 停。

---

## §2 完整 Track 清单（status quo 全表）

### 2.0 图例

- ✅ Ship 在 main
- 🟡 In progress（branch / draft）
- ⬜ 未启动
- 🔄 被其他 track 吸收（避免重复）
- ⏳ deferred / 等触发条件

每条 track 列：**名 / status / pts 估 / forward-locks（这条 block 谁）/ blocked-by（谁 block 这条）/ Linear**

### 2.1 ✅ Shipped baseline（事实保留，不展开）

详见 `docs/superpowers/status.md` §1 全表 + v0.4 §5.1。本文档不复制；以"shipped"作为下面 ⬜ track 的前置假设。

### 2.2 🟡 In-Flight

| Track | Status | pts 剩 | forward-locks | blocked-by | Linear |
|---|---|---|---|---|---|
| **YUK-101** Transactional outbox for `writeEvent` → memory event ingest | ✅ shipped | — | Memory ingest transactional integrity | Wave 1 closeout surfaced orphan-job risk | [YUK-101](https://linear.app/yukoval-studios/issue/YUK-101) |
| **T-88** Block-Tree Note Rebuild (YUK-88) | 🟡 planning done | 61 | Layer 5 完全体 + Living Note v0 | (none) | [YUK-88](https://linear.app/yukoval-studios/issue/YUK-88) + YUK-90~97 |

### 2.3 ⬜ P0 — Critical (阻塞 first-class AI actor 承诺)

| Track | Status | pts | forward-locks | blocked-by | Linear |
|---|---|---|---|---|---|
| **T-D2** DomainTool Registry M2 (10 read tools 补完) | ✅ shipped | — | Drawer / Dreaming / Coach 三条全 | M1 ship ✓ | [YUK-102](https://linear.app/yukoval-studios/issue/YUK-102) + YUK-103~106 |
| **T-D3** Copilot Drawer MVP (1 route 试点) | ⬜ | ~13 | Drawer 全 6 routes 铺开 | T-D2 ✅ | ⬜ 待建 |
| **T-D4** DomainTool Propose/Write Tools (8 个) | ✅ shipped | ~24 | Dreaming + Coach proposal 写入 | T-D2 done ✓ | [YUK-107](https://linear.app/yukoval-studios/issue/YUK-107) + YUK-108~112 |
| **T-D5** Drawer 跨 6 routes 常驻 | ⬜ | ~13 | Layer 8 用户级兑现 | T-D3 试点验证 | ⬜ 待建 |
| **T-D6** Phase 3 Global Coach Orchestrator | ⬜ | ~15 | Layer 8 自动产出"今日安排" | T-D2 ✅ + T-DR ✅ | ⬜ 待建 |
| **T-D7** `experimental:tool_use` promote to KnownEvent | ⬜ | ~3 | ADR-0011 后续修订 | 3 tool stable + 2 周 | ⬜ 待建 |
| **T-DR** Dreaming Lane | ✅ implementation complete | ~20 | Layer 7 brief refresh + T-D6 Coach | T-37 done + T-D2 done | [YUK-114](https://linear.app/yukoval-studios/issue/YUK-114) |

**P0 小计**：original ~113 pts；remaining critical path now centers on Drawer / Coach / promote after T-D2, T-D4, and T-DR landed.

### 2.4 ⬜ P1 — 学科能力补完

| Track | Status | pts | forward-locks | blocked-by | Linear |
|---|---|---|---|---|---|
| **T-J1** rubric judge | ⬜ | ~8 | essay / 论述题型 | (none，registry ✓) | ⬜ |
| **T-J2** multimodal_direct judge | ⬜ | ~8 | 手写 / 图表 题型 | (none) | ⬜ |
| **T-J3** ai_flexible judge | ⬜ | ~5 | borderline / appeal 强制 flex | (none) | ⬜ |
| **T-J4** external_judge | ⬜ | ~13 | OJ / 外部认证；含 evidence provenance / trust level / privacy | (none) | ⬜ |
| **T-J5** code_execution judge | ⬜ | ~13 | programming exercise | (none) | ⬜ |
| **T-J6** speech_audio judge | ⬜ | ~13 | 语言口语 | (none) | ⬜ |
| **T-J7** diagram_handwriting judge | ⬜ | ~8 | 几何 / 科学图表 | (none) | ⬜ |
| **T-J8** human_review judge | ⬜ | ~5 | safety-critical / 高 uncertainty | (none) | ⬜ |
| **T-J9** symbolic judge（可选 Python sidecar SymPy） | ⏳ | ~13 | math symbolic 等价 | ADR-0001 revise（引入 sidecar）| ⬜ |
| **T-QP** `question_part` ActivityKind | ⬜ | ~8 | 英语阅读 / 物理多步独立调度 + cross-subject scheduling | (none) | ⬜ |
| **T-S4** Subject #4 acid test | ⬜ | ~8 | 第 4 学科 onboard 流程定型 | (none) | ⬜ |
| **T-LI** 3a/3b LearningIntent proposal flow | ⬜ | ~13 | "我想学 X" 路径完全体（主题不存在 / 不完整） | (none) | ⬜ |
| **T-RA** Partial credit P3 RatingAdvisor | ✅ ship 2026-05-27 | (done) | review feedback advisory shipped | — | [YUK-98](https://linear.app/yukoval-studios/issue/YUK-98) |
| **T-66** YUK-66 Teaching ask_check artifact | ✅ ship 2026-05-27 | (done) | teaching loop ask_check persistence shipped | — | [YUK-66](https://linear.app/yukoval-studios/issue/YUK-66) |
| **T-W4** wenyan profile.causeCategories 100% | ✅ | (done) | — | — | [YUK-83](https://linear.app/yukoval-studios/issue/YUK-83) |

**P1 小计**：~115 pts，~28-37 周（单人 raw；含 T-J9 13pt 如果做；T-RA/T-66 已从剩余量移除）

### 2.5 ⬜ P2 — 闭环深化

| Track | Status | pts | forward-locks | blocked-by | Linear |
|---|---|---|---|---|---|
| **T-AR** Acceptance-rate / dismiss-reason 信号 | ⬜ | ~5 | Maintenance ranking + Dreaming priorityization | (none) | ⬜ |
| **T-RT** Bad accepted proposal PR-level revert event | ⬜ | ~8 | proposal full lifecycle | (none) | ⬜ |
| **T-LN** Living Note 5 触发器 + NoteRefineTask | 🔄 | (T-88 P4) | — | T-88 P4 | (T-88 sub) |
| **T-MW** Note appeal / mark-wrong UX | ✅ | (done) | — | — | YUK-85 PR #151/#153/#154 |
| **T-CS** Cross-subject scheduling v1 (deterministic quotas) | ⬜ | ~13 | 多学科混排; P1.1 / P1.2 done 才有意义 | T-QP + ≥ 5 judges | ⬜ |
| **T-MR** Maintenance ranking 深化 | ⬜ | ~5 | T-AR signal | T-AR | ⬜ |
| **T-TE** TipTap 编辑器 + 自定义 block (Layer 5 P2.7) | 🔄 | (T-88 P2) | — | T-88 P2 | (T-88 sub) |
| **T-TQ** standalone `tool_quiz` artifact + UI | ⬜ | ~8 | quiz 独立路径（模拟卷 / 每日 quiz / final quiz） | T-88 P3 ✅（EmbeddedCheck 已拆成 `tool_quiz` ref；UI 仍待） | ⬜ |
| **T-KG** Knowledge graph force-directed view | ⬜ | ~13 | v2.1 brief §2.3.b "必须" | (none，D3/cytoscape 待选) | ⬜ |
| **T-IK** /inbox actionable Today KPI 第三格 | ✅ | (done) | — | — | YUK-84 PR #150 |

**P2 小计**：~52 pts，~12-18 周（含 T-CS 13pt 如果做）

### 2.6 ⬜ P3 — Track F (Source / Grounding / Multimodal)

| Track | Status | pts | forward-locks | blocked-by | Linear |
|---|---|---|---|---|---|
| **T-SP** SourcePack + SourceResult | ⬜ | ~8 | grounded quiz / note 来源标签 | (none) | ⬜ |
| **T-SQ** Search-grounded QuizGen + QuizVerify + QuizPlan | ⬜ | ~13 | Quiz agent 不再"上网找题" | T-SP | ⬜ |
| **T-PS** Passage + referenced_span_ids | ⬜ | ~8 | 长阅读题 schema + 桌面/移动 UI | (none) | ⬜ |
| **T-BA** BlockAssemblyTask AI auto-merge | ⬜ | ~5 | 相邻 block AI merge proposal | T-88 P3 ✅（artifact schema 改）| ⬜ |
| **T-SG** Source grounding + textbook RAG | ⬜ | ~13 | source_tier write path + user_verified flip；与 ADR-0020 解耦 | (none) | ⬜ |
| **T-MM** Multimodal first-class (audio / handwriting / 图表 / 表格) | ⬜ | ~20 | first-class material | T-J2 + T-J7（vision/diagram judge）| ⬜ |
| **T-OC** OCR capture pipeline rebuild (Sub 0c handoffs §3) | ⬜ | ~15 | StructureTask / TaggingTask / WorkflowJudge / MistakeEnrollTask / 6 个 agent tools | T-D4 (propose tools) | ⬜ |

**P3 小计**：~82 pts，~20-26 周

### 2.7 ⬜ P4 — 文档与基础设施债

详见 v0.4 §6 P4.1-P4.13。13 项小工作，pts 大多 1-3。

| Track 群 | pts 估 |
|---|---|
| T-PD1 architecture.md Task 表 + audit gate | 2 |
| T-PD2 `ai_task_runs` 决策 + `event.task_run_id` FK | 3 |
| T-PD3 2026-05-18 5 条 doc drift 复检 | 3 |
| T-PD4 `maxCost / fallbackChain` 实装 or 标 inactive | 2 |
| T-PD5 `db/client.ts` Vercel/Neon/SQLite/D1 sweep | 1 |
| T-PD6 `knowledge.approval_status` enum 缩减 | 1 |
| T-PD7 ADR-0002 `extracted_prompt_md` 过渡注释 + revision | 2 |
| T-PD8 Modules doc 主体 vs schema 漂移大 sweep | 8 |
| T-PD9 旧 PLANNING.md Phase 2 承诺补 v0.3 入账 | 2 |
| T-PD10 5-25 几份小 plan checkbox 跟 status.md 对账 | 1 |
| T-PD11 ADR-0014 status proposed → accepted | 1 |
| T-PD12 ADR metadata drift sweep (0012/0016/0004) | 2 |
| T-PD13 Spec ledger Status 字段 + superseded banner | 3 |

**P4 小计**：~31 pts，~6-8 周

### 2.8 ⬜ P5 — Brainstorm → Spec

| Track | pts | 来源 |
|---|---|---|
| T-CB Context Budget Policy spec | 2 | brainstorm 2026-05-17 |
| T-SB Subject-scoped vs global brief 并行刷新 | 2 | brief brainstorm |
| T-LS Long-term brief 段落 stale 规则 | 2 | brief brainstorm |
| T-PQ Proposal Quality Rubric enforce 化 | 3 | modules/knowledge.md §4 |
| T-TF Tool Eval Fixtures (10 个) | 5 | spec 已列 |
| T-CL Copilot suggestion 语义 (proactive/corrective/accept) | 2 | ADR-0011 后续 |
| T-EP `experimental:tool_use` promote 准则 | 1 | (= T-D7) |
| T-FF 5 个完整 fixture (wenyan/math/Eng/prog/reading) | 8 | math ✓；其它 0 |

**P5 小计**：~25 pts，~5-7 周（多数小，部分依赖 P0 done）

### 2.9 总计

| Bucket | pts | 周（单人 raw） |
|---|---|---|
| 🟡 In-Flight | ~61 + YUK-101 TBD | 15-20 + follow-up |
| ⬜ P0 Critical | ~113 | 28-35 |
| ⬜ P1 学科 | ~115 | 28-37 |
| ⬜ P2 闭环 | ~52 | 12-18 |
| ⬜ P3 Track F | ~82 | 20-26 |
| ⬜ P4 doc/infra 债 | ~31 | 6-8 |
| ⬜ P5 brainstorm→spec | ~25 | 5-7 |
| **Grand Total** | **~479 pts + YUK-101 TBD** | **~116-151 周 ≈ 2.4-3 年（单人 raw）** |

**这是 brutal truth**。即使 AI-paired 把 raw velocity 翻 1.5-2x，也是 **1.5-2 年**整 closeout。所以**全 ship 不现实**，必须 prioritization + 接受不完整 closeout。

---

## §3 Cross-Track Dependency Graph

### 3.1 完整依赖图（关键 forward-lock 链）

```
                                  ┌──────────────────────────────────────┐
                                  │  Layer 8 — Global Copilot Orchestrator│
                                  │  (CRITICAL：first-class AI actor 兑现处)│
                                  └──────────────┬───────────────────────┘
                                                 │ 全部 forward-locked by:
                          ┌──────────────────────┼─────────────────────────────┐
                          ↓                      ↓                             ↓
                       T-D6 Coach            T-D5 Drawer×6                 T-D7 promote
                          │                      │                             ↑ 3 tools 2 周 stable
                          ↓                      ↑                             │
            ┌──────────┴──────────┐         T-D3 Drawer MVP                    │
            ↓                     ↓              ↑                             │
        T-DR Dreaming         T-D2 read tools ───┴──────T-D4 propose tools ────┘
            │                     ↑                          │
            ↓                     │                          ↓
        T-37 brief writer     M1 ✓ (3 tools)             T-OC OCR rebuild

                          ─── 上面这段是 P0 critical path ───

T-88 (YUK-88, Layer 5) ─── 独立，几乎无 forward-lock ─── 8 phase 内部已规划
  └── P3 schema change forward-locks T-TQ standalone tool_quiz
  └── P3 schema change forward-locks T-BA AI auto-merge
  └── P4 absorbs T-LN Living Note 5 triggers

P1 学科：
T-J1..T-J8 judges ────→ T-CS cross-subject scheduling
T-QP question_part ────→ T-CS
T-S4 Subject #4 ────→ (验证 capability registry 真泛化)
T-LI 3a/3b LearningIntent ────→ "我想学 X" 完全体
T-RA RatingAdvisor (3pt) ────→ review feedback advisory (independent)
T-66 ask_check (5pt) ────→ teaching loop closeout (independent)

P2 闭环：
T-AR ranking signal ────→ T-MR Maintenance ranking
T-RT PR-level revert ────→ proposal full lifecycle (independent)
T-KG graph view ────→ v2.1 brief §2.3.b 必须 (independent)

P3 Track F：
T-SP SourcePack ────→ T-SQ search-grounded quiz
T-MM Multimodal ────→ blocks T-J2/T-J7 但 sub-J 各自可独立做
T-OC OCR ────→ requires T-D4 propose tools (DomainTool 集成)
T-SG grounding ────→ 与 ADR-0020 解耦，independent

P4 doc/infra：
独立，可任何时候插入；建议 P0 / P1 / P2 wave 间隙

P5 brainstorm→spec：
T-CB / T-PQ / T-CL ────→ blocks Copilot detail features
T-FF fixtures ────→ blocks Eval / acceptance test 自动化
```

### 3.2 三条 forward-lock 长链（这些决定整体进度）

```
长链 1 (Layer 8 关键路径)：
  T-D2 (10 read tools) → T-D3 (Drawer MVP) → T-D5 (Drawer×6)
                       → T-DR (Dreaming) → T-D6 (Coach)
                                           ↓
                                     完成 Layer 8 兑现

  关键瓶颈：T-D2 + T-DR 已落地；现在剩 T-D3 / T-D5 / T-D6 / T-D7
  无法跳过；必须按序

长链 2 (学科能力 → scheduling)：
  T-J1..T-J5 (5 个核心 judge) → T-CS (cross-subject scheduling)
                                ↑
  T-QP (question_part) ────────┘

  关键瓶颈：要做 T-CS 必须至少 5 个 judge + question_part；否则它是空架子
  ~50pt 必经

长链 3 (memory + dreaming)：
  T-37 (brief writer Phase B) → T-DR (Dreaming agent 周期性 refresh) → T-D6 Coach
                                ↓
                              brief 真在用，T-D2 read tools 含 query_memory_brief

  关键瓶颈：T-37 + T-D2 + T-DR 已落地；现在瓶颈移到 T-D6 Coach 消费 brief/Dreaming 输出
```

### 3.3 高度并行可能性（file-disjoint）

可以同时跑两条 worktree 的组合：

| A | B | 文件不冲突理由 |
|---|---|---|
| **T-88** YUK-88 | **T-D2** read tools | T-88 改 `src/server/{events,artifacts,notes}/` + TipTap UI；T-D2 改 `src/server/ai/tools/` |
| **T-88** YUK-88 | **T-37** brief writer | T-88 改 artifact / event；T-37 改 `src/server/memory/brief.ts` |
| **T-88** YUK-88 | **T-DR** Dreaming | T-DR 是新 pg-boss handler + brief writer 消费者 |
| **T-D2** read tools | **T-37** brief writer | 文件分离；但 T-D2 含 query_memory_brief，最好等 T-37 先 |
| **T-J1..J8** | **T-88 / T-D2 / etc** | judges 在 `src/core/capability/judges/` 独立 |
| **T-PD\*** doc sweep | (任何主线) | doc only，不动 src/ |

**不能并行**（撞 schema 或 invariant）：
- T-88 P1 (schema) + T-37 (brief writer 写 event.affected_scopes) —— event schema 改动期间禁
- T-88 P3 (AI pipeline) + T-D4 (propose tools) —— 都改 ai/task 路径
- T-DR + T-37 —— Dreaming 读 brief，必须 brief writer 先 ship

---

## §4 Capacity model + 时间线

### 4.1 单人 raw capacity

- **理论值**：1pt ≈ 0.25 周 = ~10 小时（含 plan/impl/test/PR）
- **实际**（按 YUK-88 P0-P7 历史拟合）：1pt ≈ 0.30-0.35 周
- **492 pts**：~140-170 周 = **2.7-3.3 年**

### 4.2 AI-paired capacity（含 Claude Code skills）

**收益来源**：
1. **Lane 内 impl 加速**：subagent 跑 impl 时人可 review / plan 下条 lane → ~1.4x
2. **多 worktree 并行**（file-disjoint）：2 worktree → ~1.6x；3 worktree → ~1.8x（review capacity 是瓶颈）
3. **过夜 / 周末**：AI 可在人不在时跑（前提：lane 已设好，无需 ADR 决策）→ ~1.2x
4. **自动 audit / doc sweep**：P4 类工作几乎 100% AI → +30pt 不计入瓶颈

**综合**：raw × 1.5-2x → **70-100 周 ≈ 1.5-2 年**

### 4.3 三种时间线方案

| 方案 | scope | 估时 | 缺什么 |
|---|---|---|---|
| **A. 极简（v1 closeout）** | Layer 5 (T-88) + Layer 7 (T-37) + Layer 8 critical path (T-D2/D3/DR/D6) + RatingAdvisor + ask_check + P4 doc sweep | ~250 pts / 70-90 周 = **18-20 个月** | 8 judges 大半 / Track F 全部 / cross-subject scheduling / graph view |
| **B. 平衡（v2 closeout）** | A + 5 judges (rubric/multimodal/code/external/diagram) + question_part + Subject #4 + Drawer×6 + Coach + graph view + Track F 半套 (SourcePack/grounding/PassageUI) | ~380 pts / 100-130 周 = **2-2.7 年** | speech_audio / human_review / OCR rebuild / Multimodal first-class / cross-subject scheduling deep |
| **C. 完全体（v3 closeout）** | 全 492 pts | **2.5-3.3 年** | 没了 |

**Recommendation**：**方案 A 是真实 1-2 年内 ship 范围**；方案 B 是 2-3 年；C 不现实。

---

## §5 推荐 sequencing

> Status: grill in progress（2026-05-27）。已 crystallize 决策见 §5.0；剩余 open question 见每条 wave 末尾。

### §5.0 Decisions crystallized during grill（2026-05-27）

| Q | Decision | Notes |
|---|---|---|
| Q5 | **v1 ship line @ Scenario A (~250pt)** + rolling commitment | A 打完做 retrospective 决定续 B / 转 maintenance / 暂停；不 upfront commit 2-3 年。Calibration baseline 5-8 pt/wk sustained → A 估 8-12 个月真实窗口。 |
| Q6.a | **T-D4 full 8 propose tools 进 A**（24pt，不 trim） | 不为 -14pt 削弱 first-class AI actor surface 完整性 |
| Q6.b | **T-D7 experimental:tool_use promote 进 A**（3pt） | 不 defer 到 maintenance；ADR-0011 promotion 闭环也是 v1 deliverable |
| Q6.c | **T-PD doc sweep 分布到 wave 之间**（不集中） | AI 主导，每 wave 3-5pt gap-filler；保 cognitive load 低 |
| Q6.d | **T-KG knowledge graph force-directed view 加进 A**（+13pt） | v2.1 brief §2.3.b 写"必须"= design contract；v1 不带 graph view = 未兑现 contract |
| Q2 | **T-88 P2 拆 basic + polish 两 sub-wave** | P2-basic (~12pt): TipTap + NodeView + text edit/split/merge/paste-md/undo/marks → ship；P2-polish (~4pt): slash/drag-drop/mention picker/cross_link picker UI → 后续 wave。**v0 readonly 被结构 constraint 否决**（P1 schema migration 会立即让 YUK-54 失效，必须 ship 编辑器无 UX hole）。Polish 可灵活推到 maintenance |
| Q4 | **T-DR // T-88 P3 并行**（with T-D4 propose tools merged 先）| File-disjoint enough in practice (`src/server/boss/handlers/dreaming_nightly.ts` + DomainTool bridge vs note AI pipeline handlers)；T-D4 merge 后冻结 registry.ts 直到两 track chain-merge 完；critical path 双线推进，整 schedule 省 4-6 周 |
| Q1 | **Wave 1 = 4 tracks 并行**（T-37 + T-RA + T-66 + T-88 P0）| Worktree A: T-37 → T-88 P0；Worktree B: T-RA → T-66。File-disjoint 全覆盖。匹配 Track-1 follow-up wave-1 历史节奏（3+1 lane）；不推迟 T-37 critical path（避免 6+ 周 compounding）|
| Q3 | **T-D3 Drawer MVP 试点 /today**（summary-driven）| 高频访问 + Layer 8 完全体核心模式（drawer 自动浮"今日 AI 建议"）；30s dwell trigger（v2.1 §1.2 锁定）。Deps：T-D2 query_review_due / query_memory_brief / query_learning_item_context 必先 ship；T-37 brief writer 必先 ship。比 /mistakes ask-driven 模式更激进但长期 vision 价值高 |

**A 剩余预算（post-Wave 1）**：T-88 remaining (~59) + T-D2 (25) + T-D3 (13) + T-D4 full (24) + T-DR (20) + T-D6 (15) + T-D7 (3) + T-PD (31) + T-KG (13) = **~203pt 主线** + ~30pt buffer = **~233pt**，@ 5-8 pt/wk → **7-12 月真实窗口**。T-37 / T-RA / T-66 / T-88 P0 已在 Wave 1 shipped，不再计入剩余主线。

### §5.1 Wave 模型（post-grill 2026-05-27，scenario A）

**所有 6 个 open question 已 grill 拍板**（见 §5.0）。Wave 结构基于 post-Wave-1 剩余 ~203pt 主线 + 30pt buffer = ~233pt（A）+ T-PD 31pt 分布到 wave 间隙。

**总 elapsed 估**：8 waves × 平均 5-6 周 ≈ **40-50 周（10-12 月真实窗口）@ 5-7 pt/wk sustainable**。

**Worktree allocation 原则**：每 wave 2 worktree 上限（hard cap，per §6.2）；wave 内多 track 用 worktree A/B 并行；同 worktree 内 sequential。

#### Wave 1 ✅ ship 2026-05-27 (1 天 actual elapsed — Critical path unlock + Track-1 closure)

| Track | pts | worktree | status |
|---|---|---|---|
| T-37 brief writer Phase B（推完）| ~5 | A | ✅ ship (PR #159 → main caccd97b) |
| T-88 P0 spike（接 T-37 后）| 2 | A | ✅ ship (PR #162 → spike 719c2b73) |
| T-RA RatingAdvisor | 3 | B | ✅ ship (PR #160 → main aaa534c7) |
| T-66 ask_check artifact | 5 | B | ✅ ship (PR #161 → main c3204469) |
| Wave 1 closeout YUK-99 / YUK-100 | — | — | ✅ ship (PR #163 → squash f1d5d9d2) |
| Iter2 post-ship 13 findings (YUK-101 band-aids) | — | — | ✅ ship (PR #165 → squash d4d68864)；true outbox follow-up later shipped via PR #168 / `72d77555` |

**实际**：~17 pts shipped。出口实现：T-37 ✓ unblocks T-DR + query_memory_brief；T-88 P0 spike ✓ 验证 split/merge/mark_wrong/idle 4 invariants；Track-1 follow-up phase **关 phase**。
**Follow-up resolved**：YUK-101 transactional outbox architectural rewrite shipped before Wave 3 prep。

#### Wave 2 (~10 周) — Schema + Editor basic + DomainTool M2

| Track | pts | worktree |
|---|---|---|
| T-88 P1 (schema + ADR-0020 land) | 5 | A |
| T-88 P2-basic (TipTap NodeView + 基础 edit) | 12 | A（P1 后）|
| T-D2 read tools (10 个 M2 全 ship，含 /today drawer 需要的 query_review_due / query_memory_brief / query_learning_item_context) | 25 | B |
| T-PD doc sweep gap-filler | ~4 | (任 worktree gap) |

**预期**：~46 pts，~9-10 周。出口：YUK-88 编辑器 basic ship（用户可编辑无 UX hole）；Layer 8 read tools 全 ship；ADR-0022 draft（基于 basic 验证）。
**实际**：PR #169 merged 2026-05-27，YUK-91 / YUK-92 / YUK-102 全部 ship；Wave 3 prep 从 `origin/main@709152e6` 起跑。

#### Wave 3 (~5 周) — Propose tools 集中 ship（registry 冻结准备期）

| Track | pts | worktree |
|---|---|---|
| T-D4 propose/write tools (8 个 full) | 24 | A（单 worktree focus；冻结其它 worktree 防 registry.ts 撞）|
| T-PD doc sweep gap-filler | ~3 | A |

**预期**：~27 pts，~4-5 周。出口：DomainTool 21 个全 ship；registry.ts 锁定；为 Wave 4 T-DR // T-88 P3 并行扫清 conflict。
**实际**：PR #170 ships T-D4 full 8 tools (`propose_knowledge_edge`, `propose_knowledge_mutation`, `attribute_mistake`, `propose_variant`, `propose_learning_item_completion`, `propose_learning_item_relearn`, `propose_record_links`, `propose_record_promotion`), plus `src/server/ai/tools/allowlists.ts` for the spec task/surface matrix. Linear：YUK-107 parent + YUK-108..112 lanes。
**Ready doc / closeout**：[`2026-05-28-wave3-ready-to-launch.md`](2026-05-28-wave3-ready-to-launch.md)。**Driver**：[`2026-05-28-td4-propose-write-tools-driver.md`](2026-05-28-td4-propose-write-tools-driver.md)。

#### Wave 4 ✅ implementation complete 2026-05-28 — T-DR // T-88 P3 并行（critical path 双线）

| Track | pts | worktree | status |
|---|---|---|---|
| T-88 P3 AI pipeline rewrite | 10 | A | ✅ YUK-93 implementation complete |
| T-DR Dreaming Lane | 20 | B | ✅ YUK-114 implementation complete |
| T-PD doc sweep gap-filler | ~4 | (任 worktree gap) | ✅ status/roadmap/lane docs updated |

**预期**：~34 pts，~5-6 周。出口：T-88 AI pipeline 完整改完 → unblocks P4；Dreaming agent 真跑 → unblocks T-D6 Coach + brief refresh 闭环。
**实际**：single Wave branch `yuk-114-yuk-93-wave4-autopilot` on `/private/tmp/tlp-wave4`；focused Vitest/Biome/`git diff --check` pass；full gate pending because local reused `node_modules` lacks `@tiptap/*` packages. Wave driver：[`2026-05-28-wave4-ready-to-launch.md`](2026-05-28-wave4-ready-to-launch.md)。

#### Wave 5 (~6 周) — Drawer /today MVP // Coach（Layer 8 vision 兑现起点）

| Track | pts | worktree |
|---|---|---|
| T-D3 Copilot Drawer MVP on /today（summary-driven + 30s dwell + tool-use 三段式）| 13 | A |
| T-D6 Phase 3 Global Coach Orchestrator | 15 | B |
| T-PD doc sweep gap-filler | ~4 | (任 worktree gap) |

**预期**：~32 pts，~5-6 周。出口：**Layer 8 vision 兑现起点** —— /today route 有真 Drawer + Coach 跑每日 / 每周 cron 出"今日安排" proposal。

**实现快照 (2026-05-28，single-PR wave)：**
- T-D6/A (YUK-118): CoachTask + TodayPlan schema (`src/core/schema/coach.ts`) + registry/prompt (mimo-v2.5-pro default + mimo-v2.5 fallback)
- T-D6/B (YUK-119): coach_daily ("45 3 * * *" — 30 min after dreaming_nightly, 15 min before prune_job_events) + coach_weekly ("30 4 * * 0") pg-boss handlers + `experimental:trigger_coach_scan` / `experimental:coach_scan` events
- T-D6/C (YUK-120): propose_learning_item_defer + propose_learning_item_archive tools；COACH allowlist +propose_knowledge_mutation；新增 `'defer'` proposal kind
- T-D3/A (YUK-122): `<CopilotDrawer>` 通用 slide-out + `<ToolUseCard>` 三段式 + tweaks (chainRowCost / toolUseDetail) + 6 个 fixture
- T-D3/B (YUK-123): `/today` 30s dwell hook + `GET /api/today/copilot-summary` (coach scan + dreaming preview + pending totals)
- T-D3/C (YUK-124): CopilotTask + `POST /api/copilot/chat` 两面路由 (`triggered_by='chat'` → copilot allowlist + writes `experimental:copilot_user_ask`; `triggered_by='chip'` → copilot_user_suggested_mistake_action allowlist + 不写 user ask, 仅 `experimental:copilot_chip_trigger`)

#### Wave 6 (~3 周) — Living Note + experimental promote

| Track | pts | worktree |
|---|---|---|
| T-88 P4 Living Note v0 | 10 | A |
| T-D7 experimental:tool_use → KnownEvent promote | 3 | B（小 PR）|
| T-PD doc sweep gap-filler | ~5 | (任 worktree gap) |

**预期**：~18 pts，~3 周。出口：Living Note mutator + idle + undo 全 ship；ADR-0011 promotion 闭环。

#### Wave 7 (~5 周) — 反链 / hub auto-sync + Knowledge graph

| Track | pts | worktree |
|---|---|---|
| T-88 P5 反链 + cross_link UI + hub auto-sync | 8 | A |
| T-KG Knowledge graph force-directed view | 13 | B |
| T-PD doc sweep gap-filler | ~4 | (任 worktree gap) |

**预期**：~25 pts，~4-5 周。出口：cross_link + 反链 + auto-sync nightly worker ship；v2.1 brief §2.3.b graph view contract 兑现。

#### Wave 8 (~4 周) — Read view + tests sweep + Editor polish + closeout

| Track | pts | worktree |
|---|---|---|
| T-88 P6 read-view + 节点页 | 6 | A |
| T-88 P7 tests rework | 4 | A（P6 后）|
| T-88 P2-polish (slash / drag-drop / mention picker / cross_link picker UI) | 4 | B |
| T-PD doc sweep 收尾 | ~5 | B |
| v1 closeout audit + status.md update | — | (master coordinator) |

**预期**：~19 pts，~3-4 周。出口：**v1 closeout** —— YUK-88 P0-P7 全 ship + Layer 8 critical path 全 ship + Layer 7 brief writer 闭环 + design brief contracts 兑现。Retrospective + 决定续 B / 转 maintenance / 暂停（per Q5 rolling commitment）。

#### Wave 总览

| Wave | Range | Major deliverable | pts |
|---|---|---|---|
| 1 | ~4 周 | Track-1 closure + critical path unlock + spike | 17 |
| 2 | ~10 周 | YUK-88 schema + editor basic + DomainTool read tools | 46 |
| 3 | ~5 周 | DomainTool propose tools full | 27 |
| 4 | ✅ implementation branch 2026-05-28 | T-DR // T-88 P3 双线 | 34 |
| 5 | ~6 周 | Drawer /today MVP // Coach（Layer 8 vision 兑现） | 32 |
| 6 | ~3 周 | Living Note + promote | 18 |
| 7 | ~5 周 | 反链 + hub auto-sync + graph view | 25 |
| 8 | ~4 周 | read view + tests + polish + closeout | 19 |
| **Total** | **~43 周 ≈ 10 月** | scenario A v1 closeout | **218 主线 + 30 buffer + 31 PD = ~279pt** |

注：~43 周是 5-7 pt/wk sustainable 估；如 5pt/wk → ~56 周（13 月）；如 8pt/wk → ~35 周（8 月）。

**Wave 间 gate**（每 wave 结束必跑）：
1. `pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test && pnpm build` 全绿
2. `/audit-drift` 跑一次
3. `docs/superpowers/status.md` update（标 wave deliverable ✅）
4. master roadmap §0.3 当前快照 update
5. **新 ADR / ADR revision check** —— 跨 wave 新 ADR 必须 link 进 v0.4-complete-form-roadmap.md §2 ADR 表
6. Linear sub-issue close（commit message `Closes YUK-9N`）
7. 用户拍板下 wave 启动 OR retrospective（rolling commitment 决策点）

### 5.2 砍 / 推后 candidates

按"投入产出比 + 用户单人价值"评估：

| 砍 / 推后 | 理由 |
|---|---|
| **T-J6 speech_audio / T-J7 diagram_handwriting / T-J8 human_review** | 当前数据集（wenyan + math + physics）用不到；等真有这类题再做 |
| **T-J9 symbolic (Python sidecar)** | 需 ADR-0001 revise + 工程成本高；math symbolic 等价用 LLM ai_flexible 兜底足够 |
| **T-MM Multimodal first-class** 完整版 | 当前 vision 是 user-triggered rescue（ADR-0002）；first-class 工程量太大，等真高频再做 |
| **T-OC OCR pipeline rebuild** | 当前 Tencent Mark Agent + manual rescue 跑得动；rebuild 是 nice-to-have |
| **T-CS cross-subject scheduling deep** | 单用户 + 学科 ≤ 3 时手动切换够用；deep scheduling 是 4+ subject 才有真痛点 |
| **T-S4 Subject #4 acid test** | 不做新 subject，等 vision 兑现后再说 |
| **T-LI 3a/3b LearningIntent** | 3c 已覆盖主流路径；3a/3b 是 edge case |

砍这 7 条 → 减 ~80 pts → 综合时间线从 **2 年压到 ~1.5 年**。

### 5.3 接受 unfinished state

**永远不会 100% closeout**。这个项目的本质是单用户长期演化。"完成定义"应该改为：
- Layer 5 + Layer 8 + Layer 7 critical 部分（=方案 A）= **product v1 closeout**
- 其他 = 持续 maintenance backlog，按用户真需求触发

---

# Part 2 — Autonomous Driver (the HOW)

## §6 执行架构

### 6.1 三层模型

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer A — Master Coordinator (你 + 主 session)                  │
│ - 看 master roadmap state                                       │
│ - 决定下一个 wave / track                                       │
│ - 跨 worktree gate decisions（ADR / UX / 优先级）               │
│ - 写本 doc updates                                              │
└──────────────────┬──────────────────────────────────────────────┘
                   │ dispatches per-track
                   ↓
┌─────────────────────────────────────────────────────────────────┐
│ Layer B — Track Driver (1 个 / track，独立 worktree + session)  │
│ - per-track ultragoal ledger (`.omc/ultragoal/<track-id>/`)     │
│ - per-track autonomous driver doc（仿 YUK-88 driver）           │
│ - 用 `/launch-phase` 执行 phase                                 │
│ - 周期性回 Layer A 报状态                                       │
└──────────────────┬──────────────────────────────────────────────┘
                   │ dispatches per-phase
                   ↓
┌─────────────────────────────────────────────────────────────────┐
│ Layer C — Phase Orchestrator (`/launch-phase` skill)            │
│ - 拆 lane → worktree per lane → superpowers loop                │
│ - pre-merge gate                                                │
│ - chain-merge sequential                                        │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Multi-track parallelism 规则

**Hard cap**：**同时 active track ≤ 2**。理由：
- review capacity（人 + AI 自审）
- main branch 合并冲突风险
- ADR / spec 决策的 cognitive load

**例外**：P4 doc sweep 可作为第三条"low-touch" track 并行（不动 src/，纯 doc）。

**Worktree allocation**：
```
worktrees/
  track-88/          # YUK-88 主 worktree（or per-phase worktree as launch-phase 拆）
  track-d2/          # DomainTool read tools
  track-37/          # brief writer Phase B
  track-doc/         # P4 doc sweep（low-touch）
```

**何时新开 worktree**：
- 当前 active track ≥ 2 → 拒绝新开
- 一条 track 进入 review-only state（等 PR merge）→ 可暂"挂起"开新 track

### 6.3 ultragoal ledger 结构

**Decision**：**per-track ultragoal**，不用 master ledger。理由：
- ultragoal CLI 不直接支持多 plan 共存于同一目录（每 plan 期望 `.omc/ultragoal/goals.json` 唯一）
- 跨 track 协调用本 doc + status.md（cross-track 状态查询 = 跑每个 track 的 status）

**目录布局**（建议）：

```
.omc/ultragoal/                          # 当前 YUK-88 已占（goals.json）
.omc/ultragoal-track-88/                 # （未来 migrate；当前先复用 .omc/ultragoal/ 作 track-88）
.omc/ultragoal-track-d2/                 # T-D2 read tools
.omc/ultragoal-track-37/                 # T-37 brief writer
.omc/ultragoal-track-dr/                 # T-DR Dreaming
.omc/ultragoal-track-d6/                 # T-D6 Coach
```

**当前妥协方案**：`omc ultragoal` CLI 默认读 `.omc/ultragoal/`，要 per-track 需要 wrapper script。**短期建议**：

- T-88 占用 `.omc/ultragoal/`（已 init）
- 第二条 track 启动时，写 wrapper：
  ```bash
  cd .omc && mv ultragoal ultragoal-track-88 && ln -s ultragoal-track-88 ultragoal
  # 切到第二条 track 时 mv + relink
  ```
- 长期：等 ultragoal CLI 支持 `--workdir` 后真做 per-track

### 6.4 Background polling / Schedule

**Use case**：Layer A coordinator session 不常驻；用 schedule 周期性回来检查。

| 触发 | 频率 | 动作 |
|---|---|---|
| 每个 active track 的 phase end (PR merged) | event-driven | 触发 Layer A 决定下一 phase / 下一 track |
| Weekly audit | `/loop 7d` 或 cron | 跑 `/audit-drift`，看 status.md 是否需要 update |
| Daily check | `/loop 1d`（optional） | `omc ultragoal status` × all ledgers，看 blockers |
| Phase 启动前 preflight | manual | 见 YUK-88 driver §1.1 + 本 doc §1.1 |

**实施**：
- `/loop 1d <prompt>` 让一个常驻 session 每天醒一次检查
- 或不开 loop，纯用户 trigger（session 起来跑 ritual）

### 6.5 Session 模型（建议）

**Master coordinator session**：1 个，持久；驱动本 doc 的 update + cross-track decision。

**Per-track session**：每条 active track 一个，**独立 Claude Code session in own worktree**。track session 跑 `/launch-phase`，与 master 通信用：
- 文件（commit / PR / ultragoal ledger）= 主同步通道
- 不用 SendMessage / TeamCreate（per §6.2，2 track 上限不值得 team mode）

**接力 ritual**：新 session 接力时，读：
1. 本 doc §0.3 当前快照
2. 各 track 的 `.omc/ultragoal-*/` status
3. 本 doc §5 当前 wave 在哪
4. （per track）该 track 的 YUK-88-style autonomous driver doc

---

## §7 Decision gates（必须人 trigger）

| Gate | 时机 | 谁决定 |
|---|---|---|
| **G-priority**：wave 之间 priority 调整 | 每 wave 结束 | 用户 grill `/grill-with-docs` |
| **G-ADR**：发现 ADR 需 revise | impl 期间撞到 | 用户 + `/grill-with-docs` |
| **G-UI**：任何 UI 改动 | UI 代码动手前 | 用户 + UI design pre-flight（per CLAUDE.md） |
| **G-scope**：phase 超 2x 估时 | escalation | 用户决定续做 / 拆分 / 砍 |
| **G-track**：新 track 启动 | wave 节点 | 用户拍板该 track 真需要 |
| **G-merge**：ff-merge 不可能 | launch-phase chain-merge 段 | 用户决定 rebase / merge commit |
| **G-push**：push 到 remote main | chain-merge done | 用户手动 push（per YUK-88 driver §3.3 launch-phase 不自动 push） |
| **G-non-goal**：触发"重新评估 non-goal" 条件 | v0.4 §1.3 + §9 列出的 5 条 | 用户 grill |
| **G-spike-revise**：spike (P0 类) 结论说明 ADR 需调 | spike PR 描述 | 用户 review spike 结论 |
| **G-cost**：当月 token cost > 用户阈值 | monthly review | 用户决定降级 model / 停 track |

**所有其他决策都可 AI 自主**。

---

## §8 Skill + MCP usage（cross-track delta）

> Common rules: 见 YUK-88 driver `2026-05-26-yuk88-autonomous-driver.md` §4 + §5。本节只给跨 track 的额外规则。

### 8.1 跨 track 必用 skill

| Skill | 何时 |
|---|---|
| `/audit-drift`（项目本地）| 每 wave 结束 / 每个 phase ship 后 |
| `/grill-with-docs`（项目本地） | wave 切换 / 发现 ADR 冲突 / priority 评估 |
| `omc ultragoal`（CLI） | per-track ledger 操作 |
| `/launch-phase`（项目本地） | per-phase 拆 lane 执行 |
| `/handoff`（superpowers）| 当前 session compact 前的接力 |
| `/oh-my-claudecode:plan` (Opus) | 跨 track 优先级 grill / wave 规划 |

### 8.2 cross-track 不要用

- ❌ `/oh-my-claudecode:autopilot` —— 单 track 都不够用，跨 track 更不行
- ❌ `/oh-my-claudecode:ralph` 跨 track —— 自循环不知道 track 边界
- ❌ `/oh-my-claudecode:team` —— 2 track cap，team coordination overhead 无收益
- ❌ `/oh-my-claudecode:ultrawork` —— 同上

### 8.3 Cross-track Linear / MCP 规则

| 操作 | 工具 | 频率 |
|---|---|---|
| Sub-issue 列表全扫 | `mcp__claude_ai_Linear__list_issues --parentId YUK-88` 等 | weekly |
| 跨 track follow-up issue 新建 | `mcp__claude_ai_Linear__save_issue --parentId <relevant>` | as needed |
| 跨 track audit 报告 | 不发 Linear comment；写 `docs/audit/YYYY-MM-DD-cross-track-audit.md` | bi-weekly |
| Master coordinator update | 本 doc §0.3 当前快照 + §5 wave 进度 | 每个 wave 结束 |

---

## §9 Failure handling + Escalation（cross-track delta）

> Common: YUK-88 driver §9

### 9.1 跨 track 撞 schema / 文件

- Track A 在 worktree A 改 X 文件；Track B 在 worktree B 也改 X 文件
- launch-phase chain-merge 时 ff-merge 不可能 → G-merge gate
- **mitigation**：在 §3.3 的"高度并行可能性"表里事先把可并行 pair 列死；不在列表内的不并行

### 9.2 cross-track ADR 冲突

- Track A 引入 ADR-0022（假设），Track B 的 spec 跟新 ADR 冲突
- escalate: 停 Track B + 用 `/grill-with-docs` 重审 ADR-0022 + 看 B 是否需 revise spec
- **不**让 Track B 自己 "在边缘绕"

### 9.3 wave 估时 2x 超

- 当前 wave 超时 2x → 停所有新 track 启动 + 用户重 prioritize 当前 wave 剩余项

### 9.4 单 track session 死循环（subagent ≥ 2 同因 BLOCKED）

- 该 track session 报告 Layer A
- Layer A 决定：A 修 spec / B 拆 lane / C 砍 track

---

## §10 Logging + State Updates

### 10.1 Per-wave update

每个 wave 结束（≥ 1 track checkpoint complete）：

1. 本 doc §0.3 当前快照 update
2. 本 doc §5 wave 进度标 ✅
3. `docs/superpowers/status.md` 加 wave ship 段
4. 每个 ship 的 track：`omc ultragoal checkpoint --status complete --quality-gate-json ...`
5. Linear: `Closes YUK-9N` in commits（auto-flip Done）

### 10.2 Per-phase update（per track，跟 YUK-88 driver §10 同）

### 10.3 Master roadmap update 触发

- 每 wave 结束
- 发现新 forward-lock / 依赖
- 用户砍 / 加 track
- 估时大幅修正（> 30% diff）

### 10.4 Memory updates

发现新 cross-track pattern → save memory（per CLAUDE.md auto memory 协议）：
- "Track A + Track B 并行实证可 / 不可" → feedback memory
- "ultragoal multi-ledger 实际 friction" → reference memory
- "wave 切换的人 trigger 时机" → feedback memory

---

## §11 Per-Track Summary Cards

> 每条 active / 即将 active 的 track 在这里有一张卡片。每张卡片链到该 track 的 detailed driver doc（如已存在）或 spec source。

### Card T-88 — YUK-88 Block-Tree Note Rebuild

- **Status**：planning ✓，**P0 ✅ ship 2026-05-27**（PR #162 spike），P1/P2 ✅ Wave 2，P3 ✅ implementation branch，P4-P7 ⬜
- **pts**：61 (P4-P7 remaining)
- **Estimate**：remaining scoped by P4-P7 + polish/read-view/test sweep
- **Driver doc**：[`docs/superpowers/plans/2026-05-26-yuk88-autonomous-driver.md`](2026-05-26-yuk88-autonomous-driver.md)
- **Phase index**：[`docs/superpowers/plans/2026-05-26-yuk88-block-tree-rebuild-phase.md`](2026-05-26-yuk88-block-tree-rebuild-phase.md)
- **ultragoal ledger**：`.omc/ultragoal/`（init 完成，per-story mode，G001-G008）
- **Linear**：YUK-88 + YUK-90 ✅ + YUK-91/YUK-92 ✅ + YUK-93 In Review pending PR + YUK-94~97
- **Forward-locks**：Layer 5 完全体；P3 schema 改动已 unblock T-TQ / T-BA
- **Blocked-by**：(none) —— 可立即跑

### Card T-37 — ADR-0017 Brief Writer Phase B

- **Status**：✅ ship 2026-05-27（PR #159 → main caccd97b；Linear YUK-37 Done）
- **pts**：8（estimate 8pt 收口，per Linear field）
- **Driver doc**：[docs/superpowers/plans/2026-05-27-t37-brief-writer-driver.md](2026-05-27-t37-brief-writer-driver.md)
- **Forward-locks 已 unblock**：Layer 7 Memory writer ✓ + T-DR Dreaming(blocked-by T-37 解除) + T-D2 query_memory_brief 可建
- **Linear**：YUK-37 ✅

### Card T-D2 — DomainTool Registry M2 (10 read tools 补完)

- **Status**：✅ implementation complete 2026-05-27
- **pts**：~25
- **Estimate**：6-8 周
- **Driver doc**：[`docs/superpowers/plans/2026-05-27-td2-read-tools-driver.md`](2026-05-27-td2-read-tools-driver.md) was the lane driver during Wave 2; implementation shipped in PR #169
- **Source spec**：`docs/superpowers/specs/2026-05-17-agent-context-tools-design.md` §Engineering Sequence step 5-6
- **Tools (10 个)**：`get_subject_graph_overview` / `query_knowledge` / `expand_knowledge_subgraph` / `find_knowledge_paths` / `query_records` / `get_record_context` / `get_question_context` / `get_review_due` / `get_learning_item_context` / `query_memory_brief`（最后一个等 T-37）
- **Forward-locks**：T-D3 / T-DR / T-D6 / T-OC unblocked for read-context usage
- **Blocked-by**：M1 ✓
- **Linear**：YUK-102 Done; proposal/write M4 split into YUK-107 parent + YUK-108..112 lanes

### Card T-DR — Dreaming Lane

- **Status**：✅ implementation complete 2026-05-28（final gate / PR pending）
- **pts**：~20
- **Estimate**：landed in Wave 4 branch
- **Driver doc**：[`docs/superpowers/plans/2026-05-28-tdr-dreaming-lane-driver.md`](2026-05-28-tdr-dreaming-lane-driver.md)
- **Source spec**：v0.3 §"Track D"；`docs/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md` §Phase 3
- **Forward-locks**：T-D6 Coach + Layer 7 brief refresh consumer
- **Blocked-by**：T-37 done + T-D2 done
- **Linear**：[YUK-114](https://linear.app/yukoval-studios/issue/YUK-114)

### Card T-D3 — Copilot Drawer MVP (1 route 试点)

- **Status**：⬜
- **pts**：~13
- **Estimate**：3-4 周
- **Driver doc**：⬜ 待写
- **Source design**：`docs/design/2026-05-15-design-brief-v2.1.md` §1.6 + `docs/design/loom-design-v2.1/`
- **Forward-locks**：T-D5 Drawer×6 routes
- **Blocked-by**：T-D2 ≥ 6 read tools
- **Linear**：⬜ 待建

### Card T-D6 — Phase 3 Global Coach Orchestrator

- **Status**：⬜
- **pts**：~15
- **Estimate**：4 周
- **Driver doc**：⬜ 待写
- **Source spec**：`docs/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md` §Phase 3
- **Forward-locks**：Layer 8 兑现
- **Blocked-by**：T-DR ✅ + T-D4 ✅（propose tools）
- **Linear**：⬜ 待建

### Card T-RA — Partial credit P3 RatingAdvisor

- **Status**：✅ ship 2026-05-27（PR #160 → main aaa534c7；Linear YUK-98 Done）
- **pts**：3
- **Driver doc**：[`docs/superpowers/plans/2026-05-27-tra-rating-advisor-driver.md`](2026-05-27-tra-rating-advisor-driver.md)
- **Linear**：YUK-98 ✅
- **Post-ship**：YUK-100 cause SoT fix shipped via Wave 1 closeout PR #163

### Card T-66 — Teaching ask_check artifact (YUK-66)

- **Status**：✅ ship 2026-05-27（PR #161 → main c3204469；Linear YUK-66 Done）
- **pts**：5
- **Driver doc**：[`docs/superpowers/plans/2026-05-27-t66-teaching-ask-check-driver.md`](2026-05-27-t66-teaching-ask-check-driver.md)
- **Linear**：YUK-66 ✅

### Card T-J1..T-J5 — Core judges (rubric / multimodal / ai_flexible / external / code_execution)

- **Status**：⬜
- **pts**：~5 + 8 + 5 + 13 + 13 = 44
- **Estimate**：12-15 周（5 个串）
- **Driver doc**：⬜（建议一份共用 judge driver，记 registry pattern）
- **Linear**：⬜ 待建 5 个

### 其他 cards 略

T-D4 / T-D5 / T-D7 / T-J6..J9 / T-QP / T-S4 / T-LI / T-AR / T-RT / T-CS / T-MR / T-TQ / T-KG / T-SP / T-SQ / T-PS / T-BA / T-SG / T-MM / T-OC / T-PD1..PD13 / T-CB / T-SB / T-LS / T-PQ / T-TF / T-CL / T-EP / T-FF：

启动时再写 card。模板：

```
### Card T-XX — <Name>
- Status / pts / Estimate / Driver doc / Source spec / Forward-locks / Blocked-by / Linear
```

---

## §12 Risk Inventory + Mitigations

> Common risks 见 YUK-88 driver §9。本节是 cross-track / 项目级别。

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **R-1 估时严重超** | High | 项目永远 close 不掉 | 接受方案 A (v1 closeout 范围) 而不是 C 完全体 |
| **R-2 ADR-0014 仍 proposed 但被引用** | Medium | 后续 ADR drift | T-PD11 优先；或 wave 1 顺手 升 accepted |
| **R-3 Dreaming forward-lock 链长期未解** | Low（Wave 4 resolved implementation path）| Layer 8 仍需 Coach/Drawer 才兑现 | T-37 + T-D2 + T-D4 + T-DR 已落地；下一步集中到 T-D6 / T-D3 |
| **R-4 5 brainstorm open question 没转 spec** | Medium | Copilot detail 落地卡 | T-CB / T-PQ / T-CL 在 Wave 2-3 中插入 |
| **R-5 用户审 capacity 是瓶颈**（不是 AI 算力） | High | 并行 cap = 2 worktree | 严格守 §6.2 cap；超了 ship 质量崩 |
| **R-6 Token cost 累积** | Medium | 月开销 | per phase cost 估 + 月度 review (G-cost gate) |
| **R-7 ADR-0020 / 0021 在 P2 跑通后需大 revision** | Medium | P3 / P4 stale | 接受 ADR revision 是 norm，不当 failure |
| **R-8 stack pivot 残留**（v0.4 §10.2 列出多处） | Low | 新 onboard 误读 | T-PD3 / T-PD8 sweep |
| **R-9 multi-subject pressure test 没真做** | Low | framework 假设不验证 | T-S4 可砍（不做也行，但记 R-9 残留） |
| **R-10 ultragoal multi-ledger CLI 不直接支持** | Medium | per-track ledger friction | §6.3 wrapper 或等 CLI 升级 |
| **R-11 git-guard hook 跟 cross-track 协调撞** | Low | commit 被拦 | per YUK-88 driver §9.2，触发即 escalate |
| **R-12 Session compaction 跨 track 上下文丢** | High | 接力丢上下文 | 用 `/handoff` skill + 本 doc + per-track ultragoal status 三件套接力 |

---

## §13 Hard NO (anti-patterns，cross-track)

> Common 见 YUK-88 driver §11。本节是 cross-track 特有。

| ❌ | 为什么 |
|---|---|
| 同时启 ≥ 3 track active | 超人 review capacity；ship 质量必崩 |
| 不验文件分离就并行两条 track | 撞 schema 必死；§3.3 已列死可并行 pair |
| 跨 track 共用 ultragoal ledger | CLI 不支持；用 per-track |
| 主 session 自己跑 `/launch-phase` 跨多 track | 主 session 是 coordinator，不亲手执行 |
| track 启动不写 driver doc 就上 `/launch-phase` | 复用 YUK-88 driver 也行，但必须有 anchor doc |
| ADR-0020/0021 撞了 track 自己绕 | 任何 ADR 冲突走 §9.2 escalate |
| wave 切换不跑 `/audit-drift` | 跨 wave 必跑，否则漂移累积 |
| 写新 ADR 不 link 进 v0.4 §2 ADR 表 | v0.4 是合成 SoT，新 ADR 要进表 |
| Linear sub-issue 不跟 track ID 对应 | track-id → Linear epic + sub 一对一 |
| 砍 track 不在本 doc §5.2 留痕 | 隐式砍会忘 |

---

## §14 Final Closeout（项目级）

**触发条件**：
- 方案 A 全部 ship（Layer 5 + Layer 7 + Layer 8 critical path + RatingAdvisor + ask_check + P4 sweep）
- OR 用户显式宣布"close v1，剩下走 maintenance mode"

**Closeout 动作**：
1. 本 doc §0.3 当前快照 final update
2. 写 `docs/superpowers/audits/2027-XX-XX-v1-closeout.md` —— v1 ship 表 + 遗留 backlog + 学到什么
3. `docs/planning/v0.4-complete-form-roadmap.md` mark "v1 closeout achieved on YYYY-MM-DD"
4. `docs/superpowers/status.md` 顶部加 "v1 closeout 完成" header
5. 所有 v1 范围内 Linear issue closed
6. 剩余 track 转 `maintenance backlog` Linear project
7. 新建 `docs/planning/v0.5-maintenance-roadmap.md`（如继续）or `v1.0-product-anchor.md`（如 freeze 当前架构）

---

## Appendix A: Tool / Skill quick reference (cross-track delta)

| 场景 | Tool |
|---|---|
| Master coordinator session 起 | 本 doc §1.1 ritual |
| 启新 track | per-track driver doc（仿 YUK-88）+ ultragoal init + per-track wave 估时 |
| Wave 切换 | `/grill-with-docs` + 本 doc §5 update |
| 跨 track 撞 schema | §9.1 / §9.2 |
| Phase ship | per-track ultragoal checkpoint + Linear commit close + 看本 doc §0.3 update |
| Wave ship | 本 doc §0.3 + §5 update + `docs/superpowers/status.md` update + `/audit-drift` |
| v1 closeout | §14 |

## Appendix B: ultragoal command cheatsheet

```bash
# 单 track 操作（默认 .omc/ultragoal/）
omc ultragoal status
omc ultragoal complete-goals       # 拿下一 phase handoff
omc ultragoal checkpoint --goal-id G00N --status complete --evidence "..." --claude-goal-json '...'
omc ultragoal record-review-blockers --goal-id G00N --title "..." --objective "..." --evidence "..."
omc ultragoal add-goal --title "..." --objective "..."

# Multi-track（手动 swap，等 CLI --workdir 支持）
cd .omc && rm ultragoal && ln -s ultragoal-track-d2 ultragoal
omc ultragoal status  # 现在看的是 track-d2

# 初始化新 track
mkdir -p .omc/ultragoal-track-XX
cd .omc && rm ultragoal && ln -s ultragoal-track-XX ultragoal
omc ultragoal create-goals --brief-file <track driver doc> \
  --claude-goal-mode per-story \
  --goal "P0::..." --goal "P1::..." ...
```

## Appendix C: Session-start ritual（master coordinator）

```
我在驱动整个 the-learning-project roadmap autonomous execution。
按 docs/superpowers/plans/2026-05-27-master-roadmap.md 执行。

执行 §1.1 ritual：
1. ls .omc/ultragoal*  — 看几个 track 在跑
2. (per active track) omc ultragoal status
3. git status -uno && git log --oneline -10 && git worktree list
4. 看 Linear active YUK-88 / 其他 active issue
5. 看 docs/audit/*drift* 最新一份

读完本 doc §0.3 当前快照 + §5 当前 wave。
按当前 wave 决定下一步动作。
```

## Appendix D: Master decision flowchart

```
session start
  ↓
master ritual §1.1
  ↓
any track 在 review-blocked? → yes → 优先解（不开新 track）
  ↓ no
any track 当前 phase done & 待 user trigger 下个 phase?
  ↓ yes
  trigger 下个 phase（同 track）→ delegate to track session
  ↓ no
当前 active track 数 < 2 (or <3 含 doc) ?
  ↓ yes
当前 wave 还有未启 track？ → yes → propose 启动 + user approve
  ↓ no
当前 wave done? → yes → wave 切换 ritual: /audit-drift + status.md + master doc update + propose next wave
  ↓ no
等 active track ship 更多 phase / 拿 ScheduleWakeup 周期回来
```

---

## §15 立刻可行的下一步（你拍板后）

按建议优先级：

1. **立即（今天）**：用 `/grill-with-docs` grill 本 doc §5 推荐 sequencing —— 6 个 open question 列在 §5.1 each wave 末尾。grill 完拍板 Wave 1 范围。
2. **本周**：
   - 把当前 `.omc/ultragoal/` 改名为 `.omc/ultragoal-track-88/`（per §6.3）+ symlink
   - 写 T-37 + T-RA + T-66 三条 quick-win track 的 driver doc（薄，复用 YUK-88 driver 大部分）
   - 启动 Wave 1：T-37 + T-RA + T-66 + T-88 P0 并行
3. **本月**：Wave 1 ship → Wave 2 grill → 启 T-D2 + T-88 P1/P2
4. **每月**：master roadmap doc update + `/audit-drift` 一次 + ScheduleWakeup 每周回看 ultragoal status

---

## §16 维护规则

- 每 wave 结束 update 一次（§0.3 / §5 / §11 cards）
- 不复制 ADR / spec 内容；只 link
- estimate 修正 > 30% 必须留痕（在本 doc 加 commit ref + 简述原因）
- 砍 track 必须在 §5.2 留痕
- 新 track 必须在 §2 + §11 加 entry
- v1 closeout 后本 doc 标 "frozen，转 v0.5 maintenance"

---

**End of Master Roadmap & Autonomous Execution Driver v1**

> 状态：v1 draft，pending grill。任何根据本 doc 的执行决策应先经 §15 step 1 grill 拍板。
