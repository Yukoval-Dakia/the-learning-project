# YUK-1647 — harness 计分板 M3/M4/M5 真实口径与 10-07～10-18 重算交接

2026-10-21 · 实施记录。权威指标定义：`docs/adr/0075-agent-harness-contract.md` D7「指标（M1–M7）」。设计稿在仓库外，本文件只引用 ADR 摘要，不复制设计稿正文。

## 范围

- 把 `harness_scoreboard` 的 M3/M4/M5 从「每个指标一个代理定义」改成 ADR 的逐任务 / 逐子项定义。M3/M4/M5 的载荷改为 `parts[]`，每项独立给出 `numerator`/`denominator`/`value`/`basis`/`note`。
- M1、M2、M6 的定义与取值方式不变。
- 10-07～10-18 的 M1–M6 重算：**NOT_RUN**（本机无 TEST 数据库访问，未读取任何凭据）。执行步骤与比对模板见下文。
- 不新增测试，不跑付费调用，不改 TEST 配置 / 部署。

## 实现口径

所有数值由原始表确定性折叠，零模型调用。`basis=measured` 表示该子项在下列定义下由原始表完整决定；`proxy` 表示只能用近似原始信号且 note 写明差异；`unavailable` 表示现有表无法回答。

### M3 被丢弃的付费产出（`m3_dropped_paid_output.parts`）

| key | 分子 / 分母 | 原始表 | 口径 |
|---|---|---|---|
| `quiz_gen_batches` | 丢弃批次数 / 终止批次数 | `event`（`experimental:quiz_gen`） | 终止 = `outcome ∈ success,failure`。失败且 `failure_stage ∈ {event,dispatch}` 时题面已持久化，不算丢弃；`plan/producer/persist` 失败计入丢弃。 |
| `source_consistency_questions` | 被拒题数 / 有终判题数 | `event`（`experimental:source_verify`，`subject_kind='question'`） | 同一题在窗口内任一终判为 `failure` 即计为被拒；`outcome=error`（瞬态）不计入分子或分母。 |
| `note_generation_attempts` | 失败尝试数 / 终止尝试数 | `event`（`experimental:artifact_lifecycle`，`actor_ref='note_generate'`，`op='set_generation_status'`，`generation_status ∈ {ready,failed}`） | 每次付费生成尝试一条终态迁移，重试分别计数。 |
| `knowledge_review_writes` | 未落地写入数 / 写入尝试数 | `tool_call_log`（`task_kind='KnowledgeReviewTask'`，propose 工具） | 落地 = 无 `error_reason` 且确实写入提案事件：共享工具 `status='proposed'`；旧 `write_proposal` 为 `kind='tree_mutation'` 且带 `proposal_id`，或 `kind='knowledge_edge_propose'` 且带 `event_id`（成功边写入没有 `proposal_id`）。`skipped_duplicate` / `skipped_cooldown` / `rubric_rejected` 不落地。`1 - value` 即 KR 写入成功率。 |

### M4 收件箱积压（`m4_inbox_backlog.parts`）

`pending` / `oldest_pending_days` / `closable` / `conflict_involved` 均基于 **窗口结束时刻** 的收件箱投影：复用 `kernel/proposals/inbox` 的 `listProposalInboxRows({status:'pending', asOf:to})`，只计 `to` 之前创建的 propose、rate、correction，避免今天已裁决的条目把 10-18 的积压重算没了。`closable` 与 block_merge 的可裁决性仍读当前行（历史行状态不可回放，见「已知边界」），因此 `closable` 恒为 `basis: 'proxy'`；pending 集含 block_merge 时，`pending` / `oldest_pending_days` 也标 `proxy`。

- `pending`：该投影下仍 pending 的行数（admissible block_merge 过滤沿用现有投影）。
- `oldest_pending_days`：最老 pending 行到 `to` 的天数。
- `closable`：被引用知识点缺失/已归档、`expected_version` 与当前版本不符、或 `knowledge_edge` 归档目标已不存在的 pending 行数。其余「已满足」类别（例如 `block_merge`、`question_draft` 已提升）尚未纳入该谓词。
- `conflict_involved`：与另一条 pending 行共享至少一个被引用知识点的行数；覆盖 `knowledge_node`、`knowledge_mutation`、`archive`、`knowledge_edge`、`image_candidate`、`question_draft`、`goal_scope`，`conjecture` 指向心智模型不计入；分母 = 引用了这些知识点的 pending 行数。

10-18 审查报告的「可关 9 条」「17/26 卷入冲突」是人工读数，本实现给的是确定性谓词；两者定义不同，重算时按「定义差异」记录 delta，不调参凑数。

### M5 重复率（`m5_duplicate_rate.parts`）

| key | 分子 / 分母 | 原始表 | 口径 |
|---|---|---|---|
| `new_question_duplicates` | 重复题数 / 窗口新建题数 | `event`（`experimental:question_draft_submit` 回执、`experimental:quiz_gen`）+ `question.created_at` | 重复 = 提交回执 `status='conflict'` 且 `reason ∈ {duplicate_exact,duplicate_source,near_dup}` + QuizGen `exact_duplicate_count`；同一逻辑提交只计一次（候选提交内层 `${request_id}:submit` 回执折入外层调用方回执）。分母 = 窗口内 `question` 行数（含 draft；提升不改 `created_at`）。比值可超过 1。 |
| `same_name_same_parent_pairs` | 双胞胎对数（gauge） | `knowledge`（窗口内 `created_at`） | 按 `lower(trim(name)) + parent_id` 分组，每组多出的行数即对数；与旧代理「仅同名」的区别是同父约束。 |

## 10-07～10-18 重算（NOT_RUN，待 owner 批准）

本机没有只读 TEST 连接，本 PR 也不申请用任何凭据访问 TEST；重算待 owner 批准后由有 TEST 访问权限的人执行。

前置条件：可读 TEST Postgres 的连接串（只读角色即可；本仓库不保存也不接受任何凭据）。命令只读；`--persist` 会写一条 `experimental:harness_scoreboard` 投影，**重算比对时不要加**。

```bash
export PATH=/workspace/el/toolchain/pnpm-shim:/workspace/el/toolchain/node22/bin:$PATH
DATABASE_URL='postgres://<read-only-user>:<password>@<test-host>:5432/<test-db>' \
  pnpm --silent harness:scoreboard --from 2026-10-07 --to 2026-10-18 \
  > /tmp/yuk1647-scoreboard-20261007-20261018.json
```

验证输出：`head -c 1` 应为 `{`；JSON 的 `version` 为 `2`，`window.from_day/to_day` 为 `2026-10-07` / `2026-10-18`。失败时 CLI 以非零退出并打印到 stderr。

### 比对模板（执行人填写）

差值规则（本票采用）：比例类子项按百分点比较（review 的百分比 vs `value*100`），计数 / 天数类 gauge 按相对差 `|recomputed-baseline|/baseline`。M4 `closable` 的基线是条数，比对用 `numerator`；`conflict_involved` 的基线是比例，比对用 `value`。超过 2% 的每一项必须写原因（定义差异或数据缺失），不得改口径凑数。

| 指标 / 子项 | ADR-0075 基线（10-07～10-18） | 重算值 | 差值 | 是否 ≤2% | 原因（超差必填） |
|---|---|---|---|---|---|
| M1 零产出 token 占比 | ≥40%（164.4 M / 411.2 M） | NOT_RUN | — | — | — |
| M2 打转运行数（按 task_kind） | KR 271、Copilot 48、RM 19；失控 4 | NOT_RUN | — | — | — |
| M3 `quiz_gen_batches` | 55% | NOT_RUN | — | — | — |
| M3 `source_consistency_questions` | 68/198（34.3%） | NOT_RUN | — | — | 口径：按题终判；review 按检查/题计数未在 ADR 展开 |
| M3 `note_generation_attempts` | 24/31（77.4%） | NOT_RUN | — | — | 口径：按付费尝试；review 可能按 artifact 终态 |
| M3 `knowledge_review_writes` | 748/748（100% 丢弃，成功率 0%） | NOT_RUN | — | — | 口径：propose 工具调用落地率 |
| M4 `pending` | 45 | NOT_RUN | — | — | as-of 10-18 收件箱投影 |
| M4 `oldest_pending_days` | 9.6 | NOT_RUN | — | — | — |
| M4 `closable` | 9 | NOT_RUN | — | — | 人工读数 vs 确定性谓词，定义差异须单列 |
| M4 `conflict_involved` | 17/26（65.4%） | NOT_RUN | — | — | 人工冲突分析 vs 共享知识点谓词 |
| M5 `new_question_duplicates` | 48/276（17.4%） | NOT_RUN | — | — | 分子含提交回执 + QuizGen exact duplicate |
| M5 `same_name_same_parent_pairs` | 6 对 | NOT_RUN | — | — | 旧代理仅同名；本实现要求同父 |
| M6 空闲日花费 | 约 57 M / USD 1.63 每天 | NOT_RUN | — | — | 空闲日 = 零 `actor_kind='user'` 事件 |

重算完成后把结果 JSON 与填好的表放到仓库外 artifact 目录，并在 YUK-1647 回填路径与 SHA256；仓库内只保留这张表与结论。

## 本机验证（合成数据，不是 TEST 重算）

在 `/tmp` 起一次性 PG17 + pgvector，跑完全部 drizzle migration，再插入覆盖各分支的合成行，用同一 CLI 实际执行 `--from 2026-10-07 --to 2026-10-18`：

- M3：QuizGen 1/4（`dispatch` 失败已持久化被排除）、source_verify 2/3（一题失败后成功仍计被拒，`error` 排除）、笔记 2/3、KR 2/3（error / skipped / proposed 各一）。
- M4：`asOf` 后 pending 6（窗口后 accept 的仍计入；窗口前 accept 的排除）、最老 12 天、`closable` 1/6（expected_version 失配）、`conflict_involved` 4/4（共享 k1/k3）。
- M5：提交回执 2 条重复 + QuizGen exact 1，新建题 4 → 3/4；同父同名 1 对。
- `--persist` 写出 `harness_scoreboard_v2_2026-10-07_2026-10-18`（payload version=2），重复执行仍只有 1 行；`readLatestHarnessScoreboard` 解析成功并返回四个 M4 part。

合成行只用于证明查询语义与读写链路，不代表 TEST 真实数值；TEST 重算仍为 NOT_RUN。

## 已知边界

- **M1**：`empty` 产出尚无独立 outcome 列（ADR C2-3 属 P2），分子只含 `status='failure'`；定义未扩展。
- **M4 历史回放**：propose/rate/correction 可 as-of；block_merge 可裁决性与知识点版本读当前行，若窗口结束后目标被归档/改版，`closable` 会漂移，pending 集含 block_merge 时积压数也会漂移。日更同样读当前行，只是窗口结束到运行之间的时间差更短，不能说「不受影响」。
- **M4 人工读数**：`closable`、`conflict_involved` 是可复算的确定性定义，不承诺与 review 的 9 / 17 逐条相同。
- **M5 分母**：`question.created_at` 含 draft；draft 提升不改 `created_at`，所以「新入库」按新建行近似。
- **M2**：ADR 基线是三个任务的具体计数；`by_task` 的 key 是 `task_kind`，比对时需按任务名映射。
- **M7**：guard 触发数尚未记账（P2 RunMonitor 落地后才有），不在本次 M1–M6 重算范围。

## Follow-ups

- C4-4③ 读侧「目标不存在/版本不匹配/已满足」统一折叠实现后，把 M4 `closable` 切到该 owner，删除本地谓词。
- M1 的 `empty` 产出需要 C2-3 的 `outcome` 列；在此之前 M1 保持 failure-only。
- `question_draft_submit` 回执已在 M5 读取侧按逻辑 `request_id` 去重（候选提交的 `:submit` 内层回执折入外层调用方回执），回执写入语义未改；若未来出现同一逻辑提交换 `request_id` 重试，仍需另定归并键。
