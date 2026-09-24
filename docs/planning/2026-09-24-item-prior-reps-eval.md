# YUK-1034 — feature→b 重复采样 median 聚合评测报告

Date: 2026-09-24 · Branch: `yuk-1034-prior-reps` · Base: `origin/main @ 769a016d6`
Ticket: YUK-1034（YUK-376 eval 建议②的落地：同法 N 次采样取 b_logit median 降噪，opt-in `reps`）
Evidence: [`docs/planning/evidence/2026-09-24-item-prior-reps-eval-actual.json`](evidence/2026-09-24-item-prior-reps-eval-actual.json)
前置评测: [`docs/planning/2026-09-23-llasa-prior-eval.md`](2026-09-23-llasa-prior-eval.md)

## 结论（TL;DR）

**median-of-3 把估计量离散度约减半：within-question SD mean 0.397 → 0.199（median 0.361 → 0.173），配对 mean 降幅 0.199 logit（ratio 0.53）——达到并略优于 YUK-376 预测的 ~0.17 median SD，排序效度无损（Spearman 0.52 → 0.50）。**

reps=1 单次采样本轮基线 SD（mean 0.397 / median 0.361，n=9/题）略高于 376 封存值（0.298/0.276，n=3/题）——同一方法不同日的抽样波动 + n=9 对尾部 rep 覆盖更全；同 run 内的配对对比（median-of-3 vs 单样本）是干净证据，不跨 run 比绝对值。

建议：**生产 backfill 可启用 `reps: 3`**（`boss.send('item_prior_backfill', { reps: 3 })` 或后续把 cron/触发 data 带上），成本 ≈ +$0.0004/题（本轮实测 $0.00024/call × 3）；默认仍 1，是否翻默认由 owner 决定。

**后续（2026-09-24）：owner 已拍板翻默认——`item_prior_backfill` feature 路径默认 `DEFAULT_REPS=3`**，nightly cron（不带 job data）即跑 median-of-3；`{reps:1}` 保留单次调用 opt-out，`{reps:N}` 仍可覆盖（上限 MAX_REPS=9）。

## 实验设置

| 项 | 值 |
| --- | --- |
| 样本 | 本地 dev DB（Postgres :5433）真实题目 **30 题**，与 376 eval 同款按 kind 分层抽样（`ORDER BY id` 定序） |
| kind 分布 | choice 14 / computation 7 / short_answer 4 / fill_blank 3 / derivation 1 / true_false 1 |
| 设计 | 每题 **3 组 × 3 reps = 9 calls**（全 feature→b `ItemPriorTask`）；组内用 job 同款 `aggregateItemPriorRepDrafts` 折成 1 个 median |
| 执行路径 | 全部经 `runTask` → `PiAgentAdapter`（生产 runner 路径），非旁路 |
| provider / model / adapter | `xiaomi` / `mimo-v2.5-pro` / `pi`（本任务默认 lane，由 `ai_task_runs` 回查确认） |
| 调用量 / 成功率 | **270 calls，267 ok（98.9%）**——3 次 parse_failed（mimo JSON 非法转义/控制字符，已知失败模式），0 run_failed |
| 总成本 | **$0.0645**（mean $0.00024/call） |
| 封存 | 每条记录含 `task_run_id`、`input_digest`/`output_digest`（sha256）、`cost_usd`、`status`；commit `769a016d6` + dirty worktree（本票改动未提交时跑的） |

## 结果对比表

| 指标 | reps=1（单次采样估计量） | reps=3（median-of-3 估计量） |
| --- | --- | --- |
| within-question SD · mean | 0.397 | **0.199** |
| within-question SD · median | 0.361 | **0.173** |
| within-question SD · p90 | 0.601 | **0.356** |
| within-question SD · max | 0.851 | **0.681** |
| Spearman vs owner difficulty | 0.518 | 0.496 |
| vs stored `llm_prior` b · mean \|Δ\| | 0.332 | — |
| 每题 LLM 成本 | $0.00024 | $0.00072（×3） |

配对口径（30 题两种 SD 均可估）：median/single SD ratio mean = **0.534**，mean 绝对降幅 **0.199 logit**。

### 观察

- **降幅符合预期**：3 样本 median 对连续噪声分布的理论/经验压缩 ~0.6×，本轮实测 0.53×；median SD 0.173 与 376 报告预测 ~0.17 几乎重合。
- **失败 rep 丢弃机制实跑生效**：3 次 parse_failed 分散在 2 题的 2 个组，组内取幸存 2 样本的偶数 median，无组全败、无题丢失（`groups_all_failed` 全 0）。
- **排序效度不变**：median 聚合不伤害跨题排序信号（Spearman 0.518→0.496 在噪声范围内）。
- 冷启锚的实用含义：SD 0.17 logit ≈ 中点 P(correct) 扰动 ~0.04，对 n=1 冷启选题排序已属温和噪声；剩余误差由真实作答数据 + fixed-anchor 重标定兜底。

## 实现摘要（本票代码侧）

- `src/core/item-prior-reps.ts` — `aggregateItemPriorRepDrafts`：b_logit/confidence 取 median（偶数样本两中位均值），reasoning 取离 median 最近的 rep 原文 + provenance 后缀（`n/N 成功 + 各次 b_logit`）。
- `item_prior_backfill` job — `deps.reps` / job data `{reps:N}` opt-in：仅 feature 路径；逐 rep 独立 try/catch 丢弃失败，全败才跳过该题（沿用单题失败语义）；`source='llm_prior'` 不变；非法 reps 回退 1，上限 9。
- LLaSA 路径零改动（`method:'llasa'` + `reps>1` → warn 忽略 reps）。

## 验证与范围

- 本机 gates：`pnpm typecheck` ✅ / `pnpm build` ✅ / scoped unit（`item-prior-reps` 9）✅ / scoped DB（`item_prior_backfill` 11，含 4 个 reps 用例）✅ / `audit:partition` ✅ / Biome ✅
- 完整 test gate 由 push 后 exact-head `CI Gate` 执行（仓库约束，本机不跑 full `pnpm test`）。
- 未触碰：`question.kind`/`answer_class`、LLaSA 路径、QuestionDetailPage、dependabot.yml；无新 provider/新 task kind；`item_calibration` 表结构零改动（provenance 进 reasoning 字段，不落列）。
