# YUK-596 actual-provider burn-in — 2026-08-02

## Decision

- **Durable transport / liveness / in-loop Stop：PASS。** 30/30 自动契约断言通过，
  F01–F05 独立 review 无 P0/P1。
- **Durable-default / UI 扩量：HOLD。** actual output 暴露 5 个新的产品 P1，先修
  YUK-832–836，再用同一复杂数据重放。
- 本结论不改写 YUK-814 的 owner mock waiver，也不把本次 actual burn-in 反向变成
  YUK-814 的新 gate。

## Reproducible boundary

- code revision：`main@ae82906510da102cc0ebae68ae08993999cdc888`
- provider/model：`xiaomi / mimo-v2.5-pro`
- Agent SDK：declared/installed/latest 均为 `0.3.220`
- 数据：从当前 Postgres 的 `public` + `drizzle` schema 克隆到隔离 compose project，
  不连接生产 app/worker，不修改原库。
- 30 个复杂案例：A evidence chain、B graph/question/artifact、C learner/FSRS、
  D math/physics/reasoning、E human-in-loop/security、F Stop。
- mock 只验证 seam；本报告的内容结论来自真实 provider output、真实 DomainTool、真实
  Postgres 写入与独立人工复核。
- 原始 cases/results 留在本地 mode 0600 临时目录，不提交可能包含完整对话与数据库片段的
  大文件；用 SHA-256 锁定：
  - cases：`f17f36ad212c682eea52bd227cabf6488b45a5ac7dcb87bd0db9a58f20cca7a2`
  - harness：`4912df7728895985519c4871827beddeb34eac30e82a65eae75aa7f79f5b83f9`
  - actual results：`631e6419bf16c92c794e1fa6d54759687c9f42f27760760ed19a2f1a1702ab55`
  - pre-fence results：`76565f10affceef710be5456bbcff253f5430c758bc890f06293c9056ffb32a4`

## Mechanical results

| Metric | Result |
|---|---:|
| Cases | 30 |
| Automatic contract pass | 30 / 30 |
| Normal `copilot_run.done` | 25 |
| Designed `failed:cancelled` | 5 |
| Successful provider ledger runs | 25 |
| Input / output tokens | 2,100,674 / 118,004 |
| Recorded cost | USD 6.685758 |
| AI runs / runs with thinking | 29 / 25 |
| Thinking blocks / characters | 85 / 181,364 |
| DomainTool calls | 240 |
| Read / propose / write | 229 / 9 / 2 |

产品只持久化 aggregate `thinkingBlocks` / `thinkingCharacters`，没有 raw
`reasoning_content`。本次只能证明 provider 实际返回 thinking blocks，不能证明另有独立显式
“thinking 开关”。4 次 `search_memory_facts` 因本机进程无权创建 `/var/lib/mem0` 失败，
属于本次非容器 harness 限制，不作为产品事故。

## Stop F01–F05

- **F01 pre-fence**：`queued → cancel_requested → failed(cancelled_before_start)`；无
  STARTED / execution fence / ai_run / tool / ledger。晚启动 worker 后仍未调用 provider；
  domain history 写入“已停止这次运行”。
- **F02 execution-started、F03 first-delta、F04 first-read-mirror**：均只有一个 execution
  fence、一个 cancelled terminal、一个 failure reply marker；取消后无 write effect。
- **F05 materializing-mirror**：`author_artifact` 已提交并完成 mirror 后收到 Stop。系统保留已完成
  写入，但 fail-closed 为 `checkpoint_safe:false`，不暴露伪安全 checkpoint。
- P2 evidence caveat：F03 polling 捕获 Stop 前已有 3 个 read mirror；它不是“delta 后且 tool 前”
  的纯隔离样本。取消的 ai_run usage=0/cost=null 只证明 abort contract，不证明取消前实际消耗。

## Actual-output findings

### YUK-832 — evidence reader 反转事实

- A03 已返回真实 intervention actions，A04 随后把不存在的 action 片段当 exact filter，
  再把 0 rows 升级成“系统从未发生”。
- C01 把 review 下的 judge/checkpoint siblings 猜成线性链，错误宣称 checkpoint 缺失。
- C04 只证明 due-now=0，却宣称 queue 全空；真实有两个 future FSRS item。
- 修复方向：exact semantics、多 action/causal graph、coverage/truncation、due-now vs future typed read。

### YUK-833 — artifact 写入前无内容 gate

- B05 真实写入 `art_vslgtoejt9hdizp6rajw7on8`，但球形气球题同时给
  `dr/dt=+3`、`dS/dt=-48π`、`dV/dt=+48π`；givens 与答案互相矛盾。
- 同一 artifact 还包含错误量纲、HTML v1 vs DB version 0、未支持的 delete rollback 承诺。
- 修复方向：泛化并复用既有 question/content validator，在 author/update 持久化前 fail-closed，
  保留 validator provenance。

### YUK-834 — human-in-loop / capability 失真

- B03 把 rename/delete/tag 归为“不需要 owner”的 LIGHT，并虚构 soft-delete/inbox/relearn rollback。
- E02 对错误对象连续 propose，随后建议未核验 SQL；E04 把 b/c 请求扩张为连 a 一起 archive。
- 修复方向：effect/capability contract、scope subset、typed failure；不以关键词 regex 判 gate。

### YUK-835 — 直出题解绕过 validator

- D02 的 ODE 数值、RK4 轨迹和表格互相不一致，但输出呈现为完成态。
- D04 的对照题 givens 冲突、delayed-transfer 表面线索不合格，却声称“validator 全过”。
- 对应 runs 没有调用 SolutionGenerate / QuizVerify / TeachingQuality；所谓自检只是同一模型 prose。
- 修复方向：和 YUK-833 共享 validator 核心；直出题解/题包只有真实 evidence pass 后才能声称
  validated。

### YUK-836 — correction 反转 session 历史

- D05 的“上一轮”实际指向 D04，模型却静默跳到 D02；又把 D02 的稳态 `4/9` 编成 `0.76`
  并虚构参数变化。
- 修复方向：correction intent 绑定 prior turn ID，歧义先澄清，输出 changed/retained/uncertain。

## Delivery order

1. YUK-832：先修读模型；后续所有审计/validator 都依赖可信 evidence。
2. YUK-833 + YUK-835：抽一个共享的泛化 validator core，分别接持久化 gate 与直出内容 gate。
3. YUK-834：把 owner gate、surface capability 与 rollback 事实机器化。
4. YUK-836：修 correction/prior-turn contract。
5. 用本批复杂 mock 固定 seam，再跑最小 actual-provider rerun；exact-head GitHub CI 代替本机
   完整 `pnpm test`。
6. 上述 P1 清零后才提交 Dock/UI design pre-flight；UI 代码仍需 owner 单独批准。
