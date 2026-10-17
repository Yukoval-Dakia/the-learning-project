# YUK-1516 — search_bank 向量检索计入阈值（与查重阈值分离）

日期：2026-10-17 · 阶段：第一天能用（W0）· 状态：已实施，参数 PROVISIONAL

## 问题（实测）

`search_bank` 通道 B 原先在 SQL 里复用查重常量 `MATCHER_COSINE_MAX_DISTANCE = 0.35`
（`src/capabilities/practice/server/quiz/matcher.ts:72`，question↔question 查重轴）。0.35 是
「同一道题」的判重档位，不是「同主题检索」档位。在 105 题真实题库副本（全部带有效
text-embedding-v4@1024 向量）上实测：

- 「文言断句 划分句子朗读停顿」：正确目标题距查询 **0.422**，第二名 0.675 → 被 0.35
  挡掉，向量通道零命中。
- 「离子方程式的书写与正误判断」（库中无化学题）：最近命中是无关数学题 **0.436**，
  第二名 0.546。

绝对距离分不开这两类（收 0.422 必收 0.436）；能分开的是 **top-1 领先幅度**：正确目标
领先 0.253，无关命中只领先 0.110。报告：
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-k7-paid-vector/report.md`。

## 规则 v1（`src/capabilities/practice/server/tools/bank-vector-retrieval.ts`）

1. **召回进候选池**：`distance ≤ BANK_VECTOR_RETRIEVAL_MAX_DISTANCE`（0.55，绝对天花板），
   取代查重 0.35 的池门角色。SQL 召回改为取最近 CAP+1 行（不设距离 WHERE）：判 margin
   需要全库真实 rank-2，哪怕它落在天花板之外。
2. **计入 coverage.verdict**：仅 rank-1，且需 **decisive**——存在 rank-2 且
   `rank2 − rank1 ≥ BANK_VECTOR_RETRIEVAL_TOP1_MARGIN`（0.15）。
   - drop-off 之后（≥δ 落后）的命中不是已证实的主题匹配；rank-1/rank-2 贴成簇
     （margin < δ）时无 decisive 证据——两者都只在候选列表展示
     （`match_evidence.counted=false`，语义同 fts weak），不抬 verdict。
   - 库内（硬过滤后、带向量）不足两题 ⇒ 无竞争者证据 ⇒ 不计入（保守）。
3. 选择 absolute-gap 而非 ratio 的理由：实测证据即以 gap 表述（0.253 vs 0.110，取中带
   0.15）；cosine 距离上 ratio 阈值在小距离端（近重复）与大距离端（压缩）都不稳定。

保守方向：拿不准时宁可 `none` + gap_request，不造 false `enough`。已知代价：多条同主题
题贴成簇时 margin 不满足 → 该主题保守判 none（gap 照发）；由标定数据决定是否调参或升
规则版本（`BANK_VECTOR_RETRIEVAL_RULE_VERSION`）。

## 查重 matcher 不动

`MATCHER_COSINE_MAX_DISTANCE = 0.35`、matcher 及其调用方一概未改；本变更移除的是
bank-search 对该常量的**误借用**（检索借用查重阈值正是缺陷本身）。

## 参数 PROVISIONAL

0.55 / 0.15（rule v1）以两组实测为锚，未经全量标定。lead 在真实题库副本上运行：

```bash
pnpm tsx scripts/calibrate-bank-vector-threshold.ts <labelled.json> --db-url <bank-copy-url>
```

（模板：`scripts/fixtures/bank-vector-calibration.sample.json`；脚本只读题库表，embed 走
既有 embedText 付费路径并留 provider-attempt 票据。）输出 present 主题的 query 级
precision/recall、absent 主题的 false-enough 率与全网格；据此修订常量须走代码 PR 并更新
本文档。

## 已知边界

- cursor schema 升 v3（pool 条目携带 `vd`/`vc`）：续页不 embed，向量距离与计入判定只能
  由游标还原；v2 游标（15 分钟 TTL）显式过期，重新检索即可。
- 标定脚本的可见性基线镜像引擎默认面（draft_state='all' + admission_state='any'），
  无 scope 专属过滤——标定的是向量轴本身。
