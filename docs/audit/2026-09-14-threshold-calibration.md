# 2026-09-14 — Embedding 余弦距离阈值标定回放（YUK-677）

三个 embedding 余弦距离阈值全部自标 UNTUNED，且标定 follow-up 一直寄挂在 YUK-396（poolFetch
算子票，从未含标定 scope——孤儿引用）。本票把引用重锚到 YUK-677，并落地 report-only 回放脚本
`pnpm audit:threshold-calibration`（`scripts/audit-threshold-calibration.ts`）：只 SELECT、内存
里重放余弦距离、永不写库永不翻阈值。连接走 `AUDIT_READ_DATABASE_URL`（未设则回落
`DATABASE_URL`），会话层钉死 `default_transaction_read_only=on`（已实测 CREATE TEMP TABLE 被拒）。

## 语料与口径

- **数据源**：本机 dev compose Postgres（`127.0.0.1:5433`）。生产 NAS 库只在 compose 内网
  `postgres:5432` 暴露，本机不可达——本报告如实基于可得语料，n 偏小，结论按薄证据写。
- **语料**：`knowledge` 12 节点（全部 active+embedded：3 学科 root + 3 个 YUK-792 E2E canary +
  6 个概率论子树，domain=general）；`question` 62 题，embedded 42，其中 tagged 39、
  非 draft 16（draft 26 也含 embedding）；`experimental:auto_tag_kc_created` 事件 **0** 条
  （统一标注轴尚未在本库产过 auto-created KC，dedup 的生产扫描总体为空）。
- **口径**：Axis A 逐拍镜像 `tagKnowledge`——先全局最近邻检索 `RETRIEVAL_TOP_K=10`
  （`matchKnowledgeBySimilarity`），再在窗口内做 effective-domain subject-scope，最后
  「最近域内候选 ≤ 阈值 → MATCH」（target domain 用题目 primary KC 的 effective domain 代理；
  窗口外才出现的域内真 KC 记 retrieval-starved，不许计入 accept）。Axis B 全量 KC↔KC 无序对。
  Axis C 逐拍镜像 matcher 召回：`poolFetch(knowledgeId, activeOnly:false)` 的候选集按定义只有
  **携带该 KC 的题**（`knowledge_ids @> [knowledgeId]`，draft 含在内——draft 走 lazy
  verify-promote，是真实候选），跨 KC「误服」在本路径结构性不可能，**不存在负例分布**；
  阈值只交换「池内供应 vs 残余生成」。query→question 一侧用 KC 标签向量→own 题距离做
  KC-中心 query 代理（真实 demand 是自由文本，语料里不存在）。
- **已知口径偏差**：库存 `question.embedding` 嵌的是 `questionEmbedText` 全字段
  （prompt+reference+choices），生产 `tagKnowledge` 只嵌 prompt——偏差同向作用于正/负两侧，
  但绝对距离不可与探针直接对齐。Axis C 的 query 代理是 KC 的 `name\ndomain` 标签向量，
  大概率**高估**真实 demand 文本到目标题的距离（真实查询通常比 KC 标签更贴近题面措辞）。

## Axis A — `MATCH_THRESHOLD = 0.55`（tagging-flags.ts / `TAGGING_MATCH_THRESHOLD`）

| 分布 | n | min | p25 | p50 | p75 | p90 | max |
|---|---|---|---|---|---|---|---|
| q→assigned KC（正例对，全量） | 41 | 0.338 | 0.467 | 0.534 | 0.568 | 0.599 | 0.642 |
| q→最近域内 assigned KC（top-10 窗口内） | 39 | 0.338 | 0.449 | 0.526 | 0.564 | 0.582 | 0.642 |
| q→最近域内非 assigned KC（rival，窗口内） | 39 | 0.438 | 0.507 | 0.545 | 0.579 | 0.618 | 0.639 |
| q→最近域内 KC overall（窗口内） | 39 | 0.338 | 0.436 | 0.499 | 0.549 | 0.569 | 0.613 |

- 正例 ≤0.55 占 61.0%，≤0.65 才 100%；rival ≤0.55 占 56.4%——正负侧在本语料上**有重叠**，
  不存在干净分界（neg p10=0.466 < pos p90=0.599）。
- 当前阈值实测分解（n=39，窗口=全局 top-10 → 域内过滤）：**correct-accept 22 /
  wrong-accept（误标）9 / 窗口内真 KC >T 被 propose（threshold-starved）8 /
  真 KC 被挤出 top-10（retrieval-starved）0 / 无可匹配正常 propose 0**；hit@1 = 27/39（69%）。
- 窗口截断在本语料未改变任何决策（retrieval-starved=0，12 KC 下 top-10 近乎全覆盖），但语义
  已与生产逐拍对齐——语料长大后该偏置不再静默累积。
- 解读：8 题真归属 KC 距离 >0.55 → 走 propose 产重复 KC（文档化非破坏失败，dedup lane 兜）。
  9 个 wrong-accept 是**排序失败**（最近 KC 本就不是归属 KC），阈值再紧只是把它们从「静默误标」
  转成「propose 新 KC」。放宽到 ≥0.62 能收回全部 hit@1（27 题），但 wrong-accept 涨到 12。
- **结论：维持 0.55。** 在当前 n 下没有占优的移动方向：收紧把排序失败变成 propose（重复 KC
  可见可审），放宽把更多误标静默放行。0.55 落在正例 p50(0.534)–p75(0.568) 之间，方向与 n=6
  探针一致；正负侧距离带虽有重叠，真正保精度的是 nearest-first 排序（hit@1=69%）而非阈值
  本身——移动阈值改变的是「谁被放行」，不是「谁排第一」。语料长大（top-K 截断开始咬合）或
  换 concept-projection 对称 embed 后再复测（docblock 里记的同一条 refinement）。

## Axis B — `DEDUP_DISTANCE_MAX = 0.10`（dedup-flags.ts / `KC_DEDUP_DISTANCE_MAX`）

| 分布 | n | min | p05 | p10 | p25 | p50 | p75 | p90 | max |
|---|---|---|---|---|---|---|---|---|---|
| KC↔KC 全对 | 66 | 0.0065 | 0.158 | 0.215 | 0.344 | 0.565 | 0.613 | 0.714 | 0.792 |
| 同 domain 子集 | 21 | 0.0065 | 0.0075 | 0.011 | 0.189 | 0.247 | 0.316 | 0.494 | 0.512 |
| 触 auto-created KC 的对（生产扫描总体） | 0 | — | — | — | — | — | — | — | — |

- 唯一 ≤0.10 的簇是 3 个 YUK-792 canary KC（名字近似、同一 domain，距离 0.0065–0.0109）——
  真近重复；**次近对在 0.1483**，elbow gap 0.011→0.148（13× 间隔）。
- 当前 0.10 只放进 4.5% 的全对、且全部是真近重复；生产窗口径（近窗 auto-created）当前为
  空集，nightly 不会产提议。
- **结论：维持 0.10。** 它干净落在「真重复簇 ≤0.011 / 真实异构对 ≥0.148」的间隔里，双侧
  余量都大；human accept gate 还在下游。收紧到 0.05 也仍能抓到该簇，但没有证据驱动去改。

## Axis C — `MATCHER_COSINE_MAX_DISTANCE = 0.35`（matcher.ts，硬编码常量）

| 分布 | n | min | p25 | p50 | p75 | p90 | max |
|---|---|---|---|---|---|---|---|
| 同-KC 题↔题对（pool 内聚度） | 104 | 0.156 | 0.342 | 0.407 | 0.474 | 0.565 | 0.625 |
| KC→own 题（query 代理，即召回池候选距离） | 41 | 0.338 | 0.467 | 0.534 | 0.568 | 0.599 | 0.642 |

- 召回池 = 全部 42 道 embedded 题（draft 含在内，对齐 `activeOnly:false`）；有池题的 KC 9 个。
- 当前 0.35 下：同-KC 题对 28.8% 入阈、≤0.45 升至 62.5%；KC→own 代理距离只有 **2.4%** 入阈、
  ≤0.45 才 24.4%、≤0.55 为 61.0%。9 个有池 KC 实测：**servable 1 / starved 8**——即约 89%
  的需求在 0.35 下拿不到任何候选，全部落残余生成（这正是「宁残余不塞次品」的设计兜底，
  不是静默错误）。
- **本轴没有负例侧**：`poolFetch` 的 `knowledge_ids @> [knowledgeId]` 让跨 KC 题永远进不了
  候选集，「放宽阈值吃进未归属题」在本路径不可能发生（此前报告里的负例 floor 口径描述的是
  不可达结果，已更正）。放宽的真实代价是**用同 KC 内语义更弱的题顶替残余生成**——质量
  折衷，不是错 KC。
- **结论：维持 0.35，但理由改写。** 该路径当前无 live 调用方（matcher-flags.ts 自注
  dormant）；饥饿的代价是走残余生成，是设计内保守偏置而非故障。serve-side 证据（KC→own
  p50–p90 ≈ 0.53–0.60）提示若按 KC 标签代理放宽需到 ~0.55 才能让多数池候选入阈——但该代理
  相对真实 demand 文本系统性偏松，**不应据代理数字预放宽**。正确动作是等 matcher() 接
  live caller 后用**真实 demand query embedding** 重跑本回放，再按实测饥饿率评估
  0.45–0.55 带；同-KC 题对内聚度（p50≈0.41）说明若 demand 措辞贴近题面，0.35–0.45 已有
  约三成到六成池内覆盖。

## 复跑

```bash
# 本机 dev compose（本报告口径）
DATABASE_URL='postgres://loom:loom@127.0.0.1:5433/loom' pnpm audit:threshold-calibration
# 指向只读 role/副本（推荐对重语料库）
AUDIT_READ_DATABASE_URL='postgres://<read-only-dsn>' pnpm audit:threshold-calibration
pnpm audit:threshold-calibration -- --json   # 机器可读
```

## 遗留

- 语料 n 小（KC 12 / tagged 题 39 / embedded 题 42 含 draft），所有结论标注为薄证据；生产
  NAS 库本机不可达，待能在有真语料的库上重跑后复核三条结论。
- Axis A 已按生产逐拍口径加 retrieval-starved 计数；本语料下为 0，语料长大或 top-K 收紧后
  该计数若抬头，说明窗口先于阈值成为瓶颈，复测时应一并报告。
- Axis C 的 query 代理（KC 标签向量）系统性高估真实 demand 文本距离；matcher() 接 live
  caller 后应改用真实 demand query embedding 重跑（当前语料里不存在该数据，未虚构）。
- `docs/design/2026-06-22-unified-tagging-axis.md` 与 `docs/superpowers/plans/*` 里的
  YUK-396 引用属历史快照（记录的是当时归属），未改动；src/ 内剩余 YUK-396 均为
  poolFetch/matcher 的 Phase-1 增量归属，非标定语义。
- `auto_tag_kc_created` 事件为 0 → Axis B 的生产扫描总体为空；等统一标注轴真实产出
  auto-created KC 后重跑，dedup 分布才有生产口径的 n。
