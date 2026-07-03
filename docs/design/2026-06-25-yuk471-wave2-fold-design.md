# YUK-471 Wave 2 — Fold + Genesis Backfill 设计稿 (goal / mistake_variant / learning_item)

I have full grounding. The `MaterializedSubjectKind` type (line 31) is the W1 union that needs extension, and `subject_kind` is a free `text` column (no DB enum), so no migration is needed on `materialized_id_index` itself — only the TS union. I now have everything needed to produce the design doc.

---

# YUK-471 Wave 2 — Fold + Genesis Backfill 设计稿（goal / mistake_variant / learning_item）

Refs YUK-471 · 真相源 ADR-0044 · 沿用 W1 fold 模式（不发明新机制）· SoT flip 已 LIVE（`PROJECTION_IS_WRITER=1`）

## 0. 三实体共性结论（先定调，避免每节重复）

W1 的 knowledge/knowledge_edge 有一个本质难点：`propose_new`/`split` 铸造的节点 id **不等于** propose event 的 `subject_id`（minted id 藏在 accept rate 的 `payload.materialized_ids` 里），所以 gather 必须经 `materialized_id_index` 反查（Q2）。

**W2 三实体全部没有这个难点**——它们的行 id 始终 `== event.subject_id`（goal 的 proposal `target.subject_id`、mistake_variant 的 `proposal_event_id` 锚 + `createId()` 预生成、learning_item 的 genesis subject_id）。因此：

- **三实体的 fold gather 主路径是 Q1（subject 直查）+ caused_by 链（rate/correct/verify），不需要 Q2 materialized_id 反查来「找 id」。**
- **`materialized_id_index` 仍要为三实体写入**，但只用于一个目的：SoT-flip guard 的「该行有没有 genesis anchor」O(1) 判定（镜 W1 `hasKnowledgeNodeGenesisAnchor`，`src/server/projections/parity.ts:124`）。Codex 硬要求 #3 的「minted id != subject_id」反查场景在 W2 不存在——但 index 写入本身仍是 backfill 的标准产物 + flip-guard 依赖，不能省。
- 三实体都是**弱事件溯源实体**：很多 status 变更目前是裸命令式 UPDATE，无对应事件。W2 必须为这些变更补写 `experimental:*` 专属动作事件，否则 `fold(events) != row`。这是 W2 比 W1 多出来的核心工作量（W1 的 knowledge 变更已全部事件化）。

共享改动锚点（三实体复用，只列一次）：
- Genesis schema：`src/core/schema/event/genesis.ts:98` 的 `subject_kind` 枚举 + line 106 的 `payload.row` union + line 113 的 superRefine。
- materialized_id_index TS union：`src/server/projections/materialized-id-index.ts:31` `MaterializedSubjectKind`（**无 migration**——DB 列是裸 `text`，schema.ts:794）。
- backfill 脚本：`scripts/backfill-genesis-events.ts`（加三个 `backfill<Entity>Genesis` + 编排进 `backfillGenesisEvents`，FK 序）。
- 纯 reducer：新建 `src/core/projections/{goal,mistake_variant,learning_item}.ts`（镜 `src/core/projections/knowledge.ts`）。
- IO shell：新建 `src/server/projections/{goal,mistake_variant,learning_item}.ts` + gather helpers 进 `src/server/projections/gather.ts`（镜既有 `gatherAndFoldKnowledgeNode`，gather.ts:80）。
- 审计：`scripts/audit-projection.ts`（加三实体全表 fold-diff 段）。

---

## 1. goal

### ① GoalRowSnapshot（全列，无排除）

goal 表无任何衍生维护态列（无 embed_*），全列即 snapshot。镜 `KnowledgeRowSnapshot`（genesis.ts:40）：

```
id, title, subject_id(nullable), scope_knowledge_ids(string[]),
sequence_hint(int), status(enum active|dormant|done), source, source_ref(nullable),
created_at, updated_at, version(int)
```

排除：无。理由：goal schema（schema.ts:1177-1206）每列都是 fold 真相。`version` 进 snapshot（与 knowledge 一致），fold==row 比对时由 `diffSnapshots`（snapshot-diff.ts）统一处理；retract 路径不 bump version 的 inconsistency 见接线点 ⑥。

### ② GenesisExperimental.subject_kind 扩展

加 `'goal'`。superRefine 需扩展行-shape 判别：当前用 `'from_knowledge_id' in row` 区分 edge（genesis.ts:120）。新增三实体后 union 成五成员，**plain union 的歧义风险**——goal/learning_item 都有 `title`+`status`，mistake_variant 有 `parent_question_id`。建议：superRefine 不再用「字段嗅探」，改为 **per-subject_kind 显式 `safeParse(SpecificSnapshot)`**（`subject_kind==='goal'` → 必须 `GoalRowSnapshot.safeParse` 成功），更鲁棒且与 reducer 内的 `safeParse` 一致。subject_id===row.id 检查保留。

### ③ fold reducer 事件聚合策略

goal 是「以自身 subject_kind='goal' 事件 + caused_by 链」重建：

| 事件 | action / subject_kind | fold 效果 |
|---|---|---|
| 种子 | `experimental:genesis` / `goal` | 初始化 RowSnapshot（全列 verbatim，含 version） |
| 提案（仅 proposal 路径有） | `experimental:proposal` / `goal`（scope.ts:97-117） | 读 `proposed_change` 提供 title/subject_id/scope/hint 初值（但 backfill 后 genesis 才是权威，见 ⑤） |
| 接受 | `rate` / `event`，`caused_by_event_id`=proposeId，`payload.rating='accept'`，`payload.materialized_goal_id`=goalId（accept.ts:116-131） | status→active，确认 goalId，stamp 行时间=rate.created_at |
| 撤回 | `correct` / `event`，`caused_by_event_id`=proposeId，`payload.correction_kind='retract'`（actions.ts:1037-1048） | status→dormant，updated_at=correct.created_at |
| **W2 新增** status 变更 | `experimental:goal_status_update` / `goal` | status→done/dormant，version+1 |
| **W2 新增** scope 变更 | `experimental:goal_scope_update` / `goal` | title/scope_knowledge_ids/sequence_hint 更新，version+1 |

注意 manual 路径的 goal（goal-create.ts:75，source='manual'）**完全无事件**，只能靠 genesis backfill 重建——proposal 路径与 manual 路径在 fold 后都从 genesis 开始，差异只在是否有上游 proposal/rate 链。

### ④ gather 查询

- **Q1（subject 直查）**：`event WHERE subject_kind='goal' AND subject_id=goalId` → genesis + proposal + W2 新增的 status/scope 变更事件。
- **caused_by 链**：`event WHERE caused_by_event_id IN <Q1 ids> AND action IN ('rate','correct')` → accept rate（subject_kind='event'）+ retract correct（subject_kind='event'）。
- **Q2 反查**：不需要（goalId == subject_id，proposal 用 `target.subject_id` 非 materialized_ids）。
- **Q3 merge-into**：不适用。

### ⑤ genesis backfill timestamp 对齐

`backfillGoalGenesis`：扫 goal 表无 genesis anchor 的行（判定条件：`event WHERE subject_kind='goal' AND subject_id=id AND action='experimental:genesis'` 不存在；**不能用「有 proposal event」判定**，因 manual goal 无 proposal）。timestamp 取**行的当前 created_at/updated_at verbatim**（与 W1 一致：genesis snapshot 携带行自身时间戳，不重算）。原子 tx：genesis event + materialized_id_index 行，`ingest_at=now`（outbox opt-out），幂等。

### ⑥ 接线点（SoT flip 已 LIVE → projection-as-writer 语义）

- INSERT：`insertGoal`（queries.ts:44）的两个调用方——accept.ts:105 + goal-create.ts:75——改为同 tx 写 genesis event + materialized_id_index 后调 `projectGoal(tx, goalId)` 写穿（镜 knowledge 的 accept seam）。
- UPDATE retract：actions.ts:1046 当前裸 `.update(goal).set({status:'dormant'})` 且**不 bump version**。W2 改为：先写 `correct` event（已有）→ 调 `projectGoalGuarded(tx, goalId)` 写穿。fold 的 retract 分支对齐「dormant + updated_at，**不 bump version**」以匹配现有命令式语义（保持 behavior-preserving；若要统一 bump 另起 follow-up issue，不在本 wave 扩 scope）。
- UPDATE updateGoalStatus/updateGoalScope（queries.ts:76/98）：**当前无生产调用者**。W2 同步补写 `experimental:goal_status_update` / `experimental:goal_scope_update` 事件 + 写穿，使 helper 一旦接线即 fold-complete。这是「数据门只 gate 翻转不 gate build」——先把事件路径接通，避免未来接线时漏。

---

## 2. mistake_variant

### ① MistakeVariantRowSnapshot

全列（schema.ts:1144-1161），无 embed_*：

```
id, parent_question_id, variant_question_id(nullable), proposal_event_id(nullable),
status(enum draft|active|broken|dismissed), failure_reasons(string[]),
cause_category(nullable), created_at, updated_at
```

排除：无（无 version 列，与 edge 一致）。`updated_at` 取事件链 keep-last。

### ② GenesisExperimental.subject_kind 扩展

加 `'mistake_variant'`，`payload.row` union 加 `MistakeVariantRowSnapshot`，superRefine 用显式 `safeParse`（见 §1②）。

### ③ fold reducer 事件聚合策略（这是 W2 最复杂的一个）

mistake_variant **不是纯独立事件流**——它是「以 `proposal_event_id`（E1）为锚的多事件复合投影」，且有一个字段无法从事件链重算。事件结构（grounding 五事件）：

| 事件 | 定位 | fold 效果 |
|---|---|---|
| E0 genesis | `experimental:genesis`/`mistake_variant`，subject_id=mvId | 初始化全列（**含 cause_category，见关键点**） |
| E1 proposal | `experimental:proposal`/`question`（variant_gen.ts:263 同 tx），`ai_proposal.kind='variant_question'` | 提供 parent_question_id（=source_question_id）、初始 draft；行 id 是 `createId()`，不在 E1 payload |
| E2 accept | `rate`/`event`，caused_by=E1.id，`payload.rating='accept'`，`payload.mistake_variant_id`=mvId，`payload.materialized_question_id` | status→active，variant_question_id=materialized_question_id（proposal-appliers.ts:230-237） |
| E3 verify | `experimental:variant_verify`/`question`，caused_by=E1.id，subject_id=variant_question_id | verdict='fail'→status='broken'+failure_reasons（variant_verify.ts:296-302）；'pass'→touch updated_at |
| E4 dismiss | `rate`/`event`，caused_by=E1.id，`payload.rating='dismiss'` | status→dismissed（actions.ts:908-916） |
| E5 retract | `correct`/`event`，caused_by=E1.id，`correction_kind='retract'` | status→dismissed（actions.ts:1002-1010，可从 draft/active 翻） |

**关键点 — cause_category 是折叠盲区**：它在 variant_gen INSERT 时由 `effectiveCauseForFailureAttempt(failure)` 运行时计算填入行，**不在任何事件 payload**。这打破「完全从事件流重建」纯粹性。**解法（与 grounding 一致，正确且必要）**：genesis backfill 时把 cause_category 作为 RowSnapshot 字段直接快照进 E0。这样 fold 从 genesis 起就有完整 cause_category，无需联接 judge 事件链。**W2 接线前提**：variant_gen 的 INSERT 必须改为「先写 genesis 事件（payload.row 含 cause_category）→ 写穿」，否则新建的 variant fold 时 cause_category 仍丢。即 cause_category 必须由 **genesis-at-creation** 携带（不是只靠一次性 backfill）——见接线点 ⑥。

mvId 的事件链定位：fold 输入需要「锚事件 E1 + 所有 caused_by=E1 的事件」。但 reducer 是 `fold(mvId, events)` 纯函数——它通过 E0 genesis（subject_id=mvId）拿到 `proposal_event_id` 字段值，再由 gather 用该值拉 caused_by 链（见 ④）。

### ④ gather 查询

- **Q1**：`event WHERE subject_kind='mistake_variant' AND subject_id=mvId` → 拿 E0 genesis（其 payload.row.proposal_event_id = E1.id）+ W2 新增的变更事件。
- **caused_by 链**：`event WHERE caused_by_event_id = <proposal_event_id> AND action IN ('rate','correct','experimental:variant_verify')` → E2/E3/E4/E5。proposal_event_id 从 Q1 的 genesis snapshot 取（reducer 内 / gather 内两步：先 Q1 拿 anchor，再用 anchor 拉链）。
- **Q2/Q3**：不需要（mvId == subject_id；createId() 预生成）。

### ⑤ genesis backfill timestamp 对齐

`backfillMistakeVariantGenesis`：扫无 `experimental:genesis`/`mistake_variant` 的行。timestamp verbatim（行自身 created_at/updated_at）。**cause_category 必须进 snapshot**（折叠盲区补偿）。原子 tx + index 行 + outbox opt-out + 幂等。FK 序：在 question + event 之后（mistake_variant 软引用二者）。

### ⑥ 接线点

- INSERT（variant_gen.ts:263）：改为同 tx 写 `experimental:genesis`/`mistake_variant`（payload.row 含 cause_category + proposal_event_id=E1.id）+ index → `projectMistakeVariant(tx, mvId)` 写穿。**这是 W2 唯一一处必须在 creation 即写 genesis 的实体**（因 cause_category 盲区；其他两实体 creation 可走标准事件链）。
- UPDATE active（proposal-appliers.ts:230-237）：accept 已写 E2 rate → 改写穿。
- UPDATE broken/pass（variant_verify.ts:296-309）：verify 已写 E3 → 改写穿。
- UPDATE dismissed（actions.ts:908/1002）：dismiss/retract 已写 E4/E5 → 改写穿。
- 所有 UPDATE 路径的 status 转移**已经有对应事件**（E2-E5），所以 mistake_variant 不像 goal/learning_item 需要补写大量新动作事件——只需 creation 补 genesis + reducer 正确消费 E2-E5。

---

## 3. learning_item

### ① LearningItemRowSnapshot（排除最多）

schema.ts:304-343。**排除衍生/无写路径列**：

| 排除列 | 理由（grounding 核实） |
|---|---|
| `child_learning_item_ids` | 始终 `[]`，无 UPDATE 路径，冗余；fold 强制 `[]` 或排除——选**排除**（fold 不 assert） |
| `ai_score` | 无任何写路径（仅 read），衍生占位 |
| `due_at` | 无任何写路径（context-readers 的 due_at 是 material_fsrs_state 的），历史残留 |
| `reviewed_at` | 无任何写路径，读路径从 event 表派生 |
| `user_pinned` | 无事件驱动写入；snapshot 保留（始终 false）但 **fold==row 比对跳过**（无事件可重建后续变更） |

snapshot 保留列：`id, source, source_ref, title, content, knowledge_ids, primary_artifact_id, parent_learning_item_id, status, user_pinned, completed_at, dismissed_at(始终null,保留), archived_at, archived_reason, created_at, updated_at, version`。

audit:projection 的 deep-diff 须配置忽略 `child_learning_item_ids`/`ai_score`/`due_at`/`reviewed_at`/`user_pinned`（镜 W1 embed_* 的 upsert 排除 + 比对排除，knowledge.ts shell line 69-72）。

### ② GenesisExperimental.subject_kind 扩展

加 `'learning_item'`。**粒度：每个 learning_item id（hub + 每个子 item）各一个独立 genesis event**（subject_id=item.id），不是整树一个。

### ③ fold reducer 事件聚合策略

learning_item 的独有复杂性：status 转移事件目前**经 rate event 的 payload `materialized_learning_item_id` 侧信道传递**，而非 subject_kind='learning_item' 专属事件。

| 事件 | 定位 | fold 效果 |
|---|---|---|
| genesis | `experimental:genesis`/`learning_item`，subject_id=itemId | 初始化（排除列除外） |
| **W2 新增** complete | `experimental:learning_item_complete`/`learning_item` | status→done，completed_at=now，version+1 |
| **W2 新增** relearn | `experimental:learning_item_relearn`/`learning_item` | status→in_progress，completed_at=null，version+1 |
| **W2 新增** archive | `experimental:learning_item_archive`/`learning_item` | archived_at=now，archived_reason，version+1 |

**推荐路线（与 W1 pattern 一致，Q1 直查）**：completion/relearn accept（proposal-appliers.ts:293/377）+ retract（actions.ts:1021）在 W2 同 tx **新增上述专属动作事件**，而非依赖 rate payload 反查。这样 gather 只需 Q1。

**过渡路线（若 complete/relearn 转移事件 defer 到 retract lane 协同）**：fold 经 Q3 反查 rate event 的 `payload->>'materialized_learning_item_id'` 近似重建 status（grounding 方案）。**本设计选推荐路线**——侧信道反查脆弱（payload 字段路径耦合），且 retract lane 正在动这些路径（见 §3⑩），一次性事件化更干净。

### ④ gather 查询

- **Q1**：`event WHERE subject_kind='learning_item' AND subject_id=itemId` → genesis + W2 complete/relearn/archive 事件（推荐路线下全部命中）。
- **caused_by 链**：creation accept 的 rate（acceptLearningIntent，learning_intent.ts:765，**注意：create accept 不带 materialized_learning_item_id**）——但 creation 由 genesis 覆盖，不依赖此链。仅在过渡路线需要 Q3。
- **Q3（仅过渡路线）**：`event WHERE action='rate' AND payload->>'materialized_learning_item_id'=itemId`。推荐路线下不需要。
- **Q2 反查**：不需要（itemId == genesis subject_id）。
- **树关系**：`parent_learning_item_id` 进 snapshot 即可；**不需要跨树 fold**——每行独立 fold（child_learning_item_ids 已排除，hub 不依赖 child 状态）。grounding 的「不可单独 fold 一行」是针对 child_learning_item_ids 想要保持同步的旧设想；既然该列排除，每行可独立 fold。

### ⑤ genesis backfill timestamp 对齐

`backfillLearningItemGenesis`：扫无 genesis anchor 的行。**每个 id 独立 genesis**（hub + 子项各一条）。timestamp verbatim。原子 tx + index + outbox opt-out + 幂等。FK 序：在 artifact + event 之后（learning_item 软引用 primary_artifact_id + source_ref→event）。

### ⑥ 接线点

- INSERT（learning_intent.ts:604/629/655 hub+atomic+long；legacy-record-appliers.ts:357 ai_dream）：每个 INSERT 改为同 tx 写 per-id genesis + index → `projectLearningItem(tx, id)` 写穿。
- UPDATE complete（proposal-appliers.ts:293）：W2 新增 `experimental:learning_item_complete` 事件 → 写穿。
- UPDATE relearn（proposal-appliers.ts:377）：W2 新增 `experimental:learning_item_relearn` 事件 → 写穿。
- UPDATE archive/retract（actions.ts:1021，当前裸 UPDATE archived_at + **不 bump version**）：W2 改为先写 genesis（若该 item 无 genesis，retract 时补 genesis + archive 事件对，让 `fold==archived_row` 成立——grounding 推荐）→ archive 事件 → `projectLearningItemGuarded` 写穿，version+1（对齐 knowledge_node retract 范本）。

---

## 4. 新表/迁移/常量登记（5 处）

**关键：W2 不新增任何 pgTable。** materialized_id_index（migration 0050）已存在，三实体复用。因此 5 处登记里的「新表」项大多 N/A，只列实际变更：

1. **schema**：无新表（复用 materialized_id_index）。
2. **migration**：**无新 migration**——materialized_id_index.subject_kind 是裸 `text`（schema.ts:794），加 'goal'/'mistake_variant'/'learning_item' 三值不需 DDL。（W2 唯一可能的 migration 是若决定给三实体的 status 加 DB enum，但当前都是 `text`，建议保持，无 migration。）
3. **audit:schema**：三实体新增的事件写路径不引入新列，但 W2 给 goal 的 updateGoalStatus/updateGoalScope 接线后，原 audit-schema-allowlist 里若有相关 goal 列的「无 write path」豁免需复核解除。逐一核 `scripts/audit-schema-allowlist.json`。
4. **export-constants.ts**：FK_ORDER 不变（三实体已在 constants.ts:127/136/137，materialized_id_index 已在末尾）；**SCHEMA_VERSION 不 bump**（无新表、无新列）。注意：`reference_new_pgtable_registration_surfaces` 的 5 处是「新 pgTable」触发的——W2 无新表，故第 3-5 处大多 no-op，但仍须**显式核对一遍**确认无遗漏（这是记忆里的失效模式）。
5. **db.ts ALL_TABLES（tests/helpers/db.ts）**：三实体表已在 ALL_TABLES（resetDb 已 TRUNCATE，见 knowledge.db.test.ts:125 注释 materialized_id_index 已纳入）。无新增。

**结论：W2 是「纯事件 + reducer + shell + backfill」工作，零 schema/migration/FK 变更**——这与 W1 不同（W1 引入了 materialized_id_index 新表）。登记 5 处主要是「核对无遗漏」而非「新增」。

---

## 5. 测试矩阵

每实体三类（镜 `audit-projection.db.test.ts` + W1 reducer 单测）：

| 类别 | 配置 | 断言 |
|---|---|---|
| **fold==row parity（纯 reducer 单测）** | unit（vitest.unit.config，纯函数无 DB） | 构造 FoldEvent[] → fold → 逐字段等于期望 RowSnapshot。覆盖：genesis-only / genesis+accept / genesis+retract / 各 status 转移 / mistake_variant cause_category 从 genesis 还原 / learning_item 排除列不参与 |
| **backfill 幂等（DB 测）** | db（vitest.db.config，testcontainer） | seed 命令式行 → backfill → 断 seeded 计数 + index 行 + genesis 事件；**二次 backfill → seeded=0**（幂等）；已事件化行 skip |
| **audit:projection 扩展（DB 测）** | db | seed 一致 genesis+index fixture → auditProjection CLEAN；out-of-band 改一行 → DRIFT。每实体一段，镜 audit-projection.db.test.ts |
| **接线写穿（DB 测）** | db | accept/retract/verify 经新 projection-as-writer 路径 → 断库行 == fold(events)（in-tx parity assert，镜 parity.ts:214 `assertKnowledgeNodeParity`） |

pre-flight（记忆 `feedback_preflight_typecheck_after_all_edits`）：全量 `pnpm typecheck` + biome + 受影响 targeted 测试（含 import 这些文件的测试）。`scripts/b3-gate.ts` 的 prod-clone GO/NO-GO 在 owner Mac 跑（已 LIVE flip，clone backfill+rebuild→audit:projection CLEAN）。

---

## 6. 实施切片建议（按 PR，每片独立 gate，Refs YUK-471）

按依赖序，每片可独立 typecheck/lint/targeted-test 通过。前两片对每实体重复（三实体可并行起 worktree，互不依赖）：

- **W2-S1 schema + 纯 reducer（per-entity ×3，可并行）**：扩 genesis.ts subject_kind/union/superRefine（一次性容三实体，或每片加一个）+ 新建 `src/core/projections/<entity>.ts` + 纯 reducer 单测。**无 IO、无接线、behavior-preserving**（镜 W1 PR-A1）。gate：unit 测 + typecheck。
- **W2-S2 IO shell + gather + backfill（per-entity ×3）**：新建 `src/server/projections/<entity>.ts`（projectX + projectXGuarded）+ gather helper + `materialized-id-index.ts:31` union 扩 + backfill 脚本段 + DB 测（backfill 幂等 + shell parity）。**仍不接线 live**（镜 W1 PR-A2a）。gate：db 测 + typecheck。
- **W2-S3 新动作事件 schema（goal + learning_item）**：定义 `experimental:goal_status_update`/`goal_scope_update`/`learning_item_complete`/`relearn`/`archive` 的 typed schema（镜 W1 archive 事件，加进 RESERVED_EXPERIMENTAL_ACTIONS parse barrier，Codex #4 前缀要求）。mistake_variant 无需（E2-E5 已存在）。gate：unit + parse-barrier 测。
- **W2-S4 接线 projection-as-writer（per-entity ×3，SoT flip 已 LIVE）**：把 §⑥ 的命令式 INSERT/UPDATE 改走 projectX/projectXGuarded + 同 tx 写事件。mistake_variant 的 creation 必须带 cause_category genesis（§2⑥）。**按 FK 序接线**（被依赖表先：question/event/artifact 已事件化在先）。gate：db parity 测 + in-tx assert。
- **W2-S5 audit:projection 扩展 + backfill 编排 + prod-clone gate**：audit-projection.ts 加三实体全表 diff 段 + `backfillGenesisEvents` 编排三实体（FK 序）+ owner 跑 b3-gate prod-clone。gate：audit:projection CLEAN on clone。

mistake_variant 因 E2-E5 已存在，可跳 S3，但 S4 的 creation-genesis 是其特有重点。

---

## 7. 与 retract lane（item 5，撤 learning_item/goal）的协调点

retract lane 在 `tlp-wt-retract` worktree 并行动 actions.ts 的 retract 路径，与 W2 learning_item/goal 强耦合。**接口约定（W2 必须先定，retract lane 消费）**：

1. **事件 shape 是 W2 的责任**：W2-S3 定义 goal/learning_item 的 retract-visible 事件（`experimental:goal_status_update`→dormant、`experimental:learning_item_archive`）。retract lane 在其 rollback tx 里**写 W2 定义的事件**，不要各自发明。
2. **goal retract（actions.ts:1046）**：W2 接线后从「裸 UPDATE dormant」改为「写 correct（已有）→ projectGoalGuarded」。retract lane 若也改这块，须以 W2 的 projectGoalGuarded 为准，避免双写冲突。
3. **learning_item completion/relearn retract（retract lane 已在 diff 里，纯命令式 reopen）**：W2 提供 `experimental:learning_item_relearn`（completion retract→in_progress）/ `learning_item_complete`（relearn retract→done）作为 undo 事件——retract lane 的 reopen tx 须写这些事件 + 调 projectLearningItem，否则 fold 追不到 reopen。relearn retract 写的 `completed_at=now` 是合成时间戳（无法恢复原值），fold 接受此语义。
4. **knowledge_node retract（retract lane 已有 fold==row 设计：写 archive+rate→applyArchive）**：这是 W2 learning_item/goal archive 事件设计的**参考范本**，W2 直接镜它。
5. **learning_item retract（actions.ts:1021，撤 hub+所有 child）**：W2 推荐「retract 时若 item 无 genesis 则补 genesis + archive 事件对」让 fold==archived_row。retract lane 须用 W2 的 archive 事件。
6. **completion_evidence DELETE（retract lane）**：不在任一 fold 范围内（hard-delete 合理）；audit:schema 注意该表无 archived_at。W2 不碰。
7. **version bump 一致性**：goal/learning_item 当前 retract 不 bump version（actions.ts:1046/1021）。W2 reducer 的 retract 分支须与最终命令式语义一致——**W2 与 retract lane 须就「retract 是否 bump version」达成单一约定**（建议：对齐 knowledge_node 范本 bump version，但需两 lane 同步改，否则 parity 漂移）。这是两 lane 的**头号必须对齐项**。

---

## Linear 捕获

本设计稿发现的 follow-up（应建 Linear issue，避免只留散文）：
- **goal updateGoalStatus/updateGoalScope 无生产调用者 + retract 不 bump version 的 inconsistency**（actions.ts:1046）——W2 接线时顺带修，或拆独立 issue 跟踪「goal status 变更接线 + version 统一」。
- **W2 与 retract lane 的 version-bump 单一约定**（§7.7）——头号协调项，建议在 YUK-471 下建子 issue 或 PLAN.md BLOCKED-ON 记录，避免两 lane 各改各的导致 parity 漂移。
- mistake_variant `GenerateArtifact`/`artifact_kind='variant'`（known.ts:230）是历史死字段，未被任何写入使用——可记 audit:relations 类死边 follow-up，非本 wave scope。

（以上为设计建议，最终是否开 issue 由 driver session 决定；本综合者不直接创建 Linear issue。）

---

**关键文件锚点汇总**：W1 范本 = `src/core/projections/knowledge.ts:101`（reducer）/ `src/server/projections/knowledge.ts:104`（guarded shell）/ `src/server/projections/gather.ts:80`（gather）/ `scripts/backfill-genesis-events.ts:144`（backfill）/ `src/core/schema/event/genesis.ts:93`（genesis schema）/ `src/server/projections/parity.ts:124`（flip-guard anchor）。W2 目标 schema = `src/db/schema.ts:1177`（goal）/ `:1144`（mistake_variant）/ `:304`（learning_item）。接线点 = `src/capabilities/agency/server/goals/{accept.ts:105,queries.ts:44/76/98}`、`src/capabilities/agency/api/goal-create.ts:75`、`src/server/boss/handlers/{variant_gen.ts:263,variant_verify.ts:296}`、`src/capabilities/practice/server/proposal-appliers.ts:230`、`src/capabilities/agency/server/proposal-appliers.ts:293/377`、`src/server/orchestrator/learning_intent.ts:604`、`src/server/proposals/{actions.ts:1021/1046,legacy-record-appliers.ts:357}`。