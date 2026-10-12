# YUK-1470：统一遗忘候选与主线接入准备

状态：候选核心与应用接入已实施并完成本地 scoped 验证；默认仍为 FSRS，父线 TEST T1–T6 尚未执行。固定 `history-kernel-logistic-v1` 工程参数规格。基线为已合 main `79825bb6da73f9894c65a5d6735e3725f098e8e1`。

## 已批准行为

- 每次有效作答结算后，根据技能、语境、作答质量、帮助程度与真实发生时间更新保持判断；到期读取随时间衰减，并给出确定性可复算的复习安排。
- 新候选替换 FSRS 的遗忘计算，不把卡片评级重新包装成新算法；现役能力估计、题目难度与按 kind 选题的其他语义保持其独立授权边界。
- 历史事件、更正和撤回可按有效事实重放；幂等重复不能造成第二次学习增益，晚到结果不能倒退状态时钟或泄漏未来信息。
- 无个人数据时使用明确来源的群体先验或标明工程假设，保持未校准；不能把本地合成结果声称为个人预测准确率或真实学习收益。
- 学习者看到白话状态与证据。概率显示仍遵守 ADR-0070 的校准资格；不采身体、睡眠、排名等被禁止的信号。
- 候选或状态不可用时，现有学习流程有明确的确定性兜底。替换已获批准，不再要求先赢过 FSRS 才允许实现；实际切换仍须 due list、Today fallback、settlement 与恢复验证。

## 分工与顺序

| 工作 | 独立产物 | 写入边界 |
| --- | --- | --- |
| 数学设计 | 至少两种具体函数候选、先验来源、数值性质、选择理由、可实施接口 | 先仓库外设计产物，父综合后固定 spec |
| 调用链盘点 | 结算、到期、复习、Today、初始入池、重放及消费者逐条清单 | 只读固定基线，文件和调用证据 |
| 算法实现 | 纯确定性状态演化、读取、到期解算与实质性质测试 | 独立 engine worktree，固定合同后唯一 writer |
| 接入实施 | 既有事件/状态及调度入口接入，历史保留和故障兜底 | 独立 integration worktree，领域归属先协调 |
| 验证准备 | 原实现基线、现实序列、边界/撤回/幂等/跨时间反例、scoped DB和主线CI命令 | 独立 verification worktree，不能只镜像实现 |
| 父验收 | 固定整合版本、独立审查、实际运行与PR交付 | 本工作树串行整合，不与child并写 |

按全项目最多8个运行agent调度。数学设计和调用链/验证准备可并行；实现依赖固定合同，各writer独立工作树。UI发布期间不启动DB、TEST或provider；离线研究和纯unit不占共享runtime窗口。

## 完成证据

1. 具体公式、参数版本、输入与状态接口已固定，文献依据与工程假设分开说明。
2. 候选实际执行，确定性、长期数值稳定、练习/遗忘行为、稀疏证据和更正重放由现实序列及失败反例验证。
3. 生产消费者路径已接上可验证的候选入口，不停在无人读取的库；默认切换与候选代码存在分开记录。
4. 父scoped unit及需锁的DB验收、typecheck/lint/build和独立审查有准确版本；完整测试只由远端exact-head CI执行。
5. PR、Linear与本计划同步。真实模型胜出、个人校准和学习收益若未测，明确未测，不从测试绿推断。

## 当前缺项

纯核心位于 `src/core/forgetting/`，包含版本化状态、证据映射、演化/读取/求根、有效历史重放与无模型兜底。独立 25 次 / 180 天 oracle 与反例测试覆盖数值性质；实现及 spec 解释见该目录 README。参数全部 engineering/uncalibrated，不冒称群体拟合先验。数据库及消费者接入已在候选分支实现；TEST 调度验收、独立审查、远端 exact-head CI、个人预测校准与学习效果未完成。父协调线负责整合、审查与 TEST；本接入线不打开 PR、不部署、不切换 main 默认。

## 纯核心切片历史验证（2026-10-11，接入之前）

- `pnpm vitest run --config vitest.unit.config.ts src/core/forgetting/forgetting.unit.test.ts`：11 个 grading/scheduling invariant case 通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过；lint 172 个现有 warning，新模块无 warning。
- `pnpm audit:partition` 与 `pnpm audit:test-policy` 通过，11 个新增 case 全部有 invariant/fails-if 声明。
- oracle 副本与研究产物 SHA-256 相同：`13ef197e3452051bf9eb31e97ac58775daf3d0b319c4d8b0cbdf1463f88e6efe`。
- Linear capture：查重已确认 YUK-1470；未发现新增 actionable follow-up，接入、TEST、独立 review 与 PR 已由父协调线承担，不新建重复票、不把整票标 Done。
- 无 DB、provider、TEST、deployment、PR 或消费者接入；本分支 commit/push 后交回父协调线。


## 接入交付回执（2026-10-11）

工作树 `tlp-yuk1470-forgetting-candidate`，分支 `feat/yuk-1470-forgetting-candidate`；已验证的源提交为 `0064b911e0a4c6c3a4a9376e3e34e18e2d4209d7`。之后的提交只记录本回执及 handoff。依 schema → settlement → replay → readers → initial paths 分别提交 checkpoint。单一服务器开关 `FORGETTING_ENGINE` 默认 `fsrs`，显式 `forgetting_candidate` 才选择候选；每次结算只写一个既有主体行。

### 协调裁决落实（1–9）

| 裁决 | 已实现入口与行为 |
| --- | --- |
| 1 状态与版本 | `src/core/schema/scheduling-state.ts:6` 接受 bare legacy Card、带 discriminator 的 FSRS 与 candidate；`src/core/schema/event/state-snapshot.ts:120` 的 before/after 同源。`src/server/assessment/settle.ts:948` / `src/server/fsrs/candidate.ts:244` 从 sealed history 重建或标记 legacy_cold；跨版本 restore 保留完整 bracket，`src/server/revert/cascade-revert.ts:827` 比较完整候选态。 |
| 2 全部证据输入 | `src/server/assessment/activate.ts` 扩展 capture；`src/server/assessment/settle.ts:525` 从封存的评分、帮助、信心、延迟和 revision 生成事实；`src/server/fsrs/candidate.ts:108` 只 hash canonical facts，以 submitted occurrence + submission ID 排序，序号同源。`candidate.ts:60` 与 `settle.ts:1041` 封存可复算 replay packet。 |
| 3 due_at | `src/server/fsrs/candidate.ts:205` 的 due_now/scheduled 使用返回时点，beyond_horizon 使用 checkedThrough，unknown/invalid_input 使用 fallbackSchedule。候选态记录 dueKind/fallbackReason；active 初始入池立即到期，dueKind=initial。 |
| 4 retention | `src/server/fsrs/retention.ts:11` / `state.ts:76` 调 retention，unknown 透传；节点 DTO / 页面和 probe 保存 engineering/uncalibrated 标记。需要数字的旧兼容字段在 unknown 时保持 null，不把 unknown 当零。 |
| 5 时钟 | `settle-forgetting.db.test.ts` 用注入 now 与 vi.setSystemTime 验证 due/tool/Today 时钟翻转；产品 clock 保持现有行为。 |
| 6 缺 help | `settle.ts:571` 缺 snapshot 映为 unknown，`src/core/forgetting/evidence.ts:49` 排除，历史缺快照不会进入弱证据。 |
| 7 self_report | `src/core/forgetting/evidence.ts:41` 允许独立来源 self_report，工程权重系数 0.1、independent=false；用户评级保留独立调度渠道，D15 不更新 θ̂。 |
| 8 context key | `scheduling-state.ts:10` 将 global/contexts 嵌入原 jsonb；subject_kind/subject_id、表、索引和 SQL key 均未迁移。 |
| 9 声明边界 | 候选数值仍是未校准工程分数；本回执不声称已验证个人预测准确率或学习收益。 |

due list、get_review_due、Today 经 `resolveSchedulingProjection` 读取同一选定调度；自动可判/withdrawn/draft/suspended/合成根过滤保留。节点与 probe 读取同一 retention。六个初始入口是 source_verify、quiz_verify、proposal-appliers、quiz/verify-and-promote、quiz/content-fingerprint、intervention-diagnostics，均改为 state-owner 的 `initialSchedulingState`，含 composite 子题，保留冲突不覆盖及一次性 retirement。

θ̂/PFA 与 by-kind 的实现未修改。DB guard 比较相同输入两种引擎的 θ̂/calibration brackets，并通过现有 prefetch/selectProbe 的真实 by-kind 调用验证选择边界。`cron.db.test.ts`、`migration.db.test.ts` 未修改。协调线将另行修改 assessment/settlement.ts 的 partial_unknown_points 语义；本线未修改该文件。候选适配已有 earned=null 排除和 unsupported judgment 排除，不将 unresolved unit 当零证据；独立 user self-rating 渠道仍按 D15 保留。

切回环境开关不会把候选态伪装成 FSRS Card；跨版本回退须使用封存 bracket / 事实重建，不能依靠双写的另一份状态。

### 纯引擎改动全集

仅以下四个文件改变；engine/replay/schedule/types 与 oracle fixture 未改变。

- `src/core/forgetting/evidence.ts`：允许 self_report，乘工程权重系数并强制非独立，记录 source mapping note；unknown help 仍排除。
- `src/core/forgetting/model.ts`：mapping 版本升至 evidence-quality-20261011-v2；新增 selfReport=0.1，更新工程常数计数。模型动力学与排期常数未改。
- `src/core/forgetting/forgetting.unit.test.ts`：新增 self-report/unknown-help/source-exclusion invariant；原 rejected-source case 改用 reading。
- `src/core/forgetting/README.md`：记录第八项 mapping 常数与 self-report 渠道，更新接入后描述。

### Scoped 验证与命令

实际 Postgres 16.14，镜像 `pgvector/pgvector:0.8.2-pg16-bookworm`，仅 throwaway DB yuk1470，localhost:32771。容器 `yuk1470-forgetting-db-20261011-2059-c3f26c55` 已按 exact name stop/rm；不再需要 DB。未运行 TEST/provider/部署锁、full pnpm test、Testcontainers/Ryuk 或 prune。协调线随后报告清理时存在 CI 独占窗口及 parity 失败；本线已报告自身 exact-name stop/rm，不将此清理声称为共享 host parity 验收。未操作 jolly_johnson 或 preserved evidence container。今后任何容器创建/删除先等协调线明确 start。

迁移命令：

```sh
DATABASE_URL=postgres://postgres@127.0.0.1:32771/yuk1470 pnpm db:migrate
```

为避免共享 runtime 上启动 Testcontainers，使用未提交的 `.cache/yuk1470-scoped.vitest.ts`：导入 vitest.db.config，test 中 globalSetup/setupFiles 为空，maxWorkers=1；复用原 testDb/resetDb，数据库先执行真实迁移。以下 DB 命令的 DATABASE_URL 和 TEST_DATABASE_URL 均设为上述 throwaway URL。

```sh
DATABASE_URL=postgres://postgres@127.0.0.1:32771/yuk1470 TEST_DATABASE_URL=postgres://postgres@127.0.0.1:32771/yuk1470 \
pnpm vitest run --config .cache/yuk1470-scoped.vitest.ts \
 src/server/assessment/settle-forgetting.db.test.ts \
 src/server/assessment/settle.db.test.ts \
 src/capabilities/practice/api/submit-late-arrival.db.test.ts \
 src/capabilities/practice/server/review-settlement.db.test.ts \
 src/server/revert/cascade-revert.db.test.ts \
 src/capabilities/practice/jobs/judge_run.db.test.ts \
 src/capabilities/practice/server/native-durable-attempt.db.test.ts \
 src/capabilities/practice/server/paper-cycle.db.test.ts \
 src/capabilities/practice/server/paper-issuance.db.test.ts \
 src/capabilities/practice/jobs/source_verify.test.ts \
 src/capabilities/practice/jobs/quiz_verify.test.ts \
 src/capabilities/practice/server/proposal-appliers.db.test.ts \
 src/capabilities/practice/server/quiz/content-fingerprint.db.test.ts \
 src/capabilities/agency/server/conjecture/probe-lifecycle.db.test.ts
```

历史 14 files / 157 cases PASS（源0064b911e；当前 policy gate 见下）。多步现实 fixture 覆盖乱序、相同时点稳定顺序、重复、反向 activation clock、legacy conversion/cold start、跨版本 revert/re-apply、assisted/self-report/unknown help、corrupt/版本不符/future writer、保留摄取撤回、正式 issuance/commit/assistance、rename/freeze 与 serving guards。

```sh
pnpm vitest run --config vitest.unit.config.ts \
 src/core/forgetting/forgetting.unit.test.ts \
 src/server/fsrs/candidate.unit.test.ts \
 src/capabilities/practice/server/fsrs.unit.test.ts
```

历史 3 files / 26 cases PASS（22:15 policy 后已删 helper-only suite，不作为当前 gate）。当时覆盖完整 canonical fact 映射、replay duplicates/conflicts/cutoff/context、五种 due 投影、混合 schema/selector 与 UI unknown/calibration 边界。

```sh
FORGETTING_ENGINE=forgetting_candidate DATABASE_URL=postgres://postgres@127.0.0.1:32771/yuk1470 TEST_DATABASE_URL=postgres://postgres@127.0.0.1:32771/yuk1470 \
pnpm vitest run --config .cache/yuk1470-scoped.vitest.ts \
 src/capabilities/practice/jobs/source_verify.test.ts \
 src/capabilities/practice/jobs/quiz_verify.test.ts \
 src/capabilities/practice/server/proposal-appliers.db.test.ts \
 src/capabilities/practice/server/quiz/content-fingerprint.db.test.ts \
 src/capabilities/agency/server/conjecture/probe-lifecycle.db.test.ts
```

5 files / 19 cases PASS（与上方 suite 部分重叠，单独强制候选模式）。

```sh
pnpm gen:api-client
pnpm gen:postman
pnpm typecheck
pnpm lint
pnpm build
pnpm audit:test-policy --base 79825bb6da73f9894c65a5d6735e3725f098e8e1
pnpm audit:partition
```

全部 exit 0；lint 172 个现有 warning；test-policy 检查 38 changed/new、81 inherited，errors=[]；partition unit65/db208/migration1，errors=[]。API client/Postman 与节点 retention DTO 同步。证据存本工作树 `.cache/yuk1470-evidence/` 的 *-head.log；早期失败 candidate-db-r1–r11 保留，不用最后通过覆盖失败历史。证据未提交，不把本地通过当远端 CI 或 TEST 通过。

### 父验收 / Group F 未执行清单

以下均由父协调线在授权 TEST 窗口执行；全部通过之前默认保持 FSRS。

- [ ] T1 真作答：applied + state + settlement + bracket。
- [ ] T2 due HTTP / Today / copilot summary 同项同计数、无 500。
- [ ] T3 真实到期翻转可见。
- [ ] T4 fallbackSchedule 演练：due/settlement 可用且 marker 可见。
- [ ] T5 乱序终态等价、replay 链可读。
- [ ] T6 learner / contract 标明 uncalibrated。
- [ ] 父独立审查与整合后 exact-head CI。

Linear capture：已核对既有 YUK-1470 为 In Progress；已发现的接入 correctness 问题在本线修复，未发现需另建票的 actionable follow-up。TEST、review、CI、切换及 PR 属既有票父验收，不重复创建、不标整票 Done。本线只 commit/push 指定分支，无 PR。


## 22:15 owner 测试规则替换与收敛

新规则替换 verification pack 的逐行实施要求；A–G 只作为行为 checklist。新增接入 suite 由 12 DB + 5 helper-only cases 收敛为 **8 DB boundary cases**；保留纯引擎公开入口的 **1 个 self-report invariant**。原 reviewed engine 的 11 cases 与既有 FSRS/settlement/revert tests 不属于本线新增矩阵，未复制或展开。删除 `src/server/fsrs/candidate.unit.test.ts` 全文件及其 partition 注册；不保留单独的 schema/selector/mapper/due-result/UI-helper 测试。

| 保留 case | 实际边界与 invariant |
| --- | --- |
| sealed settlement | 结算 DB 事务：全部输入封存；重复 activation 无第二次写入；反向 activation clock 不改变 occurrence。 |
| ordered settlement | 结算 DB 事务：相同四次、同时间 tie 与失败事实，以正序/晚到序列执行后得到完全相同 state/due/mastery；两条真实历史用于检验 determinism，并非每个参数一例。 |
| legacy correction | replay/revert：legacy history 转换，before/after 跨版本，更正后重放等价且原 receipt 不变。 |
| excluded settlement | 结算 DB 事务：assisted / unresolved 无 memory 写；显式 self-report 仍是独立授权渠道；缺 help 不新增写入。 |
| due and unknown | due/Today 实际 reads：同一投影的到期翻转与 tool counts；无 sealed history 的 legacy cold read 保持 unknown。 |
| ownership guard | 结算 DB 事务：两种引擎相同 θ/PFA 结果，调用真实现有 by-kind selector 检验结果/引用一致。 |
| serving guard | due reads：一次读取现实混合队列，只输出获准项；多状态只是同一个队列 fixture，不逐项重复调用测试路径。 |
| captured withdrawal | replay/revert：撤回 preserved capture 后后续有效事实不变，重复撤回幂等，原文事件 immutable。 |
| self-report | forgetting public entrypoint：用户评级只贡献 0.1 工程系数、非独立证据，unknown help 排除。 |

无模型 fallback 与 no-future-leakage 使用原已审 pure engine public-entry invariants（`schedules without any model...` / `decays monotonically...`），不再写 helper case 或参数分支矩阵。新增 suite 不断言 mock interactions。

Owner 同时明确 assisted judgment 无写入：`settle.ts` 封存 suppression；直接 apply、historical replay 与 legacy reconstruction 都排除 assisted judged facts。self-report 不因 AI 未决而丢失；它仍不更新 θ̂。`src/core/schema/assessment/settlement.ts` 未编辑，feature line 的 partial_unknown_points 分类改动留待父整合；本线从空 points/unsupported judgment 不产生 candidate observation。

历史 integration-only 预算以 `git diff --numstat ecd845d9e` 的 added 列计算：test 887 / product 1200；该切片不含此前加入的 oracle fixture，此数字只描述当时切片。原全分支“test 1626 ≤ product 2123、无超额例外”的结论漏计 `src/core/forgetting/numeric-oracle.fixture.json` **594 行**，已撤回。统一以 API PR base `c2ace38ddba976175afde2bed342d8fba5767d79` 重计：review 源 `2b8633ef` 为 **test 2220 / product 2123**；前次 CI 修复源 `d86c9d4d` 为 **test 2282 / product 2141**。这些数字不沿用原历史 merge-base `79825bb6`。

统计只取完整 diff 的 added 列：test 包含路径中的 `.test.` / `.spec.` / `.fixture.` 及 `tests/`；product 为 `src/` 下非测试 TS/TSX，排除 `.generated.`。其余文档、生成 client、Postman、Vitest 配置均排除；此 diff 无另外漏出的 server/web/scripts 产品改动。测试多于产品触发逐不变量说明，不能通过删有效测试或计入文档/生成代码缩小差额：594 行独立高精度 oracle 验证数值结果，不是实现镜像；核心公开入口保护确定性、乱序/更正/撤回及 future cutoff；DB 结算保护幂等、状态恢复、助力/未决排除和独立用户评级；实际队列/tool 保护冷却与过滤边界，旧测试的类型适配保持已有数据/结算断言。


新 DB 使用协调线明确 start 授权的 `yuk1470-boundary-db-20261011-2215-89cb7792b`，ID `ca8fcea10f8131947009fc89d1a0a3c4797c19e4d45f7f04bcb6bf236790998a`，localhost:32772；创建前仅见 7 baseline containers，均 stable/running。无 Testcontainers/Ryuk/prune；删除已获得协调线第二次 start，仅按 exact name stop/rm 完成。

当前 scoped 命令（同上 temporary config，无新 harness）：

```sh
DATABASE_URL=postgres://postgres@127.0.0.1:32772/yuk1470 pnpm db:migrate
DATABASE_URL=postgres://postgres@127.0.0.1:32772/yuk1470 TEST_DATABASE_URL=postgres://postgres@127.0.0.1:32772/yuk1470 \
pnpm vitest run --config .cache/yuk1470-scoped.vitest.ts \
 src/server/assessment/settle-forgetting.db.test.ts \
 src/server/assessment/settle.db.test.ts \
 src/capabilities/practice/server/review-settlement.db.test.ts \
 src/server/revert/cascade-revert.db.test.ts
pnpm vitest run --config vitest.unit.config.ts \
 src/core/forgetting/forgetting.unit.test.ts \
 src/capabilities/practice/server/fsrs.unit.test.ts
pnpm typecheck
pnpm lint
pnpm build
pnpm audit:test-policy --base 79825bb6da73f9894c65a5d6735e3725f098e8e1
pnpm audit:partition
```

首轮 boundary-db-r1 因 assisted 的期望仍为 applied（实际正确返回 ineligible）失败，修正边界期望后重跑；失败 log 保留，不以通过覆盖。最终 boundary-db-r2：4 files / 62 cases PASS（含本线8 boundary cases）；unit：2 files / 21 cases PASS（engine12/FSRS9）；typecheck/lint/build 全过（lint172既有warning）；test-policy checked29/inherited81/errors=[]，partition unit64/db208/migration1/errors=[]。证据为 .cache/yuk1470-evidence/boundary-*.log。协调线再次明确 start 后，已仅按 exact name docker stop / docker rm 删除该容器。


## PR1700 三项 P1 修复回执（2026-10-11）

修复限定为候选的助力准入、执行冷却和部分得分归属；默认仍为 FSRS。纯核心动力学、工程参数、开关默认、θ/PFA、UI、kernel facade 和已验 rename 实现均未修改。

- 助力：自动评价的 assisted、submission/help 及 sealed hint 数量任一禁止证据均阻止候选写入。直接结算、sealed history 与 legacy 重建共用判定；旧 plan 在选择 writer 前只规范化候选输入/抑制字段，不改历史事件。显式 user rating 的独立 self-report 通道保留。
- 冷却：应用投影调用既有 `arrange` / `fallbackSchedule`；`due` 为实际 eligibleAt，向后兼容的 optional `modelDue` 保留原结果/kind。lastCompletedAt 来自有效作答，不以每次读取 now 重置。旧无 modelDue 的候选态只读补投影，新态沿用已安排日期；beyond_horizon 使用 checkedThrough，unknown/invalid 原因保留。尚无生产用户日期入口来源，本次未声称该入口已验；仅保留已有约束参数能力，不新建日期 pipeline。
- 归属：多 KC 的未定位 partial 点保留 evidenceRefs 与 `unattributed_multi_skill`，不均分猜分；同卷单 KC 合法点继续纳入。writer 和相关预检查只取 included 的技能，legacy 回落不把空 shares 再填成平均值。

仅增强既有三个 DB case，没有增加 case 数或矩阵：continuous case 检验未定位 partial 与同卷合法邻项；assisted case 保护直接、旧 sealed、旧 legacy reader/实际 replay 的不同准入缺口，并比较只读后的持久化事件；due case 以首次独立失败验证一天冷却以及旧候选态的队列/tool 一致性。原 8 个候选边界 case 保留。统一 base `c2ace38ddba976175afde2bed342d8fba5767d79` 的完整分支 added 为 **test 2455 / product 2233**，包含 594 行 oracle；逐文件分类与排除清单在本轮外置证据中，未删有效测试凑数。

最小 RED 在未修产品源 `d86c9d4d` 上由同三个 case 得到 3 fail / 5 skipped：错误写入两类不合格记忆、首次失败早到期一天。失败日志与测试 patch 独立保留。后续两次夹具失败分别是 Date/jsonb 表示比较与 terminal evaluation 冻结约束；已比较实际持久化回执，并从一开始创建不可变 assisted 评价，不绕过 guard。验证 driver 仅使用显式环境 allowlist、loopback sentinel 与未改的标准 Testcontainers globalSetup，每次新合成 PG；无真实 DB、provider、Mac、R2 或全量本地测试。

证据目录 `/workspace/pr1700-r1-fix-evidence/`；同一最终提交的 scoped DB/core-unit、typecheck/lint/build 与相关 audits 结果由父交付回执绑定精确 SHA。R1 三项 P1 已进入此修复；限定 R2、远端 exact-head CI、原 PR 唯一评论及发布仍由父负责，不把中间本地 PASS 当最终交付。Linear capture 沿用 YUK-1470；本次没有三项之外的新 actionable follow-up，不新建重复票。

额外 `audit:fold-writes --strict` 的 precommit 检查报告 rehearsal/corpus.ts 六处写者未登记；脚本、allowlist 与 corpus 在上述统一 base、修前 head 和当前工作树的 Git blob 均相同。这是既有非默认 strict advisory，不改 allowlist、不开三项以外的整治；其失败保留在证据中，不称全部 audit 绿色。


## PR1700 R2 旧 sealed partial 准入补漏（2026-10-11）

限定 R2 指出：历史封存的 judged 多 KC partial 可能已经含平均 shares，非空 shares 不能证明局部归属。旧 `CandidateFact` 没有 scoring-unit/part 归属证明；本次只保守排除 `0 < earned < maximum` 且有多个正权重技能的 judged 点，不根据现有题目标签猜测。旧 receipt 仍按原映射完整校验；当前准入另行计算，并在 identity remap 前执行，避免多个历史技能合并后掩盖歧义。合法同卷单 KC partial 保留，self-report 和满分/零分事实不因这条规则排除。

读取转换在无可纳入记忆时保留 `unattributed_multi_skill_requires_rebuild` 原因；实际重放的新回执保留排除原因和 evidenceRefs。旧 event 原样保留，不改历史 hash，不作全库迁移，也不扩大至现有 warm materialization 的其它读取路径。默认 FSRS、核心动力学、参数、开关和 UI 均未改变。

仅增强既有 continuous DB case，case 数仍为 8；相对 `8d263ba6` 的测试 diff 为 153 added / 1 deleted。新增主体用于构造相互一致的三条旧候选状态、sealed core replay packets 和恢复快照，再从真实读取与晚到事件的 revert/reapply 检验同一个归属不变量：歧义 B/C 不纳入、合法 D 保留、旧 event 不变。不是新增 helper 套件或参数矩阵。相同夹具在 `8d263ba6` 产品源下有四个失败断言（读取 warm、缺原因、实际重放复活 B/C、新回执无排除记录），恢复修复后 1 pass / 7 skipped；临时切换仅两产品文件，恢复 patch 与切换前保存内容的 SHA256 一致。早期不完整夹具记录保留，但不作为真实旧恢复链证据。

完整分支仍以 `c2ace38ddba976175afde2bed342d8fba5767d79` 为 base，added 重计 **test 2607 / product 2284**，包含 594 行独立高精度 oracle。沿用上节逐不变量说明；本次额外测试行只保护旧封存证据的读取/恢复确定性。文档、生成 client、Postman 和 Vitest 配置不计产品；逐文件分类及排除清单在 `/workspace/pr1700-r2-fix-evidence/`，没有删除有效测试以缩小差额。

本轮沿用显式环境 allowlist、loopback sentinel 与未改的标准 Testcontainers globalSetup，每次新合成 PG。最终同 SHA 的四文件 62 DB、既有 21 unit、typecheck/lint/build 与 test-policy/partition/architecture 验证由外置回执记录；不重跑全量本地测试或前轮 15-audit bundle。R2 已完成，本补漏不启动第三轮审查；push、远端 exact-head CI、原 PR 回执和既有 YUK-1470 状态由父协调线处理，无新 tracker 工作。
