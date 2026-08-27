# YUK-839 acceptance #6 burn-in — 2026-08-26（zhipu / glm-5.3-flash）

> **Round 2（同日，owner 授权）已追加**：解除 budget 上限（1h/leg）+ reasoning=high
> 后，完整 validator 流程与 sealed-checkpoint resume 均跑通。Round 1 的
> “FAIL/不可达”结论仅适用于产品 durable budget；当前总结论见文末
> `## Round 2` 节的 verdict。

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

## Round 2 — unlimited budget + reasoning=high（owner-authorized diagnostic）

Owner 2026-08-26 授权的本轮仅作诊断：leg 预算从产品 durable 常量改为
`referenceMs/comparisonMs = 3_600_000`（1h/leg，事实无限），**偏离产品预算**；
本轮结论不能直接外推为"glm-5.3-flash 可用于生产 validator"。

### Setup deltas（vs Round 1）

- harness 增加 `BURNIN_REF_MS` / `BURNIN_CMP_MS` / `BURNIN_TAG` env 透传；本轮
  均 3_600_000。
- `MAX_THINKING_TOKENS=16384` 在 harness 进程 env 设置（import 前），经
  `buildAgentEnv` 的 process.env 拷贝进入 Claude CLI 子进程。
- thinking-budget 预检（单次 API 直连，非 SDK）：zhipu anthropic endpoint 对
  glm-5.3-flash 接受 `thinking.budget_tokens=16384`（200，end_turn，65 thinking
  chars，1.9s）。**但经 Agent SDK CLI 路径的实测 thinking chars 未显著下降**
  （clean 73,518 / 意外全量 112,116 / resume 57,474 / aborted 80,614，vs R1
  64,916）——env cap 是否真实穿透 CLI 未获证实；按 mandate 只记录、不追加
  probe。
- 其余隔离边界与 Round 1 相同（同 worktree / 同容器 PG / 同 fixture 与 seam）。
- Round 2 新增工件 SHA-256（/tmp/yuk839-burnin，0600，不提交）：
  - harness 入口：`f0e2a35042e670a504c74f6837a32dfabd150be430fca66ae629c59d20b8d5de`
  - harness core：`e2d5eb182c4ac92e8e78212dfa94b4c13f3c88cef375dfe3f44248a6791048ed`
  - thinking probe：`c388f0bfa44c8c1c20a563cc2c477063a3e6a2ed58b3c0a7ecb28c049adcbbc1`
  - clean results：`aec23133e7357991221d78cb2612ec3380b4be2de8361f30e1166d164b044508`
  - recovery results：`534dfd725a91ea3104f9d61384ba84be843424fda39fe45813ae34e90fdad221`
  - clean log：`992b5471b2a9d6b8e70932b5acaf86bc02b21f2fa90c20664a04036ad4272e23`
  - （意外全量）recovery log：`06ea614a1835e0ab19df7b529e43eca68972c102b2edca4f9e2255c0ee5aa821`
  - recovery r2b log：`558ad5b3cd32ae35f2b6cdc87205d5beb6af603ac94d5eb9d6d40a8be5c858a4`

### Case a′ — clean run @1h legs（scope `yuk839_burnin_clean_1787760863534`）

**完整跑通 reference + 双 comparator，21.3 min wall。** 三个 paid leg 全部
success、sealed、provenance-bound（result_digest 非空）：

| leg | task_run_id | 时长 | in/out tokens | thinking chars | cost（reported） |
|---|---|---:|---|---:|---:|
| reference | `pychfirysigg8qxtvbag9ydj` | 771.9s | 354,679 / 34,426 | 73,518 | $1.315005 |
| comparison:original:pass_1 | `ozr6i92ewzd8vgvk47mb1mqx` | 168.9s | 77,360 / 6,765 | 25,374 | $0.397237 |
| comparison:blind_reference:pass_1 | `d266dj4fuxl9dym6msb43adw` | 339.3s | 306,096 / 15,837 | 47,131 | $0.796869 |

- reference ledger：4 records = 21 evidence points（覆盖 6 request units）+
  10 not-material calls + safe_reply；一次过，无 contract retry。
- original comparator 对故意不安全的候选给出 **decided fail**（5/5 reply units
  `unsupported`）——语义正确的拒判。
- fallback comparator（盲 safe reply）：34 reply checks = 32 `supported` +
  2 `explicit_gap`，但 request unit 0 派生 `missing` → decided fail。
- 终局 `failed_closed`，reason `fallback_comparison_rejected`（代码路径
  evidence-review.ts:1147-1148：fallback decided 非 pass → fail-closed）。这是
  设计内的保守终局：候选不合格且盲回复也无法确认通过。**机械层全绿：三次
  sealed、三次 attempt 审计、三次 digest 绑定。**
- 与 Round 1 的关键差异确认：480s→1h 后 reference 一次通过，说明 R1 的
  budget_timeout 是预算-延迟失配，不是 endpoint/工具链缺陷。

### Case b′ — recovery run（scope `yuk839_burnin_recovery_1787763826085`）

注入阈值说明：mandate 原文"≥8 accepted appends"在本模型上结构性不可达——
模型按 12-point 上限成批提交（clean run 的 reference 只有 4 条 append
records）。改用等效触发"≥12 accepted evidence points"，在第一条 append（12
points）落地后即触发 caller-signal abort。abort 后 attempt 1 又跑了 ~9-10 分钟
才完成 SDK 子进程拆除并落 `failed_permanent`（teardown 延迟本身是一个值得记录
的运行时观察）。

**Resume 证明（全部来自真实 DB 行）：**

1. **abort 快照**：records=1 / points=12 / revision=1，digest 列表
   `[430dc01eb5dae94f2dfef4badb523c7e3c7d2036a294d1b2cc74e2899502062f]`；
   attempt 1 `pt6ka5pooivxnldfvcvachul`（`task_input_sha256=e2f648c5…`）。
2. **abort 不回滚**：post-abort 行仍 records=1、同一 digest——accepted 状态
   完整保留。
3. **attempt 2 携带 resume block**：run-call 记录显示
   `checkpoint_resume.accepted = {points:12, not_material:[], safe_reply_set:false,
   evidence_points_by_request_unit:[…]}`；其 `task_input_sha256=933c0c43…` ≠
   attempt 1 的 `e2f648c5…`（resume 输入内容派生，非 attempt 计数派生）。
4. **accepted 零重提**：resume 后 reference slot 共 10 次 append，每次
   offered=1、`duplicates_against_existing=0`、store 计数单调 1→11；预接受的
   digest `430dc01e…` 从未被再次 offered。
5. **digest 前缀保持**：final sealed digest 列表（11 项）第一项就是 abort 时的
   `430dc01e…`——精确前缀保持，后 10 项全为 resume 新增。
6. **attempt 2 usage 呈续跑形态**：in/out 375,305 / 28,122（vs 全新 clean
   reference 354,679 / 34,426）：输出只覆盖剩余 ~10 条 records（补点 +
   not-material + safe_reply），thinking 57,474 < 全量 73,518。不是重启。
7. **attempt 审计**：`[running→(abort), success]` 两行齐全；reference sealed
   by `sa0tjd452z91e7buwh62ufrb`。

续跑后双 comparator 正常执行并 sealed；终局同为
`fallback_comparison_rejected`（fallback 腿模型质量波动，非机械故障）。
Recovery leg 成本：attempt 1 aborted（usage 不可回收，80,614 thinking chars）+
attempt 2 $1.020343 + comparators $0.342664 / $1.048259。

### 意外全量 run 披露（harness bug，已修正）

第一次 recovery 尝试（scope `…1787762317016`）因 harness poller 的 SQL 错误
（postgres.js 模板里写了 `sleep 0.4`，PG 需要 `pg_sleep`）在第一个 tick 即死：
**abort 从未触发**，该"recovery"退化成第二次完整 clean run（reference $2.012929
+ comparators $0.363401/$0.784224 = $3.160554），终局同样
`fallback_comparison_rejected`（reference 5 records / 21 points 一次通过，再次
佐证 clean 路径可复现）。poller 修正为 `pg_sleep` 后 r2b 才是真实 recovery
样本。该多烧的 ~$3.16 已计入本轮总 spend。

### Round 2 总 spend

- 3 次完整 validator 流程（1 次 intentional clean + 1 次意外全量 + 1 次
  recovery）+ 1 次 aborted reference attempt：reported 总成本 **$8.080931**
  （tokens 合计 in 2,744,570 / out 184,011，全部 `cost_basis=reported`——
  endpoint 在成功完成时返回真实 total_cost_usd，回答了 R1 的 null-cost 问题）。
- 单 leg 量级：reference $1.0-2.0，pass_1 comparator $0.34-0.40，fallback
  comparator $0.80-1.05。

### Verdict vs Round 1 三个开放问题

1. **"flash 太慢 vs endpoint 因素"** → 是预算-延迟失配。1h/leg 下完整流程
   21.3 min 跑通；产品 480s reference 预算约为该模型实际需要（~13 min）的
   1/3。
2. **"维持 mimo 默认 / 排除 flash"** → 修正为：glm-5.3-flash **可以**跑通
   validator 全流程与 sealed-checkpoint resume（机械层验收全绿），但需要
   ≥25-30 min 量级的总 wall 预算与 ~$2.5/run 的成本，且 fallback comparator
   腿存在模型质量波动（两次 decided fail 均因 request unit 0 `missing`）。
   是否纳入生产 validator lane 是预算/质量权衡，归 owner。
3. **"更大 budget 定位实验"** → 本轮已完成。

**acceptance #6（机械层）在 zhipu / glm-5.3-flash @1h-leg 诊断预算下：PASS。**
reference + 双 comparator 完整跑通；checkpoint resume 获得真实流量证明
（digest 前缀保持、accepted 零重提、续跑 usage、attempt 审计齐全）。产品
durable budget 下的结论维持 Round 1：不可达。

## Round 3 — effort=high via task-spec (owner-authorized, single-variable)

Owner 2026-08-27 授权 **一次** clean validator run（YUK-925），用于测量
`reasoningEffort: 'high'` 经生产 Agent SDK seam 传入 `Options.effort` 后，对
zhipu / glm-5.3-flash 的单变量影响。本轮没有 recovery、abort 或追加 paid probe，
也没有设置 `MAX_THINKING_TOKENS`。

### Setup deltas（vs Round 2 clean）

- code revision：`354982ae7817a4826b992c8f81942bcffb59fdcf`（branch
  `codex/yuk-925-r3-burnin`，base `origin/main`）。两项 validator task spec 均声明
  `reasoningEffort: 'high'`；runner 的 `model_profile_resolved` 三次均记录
  `reasoning_effort: high`，harness 不写 effort，也不写 thinking env。
- harness 的 `runTaskFn` 仍只追加
  `override={provider:'zhipu', model:'glm-5.3-flash'}`；request context、故意不安全的
  candidate reply、checkpoint append observer 与 Round 2 相同。
- 预算不再由 burn-in env 覆盖：直接调用生产
  `durableEvidenceTimeoutsFor('glm-5.3-flash')`，得到 reference 1,200,000ms / comparison
  600,000ms。三腿均在预算内成功，故该 backstop 没有截断本次测量。
- 隔离 PG：`wt-925-pg`，`pgvector/pgvector:0.8.2-pg16-bookworm`，
  `127.0.0.1:5435`；迁移完整。`ZHIPU_API_KEY` 仅从主 repo `.env` 只读加载且未输出。
- fixture 仍是未改动的 `REALISTIC_EVIDENCE_TRACE + slice(0, 8)`：21 条 successful
  reads，serialized 58,465 chars。当前 harness 的“所有 primitive/null 均计叶”算法得到
  1,814 leaves；brief 中的 1,761 未能用该算法复现，但 fixture 源文件相对 Round 2
  revision 无 diff，因此没有换 fixture 或修改输入来追数。

本轮 paid 流程已经完整结束；随后临时 `run.ts` 的 DB 取证阶段因从 `/tmp` 解析不到
`drizzle-orm` 而退出。没有重跑 provider；以下结果由已完成 run 的原始 log、
`ai_task_runs`、`cost_ledger` 与 checkpoint 行无付费地回收。`provider_attempt` 本轮无行，
token/cost 真相来自上述成功 run 与 ledger（均为 `cost_basis=reported`）。

### Per-leg measurement vs Round 2

scope：`yuk925_burnin_r3_1787809522289`；总 wall 1,445.8s（24.1min），reported
总成本 $3.313845。它高于授权时的 ~$1–2 估算区间（主要来自 reference 与 blind
comparator 输出膨胀）；发现时 paid run 已完整结束，随后没有追加任何付费调用。

| leg | R2 wall | R3 wall（Δ） | R2 in / out | R3 in / out（Δ） | R2 thinking | R3 thinking（Δ） | R2 cost | R3 cost（Δ） | accepted append turns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| reference | 771.9s | 823.2s (+6.6%) | 354,679 / 34,426 | 370,198 / 48,173 (+4.4% / +39.9%) | 73,518 | 103,136 (+40.3%) | $1.315005 | $1.729363 (+31.5%) | 4 |
| comparison:original:pass_1 | 168.9s | 128.0s (-24.2%) | 77,360 / 6,765 | 79,519 / 6,662 (+2.8% / -1.5%) | 25,374 | 24,880 (-1.9%) | $0.397237 | $0.400273 (+0.8%) | 1 |
| comparison:blind_reference:pass_1 | 339.3s | 494.6s (+45.8%) | 306,096 / 15,837 | 589,420 / 23,741 (+92.6% / +49.9%) | 47,131 | 73,935 (+56.9%) | $0.796869 | $1.184209 (+48.6%) | 6 |

`accepted append turns` 是 checkpoint-store observer 实际接受的 append 调用数；它不把
SDK 最后的短文本 completion 计作 append，也不能回推出被 tool schema 拒绝的 assistant
turn。reference 的 4 条依次为 2×evidence_points、trace_calls_not_material、safe_reply；
original 为 1×reply_checks；blind comparator 为 6×reply_checks。全部 offered=1、duplicate=0，
store record 数单调递增。

### Decision / sealed health

- 终局仍为 `failed_closed / fallback_comparison_rejected`：unsafe original 的 5 个 reply
  units 全部 `unsupported`，6 个 request units 全部 `missing`；blind safe reply 的 54 个
  reply units 为 47 `supported` + 7 `explicit_gap`，request coverage 为 1 `answered` +
  5 `explicit_gap`，模型仍判 fail。
- 三个 checkpoint 全部 `sealed`，revision / records = 4 / 4、1 / 1、6 / 6；每腿
  `attempts_json` 恰一条 success，sealed task-run ID 非空，且三腿 sealed digest 均与
  对应 run result digest 精确相等。无 retry、无 duplicate append、无 phantom record，
  attempt audit 完整。

### Verdict vs YUK-923 expected benefit

**预期收益不成立。** YUK-923 的工作假设是 effort=high 若把 reference thinking 约减半，
可把 reference 拉回约 7min；实测 reference thinking 不降反升 40.3%（73,518 →
103,136），wall 也增加 6.6%（12.9 → 13.7min）。original comparator 基本持平且更快，
但 blind comparator 明显变差；单次样本不能把随机质量波动与 endpoint 对 effort 的真实
解释完全分开，不过它足以否定“effort=high 在这次 validator 输入上带来 ≥40–50%
thinking 降幅”的验收主张。runner 已证明 `high` 写入 SDK options；没有 wire capture 能
进一步证明 zhipu endpoint 如何翻译该字段，因此不声称 endpoint 必然执行了对应档位。
按 owner 的单次闸停止，不烧第二轮。

### R4 outlook（YUK-926）

R3 没有获得 effort 控制面的成本/延迟收益，下一可归因变量仍应是 YUK-926 的 validator
not-material 批量提交（目标 append 轮次 12→8、总输入约 -35%）。本轮 blind comparator
因 6 个 append turns 把累计 input 推到 589,420，进一步说明“减少多轮全上下文重发”比
继续调 effort 更直接；R4 应保持本轮 task-spec effort、provider/model、fixture 与 profile
budgets 全部不变，只改 batch shape，并继续只跑一份 clean sample。

### Round 3 artifacts（`/tmp/yuk925-burnin`，全部 mode 0600）

- harness core：`c60492f039be6071ddbe7fb11730979152a27b13dd3e4465221fd01baf9ce5a6`
- harness entry：`67e4b5704e487ee6eaf25febc6a5c77c304510c0f6a33f0cb22ac5fda3342c90`
- salvaged results：`1acddd810f3c1a35a282833462f38b7b557d5e40d66f47e009d3ec6e20892c31`
- clean log：`f8d17b337a758f1bb2d64569d5b983d97694e845aa9291af7d17fbcde880379a`
