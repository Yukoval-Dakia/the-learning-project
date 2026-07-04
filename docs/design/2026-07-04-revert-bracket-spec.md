# Worklist #10 — revert-bracket decide-and-record 设计（reconciled 终稿）

> **版本**：2026-07-04 reconcile 终裁版。draft → Lens A（因果/可逆性）+ Lens B（工程/运行时）双对抗审查 → 本终稿。逐条裁决见附录 B（Attack Ledger）。全部 file:line 对 `origin/main = ec4693d8` 重接地（争议处终裁自行 `git show` 抽验）。

- **单元**：master register §3 polish-order #10（`G3/F8 revert-bracket — decide-and-record`，P1-systemic）
- **owner 决策（2026-07-04）**：**选项 A** —— 修 A-class 可达性（串 `caused_by` 中间 checkpoint）+ 接一个 live caller。这是给定约束，本设计只裁「怎么修」，不裁「修不修」；显式退休 register 的选项 (b)（θ̂/mastery 记为 append-only + 退掉 A-class bucket）。
- **红线继承**：n=1 不拟合 item 参数；fold-owned 表不许 raw UPDATE 走事件层；forensic/experimental 事件 `ingest_at:now`；数据门只 gate 翻转不 gate build；护栏两层（warning 水位 vs 硬顶）；无死 fallback；轻量/完整两案并呈；新常量标「未经数据校准的保守初值」。
- **reconcile headline**：draft 的核心机制（Q1-a checkpoint 拓扑 + Q3 无损快照 + Q2 revert-only caller）双 lens 均 UPHELD；但 **live caller 半有三个必修**（原子性、auto_rate/位翻转门、no_checkpoint refusal），加上 happy-path 残留可见性 + 段感知补偿 + 快照列完整性，全部修入本稿。

> **O2 完整案对齐，2026-07-04（owner AskUserQuestion 拍板，附录第 2 条）**：本稿 M5/Q3/切片节原按**轻量案**（单快照两轴共存 + 段过滤 + 段感知 retract）写成。owner 拍**完整案——θ̂/FSRS 双 sibling checkpoint 事件**。以下机制节已全部重写为双 sibling 形态：
>   - **拓扑**：每 attempt E 按段各写一条独立 checkpoint + 独立 snapshot：θ̂ 段 `C_θ`(`${E}:checkpoint:theta`) → `S_θ`(`${E}:snapshot:theta`)；FSRS 段 `C_f`(`${E}:checkpoint:fsrs`) → `S_f`(`${E}:snapshot:fsrs`)。两 checkpoint 是 E 的 sibling 子节点。
>   - **捕获列分配**：`S_θ` 只带 θ̂ 段（theta_snapshots，其 `before` 携 theta_hat/rt/grid 全列；fsrs_snapshots:[]）；`S_f` 只带 FSRS 段（fsrs_snapshots；theta_snapshots:[]）。
>   - **段撤销天然正交**：revert θ̂ = `revert(${E}:checkpoint:theta)`（闭包 = {S_θ}）；revert FSRS = `revert(${E}:checkpoint:fsrs)`（闭包 = {S_f}）。**「撤哪个事件」即表达段选择——`revertSegments` 过滤字段整个退场，orchestrator 无段裁切逻辑，retract 也无 `reverted_segments` 字段**（被撤 snapshot 的 subject_id 即段身份）。永不需要存量迁移（段独立 collect/guard/tombstone）。
>   - **代价（owner 接受）**：事件登记面 ×2（grading_checkpoint 一个 action 承两段，segment 字段判别）、每 attempt 双段双写（最多 4 event：2 checkpoint + 2 snapshot）、双事件原子性由**同 tx 原子写 + 同条件写不变量覆盖两段**保证。live caller（rejudge）当前只撤 θ̂ 段；FSRS 段 checkpoint/snapshot 写但 inert（future-ready，FSRS 接线时 `revert(C_f)` 即可达）。

---

## 1. 现状与问题（逐行接地，含审查订正）

### 1.1 写侧：每次 attempt 都写一个 A-class snapshot，但它挂错了父

**solo review**（`src/capabilities/practice/api/submit.ts`）：

- review event `E`：`action:'review'`，`caused_by_event_id: null`（submit.ts:572）。
- judge event `J`：`action:'judge'`，`subject_id: E`，`caused_by_event_id: E`（submit.ts:587-624，caused_by 在 :619）。
- snapshot `E:snapshot`：`action:'experimental:state_snapshot'`，`subject_id: E`，**`caused_by_event_id: eventId`（= E）**（submit.ts:708），`ingest_at: now`（:712，opt out memory outbox）。payload = `{ attempt_event_id, theta_snapshots[], fsrs_snapshots[] }`（:698-707）。**solo snapshot 无条件写**（tx 内顶层，无 if-guard）。

**paper**（`src/capabilities/practice/server/paper-submit.ts`）：同构 —— attempt `E`（`caused_by: null`，:566）→ judge `J`（`caused_by: E`，:615）→ snapshot（**`caused_by_event_id: attemptEventId`**，条件写 `if (fsrsWrote || thetaSnapshots.length > 0)`，:778-780）。

snapshot payload schema（`src/core/schema/event/state-snapshot.ts`）：

- `ThetaSnapshot = { kc_id, before: z.number().nullable(), after: z.number() }`（:36-40）—— **只带 `theta_hat`**，`before=null ≡ 冷启无行`。
- `FsrsSnapshot`（:48-53）—— 带**整张 FSRS Card**（before nullable / after）。
- **两轴 bracket 在同一个 event 的同一 payload 里**（θ̂ 段 + FSRS 段共存一行）——见 §3 Q3b 段感知决策。

### 1.2 读侧：orchestrator 结构性打不着 A-class（双 lens UPHELD）

`orchestrateCascadeRevert`（`src/server/revert/cascade-revert.ts:245`）流程：

1. `collectCascadeFromCheckpoint`（`src/server/events/cascade.ts:84`）—— 沿 `caused_by_event_id` 反向收集下游闭包，排除 root 自身（cascade.ts:18-19），排除 `action='correct'` 节点与桥（:24-27，CTE :116-140）。硬顶：`CASCADE_DEPTH_LIMIT=64`（:36）+ `CASCADE_DEFAULT_NODE_CAP=10_000`（:39）→ `truncated` honest-reject。
2. 载入 root row；**root 不存在 → 返回 `refusal:'irreversible'`（cascade-revert.ts:262-270）**——这是 Lens B F3 的雷源（见 §3 Q2c）。
3. `orderedRows = [...cascade.nodes(depth-DESC), rootRow]`，`effects = orderedRows.map(classifyRow)`。
4. **step-4 all-or-nothing**：任一 `irreversible` → 整体 refuse（:297-309）。
5. step-5 A-class 冲突守卫（`assertSnapshotMatchesCurrent`，**tx 外预检**，:311-329）——对 payload 里**每个** θ̂ 项断言 `current === after`（`thetaExactEq` f64 精确，:618-620）+ **每个** FSRS 项 deep-equal（:585-600）。
6. step-6 单 tx apply（:340-399）：restore 前 tx 内**再跑一次守卫**（defence-in-depth，冲突 throw `CascadeRevertConflictError` 回滚整 tx，:348-355）+ 每节点写 `correct(retract)` 补偿（`actor_ref:'cascade_revert'`，`ingest_at:now`，`caused_by:e.eventId`，:377-396）。

`classifyRow`（:199-235）：`experimental:state_snapshot` → A-class（:202）；`generate(knowledge_edge, create)` → `structural_imperative`（:216-226）；`EVENT_LAYER_ACTIONS`（:111-118）→ `event_layer`（:228）；**catch-all → `irreversible`（:234）**—— `review`/`attempt`/`judge` 全落这里。

**结构性不可达证明**（Lens A/B 双双 code-verify UPHELD）：snapshot 唯一父 = `E`；`E.caused_by = null` ⇒ `E` 永远只能当 root；checkpoint=`E` 时 `E` 进 orderedRows，`classifyRow(E)='irreversible'`，step-4 在 restore 前 refuse。⇒ A-class 成功路径在生产 topology 下不可达。现有 `cascade-revert.db.test.ts` 靠合成 topology（snapshot 挂 `copilot_user_ask` 检查点——无生产 writer 产此形状）才走通。

**审查订正（Lens A F4，ACCEPT）**：cascade 的 `action <> 'correct'` **只排除补偿节点本身**（cascade.ts:24-27），被 retract 的 snapshot **仍会被重新 collect**。实际阻止「二次 revert 同一 checkpoint 双重 apply」的是**冲突守卫**（revert 后 current=`before`≠`after` → conflict refuse），**不是 tombstone**。冲突守卫同时是 **LIFO 正确性载体**——restore-to-before 只对「该 KC 的最近一次 transition」数学正确，守卫强制了这一点。orchestrator :371-376 的注释归因（"re-collection won't re-sweep it"）对 snapshot 不成立，本波顺手订正注释 + 加 revert-twice 回归测试（§6.2）。

### 1.3 restore 原语：warm 路径把 count 归零 + precision 陈旧（双 lens UPHELD）

`restoreStateSnapshot`（`src/server/revert/restore-snapshot.ts`）θ̂ warm 分支（:78-85）硬写 `evidence_count:0, success_count:0, fail_count:0, last_outcome_at:new Date(0)`，且**不传** `theta_precision` → 经 `upsertMasteryState`「不传就不改」（state.ts:140-170）→ precision 停在 attempt 后 firm 值，与 `evidence_count=0` 自相矛盾，污染 `pfaLogit(success,fail)` + `thetaSe(precision)`（state.ts:488-503）。

**数据已在手（零成本捕获，UPHELD）**：`updateThetaForAttempt` 的 pre-attempt 读（state.ts:987-1012）已捕获 `thetaBefore/theta/evidence/success/fail/precision/gridPrior/rtBuffer` 全套；snapshot push（:1151）却只塞 `{kc_id, before: s.thetaBefore, after: newTheta}`。

**审查升级（Lens B F5，ACCEPT + 终裁加重）**：同一 attempt 还会写 `rt_correct_ms`（state.ts:1134-1146，gate `useSrt && outcome===1`）与 `theta_grid_json`（:1259-1271，独立块）。**`SRT_ENABLED = true` 是 LIVE**（`src/core/theta.ts:259`，YUK-361 P1 go-live），所以 rt buffer **今天就在被写**——「只还原 θ̂+counts」的 restore 对带 RT 的答对 attempt 今天就不 verbatim（残留一个 post-attempt 样本），不是 flag-coupled 未来问题。`THETA_GRID_ENABLED = false`（theta-grid.ts:54，A4 dark）。⇒ `before` 必须捕获**全部 attempt 可写列**（§3 Q3）。

### 1.4 live caller 缺席 + rejudge 既有形态（关键接地）

- `orchestrateCascadeRevert`/`restoreStateSnapshot` 零 live caller（只被 db test import）。
- **rejudge（`src/capabilities/practice/jobs/rejudge.ts`）**：pg-boss handler 由 `server/boss/handlers.ts:66-70` 以**裸 `db` 无 tx** 调用。幂等守卫在**函数顶部、任何写之前**：`WHERE caused_by_event_id = appeal.id → skipped 'already_resolved'`（rejudge.ts:57-62）。overturn 分支是**三个独立 auto-commit 写**：newJudge（`caused_by: appeal.id`，:127-155）→ correction（`caused_by: newJudgeId`，:157-176）。`judge.subject` = 作答事件（**卷题 attempt / 散题 review 都在申诉面内**，:70-71）。FSRS 刻意不在此重写（:13-15）。
- **θ̂ 归因的关键分叉（Lens B F2 接地）**：
  - solo：`outcome = finalRating === 'again' ? 'failure' : 'success'`（submit.ts:390）；`finalRating` 默认 = **用户手评** `body.rating`，只有 `body.auto_rate=true` 才被 judge 的 suggestedRating 覆盖（:282-306）。而独立 judge 锚点**不看 auto_rate 照写**（:587）⇒ **手评作答也有可申诉的 judge event，但其 θ̂ 不是判决驱动的**。`payload.judge.auto_rated` 已存在 review event payload（:502）。代码库已有同源判例：family calibration 明确 gate 在 `body.auto_rate`（:722-727，「手评带用户主观，污染 b 通道」）。
  - paper：`attemptOutcome` 直接派生自 judge `coarseOutcome`（paper-submit.ts:275-282），θ̂ 输入 `attemptOutcome==='failure'?0:1`（:671，**partial→1**）⇒ paper θ̂ 恒判决驱动。
- judge-overturn reproject 是 4 个被 gate 下游中唯一直接的 θ̂ 自愈诉求（register `judge-fidelity-spof`：「θ̂ never reprojected after an overturned verdict — needs a visible marker」）。

### 1.5 F8 横切判据（register ~1167-1173）

「revert/reversal bracket is dark **and** structurally non-functional on every θ̂/mastery write」——三条 live 写路径都隐性押注一张既没接线又打不着的 revert 网。#10 = 单一 decide-and-record，gate 住 4 个下游。owner 拍板走 (a)。

---

## 2. 目标 / 非目标

### 目标
1. **修 A-class 可达**：经中间 checkpoint 让「一次 attempt 的 θ̂ 派生副作用」在不碰 attempt 真实事实的前提下可 revert。
2. **snapshot 无损化**：θ̂ `before` 捕获**全部 attempt 可写列**（counts + precision + delta + rt buffer + grid），restore = verbatim 全行还原。
3. **接一个 live caller（原子）**：judge-overturn 触发 θ̂ 段 revert，**与改判写同 tx 原子提交**；且只在「判决实际驱动了 θ̂ 且改判翻转了 θ̂ 位」时触发。
4. **残留全量可见**：happy-path 与 conflict-path 都写 `reproject_deferred` 可见 marker——第二实例重投影引擎的 worklist 必须完整（register「make the residual visible」的字面要求）。
5. **forensic 纪律**：revert 事件 append-only、`ingest_at:now`、段感知（**O2 双 sibling**：段身份由被撤 snapshot 的 subject_id `${E}:snapshot:theta`\|`:fsrs` 自证，无 reverted_segments 字段）、可追溯到 overturn。
6. **可观测 + runbook**：护栏两层；三类+1 refusal 处置手册；诚实标注多 KC conflict 命中率预期。

### 非目标（明确外推）
- **全历史重投影 / re-apply 改判后的正确 outcome**（第二实例原则）—— judge-spof 下半，独立 issue。本波所有 overturn（含 happy-path revert 成功的）经 `reproject_deferred` marker 排进它的 worklist。
- **A2 `ability_global` bracket** —— `HIERARCHICAL_ELO_ENABLED` OFF（state.ts:1033/1156-1158 无 global 行写入），随 A2 ship（state.ts:881-885 注释已 flag）。
- **Elo-K 曲线升级** —— harness-gated，正交。
- **mem0 平行 append-only 决策** —— 不同子系统不同代价结构，独立。
- **FSRS 段 revert 接线** —— rejudge 明写 FSRS=用户确认动作（rejudge.ts:13-15）；ADR-0035 R⟂p(L) 允许 θ̂ 独立撤。段感知机制（Q3b）保证未来接 FSRS 不被焊死。
- **unarchive_edge / extract / suppress 可逆化** —— fail-closed 正确，不动。

---

## 3. 决策表（reconciled）

### Q1 — A-class 可达性修复形态：怎么串 `caused_by` 中间 checkpoint？

| 方案 | 机制 | 取舍 |
|---|---|---|
| **Q1-a（选定，owner 定向）中间 grading-checkpoint 锚** | attempt `E` → checkpoint `C`（`id=${E}:checkpoint`，`caused_by:E`）→ snapshot（`caused_by:C`）。live caller revert `C`。 | ✅ `C` 闭包 = `{snapshot}`，不含 `E`/`J`（父/兄弟，CTE 只向下走——双 lens 闭包数学 UPHELD）。✅ 语义清晰 + 未来 sibling 副作用可原子分组。✅ 把测试的合成形状变成生产真形状。⚠️ +1 event/attempt（solo 无条件）。 |
| Q1-b（轻量案，透明记录）snapshot 自身当 root | 零写侧改动；直接 `revert(${E}:snapshot)`（snapshot 作 root → A-class → 全通）。 | ✅ 今天就能跑。❌ 效果行当 checkpoint-root 语义 smell；无 sibling 分组。 |
| Q1-c（否决）放松 classifyRow / all-or-nothing | — | ❌ 违诚实天花板 §100。 |

**裁决：Q1-a（owner 已拍）**。**诚实标注（Lens B F7，ACCEPT）**：Q1-a 相对 Q1-b 多付的 +1 event/attempt，买的「A2/family/difficulty 挂同一锚」扩展性**本波兑现不了**（A2 flag OFF；family/difficulty 走 SAVEPOINT 写非 event 表，今天不会成为 C 的 cascade 子节点）——当前是纯为 topology 干净付费，ROI 递延；Q1-b 留作可回退姿态。**step-4 all-or-nothing 不放松**；修复靠把 snapshot 移出必含 irreversible attempt 的闭包。

**checkpoint `C` 分类**：加入 `EVENT_LAYER_ACTIONS`（cascade-revert.ts:111）——`C` 无独立 SoT 行（A-class 状态在挂它的 snapshot 里），`correct(retract)` 即完整反转，与 `copilot_user_ask`/`chip_trigger` 同类（语义精确，双 lens UPHELD）。

**写侧不变量（Lens A F6，ACCEPT）**：`event.caused_by_event_id` **无 FK**（schema.ts:814 裸 text，:838 只有 index）——draft 的「FK 保证写序」是假前提，删除。真正要守的不变量是「**C 与 snapshot 逐字节同条件写**」（写了 snapshot 必写 C，反之亦然；paper 侧同挂 `if (fsrsWrote || thetaSnapshots.length>0)`，solo 侧同为无条件）——否则产生 dangling `caused_by` 的 snapshot 永久不可 revert 且无 DB 层兜底。加显式测试（§6.2）。

### Q2 — live caller：judge-overturn（reconciled，三个必修全部修入）

首个 caller = **rejudge overturn 分支，revert-only（θ̂ 段）**。4 候选对比不变（judge-overturn 是唯一直接诉求；conjunctive/elo-k 无 live 触发；taxonomy 是被修机制本身）。以下三条是对抗审查修入的必修：

**Q2a — 原子性（Lens A F1 = Lens B F1，ACCEPT，MAJOR，非修不可）**

失效链（code-ground）：overturn 首跑 newJudge auto-commit ✓ → correction ✓ → 独立 tx 的 revert 抛瞬时 DB 错（40001/timeout/断连）→ handler throw → pg-boss 重试 → 幂等守卫（rejudge.ts:58-62）命中已 commit 的 newJudge → `already_resolved`（成功）→ **revert 永不再跑**，vetted-wrong θ̂ 污染永久残留且 job 报成功——恰是本单元要消灭的失效模式被守卫锁死为不可自愈 + 假完成。draft Q4 的幂等论述只覆盖双-revert，没覆盖 never-revert-on-retry。

**修法（选 (a) 真原子）**：`handleRejudge` 的 overturn 分支包进**同一 `db.transaction`**：`tx { newJudge; correction; revert-or-marker }`——改判与 θ̂ 自愈同生共死，部分失败整体回滚，重试从头干净重放，守卫对真完成的 run 仍正确。技术细节：

- `orchestrateCascadeRevert` 增加 **tx-aware 变体**（或首参改 `DbLike` + options 注入）：`collectCascadeFromCheckpoint`/`loadEventRow` 已是 `DbLike`（cascade.ts:33 / cascade-revert.ts:93）；step-5 预检读迁进 caller tx；step-6 的 apply 用 `tx.transaction(...)` **嵌套 SAVEPOINT**（drizzle 既有先例：paper-submit.ts:717/:741）——apply 内 throw 只回滚 savepoint，**refusal 以返回值形态回到 caller**，caller 在同一外层 tx 里写 deferred/error marker 再整体 commit。这是 PR-4 必须计价的非平凡 orchestrator 签名重构（draft 切片未计价，现已计入 PR-3）。
- 备选 (b)（守卫改 revert-aware resume）记录不采：需要可靠的「revert 已完成」信号且语义更绕；(a) 直接给出 overturn+heal 原子性。

**Q2b — 触发门：判决驱动 + θ̂ 位翻转（Lens B F2，ACCEPT，MAJOR + 终裁补强）**

θ̂ revert 只在**两个条件同时成立**时触发：

1. **判决实际驱动了 θ̂**：`answerEvent.action === 'attempt'`（paper，恒判决驱动）或 `answerEvent.action === 'review'` 且 `payload.judge?.auto_rated === true`（submit.ts:502 已存）。auto_rate=false 的 solo：θ̂ 来自用户手评（submit.ts:390 + :282-306），overturn 撤它是纯污染——与 family-calibration 的同源判例（:722-727）一致。
2. **改判翻转了 θ̂ 位**（终裁补充，两 lens 均未点到）：`bit(coarse) = coarse ∈ {correct, partial} ? 1 : 0`（solo 经 ratingFromCoarseOutcome→again 二分、paper 经 attemptOutcome 派生，两路同构；paper partial→1 见 paper-submit.ts:671）。**此位翻转「no-marker」判据只裁真 θ̂-moving prior（prior 与 new 均 θ̂-有意义，∈ {correct, partial, incorrect}）**：`bit(priorOutcome) === bit(newOutcome)`（如 partial→correct）时 θ̂ transition 本就是正确位的更新，**revert 会删掉合法信号**——不 revert、不写 marker（O3，无 θ̂ 残留）。**θ̂-skipped prior（unsupported/unknown）绝不走此判据**：它无 bit（θ̂ 从未动），`outcomeBit` 会把它误并进 failure 位（0），故 `unsupported/unknown → incorrect`（同 0 位）会被误判成「位未翻」而**漏掉本该写的 residual marker**（FIX-1 修复的 P0）——由 item 3 的 skipped-prior 分句单独接管。
3. **θ̂-skipped prior（FIX-1 P0，rejudge.ts `thetaSkippedPrior` 门）**：prior ∈ {unsupported, unknown}（θ̂ 被跳过，`theta_snapshots:[]` / 无 `${E}:checkpoint:theta`——paper-submit.ts:651-655）overturn 到**任意 θ̂-有意义 new outcome**（correct/partial/incorrect；`new === 'unsupported'` 已在 rejudge.ts:113 当 upheld 过滤，故此处 new 必 θ̂-有意义）→ **一律经 revert 路径**（门直接置 `shouldRevertTheta = judgeDriven && (thetaSkippedPrior || 位翻转)`，绕过位翻转判据）。因无 checkpoint，orchestrator 天然返 `no_checkpoint` → 同 tx 写 `reproject_deferred（residual=full_reprojection, reason=no_checkpoint）`（**与 Q2c 表对齐**——本条此前误写 `residual=reapply`，与 no_checkpoint→full_reprojection 自相矛盾，已订正）。θ̂ 段为空的 snapshot 同理：caller 检出后跳 revert 直落 marker，不做空转 retract。

不满足门的 overturn：**不 revert、不写 marker**（θ̂ 无残留；FSRS 半走既有用户确认流）——记录为决策而非静默（O 段确认窗口）。

**Q2c — refusal 分型：`no_checkpoint`（Lens B F3，ACCEPT，MAJOR）**

orchestrator 对 rootRow 缺失现返 `refusal:'irreversible'`（cascade-revert.ts:262-270）。而**所有本波之前的历史 attempt 都无 checkpoint**（+ paper 条件写为 false 的 attempt）——它们被 overturn 时若落 `else → fail-loud error marker` 会造成 error 洪水，且与 draft 自己的散文（「旧 attempt 走 deferred」）自相矛盾。**修法**：orchestrator 新增 refusal 子类 **`no_checkpoint`**（rootRow null 时返回），`irreversible` 严格留给「闭包含真 learner fact」（真 caller bug）。caller 分派（无死 fallback，四态全显式）：

| orchestrator 结果 | caller 动作 |
|---|---|
| `ok:true` | 同 tx 写 `reproject_deferred`（residual:'reapply_correct_outcome'——见 Q4）|
| `refusal:'no_checkpoint'` | 同 tx 写 `reproject_deferred`（residual:'full_reprojection', reason:'no_checkpoint'）——旧数据/θ̂-skipped prior 的 overturn honest 排队（含 Q2b item 3 的 unsupported/unknown→θ̂-meaningful）|
| `refusal:'conflict'` | 同 tx 写 `reproject_deferred`（residual:'full_reprojection', reason:'later_theta_movement', kc_conflict）|
| `refusal:'irreversible' \| 'truncated'` | 不应发生（C 闭包只有 snapshot）→ fail-loud error marker，绝不当成功 |

**Q2d — 残留全量可见（Lens A F3，ACCEPT，MAJOR）**

overturn 语义 = 「这次其实答对（或答错）」；revert-only 只抹掉错误 transition，**不 re-apply 正确 outcome**——happy-path 成功 revert 后仍有残留（正确证据从未计入：evidence_count 回退 → eloK 学习率被抬高；FSRS 仍是被推翻判定的排程）。draft 只在 conflict 写 marker ⇒ 第二实例重投影引擎的 worklist 只有 conflict 子集，happy-path overturn 从视野里消失。**修法**：如 Q2c 表——**成功 revert 也写 `reproject_deferred`**（residual:'reapply_correct_outcome'，携 appeal 上下文），worklist 完整。revert-only vs revert+re-apply 的 scope 切分本身维持（去污染无歧义正确；re-apply 归第二实例）。

**Q2e — 效力诚实标注（Lens A F7，ACCEPT）**：守卫检查 payload 内**所有** θ̂ 项（cascade-revert.ts:569-583），任一 KC 被后续 attempt 动过 → 整体 conflict → defer。多 KC 合取题的 overturn 将**以 defer 为主**；「θ̂ 自愈」只在该 attempt 全部 KC 此后未再被练时兑现。写进 runbook 预期，不当卖点。

### Q3 — `state_snapshot` 写面治理（对照 #9 write-ahead + fail-closed）

| 维度 | 现状 | 修复（reconciled） |
|---|---|---|
| θ̂ 段 payload | 只 `theta_hat`（before/after） | `before` 扩为**全部 attempt 可写列**（Lens B F5 ACCEPT，SRT live 加重）：`{ theta_hat, evidence_count, success_count, fail_count, theta_precision, last_theta_delta, last_outcome_at, rt_correct_ms, theta_grid_json } | null`。数据已全在 `states[i]` + 原始 pre-attempt row（state.ts:987-1012；`last_theta_delta`/`last_outcome_at` 从 `byId.get(id)` 原始行取）。**`after` 只留 `{ theta_hat }`**（守卫只需它；全对称 after 在 grid 翻 flag 后会双倍膨胀 payload——`after` 保守案，双 sibling 段独立不受影响）。**O2 完整案对齐 2026-07-04**：θ̂ 段独占 `S_θ`（fsrs_snapshots:[]），FSRS 段独占 `S_f`（theta_snapshots:[]）；payload schema 形态不变（两数组恒在，各事件只填一段），段隔离靠**拓扑**（各挂各的 checkpoint）而非 payload 过滤。 |
| grid after 时序 | `theta_grid_json` 写在 snapshot push **之后**的独立块（state.ts:1259-1271 vs :1151） | `before.theta_grid_json` 取 pre-attempt 读（:1006 gridPrior）即可，无时序问题；after 不含 grid（上行决策）→ 无需重排。留一行注释防未来把 grid 塞进 after 时踩时序。 |
| restore 语义 | warm 归零 counts + 不动 precision（restore-snapshot.ts:78-85） | **verbatim 全行 upsert**：`before` 各列原样写回（含 `theta_precision`/`last_theta_delta`/`rt_correct_ms`/`theta_grid_json`——upsert 面已全支持，state.ts:140-170）；`before=null` → DELETE（冷启逆）。 |
| schema 演进 | `before: z.number().nullable()` | **union（Lens B F9 ACCEPT）**：`before: z.union([z.number(), ThetaRowSnapshot]).nullable()`——新旧 payload 都过 parse barrier（前后向兼容，代码回滚不炸读侧）；**restore 侧**遇 legacy bare-number → **typed refusal `legacy_snapshot`**（Lens A F5 ACCEPT：draft 的「typed refusal」原与 parseSnapshotPayload 的 throw（cascade-revert.ts:545-550）不符——union 让 parse 过、refusal 在语义层出，绝不 lossy restore）。缓解事实：legacy snapshot 无 checkpoint C，经 C-revert 走 `no_checkpoint`，本分支是 defence-in-depth。 |
| 保留 vs 裁剪 | — | 保留 snapshot（append-only）；revert 靠 `correct(retract)` 墓碑，绝不删原行。**订正（Lens A F4）**：墓碑防的是 fold/读层重放，防双 revert 的是冲突守卫（LIFO 正确性载体）——注释与 ADR 按此归因。 |
| 守卫 | `thetaExactEq` f64 精确（:618-620） | 保留（YUK-495 S4 bit-exact）。#9 对照精化（Lens A UPHELD-7）：#9 的 restoreVerbatim 无路径依赖，θ̂ 是路径依赖量——这条守卫**严格强于** #9 的形状检查，是正确性而非仅并发的载体，ADR 点明。 |
| **段感知（Lens A F2 PARTIAL）→ O2 完整案对齐 2026-07-04** | 单 snapshot 两轴共存；retract 无段信息 | **拆双 sibling checkpoint 事件（owner 拍完整案，推翻轻量单快照+段过滤）**：θ̂ 段 `C_θ`→`S_θ`（fsrs_snapshots:[]），FSRS 段 `C_f`→`S_f`（theta_snapshots:[]），两 checkpoint 为 E 的 sibling。段撤销**天然正交**——`revert(${E}:checkpoint:theta)` 闭包只含 `S_θ`，`revert(${E}:checkpoint:fsrs)` 闭包只含 `S_f`，两段互不可见、互不 conflict。① **`revertSegments` 过滤字段退场**：orchestrator 无段裁切逻辑（step-5 预检 / step-6 tx 内重检 / restore 三站点各自只见目标 checkpoint 闭包的单段 snapshot）；② **retract 无 `reverted_segments` 字段**：被撤 snapshot 的 subject_id 即段身份（`S_θ` vs `S_f`），forensic 无失真；③ **无「部分 revert 后必段过滤」文档规则**（该规则是轻量案共享快照的产物，双 sibling 下不存在——θ̂ 段撤了不碰 FSRS 段的 `S_f`，二者 append-only 独立墓碑）；④ 永不需要存量迁移（Lens A 拆分论点兑现）。 |
| **KC-merge 缝（Lens B F4，ACCEPT）** | snapshot 存作答当下 `kc_id`；YUK-543 merge 会 rename/freeze `mastery_state`（state.ts:194-228） | 显式声明 staleness 语义：**renamed**（loser 行搬进 winner，:212-219）→ 守卫查 loser 无行 → `current===undefined` → conflict refuse（安全 fail-closed）→ deferred marker **带 best-effort `merged_into` 上下文**（供第二实例定位「被推翻的错判已 baked 进 winner」——这正是残留可见性该覆盖的）；**frozen**（:221-227）→ 守卫可能对 inert 行通过 → restore 碰无 reader 的冻结行，无害，文档化；**cold-start DELETE × YUK-543 backfill 竞态** → 极端窗口，记录不改码。加一条 renamed 测试（§6.3）。YUK-544 sweep 是 propose-only 不写 mastery，无缝（Lens B UPHELD）。 |

**#9 借鉴四要素**（快照在持有层同原子 ✅ 已有 / 写前捕获完整 prev ✅ 本波补 / fail-closed 守卫 ✅ 补强 / runbook ✅ Q6）；代价结构差异照记（mem0 tombstone 免费，θ̂ 侧 retract+checkpoint 自建）。

### Q4 — 事件语义（decide-and-record + forensic 纪律）

| 项 | 决策 |
|---|---|
| record 臂 | ADR-0044 addendum（或新 ADR）：选 A / 退 (b)、checkpoint-chaining、首个 caller + 三门（原子/驱动+位翻转/refusal 分型）、段感知、残留可见性、append-only 边界、冲突守卫=LIFO 正确性载体的归因订正。Linear 挂 #10 单元 issue。 |
| revert 事件 | 复用 `correct(retract)`（actor_ref:'cascade_revert'，ingest_at:now，caused_by:e.eventId）不新建类型；payload += `reasonContext`（appeal_event_id + prior→new）拼进 reason_md。**O2 对齐**：**无 `reverted_segments` 字段**——被撤 snapshot 的 subject_id（`${E}:snapshot:theta` vs `:fsrs`）即段身份，双 sibling 拓扑自证。 |
| 新 experimental actions（Lens B F8，ACCEPT） | 本波新增 **2 个 action**（终裁裁剪：draft 的第 3 个 `cascade_revert_applied` 遥测 event **砍掉**——成功可观测性由 retract 行（`action='correct' AND actor_ref='cascade_revert'`）+ marker 查询覆盖，少一个登记面）：`experimental:grading_checkpoint`（**一个 action 承 θ̂/FSRS 两段**，payload `segment:'theta'\|'fsrs'` 判别——O2 双 sibling 用同 action 两实例，不新增第二个 checkpoint action）+ `experimental:reproject_deferred`。**两个都走 reserved + 专属 tiny schema**（`RESERVED_EXPERIMENTAL_ACTIONS`，experimental.ts:116）+ **`ingest_at:now`**。**红标 landmine（Lens A UPHELD-2）**：`grading_checkpoint` 的 schema/RESERVED 登记必须与 writer **同 PR/commit**（S2）——否则 parse barrier 对每次 attempt tx throw → 全线 attempt 崩。 |
| `reproject_deferred` payload | `{ appeal_event_id, answer_event_id, residual: 'reapply_correct_outcome' \| 'full_reprojection', reason: 'reverted' \| 'no_checkpoint' \| 'later_theta_movement', kc_conflict?, merged_into?, prior_outcome, new_outcome }` —— 第二实例重投影引擎的完整 worklist 行。 |
| 幂等 | checkpoint `${E}:checkpoint` + snapshot `${E}:snapshot` + writeEvent onConflictDoNothing ⇒ retried attempt tx 不双写。rejudge：Q2a 原子化后整个 overturn（judge+correction+revert+marker）一次 commit，caused_by 守卫（rejudge.ts:58-62）对真完成 run 语义恢复正确；双 revert 由冲突守卫兜（归因订正后）。 |
| append-only | 原 snapshot/attempt/judge 永不删；revert 只 state-table 还原 + 追加 retract。 |

### Q5 — 4 下游解锁顺序（不变，措辞对齐 reconcile）

| 下游 | 随本单元 or 独立 |
|---|---|
| cascade-revert-taxonomy（P2） | **随本波**（Q1 可达修复 = RESHAPE 核心；unarchive/extract/suppress fail-closed 残留文档化） |
| judge-spof（P2） | **半随本波**（revert-on-overturn 本波；完整 reprojection/re-apply = 独立 issue，worklist 由 `reproject_deferred` 全量喂） |
| elo-k-schedule（P2） | **工程半随本波**（Q3 count+precision restore 修复）；K-曲线独立（harness-gated），math shape KEEP |
| conjunctive-multi-kc-credit（P1 capture-gap） | **per-KC 随本波**（Q3 全列捕获关掉 per-KC gap）；θ_global bracket = A2-gated 独立 issue |

### Q6 — 可观测与 runbook（护栏两层）

| 层 | 内容 |
|---|---|
| 硬顶（已在，不改） | depth 64 + node cap 10k → `truncated`；冲突守卫 → `conflict`。 |
| warning 水位（补，零干预只告知） | 观测查询（不再新增遥测 event——Q4 裁剪）：revert 成功数 = `correct` × `actor_ref='cascade_revert'` 计数；conflict/defer 率 + 积压 = `reproject_deferred` 按 reason 分桶。积压量是第二实例引擎的输入。 |
| runbook | ① 手动 revert（**O2 双 sibling**）：θ̂ 段 = `revert(${attemptEventId}:checkpoint:theta)`，FSRS 段 = `revert(${attemptEventId}:checkpoint:fsrs)`——**段选择靠撤哪个 checkpoint，无 revertSegments 参数**；② forensic 溯源：retract 行（subject_id=`${E}:snapshot:theta`\|`:fsrs` 即段身份）+ reasonContext appeal 链；③ refusal 语义四态：`truncated`→人工、`conflict`→等第二实例（看 deferred 队列）、`no_checkpoint`→旧数据/无快照/该段未动的 attempt（正常，排队）、`legacy_snapshot`→pre-S1 bare-number 快照（正常，排队）、`irreversible`→传错 checkpoint 的 caller bug（fail-loud）；④ **预期管理（Q2e）**：多 KC 题 overturn 以 defer 为主。**双 sibling 无「段过滤」概念**——θ̂ 段撤了不碰 FSRS 段的 `S_f`，二者独立墓碑。 |

---

## 4. 机制设计（file:line 级，reconciled）

### 4.1 写侧：双 sibling checkpoint（Q1-a + O2 完整案对齐 2026-07-04）

**共享 helper**（`src/capabilities/practice/server/attempt-snapshot.ts` 新建，submit/paper 复用——避免双写点手抄漂移，Lens B F10 精神）：`writeSegmentBracket(tx, { attemptEventId, segment, sessionId, now, thetaSnapshots, fsrsSnapshots })` 按段写 **checkpoint + snapshot 一对**（同条件、同 tx、写序先 checkpoint 后 snapshot——好习惯非 FK 要求，schema.ts:814 caused_by 无 FK）：

```
// θ̂ 段（thetaSnapshots.length > 0 时）：
await writeEvent(tx, {
  id: `${E}:checkpoint:theta`,
  actor_kind: 'system', actor_ref: 'attempt_snapshot',
  action: 'experimental:grading_checkpoint',
  subject_kind: 'event', subject_id: E, outcome: 'success',
  payload: { attempt_event_id: E, segment: 'theta' },
  caused_by_event_id: E, ingest_at: now, created_at: now,
});
await writeEvent(tx, {
  id: `${E}:snapshot:theta`,
  actor_kind: 'system', actor_ref: 'attempt_snapshot',
  action: 'experimental:state_snapshot',
  subject_kind: 'event', subject_id: E, outcome: 'success',
  payload: { attempt_event_id: E, theta_snapshots: [...rich...], fsrs_snapshots: [] },
  caused_by_event_id: `${E}:checkpoint:theta`,   // 挂 θ̂ checkpoint，非 attempt
  ingest_at: now, created_at: now,
});
// FSRS 段（fsrsSnapshots.length > 0 时）：同构，id 后缀 :fsrs，
//   checkpoint payload.segment='fsrs'，snapshot payload theta_snapshots:[] + fsrs_snapshots:[...]。
```

**同条件写不变量（per segment，Lens A F6 订正后的真不变量）**：
- θ̂ 段：`C_θ` ↔ `S_θ` 两者恒同条件写（gate = `thetaSnapshots.length > 0`）——写了 `S_θ` 必写 `C_θ`，反之亦然，否则 dangling caused_by 的 snapshot 永不可 revert 且无 DB 层兜底（无 FK）。
- FSRS 段：`C_f` ↔ `S_f` 同理（gate = `fsrsSnapshots.length > 0`；solo 恒 ≥1 FSRS subject → FSRS 段恒写；paper photo-only 两段皆无）。

`submit.ts`（原 snapshot 块 :689-714）：替换为两次 `writeSegmentBracket` 调用（θ̂ 段 gate `thetaResult.theta_snapshots.length>0`；FSRS 段 gate `fsrs_snapshots.length>0`，solo 恒真）。
`paper-submit.ts`（原 (e) 块 :778-810）：同构——θ̂ 段 gate `thetaSnapshots.length>0`，FSRS 段 gate `fsrsWrote`。photo-only unsupported 两段皆 skip（既有行为不变）。

### 4.2 分类 + 新 action 登记

- `cascade-revert.ts:111` `EVENT_LAYER_ACTIONS` += `'experimental:grading_checkpoint'`。
- `experimental.ts:116` `RESERVED_EXPERIMENTAL_ACTIONS` += `grading_checkpoint` / `reproject_deferred`，各配 tiny schema（与 state-snapshot.ts:67-83 的 parity 形态一致）。**与 writer 同 PR**。

### 4.3 snapshot payload 无损化（Q3）

`src/core/schema/event/state-snapshot.ts`：

```
const ThetaRowSnapshot = z.object({
  theta_hat: z.number(),
  evidence_count: z.number().int(),
  success_count: z.number().int(),
  fail_count: z.number().int(),
  theta_precision: z.number(),
  last_theta_delta: z.number().nullable(),
  last_outcome_at: z.coerce.date().nullable(),
  rt_correct_ms: RtCorrectBufferSchema.nullable(),   // SRT_ENABLED=true，LIVE 列（theta.ts:259）
  theta_grid_json: ThetaGridPosteriorSchema.nullable(), // A4 dark（theta-grid.ts:54）；捕获保 flag 翻转后 verbatim 不静默失真
});
const ThetaSnapshot = z.object({
  kc_id: z.string().min(1),
  before: z.union([z.number(), ThetaRowSnapshot]).nullable(), // union：legacy bare number 兼容（parse 过、restore 拒）
  after: z.object({ theta_hat: z.number() }).or(z.number()),  // 守卫只需 theta_hat；旧形状兼容
});
```

`src/server/mastery/state.ts`：`ThetaSnapshotEntry`（:887-891）扩 rich；push（:1151）从 `states[i]` 填全 before（:987-1012 已含全列；`last_outcome_at` 从 row 取，trivial）。:881-885 A2 注释保留（global 仍 defer），counts 部分删除。

`src/server/revert/restore-snapshot.ts:59-87`：

- `before` 为 rich 对象 → verbatim 全行 `upsertMasteryState`（显式传 `theta_precision`/`last_theta_delta`/`rt_correct_ms`/`theta_grid_json`/counts/`last_outcome_at`）。
- `before === null` → DELETE（不变）。
- `before` 为 legacy bare number → **返回 typed refusal `legacy_snapshot`**（经 orchestrator 透出；绝不 lossy restore）。
- :113-114「orchestrator wave passes …」等前向 promise 注释更新。

### 4.4 orchestrator：tx-aware + no_checkpoint + legacy_snapshot（Q2a/Q2c；O2 段裁切退场）

`src/server/revert/cascade-revert.ts`：

- 签名 `db: DbLike`（`Db | Tx`）支持 caller tx（step-6 用 `db.transaction` —— caller 传 Tx 时 drizzle 转 SAVEPOINT 嵌套，独立调用时是真 tx，行为不变）。step-1..5 预检在 caller 传入的 db/tx 上跑（无 mutation）。
- refusal union 增 `'no_checkpoint'`（rootRow null，原 :262-270 返 `irreversible` 处改）+ `'legacy_snapshot'`（restore 段检出 bare-number `before` 透出）。`irreversible` 语义收窄为「闭包含真 learner fact / 无 clean inverse 形状」（真 caller bug）。
- `OrchestrateCascadeRevertOptions` += `reasonContext?: { appeal_event_id?: string; note?: string }`。**O2 完整案对齐 2026-07-04：无 `revertSegments` option、无段裁切逻辑**——段隔离由拓扑（caller 撤 `${E}:checkpoint:theta` vs `:fsrs`，闭包各自只含单段 snapshot）达成，orchestrator 一视同仁 collect→classify→conflict-check→restore 目标 checkpoint 的闭包。
- **原子化 refusal 回传（Q2a）**：step-6 `db.transaction` 内，conflict 重检 throw `CascadeRevertConflictError` / restore 检出 legacy throw `CascadeRevertLegacyError`；orchestrator 在 `db.transaction(...)` 外层 try/catch 捕这两类 → SAVEPOINT/tx 回滚 → **以 typed refusal 返回值形态回到 caller**（caller 在同一外层 tx 里写 marker 再整体 commit）。其它 throw（missing edge 等）继续 fail-loud 冒泡。
- restore 原语返回 `{ ok:true } | { ok:false; refusal:'legacy_snapshot'; ... }`——遇 bare-number `before` **扫描先行、零 mutation** 后返回 refusal（绝不 lossy restore，Lens A F5）。
- retract 补偿 payload += reasonContext 拼入 reason_md（原 :387）。**无 `reverted_segments`**（O2：段身份由 subject_id 自证）。
- 原 :371-376 tombstone 注释归因订正（防双 revert 的是**冲突守卫**=LIFO 正确性载体，非 tombstone；Lens A F4）。

### 4.5 live caller：rejudge overturn（Q2，原子 + 三门）

`src/capabilities/practice/jobs/rejudge.ts` overturn 分支重构（伪码）：

```
// 触发门（Q2b）：判决驱动 + 位翻转
const judgeDriven = answerEvent.action === 'attempt'
  || (answerEvent.action === 'review' && answerPayload.judge?.auto_rated === true);
const bitFlip = bitOf(priorOutcome) !== bitOf(newOutcome); // bit = coarse ∈ {correct,partial} ? 1 : 0
const shouldRevertTheta = judgeDriven && bitFlip;

await db.transaction(async (tx) => {                    // Q2a：同生共死
  const newJudgeId = await writeEvent(tx, { ...新 judge... });
  await writeEvent(tx, { ...correction(supersede)... });
  if (!shouldRevertTheta) return;                        // 无 θ̂ 残留：不 revert 不 marker（O3 owner 拍零 marker）
  // O2 完整案对齐：撤 θ̂ 段 = 撤 θ̂ checkpoint（无 revertSegments option）。
  const revert = await orchestrateCascadeRevert(tx, `${answerEvent.id}:checkpoint:theta`, {
    reasonContext: { appeal_event_id: appeal.id, note: `${priorOutcome}→${newOutcome}` },
  });
  // 四态分派（Q2c/Q2d），marker 全部同 tx：
  if (revert.ok) await writeMarker(tx, { residual: 'reapply_correct_outcome', reason: 'reverted' });
  else if (revert.refusal === 'no_checkpoint' || revert.refusal === 'legacy_snapshot')
    await writeMarker(tx, { residual: 'full_reprojection', reason: 'no_checkpoint' });
  else if (revert.refusal === 'conflict')
    await writeMarker(tx, { residual: 'full_reprojection', reason: 'later_theta_movement',
                            kc_conflict: revert.conflictRef, merged_into: await resolveMergedInto(tx, revert.conflictRef) });
  else await writeErrorMarker(tx, revert);               // truncated/irreversible：fail-loud
});
```

- marker = `experimental:reproject_deferred`（`caused_by: appeal.id`——与幂等守卫同键族，`ingest_at:now`）。θ̂ 段为空/prior unsupported（无 `${E}:checkpoint:theta` 写入）→ orchestrator 天然返 `no_checkpoint`（rootRow null）→ 同款 full_reprojection marker，orchestrator no_checkpoint 分支 tx 前返回、**零 retract 空转**。
- `resolveMergedInto`：best-effort 查 KC merge 链（YUK-543），失败留空——只是给第二实例的定位提示。
- rejudge.ts:13-15 注释更新（θ̂ 段已接 live；FSRS 仍用户确认）；submit/paper-submit/restore-snapshot 的「later wave」注释同步清理。

---

## 5. 实施切片（PR 粒度 + pre-flight）

> 单波多 PR，`Refs YUK-XX` 串，末 PR 才 `Closes`。每 PR pre-flight = 全量 `pnpm typecheck`（所有 edit + biome --write 之后）+ `pnpm lint` + 受影响 targeted 测试。

- **PR-1 / S1（schema union + rich 捕获 + verbatim restore，Q3）**：state-snapshot.ts θ̂ `before` union schema（rich `ThetaRowSnapshot` \| legacy bare number）+ state.ts rich push（从原始 pre-attempt row 取 last_theta_delta/last_outcome_at 全列）+ restore-snapshot.ts verbatim（含 rt/grid 列，返回 typed 结果）+ `legacy_snapshot` typed refusal + upsertMasteryState `last_outcome_at` 放宽 `Date|null`（verbatim 需还原 null）+ **列漂移守卫测试**（§6.4）。无新表；write path 走 upsert single-writer。中间态 inert（无 live caller）。
- **PR-2 / S2（写侧双 sibling checkpoint，Q1-a + O2）**：`experimental:grading_checkpoint`（一个 action 承两段，`segment` 判别）**reserved+schema+union 与 writer 同 commit（红标）** + `EVENT_LAYER_ACTIONS` += 它 + 共享 `writeSegmentBracket` helper + submit/paper-submit 各两段双写点 + **per-segment C↔snapshot 同条件写不变量测试**。中间态 inert。
- **PR-3 / S3（orchestrator 重构，Q2a/Q2c；O2 段裁切退场）**：`db: DbLike` tx-aware（step-6 SAVEPOINT 嵌套，conflict/legacy throw → 外层 catch → typed refusal 返回值）+ `no_checkpoint`/`legacy_snapshot` refusal + reasonContext（**无 revertSegments、无段裁切**）+ **共享 topology builder**（§6.5）+ revert-twice→conflict 回归测试 + no_checkpoint 测试 + fake topology 测试重写为真 writer 双 sibling 形态 + tombstone 注释订正。中间态 inert。
- **PR-4 / S4（live caller，Q2）**：rejudge overturn 原子 tx 重构（newJudge+correction+revert+marker 同 `db.transaction`）+ 双门（judgeDriven && bitFlip）+ `experimental:reproject_deferred`（reserved+schema+union）四态分派 + 撤 `${E}:checkpoint:theta` + KC-merge renamed 测试 + 双门各象限测试 + 原子性测试 + 注释残留清理 + 砍 `cascade_revert_applied` 遥测（本就未建）。依赖 S1/S2/S3。**接上 live caller 后 revert 才活**。
- **PR-5（record + runbook，Q4/Q6）**：ADR addendum + runbook doc（观测查询、refusal 四态、多 KC defer 预期）+ Linear #10 issue + doc 同步。
- **末 PR gate**：typecheck + lint + audit:schema/partition/profile/draft-status + `pnpm test`（DB 分区）+ `pnpm build`。

部署安全（Lens B UPHELD）：PR-1/2 中间态因无 live caller 而 inert；PR-1∥PR-2 可并行 worktree，PR-3 依赖 1/2，PR-4 依赖 3。

---

## 6. 测试与 gate

### 6.1 round-trip oracle（核心，逐列但排除声明列）

1. 冷启 KC → 真 attempt → 断言 `C_θ`+`S_θ` 都写、θ̂ before=null → `revert(${E}:checkpoint:theta)` → **mastery_state 行被 DELETE**。
2. warm 变体：预置 `S_before`（非零 θ̂/counts/precision/delta/**rt buffer**）→ attempt → `revert(${E}:checkpoint:theta)` → **`mastery_state == S_before` 逐列**（含 rt_correct_ms；theta_grid_json 在 flag OFF 下恒 null 也纳入断言）。
3. PFA 不污染 oracle：revert 后 `getMasteryProjection(kc)` 的 p(L) == attempt 前。

### 6.2 topology 可达性 + 防线归因回归（O2 双 sibling 对齐）

- 真 writer 链 attempt→`C_θ`→`S_θ`，`revert(${E}:checkpoint:theta)` 成功（A-class 可达）；FSRS 段 `C_f`/`S_f` 不受影响（未撤）。
- revert attempt `E` 本身 → 仍 `irreversible`（真事实不可撤）。
- **`revert(${E}:checkpoint:theta)` 两次 → 第二次必返 `conflict`**（防线=冲突守卫的显式回归，Lens A F4）。
- **per-segment C↔snapshot 同条件写不变量**：solo/paper 各一条（θ̂ 段 `C_θ`↔`S_θ`、FSRS 段 `C_f`↔`S_f` 各自 both-or-neither；paper 的 photo-only 路径四者皆无）。
- 不存在的 checkpoint（如旧 attempt 无 `${E}:checkpoint:theta`）→ `no_checkpoint`（非 irreversible）。
- **段正交**：`revert(${E}:checkpoint:theta)` 只动 θ̂ 段、`S_f`/material_fsrs_state 不动；反之亦然。
- 删除/重写旧 fake topology 测试（snapshot 挂 copilot_user_ask 的合成形状 → 真 writer 双 sibling 形态）。

### 6.3 live caller

- paper overturn（wrong→correct）→ θ̂ 段 revert（撤 `${E}:checkpoint:theta`）+ FSRS 段（`S_f`/material_fsrs_state）不动 + retract subject_id=`${E}:snapshot:theta`（段身份自证，无 `reverted_segments`）+ reasonContext appeal 溯源 + **成功路径也写 reproject_deferred（residual=reapply）**。
- solo `auto_rate=false` overturn → **不 revert**（θ̂ 非判决驱动）。
- **partial→correct overturn → 不 revert**（位未翻转，合法信号不删）。
- overturn 后同 KC 有后续 attempt → conflict → deferred marker（reason=later_theta_movement），θ̂ 不被 clobber。
- 旧 attempt（无 checkpoint）overturn → deferred marker（reason=no_checkpoint），无 error 洪水。
- **原子性**：revert 段注入瞬时失败 → 整个 overturn 回滚 → 重试完整重放（newJudge 不残留、守卫不锁死）。
- KC-merge renamed 后 overturn → conflict → deferred（带 merged_into），无死 KC 复活。
- 幂等：同 appeal 重跑 → 守卫 skip，不双撤。

### 6.4 列漂移守卫（Lens B F5b）

断言「一次 attempt 对 mastery_state 的写列集合 ⊆ ThetaRowSnapshot 捕获列集合」——未来 state.ts 加新列时该测试红，强制同步扩 snapshot（防 verbatim 静默失真复发）。

### 6.5 测试构造（Lens B F10）

共享 **topology builder**（复用 §4.1 的 `writeSegmentBracket` helper 产 per-segment checkpoint+snapshot 形状——builder 即 writer，天然同形）+ **一条 golden 集成测试**对真 submit 产出校验双 sibling 形状（`${E}:checkpoint:theta`/`:fsrs` + `${E}:snapshot:theta`/`:fsrs` 各就位、caused_by 链正确、payload 段隔离）== 生产形状；其余 revert 单测复用 builder。

### 6.6 legacy fail-closed

喂 bare-number before 的旧 payload → parse 过（union）→ restore 拒（`legacy_snapshot`），不 lossy。

---

## 7. 开放问题（owner 级；方向已拍，参数/顺序级确认窗）

- **O1（低，默认已选）**：`grading_checkpoint`/`reproject_deferred` 都走 reserved + tiny schema（parse-barrier 一致）。默认落地，owner 嫌重可对 `reproject_deferred` 降为 loose generic（`grading_checkpoint` 不可降——load-bearing 路由锚）。
- **O2（已拍——owner 2026-07-04 选完整案）**：段感知形态 = **拆 θ̂ / FSRS 两个 sibling checkpoint 事件**（推翻轻量单快照+段过滤）。段独立 collect/guard/tombstone 正交、**永不需要存量迁移**；代价（事件登记面—— grading_checkpoint 一个 action 两实例、每 attempt 双段双写、双事件原子性由同 tx + 同条件写不变量守）owner 接受。`after` 仍只留 `{theta_hat}`（守卫只需它；双 sibling 段独立，不受 after 保守案影响）。**本稿 M5/Q3/§4/§5/§6 已全部对齐此形态**。
- **O3（参数级）**：不满足触发门的 overturn（手评 solo / 位未翻转）当前**不写任何 marker**（无 θ̂ 残留）——owner 若要全量 overturn 审计流水，可加 informational marker（非 deferred 队列）。
- **O4（顺序级）**：PR-1∥PR-2 并行 or 串行，及 PR-4 是否与 PR-3 合并落（原子重构与 caller 强耦合，合并可少一轮 review 但 diff 更大）。
- **O5（记录，非阻断）**：A2 ship 时必须扩 `ThetaSnapshot` 到 ability_global 层（state.ts:881-885 + 本 doc §2 OUT 已双记）；FSRS 段接线时走 `revert(${E}:checkpoint:fsrs)`（**O2 双 sibling**：`C_f`/`S_f` 本波已写 inert，接线只需给 caller 加一条撤 FSRS checkpoint 的路径，无 schema/writer 改动）。

---

## 附 A：红线逐条对表

- **n=1 不拟合 item 参数**：捕获/还原的是学习者自身 θ̂/counts/precision/rt-buffer（自状态充分统计），非跨考生 item 拟合。
- **fold-owned 表不 raw UPDATE**：restore 走 `upsertMasteryState`/`upsertFsrsState` single-writer；DELETE 是冷启 INSERT 的逆、同 tx。
- **forensic/experimental ingest_at:now**：checkpoint / snapshot / retract / reproject_deferred 全 `ingest_at:now`（本波无遥测 event——已裁剪）。
- **数据门只 gate 翻转不 gate build**：机制全建 + caller 穿 live；A2/FSRS 只 defer flag 半边不 defer build；grid/rt 列现在就捕获（flag 翻转日 verbatim 自动成立，不留「等数据」死循环）。
- **护栏两层**：硬顶（depth/cap/守卫）已在；warning 水位=观测查询，只告知不阻断。
- **无死 fallback**：refusal 四态+legacy 全显式处置；happy-path 残留也可见（marker）；不满足门=显式决策非静默漏。
- **新常量标注**：本波无新数值常量（checkpoint id 是派生串）；若 O2 完整案或未来 re-apply 引入阈值，标「未经数据校准的保守初值」。

---

## 附 B：Attack Ledger（逐条裁决）

| # | Finding | 裁决 | 处置 |
|---|---|---|---|
| A-F1 | rejudge 幂等守卫在 revert 前短路，部分失败→retry→skip→θ̂ 自愈永久跳过且报成功 | **ACCEPT（MAJOR，= B-F1）** | Q2a：同 tx 原子（选 (a)）；orchestrator tx-aware+SAVEPOINT；备选 (b) 记录不采 |
| A-F2 | θ̂-only 部分 revert 永久毒化共享快照，FSRS-revert 未来结构性不可达 | **PARTIAL** | 「结构性不可能」过强——`revert(C,['fsrs'])` 段过滤守卫即可达（draft §4.4 已含段过滤）。存活半：retract 须段感知 + forensic reason 不失真 + 文档化「部分 revert 后必段过滤」；拆双 event 记 O2 完整案（Q3b）。**O2 对齐（2026-07-04 终裁，消歧）**：段选择 = 撤哪个 checkpoint（`${E}:checkpoint:theta` vs `:fsrs`）；**无 `revertSegments`、无 orchestrator 段裁切、无「部分 revert 后必段过滤」文档规则**——三者皆已被 O2 双 sibling 拓扑取代（θ̂ 段撤了不碰 `S_f`，二者独立墓碑；见 §3/§4.4/Q6）。本 disposition 中「`revert(C,['fsrs'])` 段过滤」为轻量案措辞，仅存证裁决轨迹，非现行实现。 |
| A-F3 | 残留只在 conflict 可见，happy-path revert-only 的「正确证据未计入」残留对第二实例不可见 | **ACCEPT（MAJOR）** | Q2d：成功路径也写 `reproject_deferred`（residual=reapply），worklist 完整 |
| A-F4 | revert-of-revert 防线归因错（tombstone vs 冲突守卫）| **ACCEPT** | §1.2 订正 + 注释/ADR 归因 + revert-twice 回归测试；守卫=LIFO 正确性载体点明 |
| A-F5 | legacy「typed refusal」与 parseSnapshotPayload 实际 throw 不符 | **ACCEPT** | Q3 union schema + restore 层 `legacy_snapshot` typed refusal；缓解事实（no_checkpoint 先挡）照记 |
| A-F6 | 「FK 保证写序」假前提；真不变量=C↔snapshot 同条件写 | **ACCEPT** | schema.ts:814 无 FK 确认；措辞删除 + 不变量 + 测试（§6.2） |
| A-F7 | 多 KC conflict 命中率高，self-heal 效力 oversold | **ACCEPT** | Q2e + runbook 诚实标注 |
| A-UPHELD 1-7 | 拓扑/分类/零成本捕获/count-bug/原子性/切片/#9 对照 | 采納 | UPHELD-2 的「schema 与 writer 同 PR」landmine 红标进 Q4/PR-2；UPHELD-7 的守卫强度 framing 进 Q3/ADR |
| B-F1 | = A-F1（非原子 + 守卫锁死） | **ACCEPT（MAJOR）** | 同上 Q2a；orchestrator 签名重构计价进 PR-3 |
| B-F2 | auto_rate=false 的 solo θ̂ 非判决驱动，overturn 撤它是污染 | **ACCEPT（MAJOR）** | Q2b 门 1（judgeDriven）；**终裁补强**：+门 2 位翻转（partial→correct 不撤合法信号——两 lens 均未点到） |
| B-F3 | checkpoint-not-found 落 irreversible→error 洪水，与散文自相矛盾 | **ACCEPT（MAJOR）** | Q2c：`no_checkpoint` refusal 子类 + 四态分派表 |
| B-F4 | YUK-543 KC-merge 缝全程缺席（renamed 把错判 baked 进 winner） | **ACCEPT** | Q3 表末行：staleness 语义声明 + renamed 测试 + marker 带 merged_into；frozen/竞态文档化 |
| B-F5 | 「verbatim」漏 rt_correct_ms/theta_grid_json 影子列 | **ACCEPT（终裁加重）** | `SRT_ENABLED=true`（theta.ts:259）→ rt 列**今天就 live**，非 flag-coupled。选 (a) 全列捕获（非 draft 的 (b) 排除案）+ 列漂移守卫测试（§6.4） |
| B-F6 | 段过滤须覆盖三站点（step-5/step-6/restore），draft 只点两个 | **ACCEPT** | 入口一次性裁 payload，三站点自然收敛（§4.4）。**O2 对齐（2026-07-04 终裁，消歧）**：双 sibling 下**根本无「段过滤」概念**——每 checkpoint 闭包只含单段 snapshot（`revert(${E}:checkpoint:theta)` 闭包只 `S_θ`），三站点各自只见目标段，orchestrator 一视同仁 collect→classify→conflict-check→restore，无段裁切逻辑（见 §3/§4.4/Q6）。「入口裁 payload」为轻量案措辞，仅存证裁决轨迹，非现行实现。 |
| B-F7 | Q1-a 写放大 ROI 递延（sibling 全 deferred/非 event 写） | **ACCEPT（记录）** | Q1 诚实标注；owner 决策不推翻；Q1-b 留回退姿态 |
| B-F8 | 新 action 登记面只走完 1/3 | **ACCEPT（+终裁裁剪）** | 砍 `cascade_revert_applied` 遥测 event（观测由既有行覆盖）→ 剩 2 个 action 全 reserved+schema+ingest_at:now（Q4） |
| B-F9 | schema 硬替换破坏 rollback 兼容 | **ACCEPT** | union（rich \| legacy bare），吸收 legacy 分支（Q3） |
| B-F10 | 真 submit 驱动测试构造成本陡升 | **ACCEPT** | 共享 topology builder + 1 条 golden 集成校验（§6.5） |
| B-UPHELD 全部 | 不可达证明/闭包数学/读侧安全/count-bug/all-or-nothing/event_layer 语义/无 FK/audit 面/ingest_at/single-writer/YUK-544 无缝 | 采納 | 融入 §1/§3 |
| 终裁自增 1 | 位翻转门（partial↔correct 不撤） | — | Q2b 门 2 + §6.3 测试 |
| 终裁自增 2 | 砍遥测 event 缩登记面 | — | Q4/Q6 |
| 终裁自增 3 | θ̂ 段为空 snapshot 的 caller 预检直落 marker（不空转 retract） | — | §4.5 |

---

## 附录 — Owner 决策实录(2026-07-04,AskUserQuestion)

方向与参数四项处置:

1. **方向(决策一页纸)**:owner 拍 **A 修可达+接线**(推翻材料推荐的 B append-only)——θ̂/FSRS 不应是全系统唯一残留的结构性单向写面,#9 记忆层可逆先例同向。
2. **O2 快照段感知形态**:owner 拍**完整案——θ̂/FSRS 双 sibling checkpoint 事件**(推翻本稿默认的轻量单快照+段过滤)。段撤销天然正交、永不需要存量迁移;代价(事件登记面 ×2、每 attempt 双写、双事件原子性耦合守卫)接受。**实施注意**:本稿 M5/Q3 机制节按轻量案写成,executor 须在 PR-1/PR-2 实施前把机制细节对齐双 sibling 形态(捕获列分配:θ̂ 段=theta_hat/rt/grid 列,FSRS 段=FSRS 状态列;双事件同 tx 原子写+同条件写不变量覆盖两者)。
3. **O3 不满足双触发门的 overturn**:owner 拍**零 marker**(无 θ̂ 残留则无可审计之物,overturn 本身在 rejudge 事件链可查,不叠床架屋)。
4. **O1/O4 按 spec 默认自决**:reproject_deferred 同走 reserved+schema(与 grading_checkpoint 同纪律);PR-4 与 PR-3 分开落(原子重构与 caller 强耦合但边界清晰)。

Linear:YUK-561(parent YUK-538)。

---

## 附录 — 独立 review 环裁决（2026-07-04）

终稿落地后跑了一轮独立对抗 review 环（Opus 终裁，逐簇独立验证到 node_modules 源码级）。裁决落地为 **FIX-1..5**（P0 correctness + review-limb/grid/atomicity 测试 + 嵌套形状锁）与 **SPEC-1/SPEC-2**（本 doc 内部张力订正）。以下为**不进本波修复**的裁决留档；DEFER 项另开 Linear follow-up。

### 已落地（本波）
- **FIX-1（P0 correctness，rejudge.ts）**：双触发门漏「θ̂-skipped prior」——`outcomeBit('unsupported')=outcomeBit('incorrect')=0` → 误判「位未翻」→ 漏写 `unsupported→incorrect` 的 residual marker（§Q2b(3)）。改为 `judgeDriven && (thetaSkippedPrior || 位翻转)`；skipped prior 经 revert 路径 → `no_checkpoint` → `full_reprojection` marker。非回归：`partial→correct` 仍不 revert，`unsupported→correct/partial` 不变（只改经 skipped 分句）。
- **FIX-2/3/4（测试）**：judgeDriven review-true 支路（auto_rated=true）可红；restore-snapshot test 14 补 `theta_grid_json` 非-null verbatim round-trip（闭合唯一从未非-null round-trip 的列）；cascade-revert 补 in-tx re-check→catch→typed refusal→外层 tx 存活→marker commits（双 sibling 同-KC 快照确定性构造，无 mock）。
- **FIX-5（加固，state-snapshot.ts）**：编译期类型相等锁——`z.infer<RtCorrectBufferSnapshot>` ≙ `RtCorrectBuffer`、`z.infer<ThetaGridPosteriorSnapshot>` ≙ `ThetaGridPosterior`；源接口未来加字段则 typecheck 红，而非 restore 时静默丢字段。
- **SPEC-1/SPEC-2**：§Q2b(2/3) 化解 FIX-1 暴露的内部张力（位翻转 no-marker 只裁真 θ̂-moving prior；skipped prior 欠 marker，residual=full_reprojection/no_checkpoint 与 Q2c 表对齐）；附 B Attack Ledger A-F2/B-F6 加 O2-reconciliation 注（段选择=撤哪个 checkpoint，无 revertSegments/段裁切/段过滤规则，已被双 sibling 取代）。

### DEFER（独立 follow-up，不塞进 revert 波）
- **DEFER-1（C3）**：并发双投递（同 appeal 两 worker 并跑）→ 各撤各的 θ̂ → spurious `later_theta_movement` marker。修需 advisory-lock 或 appeal 结论键 unique-index，超本修复轮。当前 `caused_by` 幂等守卫（rejudge.ts:58-62）挡串行重跑、不挡真并发。
- **DEFER-2（C8）**：memory-brief 被内部 ledger 行污染——checkpoint/snapshot/retract/`reproject_deferred` 虽 `ingest_at:now` opt-out outbox，但 memory-brief 的 S2 聚合面另有读路径把内部行放大（1→4-6）。跨子系统修（须把 outbox 的 `ingest_at IS NULL` gate 镜像到 brief ingest 面），不塞进本波。
- **DEFER-3（C10）**：overturn tx 内 4 INSERT / N+1 SELECT（marker/retract/merge-lookup）批量化。n=1 可忽略，纯性能，defer。

### REFUTE（独立验证后判无需修，留档防重提）
- **C2（correctness）**：savepoint `ROLLBACK TO` 保外层 tx 存活——drizzle 嵌套 tx 转 SAVEPOINT，in-tx conflict/legacy throw 只回滚 savepoint，外层 tx 继续（FIX-4 实测坐实）。
- **C7**：`double precision`（f8）theta_hat + jsonb grid/rt round-trip 精确——postgres-js binary64 经 TEXT 无损往返（FIX-3 verbatim 断言坐实）。
- **C5**：legacy bare-number `before` → 生产侧 `no_checkpoint` 先挡（legacy snapshot 无 checkpoint），restore 层 `legacy_snapshot` typed refusal 是 defence-in-depth——spec §4.3/§6.6 明文，非漏。
- **C6**：missing checkpoint = `no_checkpoint`（honest-defer）而非 `irreversible`——Q2c ratified；`irreversible`/`truncated` 对 C_θ 闭包（只有 reversible snapshot）结构性不可能，发生即拓扑损坏 bug → fail-loud，绝不静默 commit。
- **C4c**：allowlist（union `ThetaRowSnapshot | number`）双向失效是固有代价——FIX-3 全行 round-trip（含 grid）兜底，legacy 分支 typed refusal 不 lossy。
