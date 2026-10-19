# YUK-1577 — advisory-lock 静态盘点与排序证据

> 架构深化线子任务交付文档（修正版，父验收退回 `fc6197324` 后重做）。
> 2026-10-20 续片：四项已核实事实错误已按源码 revision `4419f4fbb` 修正
> （分支 `docs/yuk-1577-correct-lock-registration`，正常 merge 警示提交
> `c31424d0`；§9）。本记录仍不是完整排序证明。
> 原分支 `refactor/yuk-1577-lock-ownership-registry`，基于 `origin/main@69644912`。
> 登记文档：`docs/architecture/advisory-locks.md`。**无生产代码改动**——首版的
> registry 模块与 fail-closed 消费面已按 brief 撤回（见 §6 修正记录）。

## 1. 交付物

| 物 | 位置 | 说明 |
|---|---|---|
| 锁登记文档 | `docs/architecture/advisory-locks.md` | 覆盖口径、helper 表、81 族紧凑表、排序边摘要、已知边界 |
| 原始证据（仓库外） | `…/YUK-1577/fc619732/raw-lock-sites.txt` | 148 行文本匹配原样 |
| 站点分类 | `…/fc619732/site-classification.txt` | exec/comment 逐行计数 |
| 旧 79 族机读表 | `…/fc619732/family-table.md`、`registry-snapshot.ts` | 被撤下的 registry 稿，仅作快照；含已修错误 |
| 旧逐边调用链 | `…/fc619732/edge-evidence.md` | 每条边的语句序证据、dyn 标注；含已修错误 |
| 四事实修正证据 | `…/YUK-1577/4419f4fbb8c93cc5c6b42f08c2e44502a3788a34/four-facts-correction/` | 81 族表、逐边修正、修正清单与 SHA（§9） |

## 2. 口径（修正后，不冒称）

- 文本扫描匹配 **148** 行 = **130 条可执行语句**（120 xact_acquire + 1 try_xact +
  5 try_session + 4 unlock）+ **18 条注释/文档引用**。148 不是"生产站点数"，
  注释从不执行。
- **81 family** 是本次扫描归并出的 distinct key 模板/命名空间数——分母是本盘点
  自身的归并结果，不证明全仓再无其他 advisory 站点（动态 SQL、拼接 SQL、非 ts
  载体可能漏出文本扫描面，已在文档 §5 列为 unknown）。旧版 79 族因 appeal
  混族行拆分（#10/#80/#81）+2。
- helper 转调获取点（`acquireSortedAdvisoryLocks` 11 文件、`acquireLearningStateWriteLock`/
  `withLearningStateLock` ~24 文件等）是"同一语句多处触发"，计族不计站点。
- 排序边**只录同一 critical section 内的语句序证据**；经动态 dispatch 的边标 dyn。
  **`after` 边集不是无环图**——`instance ⇄ corrections:all` 是已证 2-环（§9-1），
  已核站点内由 G 共同串行化；边集**不证明** 0 reachable cycles、不证明无
  反向站点、不证明跨 backend 无互等，亦不构成完整排序证明。

## 3. 顺序登记摘要（四事实已修；限度见 §5/§9）

learning spine：`G → fsrs:*(sorted) → ability_global(sorted)`；
assessment：`G → group → 行锁 → fsrs:*`；
intervention：`G → instance → corrections:all → source`（activate）与
`G → corrections:all → instance`（native review）双向并存，G 共同串行化；
appeal：`request → group`、激活回调内 `group → resolution`；
stream：`session(compose-paid) → xact(compose)`、`scope → session-partition`、
`deliver → compose`；durable：install tx `fence → 族控制锁`，runtime tx
`control 行锁 → tick`（不同事务，不拼同段）；
paid-effect：`control → identity row → gate`；provider：`op-kind → sorted attempt →
lane`；小边：probe-question → conjecture-fold → proposal_decision、
write_quiz → proposal_decision、note_refine effect → product、paper-native →
attempt-claim、review-answer → group、serving → admission 行锁。

## 4. R1 纠正：撤回 G/group 互等候选

`evaluate-submission.ts` 的 `run` 只含 load → model → seal，seal 不获取 G；
G :820 位于另一个 export `activateSubmissionCandidate` 的事务 :818。
原文将相邻函数误当嵌套调用，A 持 session(group) 再等 G 的前提为假，
不据此登记 deadlock bug。真实的 G→group 激活顺序不变；跨 backend 同组
等待仍覆盖 model span，其他行锁介导形态未知，无 DB 并发运行证明。

原外部证据保留；纠正 E3x 的新副本和 SHA-256 见锁登记文档 §4。
同时修正扫描正则漏列 plain `pg_advisory_lock`（148 中唯一额外匹配为注释），
以及 family 71 直接语句数 2→1。生产源码/测试均未变。

## 5. 指标与验证

- 生产 diff：**0 行**（两 helper 恢复至 base 逐字节相同；registry.ts 删除）。
- 文档：`docs/architecture/advisory-locks.md`（重写，紧凑表+论证+指针）+
  本文（重写）。
- 验证已跑：`git diff --check` 净、`git status` 仅两文档、两恢复文件与 base diff 为空。
- **NOT_RUN**：typecheck/lint/build 未重跑（改动仅文档与"恢复至已验证 base 状态"的
  代码，无可编译增量）；无测试增删（owner 批准缺席）、无 DB/runtime/provider/paid。
- 诚实边界：81 族为 self-consistent 分母；动态 key 实例域、`<requestId>`/`<runId>`
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

## 8. 父级收口（2026-10-20）

修复 revision `36ba2b8a2c3a09308d6123a4a048d54685979fbb`：GLM 独立 R1 后
唯一 R2 已通过，三个证明错误均已纠正；无第三轮。父级 `pnpm typecheck`、
`pnpm lint`、`pnpm build` 均退出 0（这是对 §5 初版 NOT_RUN 的补充）。
无生产/测试代码改动，无 DB/运行时/并发锁验证；本片不结清 YUK-1577 的完整排序证明。

- 检查结果：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1577/36ba2b8a2c3a09308d6123a4a048d54685979fbb/parent-checks/results.json`，SHA-256 `91b36c6967e508045a0cef81df50da52062fb986d6b874c5043075d3d844cb3f`。
- R1：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1577/2ecfde084/review-r1-glm.md`，SHA-256 `9f703706e215923c925c29268d22b8c48c7e55fa714bf11fa5bb5c3243a7a907`。
- R2：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1577/36ba2b8a2/review-r2-glm.md`，SHA-256 `df1078611c409ec82c5a49a348064a8dc5d46b9eeb19573c521b60f449bc523d`。

仍未证明：动态路径全部排序、共享 key 实例域与行锁交互；族表 sites 的共享 helper
重复归属口径和旧快照目录命名是 R1 已记录的非阻塞后续，不冒称已修。

## 9. 四事实修正（2026-10-20，分支 `docs/yuk-1577-correct-lock-registration`）

修正顶部警示登记的四项事实错误。核对源码 revision
`4419f4fbb8c93cc5c6b42f08c2e44502a3788a34`（origin/main；所引站点文件与 R1
核对 revision `2ecfde0840ad3dbf3c60eac6763c604d34aea99e` 逐字节一致，
`git diff --name-only` 为空）。封存旧件 `fc619732/`、
`…/2ecfde084…/r1-correction/` 未覆盖，含已修错误作历史反例。

1. **intervention 反边**：`recordNativeInterventionDiagnosticReview`
   （store.ts:554）同 tx 内 G(:555) → corrections:all(:557) → 内联
   `withLearningStateLock` 重入 G(:595) → instance(:597)，原"未见反向"撤回。
   G 共同串行化静态条件：同取 instance+corrections 的已见路径全程持 G（单一
   xact 键）；无 G 的 corrections 站点（reconcile:212/probe-subscription:115/
   writeEvents:342）不取 instance，无 G 的 instance 站点（:757）不取
   corrections → 已核站点内环不可达，不宣称无 runtime 死锁，不再保留
   "边集无环"措辞。另补 `copilot-execution-settlement → source`
   （review-answer-consumer.ts:45→47）同 tx 边。
2. **appeal 拆族**：`evt_native_appeal_<hash>`（#10，appeal.ts:24）、
   `evt_native_resolution_<hash>`（#80，appeal.ts:78）、`hte(appeal.id,0)`
   （#81，rejudge.ts:45）分族；`request → group`（:24→:41）、激活回调内
   `group → resolution`（:155–161→evaluate-submission.ts:833，settle `fsrs:*`
   条件插入）登记。族总数 79→81。
3. **durable 分事务**：install tx `fence → (1356,1)/(1355,1)/(1393,1)/
   session-orphan-install`（无 tick）；runtime tx `control 行锁 → tick/
   reconcile`（FOR SHARE/UPDATE）。advisory 族控制对与 per-tick 从未同 tx
   共现，`family-control → per-tick` 拼接撤回，未推断未证跨 tx 边。
4. **锁空间**：PG 单参签名 `pg_advisory*(key bigint)`（functions-admin
   §9.28.10）；`hashtext` int4 符号扩展、`hashtextextended` int8、int 字面量
   同处一个 bigint 锁空间，编码标签不是锁空间；双参 `(integer,integer)`
   另一空间（pg_locks objsubid 单参=1、双参=2）。全篇 "int4/int8 两空间"
   表述已改。

证据（仓库外，新目录，未覆盖封存件）：
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1577/4419f4fbb8c93cc5c6b42f08c2e44502a3788a34/four-facts-correction/`

| 文件 | SHA-256 |
|---|---|
| `family-table.md`（81 族） | `34f8616c9062d82fc1e6878effe735035fddd7fb3703ab240d17528dcffc1377` |
| `edge-evidence.md` | `020f9ed77111856f0823612be79b2f32224d69345314d77d3fe28b84a8e05e52` |

验证已跑：源码逐站点读取（上列行号链）、`git diff --name-only` 结转段核对、
`git diff --check`。**NOT_RUN**：typecheck/lint/build（仅文档改动、无可编译
增量，父级可补）、全部本地测试（无增删）、DB/TEST/Docker/provider/paid、
tsx -e/手造输入验证。仍未证：行锁全图、动态 dispatch 全路径、跨 backend
等待、动态 key 实例域——本片不结清 YUK-1577 完整排序证明。
