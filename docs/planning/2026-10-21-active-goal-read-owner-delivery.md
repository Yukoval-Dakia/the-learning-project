# 共享活跃目标读模型归位 — 交付说明（YUK-1571）

状态：已实施，本地验证完成。服务"帮助靠谱"阶段的共享事实读取归位。
获批方案：`docs/planning/2026-10-21-shared-active-goal-read-proposal.md`
（arch-lead 树，SHA256 ac555524b47125399182cda2c80ad07f6fc8a218c01055fc7b0a385411e5b3e6）。
初始基座 `93578223e1489d44e1e66690611473848e2a08df`；实施期间 origin/main
先后前移至 `fabf68ec4`（#1904）与 `d97019477aac72fdd19c9b872cc88211c2a2f8b8`
（#1907），均以普通 merge 并入，现合入基座为 `d97019477`。
本片 head：`70817c2fb990107e474a37d1bb095458a0ee6a58`（merge commit，
产品 blob 与已批 `d9fe5d268` 逐字一致）。

## 变更内容

- 新增 `src/kernel/read-models/active-goal-scope.ts`：`ActiveGoal`、
  `listActiveGoals`、`listActiveGoalsWithResolvedScope` 逐字迁入。
  `scope_mode` 按方案改用 `(typeof goal.$inferSelect)['scope_mode']`
  （schema enum `explicit|subject_live`），不从 agency/commands 取类型。
- `capabilities/agency/server/goals/queries.ts`：删除两个 reader 与
  `ActiveGoal` 及悬空 drizzle/schema/kernel imports；`updateGoalStatus`、
  `updateGoalScope`、`mutateGoal` 调用与 command 类型再导出原样保留。
- `capabilities/agency/public.ts`：仅删除 `ActiveGoal`、`listActiveGoals`、
  `listActiveGoalsWithResolvedScope` 三个出口；`updateGoalScope` 等其余保留。
- 六个 consumer 全部改指 kernel，零 compat shim、零 reader re-export：
  `agency/jobs/coach_daily.ts`、`agency/jobs/dreaming_nightly.ts`、
  `agency/jobs/goal_scope_propose_nightly.ts`、`practice/server/due-list.ts`、
  `copilot/server/learner-state.ts`、`scripts/demo-flywheel.ts`（脚本不执行）。
- `scripts/capability-public-read-cycles.ts`：agency→practice 条目退役
  due-list 文件与 `ActiveGoal`/`listActiveGoalsWithResolvedScope` 符号；
  `quiz_verify`/`intervention-author` 的 guard/intervention/pool-gap 项保留。
- `scripts/capability-boundary-baseline.json`：edgeRecords 追加 5 条
  capability→kernel 边登记（逐文件、symbols 与实测一致，UTC 2026-10-20）；
  changes 追加 2 条实测 decrease；notes 追加 `YUK-1571-active-goal-read`；
  全部历史记录保留。

## 实测指标（本 head，非推演）

- cross-capability value：39 → 37（`practice -> agency` 3→2，
  `copilot -> agency` 1→0）。
- capability → server：403（本片不减 server；405→403 为上游 #1904
  session-summary 归位的实测下降，归上游记账）。server → capability-deep：0。
- 非平凡 SCC：`{agency, knowledge, practice}` 不变。
- pass-through sites：+0 新增。

收益口径：共享读职责归位与依赖方向收敛；不声称新接口深度或步骤减少。

## 验证

heavy.sh 包装执行，原始日志与 SHA256 封存于仓库外：
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1571/d9fe5d268f33a262ec2e3e72d41c6c10001bdbb1/`
（初切基座 935+fab 合并头证据）；合并 `d970` 后复验证据追加于
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1571/70817c2fb990107e474a37d1bb095458a0ee6a58/`。

- `pnpm typecheck`：exit 0
- `pnpm lint`：exit 0（180 条存量 warning，本片文件零命中）
- `pnpm build`：exit 0
- `pnpm audit:capability-boundaries`：exit 0（`--tighten` 登记实测 decrease）
- `pnpm audit:architecture-deepening`：exit 0
- `pnpm exec biome check`（11 个触及文件）：exit 0

NOT_RUN：全部测试/DB/provider/runtime/Docker（按 owner 规则本片不触及
五类不变量，且 owner 禁止未经批准运行测试）；`demo-flywheel.ts` 未执行。
