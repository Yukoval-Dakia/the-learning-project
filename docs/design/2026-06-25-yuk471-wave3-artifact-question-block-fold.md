# YUK-471 Wave 3 设计稿 — artifact + question_block 真 fold（ADR-0044「最难表」/ YUK-358 合流）

**Status**: Draft（待 owner 拍 §10 未决分叉）
**Date**: 2026-06-25
**Part of**: YUK-203 · YUK-363 epic · ADR-0044 §1/§2/§6 Wave 3
**真相源**: `docs/adr/0044-event-sourcing-foundation-redesign.md`
**合流**: ADR-0040 / YUK-358 笔记域 re-think（artifact 写契约不平行造两套）
**前置已 LIVE**: W1 `PROJECTION_IS_WRITER=1`（owner Mac，SoT flip 已生效，双写期已过）

---

## 0. 范围与铁律（落地前必读）

Wave 3 把两张表升级为 event-sourced（fold(events)==row 可验证 + materialized write-through）：

1. **`artifact`**（FK_ORDER 第 15 位，`constants.ts:129`）—— 14 个文档化写者，跨 notes/ingestion/orchestrator/proposals/ai-tools 五个 capability，ADR 标「写者数量最多」。
2. **`question_block.structured`**（FK_ORDER 第 8 位，`constants.ts:112`）—— `block-structured-edit.ts` 的编辑 op 只写 `job_events`，未进真相层。

**已 LIVE 的语义变化（关键）**：W1 SoT flip 已生效（`PROJECTION_IS_WRITER=1`）。Wave 3 接线时 **直接是 projection-as-writer**——不再有「双写期共存→flip」的两段切换。但 ADR-0044 §7 的「双写期即时 `fold==projection` 校验」仍是落地纪律：每个 PR 落地后，`pnpm audit:projection` 必须对新覆盖的表/字段 zero-drift，才允许把该表的写路径切到 reducer-apply。换言之，**「双写期」在 W3 退化为「PR 内的 audit gate」**，而非跨 PR 的运行期 flag 共存窗口。

**切换铁律**（ADR-0044 §7，FK 序：被依赖表先）：

```
question_block  →  artifact  →  artifact_block_ref(已 backed up，不在本 Wave fold 范围)
```

question_block 无 artifact FK 依赖（两者不互 FK，`constants.ts` 注释确认），且 question_block 在 FK_ORDER 更靠前，故 **question_block 先于 artifact 接线**。artifact 末位的三层理由（grounding p7 §8）：写者最多、与 YUK-358 写契约冲突面最大、FK 序要 knowledge/knowledge_edge 先稳（`artifact.knowledge_ids` loose ref）。

**沿用 W1 fold 模式，不发明新机制**（逐项映射见 §11）：
- 纯函数 reducer `src/core/projections/<table>.ts` + 共享 `fold-event.ts`（`FoldEvent` 扁平行，`(created_at asc, id asc)` 规范排序，完全从事件流重建，不读 projection 表）。
- genesis typed schema（`GenesisExperimental` 扩 `subject_kind`，三层校验 + superRefine）。
- 反查索引 `materialized_id_index`（PK O(1) 查；Codex #3 增量 fold 不能只用 `event_subject_idx`）。
- IO shell `src/server/projections/<table>.ts` + 共享 `gather.ts`（Q1 subject 直查 / Q2 反查 anchor / Q3 jsonb @>）。
- backfill `scripts/backfill-genesis-events.ts`（扩 SCOPED 扫描覆盖新表）。
- audit `pnpm audit:projection` + `scripts/b3-gate.ts`。
- 新表登记 5 处（本 Wave **不加新表**——artifact/question_block/materialized_id_index 都已在 FK_ORDER）。

---

## 1. Payload #2 — `BodyBlocksEdit`（artifact body_blocks 编辑）

**问题**（grounding p2 §1）：`editArtifactBodyBlocks`（`body-blocks-edit.ts:36`）的 event payload 只有 `{ artifact_id, previous_version, next_version }`（`:119-128`），action=`experimental:artifact_body_blocks_edit`。fold 从事件流无法重建 `body_blocks` 内容。

**决策：promote 出 experimental，新建 KnownEvent `BodyBlocksEdit`**（action=`body_blocks_edit`，subject_kind=`artifact`）。理由：ADR-0044 §Wave3「与 YUK-358 合流，不平行造两套 artifact 写契约」；body_blocks 编辑是稳定的核心写路径（非探索期），直接 promote 减少后续二次迁移。

```ts
// src/core/schema/event/known.ts （新增分支，加入 KnownEvent union）
export const BodyBlocksEdit = z.object({
  actor_kind: z.enum(['user', 'agent']),       // 手编=user(self)；AI refine 走自己的 action(见下)
  actor_ref: z.string().min(1),                // 'artifact_block_tree_editor' | NOTE_REFINE_ACCEPT_ACTOR ...
  action: z.literal('body_blocks_edit'),
  subject_kind: z.literal('artifact'),
  subject_id: z.string().min(1),               // artifact_id
  outcome: z.literal('success'),
  payload: z.object({
    previous_artifact_version: z.number().int().nonnegative(),
    next_artifact_version: z.number().int().nonnegative(),
    // ▼ P0 #2 核心：after 全量 body_blocks（fold 直接 full-snapshot 重建，不按 ops 推演）
    body_blocks: ArtifactBodyBlocks,                  // src/core/schema/business.ts:291
    // ▼ undo/revert restore 所需 before（mirror note-refine-apply.ts:194 的 previous_body_blocks）
    previous_body_blocks: ArtifactBodyBlocks.nullable(),  // null = 冷启首写
  }),
  ...baseOptionalFields,
});
```

**与 `note_refine_apply` 的关系（合流，不统一 action）**：grounding p2 §4 一度提议统一 action，本设计 **维持两个 action 分离**：
- `body_blocks_edit`（手编 + 人类 inbox accept）：full-snapshot fold（payload 直接带 after 全树）。
- `experimental:note_refine_apply`（AI 精炼 apply，`note-refine-apply.ts:182`）：保持现状，payload 已自足（`ops[]` + `previous_body_blocks`），是 reverse-patch undo 链。

理由：两者语义不同（一个 full-snapshot、一个 patch ops），fold reducer 对两个 action 都能产出 after-state（见 §6 reducer），统一 action 反而要在 payload 里塞判别式，更脆。`note_refine_apply` 已是稳定 reserved experimental（不在本 Wave promote 范围）。

**写路径改动**（`body-blocks-edit.ts:119`）：event payload 扩 `body_blocks`（从同 tx UPDATE 后的值）+ `previous_body_blocks`（从写前 SELECT 取，`body-blocks-edit.ts` 已 SELECT 旧行做乐观锁，复用即可）；action 从 `experimental:artifact_body_blocks_edit` 改 `body_blocks_edit`。

---

## 2. Payload #3+#4 — `GenerateArtifact` 扩字段 + 5 处创建归一

**现状 payload**（`known.ts:222-237`）只有 `artifact_kind/title/body_md/referenced_event_ids`——fold 无法重建 artifact 行。

**决策：扩 `GenerateArtifact.payload` 为 artifact-genesis 自足契约**，所有 AI 创建路径归一到它（`subject_kind='artifact'`, `subject_id=artifactId`, action=`generate`）。

```ts
// src/core/schema/event/known.ts — GenerateArtifact.payload 重定义
export const GenerateArtifact = z.object({
  actor_kind: z.enum(['agent', 'system']),     // system 容纳 ingestion import（make-paper）
  actor_ref: z.string(),
  action: z.literal('generate'),
  subject_kind: z.literal('artifact'),
  subject_id: z.string(),
  outcome: z.enum(['success', 'failure']),
  payload: z.object({
    // ── 行结构真相（fold 重建 artifact row 的 genesis 基线）──
    type: ArtifactType,                          // note_hub/note_atomic/note_long/tool_quiz/interactive
    title: z.string(),
    parent_artifact_id: z.string().nullable(),
    knowledge_ids: z.array(z.string()),
    intent_source: z.string(),                   // 9 值，上游 Zod 已校（宽 string）
    source: z.string(),                          // ai_generated/imported/ai_dream
    source_ref: z.string().nullable(),
    tool_kind: z.string().nullable(),            // tool_quiz 专用（quiz_gen/review_plan）
    tool_state: z.unknown().nullable(),          // paper 的 question_ids/sections，opaque
    attrs: z.record(z.string(), z.unknown()),    // interactive 的 html blob 也在此
    // ── 内容（hub/ready 有值；atomic/long stub 待 note_generate 填）──
    body_blocks: ArtifactBodyBlocks.nullable(),  // null = pending stub（冷启）
    // ── 初始生命周期状态（genesis 写出，#7 转移事件后续更新）──
    generation_status: ArtifactGenerationStatus, // 'pending' | 'ready' | 'failed'
    verification_status: ArtifactVerificationStatus,
    // ── 既有保留 ──
    referenced_event_ids: z.array(z.string()).optional(),
  }),
  ...baseOptionalFields,
});
```

**`artifact_kind` 枚举废弃**：现有 `['note','quiz','variant','summary']` 与 `artifact.type` 语义重叠且覆盖不足（缺 interactive），改用 `type: ArtifactType`（`business.ts` 已有枚举）。`body_md` 删除（被 `body_blocks` 取代）。

**5 处 AI 创建归一**（grounding p3p4 §5 + p7 §3）：

| # | 写点 | file:line | 改动 |
|---|---|---|---|
| D | hub | `learning_intent.ts:673` | `tx.insert(artifact)` 后追 `writeEvent(tx, GenerateArtifact{body_blocks=已有值, generation_status='ready'})` |
| E | atomic stub | `learning_intent.ts:708` | 同上，`body_blocks=null, generation_status='pending'` |
| F | long stub | `learning_intent.ts:733` | 同上，`body_blocks=null, generation_status='pending'` |
| G | dream applier | `legacy-record-appliers.ts:369` | `insert` 后追 `GenerateArtifact`（写在已有 RateEvent 之前，artifact 先存在再记 accept） |
| H | quiz_gen job | `quiz_gen.ts:683` | `insert` 后追 `GenerateArtifact{type='tool_quiz'}`；**保留** `experimental:quiz_gen`（job-level audit，subject_kind='query'，与 genesis 不互斥） |

**P0 #3 — `runNoteGenerate` 补 genesis-fill 转移**（`note_generate.ts:207`）：runNoteGenerate **不创建** artifact，只 UPDATE stub（pending→ready + 填 body_blocks）。它消费 E/F 的 pending stub。fold 视角：stub 的 genesis 由 D/E/F 的 `GenerateArtifact{generation_status='pending', body_blocks=null}` 写出；runNoteGenerate 同 tx 须补写 **状态转移 + 内容填充事件**（用 #7 的 `BodyBlocksEdit` + status-transition，见 §4），否则 fold 重建出的 artifact 永远停在 pending/body_blocks=null。

> **落地纪律**：runNoteGenerate 当前完全无 `writeEvent`（grounding p3p4 §3）。同 tx 需注入 `writeEvent` + `newId` 依赖。pending→ready 转移走 §4 的 status-transition event；body_blocks 填充走 §1 的 `BodyBlocksEdit`（previous_body_blocks=null，因 stub 原本是 null）。

**P0 #4 残留分叉 — `make-paper.ts:324`（import 路径）+ `author-artifact.ts:108` / `tool-quiz-core.ts:53`（mirror 链）**：见 §10 未决问题 Q1/Q2。

---

## 3. Payload #5+#6 — `EditQuestionBlockStructured`（job_events→canonical 迁移 + merge 多行 after）

**问题**（grounding p5p6 §2/#4）：`block-structured-edit.ts` 的 6 个 op（updatePrompt/addOption/setQuestionType/splitStem/mergeQuestions/reassignFigure）只写 `job_events`（`writeJobEvent`，`:143/:516/:523/:612`），**不写 canonical event**。merge 改 1+N 行（primary 树更新 + N 个 absorbed 块 `status='ignored'`，`:505-513`），但 `question_block` 表 **无 `merged_into` 列**——归属只反向存于 primary 的 `merged_from_block_ids`。

**决策：新建 KnownEvent `EditQuestionBlockStructured`**（action=`edit_structured`，subject_kind=`question_block`），覆盖 Codex #5（block 内容自足）+ #6（merge 多行 after）。

```ts
// src/core/schema/event/question-block.ts （新文件）
// 单块 after 快照（每条受影响 block 的完整状态，fold 直接 full-snapshot 重建）
export const AffectedBlockSnapshot = z.object({
  block_id: z.string().min(1),
  structured: StructuredQuestion.nullable(),       // StructuredQuestion 树，after
  figures: z.array(FigureRef),
  page_spans: z.array(PageSpanSchema),
  status: z.enum(['draft', 'ignored']),            // merge 后 absorbed = 'ignored'
  merged_from_block_ids: z.array(z.string()),       // primary 的 merge 归属（反向）
  version: z.number().int().nonnegative(),
  role: z.enum(['primary', 'absorbed']),           // merge 区分；非 merge op 恒 'primary'
  merged_into_block_id: z.string().nullable(),     // absorbed 块指向 primary（fold 重建归属）
});

export const EditQuestionBlockStructured = z.object({
  actor_kind: z.enum(['agent', 'user', 'system']),
  actor_ref: z.string(),
  action: z.literal('edit_structured'),
  subject_kind: z.literal('question_block'),
  subject_id: z.string().min(1),                   // = primary block id
  outcome: z.enum(['success', 'failure']),
  payload: z.object({
    op: z.enum(['update_prompt', 'add_option', 'set_question_type',
                'split_stem', 'merge_questions', 'reassign_figure']),
    // ▼ Codex #6：所有受影响块的 after 快照（merge 覆盖 primary + 全部 absorbed）
    affected_blocks: z.array(AffectedBlockSnapshot).min(1),  // [0] = primary
    // op 元数据（可选）
    node_id: z.string().optional(),                  // update_prompt/add_option/set_type/split
    asset_id: z.string().optional(),                 // reassign_figure
    attached_to_index: z.string().optional(),
  }),
  ...baseOptionalFields,
});
```

**写路径改动**（`block-structured-edit.ts`）：6 个 op 在 `writeJobEvent` 之后 **额外** `writeEvent(tx, EditQuestionBlockStructured)`（job_events 保留做 SSE 传输层，二者不互斥——ADR §7 job_events 不在真相层，但仍是 SSE 增量流）。`persistStructured`（`:139`）的 5 个 single-block op → `affected_blocks=[primary after]`。`mergeQuestions`（`:413`）→ `affected_blocks=[primary after(merged_from_block_ids 已含 mergeIds), ...absorbed(status='ignored', role='absorbed', merged_into_block_id=primaryBlockId)]`。

---

## 4. Payload #7 — artifact lifecycle status 转移 event（P1，可 defer，见 §8/§10-Q3）

**问题**（grounding p7 §2/§3）：`generation_status`（pending/ready/failed）+ `verification_status`（6 态）+ `archived_at`（软删）转移多数无事件。fold 若缺转移事件，重建出的 artifact 永远停在 genesis 写出的初值。

**决策：新建 reserved experimental `experimental:artifact_status`**（先走 experimental，非立即 promote——P1 优先级 + 探索期）。加入 `RESERVED_EXPERIMENTAL_ACTIONS`，新建专用 schema（不降为通用 fallback，与 state_snapshot/genesis 同等待遇）。

```ts
// src/core/schema/event/artifact-status.ts （新文件，reserved experimental）
export const ArtifactStatusExperimental = z.object({
  actor_kind: z.enum(['agent', 'system']),
  actor_ref: z.string().min(1),                    // 'note_generate' | 'note_verify' | 'retract_proposal'
  action: z.literal('experimental:artifact_status'),
  subject_kind: z.literal('artifact'),
  subject_id: z.string().min(1),
  outcome: z.enum(['success', 'failure']),
  payload: z.object({
    field: z.enum(['generation_status', 'verification_status', 'archived_at']),
    before: z.string().nullable(),                 // 前态（archived_at 走 ISO string）
    after: z.string().nullable(),
    reason: z.string().optional(),                 // failed 时有意义
  }),
  caused_by_event_id: z.string().optional(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
```

**转移补点**（按 fold 重要性）：
1. `note_generate.ts:212` pending→ready（同 tx，配合 §2 P0#3 的 body_blocks 填充）。
2. `note_generate.ts:242` pending→failed（catch 块，best-effort）。
3. `note_verify.ts:163` →verified/needs_review（**复用现有 `experimental:note_verify` event**，在其 payload 加 before/after 字段，不另写——避免重复，grounding p7 §4③）。
4. `note_verify.ts:340` →failed（同上）。
5. `actions.ts:1028-1034` `retractAiProposal` 的 `archived_at` 写（同 tx，挂在已有 `correct` event 下游）。

**defer 边界**（grounding p7 §6）：若 Wave 3 双写期 audit **只覆盖 artifact 的结构字段**（type/title/knowledge_ids/body_blocks/attrs/parent_artifact_id），把 generation_status/verification_status 排除在 `audit:projection` 对比范围外（在 reducer + audit allowlist 显式注明 deferred），则 #7 可推迟到 Wave 3.5。**但 archived_at（软删）不可 defer**——它是读路径标准 WHERE（`isNull(artifact.archived_at)`），fold 漏它会让被删 artifact 复活。决策见 §10-Q3。

---

## 5. RowSnapshot 设计（artifact + question_block）

### 5.1 `ArtifactRowSnapshot`（`src/core/schema/event/genesis.ts` 扩 / 或独立 artifact-genesis.ts）

artifact 表 **无 embedding/cache 衍生列**（`schema.ts:422-445`，grounding fold §1）——`body_blocks`/`attrs.html`/`tool_state`/`history` 都是内容真相，**不可排除**。RowSnapshot = 全列子集：

```ts
export const ArtifactRowSnapshot = z.object({
  id: z.string().min(1),
  type: ArtifactType,
  title: z.string(),
  parent_artifact_id: z.string().nullable(),
  knowledge_ids: z.array(z.string()),
  intent_source: z.string(),
  source: z.string(),
  source_ref: z.string().nullable(),
  body_blocks: z.unknown().nullable(),             // TipTap jsonb, opaque to fold
  attrs: z.record(z.string(), z.unknown()),
  tool_kind: z.string().nullable(),
  tool_state: z.unknown().nullable(),
  generation_status: ArtifactGenerationStatus,
  verification_status: ArtifactVerificationStatus,
  verification_summary: z.unknown().nullable(),
  generated_by: z.record(z.string(), z.unknown()).nullable(),
  verified_by: z.record(z.string(), z.unknown()).nullable(),
  history: z.array(z.unknown()),                   // ArtifactHistoryEntry[], opaque
  archived_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  version: z.number().int(),
});
```

### 5.2 `QuestionBlockRowSnapshot`

唯一可排除的衍生列 = **`crop_refs`**（`ingestion.ts:246` = `figures.map(f=>f.asset_id)` 的纯投影，类比 knowledge 的 `embed_content_hash` 被排除，grounding fold §7）。其余全 fold 真相。`extracted_prompt_md` 是 deprecated 但仍写的列（DROP 推迟 Step 11.5，`schema.ts:176-180`），保留进 snapshot。

```ts
export const QuestionBlockRowSnapshot = z.object({
  id: z.string().min(1),
  ingestion_session_id: z.string(),
  source_document_id: z.string().nullable(),
  source_asset_ids: z.array(z.string()),
  page_spans: z.array(z.unknown()),
  extracted_prompt_md: z.string().nullable(),       // deprecated 列，保留至 Step 11.5
  structured: z.unknown().nullable(),
  figures: z.array(z.unknown()),
  // crop_refs EXCLUDED — figures.map(f=>f.asset_id) 派生，IO shell write-through 时重算
  layout_quality: z.string(),
  reference_md: z.string().nullable(),
  wrong_answer_md: z.string().nullable(),
  image_refs: z.array(z.string()),
  visual_complexity: z.string(),
  extraction_confidence: z.number(),
  status: z.string(),
  knowledge_hint: z.string().nullable(),
  merged_from_block_ids: z.array(z.string()),
  imported_question_id: z.string().nullable(),
  imported_attempt_event_id: z.string().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  version: z.number().int(),
});
```

> **crop_refs 落地纪律**：RowSnapshot 排除 crop_refs，但 IO shell write-through（`src/server/projections/question_block.ts`）upsert 时须从 reducer 输出的 `figures` 重算 `crop_refs = figures.map(f=>f.asset_id)` 再写表（否则 audit:projection 会把 crop_refs 列当 drift）。在 IO shell（非纯 reducer）做派生，与 W1「embed_* 在维护 job 派生、不在 fold」同构。

---

## 6. Fold reducer 聚合策略（重点解 Codex #5 + #6）

### 6.1 `foldArtifact`（`src/core/projections/artifact.ts`）

**type-dispatch 入口**（合流冲突面 6，grounding 358 §合流建议1）：reducer 第一步按 artifact.type 路由分支语义（非 type error，是语义分支）：
- `note_hub/note_atomic/note_long` → body_blocks fold（消费 `generate`/`body_blocks_edit`/`note_refine_apply`/`correct`/`suppress` + status events）。
- `interactive/tool_quiz` → attrs/html fold（genesis 的 attrs + `update_artifact` 的 mirror 链 / `experimental:quiz_gen`）。

**事件分支**（全部 full-snapshot 或 ops-replay，apply 顺序 `(created_at asc, id asc)`）：

| action | 来源 | reducer 行为 |
|---|---|---|
| `generate`（GenerateArtifact）| §2 | genesis 基线：从 payload 重建整行（type/title/knowledge_ids/intent_source/source/attrs/body_blocks/generation_status/...），version=0 |
| `experimental:genesis`（subject_kind='artifact'）| backfill seed | 同 W1：payload.row 即 base state，version/timestamps 全 verbatim |
| `body_blocks_edit`（BodyBlocksEdit）| §1 | full-snapshot：row.body_blocks=payload.body_blocks，version=payload.next_artifact_version，updated_at=event.created_at |
| `experimental:note_refine_apply` | 现有 | **replay ops**（`applyNotePatch`，`enforceUserVerifiedGuard: false` —— 见合流冲突面5）或直读 payload after；version+1 |
| `correct`（CorrectArtifactEvent）| 现有 | block-grained correction（whole-artifact / block_id 级） |
| `suppress`（SuppressArtifactLink）| 现有 | attrs.suppressed_block_refs 追加 |
| `experimental:artifact_status` | §4 | field 路由：generation_status/verification_status/archived_at 改对应字段 |

**合流红线（必须守，grounding 358 §合流冲突面5）**：fold 重放 `note_refine_apply` ops 时 **必须** `enforceUserVerifiedGuard: false`。理由：guard 在 `apply-note-patch.ts:125-146` 防 AI 在线 mutator 误覆盖 verified 块；fold 是回放历史、非在线 AI 写入。若历史 op 当时 targeting 未 verified 的块、但 fold 重放时该块已被后续事件 verify，guard 会抛 `user_verified_protected` 致 fold 失败。reducer 注释须显式标「fold-only 重建路径，非在线 AI 写入；勿借此 options 绕在线写守卫」。

### 6.2 `foldQuestionBlock`（`src/core/projections/question_block.ts`）

**Codex #5 — 新 OCR block genesis**（核心难点）：`extract` event（`ExtractSourceDocument`, subject_kind='source_document'）只存 `structured_block_ids[]`（`known.ts:453`），真实 structured/figures/page_spans 在 `applyExtractionResult`（`ingestion.ts:280`）直插表。从 extract event **无法重建 block 内容**。

> **决策（方案 A3）：扩 `GenesisExperimental.subject_kind` 加 `'question_block'` + 新增 `QuestionBlockRowSnapshot`**，在 `applyExtractionResult` 为每个新 block **同步**写一条 `experimental:genesis(subject_kind='question_block')` 事件（payload.row = 完整 block snapshot）。
>
> 否决方案 A1（扩 `ExtractSourceDocument.payload` 加 `blocks_content`）：是 KnownEvent 破坏性变更，所有历史 extract event 需 backfill 或 fold fallback，且 extract event subject 是 source_document 非 question_block，fold question_block 时还要跨 subject join。A3 与 W1 knowledge/edge genesis 模式完全同构（每行一条 genesis seed），fold 只查 `subject_kind='question_block'` 即自足。
>
> **不止迁移当下**（Codex #5 显式要求）：A3 的 genesis 写在 `applyExtractionResult` 内（每个新 block 同步写），**不是只 backfill 历史**——切换后新 OCR 产生的 block 也立即有 genesis seed。历史行（pre-W3）由 backfill 脚本补一次。

**genesis schema 扩展**（`genesis.ts`）：

```ts
// GenesisExperimental.subject_kind 扩为 3 值
subject_kind: z.enum(['knowledge', 'knowledge_edge', 'question_block']),
payload: z.object({
  row: z.union([KnowledgeRowSnapshot, KnowledgeEdgeRowSnapshot, QuestionBlockRowSnapshot]),
}),
// superRefine 扩判别：question_block row 用 'ingestion_session_id' in row 区分
// （knowledge 无此字段、edge 用 from_knowledge_id 区分）；subject_id===row.id 不变
```

**Codex #6 — merge_questions 多行 after**（核心难点）：merge 事件的 `subject_id`=primary block id，但 absorbed block 的状态变更（`status='ignored'`）只在 `affected_blocks[]` 里。fold reducer 必须能从单事件重建所有受影响块：

- reducer 签名接收 `(blockId, events)`，对每条 `edit_structured` 事件遍历 `payload.affected_blocks`，找 `block_id===blockId` 的条目应用其 after 快照（structured/figures/status/merged_from_block_ids/version）。
- absorbed 块（`role='absorbed'`）的 `status='ignored'` + `merged_into_block_id` 写入 row——这样被合并块在 fold 下不再像 draft，不会被重复导入/编辑。

**Codex #6 的 gather 反查（对应 #3 的 question_block 版本）**：absorbed block 的 `block_id` **不会**作为 `(subject_kind='question_block', subject_id=<absorbed_id>)` 出现在 event 主索引（merge 事件 subject_id 是 primary）。增量 fold 不能只按 subject_id 拉历史。两条路：
- **gather Q3（jsonb @> 反查，沿用 W1 knowledge merge 的 Q3 模式）**：`SELECT events WHERE action='edit_structured' AND payload->'affected_blocks' @> [{block_id: <absorbed_id>}]`。这是 W1 `gather.ts:106` knowledge merge Q3（`payload->'from_ids' @> [nodeId]`）的直接类比，**无需额外索引**。
- 否决「materialized_id_index 反查」：question_block 无 propose→rate→accept 路径（无 minted id），absorbed block id 是上游 OCR/import 生成的真实 id（有自己的 genesis seed），不是 accept 时 mint 的——故走 jsonb @> 而非 materialized_id_index。

**gather 策略汇总**（`gather.ts` 扩）：

| 表 | Q1（subject 直查）| Q2（反查 anchor）| Q3（jsonb @>）|
|---|---|---|---|
| artifact | `subject_kind='artifact' AND subject_id=id`（覆盖 generate/genesis/body_blocks_edit/note_refine_apply/correct/suppress/status）| `materialized_id_index` 反查 genesis_event_id（**仅 pre-W3 backfill seed**；artifact 无 propose 路径，主要用于 backfill seed 寻址）| 无（artifact 无跨实体 merge）|
| question_block | `subject_kind='question_block' AND subject_id=id`（覆盖 genesis + edit_structured-as-primary）| 无（无 propose→rate 路径）| `edit_structured` 且 `affected_blocks @> [{block_id:id}]`（absorbed 块的 merge 事件）|

---

## 7. genesis backfill + 切换序

**backfill 扩 `scripts/backfill-genesis-events.ts`**（grounding：SCOPED 扫无 genesis anchor 的行→构造 `experimental:genesis` 事件 + index 行，原子 tx，ingest_at opt-out 跳 memory outbox，幂等）。Wave 3 新增两个 SCOPED 段：

- **artifact**：扫无 genesis anchor 的 artifact 行 → 写 `experimental:genesis(subject_kind='artifact', payload.row=ArtifactRowSnapshot)` + materialized_id_index 行（subject_kind='artifact'）。
- **question_block**：扫无 genesis anchor 的 question_block 行 → 写 `experimental:genesis(subject_kind='question_block', payload.row=QuestionBlockRowSnapshot)`。**注意**：question_block 无 materialized_id_index 反查需求（gather 走 Q1 直查 + Q3 jsonb @>），故 backfill **不**为 question_block 写 index 行（仅 artifact 写——artifact 的 Q2 backfill seed 寻址需要）。

> **MaterializedSubjectKind 扩展**（`materialized-id-index.ts:24`）：当前 `'knowledge' | 'knowledge_edge'`，artifact backfill 需扩为加 `'artifact'`。但 question_block **不入** index（见上）。

**切换序**（FK 序，被依赖表先；本 Wave 无新表，故是「写路径接线序」非 DDL 序）：

```
1. question_block.structured 接线（FK_ORDER 第 8 位，更靠前；无 artifact 依赖）
   → genesis seed 在 applyExtractionResult 同步写 + backfill 历史
   → block-structured-edit 6 op 补 writeEvent
   → audit:projection question_block zero-drift → 切 reducer-apply
2. artifact 接线（FK_ORDER 第 15 位，末位；依赖 knowledge/knowledge_edge 已稳）
   → 5 处创建归一 GenerateArtifact + backfill 历史
   → body_blocks_edit promote + status 转移（或 defer #7）
   → audit:projection artifact zero-drift → 切 reducer-apply
```

---

## 8. 实施切片（按 PR，标 P0/P1）

| PR | 范围 | 优先级 | 依赖 | gate |
|---|---|---|---|---|
| **W3-A1** | `EditQuestionBlockStructured` schema + `QuestionBlockRowSnapshot` + genesis subject_kind 扩 question_block（纯 schema，未接线，仿 W1 PR-A1 behavior-preserving）| P0 | — | typecheck + schema 单测 |
| **W3-A2** | `foldQuestionBlock` 纯 reducer（解 #5 genesis dispatch + #6 merge multi-row）+ reducer 单测（fold(events)==row 黄金用例）| P0 | A1 | unit |
| **W3-A3** | IO shell `src/server/projections/question_block.ts` + gather Q1/Q3 扩 + crop_refs write-through 派生；`applyExtractionResult` 同步写 genesis seed；6 op 补 `writeEvent`；backfill 扩 question_block 段 | P0 | A2 | db + audit:projection(question_block) |
| **W3-A4** | question_block 切 reducer-apply（写路径接 projection-as-writer）+ b3-gate question_block GO | P0 | A3 | b3-gate |
| **W3-B1** | `BodyBlocksEdit`（#2 promote）+ `GenerateArtifact` 扩字段（#4）+ `ArtifactRowSnapshot` + genesis subject_kind 扩 artifact（纯 schema）| P0 | — | typecheck + schema 单测 |
| **W3-B2** | `foldArtifact` 纯 reducer（type-dispatch + note_refine_apply replay w/ guard off）+ 单测 | P0 | B1 | unit |
| **W3-B3** | IO shell `src/server/projections/artifact.ts` + gather Q1/Q2 扩 + materialized_id_index 扩 'artifact'；5 处创建归一 writeEvent；body-blocks-edit payload 扩；backfill 扩 artifact 段 | P0 | B2, A4(FK 序) | db + audit:projection(artifact, **#7 字段 deferred**) |
| **W3-B4** | artifact 切 reducer-apply + b3-gate artifact GO | P0 | B3 | b3-gate |
| **W3-C1** | `experimental:artifact_status`（#7）schema + RESERVED 注册 + 5 转移补点 + audit:projection 纳入 generation/verification_status；archived_at fold | **P1（可 defer 到 W3.5；archived_at 部分见 §10-Q3 不可全 defer）** | B4 | db + audit:projection 全字段 |

> **#7 defer 的精确边界**：B3 的 audit:projection 在 artifact 上**排除** generation_status/verification_status（allowlist 显式标 deferred-to-C1），但 **archived_at 不排除**（软删读路径硬依赖）。C1 落地后移除 allowlist 排除项，audit 转全字段。若 owner 选 §10-Q3 的「archived_at 也 defer」，则 B4 不能完成 artifact 真 SoT（保留命令式 archived_at 写 + 双轨），需在 C1 完成后才切——这把 artifact 真 fold 推迟到 C1，违背「artifact 末位但本 Wave 内完成」的意图。**推荐：archived_at 纳入 B 系列（不 defer），仅 generation/verification_status defer 到 C1。**

---

## 9. 测试矩阵

| 层 | 文件 | 断言要点 |
|---|---|---|
| reducer 单测 | `src/core/projections/question_block.test.ts` | genesis seed→row；6 op full-snapshot；**merge：primary after + N absorbed status='ignored'**（#6）；fold(events)==row determinism；malformed event skip+warn |
| reducer 单测 | `src/core/projections/artifact.test.ts` | type-dispatch（note vs interactive vs tool_quiz）；generate genesis→row；body_blocks_edit full-snapshot；**note_refine_apply replay 时 verified 块不被 guard 拒**（合流红线，guard off）；correct/suppress/status 分支 |
| schema 单测 | `src/core/schema/event/question-block.test.ts` | EditQuestionBlockStructured parse barrier；affected_blocks.min(1)；genesis subject_kind='question_block' superRefine（row 形状↔subject_kind，subject_id===row.id）|
| IO shell db | `src/server/projections/question_block.db.test.ts` | gather Q1+Q3（absorbed jsonb @>）；crop_refs write-through 派生；applyExtractionResult 同步 genesis seed |
| IO shell db | `src/server/projections/artifact.db.test.ts` | gather Q1+Q2（materialized_id_index backfill seed 寻址）；5 处创建归一各写出 GenerateArtifact |
| parity db | `src/server/projections/parity.db.test.ts`（扩）| accept-time / edit-time fold==projection 即时校验 |
| audit db | `src/server/projections/audit-projection.db.test.ts`（扩）| 全量 fold diff vs 现表 zero-drift（artifact #7 字段在 C1 前 allowlisted）|
| 合流回归 | `src/capabilities/notes/embedded-check-purge.unit.test.ts`（已存在，不回退）+ note_verify advisory 不写 proposal（`note_verify.db.test.ts:253`，YUK-358 红线不破）| fold 接线不复活孤儿链 / proposal |
| migration | 无 DDL 变更（artifact/question_block/materialized_id_index 列均已存在；`merged_into` 经 event payload 表达不入表）| `pnpm test:migration` 无新 migration |
| backup 回归 | `src/server/export/reverse_lockstep.db.test.ts` | 无新表 → SCHEMA_VERSION/FK_ORDER **不 bump**（本 Wave 无 DDL）|

**pre-PR 全量 gate**（每个 lane PR）：`pnpm typecheck` + `pnpm lint` + `pnpm audit:schema`（structured/body_blocks 新增 event-sourced write path，可能需更 `audit-schema-allowlist.json`）+ `pnpm audit:partition` + `pnpm audit:projection` + `pnpm test` + `pnpm build`。

---

## 10. 风险与未决问题（需 owner 拍的设计分叉）

**Q1 — `make-paper.ts:324` import 路径是否走 GenerateArtifact？**
import（`source='imported'`）非 AI 生成。选项：(a) 复用 `GenerateArtifact{actor_kind='system', source='imported'}`（统一契约，schema 已含 system）；(b) 单独 `experimental:import` event（语义区分 import vs generate）。**推荐 (a)**——fold reducer 不需多一个分支，actor_kind='system' 已表达来源。但 ADR Codex #4 提到「genesis/import 用 experimental: 前缀」——若 owner 要 import 独立审计，走 (b) 的 `experimental:import`。

**Q2 — `author-artifact.ts:108` / `tool-quiz-core.ts:53`（mirror 链 artifact）如何 genesis？**
这两路靠 `mirrorEvent='when_causal'` 写 `ToolUseQuery`（subject_kind='query'，非 artifact），fold artifact 无法直接消费（grounding p3p4 §4，ADR L58 标 🟡）。选项：(a) `executeAuthorArtifact`/`writeToolQuizArtifact` 调用方补写 `GenerateArtifact`（+ 决定 mirrorEvent 是否降为 'never' 避免双写，或共存——GenerateArtifact 是 projection 锚，ToolUseQuery 携完整 HTML args 是 rollback 链）；(b) 保持现状，fold 从 ToolUseQuery args 链 recover（reducer 加 mirror-event 分支，文档化）。**推荐 (a) 共存**：GenerateArtifact 写结构基线（含 attrs.html 快照），ToolUseQuery 保留做级联 revert 的 args 链。需 owner 确认是否接受 interactive/tool_quiz 的 attrs.html 大 blob 进 GenerateArtifact payload（事件行体积）。

**Q3 — #7（status 转移）defer 到什么程度？**
§4/§8 已分析：generation_status/verification_status 可 defer 到 C1（B 系列 audit 排除）；**archived_at 不建议 defer**（软删读路径硬依赖，漏它复活被删 artifact）。owner 拍：(a) archived_at 纳入 B 系列（推荐，artifact 本 Wave 内真 fold）；(b) 全 status 字段 defer，artifact 真 SoT 推到 C1（artifact 末位再延后）。

**Q4 — `note_refine_apply` fold：replay ops vs 直读 snapshot？**
payload 同时有 `ops[]` 和 `previous_body_blocks`（after 可由 ops 推或直存）。replay ops（`applyNotePatch` 纯函数）更干净但须 guard off（合流红线）；直读 after-snapshot 更简单但 payload 当前无 after 全树（只有 previous）。**推荐 replay ops**（payload 已自足，guard off 已有 `ApplyNotePatchOptions` 接口）。若 owner 要 full-snapshot 一致性，需在 note_refine_apply payload 也加 after 全树（与 #2 对称）——本设计未要求，留分叉。

**Q5 — `BodyBlocksEdit` 事件行体积**（grounding 358 §合流建议2）：每次 body_blocks 编辑 event 携 after + before 全树（两份 TipTap doc），事件行体积大。选项：(a) 接受（artifact 编辑频率低）；(b) genesis 锚 + 增量 patch（更省但 fold 要推演）。**推荐 (a)**——artifact 编辑非高频，full-snapshot fold 最简单可验。

---

## 11. W1 模式逐项映射（沿用确认，不发明新机制）

| W1 已建 | Wave 3 复用 |
|---|---|
| `fold-event.ts` FoldEvent（`:33`）| 原样复用，两表 reducer 同消费 |
| `foldKnowledgeNode`（`knowledge.ts:101`）pass1 accept-index + pass2 ordered apply + `toParseInput`/`byCreatedThenId` | foldArtifact/foldQuestionBlock 同结构（artifact 走 generate-genesis 非 propose-accept；question_block 走 genesis + edit_structured）|
| `GenesisExperimental`（`genesis.ts:93`）三层校验 + superRefine | 扩 subject_kind 加 'artifact'+'question_block'；扩 row union；扩 superRefine 判别 |
| `materialized_id_index`（`materialized-id-index.ts`）PK O(1) 反查 | artifact 扩 subject_kind 'artifact'（backfill seed 寻址）；question_block 不入（走 jsonb @>）|
| `gather.ts` Q1/Q2/Q3（`:80`）| artifact: Q1+Q2；question_block: Q1+Q3（absorbed jsonb @>，类比 knowledge merge Q3 `:106`）|
| `scripts/backfill-genesis-events.ts` SCOPED + ingest_at opt-out + 幂等 | 扩 artifact + question_block 两段 |
| `pnpm audit:projection`（`audit-projection.ts`）+ `b3-gate.ts` | 扩两表（artifact #7 字段 allowlist deferred）|
| 新表登记 5 处 | **本 Wave 无新表**（artifact/question_block/materialized_id_index 均在 FK_ORDER；SCHEMA_VERSION/FK_ORDER 不 bump）|
| SoT flip LIVE（`PROJECTION_IS_WRITER=1`）| 接线即 projection-as-writer；「双写期」退化为 PR 内 audit:projection gate |

---

## 12. 结论

- **新增 schema 文件**：`src/core/schema/event/question-block.ts`（EditQuestionBlockStructured + AffectedBlockSnapshot + QuestionBlockRowSnapshot）、`src/core/schema/event/artifact-status.ts`（#7，可 defer）。
- **修改 schema**：`known.ts`（BodyBlocksEdit + GenerateArtifact 扩字段 + ArtifactRowSnapshot 或并入 genesis.ts；加入 KnownEvent union）、`genesis.ts`（subject_kind 扩 3 值 + row union + superRefine）、`experimental.ts`（RESERVED 加 `experimental:artifact_status`）、`event/index.ts`（Event union 加 ArtifactStatusExperimental）。
- **新增 reducer + IO shell**：`src/core/projections/{artifact,question_block}.ts` + `src/server/projections/{artifact,question_block}.ts` + `gather.ts` 扩。
- **写路径接线**：`body-blocks-edit.ts`（#2 + 6 op writeEvent）、`learning_intent.ts`×3 + `legacy-record-appliers.ts` + `quiz_gen.ts`（#4 归一）、`note_generate.ts`（#3 + 填充转移）、`ingestion.ts:applyExtractionResult`（#5 同步 genesis seed）、`note_verify.ts` + `actions.ts`（#7 转移）。
- **YUK-358 合流红线**：fold 重放 `note_refine_apply` 必须 `enforceUserVerifiedGuard: false`（fold-only，非在线写）；type-dispatch 跳过 opaque 类型（语义分支非 error）；advisory note_verify 不复活 proposal；embedded-check 孤儿链不复活。
- **owner 待拍**：§10 Q1（import 路径 event）、Q2（mirror 链 artifact genesis）、Q3（#7 defer 边界，archived_at 不建议 defer）、Q4（refine replay vs snapshot）、Q5（事件行体积）。
