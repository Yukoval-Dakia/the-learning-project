# YUK-88 Block-Tree Note Rebuild Phase 大纲（P0-P7）

> Phase-level orchestration doc for [YUK-88 Note rich-doc rebuild](https://linear.app/yukoval-studios/issue/YUK-88).
> 每个 phase 启动前另写 detailed lane plan doc `docs/superpowers/plans/2026-05-26-yuk88-p<N>-<slug>.md`。
> 本文档是 `/launch-phase` 的总入口 + `omc ultragoal` 的 brief。

**日期**：2026-05-26
**状态**：outline only —— per-phase lane plan docs to follow as phases start
**Roadmap source**：
- [`docs/planning/2026-05-26-note-rich-doc.md`](../../planning/2026-05-26-note-rich-doc.md) §0（post-grill 拍板 spec，权威）
- [`docs/planning/v0.4-complete-form-roadmap.md`](../../planning/v0.4-complete-form-roadmap.md) §3 第 5 层 / §6 P0-P2
- [ADR-0020](../../adr/0020-block-tree-note-rebuild.md)（核心契约）
- [ADR-0019](../../adr/0019-correction-event-artifact-section-subject.md)（已 superseded by 0020，section_id → block_id）

**Linear**：[YUK-88](https://linear.app/yukoval-studios/issue/YUK-88) + sub-issues [YUK-90](https://linear.app/yukoval-studios/issue/YUK-90)~[YUK-97](https://linear.app/yukoval-studios/issue/YUK-97)

---

## 范围与边界

**本 phase 覆盖 8 phase / ~61 pts / 17-20 周**：

| Phase | Linear | 主题 | pts | priority |
|---|---|---|---|---|
| P0 | [YUK-90](https://linear.app/yukoval-studios/issue/YUK-90) | TipTap Spike（fixture + mark_wrong + idle mock） | 2 | High |
| P1 | [YUK-91](https://linear.app/yukoval-studios/issue/YUK-91) | Schema + ADR-0020 核心契约 land | 5 | High |
| P2 | [YUK-92](https://linear.app/yukoval-studios/issue/YUK-92) | TipTap 编辑器接入 + ADR-0022 | 16 | High |
| P3 | [YUK-93](https://linear.app/yukoval-studios/issue/YUK-93) | AI pipeline 重写（NoteGenerate type switch + LearningIntent 改） | 10 | High |
| P4 | [YUK-94](https://linear.app/yukoval-studios/issue/YUK-94) | Living Note v0（mutator + idle + undo + 集中入口 + 分级） | 10 | High |
| P5 | [YUK-95](https://linear.app/yukoval-studios/issue/YUK-95) | 反链 + cross_link UI + hub auto-sync | 8 | High |
| P6 | [YUK-96](https://linear.app/yukoval-studios/issue/YUK-96) | YUK-89 read-view + knowledge node 节点页 | 6 | High |
| P7 | [YUK-97](https://linear.app/yukoval-studios/issue/YUK-97) | tests rework（按新 schema 全 sweep） | 4 | Medium |

**总估**：~61 pts / 17-20 周 elapsed（单人）。

**不在本 phase 内**：source_tier / grounding（与 ADR-0020 解耦，独立 phase）；D graph 视图（phase 2+ roadmap）；dreaming auto-archive maintenance（future）。

---

## Phase 依赖图（非线性，含并发段）

```
P0 (spike, throwaway)
   ↓
P1 (schema + ADR-0020) ─────┐
   ↓                         │
P2 (editor) ───── ADR-0022 ──┤
   ↓ (after ADR-0022)        │
   ├──────────────────────── P3 (AI pipeline)
   ↓                                ↓
   ↓                         P4 (Living Note)
   ↓                                ↓
P5 (反链 + hub auto-sync) ←─────────┘
   ↓
P6 (read-view + 节点页)
   ↓
P7 (tests rework)
```

**关键并发节点**：
- **P2 与 P3 在 ADR-0022 落地后可并行**（P2 跑通 → 补 ADR-0022 锁 PM node schema → P3 用 ADR-0022 写 prompt schema 约束）
- **P3 → P4 sequential**（Living Note 依赖 AI pipeline 重写后的 patch op schema）
- **P5 需要 P2 + P4 双完成**（反链 UI 在编辑器内 + auto-sync nightly worker 用 P3/P4 的 block schema）

**人 trigger / verifier gate 决策点**（半自主模式）：
1. P0 done → 人看 spike 结论 → 决定是否需要调 ADR-0020 → trigger P1
2. P1 done → schema land → trigger P2
3. P2 done + ADR-0022 written → 同时 trigger P3 + P4 准备（双 worktree）
4. P3 done → trigger P4 启动（如未并发）
5. P4 done + P2 done → trigger P5
6. P5 done → trigger P6
7. P6 done → trigger P7（收尾）
8. P7 done → 全 phase closeout audit

---

## Wave 划分（如果跑并行）

| Wave | Phases | 并发性 | 累计 pts |
|---|---|---|---|
| Wave 0 | P0 | 单 lane（spike，不 merge main） | 2 |
| Wave 1 | P1 | 单 lane（schema） | 7 |
| Wave 2 | P2 | 多 lane（editor 内部 5 lane） | 23 |
| Wave 3 | P3 // P4 准备 | P2 done + ADR-0022 后双 worktree | 23 (start) |
| Wave 4 | P3 ship + P4 | sequential within wave | 43 |
| Wave 5 | P5 | 单大 lane（hub auto-sync 是核心） | 51 |
| Wave 6 | P6 | 多 lane（read-view + 节点页） | 57 |
| Wave 7 | P7 | 单 lane（tests sweep） | 61 |

**Wave 间 gate**：每 wave 结束 chain-merge 完后跑 `pnpm test` + `pnpm typecheck` + `pnpm lint` + `pnpm audit:schema` + `pnpm audit:partition` + `pnpm audit:profile` + `pnpm build` 全绿，再启下一 wave 的 `/launch-phase`。

---

## Lane scope per phase（outline 级；启动前另写 lane plan）

> 每个 phase 启动时 lane subagent 在 lane start 对着 fresh main **现场写** per-lane plan（per memory `feedback_lane_plan_pattern.md`：禁预写、禁 resurrect）。
> 本文档只给 phase 级 lane 切分骨架 + acceptance test 入口，不预写 lane 内部实施步骤。

### P0 — TipTap Spike

**Lane 数**：1（spike，throwaway，不 chain-merge 到 main）
**详见**：[`2026-05-26-yuk88-p0-spike.md`](2026-05-26-yuk88-p0-spike.md)

### P1 — Schema + ADR-0020 核心契约

**Lane 切分骨架**：
- Lane A: Drizzle migration（DROP 老字段 + ADD body_blocks/knowledge_ids/attrs + artifact_block_ref 表 + GIN index）
- Lane B: Event schema rewrite（CorrectArtifactEvent payload section_id → block_id + projection）
- Lane C: ADR-0020 accepted + audit:schema allowlist 新条目 + CONTEXT.md 术语更新

**Chain-merge order**：A → B → C（schema 先 land，事件 schema 跟随，doc 收尾）。
**Per-phase plan**：`docs/superpowers/plans/2026-05-26-yuk88-p1-schema.md`（启动 P1 时写）

### P2 — TipTap 编辑器接入 + ADR-0022

**🔄 2026-05-27 master grill Q2 决策**：拆 **P2-basic + P2-polish** 两 sub-wave。理由：P1 schema migration 让 YUK-54 立即失效，必须有可用编辑器；TipTap 学习曲线在 basic 阶段就遇上，polish 阶段是 incremental；basic ship 后 P3/P4 可在真编辑器上验证而非仅 fixture；polish 可灵活推到 maintenance 不伤核心 UX。

**Lane 切分骨架（按 sub-wave 重分组）**：

**P2-basic (~12pt，3-4 周，必 ship)**：
- Lane A: TipTap StarterKit 集成 + bundle 拆分（editor lazy load / `<BlockTreeRenderer>` SSR）
- Lane B: 自定义 nodes（SemanticBlock / CrossLinkBlock / ArtifactRefBlock / CalloutBlock / AutoLinksContainer）+ NodeView 最小可用 UI
- Lane D1: paste markdown + undo/redo + inline marks（StarterKit 基础上加固）
- Lane E1: ADR-0022 draft（PM node schema 锁定，基于 basic 验证）

**P2-polish (~4pt，1.5 周，可推后)**：
- Lane C: Slash command + inline mention + cross_link picker UI
- Lane D2: Drag-drop（block 级 + nested block）
- Lane E2: ADR-0022 amendments（如有 polish 阶段 schema 微调）

**Chain-merge order**：
- P2-basic: A → B → D1 → E1（同 phase 内顺序）
- P2-basic ship 之后，P3/P4 可启动
- P2-polish 在后续 wave 接续：C → D2 → E2（可与 P3/P4 / 其他 track 并行）

**Per-phase plan**：`docs/superpowers/plans/2026-05-26-yuk88-p2-basic.md` + `2026-05-26-yuk88-p2-polish.md`（启动时分别现场写）

### P3 — AI pipeline 重写

**Lane 切分骨架**：
- Lane A: NoteGenerateTask 单 task + type switch（atomic / long / hub）+ 三套 prompt
- Lane B: NoteVerifyTask 改为 verifier 约束（5 semantic_kind for atomic / ≥3 cross_link for hub）
- Lane C: LearningIntent orchestrator 改产 1 hub + N atomic + 0-M long + propose_knowledge + propose_artifact 一次 accept
- Lane D: EmbeddedCheckGenerateTask 改为独立 quiz artifact + artifact_ref block 引用

**Chain-merge order**：A → B → C → D（pipeline 上游 → 下游）。
**Per-phase plan**：`docs/superpowers/plans/2026-05-26-yuk88-p3-ai-pipeline.md`

### P4 — Living Note v0

**Lane 切分骨架**：
- Lane A: NoteRefineTask + patch op schema（block-level insert_after / replace_block / delete_block）+ apply 落 event
- Lane B: Mutator-mode apply pipeline（小 patch 直接落库）+ propose-mode 分级（激进 mutation 走 propose）
- Lane C: Idle 协调（client presence heartbeat + server idle detection + queue flush）
- Lane D: Undo 集中入口（`/today` 活动卡 + artifact 页 "AI 改动" tab + 批量 undo）
- Lane E: 5 trigger producers 接入（mark_wrong / mastery / 错误率 / dwell / dreaming）

**Chain-merge order**：A → B → C → D → E。
**Per-phase plan**：`docs/superpowers/plans/2026-05-26-yuk88-p4-living-note.md`

### P5 — 反链 + cross_link UI + hub auto-sync

**Lane 切分骨架**：
- Lane A: Block-level cross_link mention 选择器（编辑器内 inline UI）
- Lane B: Block 反链 panel（查 `artifact_block_ref` 索引）
- Lane C: Nightly hub auto-sync worker（iii-curated mesh query：tree descendant + prerequisite incoming + derived_from outgoing + contrasts_with symmetric）
- Lane D: `AutoLinksContainer` 区 UI（relation chip + dismiss + `suppressed_block_refs[]` 事件）

**Chain-merge order**：A → B → C → D。
**Per-phase plan**：`docs/superpowers/plans/2026-05-26-yuk88-p5-cross-link.md`

### P6 — YUK-89 read-view + knowledge node 节点页

**Lane 切分骨架**：
- Lane A: `<BlockTreeRenderer>` 按 semantic_kind 渲染 idiom + 7 readability defect fix（参 [`docs/design/2026-05-26-atomic-note-read-view.md`](../../design/2026-05-26-atomic-note-read-view.md)）
- Lane B: Mark-wrong block 钻取 UI + hover/focus 稳态
- Lane C: `/knowledge/[id]` 节点页（节点元数据 + mesh chips + 主 atomic inline + 反链 panel + timeline）
- Lane D: 无主 atomic 占位卡 + 一键生成路径

**Chain-merge order**：A → B → C → D。
**Per-phase plan**：`docs/superpowers/plans/2026-05-26-yuk88-p6-read-view.md`

### P7 — tests rework

**Lane 数**：1（sweep 性质，单 lane 但跨多 test 文件）
**Per-phase plan**：`docs/superpowers/plans/2026-05-26-yuk88-p7-tests.md`

---

## Cross-cutting 约束（lane 启动必读）

### XC-1 — block_id 稳定性（ADR-0020 §2 Notion 位置规则）

**Helper**：P1 land 后位于 `src/server/blocks/anchor.ts`（待建）
**规则**：split → 原 id 跟"上半"、下半新 id；merge → 前 block id 保留、后 block id 丢弃；**无 lineage / supersedes / derived_from 字段**。
**适用 lane**：P2 编辑器、P3 AI pipeline patch op、P4 Living Note patch apply 全部依赖此 invariant。

### XC-2 — body_blocks JSONB schema 单一 SOT（ADR-0020 §1）

**Schema**：三态共用 `artifact.body_blocks JSONB`，PM doc.toJSON() 形态；differ 仅在 verifier 约束。
**适用 lane**：P3 NoteGenerate / NoteVerify、P4 Living Note patch、P5 cross_link 写入、P6 渲染。
**禁止**：任何 lane 引入 atomic-only / long-only / hub-only 物理 schema 字段。

### XC-3 — L3+L2 cross_link 索引混合（ADR-0020 §5）

**SOT**：`block.attrs.cross_link = { artifact_id, block_id? }`（L3，编辑器层）
**反链索引**：`artifact_block_ref` 表（L2，write-through）
**适用 lane**：P2 编辑器 cross_link 节点、P3 AI 出 cross_link、P5 反链 panel + auto-sync。
**禁止**：用 `knowledge_edge` 表存 note ref（mesh 留作概念关系）。

### XC-4 — knowledge_ids label 关系（ADR-0020 §3 / Q7.5b）

**Schema**：`artifact.knowledge_ids text[]`（plural），artifact 必须 ≥ 1 knowledge_id（没有就走 propose_knowledge）。
**约束**：atomic.knowledge_ids 数组长度恰好 1（verifier 强制）；long / hub 可 N。
**适用 lane**：P3 LearningIntent / NoteGenerate / NoteVerify、P5 hub auto-sync 包含判定、P6 节点页反链。

### XC-5 — Event-driven 撤回（ADR-0006 v2 + ADR-0020）

**SOT**：correction event log（block_id anchor）。
**Helper**：`src/server/events/artifact-corrections.ts` projection（P1 改读 block_id）。
**适用 lane**：P1 schema rewrite、P4 Living Note undo（apply 落 event）、P6 mark_wrong UI。
**禁止**：任何 lane 在 block tree 内嵌 lineage 字段；retract 走 event 不走 mutate。

---

## ADR 触发条件

以下情况需新 ADR：

- **P2 跑通后** → 写 ADR-0022（TipTap PM node schema 规约）
- **P5 hub auto-sync 性能不达标**（>10k knowledge nodes）→ ADR 记录 partial index 策略
- **P3 prompt token 预算超限** → 不进 ADR，进 phase audit
- **P4 mutator-mode 与 propose-mode 分级粒度调整** → 进 ADR-0020 revision（不新建 ADR）

---

## 启动建议

**默认半自主模式**：phase 间人 trigger，phase 内 `/launch-phase` 全自主跑。

**起手 sequence**：
1. **现在**：ultragoal init + 写 P0 phase spec → `/launch-phase` 跑 P0
2. **P0 done**：人看 spike 结论 → ADR-0020 微调（如需）→ 写 P1 lane plan → `/launch-phase` 跑 P1
3. **P1 done**：写 P2 lane plan → `/launch-phase` 跑 P2（多 lane 内部并行）
4. **P2 done + ADR-0022 written**：写 P3 + P4 lane plan（可并行准备）→ 双 worktree `/launch-phase` 起 P3 与 P4 准备 lane
5. **P3/P4 done**：写 P5 lane plan → `/launch-phase`
6. **P5 done**：写 P6 lane plan → `/launch-phase`
7. **P6 done**：写 P7 lane plan → `/launch-phase`（tests sweep）
8. **P7 done**：phase closeout audit + status.md update + Linear close YUK-88

**全自主升级路径**（未来评估）：跑过 ≥ 2 个 phase 找到痛点后，再决定是否用 `ralph` 包 `/launch-phase` 自动接力。当前不预设。

---

## Linear 项目结构

8 sub-issue 已建于 [Track-1 Follow-up project](https://linear.app/yukoval-studios/project/track-1-follow-up-note-teaching-review-polish-b2d5cdc828e6)（虽 parent YUK-88 不强属 Track-1，但共 project 便于浏览）：

| Phase | Linear | branch name |
|---|---|---|
| P0 | YUK-90 | `yukovaldakia09/yuk-90-p0-tiptap-spike-...` |
| P1 | YUK-91 | `yukovaldakia09/yuk-91-p1-schema-...` |
| P2 | YUK-92 | `yukovaldakia09/yuk-92-p2-tiptap-...` |
| P3 | YUK-93 | `yukovaldakia09/yuk-93-p3-ai-pipeline-...` |
| P4 | YUK-94 | `yukovaldakia09/yuk-94-p4-living-note-...` |
| P5 | YUK-95 | `yukovaldakia09/yuk-95-p5-反链-...` |
| P6 | YUK-96 | `yukovaldakia09/yuk-96-p6-yuk-89-read-view-...` |
| P7 | YUK-97 | `yukovaldakia09/yuk-97-p7-tests-rework-...` |

---

## 后续 follow-ups（不在本 phase 内）

- **source_tier / grounding write path + user_verified flip** —— 与 ADR-0020 解耦，独立 phase
- **D graph 视图**（节点页升级为图谱视图）—— phase 2+ roadmap，实施时机看实际使用反馈
- **per-hub opt-in `applied_in` / `related_to` mesh 扩展** —— day1 不做，未来用户配置项启用
- **Dreaming auto-archive maintenance agent** —— ADR-0020 §archive 留的 future 槽位，看 maintenance agent 整体优先级
- **mesh edge weight 参与 hub auto-zone 排序** —— P5 实施时决定是否按 weight 排序
