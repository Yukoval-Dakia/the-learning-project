# 共用判断只读契约与 Copilot 学情头

Refs YUK-1431。阶段：**帮助靠谱第一刀（只读契约与Copilot片）**。

本片完成 ADR-0070「第一刀」中的现役读数适配和一个现役 consumer。
owner 最新顺序是共用判断与对账先行；本文不执行 ADR-0070 旧 D4 的切换措辞。
源码 base：`0fe7e2986e42299aca1538f7509f0290938b57c5`（fresh actual origin/main）。
工作树：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-cef24c83`。
原 T3 分支保留；父 `stage1-lead` 工作树不修改。

## 既定依据与本片范围

- ADR-0070 D1、D6、D7 与「落地顺序」：共享版本化契约，现役能力计算不改，未校准不开放新数字。
- ADR-0072 D4：Copilot 是契约读者，题库工具不读写 learner state。
  候选题 ref 批量预测面仍依赖后续真实消费者与语境能力，本片不宣称已实现。
- `/Volumes/YukovalSBak/yukoval-projects/tlp-status/discussions/learner-brain-draft.md`
  §3.1、§6.1：原样读取 θ̂/PFA/现役保持，`version=v0-incumbent`，
  `calibration=uncalibrated`；Copilot 读取同一 KC 的保持状态。

没有新表、事件总线、registry、模型调用、工具、Task、HTTP 或 UI。
没有重做 YUK-1513 已交资产，也没有恢复 QuizGen。
未触及发题 transport、公有 capability 入口、context、hook、issue-response 或 issuance。

## 契约与真实 consumer

`src/core/schema/learner-judgment.ts` 定义单一 v0 契约。
输入是 strict object，仅接受 `knowledge_ids`、`context='any'`、`as_of: Date`；
额外来源字段或其他语境直接拒收，不接入身体、作息或排名。
系统现有 DB 是单学习者范围，本片不发明学习者身份或跨人比较。
`as_of` 只代表当前状态的 retention 评价时刻，不代表历史重建或输入截止点。

production 路径：`copilot-run-input.ts` 的默认 resolver →
`resolveLearnerStateHeader` → `readLearnerStateProjection` →
`readLearnerJudgments` → `getMasteryProjection` 与 kernel scheduling 的
`getFsrsRetrievabilityByIds`。Copilot 不再直接调用 production mastery getter，
也不掌握两个部件的读取顺序。

新 reader 对同一批去空白、去重的 KC 和同一个评价时刻读取两个权威端口：

- mastery 的原始 p(L)、既有 band、θ̂/precision/SE、计数、β、last outcome、
  observed/inferred 与可选 raw θ̂ 均原样保留；不复制或重算公式、阈值、有效域或 KG flags。
- `p_correct_now.kind=incumbent_pfa` 只标现役 PFA 读数，数值和 band 直接来自 getter；
  不融合 retention，也不称为已个人校准的独立作答概率。
  inferred 或零证据仍保留原 ability reading，但 P(对) 为 unknown，不冒充本人观测。
- retention 原始 number 或结构化 reading 原样保留；结构化的
  kind/reason/calibration/provenance/scope/asOf 不丢失。缺行是 unknown，
  已存在 New card 的零值仍是 getter 的零值。
- 配置选择来自 `selectedForgettingEngine()`，实际 reading 引擎另记：
  现役端口的 number 是 FSRS，结构化 score 是 candidate，unknown reading 不证明实际引擎。
  即使选择配置为 FSRS，也不把存量 candidate reading 改叫 FSRS。
  源码默认 fsrs 不等于生产部署或切换批准证据。

新 `Db` 读取使用 `REPEATABLE READ / READ ONLY`，两个部件顺序复用同一连接与快照。
每个部件使用 savepoint，部件失败成为对应 unknown，不让 SQL 错误污染另一部件。
调用方传入 `Tx` 时读取其真实 isolation/access mode；只有已有 read-only repeatable-read
或 serializable 事务才读部件，其他事务返回 unknown，不用 savepoint 假称升级了快照。
事务建立/提交失败返回 snapshot unknown。这是源码约束，DB 运行验证仍 NOT_RUN。

既有 `getMasteryProjectionFn` 注入签名保持兼容，注入仍经同一适配函数；
显式部分来源注入标 `injected_partial_source`，retention 未注入即 unknown，
不偷偷访问 DB、不虚构 retention、快照或完整校准证据。production 无此 override。

Copilot 保留原 scope 选择与 mastery summary 算法；只有本人 observed 且有证据的行
进入 summary，未观察或推断部分标 unknown。新增文字只报告同范围保持读数可用或未知，
不引入新预测数字、排名或个人校准宣称。原有数字不新增种类。
session assemble-once、valid-window、watermarks、字符预算、proposal feedback、
failure/goal/overnight 读取和 mem0 opt-out 均保留。
旧缓存不强制逐 turn 重建，在原有效窗失效时才出现新文字。

## 明确的 unknown

部件版本、部件和批次完整输入高水位：现役 getter 未提供，均 unknown。
`last_outcome_at` 是最近作答时间，不足以覆盖 item β、KG、重放及更正等输入；
不把它或 `as_of` 冒充高水位，也不编造版本/hash。

独立/帮助/自评分证据分项、部件分歧、信息增益建议、pattern 部件、有效更正对账、
未来 retention/跌破目标时刻、个人校准样本与基线表现均未由端口提供，按原因 unknown。
现役 band 保留原标签，不升级为新可信区间。

## 边界与后续义务

只新增一条 Copilot → kernel judgment value edge，同时退出原 Copilot → kernel mastery
value edge（其 type import 保留）。无新增 capability → server 或跨 capability value edge。
baseline 仅追加真实 edge record，保留全部 main 前缀，不加 stable/compat ruling 或阈值。
新增模块均低于 source-size 登记线，不添加虚构 size 豁免。

`sealing=not_connected`。正式出题事务内封存、结算配对、有效更正后的重放对账、
作答账本信号补充仍属后续片；不能把本片视为整个 YUK-1431 完成。
遗忘参数先验、TEST 调度验收、owner 切换批准和长期个人校准继续由原任务承接；
本片不改变 FSRS/PFA/θ̂、eligibility、selector、settlement、更新逻辑、默认值或 flags。
YUK-1969 的两处测试 TEXT 仍归 owner，本片不写测试或重跑旧红。
没有本片新增的独立 actionable follow-up；上述义务均已归既有票，Linear 由父协调更新。

## 验证边界

仅授权静态门，日志目录 `/tmp/yuk1431-incumbent-judgment-20261023/`。
每条 heavy 命令串行经 host `heavy.sh`，`HEAVY_SLOTS=2`（本线同时最多一个），
`NODE_OPTIONS=--max-old-space-size=3072`。缺依赖时已串行 frozen install。
本片不修改 DB schema 或 API route，因此 schema write-path/API contract audit 不适用。

静态门逐项结果（均为本树实跑，没有运行测试）：

- `pnpm install --frozen-lockfile`：exit 0，`install.log`。
- `pnpm exec biome check --write <四个 owned 源码/登记文件>`：exit 0，`format.log`；
  当时一条 optional-chain warning 已在正式 typecheck/lint 前修正，没有采用 unsafe fix。
- `pnpm typecheck`：exit 0，`typecheck.log`（两个 tsrs 配置）。
- `pnpm lint`：exit 0，`lint.log`；184 warnings，无 error，不将 warning 写成无诊断。
- `pnpm audit:capability-boundaries`：exit 0，`capability-boundaries.log`；
  固定 `CAPABILITY_BASE_SHA` 为上述 base，实际 debts 340/0/39，新增 dependency edge 1，
  SCC 1→1、>1500 行文件 11→11，无新反向依赖。
- `pnpm audit:architecture-deepening`：exit 0，`architecture-deepening.log`；
  同一固定 base，pass-through sites 1129（新增 0）。
- `pnpm build`：exit 0，`build.log`；web、Start、server、worker、migrate 均完成 bundle。
- `git diff --cached --check`：exit 0。源码本身约束数值直通，未将源码证据替代 runtime parity。

NOT_RUN：所有测试/断言脚本、DB/浏览器/Chromium、provider/embedding、容器、部署、
真实 Copilot 输出、运行时引擎选择、快照隔离/数值对等实测、封存/对账及学习效果。
未因环境缺失把上述范围冒称通过；本片没有 runtime 授权。
父协调负责独立 R1、必要 R2、exact-head CI、merge 与最终验收；writer 不 watch/poll/review/resolve/merge。
