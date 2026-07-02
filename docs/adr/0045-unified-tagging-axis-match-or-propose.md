# ADR-0045 — 统一 match-or-propose KC 标注轴（tagging 轴重设计 + cold-start-bridge 解体）

**状态**：accepted
**日期**：2026-06-23 (YUK-489)
**Supersedes**：ADR-0026 §1–2（tagging/judge 置信门机制；§3–4 仍有效）
**Superseded by**：—
**Related**：ADR-0026（WorkflowJudge 置信门 + flag-gated 入库 — §3–4 复用）/ ADR-0024（`enrollCapturedBlock` 唯一入库 owner）/ ADR-0012（mastery as derived view）/ YUK-488（整页 holistic vision 判分 = performance 轴，与本轴正交）

> 权威设计底稿：`docs/design/2026-06-22-unified-tagging-axis.md`（owner-directed，4 路存活探针 + spot-check 坐实）。本 ADR 固化该设计的决策，不重复其全文。

## Context

标注（KC 归属）轴此前「每入口各搞一套」：auto-enroll 走 grid-snapshot `TaggingTask`（题面+网格→{suggestions,confidence}）经 WorkflowJudge 置信门（ADR-0026 §1–2）；冷启上传走 `cold-start-bridge`，由一个 `knowledge_ids:[]` 零匹配门触发（YUK-478）。该门基于**错误前提**——「thin-seed 树只有 subject-root → tagger 丢弃所有建议 → 零匹配」——实际 tagger 会匹配 root，零匹配窗口被永久关死，cold-start-bridge ① 近乎死代码。标注与判分（YUK-488）两轴此前耦合（答错→提议新 KC，YUK-482 已部分解除）。

KC/题库语义检索（`knowledge.embedding`/`question.embedding` vector(1024)，DashScope text-embedding-v4，nightly backfill）substrate 已就绪但 KC 侧零 `<=>` 读消费者。

## 决策

1. **统一 `tagKnowledge`（match-or-propose）** 替换 per-entry grid-tagging + cold-start-bridge ①。流程：embed 题面 → `matchKnowledgeBySimilarity`（KC 余弦 top-K，净新）→ effective-domain subject 过滤 → nearest `cosine_distance ≤ MATCH_THRESHOLD` ? **MATCH**（≥1 已有 KC）: **PROPOSE**（建子 KC）。判别式 union 输出，`propose` 恒产具体 KC id。
2. **embedding 语义检索驱动** match-vs-propose（owner 决策①）。`MATCH_THRESHOLD` 单旋钮（`tagging-flags.ts`，env-overridable，UNTUNED → YUK-396 标定；探针 n=6 实测 0.55，因 query=整题文本 vs KC=`name\ndomain` 非对称抬高距离）。
3. **新 KC 自动批准 + audit-only 留痕**（owner 决策③）：`applyProposeNew`（approved）+ `experimental:auto_tag_kc_created` 事件（`proposalWhere()` 不折叠 → 可查可审、非 pending inbox 项、无 acceptProposal 重放）。无人审墙、day-one 可用。
4. **跑全部题目创建入口**（owner 决策④）：auto-enroll ENROLL / image-candidate-accept / 手动 `/api/mistakes` / `/api/import`。auto-enroll ENROLL 合成 full-confidence `TaggingOutput` 喂现有 `runWorkflowJudge` 以保其结构不变（tagging 不再是路由不确定性来源；ADR-0026 §3 flag rollout + §4 入库 owner 不变）。OBSERVE 模式仍跑原 `TaggingTask`（零-mutation 探针）。mistakes/import 当前无 request 级 subject 信号 → 暂 ids-required（auto-tag 待 subject 信号 follow-up）。
5. **死的 `knowledge_ids:[]` 零匹配门移除**——`propose` 恒产 KC id，「空→不可见」失效模式结构性消除。
6. **subject 来源**：auto-enroll 无 `params.subjectId`（subject 是派生视图、不存储）时按 image-candidate-accept 方式经 cold-start-bridge **分类** subject → `seed:<subject>:root`，复用 bridge 名避免二次模型调用。
7. **dedup-on-maintenance**（owner 决策②，propose-only 兜底）：`kc_dedup_nightly`（确定性 cosine 自连接 over 近窗 auto-created KC → merge 提议，**绝不 auto-merge**，复用 live `applyMerge` accept 路径 + `experimental:kc_dedup_scan` 可观测）。
8. **cold-start-bridge 角色收窄**：保留为 subject 分类器 + `tagKnowledge` 命名引擎；其 ③ reference 生成**解耦**为独立 `reference_answer_backfill`（`reference_md IS NULL` nightly 触发，复用 `generateReferenceSolution`），与 KC 无关。

## 后果

- **正交性**：本轴（内容→KC ids，读题面）与 YUK-488 判分轴（整页 vision 判学生作答）正交，互不写对方的列。
- **铁律**：dedup auto-**approve** 用于*创建*（便宜、加性、可经 merge 回滚）；auto-**merge** 破坏性（archive from-KC + merged_from[] + 重写 9 个下游归属面：question/learning_item/goal knowledge_ids、knowledge_edge 端点、mastery/fsrs/axis/kc_typed 每-KC state、misconception edge target——YUK-543），永远人工 accept。
- **失败模式非破坏性**：阈值太紧→重复 KC（P5 dedup 兜）；太松→相关但不同的 KC 误提议（人工 dismiss）。
- 实现：P1 `matchKnowledgeBySimilarity`（#561）/ P2 `tagKnowledge`（#562）/ P3 接 4 入口 + 删死门（#566）/ P4a reference 解耦（#569）/ P5 `kc_dedup_nightly`（#570）。
- Follow-up：`MATCH_THRESHOLD`/`DEDUP_DISTANCE_MAX` 真语料标定（YUK-396）；mistakes/import 的 request 级 subject 信号以启用其 auto-tag。
