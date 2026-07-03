# YUK-471 Wave 3 修正设计 — artifact + question_block fold（impl-ready）

> 综合者修订稿，OVERRIDE 原设计稿 `2026-06-25-yuk471-wave3-artifact-question-block-fold.md`。
> 解决 critic（`2026-06-25-yuk471-wave23-design-critic.md`）5 条 BLOCKER：A2 / A3 / B4 / C2 / C4，全部 re-ground 到真实代码 + fork 决策。
>
> **Fork 决策（已锁，本稿一律遵循）**
> 1. artifact fold = **full-snapshot**（每次 edit 携 after 全树 + previous 供 revert），NOT op-replay。
> 2. 运行时新建 = **专属 create 事件 / 扩 payload**，genesis 仅一次性 backfill。
> 3. **per-entity SoT flag**（artifact / question_block 各自默认 OFF）。
> 4. 切换序 **artifact-before-learning_item**。
> 5. **复用 Wave 2 共享基建**（goal slice 的 superRefine / parity / gather / backfill / per-entity-flag 脚手架），extend 不重造。

---

## 0. 现状基线（re-ground 锚点）

| 事实 | file:line |
|---|---|
| `artifact` 表 24 列；fold 真相列 = `body_blocks`（TipTap doc JSON）、`type/title/parent_artifact_id/knowledge_ids/...`、生命周期 `archived_at/version/generation_status/verification_status` | `src/db/schema.ts` artifact pgTable |
| `question_block` 表；fold 真相列 = `structured`(StructuredQuestion 树)、`figures`、`status`、`merged_from_block_ids`、`version`；**`merged_into` 列不存在** | `src/db/schema.ts` question_block pgTable |
| `crop_refs = figures.map(f=>f.asset_id)` 派生列，唯一真派生写在 `applyExtractionResult`；`applyRescue` 更新 figures 但**不同步 crop_refs**（既有 staleness bug） | `src/server/session/ingestion.ts:246` / `:408-416` |
| artifact 生产 INSERT 站点 **6 处**（非原稿说的 5）：make-paper / author-artifact / tool-quiz-core / quiz_gen / learning_intent(×3) / legacy-record-appliers | `git grep '.insert(artifact)'` 见 §1.2 |
| `body_blocks` 编辑 2 路：手编 `editArtifactBodyBlocks`（事件 `experimental:artifact_body_blocks_edit`，payload 仅 `{artifact_id,prev_ver,next_ver}`）+ AI 精炼 `persistNoteRefineApply`（`experimental:note_refine_apply`，payload 已含 `ops[] + previous_body_blocks`） | `src/capabilities/notes/server/body-blocks-edit.ts:119` / `note-refine-apply.ts:177-205` |
| YUK-358 guard `isVerifiedBlock` + `applyNotePatch(enforceUserVerifiedGuard)`；accept-path 已有 guard-off 先例 | `src/core/blocks/is-verified-block.ts:11` / `apply-note-patch.ts:125-149` / `note-refine-apply.ts:148-149` |
| SoT flag **目前是单一全局** `PROJECTION_IS_WRITER`（knowledge/edge 已 LIVE=1） | `src/server/projections/sot-flag.ts:26` |
| `MaterializedSubjectKind = 'knowledge' \| 'knowledge_edge'`（待扩 `'artifact'`，**不扩 question_block**） | `src/server/projections/materialized-id-index.ts:24` |
| `GenerateArtifact` 现 schema：`action:'generate'`, payload `{artifact_kind,title,body_md,referenced_event_ids?}` —— **无 body_blocks / 无生命周期字段** | `src/core/schema/event/known.ts:222-237` |
| `GenesisExperimental` 复用：`experimental:genesis` + payload.row 全量快照，reserved-action parse-barrier 已建 | `src/core/schema/event/genesis.ts:93-143` |
| Wave 2 goal/mistake_variant/learning_item fold 脚手架（gather/parity/backfill/superRefine）= W3 直接 extend 的模板 | `src/server/projections/{gather,parity}.ts`、`src/core/projections/` |
| retract 把所有 proposal-sourced artifact 行 archive（跨 wave 与 learning_item 耦合 → 切换序 artifact 先于 learning_item） | `src/capabilities/agency/server/proposal-appliers.ts:160-230` |

---

## 1. ① payload #2–#7 最终 event schema

> 命名：fold-source 事件全部走 `experimental:` 命名空间 + reserved-action parse-barrier（镜 GenesisExperimental），promote 出 experimental 由 owner 单独决策、不在本 wave。新建 schema 落 `src/core/schema/event/`，注册进 `index.ts` 的 KnownEvent 联合 + `RESERVED_EXPERIMENTAL_ACTIONS`。

### #2 — `BodyBlocksEdit`（full-snapshot）【P0】

消解 B4 的核心。手编 + 人类 inbox-accept 两条路都收口到这一条；fold 做 last-write-wins，**不走 applyNotePatch、guard 无介入机会**。

```
action:       'experimental:body_blocks_edit'   // promote 出 artifact_body_blocks_edit
subject_kind: literal('artifact')
subject_id:   artifactId
actor_kind:   enum('user','agent')
actor_ref:    string.min(1)                       // 'artifact_block_tree_editor' | NOTE_REFINE_ACCEPT_ACTOR
outcome:      literal('success')
payload:
  previous_artifact_version: int().nonnegative()
  next_artifact_version:     int().nonnegative()
  body_blocks:               ArtifactBodyBlocks            // after 全量快照（src/core/schema/business.ts:301）
  previous_body_blocks:      ArtifactBodyBlocks.nullable() // before，供 revert；null=冷启首写
```

写路径改：`body-blocks-edit.ts:119` payload 扩为携 `body_blocks`（同 tx UPDATE 后的值）+ `previous_body_blocks`（复用 `:44-55` 已 SELECT 的旧行做乐观锁）；action 改名。

### #3 — `ArtifactCreate`（运行时新建，归一 6 站点）【P0】

genesis 仅 backfill；运行时新建走专属 create 事件（对照 Wave 2 `mistake_variant_create` 模式）。**全树快照入 payload**（full-snapshot 模型铁律：fold 不能从只携 ID 的事件重建行）。6 个生产 INSERT 站点（§1.2）统一改为「mint event → fold(events) → INSERT」。

```
action:       'experimental:artifact_create'
subject_kind: literal('artifact')
subject_id:   artifactId
actor_kind:   enum('agent','user')
actor_ref:    string.min(1)
outcome:      literal('success')
payload:
  row: ArtifactRowSnapshot   // 创建时的全量行快照（§2.1），含 body_blocks/type/title/parent/knowledge_ids/tool_* 等
```

> **与 `GenerateArtifact`（#5）的关系**：`GenerateArtifact`（`action:'generate'`）是既存的「AI 产出意图」业务事件，payload 只有 `body_md`（markdown，非 body_blocks）+ 无生命周期字段——它**不是 fold-source**，保留原样不动。fold-source 是新的 `artifact_create`。一次 AI 生成既写 `generate`（意图/可观测/evidence）又写 `artifact_create`（fold 锚），两者 `caused_by_event_id` 串联。**不扩 GenerateArtifact 加 body_blocks**——避免业务事件与 fold-source 职责混淆，且 `generate` 有 `outcome:'failure'` 分支而 create 仅在成功落行时写。

### #4 — `ArtifactLifecycle`（archive / unarchive / status 变更）【P1】

`archived_at` / `generation_status` / `verification_status` / `version` 推进。retract 路径（`proposal-appliers.ts`）archive proposal-sourced artifact 走此事件。

```
action:       'experimental:artifact_lifecycle'
subject_kind: literal('artifact')
subject_id:   artifactId
payload:
  op:                    enum('archive','unarchive','set_generation_status','set_verification_status')
  archived_at:           coerce.date().nullable().optional()
  generation_status:     string.optional()
  verification_status:   string.optional()
  verification_summary:  NoteVerificationResult.nullable().optional()
  next_version:          int().nonnegative()
```

### #5 — `EditQuestionBlockStructured`（单 canonical，含 affected_blocks 多行 after）【P0】

解 C4（mergeQuestions N+1 → 单 canonical）+ A2（merged_into 不存在 → 真实 after 建模）。`block-structured-edit.ts` 的 5 个 structured 改写函数（updatePrompt / addOption / setQuestionType / splitStem / mergeQuestions）全部收口到这一条。**job_events SSE 传输层维持 N+1 条不变**（与 canonical log 正交）。

```
action:       'experimental:edit_question_block_structured'
subject_kind: literal('question_block')
subject_id:   primaryBlockId        // 唯一 SoT 锚点（只有 primary 改了 structured）
actor_kind:   enum('agent','user')
actor_ref:    string.min(1)
outcome:      literal('success')
payload:
  op:              enum('update_prompt','add_option','set_question_type','split_stem','merge_questions')
  affected_blocks: array(AffectedBlockSnapshot).min(1)   // 见下；单 block edit 长度=1
```

**`AffectedBlockSnapshot`（A2 修正版 —— 无 merged_into 物理列）**：

```
AffectedBlockSnapshot:
  block_id:   string.min(1)
  role:       enum('primary','merged_source')
  structured: StructuredQuestion.nullable()    // primary=合并后全树；merged_source=操作前原值(供 undo,可选)
  figures:    array(FigureRef).nullable().optional()  // 仅 primary 必带
  version:    int()
  status:     string                            // 'draft' | 'ignored'
  // ★ 不含 merged_into_block_id —— 该字段无物理列。
  //   「被合并进谁」反向关系由 primary.merged_from_block_ids 正向表达；
  //   UI 若需展示，从本事件 payload 内存读取，绝不持久化进 row。
```

> **A2 关键裁定**：原稿 `AffectedBlockSnapshot.merged_into_block_id` 字段**删除**。merge after-state 的真相是：primary 行 `structured=mergedTree / figures=mergedFigures / merged_from_block_ids=[...prev,...absorbedIds] / version+1`；每个 absorbed 行 `status='ignored' / 其余列 unchanged`。reducer **绝不写 merged_into**。

### #6 — `QuestionBlockCreate`（OCR 新建块，A3 选项 B）【P1】

`applyExtractionResult`（OCR INSERT N 行）+ `applyRescue`（structured UPDATE）+ docx-ingestion 三条创建/覆写路径事件化（对照 mistake_variant_create）。当前 `ingestion.extraction_completed` job_event payload 只存 `structured_block_ids`（ID 列表，**无内容**），无法 fold——故需专属 create 事件携全行快照。

```
action:       'experimental:question_block_create'
subject_kind: literal('question_block')
subject_id:   blockId
payload:
  row: QuestionBlockRowSnapshot   // 创建时全量行（§2.2），含 structured/figures/crop_refs/page_spans 等
  origin: enum('ocr','rescue','docx','import')   // rescue=对已有块的覆写，fold 当 full-snapshot 覆盖
```

> rescue 在 fold 模型下 = 对同一 blockId 的第二条 full-snapshot 事件（`origin:'rescue'`），reducer last-write-wins 覆盖 structured/figures，**顺带把 crop_refs 重写为 figures.map(...)**——这正好修掉 §0 列的 applyRescue crop_refs staleness（见 A3 裁定 §2.2）。

### #7 — `ArtifactLifecycle` 与 learning_item 跨 wave 耦合说明【可 defer】

#4 已涵盖 archive 语义本身。#7 的「defer」指：retract 路径里 learning_item 的 archive 与 artifact 的 archive 是同一事务两个 fold-source 写——**learning_item fold 是 Wave 2 范畴**。本 wave 只保证 artifact 侧 `artifact_lifecycle` 事件写齐 + 切换序把 artifact flip 排在 learning_item flip 之前（§5）。两者都 flip 前，retract 仍走 imperative 双写 + 双 parity assert，无功能缺口。**可 defer = 跨 wave 联合 flip 的端到端验证**，不是 artifact lifecycle 事件本身。

---

## 2. ② RowSnapshot + fold reducer 聚合策略

### 2.1 `ArtifactRowSnapshot`（`src/core/projections/artifact.ts`，`.strict()`）

**入快照（fold 真相）**：`id, type, title, parent_artifact_id, knowledge_ids, intent_source, source, source_ref, body_blocks, attrs, tool_kind, tool_state, generation_status, verification_status, verification_summary, generated_by, verified_by, history, archived_at, created_at, updated_at, version`。

**排除列（裁定）**：artifact 表无纯派生列——`body_blocks` 是真相。`history` 进快照（它是 append 日志但属行状态，create/edit 事件携当时全量）。**无排除列**。

**fold reducer `foldArtifact(artifactId, events)` 分支表**：

| action | reducer 行为 |
|---|---|
| `experimental:genesis`(subject='artifact') | genesis seed：payload.row verbatim 为 base，version 取 row.version |
| `experimental:artifact_create` | base state：payload.row verbatim（运行时新建首事件） |
| `experimental:body_blocks_edit` | **full-snapshot**：`row.body_blocks = payload.body_blocks`，`version = next_artifact_version`，`updated_at = event.created_at`。**不 replay、guard 无关** |
| `experimental:note_refine_apply` | replay ops：`applyNotePatch(row.body_blocks, ops, {enforceUserVerifiedGuard:false})`，`previous_body_blocks` 仅供 revert 不参与正向 fold |
| `experimental:artifact_lifecycle` | 按 op 改 `archived_at`/`generation_status`/`verification_status`/`verification_summary`，`version=next_version` |

### 2.2 `QuestionBlockRowSnapshot`（`src/core/projections/question_block.ts`，`.strict()`）

**A3 crop_refs 最终裁定 —— 纳入快照，不排除**。理由：`applyRescue` 路径下 `crop_refs ≠ figures.map(f=>f.asset_id)`（既有 staleness），若 backfill 时从 figures 重算会与实际行不一致 → parity 假失败。把 crop_refs 当独立真相列入快照，create/rescue 事件携当时值。**附带收益**：rescue 走 #6 `origin:'rescue'` full-snapshot 时把 crop_refs 一并重写为正确值，逐步收敛 staleness（不需要单独修 applyRescue 的 PR，事件化即修）。

**入快照**：`id, ingestion_session_id, source_document_id, source_asset_ids, page_spans, structured, figures, layout_quality, reference_md, wrong_answer_md, image_refs, crop_refs, visual_complexity, extraction_confidence, status, knowledge_hint, merged_from_block_ids, imported_question_id, imported_attempt_event_id, created_at, updated_at, version`。

**排除列**：`extracted_prompt_md`（legacy deprecated，新代码不写，§0 schema 注释；标 fold 不管、parity assert 用 `omit` 跳过该列直到 DROP）。

**fold reducer `foldQuestionBlock(blockId, events)` 分支表（解 C4 多行聚合）**：

| action | reducer 行为 |
|---|---|
| `experimental:genesis`(subject='question_block') | genesis seed：payload.row verbatim |
| `experimental:question_block_create` | base / rescue 覆写：payload.row verbatim（last-write-wins，rescue 是同 blockId 第二条） |
| `experimental:edit_question_block_structured` | 在 `affected_blocks[]` 里找 `block_id===blockId`：<br>• `role==='primary'` → `structured=snap.structured / figures=snap.figures??row.figures / version=snap.version / status=snap.status / updated_at=event.created_at`<br>• `role==='merged_source'` → `status='ignored' / version=snap.version / updated_at=event.created_at`（structured 保持 before，**不写 merged_into**）<br>• not found → skip |

**C4 gather 双查（IO shell `gather.ts` extend）**：
- Q1：`subject_kind='question_block' AND subject_id=blockId`（直接命中，含 create / primary-side edit）。
- Q2：`action='experimental:edit_question_block_structured' AND payload->'affected_blocks' @> '[{"block_id":"<blockId>"}]'::jsonb`（jsonb containment，找 blockId 作为 merged_source 出现的事件——镜 W1 knowledge merge Q3 `payload->'from_ids' @> [nodeId]` 模式）。
- 合并去重、按 `(created_at asc, id asc)` 排序后 fold。

---

## 3. ③ C2 — question_block flip-guard anchor 路径

question_block **不入** `materialized_id_index`（无 propose→mint，行 id 恒等于 genesis event 的 subject_id，无 Q2 id 反查需求）。flip-guard 的「该行有无 genesis anchor」判定 = **直查 event 表**（镜 `hasKnowledgeNodeGenesisAnchor` 的 case-1，走 `event_subject_idx (subject_kind,subject_id,created_at desc)` 复合索引，O(log n) index scan，性能可接受）：

```
hasQuestionBlockGenesisAnchor(db, blockId):
  SELECT 1 FROM event
  WHERE subject_kind='question_block' AND subject_id=blockId
    AND action IN ('experimental:genesis','experimental:question_block_create')
  LIMIT 1
```

> 注意要 OR `question_block_create`：运行时新建块从无 genesis seed（genesis 只 backfill 老块），其 anchor 是 create 事件。`hasKnowledgeNodeGenesisAnchor` 不需要这条是因为 knowledge 老节点都有 genesis seed；question_block 新块走 create-event 而非 genesis，故 anchor 判据要含 create。

artifact 同构：anchor 判据 = event 表查 `('experimental:genesis','experimental:artifact_create')`。artifact **入** `materialized_id_index`（`MaterializedSubjectKind` 加 `'artifact'`）——非为 Q2（artifact 无 mint，Q2 冗余），而为与 knowledge/edge 的 flip-guard O(1) anchor 判定路径一致性；写 index 行成本低、收益是 anchor 判定统一走 index PK 查。question_block 有意区分（走 event 表直查），critic C2 的「缺口」实为省略描述，本节补齐。

---

## 4. ④ YUK-358 合流（B4）

**full-snapshot 如何消解 replay 冲突**：
- 手编 / inbox-accept → `body_blocks_edit`（#2）→ fold last-write-wins `row.body_blocks=payload.body_blocks`，**根本不调 applyNotePatch**，guard 没有触发点。这是最干净的消解：不需要 guard-off、不需要任何特殊逻辑。
- AI 精炼 `note_refine_apply` → 仍 op-replay，fold 时显式 `enforceUserVerifiedGuard:false`（复用 `note-refine-apply.ts:149` accept-path 先例）。

**reducer 注释铁律**：`foldArtifact` 的 `note_refine_apply` 分支必须显式标注「**fold-only 历史重建路径，guard 全程 off；禁止把此 flag 复用到在线 AI 写入**」——防止有人误用此 off 路径绕开在线写守卫。

**fold 接线时仍要守的 note-domain 不变量**：
1. **block anchor (`attrs.id`) 稳定性**（ADR-0020 §2）：fold 重建 body_blocks 时不得重新 mint block id；full-snapshot 天然满足（payload 携完整树含 attrs.id），op-replay 路径 applyNotePatch 已守。
2. **user_verified 在线写守卫不松动**：fold 的 guard-off 仅限 reducer 内存重建；在线 `editArtifactBodyBlocks` / `persistNoteRefineApply` 的 guard 默认仍 ON（除 accept-path），本 wave 不改在线行为。
3. **previous_body_blocks 仅 revert 用**：正向 fold 绝不消费 `previous_body_blocks`（它是 undo 锚），否则双向漂移。
4. **genesis seed 含 verified block 场景**：backfill 写当时全量快照（verified attrs 在内），后续 `body_blocks_edit` full-snapshot 直接覆盖，已 verified blocks 形态由事件 payload 决定，fold 只 last-write-wins，无 guard 介入 → B4「未覆盖场景」已消解，无残留冲突。

---

## 5. ⑤ genesis backfill + 切换序

**backfill（复用 Wave 1/2 `backfill-genesis` 脚手架）**：为每个 pre-W3 的 artifact / question_block 行写一条 `experimental:genesis`（payload.row = 当前全量 RowSnapshot），使 `fold(events)==row` 自首事件起可检验。artifact 同时写 `materialized_id_index` 行（subject_kind='artifact'）；question_block **不写** index。

**切换序（per-entity flag，§6）**：
```
knowledge / knowledge_edge   —— 已 LIVE=1（全局 flag，不动）
  ↓
artifact                     —— PROJECTION_IS_WRITER_ARTIFACT，先于 learning_item
  ↓
question_block               —— PROJECTION_IS_WRITER_QUESTION_BLOCK（与 artifact 独立，无序约束）
  ↓
learning_item                —— Wave 2，排在 artifact 之后
```

理由：retract 在同一事务里 archive artifact 行 + learning_item 行（`proposal-appliers.ts:160-230`）。若 learning_item 先 flip 而 artifact 未 flip，retract 的 artifact-archive 仍走 imperative，但 learning_item-archive 走 projection——两半 SoT 不一致期窗口期内 parity assert 口径错位。artifact 先 flip 消除该错位。每个 entity 各自 GATED-not-timed cutover（rebuild prod-clone → `audit:projection` per-entity CLEAN → set flag → restart）。

---

## 6. ⑥ 复用 Wave 2 共享基建（extend 不重造）

| 基建 | Wave 2 已立 | W3 extend 动作 |
|---|---|---|
| **per-entity SoT flag** | 全局 `projectionIsWriter()`（sot-flag.ts:26） | 新增 `projectionIsWriterArtifact()` / `projectionIsWriterQuestionBlock()`，各读独立 env `PROJECTION_IS_WRITER_ARTIFACT` / `_QUESTION_BLOCK`（默认 OFF）。**全局 flag 维持只 gate knowledge/edge**，不改其语义 |
| **genesis superRefine 逐 subject_kind safeParse** | goal slice 的 genesis payload superRefine（按 subject_kind 选对应 RowSnapshot safeParse） | 在 `GenesisExperimental` superRefine 加 `artifact`/`question_block` 两分支，复用 ArtifactRowSnapshot / QuestionBlockRowSnapshot safeParse |
| **parity assert `assertXParity`** | `assertKnowledgeNodeParity` / goal 版 | 新 `assertArtifactParity` / `assertQuestionBlockParity`，复用 snapshot-diff.ts + dev-throws/prod-logs 模式（parity.ts） |
| **gather/backfill/audit** | `gatherAndFold*` / `backfill-genesis` / `audit:projection` | gather.ts 加 artifact（Q1）+ question_block（Q1+Q2 jsonb @>）；backfill 加两 entity；`audit:projection` 加两 entity 抽样 fold==row |
| **materialized-id-index** | knowledge/edge | `MaterializedSubjectKind` 加 `'artifact'`（question_block 不加） |

---

## 7. ⑦ 测试矩阵 + 新表/迁移/常量登记

**新表/迁移**：**无新 pgTable**。fold-source 全走既有 `event` 表（新 action 值）。artifact 入 `materialized_id_index` 是写既有表新 subject_kind 值——**无 DDL**。故 `docs/.../reference_new_pgtable_registration_surfaces` 5 处登记**不触发**。需登记的是 RESERVED_EXPERIMENTAL_ACTIONS（新 action）+ KnownEvent 联合（新 schema）+ `MaterializedSubjectKind` 扩 `'artifact'`。

**测试矩阵**：

| 层 | 测试 | config |
|---|---|---|
| schema parse-barrier | 5 个新 action 路由到特化 schema（非 loose fallback）+ reserved-action 直拒；merged_into 字段不存在断言 | unit |
| fold reducer (artifact) | genesis/create/body_blocks_edit(full-snapshot)/note_refine_apply(replay,guard-off)/lifecycle 各分支；previous_body_blocks 不参与正向 fold；guard-off 仅 fold | unit |
| fold reducer (question_block) | create/rescue 覆写 last-write-wins；edit primary 重建 mergedTree；merged_source → ignored 且不写 merged_into；单 block edit 长度=1 | unit |
| B4 合流 | genesis 含 verified block → body_blocks_edit 覆盖无 guard 抛错；note_refine_apply 历史 op 命中后 verify 块不抛（guard off） | unit |
| gather (Q1+Q2) | question_block merged_source 经 jsonb @> 被 Q2 召回；fold==row | db |
| parity | `assertArtifactParity`/`assertQuestionBlockParity` dev-throws on drift；crop_refs rescue staleness 行经 create-event 重写后 parity 通过 | db |
| flip-guard anchor | `hasQuestionBlockGenesisAnchor` 命中 create-event（无 genesis seed 的新块）；artifact 经 index | db |
| per-entity flag | artifact flip ON 而 question_block OFF 时两 entity 写路径正交；retract 切换序错位被 parity 捕获 | db |
| backfill | backfill-genesis 为 artifact/question_block 写 seed 后全量 fold==row | db |

pre-flight：所有 edit 后跑全量 `pnpm typecheck` + biome + targeted（import 受影响文件的全部测试）；CI 是权威闸。

---

## 8. ⑧ 实施切片计划（按 PR，全部 `Refs YUK-471`）

| PR | 内容 | 依赖 | 独立性 |
|---|---|---|---|
| **W3-A1** | #2 BodyBlocksEdit + #3 ArtifactCreate + #4 ArtifactLifecycle 三 schema + parse-barrier 测试 + RESERVED_ACTIONS/KnownEvent 注册 | gated on Wave 2 落地（复用 genesis superRefine 脚手架） | 可与 A2 并行 |
| **W3-A2** | #5 EditQuestionBlockStructured + #6 QuestionBlockCreate 两 schema（含 AffectedBlockSnapshot，**无 merged_into**）+ parse-barrier 测试 | gated on Wave 2 | 可与 A1 并行 |
| **W3-B1** | `foldArtifact` reducer + ArtifactRowSnapshot + B4 note_refine_apply guard-off 分支 + 注释铁律 + unit 测试 | A1 | 串 A1 |
| **W3-B2** | `foldQuestionBlock` reducer + QuestionBlockRowSnapshot（crop_refs 纳入）+ merge 多行聚合 + unit | A2 | 串 A2，与 B1 并行 |
| **W3-C1** | 写路径事件化：body-blocks-edit.ts payload 扩 + 6 artifact INSERT 站点改 create-event；ingestion/rescue/docx 改 question_block_create | B1+B2 | 串 |
| **W3-C2** | gather.ts extend（artifact Q1 / question_block Q1+Q2 jsonb @>）+ MaterializedSubjectKind 扩 artifact + backfill-genesis 扩两 entity | C1 | 串 |
| **W3-C3** | parity assert（assertArtifact/assertQuestionBlock）+ flip-guard anchor（hasQuestionBlockGenesisAnchor 含 create-action）+ per-entity flag（projectionIsWriterArtifact/QuestionBlock）+ audit:projection 扩 + db 测试 | C2 | 串 |
| **W3-D** | （flip，非代码 PR）GATED cutover：rebuild prod-clone → audit per-entity CLEAN → set `PROJECTION_IS_WRITER_ARTIFACT=1`（先）→ restart → 验证 → 再 question_block | C3 + Wave 2 learning_item 已 flip 在 artifact 之后 | owner-gated |

全 scope 完才 `Closes YUK-471` 对应 W3 子单；各增量 PR 用 `Refs`。

---

## 9. ⑨ 残留需 owner 拍的设计分叉

1. **`GenerateArtifact` 是否最终也吸收 body_blocks**？本稿裁定保留 `generate`（业务意图/markdown body_md）与 `artifact_create`（fold-source/body_blocks）**双事件并存**。若 owner 要单事件收口，需把 `generate` 的 `failure` 分支与 create 的「仅成功落行」语义合并，schema 复杂度上升——本 wave 不做，标 owner 决策。

2. **`extracted_prompt_md` 何时 DROP**？parity 当前 `omit` 跳过该 legacy 列。DROP 由 legacy route 迁移完成驱动（§0 schema 注释指 Step 11.5），是独立于 W3 的 follow-up，建议落 Linear 单（如有 legacy ingestion route 仍写）。

3. **`applyRescue` crop_refs staleness 的旧数据**：事件化后新 rescue 自动修；但 backfill genesis 种的是**当前（可能 stale）**crop_refs 行 → fold==row 仍成立（一致地 stale）。是否在 backfill 时顺带「重算 crop_refs 写回」是一次性数据修复决策，与 fold 正确性正交，标 owner 决定要不要在 backfill PR 里附带 data-fix。

4. **artifact 是否真需要入 materialized_id_index**：本稿为 flip-guard 路径一致性选择写入，但 artifact 无 mint、Q2 冗余。若 owner 倾向「能不写就不写」，可让 artifact 也走 event 表直查 anchor（同 question_block），省 index 写——纯一致性 vs 最小化的取舍。

---

**Linear capture**：本设计修正本身不引入需立即建单的代码 follow-up（W3 切片即实施计划）；§9.2（extracted_prompt_md DROP）与 §9.3（crop_refs 历史数据修复）若 owner 确认要做，建议各开一条 `Refs YUK-471` 子单。其余皆 owner 决策点，无隐藏 follow-up。
