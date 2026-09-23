# YUK-376 — LLaSA 冷启动难度锚点评测报告

Date: 2026-09-23 · Branch: `yuk-376-llasa-prior` · Base: `origin/main @ de83dce59`
Ticket: YUK-376（ItemPrior 冷启动 b 锚点：LLaSA 模拟学生反推法，opt-in 变体 + actual-output 评测）
Evidence: [`docs/planning/evidence/2026-09-23-llasa-prior-eval-actual.json`](evidence/2026-09-23-llasa-prior-eval-actual.json)
Spike/ADR: `docs/design/2026-06-15-b-anchor-feasibility-spike.md`、`docs/adr/0043-difficulty-data-driven-recalibration.md`

## 结论（TL;DR）

**闸门回答：feature→b 的重复采样噪声真实存在但属中等（median within-question SD ≈ 0.28 logit，p90 ≈ 0.51），且候选替代方案 LLaSA 在所有测量维度上全面更差——采纳门槛未满足，默认 feature→b 保持不变。**

具体：LLaSA 的 within-question SD 是 feature 的约 **2.1×**（mean 0.62 vs 0.30），与 owner difficulty 的 Spearman 排序相关 **0.28 vs 0.58**（更弱），90 次调用中 **7 次失败（7.8%）**（5× budget timeout + 2× JSON parse），单次成本约为 feature 的 **5.8×**。两法 Spearman 仅 0.28，说明 LLaSA 并没有在测量同一个潜变量上做得更好。

本票交付物为 **opt-in** 变体（`ItemPriorLlasaTask` + backfill `method: 'llasa'`），默认路径逐字节未动；是否启用由 owner 决定，本报告建议 **不启用**（保留代码路径供未来 revisiting）。

## 实验设置

| 项 | 值 |
| --- | --- |
| 样本 | 本地 dev DB（Postgres :5433）真实题目 **30 题**，分层抽样 |
| kind 分布 | choice 14 / computation 7 / short_answer 4 / fill_blank 3 / derivation 1 / true_false 1 |
| difficulty 分布 | 1×4 / 2×14 / 3×10 / 4×2 |
| 已有 stored `llm_prior` b | 25/30 题 |
| 方法 | `feature`（现状 feature→b，`ItemPriorTask`）vs `llasa`（`ItemPriorLlasaTask`，5 能力档模拟 → 反推 b） |
| 重复次数 | 3 reps × 2 methods × 30 题 = **180 calls** |
| 执行路径 | 全部经 `runTask` → `PiAgentAdapter`（生产 runner 路径），非旁路 SDK |
| provider / model / adapter | `xiaomi` / `mimo-v2.5-pro` / `pi`（本任务默认 lane） |
| 总成本 | **$0.1279**（feature $0.0200 / 90 calls；llasa $0.1078 / 85 calls） |
| 封存 | 每条记录含 `task_run_id`、`input_digest`/`output_digest`（sha256）、`cost_usd`、`status` |

## 结果对比表

| 指标 | feature→b（默认） | llasa（opt-in） |
| --- | --- | --- |
| 调用成功率 | **90/90 (100%)** | 83/90 (92.2%) — 5× budget_timeout + 2× JSON parse |
| within-question SD · mean | **0.298** | 0.623 |
| within-question SD · median | **0.276** | 0.638 |
| within-question SD · p90 | **0.513** | 1.023 |
| within-question SD · max | **0.681** | 2.167 |
| Spearman vs owner difficulty (1–4) | **0.58** | 0.28 |
| vs stored `llm_prior` b · mean \|Δ\| | 0.37 | — |
| 单次成本 mean | **$0.00022** | $0.00127（≈5.8×） |
| 内部质量信号 | — | censored 3.6% / nonmonotone 1.2% |
| 跨方法 \|gap\| | mean 0.77 / median 0.67 / p90 1.66 | Spearman(feature, llasa) = 0.28 |

### 噪声形态观察

- **feature**：噪声呈连续分布，3 reps 的 b 通常在 ±0.5 内收敛（例：choice/diff4 `[-1.5,-0.8,-1.0]`）。0.3 logit 的 SD 约等于在 a=1 中点把 P(correct) 移动 ~0.07——对冷启动锚点而言是可测但不致误的扰动（下游有真实作答数据再校准兜底）。
- **llasa**：噪声呈**双峰形态**——6/30 题 3 reps 完全相同（SD=0，模拟概率网格粗→反推落到同一 knot，输出聚集在 -1.21 / -0.59 / 0 / 3 等量化值），而另一部分题 reps 间剧烈摆动（fill_blank/diff3 一题给出 `[-1.21, 3.0, 0]`，摆幅 4.2 logit）。低方差样本是「网格量化」而非「稳定收敛」，高方差样本则是模拟概率本身不一致。
- **失败模式**：5 次 `budget_timeout`（60s cap 内多档模拟推理跑不完）+ 2 次 `JSON.parse` bad-escape（模型在 JSON 字符串内输出非法转义，疑似 LaTeX 风格 `\x`）；feature 侧 0 失败。

## 闸门判定

票据要求先回答：**「当前 feature→b 在日常使用中的噪声是否确实过大？」**

- 噪声**存在且不可忽略**：median SD 0.28 / p90 0.51 logit，p90 以上样本的锚点偏移已足以影响冷启动选题。
- 但相对信号尺度不算失控：库存 b 的跨题 SD ≈ 0.74，noise/signal ≈ 0.4；且 fresh-run 与 stored b 的 mean \|Δ\| = 0.37，与自身噪声同量级——**已落库的 `llm_prior` 行仍具代表性，无陈旧漂移**。
- **采纳门槛未满足**：替代方案 LLaSA 噪声 2.1×、排序效度减半、失败率 7.8%、成本 5.8×。即便认为 feature 噪声偏大，LLaSA 也不是更优解。

## 建议

1. **默认保持 feature→b**（本 PR 未改默认）；LLaSA 代码路径保留为 opt-in（`method: 'llasa'`，provenance `llm_prior_llasa`），便于未来换 provider/调档数后复测。
2. 若 owner 想降 feature 噪声，更便宜的杠杆是 **同法多次采样取 median**（3 reps 可把有效 SD 压至 ~0.17，成本 +$0.0004/题），无需引入模拟反推链路。
3. 若未来 revisit LLaSA：需先解决 60s budget timeout（拆档并行/提 cap）、JSON bad-escape 容错、以及模拟档位粒度（当前 5 档导致量化 knot）；本 eval 数据可作为 baseline 对照。

## 验证与范围

- 本机 gates：`pnpm typecheck` ✅ / `pnpm build` ✅ / scoped unit（`item-prior-llasa` 8 + `item-prior` 12）✅ / scoped DB（`item_prior_backfill` 7）✅ / task-catalog·registry·census 153 ✅ / `audit:schema`、task-census、architecture-deepening、capability-boundary ✅
- 完整 test gate 由 push 后 exact-head `CI Gate` 执行（仓库约束，本机不跑 full `pnpm test`）。
- 未触碰：`question.kind` / `answer_class` / `QuestionKind` / question-kind.ts；无新 provider/SDK；`item_calibration` 表结构零改动（`source` 为 text 列，`llm_prior_llasa` 无需 migration）。
