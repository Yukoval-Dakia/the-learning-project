# YUK-1470：统一遗忘候选与主线接入准备

状态：纯候选核心已实施，未接入应用；固定 `history-kernel-logistic-v1` 工程参数规格。基线为已合 main `79825bb6da73f9894c65a5d6735e3725f098e8e1`。

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

纯核心位于 `src/core/forgetting/`，包含版本化状态、证据映射、演化/读取/求根、有效历史重放与无模型兜底。独立 25 次 / 180 天 oracle 与反例测试覆盖数值性质；实现及 spec 解释见该目录 README。参数全部 engineering/uncalibrated，不冒称群体拟合先验。数据库接入、消费者切换、TEST 调度验收、真实预测准确率与学习效果仍未完成；本切片不改 FSRS 或当前 TEST 部署。父协调线负责接入、独立审查和 PR。

## 纯核心切片验证（2026-10-11）

- `pnpm vitest run --config vitest.unit.config.ts src/core/forgetting/forgetting.unit.test.ts`：11 个 grading/scheduling invariant case 通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过；lint 172 个现有 warning，新模块无 warning。
- `pnpm audit:partition` 与 `pnpm audit:test-policy` 通过，11 个新增 case 全部有 invariant/fails-if 声明。
- oracle 副本与研究产物 SHA-256 相同：`13ef197e3452051bf9eb31e97ac58775daf3d0b319c4d8b0cbdf1463f88e6efe`。
- Linear capture：查重已确认 YUK-1470；未发现新增 actionable follow-up，接入、TEST、独立 review 与 PR 已由父协调线承担，不新建重复票、不把整票标 Done。
- 无 DB、provider、TEST、deployment、PR 或消费者接入；本分支 commit/push 后交回父协调线。
