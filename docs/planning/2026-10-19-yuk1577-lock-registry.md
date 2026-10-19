# YUK-1577 — advisory-lock 静态盘点与排序证据

> 架构深化线子任务交付文档（修正版，父验收退回 `fc6197324` 后重做）。
> 分支 `refactor/yuk-1577-lock-ownership-registry`，基于 `origin/main@69644912`。
> 权威文档：`docs/architecture/advisory-locks.md`。**无生产代码改动**——首版的
> registry 模块与 fail-closed 消费面已按 brief 撤回（见 §6 修正记录）。

## 1. 交付物

| 物 | 位置 | 说明 |
|---|---|---|
| 权威锁文档 | `docs/architecture/advisory-locks.md` | 覆盖口径、helper 表、79 族紧凑表、排序边摘要、已知边界 |
| 原始证据（仓库外） | `…/YUK-1577/fc619732/raw-lock-sites.txt` | 148 行文本匹配原样 |
| 站点分类 | `…/fc619732/site-classification.txt` | exec/comment 逐行计数 |
| 79 族机读表 | `…/fc619732/family-table.md`、`registry-snapshot.ts` | 被撤下的 registry 稿，仅作快照 |
| 逐边调用链 | `…/fc619732/edge-evidence.md` | 每条边的语句序证据、dyn 标注 |

## 2. 口径（修正后，不冒称）

- 文本扫描匹配 **148** 行 = **130 条可执行语句**（120 xact_acquire + 1 try_xact +
  5 try_session + 4 unlock）+ **18 条注释/文档引用**。148 不是"生产站点数"，
  注释从不执行。
- **79 family** 是本次扫描归并出的 distinct key 模板/命名空间数——分母是本盘点
  自身的归并结果，不证明全仓再无其他 advisory 站点（动态 SQL、拼接 SQL、非 ts
  载体可能漏出文本扫描面，已在文档 §5 列为 unknown）。
- helper 转调获取点（`acquireSortedAdvisoryLocks` 11 文件、`acquireLearningStateWriteLock`/
  `withLearningStateLock` ~24 文件等）是"同一语句多处触发"，计族不计站点。
- 排序边**只录同一 critical section 内的语句序证据**；经动态 dispatch 的边标 dyn。
  `after` 边集无环只说明"登记的边彼此不构成环"，**不证明** 0 reachable cycles、
  不证明无反向站点、不证明跨 backend 无互等。

## 3. 已证边摘要（详见 edge-evidence.md）

learning spine：`G → fsrs:*(sorted) → ability_global(sorted)`；
assessment：`G → group → 行锁 → fsrs:*`；
intervention：`G → instance → corrections:all → source`；
stream：`session(compose-paid) → xact(compose)`、`scope → session-partition`、
`deliver → compose`；durable：`fence → family-control → tick`；
paid-effect：`control → identity row → gate`；provider：`op-kind → sorted attempt →
lane`；小边：probe-question → conjecture-fold → proposal_decision、
write_quiz → proposal_decision、note_refine effect → product、paper-native →
attempt-claim、appeal/review-answer → group、serving → admission 行锁。

## 4. 静态推导的互等形态（P1 候选，未修）

`evaluate-submission.ts:785` model 路径持 **session(group)** 覆盖 model 调用全程，
其 sealing tx 内顺序 G → xact(group)（同键同 backend 自重入不等待）；另一 backend
走 deterministic/G 路径（自带 Tx 或 activate.ts）先持 G 再等 xact(group)——
两边互等时 PG deadlock detector 应以 abort 解环（错误非挂死）。**无运行证据、
reachability 未证**；文件在禁改清单，建议父级按 P1 候选立项（Linear 由父级决定），
验证方案：同组 model span 与 G 持有窗口重叠压测。

## 5. 指标与验证

- 生产 diff：**0 行**（两 helper 恢复至 base 逐字节相同；registry.ts 删除）。
- 文档：`docs/architecture/advisory-locks.md`（重写，紧凑表+论证+指针）+
  本文（重写）。
- 验证已跑：`git diff --check` 净、`git status` 仅两文档、两恢复文件与 base diff 为空。
- **NOT_RUN**：typecheck/lint/build 未重跑（改动仅文档与"恢复至已验证 base 状态"的
  代码，无可编译增量）；无测试增删（owner 批准缺席）、无 DB/runtime/provider/paid。
- 诚实边界：79 族为 self-consistent 分母；动态 key 实例域、`<requestId>`/`<runId>`
  同源性、fsrs→group 反向序均列 unknown/no-observed-counterexample（文档 §5）。

## 6. 修正记录（fc6197324 → 本版）

父验收退回理由：brief 明确"no new runtime validator merely to say registry live"，
`requireSessionAdvisoryLockFamily` 恰是 runtime validator + 新拒绝路径；且
"79/79 覆盖""0 reachable cycles""行为不变"等表述超出证据。
修正：①两 helper 恢复 base 逐字节；②删除 `src/db/advisory-lock-registry.ts`；
③机器清单移仓库外 snapshot；④仓库文档改紧凑表+诚实口径；⑤全部过度表述
（"behavior unchanged"/"0 cycles"/"148 生产站点"）改为带限定的口径。

## 7. 非目标（维持）

不生成 SQL、不改获取/重试/超时/释放语义、不加 runtime consumer/validator、
不加检查脚本或测试、不动禁改清单文件（paid-effect 链、`src/server/ai`、测试等）。
