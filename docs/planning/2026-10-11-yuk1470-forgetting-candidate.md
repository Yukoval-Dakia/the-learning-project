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

14 files / 157 cases PASS。多步现实 fixture 覆盖乱序、相同时点稳定顺序、重复、反向 activation clock、legacy conversion/cold start、跨版本 revert/re-apply、assisted/self-report/unknown help、corrupt/版本不符/future writer、保留摄取撤回、正式 issuance/commit/assistance、rename/freeze 与 serving guards。

```sh
pnpm vitest run --config vitest.unit.config.ts \
 src/core/forgetting/forgetting.unit.test.ts \
 src/server/fsrs/candidate.unit.test.ts \
 src/capabilities/practice/server/fsrs.unit.test.ts
```

3 files / 26 cases PASS。覆盖完整 canonical fact 映射、replay duplicates/conflicts/cutoff/context、五种 due 投影、混合 schema/selector 与 UI unknown/calibration 边界。

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
