Critical confirmation on item5/retract: `actions.ts` learning_item retract archives BOTH `learning_item` AND `artifact` rows (where source_ref=proposalId), and goal retract dormants the goal — all without bumping version, all bare imperative UPDATEs. Wave 2's claim about archive paths is partially accurate but misses that learning_item retract also touches `artifact` (a Wave 3 entity) — cross-wave coupling. I now have all the grounding I need to produce the adversarial review.

---

# YUK-471 Wave 2 + Wave 3 对抗性完备性审稿

真相源 = ADR-0044。已对所有关键声明做 file:line 核验。结论导向，按严重度排列。

---

## A. BLOCKER（落地前必须解决，否则功能错或 gate 假绿）

### A1 — 【两稿共同致命】SoT flip 是**全局单 flag**，Wave 2 「flip 已 LIVE」是错误前提
**严重度：BLOCKER** · 位置：Wave 2 §0/§6/§7 全篇「SoT flip 已 LIVE（`PROJECTION_IS_WRITER=1`）」；真相 = `src/server/projections/sot-flag.ts:26-28` + `:11-22`。

`projectionIsWriter()` 读的是**单个全局 env `PROJECTION_IS_WRITER`**，不是 per-entity。`sot-flag.ts:12-15` 明确写：activation = **knowledge/knowledge_edge 的 B3 GATED cutover**（rebuild prod-clone → `audit:projection` CLEAN on knowledge/edge → 翻 flag）。这意味着：

- **若该 flag 现已 =1**（W1 已 flip），那么 Wave 2/3 的所有新接线点（goal/mistake_variant/learning_item/artifact/question_block）一旦读 `projectionIsWriter()`，会**立刻**走 projection-as-writer 路径——但它们的 reducer/gather/genesis backfill **尚未 ship**。结果：flag 已 ON 的生产环境里，新接线代码上线即 fold 空世界 / parity 崩 / 行写不进。**Wave 2/3 不能复用同一个全局 flag**，必须要么 (a) 引入 per-entity flag（`PROJECTION_IS_WRITER_GOAL` 等），要么 (b) 在各实体自己的 B3 gate CLEAN 前，新接线点**硬编码走旧命令式路径**，flag 只 gate 已验证实体。
- **若该 flag 现仍 =0**（W1 尚未 cutover），那么 Wave 2 §0「SoT flip 已 LIVE」整段定调是**事实错误**，连带 §6「SoT flip 已 LIVE」的切片假设、§7 retract lane「双写期假设不再成立」全部错。Wave 2 反而需要保留双写期 + parity assert（ADR-0044 §7「双写期：写 projection + append event + 即时 fold==projection 校验，一致再切真相源」）。

**两稿都未给出 flag 的 per-entity 隔离设计。** 这是 BLOCKER：当前架构下，Wave 2/3 上线会污染 Wave 1 的 flip 语义，或在错误前提上构建整个切片计划。

**修正**：先 ground flag 当前值 + 与 owner 确认 cutover 状态；将 `projectionIsWriter()` 扩成 per-entity（`projectionIsWriter(entity)`），各实体独立 B3 gate 独立翻；Wave 2 删除「flip 已 LIVE」全局定调，改为「W1 已 flip 不代表 W2 已 flip」。

---

### A2 — 【Wave 3，Codex #6】`merged_into` 列不存在，after-state 设计建立在虚构 schema 上
**严重度：BLOCKER** · 位置：Wave 3 核心结论 #2「Codex #6 解法 = affected_blocks[] 多行 after」；前置审稿任务描述也复述「mergeQuestions 还把被合并 block 置 status='ignored'+merged_into」。

真相（`block-structured-edit.ts:507-562`）：
- primary block：`merged_from_block_ids` 追加 + `structured`/`figures`/`version+1`。
- merge blocks：**只** `.set({ status: 'ignored', updated_at })` —— **没有 `merged_into` 列**。`question_block` schema（schema.ts:194）只有 `merged_from_block_ids`（在 primary 上），无 `merged_into`/`merged_into_block_id` 物理列。`merged_into_block_id` **仅存在于 job_event payload**（:556-561），不是行状态。

所以 Codex #6 的「覆盖所有受影响 block 的 after 状态」在实现上是：primary 的 after-tree（structured+figures+merged_from_block_ids+version）+ 每个 merge block 的 after = `{status:'ignored', updated_at}`。Wave 3 的 `affected_blocks[]` 必须按**真实 after 列**建模，不能引用不存在的 `merged_into`。否则 fold 重建出一个带 `merged_into` 字段的幽灵行，parity 永远 DRIFT。

**修正**：affected_blocks[] 的 merge-block after = `{status:'ignored', updated_at}`（无 merged_into）；merged_into 关系只能从 primary 的 `merged_from_block_ids` 反推。Wave 3 doc 须改正 schema 描述。

---

### A3 — 【Wave 3，Codex #5】「applyExtractionResult 同步写 genesis seed」未给出 figures/page_spans/crop_refs 的来源闭环
**严重度：BLOCKER** · 位置：Wave 3 #2「Codex #5 解法 = 方案 A3，applyExtractionResult 同步写 genesis seed」。

Codex #5 的硬要求是：extract event 只存 `structured_block_ids`，真实 `structured`/`figures`/`page_spans` 在 `applyExtractionResult` 直插表。Wave 3 说「applyExtractionResult 同步写 genesis seed」——但 **genesis seed 的 payload.row 必须是完整 QuestionBlockRowSnapshot**（含 structured/figures/page_spans/crop_refs/layout_quality/status/version）。Wave 3 同时声称 `crop_refs` 是**排除列**（figures.map 派生，IO shell 重算）。这里有内部矛盾 + 一个未闭环：

1. **矛盾**：若 crop_refs 排除（不进 snapshot），但它是 `notNull().default([])` 物理列（schema.ts:31），fold==row parity 比对必须显式忽略它，且 IO shell 每次 write-through 都要从 figures 重算 crop_refs。Wave 3 说了「IO shell 重算」但没说 **backfill 时**怎么处理已有行的 crop_refs（backfill 走 genesis seed → fold → write-through，重算出的 crop_refs 必须 byte-equal 现有行，否则首次 audit:projection 就 DRIFT）。需要证明 `figures → crop_refs` 重算函数对现有所有行幂等。
2. **未闭环**：genesis seed 在 `applyExtractionResult` 内同步写——但 applyExtractionResult 是 OCR pipeline 的产物落地点，**它在 `extract` canonical event 之后**。Wave 3 没说清：是 (a) 扩 `extract` payload 带完整 block 内容（Codex #5 给的选项一），还是 (b) 为每个新 block 写独立 genesis（选项二）。「写 genesis seed」听起来是 (b)，但 genesis 是 `experimental:genesis`（backfill 语义，actor_kind='system'）——把它用在**热路径 OCR 新建**上，语义错位（genesis 定义注释 genesis.ts:8-13 明确是「pre-W1 row backfill seed」，不是运行时 create）。运行时新建 block 应该走一个 **create 事件**，不是 genesis。

**修正**：Wave 3 必须二选一并明确：要么扩 extract payload（推荐，单事件原子），要么定义新的 `EditQuestionBlockStructured` create 分支 / 专属 create 事件。genesis 仅用于一次性 backfill，**禁止**用于运行时新 OCR block。crop_refs 排除需补「backfill 重算幂等」证明。

---

### A4 — 【Wave 2】mistake_variant cause_category：genesis-at-creation 把运行时 create 误用 genesis 语义（同 A3 病根）
**严重度：BLOCKER** · 位置：Wave 2 §2⑥「variant_gen 的 INSERT 改为先写 genesis 事件（payload.row 含 cause_category）」。

已核实 `variant_gen.ts:270` 的 `cause_category: cause.primary_category` 是 INSERT 时运行时计算，不在任何事件——「折叠盲区」诊断正确。但 Wave 2 的解法是「creation 即写 `experimental:genesis`/`mistake_variant`」——**与 A3 同一个语义错误**：genesis 是 backfill seed（一次性、actor_kind='system'、pre-W2 行），把它焊到 variant_gen 热路径上，意味着每次新建 variant 都写一条 `experimental:genesis`。这会：
- 污染 backfill 幂等判定（§2⑤的 backfill 扫「无 genesis anchor 的行」——运行时新建已带 genesis，backfill 永远 skip 它们，OK；但反过来，`experimental:genesis` 出现在运行时事件流里，破坏「genesis ⇒ pre-W2 行」的不变量，未来任何依赖该不变量的审计/级联会误判）。
- cause_category 应该走一个**正式 create 事件**（如 `experimental:mistake_variant_create`，payload.row 含 cause_category），而不是 genesis。

**修正**：mistake_variant 运行时 creation 用专属 create 事件携带 cause_category；genesis 仅 backfill 已有行。Wave 2 §2⑥ + §6「creation-genesis」措辞须改。

---

## B. HIGH（设计错误/遗漏，会导致 parity 漂移或 gate 失效）

### B1 — 【Wave 2，不变量 (b)】goal/learning_item retract「不 bump version」与 fold reducer 的 version 语义自相矛盾
**严重度：HIGH** · 位置：Wave 2 §1⑥ + §3⑥ + §7.7（自承「头号必须对齐项」）；真相 `actions.ts:1021/1046`（已核：裸 UPDATE，不 bump version）。

`GoalRowSnapshot`/`LearningItemRowSnapshot` 都把 `version` 纳入 snapshot。fold reducer 对每个动作事件 `version+1`（§1③/§3③表格明写「version+1」）。但 retract 走 `correct` 事件 + 「不 bump version」（behavior-preserving）。**问题**：fold 重放 genesis(v=N) → status_update(v=N+1) → retract(不 bump，v 仍 N+1) ——但若 retract 之前那条命令式 UPDATE 也没 bump，现有行的 version 与 fold 出的 version 会因「哪些 UPDATE bump、哪些不 bump」的历史不一致而漂移。Wave 2 自己在 §7.7 标为「头号协调项」却没解决，只是 punt 给「两 lane 达成单一约定」。**这是设计稿当『待协调』但实际是 fold==row 不变量的硬前提**——version 列既然进 snapshot，每条事件对 version 的影响必须确定且与历史命令式写一致，否则 §5 测试矩阵的 parity 必挂。

**修正**：要么 version 移出 snapshot（像 knowledge_edge 无 version），要么 reducer 精确镜像每个历史 UPDATE 的 bump/不-bump（需逐站点核 `version: sql\`+1\`` vs 无）。不能 punt。

### B2 — 【Wave 2/3 交叉】learning_item retract 同时 archive `artifact` 行（跨 wave 耦合未处理）
**严重度：HIGH** · 位置：`actions.ts:1021-1035`（已核）。

learning_item retract 不止 archive learning_item，还 `update(artifact).set({archived_at})` where source_ref=proposalId。artifact 是 **Wave 3** 实体。Wave 2 §7 协调点列了 learning_item/goal/knowledge_node，**完全没提这条 artifact archive**。后果：Wave 3 给 artifact 建 fold 后，这条 Wave 2/retract-lane 的裸 artifact UPDATE 不写 artifact 事件 → artifact fold 追不到 archive → parity DRIFT。三 lane（W2 / W3 / retract lane）在 actions.ts:1021 这一个函数里交汇且互不知情。

**修正**：actions.ts learning_item retract 的 artifact archive 必须写 Wave 3 的 artifact archive 事件；三 lane 须在此函数显式对齐归属。

### B3 — 【Wave 2，不变量 (c)】genesis superRefine 五成员 union 的判别从「字段嗅探」改「per-kind safeParse」是对的，但两稿都没处理**字段重叠导致 safeParse 误通过**
**严重度：HIGH** · 位置：Wave 2 §1②「改 per-subject_kind 显式 safeParse」；现状 genesis.ts:120 用 `'from_knowledge_id' in row`。

per-kind safeParse 比字段嗅探鲁棒，但 Zod object 默认 **非 strict**（多余字段被剥离不报错）。GoalRowSnapshot 和 LearningItemRowSnapshot 字段高度重叠（都有 id/title/status/source/source_ref/created_at/updated_at/version）。`GoalRowSnapshot.safeParse(learningItemRow)` 可能**误成功**（learning_item 的多余列被 strip，缺的列若都 optional/nullable 就过）。subject_kind='goal' 但 payload 实为 learning_item row → safeParse 通过 → 错误 seed 持久化。**parse barrier 守不住**（A3/A4 强调 genesis 是 ground truth，错 seed 灾难性）。

**修正**：各 RowSnapshot 用 `.strict()`，且 superRefine 额外断言「该 kind 的 discriminating 必有列存在」（goal 必有 `scope_knowledge_ids`+`sequence_hint`，learning_item 必有 `knowledge_ids`+`source` 组合）。两稿都未提 `.strict()`。

### B4 — 【Wave 3，YUK-358 不变量 (g)】`enforceUserVerifiedGuard:false` fold 回放是对的，但漏了 backfill genesis 本身会触发 guard
**严重度：HIGH** · 位置：Wave 3 #5；真相 `apply-note-patch.ts:72`（default `true`），`:125/:145` guard 点。

Wave 3 正确识别「fold 重放 note_refine_apply 须 `enforceUserVerifiedGuard:false`」。但有个未覆盖场景：artifact genesis backfill 把**当前已含 user_verified block 的 artifact** 快照进 genesis。fold 从 genesis 起重建已是 verified 状态，**然后** 重放历史 op（如某个 add/replace 早于 verify）。若 op 顺序是 verify-before-edit（历史上 verify 之后又有合法 edit），fold 必须保证 guard off 全程。Wave 3 说了 replay 时 off，但没明确 **genesis seed 内的 user_verified 状态如何与后续 op 协调** —— 如果 genesis 已是 verified-final 态，再叠 op 会与现实顺序冲突。这关系到 Wave 3 §10 Q4「refine replay vs snapshot」未决问题，但 Q4 被列为「实施 lane 内决策」——实际它决定 fold 正确性，是 BLOCKER 边缘。

**修正**：明确 artifact body_blocks 用 **full-snapshot fold（每次 edit 全量 after）** 而非 op-replay（Wave 2 BodyBlocksEdit 已 promote 为 full-snapshot + previous_body_blocks——若 artifact 走 full-snapshot，则 note op replay 根本不需要，guard 问题消失）。Wave 3 内部 BodyBlocksEdit(full-snapshot) 与「replay note_refine_apply」两种说法冲突，须统一。

### B5 — 【Wave 2，不变量 (h)】测试矩阵缺 honest-reject 用例
**严重度：HIGH** · 位置：Wave 2 §5 测试矩阵（四类：parity/幂等/audit/写穿）。

审稿要求 (h) 显式含「honest-reject」。Wave 2 矩阵**没有** parse-barrier honest-reject 用例（malformed genesis payload → writeEvent 必须拒，不 fall through generic）。这是 genesis.ts:15-21 + experimental.ts:149 整个 reserved-action 机制的核心保护。W1 必有此测试（state-snapshot/genesis 各有），Wave 2 三实体扩 union 后必须各加：错 subject_kind/错 row shape/subject_id≠row.id 三类 reject 断言。Wave 3 #1 提了 ArtifactStatusExperimental reserved，但矩阵（结论 #7-8 未展开）也需核 honest-reject。

**修正**：两稿测试矩阵都补 parse-barrier honest-reject 段（每新增 subject_kind ×3 reject 用例）。

---

## C. MED（不阻断但会埋坑）

### C1 — 【Wave 2，新表登记 (f)】audit:schema allowlist 复核被 punt，但 goal updateGoalStatus/Scope 接线会**改变** allowlist 解除条件
位置：Wave 2 §4.3。Wave 2 给 goal 的 `updateGoalStatus`/`updateGoalScope`（当前无生产调用者）补事件 + 接线后，若 `audit-schema-allowlist.json` 里有「goal 某列无 write path」的豁免，其 `resolves_when` 可能因接线而满足/失效。Wave 2 说「逐一核」但没给出**哪些列**当前在 allowlist。这是记忆 `reference_new_pgtable_registration_surfaces` 的失效模式（新写路径让旧豁免过期）。**修正**：实施前先 `grep goal/learning_item/mistake_variant scripts/audit-schema-allowlist.json` 列清单。

### C2 — 【Wave 3，新表登记 (f)】MaterializedSubjectKind 扩 'artifact' 但 question_block 不入 index — flip-guard 对 question_block 失效未说明补偿
位置：Wave 3 #6「materialized_id_index 扩 'artifact'，question_block 不入 index」。Wave 2 §0 明确 materialized_id_index 的唯一用途是「SoT-flip guard 的 O(1) genesis-anchor 判定」（镜 `parity.ts:124 hasKnowledgeNodeGenesisAnchor`）。若 question_block **不**入 index，那么 question_block 的「该行有无 genesis anchor」判定走什么？Wave 3 没说。要么 question_block 不需要 delete-on-null guard（需论证：fold 出 null 时不删行），要么需要另一条 anchor 查询路径（直查 event 表 `subject_kind='question_block' AND subject_id=? AND action='experimental:genesis'`，O(n) 但可接受）。**修正**：Wave 3 须明确 question_block 的 flip-guard anchor 路径。

### C3 — 【Wave 2，不变量 (b) self-referential】learning_item 自引用树排除 child_learning_item_ids 的论证有缺口
位置：Wave 2 §3①/§3④。Wave 2 论证「child_learning_item_ids 始终 []，排除，每行独立 fold」。审稿要求 (b) 特别点名「self-referential learning_item」。问题：`parent_learning_item_id` 进 snapshot，hub 创建时（learning_intent.ts:604 hub + atomic + long）child 的 parent 指向 hub。**若 hub 与 child 在同 tx 创建但 genesis 分别写**，backfill 时若按 FK_ORDER 单行 fold，child genesis 的 parent_learning_item_id 引用的 hub 必须已存在——backfill 顺序（同表内 hub 先于 child）未在 §3⑤说明。当前 FK_ORDER（constants.ts:127）learning_item 是单条，表内顺序无保证。**修正**：backfill learning_item 须 hub-before-child 排序（parent_id 拓扑序），否则 child genesis 写入时引用悬空（虽无 enforced FK，但 fold 出的树结构会错）。

### C4 — 【Wave 3，job_events 共存 (d)】「6 个 op 在 writeJobEvent 后额外 writeEvent」未处理 mergeQuestions 的多 writeJobEvent
位置：Wave 3 #4。已核 mergeQuestions（block-structured-edit.ts:551-562）写 **1 + N 条** job_events（primary 一条 + 每 merge block 一条）。Wave 3 说「额外 writeEvent」——但应是**单条** canonical event 覆盖所有 affected_blocks（A2 的多行 after），不是 N+1 条。job_event 数 ≠ canonical event 数。**修正**：明确 merge 写一条 canonical `EditQuestionBlockStructured`（affected_blocks 覆盖 primary+所有 merge block），job_events 保持 1+N 不变（传输层）。

### C5 — 【两稿，切换序 (e)】FK 切换序遗漏 artifact ↔ learning_item ↔ question_block 的交叉依赖
位置：Wave 2 §3⑤「learning_item 在 artifact + event 之后」；Wave 3 #6「question_block 先于 artifact，artifact 末位」。但 B2 揭示 learning_item retract archive artifact——若 Wave 2 先 cutover learning_item 而 Wave 3 artifact 未 cutover，learning_item retract 写 artifact 事件时 artifact reducer 不存在。**跨 wave 切换序**必须：artifact (W3) 的 fold 能力先于 learning_item (W2) cutover，或两者同批。这与 Wave 2「artifact 已事件化在先」(§3⑥) 的假设冲突——W2 时 artifact 尚未 fold 化。**修正**：跨 wave 依赖图须显式画出，artifact-before-learning_item。

---

## D. LOW

- **D1**（Wave 2 §3）learning_item `dismissed_at 始终 null,保留` 进 snapshot 但无写路径——应同 `user_pinned` 列入「比对跳过」，否则 backfill 一致但任何未来写入它的路径会立刻 DRIFT。措辞含糊。
- **D2**（Wave 3 #9 Q3）「archived_at 不建议 defer」结论正确（软删读路径硬依赖），但 #7 ArtifactStatusExperimental 整体可 defer 与 archived_at 不可 defer 之间的边界未在切片表（C1）落实——C1 PR 若 defer 了会漏 archived_at。
- **D3**（Wave 2 §7.3）relearn retract 写 `completed_at=now` 合成时间戳「fold 接受此语义」——这使 fold 不可重现原始 completed_at，但 snapshot 比对会因合成时间戳与历史行不符而 DRIFT（除非 backfill 时已是合成值）。需确认这类行 backfill 时取「当前行 verbatim」而非重算。

---

## E. 被设计稿当「已解决」但实际未验证的声明 (i)

1. **Wave 2「SoT flip 已 LIVE」**（A1）——最严重，未验证 flag 实际值 + 全局/per-entity 性质。
2. **Wave 3「merge ... merged_into」**（A2）——schema 无此列，未对照 schema.ts 核实。
3. **Wave 2「artifact 已事件化在先」**（C5）——artifact 是 W3 才 fold 化，W2 时不成立。
4. **两稿「crop_refs IO shell 重算」幂等**（A3）——未证明对现有行 byte-equal。
5. **Wave 3「applyExtractionResult 写 genesis seed」**（A3）+ **Wave 2「creation-genesis」**（A4）——genesis 语义被误用于运行时 create，未对照 genesis.ts:8-13 的 backfill-only 定义。

---

## 实施前必补清单（落地前逐项打勾）

1. ☐ **Ground `PROJECTION_IS_WRITER` 当前生产值** + 与 owner 确认 W1 cutover 状态；将 `projectionIsWriter()` 改为 per-entity（A1）。
2. ☐ **核 `git grep merged_into src/db/schema.ts`** 确认无此列，重写 Wave 3 Codex #6 的 after-state 为 `{status:'ignored',updated_at}`（A2）。
3. ☐ **定义运行时 create 事件**（mistake_variant create / question_block create），与 backfill-only 的 `experimental:genesis` 区分；genesis 禁止进热路径（A3/A4）。
4. ☐ **artifact body_blocks 统一为 full-snapshot fold**（非 op-replay），消解 note guard replay 冲突（B4）。
5. ☐ **version 列归属决策**：移出 snapshot 或 reducer 精确镜像历史每站点 bump（B1）。
6. ☐ **actions.ts learning_item retract 的 artifact archive** 三 lane 归属对齐 + 写 artifact 事件（B2/C5）。
7. ☐ **各 RowSnapshot `.strict()` + discriminating-column superRefine**（B3）。
8. ☐ **测试矩阵补 parse-barrier honest-reject 段**（每新 subject_kind ×3 reject）（B5）。
9. ☐ **`grep goal|learning_item|mistake_variant|artifact|question_block scripts/audit-schema-allowlist.json`** 复核解除条件（C1）。
10. ☐ **question_block flip-guard anchor 路径**明确（不入 index 时怎么判 genesis anchor）（C2）。
11. ☐ **backfill learning_item hub-before-child 拓扑序** + crop_refs 重算幂等证明（C3/A3）。
12. ☐ **跨 wave 切换序图**：artifact(W3) fold 先于 learning_item(W2) cutover（C5）。

---

## 需 owner 拍板的设计分叉

1. **flag 粒度**：单全局 `PROJECTION_IS_WRITER` 改 per-entity，还是各实体硬编码旧路径直到自己 B3 CLEAN？（A1 决定整个 W2/W3 上线安全性）
2. **运行时 create 事件 vs 扩 extract/genesis**：mistake_variant cause_category / question_block 新 OCR block 用专属 create 事件，还是扩既有事件 payload？（A3/A4）
3. **artifact fold 模型**：full-snapshot（previous_body_blocks 供 revert）vs op-replay（依赖 note guard off）？（B4，决定 YUK-358 合流复杂度）
4. **version 列**：进 snapshot（须精确镜像历史 bump）还是排除（像 knowledge_edge）？（B1，W2/retract lane 头号协调项）
5. **跨 wave cutover 编排**：W2 与 W3 是否必须同批 flip（因 learning_item↔artifact retract 耦合），还是可独立？（B2/C5）

---

**未发现需新建 Linear issue 的范围**：本任务是审稿（产出 findings），上述 follow-up 均属 YUK-471 W2/W3 实施 lane 范围内决策，应由 driver session 决定是否落 Linear/PLAN.md BLOCKED-ON（A1 的 flag 粒度 + B1/B2 的跨 lane 协调建议进 PLAN.md BLOCKED-ON，因涉及多 lane）。本审稿者不直接创建 issue。