# 会话费用证据：部分覆盖的只读交付

2026-10-27。YUK-1522；审计根项 R8；交付阶段：帮助靠谱。

现有 `GET /api/ingestion-sessions/:id/history` 增加 `cost_evidence`，原
`record-api#getHistory` 经生成的 operation response 类型接收。用户重新打开录入详情时，
调用方可读出已知费用、未结身份与缺证原因；页面显示由原 UI owner 后续消费。
本片交付生产源码与静态检查，真实 HTTP/DB/provider 费用验收尚未执行。

## 已选范围与基线

Owner 已选「先交部分覆盖的费用证据（推荐）」，沿原
[范围评论](https://linear.app/yukoval-studios/issue/YUK-1522#comment-8f8224b4-b78a-404e-ba82-7d3a53ca98fb)
及下方最新决定实施，不重开 LIGHT/FULL 选择。

工作树：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-d04d71db`。
初始分支 `t3/d04d71db`、HEAD `ee4b92bea329dde7d88609469e217dd2bb473c1d` 保留。
收尾发现原 T3 引用已不存在，用普通 `git branch` 将该引用恢复到初始 HEAD；未 reset/force/覆盖。
先 fetch，初始 HEAD 落后 main 390 个提交；产品分支
`feat/yuk-1522-session-cost-evidence-20261027` 从实际最新
`12c8c296103a690c0eef8d95a8048d5cab7ba34d` 创建。
相关 history/contracts/budget-state/spend/canonical 源码相对父提供的
`49542097ba2fe58c6f43c61d1afc36dbfced1452` 直接 diff 无差量。
父已核 8 个开放 PR 的公开 files；本片未将其推断为其它线未公开写权全域释放。

## 完整职责与证据语义

- 私有 `server/session-cost-evidence.ts` 独自建立 REPEATABLE READ / READ ONLY 事务，
  第一条 SELECT 的 DB statement 时间作为 `as_of`；该快照内读取 session budget、
  canonical 费用、task/attempt 核验事实。路由不编排事务或复写分类。
  其它 history、标题、current serving 切片保持既有读时序，未承诺全响应同一快照。
- `scope=ingestion_agent_observed`、`coverage=partial`、`total=null` 恒定。
  无独立 OCR、下游准入或整包总额声明；已知小计不会升级 coverage。
- 主任务只取该 session 的 durable `agent_budget.tasks` 精确键，核验 surviving
  `ai_task_runs.task_kind`。所有仍留存的任务均在 scope，包含旧 run；
  不从 ID 前缀猜 run/segment，也不把它们挂到今日 run。
- OCR 只取本 session `attributions` 的真实 task/operation/attempt 绑定；
  canonical 行必须同时匹配 attempt 与 operation。缺 attempt 的 write-ahead 身份仍未结。
  已有 provider attempt 与绑定 operation 冲突时安全失败，不把费用归到错误会话。
- `historical_ocr` 的 host session 和 `ownership=agent` 均不证明这个 session 拥有它。
  没有同 session 的精确 write-ahead 绑定就只披露
  `historical_ocr_attribution_unproven`，不输出其它会话身份或金额。
- 复用未改动的 `providerCostProjectedCte` 决定 finished/reserved/wire 权威与 ledger 抑制。
  私有 reader 不另读 ledger 求和、不把 ai_task_runs.cost_usd 当第二账源；
  不用周账、时间、模型或任务名前缀分摊。无精确 operation 的 OCR ledger 不作 fallback。
- canonical rows 保留 provider/model、task/attempt/operation、entry_kind、cost_basis/ref；
  每条事实只经一个 OR 筛选进入，不用多表归属 JOIN 扩增行。重复相同 attribution 合并，
  同 operation/attempt 的冲突绑定失败。reported/estimated/legacy 按币种独立累加；
  没有该依据的金额为 null，只有真实数值零才能得到 0，不换汇、不混币。
- `unsettled` 是耐久身份的去重缺证列表，不是 provider 调用计数。主任务 running、
  task 行消失、无 canonical 行、缺 attempt、unknown basis、缺金额/依据或未知币种均留明示原因。
  TTL 后无行不证明免费、未发送或允许重试。已知小计与未结身份可以并存。
- 非法身份、金额、币种、数值溢出或读取失败返回固定安全 503；
  既有 session 404、token/self 边界保持。错误只含固定 code/message/reason，
  不带 budget JSON、provider payload、DB 错误或校验值，不建议安全盲重试。
- 原 items/asks/prior_runs/current/标题/history 缺证语义保持。
  新 server 总是返回费用字段；wire 仅为老 server 兼容而允许缺字段，
  缺席表示不可用，无 any、伪 legacy 或补成零的客户端适配。
- 不写 budget/grant/receipt/history/ledger/task/run，不调用旧账扫描、reconcile、
  queue、agent/provider，不改变 unknown/fence/uncapped/重授权政策。

新增 kernel 依赖只有安全 ApiError 与既有 canonical CTE，逐条追加真实 edgeRecords；
不改 debts、规则、豁免、稳定公开口、package、schema 或 DDL。现有文件均未跨 1000 行，
因此没有虚构 source-size record。无需修改 agent/history.ts 读取接缝。

## 两个变更场景的局部边界

1. OCR 增加一项缺证解释或冲突核验：只在私有 reader 的 attribution/canonical 核验及
   wire reasons schema 修改；GET 和其 consumer 不接触 SQL、绑定顺序或恢复决策。
2. 增加一种已获批准的费用显示依据：canonical authority 继续归 kernel；
   当前 reader 负责按 currency 分类与安全金额，wire schema 与原生成器同步。
   不改 budget/paid producer，也不因显示需求补写账本。FULL 归属扩展仍需独立合同。

## 人工输入与输出观察 TEXT（未执行）

在另行获批的固定候选与只读副本上，选已有真实 session，经原 history GET 观察：

| 真实输入条件 | 应观察的输出 |
| --- | --- |
| 没有 budget / 没有 durable identities | 空 records/by_currency，missing 明示 no_budget/no_durable_identities；total null |
| durable task 存在但 task/canonical 行已无 | 原 task 身份留 unsettled，missing_task_run/missing_canonical_cost；不称调用次数或免费 |
| main task 已知估价、仍 running | 币种估价小计与 task_in_progress 同时存在 |
| 旧 run task 与今日 run 并存 | 都按 exact durable task 读取；不把旧任务改挂当前 run |
| 同 attempt 有 ledger 与权威 provider 行 | 只按 kernel canonical 投影保留权威行；不重复加 ledger |
| OCR 有 operation 但缺 attempt / 无 canonical 行 | 一个 durable OCR 身份及相应 reasons；不从 operation 推算调用次数 |
| historical_ocr 只有 host 位置 | 不纳入金额，披露 historical_ocr_attribution_unproven |
| USD reported、CNY estimated、legacy 并存 | 分币种、分依据；没有对应依据保持 null |
| 实际金额为零 / 彻底无金额记录 | 前者相应 bucket 为 0；后者空组或 unknown bucket 的 null |
| 坏 budget/冲突身份/负数/NaN/Infinity/溢出 | 固定安全错误，无原值/raw payload、无补写或重试 |
| 老 server 响应没有 cost_evidence | 原生成 operation 类型允许缺席，不能解释为零或完整 |

这些是人工可读的输入/预期观察，未编写或运行 tests、fixture、断言、probe、driver、SQL 或业务请求。

## 实际检查与剩余验收

所有本机重命令经既定 `heavy.sh`，全机最多 2、本线串行 1，Node old-space 3072；
仅一次 frozen install。源码自查已读真实 diff、完整私有 owner、两个变更场景；不冒充独立 R1/R2。
当前 diff 超过 500 行，按实际 AGENTS 归 Tier A，独立审查由父任务启动。
history manifest 仅补现有 GET 的 503 响应声明，随后重新生成客户端并完成最终门。

日志目录：`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-functional-remaining-20261027/session-cost-evidence-source-12c8c296/`。
下表文件均在该目录，exit 来自真实命令返回；没有运行测试或业务请求。

| 检查 | exit | 日志文件 |
| --- | --- | --- |
| pnpm install --frozen-lockfile（唯一一次） | 0 | yuk1522-cost-install.log |
| pnpm gen:api-client（最终含 503） | 0 | yuk1522-cost-gen-api-client-final.log |
| pnpm gen:postman | 0 | yuk1522-cost-gen-postman.log |
| pnpm typecheck（最终） | 0 | yuk1522-cost-typecheck-delivery.log |
| pnpm lint（最终，162 warnings） | 0 | yuk1522-cost-lint-delivery.log |
| pnpm build（最终，SPA/Start/server/worker/migrate bundles） | 0 | yuk1522-cost-build-delivery.log |
| pnpm audit:api-contracts（最终，165/165） | 0 | yuk1522-cost-audit-api-contracts-delivery.log |
| pnpm audit:api-client（最终，重生后 unstaged diff 为空） | 0 | yuk1522-cost-audit-api-client-delivery.log |
| pnpm audit:api-client-usage | 0 | yuk1522-cost-audit-api-client-usage.log |
| pnpm audit:capability-boundaries（2 新边，债务 239/0/39） | 0 | yuk1522-cost-audit-capability-boundaries.log |
| pnpm audit:architecture-deepening（0 新 pass-through） | 0 | yuk1522-cost-audit-architecture-deepening.log |

中间检查原日志也保留：typecheck-1/typecheck-final/lint/build、首轮 API generator/contracts/client
均 exit 0；后续修改与 503 声明后以上表最终门为准。两次限定 owned 文件的 Biome 格式整理均 exit 0。
首次 git diff --cached --check 因本文引用空行的尾空白 exit 2，已清理；交付前再次检查 exit 0。
没有错误归零、未运行脚本或复用旧 CI 的声明。

NOT_RUN：任何 tests/fixture/断言/probe/driver、业务 HTTP、DB/SQL、迁移/恢复、browser/Chromium、
provider/model/paid/runtime、容器/daemon/resources/config、部署及 hash/seal。
独立审查、exact-head CI 与真实费用验收分别留给父任务；本 writer 不启动、轮询、watch、resolve 或合并。
没有本片新发现的独立 actionable follow-up；已知 FULL、UI 与真实验收继续原 YUK-1522，
原票仍 In Progress，由父更新，不建重复票。

## 最新选择原文

[评论 4710fa4d](https://linear.app/yukoval-studios/issue/YUK-1522#comment-4710fa4d-8609-4793-a6f8-dcd1ede24cb7)，全文复用：

> Owner已选择会话费用证据 LIGHT｜产品范围待决解除
>
> 本轮Sidekick转达Owner对原第39轮LIGHT/FULL问题的明确原话：「先交部分覆盖的费用证据（推荐）」。这是已呈范围的选择，不再待重复批准；复用原8f8224b4评论与remaining-behaviors-and-next-slice.md的LIGHT，不开平行票、不重派同调查。
>
> 直接实施范围：
> - 现役GET /api/ingestion-sessions/:id/history → 完整Ingestion私有费用reader；session级cost_evidence，明确scope=ingestion_agent_observed / coverage=partial / as_of。
> - 仅以本session持久任务身份和精确OCR write-ahead attribution证明归属；复用providerCostProjectedCte权威去重，保task/attempt/operation真实身份及provider/model/费用依据。
> - currency分组，reported/estimated/legacy分开；无账、金额缺失、未结、归属不明如实unknown，不伪0、不跨币种总计。historical_ocr所在host session不是归属证明，不凭时间/同model/前缀或全局周账猜会话花费。
> - session身份与费用在同一只读快照内读取。坏身份/非法金额明确失败；不补写旧账或改变ledger、paid、budget、grant、receipt、run/history写入、重试/重新授权政策。
> - FULL的独立调用/下游准入整包总费用不在本片；UI只沿原owner后续接合同，本片无UI、schema/DDL、provider或运行扩权。
>
> fresh actualmain49542097ba2fe58c6f43c61d1afc36dbfced1452；与原e2c范围的history/contracts/budget-state/spend/canonical投影直接diff无差量。8开放PR完整files已核：这些产品接缝无交集；baseline与其它线共用，仅保main全前缀并追加本片真实记录，不称未公开写权全域释放。
>
> 本功能父承接唯一T3隔离writer，选择当前实时目录codex/gpt-6.1-sol xhigh/default；范围为私有reader、必需history只读接缝、既有GET/contract/API+Postman生成物、准确依赖登记及正式交付文档。旧stage1-lead dirty树保持；不碰1969，且不重审已交2037/2059等。普通实现/源门完成后按本片原Tier预算首次独立R1、必要唯一R2和新exact-head CI交付，无等待窗/第三审。
>
> 全机heavy2/本线1、Node≤3072，经既定heavy.sh串行；不新增/修改/运行测试、断言或探针，不执行业务HTTP/DB/容器/browser/provider/paid/runtime/部署或hash/seal。整票仍InProgress，范围批准不等于源码或真实费用验收已通过。
