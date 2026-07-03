# YUK-471 Wave 3 — 实施就绪状态 + impl 前置（re-critique 收口）

> 配套 `2026-06-25-yuk471-wave3-artifact-question-block-fold-CORRECTED.md`（修正设计，5 条原 BLOCKER 已解）。本文件记录对修正稿的对抗 re-critique 发现 + driver 对 5 个分叉的裁定。**Wave 3 impl gated on Wave 2 落地**（artifact/question_block fold 复用 Wave 2 goal slice 立的共享基建：genesis 逐 subject_kind safeParse、per-entity flag、assertXParity、gather/backfill/audit）。

## 状态：设计已修正，但**尚非 impl-ready** —— 须先（a）Wave 2 落地 reconcile 真实共享基建形态，（b）消解下列 impl 前置。

## re-critique 发现（对修正稿，2026-06-25）

| # | 严重度 | 问题 | 位置锚点 |
|---|---|---|---|
| **F1** | BLOCKER | artifact fold 真相列不全：`history` / `generation_status` / `verification_status` 的 mutation 站点未被事件化枚举 → flip ON 后这些列由谁写不清、fold≠row 必假失败 | `note_generate.ts:242`（generation_status）· `note_verify.ts:162/340`（verification_status + persistNoteVerificationResult）· `body-blocks-edit.ts:76`（history push 不进事件 payload） |
| **F2** | BLOCKER（实为 framing/timing） | 修正稿引用「Wave 2 已立」基建，但 main 上 Wave 2 未 merge（goal=PR #595 在分支）。re-critique agent 只见 main → 报 W1-only。**真相：Wave 2 在飞，先落地后 Wave 3 复用成立**；设计须改述「builds on in-flight Wave 2（先落地）」非「已立」 | `genesis.ts:93-143`（main 仍 2-enum）· `gather/parity/sot-flag`（main 仅 W1） |
| **F3** | HIGH | merge absorbed 行 `updated_at` 被改但不 bump version；fold 取 event.created_at vs 在线 `new Date()`（mergeQuestions 双 `new Date()`）→ parity 若比 updated_at 假失败 | `block-structured-edit.ts:506/511-514` |
| **F4** | HIGH | C4 Q2 jsonb `@>` 反查无 GIN 索引 → fold merged_source block 全表扫；加 GIN **是 DDL** → 推翻「无 DDL/5 处登记不触发」 | `event` 表仅 B-tree `event_subject_idx`（schema.ts:739）；W1 Q3 同坑 |
| **F5** | MED | crop_refs A3 裁定自相矛盾：rescue 事件携正确 figures.map()→与未改的 stale 在线 row 不符（假失败）；携 stale→「顺带修 staleness」收益不成立。二者不可兼得 | `ingestion.ts:408-416`（applyRescue 不写 crop_refs） |
| **F6** | MED | artifact 入 materialized_id_index 是过度设计：`hasKnowledgeNodeGenesisAnchor` event-表-first，artifact 必首段命中，index 段永不走到 | `parity.ts:124-153` |
| **F7** | MED | full-snapshot（body_blocks_edit）与 op-replay（note_refine_apply）按 created_at 交错 fold 时，op-replay 的 anchor 可能在 full-snapshot 后的树上失配；fold 无 version 乐观锁保护，未证收敛 | `note-refine-apply.ts:145-205` |
| **F8** | LOW | artifact INSERT 实为 8 条语句跨 6 文件（learning_intent.ts 有 3 条 :673/:708/:733），C1「6 站点」会漏改 2 条 | — |

## driver 对 5 个分叉的裁定（全技术层，不需 owner）

1. **Wave 2↔Wave 3 排序**：**(a) 先 Wave 2 再 Wave 3**（已定）。Wave 3 复用 Wave 2 共享基建，不自举脚手架。设计稿「已立」改述为「builds on Wave 2（先落地）」。
2. **GIN 索引（F4）**：**加** `event.payload` GIN（`jsonb_path_ops`）支撑 jsonb `@>` 反查 —— 这是 Wave 3 的一条 DDL/migration，触发新表登记面（schema/migration/audit:schema）。W1 的 Q3 同坑也顺带补（或独立 follow-up）。
3. **crop_refs（F5）**：**选 (b)** —— C1 同改 `applyRescue` 让在线也写 `crop_refs=figures.map()`（一次性 data-fix + 在线修），rescue 事件携正确值，parity 过。删「不改 applyRescue 还顺带修」的矛盾叙述。
4. **artifact 入 index（F6）**：**不入** —— 与 question_block 统一走 event-表直查 anchor；删 `MaterializedSubjectKind` 扩 `'artifact'`，省 backfill 写 index 行。
5. **GenerateArtifact 双事件（§9.1）**：保留 `generate`（业务意图）+ 新建独立 `artifact_create`（fold-source），`caused_by` 串联；孤儿补偿（generate 成功 create 失败）由同 tx 写保证原子（不跨 tx）。

## impl 前置 checklist（Wave 2 落地后、Wave 3 impl 开始前逐项）

1. 重写设计 §0+§6：「Wave 2 已立」→「W1 已 merge（knowledge/edge）+ Wave 2 先落地（goal/mistake_variant/learning_item）；artifact/question_block 的 genesis 多分支 / per-entity flag / parity-X / gather-X 复用 Wave 2 立的脚手架」。
2. 补全 artifact mutation 站点：6 文件 8 INSERT + body_blocks_edit + note_refine_apply + **note_generate(generation_status) + note_verify(verification_status) + retract(archive)**（F1）。
3. 裁定 `history` 列：进每条 edit/lifecycle 事件 payload（full-snapshot 携 after-history），或 parity `omit`（F1）。
4. `updated_at` parity：reducer 全取 event.created_at + 在线写统一单 `now`（修 mergeQuestions 双 `new Date()`），或 omit（F3）。
5. GIN 索引（F4，裁定 #2）→ 触发 migration + 登记。
6. applyRescue 同改 + crop_refs（F5，裁定 #3）。
7. artifact 不入 index（F6，裁定 #4）。
8. B4 交错收敛：fold 链 version 单调连续断言 + reducer version-gap fail-loud + 交错序列 fold==row 测试（F7）。
9. C1 站点订正 8 INSERT/6 文件逐条 line（F8）。

## 切片（修正稿 §8，经裁定微调）
A1/A2（artifact create-event + lifecycle 事件化）· B1/B2（body_blocks_edit + note_refine_apply fold）· C1→C2→C3（question_block create + edit_question_block_structured + merge）· D（owner-gated flip）。全 `Refs YUK-471`，gated on Wave 2 落地。
