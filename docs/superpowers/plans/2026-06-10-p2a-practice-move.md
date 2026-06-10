# P2a：practice 包等价平移 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `src/capabilities/practice/` 包成形：src/server/review/ 全部 14 模块 + src/server/orchestrator/{review,solve}.ts 等价迁入，练习 API 壳化，测试随迁改名分区，全部 import 站点切换。**零行为变化**。

**Architecture:** P2 spec = `docs/superpowers/specs/2026-06-10-p2-practice-journey-spec.md` §2.5/§3-P2a。配方 = P1（PR #380）验证过的五步：①测试先迁（红）→ ②模块 git mv + import 调整 → ③站点 sed → ④目标测试绿 + typecheck + grep 零残留 → ⑤biome + commit。

**Linear:** YUK-312。分支：`yuk-312-p2a-practice-move`。最后 commit 用 `Closes YUK-312`。

**环境前置：** 主仓 main 最新（含 P1）；Docker 运行中；工作区无关未跟踪文件不入 commit。

**Out of scope:** 流编排器/卷架/申诉链（P2c）、UI 改动（P2d）、questions CRUD 路由、judges 注册表、quiz 四件套、learning_intent/teaching orchestrator、内核 proposals 契约（P2b）。

---

## 通用配方（每个迁移任务都按此执行，下文只写差异参数）

```
RECIPE(模块组):
  1. git mv 测试文件 → src/capabilities/practice/<区>/<名>.{unit|db}.test.ts
     （分区已勘定，见各任务表）；修 tests/helpers/db 相对深度为 ../../../../tests/helpers/db
  2. 跑目标测试确认红（Cannot find module）
  3. git mv 实现文件 → 目标路径；包内互引改相对路径
  4. sed 全部 import 站点（各任务表列出）：
     sed -i '' "s|from '@/server/review/<名>'|from '@/capabilities/practice/server/<名>'|" <站点...>
  5. 跑目标测试绿 + pnpm typecheck + grep 残留为零 → biome --write 触碰文件 → git commit
```

红线：每个 commit 后 typecheck 必须绿（不允许跨 commit 留破碎 import）；**勘察 import 站点的 grep 不许过滤 test 文件**（P1 教训）。

---

### Task 1: 分支 + practice 包骨架

**Files:** Create `src/capabilities/practice/manifest.ts`、`src/capabilities/practice/CONTEXT.md`；Modify `src/capabilities/index.ts`、`src/capabilities/composition.unit.test.ts`

- [ ] Step 1: `git checkout -b yuk-312-p2a-practice-move`
- [ ] Step 2（红）: composition.unit.test.ts describe 块追加：

```ts
  it('includes the practice capability', () => {
    expect(capabilities.map((c) => c.name)).toContain('practice');
  });
```

Run: `pnpm vitest run --config vitest.unit.config.ts src/capabilities/composition.unit.test.ts` → Expected FAIL。

- [ ] Step 3: 创建 `src/capabilities/practice/manifest.ts`：

```ts
import { defineCapability } from '@/kernel/manifest';

export const practiceCapability = defineCapability({
  name: 'practice',
  description:
    '练习消费侧：FSRS 传感器、判分评级、卷（paper）机制与会话编排。P2c 将加入流编排器与卷架；P2a 仅等价承载迁入模块。',
  api: {
    routes: [
      { method: 'POST', path: '/api/review/submit' },
      { method: 'GET', path: '/api/review/due' },
      { method: 'POST', path: '/api/review/advice' },
      { method: 'GET', path: '/api/review/weekly' },
      { method: 'POST', path: '/api/review/appeal' },
      { method: 'GET', path: '/api/review/plan' },
      { method: 'POST', path: '/api/review/sessions' },
      { method: 'POST', path: '/api/review/sessions/[id]/pause' },
      { method: 'POST', path: '/api/review/sessions/[id]/resume' },
      { method: 'POST', path: '/api/review/sessions/[id]/end' },
      { method: 'POST', path: '/api/review/sessions/[id]/reopen' },
      { method: 'GET', path: '/api/practice' },
      { method: 'GET', path: '/api/practice/[id]' },
      { method: 'POST', path: '/api/practice/[id]/submit' },
      { method: 'PUT', path: '/api/practice/[id]/answer' },
      { method: 'POST', path: '/api/questions/[id]/solve' },
      { method: 'POST', path: '/api/questions/[id]/solve/[sid]/submit' },
      { method: 'POST', path: '/api/questions/[id]/solve/[sid]/hint' },
    ],
  },
  ui: { pages: [{ route: '/review' }, { route: '/practice' }, { route: '/practice/[id]' }] },
});
```

（注：route method 若与实际 route 文件不符，以实际文件为准修正 manifest——manifest 是归属元数据。）

- [ ] Step 4: `src/capabilities/index.ts` 登记：import `practiceCapability` 并加入数组。
- [ ] Step 5: 写 `src/capabilities/practice/CONTEXT.md`（包一页纸：职责=练习消费侧；P2a 等价迁入清单；P2c/P2d 待办指针到 P2 spec）。
- [ ] Step 6: 组合测试绿 + typecheck → commit `feat(practice): capability skeleton + manifest (YUK-312)`

### Task 2: 传感器/判分簇平移（6 模块）

**Moves**（src/server/review/ → src/capabilities/practice/server/）：

| 模块 | 测试 → 改名 |
|---|---|
| fsrs.ts | fsrs.test.ts → fsrs.unit.test.ts |
| judge-rating.ts | （无独立测试） |
| rating-advisor.ts | rating-advisor.test.ts → rating-advisor.unit.test.ts |
| effective-truth.ts | effective-truth.test.ts → effective-truth.db.test.ts |
| cause-context.ts | cause-context.test.ts → cause-context.db.test.ts |
| activity-ref.ts | activity-ref.test.ts → activity-ref.unit.test.ts |

**Import 站点**（sed 旧 `@/server/review/<名>` → `@/capabilities/practice/server/<名>`）：

- fsrs：`app/api/review/submit/route.ts`、`scripts/seed-synthetic.ts`、`src/server/boss/handlers/quiz_verify.ts`、`src/server/boss/handlers/source_verify.ts`、`src/server/proposals/actions.ts`、`src/server/proposals/actions.test.ts`
- effective-truth：`app/api/learning-items/[id]/route.ts`、`app/api/learning-items/route.ts`、`app/api/review/submit/route.ts`、`src/server/events/cause-policy.ts`、`src/server/events/queries.ts`、`src/server/orchestrator/review.ts`
- rating-advisor：`app/api/review/advice/route.ts`、`app/api/review/submit/route.ts`
- judge-rating / cause-context / activity-ref：先 `grep -rln "@/server/review/<名>" src app scripts --include='*.ts' --include='*.tsx'`（含 test）按结果 sed。

按 RECIPE 执行；db 测试验证命令 `pnpm vitest run --config vitest.db.config.ts src/capabilities/practice/server/effective-truth.db.test.ts src/capabilities/practice/server/cause-context.db.test.ts`，unit 同理。Commit `refactor(practice): move sensor/judging modules into capability (YUK-312)`。

### Task 3: 卷簇平移（8 模块）

**Moves**：

| 模块 | 测试 → 改名 |
|---|---|
| due-list.ts | （route 侧测试见 Task 5） |
| variant-rotation.ts | variant-rotation.test.ts → variant-rotation.db.test.ts |
| paper-detail.ts | paper-cycle.test.ts → paper-cycle.db.test.ts（覆盖整簇的大测试，1447 行） |
| paper-submit.ts | |
| paper-sections.ts | paper-sections.test.ts → paper-sections.unit.test.ts |
| paper-adaptation.ts | paper-adaptation.test.ts → paper-adaptation.db.test.ts |
| practice-read.ts | practice-read.unit.test.ts（已是 .unit 命名，随迁即可） |
| answer-draft.ts | |

**Import 站点**：

- paper-detail：`app/(app)/practice/[id]/page.tsx`、`app/api/practice/[id]/route.ts`
- paper-submit：`app/api/ingestion/[id]/make-paper/route.test.ts`、`app/api/practice/[id]/route.test.ts`、`app/api/practice/[id]/submit/route.ts`
- paper-sections：`app/api/practice/[id]/submit/route.ts`
- practice-read：`app/(app)/practice/page.tsx`、`app/api/ingestion/[id]/make-paper/route.test.ts`、`app/api/practice/route.ts`、`src/ui/practice/PaperCard.tsx`
- answer-draft：`app/api/practice/[id]/answer/route.ts`、`app/api/practice/[id]/route.test.ts`（包内 paper-submit→answer-draft 相对引用随 git mv 自然保留）
- due-list：`app/api/review/due/route.ts` + 同目录 3 个 test（cross-subject / soft-bias / source-tier-projection）
- variant-rotation：grep 确认（预期仅包内引用）

按 RECIPE；`rmdir src/server/review`。Commit `refactor(practice): move paper/queue cluster into capability (YUK-312)`。

### Task 4: 会话簇平移（orchestrator 练习域两模块）

**Moves**：

| 源 | 目标 | 测试 |
|---|---|---|
| src/server/orchestrator/review.ts | src/capabilities/practice/server/review-session.ts | review.test.ts → review-session.db.test.ts |
| src/server/orchestrator/solve.ts | src/capabilities/practice/server/solve-session.ts | solve.test.ts → solve-session.db.test.ts |

- [ ] Step 1（先勘察再动）：`grep -rln "@/server/orchestrator/review'" src app scripts --include='*.ts' --include='*.tsx'` 与 solve 同理（含 test，区分于 learning_intent/teaching 的进口方）。预期：review → app/api/review/plan + sessions 相关 + proposals/actions(?)；solve → questions/[id]/solve 链×3 + src/server/copilot/skills/solve-skill.ts(+test)。以实际 grep 结果为准列站点。
- [ ] Step 2-5：按 RECIPE（注意 review-session.ts 内对 effective-truth 的 import 已在 Task 2 改为包内相对路径 `./effective-truth`）。
- [ ] 边界检查：若 review.ts/solve.ts import 了 `./json-sanitize` 或 `./learning_intent` 等留守模块，改为 `@/server/orchestrator/json-sanitize`（迁移期豁免：capability 可 import 遗留共享件，记入 CONTEXT.md 待 P4 清账）。

Commit `refactor(practice): move review/solve session orchestrators into capability (YUK-312)`。

### Task 5: API 壳化批 1（review 面）

对每条 route：≤60 行的薄 route 仅做 import 路径更新（它们已是壳）；厚 route 把 body 迁入 `src/capabilities/practice/api/<名>.ts`，route 文件只留 `export const runtime` + re-export（P1 模式）。

| Route | 行数 | 处理 |
|---|---|---|
| app/api/review/submit/route.ts | 532 | body → practice/api/submit.ts；route 壳化 |
| app/api/review/weekly/route.ts | 167 | body → practice/api/weekly.ts；壳化 |
| app/api/review/advice/route.ts | 105 | body → practice/api/advice.ts；壳化 |
| app/api/review/sessions/[id]/end/route.ts | 83 | body → practice/api/session-end.ts；壳化 |
| appeal / plan / due / sessions 其余 4 条 | ≤74 | import 更新即可 |

route 测试随厚 route body 迁移：`app/api/review/due/` 3 个测试 → `src/capabilities/practice/api/due.{cross-subject,soft-bias,source-tier-projection}.db.test.ts`（它们测 handleReviewDue 行为，归包；helpers 深度 ../../../../）。submit 若有同目录测试一并迁（执行时 ls 确认）。

按 RECIPE 节奏逐条（每条先迁测试红再迁 body 绿）；全部完成后 commit `refactor(practice): shell-mount review API routes (YUK-312)`。

### Task 6: API 壳化批 2（practice 面 + solve 链）

| Route | 行数 | 处理 |
|---|---|---|
| app/api/practice/route.ts | 122 | body → practice/api/papers-list.ts；壳化 |
| app/api/practice/[id]/submit/route.ts | 105 | body → practice/api/paper-submit-route.ts；壳化 |
| app/api/practice/[id]/route.ts | 34 | import 更新 |
| app/api/practice/[id]/answer/route.ts | 50 | import 更新 |
| solve 链 ×3（39/82/42） | ≤82 | import 更新（body 本体已在 solve-session.ts） |

`app/api/practice/[id]/route.test.ts` → `src/capabilities/practice/api/paper-detail.db.test.ts`。`app/api/ingestion/[id]/make-paper/route.test.ts` 留在原地（ingestion 域），仅 Task 3 已做的 import 更新。

Commit `refactor(practice): shell-mount practice/solve API routes (YUK-312)`。

### Task 7: submit 拆三段（包内重构，行为不变）

`src/capabilities/practice/api/submit.ts`（原 532 行）拆为包内三个服务函数（同文件或 server/ 下新文件均可，以可读性定）：`validateSubmit()`（请求校验+会话/题目断言）/ `judgeSubmit()`（判分路由+评级建议）/ `persistSubmit()`（event+FSRS 单一入口写入，保持原事务边界）。route 行为零变化——**不写新测试，靠既有 submit/paper-cycle 测试钉等价**；若拆分暴露未覆盖分支，补最小 db 测试。

Commit `refactor(practice): split submit into validate/judge/persist phases (YUK-312)`。

### Task 8: vitest allowlist 清账

`vitest.shared.ts` fastTestInclude 删除 5 条已迁条目（约 L244-255）：`src/server/review/activity-ref.test.ts`、`fsrs.test.ts`、`rating-advisor.test.ts`、`paper-sections.test.ts`、`practice-read.unit.test.ts`（及随附注释块）。

Run: `pnpm test:unit 2>&1 | tail -3` 与 `pnpm audit:partition 2>&1 | tail -3` → Expected：通过，且 unit 用例数与 Task 7 结束时一致（约定 glob 已接管这 5 个文件）。

Commit `test(practice): retire migrated allowlist entries (YUK-312)`。

### Task 9: 全量 gate + PR

- [ ] `pnpm typecheck && pnpm lint && pnpm audit:partition && pnpm audit:schema`
- [ ] `pnpm test 2>&1 | tail -15`（贴尾部输出为证据）
- [ ] `pnpm build 2>&1 | tail -8`
- [ ] 零残留：`grep -rn "@/server/review/\|@/server/orchestrator/review'\|@/server/orchestrator/solve'" src app scripts --include='*.ts' --include='*.tsx'` → 零输出；`ls src/server/review` → 不存在
- [ ] 行为抽查：dev 起在实际端口，带 token `GET /api/review/due` 与 `GET /api/practice` 返回 200 且结构同前；无 token 401
- [ ] 空 commit `Closes YUK-312` trailer + push + `gh pr create`（PR body：summary + 等价性证据 + 偏差记录；**停等用户 merge**）

---

## Self-Review

- Spec 覆盖：P2 spec §2.5 全清单（14 review 模块 ✓ Task 2/3、orchestrator 两模块 ✓ Task 4、API 壳化 ✓ Task 5/6、submit 拆三段 ✓ Task 7）；§3-P2a「零行为变化」由测试随迁 + 行为抽查钉住。
- 占位符：无 TBD；两处「以实际 grep 结果为准」是显式勘察步骤（带命令），非占位——P1 教训反向要求执行期核对而非盲信预写清单。
- 一致性：目标路径统一 src/capabilities/practice/{server,api}/；测试分区归类来自 2026-06-10 实仓逐文件 grep（DB=tests/helpers/db 依赖）。
