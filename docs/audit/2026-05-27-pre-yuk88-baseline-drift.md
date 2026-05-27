# Pre-YUK-88 Baseline Drift Audit — 2026-05-27

**Scope**: ADR-0001..ADR-0020 (active; ADR-0019 superseded by ADR-0020 on 2026-05-26)；planning doc `docs/planning/v0.4-complete-form-roadmap.md` §3 / §5.1 / §6 / §10 / §11；module docs `mistakes.md / learning-items.md / quiz.md / progress.md / notes.md`。
**Run by**: Claude Code (manual /audit-drift, general-purpose subagent), pre-YUK-88 implementation baseline。
**Skip**: schema field-level write-path drift (owned by `pnpm audit:schema`).

## Executive Summary

主仓代码在 ADR-0020 拍板后 24h 内**全面对齐 pre-ADR-0020 状态**：`artifact` 表仍是 `sections / outline_json / child_artifact_ids / knowledge_id (singular)` 旧 schema；`CorrectArtifactEvent.payload` 仍持 `section_id`（ADR-0019 已 superseded 但 schema 还在）；Foundation D M1 三个 read tool 实装齐全 (`query_mistakes / query_events / get_attempt_context`)，与 status.md / v0.4 §3 第 8 层 claim 一致。`mempalace` / `dreaming` / `memory` server 目录全部缺失（forward-locks 第 7 层）。`ai_task_runs` 表已建（drift 2026-05-19 已 resolved），但 `task_run_id` 仍是无 FK text。v0.4 §11 15 项风险有 6 项可在代码层确认仍 live；2 项已 partial resolved；新发现 4 条未在 §11 列出的漂移。

---

## P1 — Critical 漂移（YUK-88 实施前必须意识到）

### F-01 [Module doc] `docs/modules/notes.md` 整篇与 ADR-0020 冲突
- **声明** (notes.md §0 表 + §3 / §10.3)：`note_hub / note_atomic` 两态；atomic 持 `sections[]` (definition/mechanism/example/pitfall/check)；存储 markdown + frontmatter；`check section.embedded_check.question_ids[]` inline；TipTap "❌ 未实现"
- **代码** (`src/db/schema.ts:289-299`)：`artifact` 表确有 `sections jsonb` + `outline_json` + `child_artifact_ids` + `knowledge_id (singular)`
- **ADR-0020 §1/§3/§6** (2026-05-26 accepted)：三态 `hub/atomic/long` 共用 `body_blocks JSONB`；DROP sections/outline/child_ids/knowledge_id；embedded check 改独立 `tool_quiz` artifact + `artifact_ref` block；存储是 JSONB 不是 markdown 文件
- **冲突**：整篇 notes.md（§3 section 模板 / §5 living-note 5 触发器 / §6 embedded check / §10.2 OSS 选型表 / §10.3 markdown frontmatter / §11 阅读 UX）按字面在 YUK-88 P0-P7 之后**全错**
- **Severity**: **P1**（YUK-88 P3 prompt rework + P4 living-note + P6 read-view 直接依赖此文档；不 sweep 会被读成 SoT）
- **建议**：YUK-88 P1 收尾时整篇 rewrite，或在 §0 顶补 "ADR-0020 后整体 superseded, 见 docs/planning/2026-05-26-note-rich-doc.md" banner；这是 v0.4 §6 P4.8 已知项的最严重一份

### F-02 [Schema] artifact 表仍是 pre-ADR-0020 形态
- **声明** ADR-0020 §1/§13 "Schema 变更"：DROP sections / outline_json / child_artifact_ids / knowledge_id；ADD body_blocks / knowledge_ids / attrs；建 `artifact_block_ref` 表 + GIN index
- **代码** (`src/db/schema.ts:289-299`)：仍含 `knowledge_id text` (290)、`child_artifact_ids jsonb` (294)、`outline_json jsonb` (298)、`sections jsonb` (299)；**未含** body_blocks / knowledge_ids (plural) / attrs；`artifact_block_ref` 表全无
- **冲突**：预期 — ADR-0020 拍板 2026-05-26，YUK-88 P1 phase 未启动；记入 baseline 让 P1 知道 DROP 量
- **Severity**: **P1** (informational baseline; expected drift)
- **建议**：YUK-88 P1 spec/plan 已写就，无需 ticket

### F-03 [Event schema] `CorrectArtifactEvent.payload.section_id` 仍存
- **声明** ADR-0020 §4：correction event payload `section_id?: string` → `block_id?: string`（schema rewrite，无 backfill）
- **代码** (`src/core/schema/event/known.ts:218-242`)：`section_id: z.string().min(1).optional()` 仍是当前字段；ADR-0019 PR #154 在 2026-05-26 刚 land
- **ADR-0019 header**：`Status: superseded by ADR-0020`，PR #154 ship 当日 supersede
- **Severity**: **P1** (expected baseline; YUK-88 P1 改名)
- **建议**：归 YUK-88 P1 schema 改造范围；audit 不另开 ticket

### F-04 [Planning §3 第 7 层] memory brief writer 目录缺失
- **声明** v0.4 §3 第 7 层 + ADR-0017：brief writer forward-locked 到 `src/server/memory/brief.ts`（Phase B / YUK-37 in progress）
- **代码** (`ls src/server/memory/` exit 1, `ls src/server/dreaming/` exit 1)：**两个目录均不存在**
- **冲突**：v0.4 §11 #13 已列为 forward-lock；status.md "🟡 YUK-37 in progress" 与目录缺失矛盾（要么 YUK-37 还停在 design 阶段，要么 brief.ts 走了别的 path 未更新文档）
- **Severity**: **P1**（forward-locks P0.3 Dreaming + P0.4 Global Coach + Copilot `query_memory_brief` tool）
- **建议**：在 YUK-37 issue 上更新一句 "brief.ts 文件何时落地"；或在 status.md L82 把 "🟡 in progress" 收口为更精确状态

---

## P2 — Confirmed drift（v0.4 §11 之内，已知未修）

### F-05 [Planning §11 #2 / P4.1] `architecture.md §5.1` 注：已 partial resolved
- **声明** v0.4 §6 P4.1：6 个 task 缺失 NoteVerifyTask / EmbeddedCheckGenerateTask / SemanticJudgeTask / UnitDimensionFallback / StepsJudgeTask / VariantVerifyTask
- **代码** (`docs/architecture.md:123-128`)：6 个 task 全部 listed（行 123-128）；过 audit
- **Severity**: **P2** — drift 2026-05-15+05-24 提到的 6 task 已补；本审计标 resolved；P4.1 ticket 可关
- **建议**：audit 完成 → 关闭 P4.1 doc sweep 占位

### F-06 [Planning §11 #3 / P4.2] `ai_task_runs` partial resolved
- **声明** v0.4 §11 #3 + §6 P4.2：表"三处文档声明但 schema 不存在"
- **代码** (`src/db/schema.ts:344-365`)：`ai_task_runs` 表已建（含 task_kind / status / started_at / 两 idx）
- **未解决**：`event.task_run_id` 仍是无 FK free-form text（schema.ts:371 + cost_ledger.task_run_id:396 + 501）；ADR-0014 / experimental.ts 多处 schema 也仍是 `z.string().optional()`
- **Severity**: **P2** — 表存在但 FK 缺失，半 resolved
- **建议**：在 audit/2026-05-27 中追加一行"`task_run_id` FK 未补"作单 ticket

### F-07 [Planning §11 #4] Copilot tools 实施已启动（5+ 周停滞 claim 失效）
- **声明** v0.4 §11 #4：spec 5+ 周无 implementation 启动；step 3-8 任何进展
- **代码** (`ls src/server/ai/tools/`)：12 个文件 — `bootstrap.ts / get-attempt-context.ts / mcp-bridge.ts / query-events.ts / query-mistakes.ts / registry.ts / types.ts` + 各 .test.ts；status.md Foundation D §M1 closeout 2026-05-26（PR #139/#140/#141）
- **Severity**: **P2 resolved** — v0.4 §11 #4 在 2026-05-26 M1 ship 后已无效；v0.4 doc 自己 §3 第 8 层已经记录了 ship 事实，但 §11 文字未同步更新
- **建议**：v0.4 §11 #4 已 stale，文字下次 update 时移除（不另开 ticket）

### F-08 [Planning §11 #6 / P4.10] YUK-62/63 plan checkbox 未对账
- **声明** v0.4 §11 #6 + P4.10：plan tasks `[ ]` 但 status.md / PR #133 已 ship
- **代码 + status.md**：status.md L121 列 YUK-62/63 ✅ ship；plan 未 cross-check（time-budgeted skip）
- **Severity**: **P3**（doc-only hygiene）
- **建议**：归入 YUK-88 后的 P4 doc sweep 大批量处理

### F-09 [Planning §11 #15 / P2.9] force-directed graph 仍 ⬜
- **声明** v0.4 §3 第 2 层 Gap + §11 #15：v2.1 brief §2.3.b "force-directed graph 视图必须"，status.md 未确认
- **代码** (`ls app/knowledge/` 不另查；§3 已确认未落)
- **Severity**: **P2** （v2.1 design ↔ ship gap 最大处）
- **建议**：与 ADR-0020 §10 "节点页 day1 不做 D graph (roadmap phase 2+)" 协调；已显式 deferred 的位置标 phase-deferred

### F-10 [Planning P4.6] knowledge.approval_status enum 缩减仍未做
- **声明** v0.4 §6 P4.6 + drift 2026-05-17：`'pending'` / `'rejected'` unreachable
- **代码** (`src/db/schema.ts:57-61`)：enum 仍是 `['pending', 'approved', 'rejected']`，default `'approved'`；grep 全 repo `approval_status` 命中 9 处全部写 `'approved'`（0 写 pending / 0 写 rejected）
- **Severity**: **P3** — pure schema lint；属 `pnpm audit:schema` 范围（schema lint already covers）
- **建议**：不另开 ticket；下次 schema audit 自动捕到

### F-11 [Planning P4.7] ADR-0002 `extracted_prompt_md` 过渡列仍存
- **声明** v0.4 §6 P4.7：列存在 + 需 ADR revision
- **代码** (`src/db/schema.ts:117`)：`extracted_prompt_md text` 仍在
- **Severity**: **P3**（pure doc/ADR sweep）
- **建议**：归入 P4 doc sweep batch

---

## P3 — Module doc drift（v0.4 §6 P4.8 总分项）

### F-12 [mistakes.md §0 + §1 + §6] disclaimer 与主体冲突有 §0 mitigate
- **声明** mistakes.md §0（2026-05-17）已写完整 "心里替换即可" disclaimer + 新旧字段映射表
- **代码 + 实际**：disclaimer 是合理 mitigate；§1+ 仍用 `Mistake.cause` / `from_judgment_id` 等旧名
- **§6** (line 96)："`from_judgment_id` 关联" — 已在 v0.4 §10.5 列为 DROPped 但 doc 未升级
- **Severity**: **P3** — §0 disclaimer 让 doc 仍可用；批量 sweep 即可
- **建议**：归入 P4.8

### F-13 [progress.md §0 vs §1] 双层 mastery 主体段未删
- **声明** progress.md §0：ADR-0012 已 DROP 双层；§1+ 仍写 `base_mastery + ai_delta_mastery` 公式 + 1.3 "AI delta 输入信号 +/- 0.15"
- **冲突**：disclaimer mitigate；新读者按 §1 实施会写不存在的字段
- **Severity**: **P3**
- **建议**：归入 P4.8 sweep；ADR-0012 已禁止 stored field，与 schema 一致

### F-14 [quiz.md §0 vs §1] Answer/Judgment/UserAppeal 三表 + JudgeRouter 主体
- **声明** quiz.md §0：3 表 DROP / JudgeRouter v2 light async；§1+ 仍按 Answer/Judgment/UserAppeal 三表写
- **Severity**: **P3**
- **建议**：归入 P4.8 sweep

### F-15 [learning-items.md §0 vs §1] hub+atomic 已落但 §1.1 来源表 stale
- **声明** learning-items.md §0：6 状态机 + hub+atomic 已 ship；§1.1 "4 个来源" 仍是 sketch 期 4 行
- **Severity**: **P3** —— §0 mitigate；§1+ 仍可读
- **建议**：归入 P4.8 sweep

---

## 新 / 意外发现（不在 v0.4 §11 列表）

### N-01 [planning consistency] v0.4 §5.1 Foundation D M1 与 status.md 同步
- v0.4 §5.1 Foundation D 段（line 637-644，2026-05-26 update）+ status.md §1 "Foundation D" 段（行 79-97）+ `src/server/ai/tools/*` 三者完全一致
- 无 drift
- **价值**：Foundation D 是当前 SoT 之一；新 baseline 中状态正确

### N-02 [DROPped tools] `update_ai_delta_mastery` / `refresh_memory_brief` 已绝迹
- **声明** v0.4 §10.5：`update_ai_delta_mastery` DROP (sub-0d 后)；spec 第 1126 行列 `refresh_memory_brief_note` 显式排除
- **代码**：grep `'update_ai_delta_mastery|refresh_memory_brief'` in `src/` returns 0 lines
- **结果**：DROP 已完成；§10.5 表项可标 "verified gone"

### N-03 [ADR ledger consistency] ADR-0019 supersede 标记正确，无 zombie
- ADR-0019 header `Status: superseded by ADR-0020`（line 3）+ ADR-0020 header `Supersedes: [ADR-0019]`（line 5）双向引用齐
- **未发现** 任何文档把 ADR-0019 当 live decision

### N-04 [Foundation D claim vs code] 3 read tools count 准确
- v0.4 §3 第 8 层 8.1 表写 `query_mistakes`/`query_events`/`get_attempt_context` 是当前 3 个 read tool；其余 10 个 ⬜
- 代码 `src/server/ai/tools/` ls：恰好 `query-events.ts / query-mistakes.ts / get-attempt-context.ts`（+ `mcp-bridge.ts / registry.ts / types.ts / bootstrap.ts` 框架文件）
- **结果**：M1 ship claim 与 code 1:1 对齐

### N-05 [ADR-0004 Task 表] VariantVerifyTask 仍未补（v0.4 §2.2 + P4.12 一致）
- **代码** (`docs/adr/0004*.md:69`)：列 `VariantGenTask`，未列 `VariantVerifyTask`
- v0.4 §2.2 / P4.12 已记
- **Severity**: P3 (重复确认；不新发现，但首次得到 grep evidence)

### N-06 [maxCost/fallbackChain] 仍是 dead metadata
- v0.4 §6 P4.4 + §11 风险点：`maxCost / fallbackChain` 实装 or 标 inactive
- **代码** (`src/ai/registry.ts:16-147`)：8 处 task 注册 7 处给 `fallbackChain`，`maxCost: 0.5` default；`architecture.md:169` 自陈 "还没有执行预算 nudge、fallback、degraded 记录"
- **结果**：metadata live but runtime dead，与 doc 自陈一致；P4.4 仍 unresolved

---

## Severity 总览

| Severity | 项数 | 描述 |
|---|---|---|
| **P1** | 4 (F-01..F-04) | YUK-88 实施前必须意识到的 active drift 或 expected baseline |
| **P2** | 5 (F-05..F-09) | v0.4 §11 已知项，部分 resolved 部分仍 live |
| **P3** | 6 (F-10..F-15) | doc-only / sweep 范围；P4.8 主体 |
| **N** (new) | 6 (N-01..N-06) | confirm / 重新校准 |

## 推荐 P4 doc sweep ticket 目标

按建议归并三批 ticket（YUK-88 后启动）：

1. **YUK-{TBD-1} — notes.md 整篇 ADR-0020 rewrite**（拆自 F-01；YUK-88 P3 收尾前必须；最高优）
2. **YUK-{TBD-2} — module doc P4.8 batch sweep**（F-12..F-15 + extracted_prompt_md F-11；ADR-0014 actor_kind cron + ADR-0017 brief writer path / §2.2 0004 task 表 / §10.5 verified gone 一并补）
3. **YUK-{TBD-3} — v0.4 §11 stale text update**（F-05/F-07 已 partial/full resolved，文字未同步；P4.4 maxCost/fallbackChain 决策）

## 不开 ticket 的项

- F-02 / F-03 已在 YUK-88 P1 范围
- F-10 由 `pnpm audit:schema` 持续盯
- F-08 归入更大 plan 收口规范（之前 YUK-{TBD-3} 涵盖）

---

**结束。Time spent**: ~25 min；time budget OK。

**Evidence trail**：
- `src/db/schema.ts` line refs above
- `src/core/schema/event/known.ts:218-242`
- `src/ai/registry.ts:16, 25, 38, 50-147`
- `docs/architecture.md:99-169`
- `docs/adr/0019-*.md:3-6`、`docs/adr/0020-*.md:1-5`、`docs/adr/0012-*.md:1-3`、`docs/adr/0014-*.md:1-7`、`docs/adr/0004-*.md:69`
- `docs/modules/notes.md §0/3/5/6/10`、`mistakes.md §0/§6`、`progress.md §0/§1`、`quiz.md §0/§1`、`learning-items.md §0`
- `docs/planning/v0.4-complete-form-roadmap.md` §3 / §5.1 / §6 / §10.5 / §11
- `ls src/server/ai/tools/`（12 files）、`ls src/server/memory/` (none)、`ls src/server/dreaming/` (none)
