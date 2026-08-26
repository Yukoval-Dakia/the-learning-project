# YUK-839 acceptance #6 burn-in — 2026-08-26（zhipu / glm-5.3-flash）

## Decision

- **acceptance #6 在 zhipu / glm-5.3-flash 上：FAIL（不可达）。** 两次完整
  validator run（共 4 个 paid reference attempt，每个 480s durable budget）全部
  `budget_timeout` fail-closed，且 **零 accepted append**（points=0 /
  not_material=0 / safe_reply=0）。盲证据腿在该模型上从未提交过任何一次
  submission tool call。
- **Case b（checkpoint resume 注入）未执行：前置条件不可达。** resume 证明需要
  ≥8 条 accepted append 后中断重试；该模型在产品 durable budget 内 0 条 append，
  注入点永远不会出现。跑 case b 只会用 ~16 分钟复现已证明的零 append 结论。
- 这不是 validator bug、也不是 endpoint 缺陷：同 lane 的单工具 probe 证明
  glm-5.3-flash 的 tool-use 正常（`stop_reason:tool_use`，6.4s 完成）。失败模式是
  **真实 77KB validator 输入下 flash 模型持续 thinking 超过 480s 预算仍未发出首个
  submission**——模型能力/预算组合问题。validator 自身的 fail-closed 语义按设计
  正确执行（reference 失败 → `failed_closed`，而非 degraded）。
- sealed-checkpoint 机器的可观测部分被正确行使：每个 scope 各建 1 行 reference
  checkpoint（open），2 个 attempt 全部入账（`failed_permanent`/`budget_timeout`），
  零记录完整性保持（records/digests=0），无 phantom 记录、无重复计费。

## Reproducible boundary

- code revision：`codex/yuk-839-burnin-glm53flash` = `c1d4e81ef604caa948179449c29e26a4a52b900d`（base `origin/main`）
- provider/model：`zhipu / glm-5.3-flash`，endpoint `https://open.bigmodel.cn/api/anthropic`
  （providers.ts 既有注册；model id 原样被接受，probe 200，无需 casing 变体）
- Agent SDK：declared `^0.3.220`
- 隔离：独立 docker postgres（`pgvector/pgvector:0.8.2-pg16-bookworm`，127.0.0.1:5435，
  container `wt-burnin-pg`），完整 drizzle migration；不触碰主 repo 的 5433 实例与
  任何其他工作树。env 从主 repo `.env` 只读加载 `ZHIPU_API_KEY`（不打印）。
- 数据：`REALISTIC_EVIDENCE_TRACE`（A01/A03/A04/C01/C04，13 calls）+ 首 8 条重复 =
  21 successful reads（与 `DURABLE_TIMEOUT_TRACE` 同构，即 acceptance #6 指定的
  A01-equivalent fixture）；request_context / candidateReply 逐字取自
  `evidence-review.unit.test.ts` 的 `reviewParams()`。
- 透传 seam：harness 的 `runTaskFn` wrapper 仅追加
  `ctx.override = { provider:'zhipu', model:'glm-5.3-flash' }`，其余 ctx 原样交给
  production `runTask`；checkpointStore 用 delegating wrapper 只观察 append
  前后的 digests，不改变任何判定。
- 预算：`attemptTimeouts` 使用产品 durable 常量
  （reference 480s / comparison 360s）；本次没有任何抬高。
- 原始 harness/results/logs 留在本地 mode 0600 临时目录 `/tmp/yuk839-burnin`，不提交
  大 JSON；SHA-256 锁定：
  - harness 入口：`8003364667fe46689ee02f41fe112ad2b9c2cca952caf26b4e71ceac0cd9850f`
  - harness core：`173c32be3abe6b6ab2d86c9b1b84ce302ac987d1291193cfda3cc48d24116700`
  - tool-use 诊断 probe：`e024680779334fcf2b7f5e6f351d54f28515aa947c76d901bcdb64285e3b32b2`
  - probe results：`dfe90a9ead9c4965ed9bbe16657804ea1450191d710bf5eb77513e952bb7f326`
  - clean run 1 results：`5e96bab425859b612179185a78421834693fdf25282e811887770b14e063e697`
  - clean run 2 results：`c8eaf6347d9befd2a91ff2bb8b0618b251359830294a32bab08f6d4695948638`
  - clean run 1 log：`b9ccd6cee7ed0cf299c5e527cb11e38444d3759525bf5dbd94dd270b5700923f`
  - clean run 2 log：`98dd8ac80c10c4167f64b91a5b1ac95cfaeedbad1a5d48cf92e58523264c5c1a`

## Harness

`reviewCopilotEvidenceReply`（production import，无 mock）+ `createPgCopilotEvidenceCheckpointStore`
（真实 PG checkpoint store）+ `runTask`（production runner，仅 provider/model override）。
观察面：

1. `run_calls`：每次 paid call 的 kind / task_run_id / input_chars /
   checkpoint_resume 是否存在 / contract_feedback 是否存在 / 时长 / 错误。
2. `append_observations`：每次 append 的 offered 数、与 store 既有 digests 的重复数、
   新接受数、store 前后记录数（用于 case b 的"accepted 不重提"证明）。
3. 事后从 `ai_task_runs` / `cost_ledger` / `copilot_evidence_checkpoint` 全量取证。

## Per-case results

### Probe（3c）

- `glm-5.3-flash` 原样接受：`200`，usage `19 input / 8 output`，`stop_reason=max_tokens`。
- 补充 tool-use 诊断（同 lane 单次调用，带 1 个 tool 定义）：
  `stop_reason=tool_use`，正确调用 `submit_point("probe_ok")`，6.4s，
  usage `172 input / 43 output`。endpoint 的 tool 通道正常。

### Case a — clean run（×2，结论可复现）

| Run | scope | wall | 决策 | reference attempts | appends |
|---|---|---:|---|---|---|
| 1 | `yuk839_burnin_clean_1787756000989` | 973.6s | `failed_closed` | 2× `budget_timeout` | 0 |
| 2 | `yuk839_burnin_clean_1787758235982` | 967.3s | `failed_closed` | 2× `budget_timeout` | 0 |

两次 run 的 4 个 attempt 逐项同构（`ai_task_runs` 全量行）：

| task_run_id | attempt | 时长 | usage_json | cost |
|---|---|---:|---|---|
| `g8abn2eomki3rz77hy0yncqw` | run1-a1 | 489.4s | `{input:0,output:0,thinkingBlocks:2,thinkingCharacters:64916}` | null/unknown |
| `c75mfxq4mfqetcs1tfs9vryv` | run1-a2 | 483.4s | `{input:0,output:0}` | null/unknown |
| `kurn07lssrj0x12l358jgm6p` | run2-a1 | 484.1s | `{input:0,output:0,thinkingBlocks:1,thinkingCharacters:57975}` | null/unknown |
| `benfxfexwahgzeb8tmu1o8un` | run2-a2 | 483.0s | `{input:0,output:0}` | null/unknown |

- 每个 run 的 attempt 1 都观测到真实 provider 流（57,975–64,916 thinking chars），
  证明模型确实在处理 77KB 输入而非挂死；attempt 2 在 abort 前连 thinking 计数都
  未落地。token 计数为 0 是产品语义：usage 只在 SDK final result message 落账，
  budget abort 杀掉 CLI 后不可恢复——这正是 coding-plan lane 下真实消耗不可从
  产品表回收的已知形态；thinking 字符数是实际工作量的唯一在库证据。
- `cost_ledger`：4 行 `entry_kind=attempt`，`tokens 0/0`，`cost=null`，
  `cost_basis=unknown`，`outcome=failed_permanent`（glm-5.3-flash 无 pricebook
  条目，属预期；pricing.ts 只有 mimo 系列）。
- `copilot_evidence_checkpoint`：每个 scope 1 行 reference slot，`status=open`，
  `records=0`、`digests=0`、`attempts=2`（`failed_permanent`/`budget_timeout`，
  `task_input_sha256` 两 attempt 完全一致 `e2f648c5…`——零 accepted 记录时
  resume block 被正确省略，输入退化为字节级等同，这本身验证了 resume 输入派生
  是内容驱动而非 attempt 计数驱动）。
- `tool_call_log` 0 行（`autoLogToolCalls:false`，符合设定）。

### Case b — recovery run（未执行，原因记录）

- 注入前置：reference checkpoint ≥8 条 accepted records（或 ≥12 points）后 abort。
- 实测：glm-5.3-flash 4/4 attempt 零 accepted append → 注入点不可达。
- 强行运行的确定结局：poller 2400×0.4s 超时 → `injection_missed`，另烧
  ~2×480s。不提供任何新信息，故按 mandate 的 STOP-and-report 分支处理。

## Checkpoint resume 证据边界（本次可证/不可证）

- 可证（已在 case a 落地）：checkpoint 行创建与 binding（含
  `recovery_scope_id` extras）、attempt 全量审计、零记录完整性、fail-closed
  降级路径（reference 失败 → `failed_closed` 而非 degraded/repair）。
- 不可证（case b 目标）：accepted append 跨 attempt 保留、accepted 项零重提、
  attempt 2 usage 呈续跑形态。**该路径在本 provider/model 上无法用真实流量
  触发**；其机器验证仍由 `evidence-checkpoint.db.test.ts` /
  `evidence-review.db.test.ts`（YUK-839 落地时）覆盖。

## Verdict（acceptance #6）

**FAIL / 不可达 on zhipu / glm-5.3-flash。** validator 代码路径无事故（无 crash、
无错误 resume、无 phantom 记录、无重复计费），但该模型在产品 durable budget 内
无法完成盲证据腿的第一次 submission，acceptance #6 要求的"reference + 双
comparator 完整跑通"与"中断续跑证明"均无法发生。可选后续（owner 决策）：

1. 用同 endpoint 的 `glm-5.2`（coding-plan 已验证 lane）重跑本 burn-in，隔离
   "flash 模型太慢"与"zhipu endpoint 因素"；
2. 维持 xiaomi/mimo-v2.5-pro 作为 validator 默认 lane，把 glm-5.3-flash 排除出
   validator 可用模型清单（或标注 budget 不可达）；
3. 如 owner 愿意给 flash 更大 budget 做定位实验，须以独立临时 budget 运行并在
   报告中明示脱离产品预算（本报告未这样做）。

## Spend

- 2 次完整 validator run（4 paid attempts，~32.4 分钟 provider 时间）+ 2 次
  probe（27+51 tokens 计费量级）。abort 场景下产品表无法回收 token 数；以
  thinking 字符计（122,891 chars 总计）实际生成量约为数十 K tokens 量级。
- 与 mandate 授权的 2-4 次 full run 预算一致，未超。
