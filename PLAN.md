# PLAN — 活看板

> Linear 是权威 tracker；更新于 2026-09-06：AI pipeline已合并，业务封装与测试精简继续。

## NOW

- Owner 本次授权整个项目架构与测试精简；一条active线：业务复杂度收进明确owner，
  保留低token与高级agent，不把目录归属/audit绿色当完成。
- AI pipeline PR #1326 已合并 main `dda46441`；exact-head `7d456998` CI全绿。
  命名synthetic actual gates全部通过，本次报告费用$0.248796；此前未知child未算作0。
  read样本输入至少降50.8%、费用至少降62.2%，旧基准不完整，仅限样本。
- 根集成工作树 tlp-wt-business-architecture；原始the-learning-project脏main保持不动。
- YUK-952：Goal manual/accepted creation、status/scope/retract集中command；legacy raw
  insert仅留import/fixture兼容；修复锁外version读取与逆序timestamp导致的有效更新回滚。
  首审P1已红测复现并修复；41 scoped DB绿，早先67 DB覆盖rebuild/golden；
  45 scoped unit、typecheck/lint/build通过；唯一验证审APPROVE，独立9+20 DB通过。
  PR #1327 exact-head CI绿色并合并 main `8a1b06d1`；YUK-952 Done。
- 测试第一批仅删除4个文件搬迁/Options全字段快照用例；权限、结算、取消、恢复覆盖不动。
- YUK-953：merge owner与命名两个独立lane；root修掉旧重复实现和跨包deep import，
  加锁防止归因覆盖并移回owner的post-accept parity。182 scoped DB与13 unit绿；
  保留单次命名、retention由FSRS owner读取；ratchet收紧444/0/47；
  独立首审APPROVE、typecheck/lint/build/audits绿色，准备push exact-head CI。
- YUK-954：Copilot共同执行规则封装在独立lane实施，保留前台/耐久生命周期差异。
- YUK-955：录入完成command在独立lane实施；保留原子导入、source约束与四类outcome。
- YUK-956：ReviewSettlement封闭三个命令，共同学习状态规则与恢复契约正在独立lane实施。
- Linear已恢复读写（部分调用偶发transport失败）；939/940/941/952 Done，953—956进行中。

## NEXT

1. Goal已合并；不部署、不扩大历史数据修复范围。
2. 集成Knowledge/Practice/Agency归因owner、单向命名adapter；验证9surface rollback、
   幂等、no-version-bump与历史record不可变。
3. 集成Copilot execution owner和Ingestion completion；接口测试替换内部装配断言。
4. 收敛paper/review判分完成的真实重复结算规则，保留各自生命周期、late-result fences。
5. 服务端表达明确模式终态，客户端统一消息投影；待UI具体文件清单批准后实现。
6. 随业务封装继续全项目测试精简，记录每项删除的替代行为证据；不按用例计数硬删。
7. 每片独立review预算最多初审+一次P0/P1验证审；本机不跑full pnpm test。

## PARKED

- 生产deploy/observation、历史数据删除、SoT flags切换：无授权，未执行。
- 旧mailbox/ToolOperations drain-only恢复器：需部署后零pending证据，不删历史读/表/migrations。
- YUK-921多provider、YUK-572夜间教研、YUK-832 HOLD不因工程改造自动开启。

## BLOCKED-ON

- UI改动需已提交的精确设计原文/组件类型/文件清单批准；等待期间后端照常实施。
- 逐实体最终去掉迁移开关需获准production clone上的backfill/audit/rebuild/golden证据；
  当前先消除各业务入口的重复兼容实现，不伪称状态迁移已完成。
