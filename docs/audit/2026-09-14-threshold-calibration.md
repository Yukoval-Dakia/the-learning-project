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
  6 个概率论子树，domain=general）；`question` 58 题，embedded 42，其中 tagged 39、
  pool-visible（非 draft）16；`experimental:auto_tag_kc_created` 事件 **0** 条（统一标注轴
  尚未在本库产过 auto-created KC，dedup 的生产扫描总体为空）。
- **口径**：Axis A 镜像 `tagKnowledge` 决策形（先做 effective-domain subject-scope，再
  「最近域内候选 ≤ 阈值 → MATCH」；target domain 用题目 primary KC 的 effective domain 代理）。
  Axis B 全量 KC↔KC 无序对。Axis C 的 question↔question 用同-KC 题对为正例、跨池最近题为
  负例；query→question 一侧用 KC→own/unassigned 题距离做 KC-中心 query 代理。
- **已知口径偏差**：库存 `question.embedding` 嵌的是 `questionEmbedText` 全字段
  （prompt+reference+choices），生产 `tagKnowledge` 只嵌 prompt——偏差同向作用于正/负两侧，
  但绝对距离不可与探针直接对齐。Axis C 的 query 代理是 KC 标签向量，不是真实 demand 文本。

## Axis A — `MATCH_THRESHOLD = 0.55`（tagging-flags.ts / `TAGGING_MATCH_THRESHOLD`）

| 分布 | n | min | p25 | p50 | p75 | p90 | max |
|---|---|---|---|---|---|---|---|
| q→assigned KC（正例对） | 41 | 0.338 | 0.467 | 0.534 | 0.568 | 0.599 | 0.642 |
| q→最近域内 assigned KC | 39 | 0.338 | 0.449 | 0.526 | 0.564 | 0.582 | 0.642 |
| q→最近域内非 assigned KC（rival） | 39 | 0.438 | 0.507 | 0.545 | 0.579 | 0.618 | 0.639 |
| q→最近域内 KC overall | 39 | 0.338 | 0.436 | 0.499 | 0.549 | 0.569 | 0.613 |

- 正例 ≤0.55 占 61.0%，≤0.65 才 100%；rival ≤0.55 占 56.4%——正负侧在本语料上**有重叠**，
  不存在干净分界（neg p10=0.466 < pos p90=0.599）。
- 当前阈值实测分解（n=39）：**correct-accept 22 / wrong-accept（误标）9 /
  有真 KC 却被 propose 8 / 无可匹配正常 propose 0**；hit@1 = 27/39（69%）。
- 解读：8 题真归属 KC 距离 >0.55 → 走 propose 产重复 KC（文档化非破坏失败，dedup lane 兜）。
  9 个 wrong-accept 是**排序失败**（最近 KC 本就不是归属 KC），阈值再紧只是把它们从「静默误标」
  转成「propose 新 KC」。放宽到 ≥0.62 能收回全部 hit@1（27 题），但 wrong-accept 涨到 12。
- **结论：维持 0.55。** 在当前 n 下没有占优的移动方向：收紧把排序失败变成 propose（重复 KC
  可见可审），放宽把更多误标静默放行。0.55 落在正例 p50(0.534)–p75(0.568) 之间，方向与 n=6
  探针一致；正负侧距离带虽有重叠，真正保精度的是 nearest-first 排序（hit@1=69%）而非阈值
  本身——移动阈值改变的是「谁被放行」，不是「谁排第一」。语料长大或换 concept-projection
  对称 embed 后再复测（docblock 里记的同一条 refinement）。

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
| 同-KC 题↔题对 | 20 | 0.232 | 0.351 | 0.420 | 0.459 | 0.556 | 0.613 |
| 题→最近跨池题（负例） | 16 | 0.319 | 0.348 | 0.371 | 0.442 | 0.469 | 0.498 |
| KC→own 题（query 代理正例） | 16 | 0.338 | 0.457 | 0.520 | 0.570 | 0.609 | 0.639 |
| KC→最近未归属题（负例） | 12 | 0.280 | 0.419 | 0.492 | 0.562 | 0.679 | 0.754 |

- 当前 0.35 下：同-KC 题对只有 25% 入阈；query 代理正例只有 6.3% 入阈。5 个有池题的 KC
  实测：**serve-own 1 / serve-wrong 0 / starved 4**——即 80% 的需求在 0.35 下拿不到候选，
  全部落残余生成（这正是「宁残余不塞次品」的设计兜底，不是静默错误）。
- 但负例 floor 已到 0.28：放宽到 0.45 会开始吃进未归属题，本语料上没有安全的放宽余量。
- **结论：维持 0.35。** 该路径当前无 live 调用方（matcher-flags.ts 自注 dormant；饥饿的
  代价是走残余生成，是设计内保守偏置）。本回放记录下「偏紧」信号：若 matcher() 接
  live caller 后饥饿率过高，按同-KC p75≈0.46 / KC→own p75≈0.57 考察 0.45–0.55 带，
  同时盯负例 floor（当前 0.28）别被吃进去。

## 复跑

```bash
# 本机 dev compose（本报告口径）
DATABASE_URL='postgres://loom:loom@127.0.0.1:5433/loom' pnpm audit:threshold-calibration
# 指向只读 role/副本（推荐对重语料库）
AUDIT_READ_DATABASE_URL='postgres://<read-only-dsn>' pnpm audit:threshold-calibration
pnpm audit:threshold-calibration -- --json   # 机器可读
```

## 遗留

- 语料 n 小（KC 12 / tagged 题 39 / pool 题 16），所有结论标注为薄证据；生产 NAS 库本机
  不可达，待能在有真语料的库上重跑后复核三条结论。
- `docs/design/2026-06-22-unified-tagging-axis.md` 与 `docs/superpowers/plans/*` 里的
  YUK-396 引用属历史快照（记录的是当时归属），未改动；src/ 内剩余 YUK-396 均为
  poolFetch/matcher 的 Phase-1 增量归属，非标定语义。
- `auto_tag_kc_created` 事件为 0 → Axis B 的生产扫描总体为空；等统一标注轴真实产出
  auto-created KC 后重跑，dedup 分布才有生产口径的 n。
