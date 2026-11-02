# Wave 1 Lane W-B — RatingAdvisor cause wiring fix

> Lane plan written on fresh main (`c320446`) inside worktree
> `worktrees/w-b-rating-advisor-cause`. Driver = original Wave 1 post-ship
> follow-up prompt. Source audit = `docs/audit/2026-05-27-wave1-postship-drift.md`
> §W-05.

**Lane**: W-B
**Branch**: `lane/w-b-rating-advisor-cause`
**Linear**: TBD (created at start of impl, recorded below)

---

## §1 Goal

修复 W-05 silent regression：YUK-98 ship 的 RatingAdvisor `causeLean()`
在生产路径死代码 —— advice route + submit route 都没把 cause SoT 传给
`judgeResultToRatingAdvice()`，所以 partial credit 永远走默认 again/hard，
carelessness → 'good' / conceptual_error → 'again' lean 从未生效。

## §2 Scope（只 W-05）

### In scope
1. `app/api/review/advice/route.ts` — 在 invoker 之后查最新 active failure
   attempt 的 effective cause category，传给 advisor
2. `app/api/review/submit/route.ts` — 同上；移除 L241-242 "callers SHOULD
   thread …" 失效注释，替换为实装说明
3. Integration test 覆盖 advice / submit 在 `partial + carelessness` /
   `partial + conceptual_error` 场景下 advisor rating 正确

### Out of scope
- 不动 `src/server/review/rating-advisor.ts` 内部逻辑（pure fn 已正确）
- 不动 UI（`src/ui/review/RatingAdvisor.tsx` 不需改）
- 不动 driver doc T-RA（W-02 P3 不在本 lane）
- 不动 `src/server/memory/*` / `src/server/events/*` / `.env.example` / README（W-A scope）

## §3 关键决策

### §3.1 cause SoT 读法

`effectiveCauseCategoryForFailureAttempt(failure: FailureAttempt)` 入参是
**FailureAttempt**（基于 attempt event id 的投影）。Review submit/advice 当前
只持有 `question_id`，没有 attempt_event_id。

**选择**：在 advice / submit route 内，`createDefaultJudgeInvoker()` 跑完后，
用 `getFailureAttempts(db, { questionIds: [questionId], limit: 1 })` 取该
question 的**最新 active failure attempt**（如有），调用
`effectiveCauseCategoryForFailureAttempt(failure)` 得到 cause category 传给
advisor。

**Rationale**：
- 这是 review session 上下文 —— 用户正在 review 同一个 question 的旧 mistake。
  最新 active failure attempt 携带的 user_cause / agent judge cause 就是该
  question 当前的 cause SoT（CC-1 invariant：active user_cause > latest active
  agent judge；helper 内部已实装这个 precedence）。
- helper 是纯函数（不读 DB），DB 读发生在 `getFailureAttempts`，与 CC-1
  single-owner invariant 一致 —— 我们没有再次分类 cause，只是读 SoT 投影。

### §3.2 advice route：首次 attempt / 无 failure 历史的边界

advice route 是 **preview**（不写 event）。两种 fallback：

1. **该 question 从未 fail 过** → `getFailureAttempts` 返回 `[]` →
   causeCategory = `null` → advisor 走默认 partial credit bucket（合法）
2. **该 question 失败过但当前 attempt 还没 cause** → 历史 failure 的 cause
   仍然 inform advisor（这是合理的：用户对该 question 的认知模式延续）

`causeCategory = null` 是合法 fallback —— advisor `causeLean()` 已 `if (!causeCategory) return 0` 处理。

### §3.3 submit route：transaction 边界

submit route 已有 transaction 串行 FSRS 写。`getFailureAttempts` 是 read-only
DB query。决策：

- **在 transaction 外读 cause**（与 judge invocation 同处），传 cause 进
  transaction。
- **理由**：
  - cause 读不需要 FSRS-level 串行（advisory 是 informational，不影响调度）
  - 在 transaction 外读避免增加 lock 持有时间
  - 与现有 judge invocation 路径（也是 transaction 外读 / 推论 / 然后写）一致

### §3.4 submit route 当前 attempt 的 user_cause 包含吗？

注意：submit route 是 **review** action 不是 **attempt** action。它是用户
re-review 一道既有 mistake，不是首次 attempt。所以"当前 attempt 的 user_cause"
不适用 —— review 不写 user_cause（route 头注释明确：「this route never writes
`experimental:user_cause`」）。我们读的是该 question 之前 attempt 的 cause
SoT。无 race，无需 transaction 内读。

## §4 实施步骤

1. **创建 Linear issue**（Yukoval Studios team，drift label）
2. **TDD red**：写 integration test —— advice/submit 在 partial+careless 场景
   下应返回 advisor rating='good'，partial+concept 应返回 'again'。当前实装
   会 fail（causeLean 死代码）
3. **改 advice route**：query failure attempt + 调 cause helper + 传 ctx
4. **改 submit route**：同上 + 更新过时注释 L241-242
5. **TDD green**：跑测试通过
6. **跑全 gate**：typecheck / lint / 3 audit / test / build
7. **Commit**（含 `Closes YUK-NN` + co-author trailer）

## §5 Acceptance

- [ ] Integration test 覆盖 advice + submit 在 partial+careless / partial+concept 两种 cause 下的 advisor rating
- [ ] advice/submit route 都调用 cause SoT helper 并传 `{ causeCategory }`
- [ ] submit route L241-242 注释更新为反映已实装
- [ ] 全部 6 个 pre-PR gate 命令绿
- [ ] Commit message ends with `Closes YUK-NN`
