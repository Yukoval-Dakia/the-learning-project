# Foundation 真 Closeout — P-1 Preflight + Audit + Physics Fixture Seed

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** P-1 phase 三件 deliverable 落地——(1) `docs/audit/2026-05-22-partial-credit-trace.md` 列 score / coarse_outcome 各层流向 + framework LOC baseline + mathjs 评估笔记；(2) `src/subjects/physics/fixtures/{data.json,index.ts,schema.test.ts}` 10 道 fixture（5 单位换算 + 3 量纲分析 + 2 公式应用）含 P2 expected_signals 4 类错误路径；(3) `src/subjects/physics/README.md` 占位说明。**不**引 profile / registry / unit_dimension capability / mathjs 依赖——全部留给 P0 / P1 / P2。

**Architecture:**
- Audit doc 是静态 markdown：transcribe spec §4.1 / 4.2 / 4.3 表格 + 加 actual file:line 引用 + 跑 `wc -l` + `git rev-parse HEAD` 落地 LOC baseline + mathjs npm 调研一段。
- Physics fixtures mirror `src/subjects/math/fixtures/` 结构：`data.json` + `index.ts`（Zod schema + loader）+ `schema.test.ts`（unit-config 跑，无 DB / R2 / AI）。
- Physics fixture schema 比 math 多 4 字段（`reference_value` / `reference_unit` / `tolerance` / `expected_signals[]`）。仅 subject-local 文件，**不动** framework schema (`src/core/schema/*`)。
- Zod schema validation 不做语义检查（无 `unit_dimension@1` capability 可用，要到 P2 才有）。fixture 是纯数据 + 元数据，schema test 验数量分布 + 5 类 expected_signal 覆盖。

**Tech Stack:** Markdown / Zod / TypeScript / Vitest unit config（`vitest.unit.config.ts`） / jq / wc / git plumbing。

**Spec source:** `docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md` §3 Phase P-1（line 70-90） + §4 现状 verify 记录 + §9 Q1 / Q2 (mathjs verify in P-1 + fixture source confirm)。

**Spec deltas observed:**
- Spec §3 P-1 #2 描述 baseline 用 `git ls-tree` —— 本 plan 改用 `wc -l <file>` 拿 LOC + `git rev-parse HEAD` 拿 baseline SHA；表格列 file / LOC / SHA / notes 四列，更便于后续 phase `git diff <SHA> -- <file>` 对照。
- Spec §3 P-1 #3 提"fixture metadata 含 expected `unit_dimension` 判分关键点（缺单位 / 单位错 / 量纲不平 / 数值错 4 类）" —— 本 plan 把 4 类扩到 5 类 `ExpectedSignal` enum：`numeric_close` / `numeric_off` / `unit_mismatch_same_dimension` / `dimension_mismatch` / `missing_unit`（与 spec §7.4 的 4 错误路径表对齐 +1 个"缺单位"未在 §7.4 单独列但 §3 P-1 #3 明确要求覆盖）。
- Spec §9 Q1 (mathjs verify in P-1) —— pre-flight `jq '.dependencies + .devDependencies' package.json` 已确认 mathjs **未引**；本 plan §Task 3 评估并写到 audit doc，**P-1 不引依赖**（P2 决策）。
- Spec §9 Q2 (fixture source confirm) —— 已 confirm：**自编 10 道**（与 math MVP 一致）；本 plan §Task 5 列出 10 道完整内容。

**Boundaries (P-1 不做):**
- ❌ `src/subjects/physics/profile.ts`（P0 deliverable）
- ❌ `src/subjects/profile.ts` 注册 physicsProfile / KNOWN_SUBJECT_IDS（P0）
- ❌ `unit_dimension@1` capability skeleton（P1）
- ❌ `unit_dimension@1` impl（P2）
- ❌ Rating advisor / review UI advisory（P3）
- ❌ Ingestion pipeline 接 fixture（P0 端到端 smoke）
- ❌ 引 mathjs 依赖（P-1 只评估，P2 决定）
- ❌ 动 framework schema (`src/core/schema/*`) / 动任何 framework 文件——P-1 全部产出在 `docs/audit/` + `src/subjects/physics/` 两个新位置

---

## File Structure

### Create
- `docs/audit/2026-05-22-partial-credit-trace.md` — audit doc（§1 partial credit 各层 / §2 framework LOC baseline / §3 mathjs 评估）
- `src/subjects/physics/fixtures/data.json` — 10 道 physics fixture
- `src/subjects/physics/fixtures/index.ts` — Zod schema + `loadPhysicsFixtures()` loader（mirror `src/subjects/math/fixtures/index.ts`）
- `src/subjects/physics/fixtures/schema.test.ts` — schema validation 测试
- `src/subjects/physics/README.md` — P-1 占位说明

### Modify
（无）—— P-1 不动 framework / 不动 math / 不动 wenyan / 不动 schema。

### Test
- 新增：`src/subjects/physics/fixtures/schema.test.ts` —— unit config 跑（无 DB / R2 / AI 依赖）

---

## Tasks

### Task 1: Audit doc skeleton + §1 partial credit 现状各层

**Files:**
- Create: `docs/audit/2026-05-22-partial-credit-trace.md`

- [ ] **Step 1: Write audit doc skeleton with §1 table**

Write to `docs/audit/2026-05-22-partial-credit-trace.md`:

```markdown
# Partial Credit Trace + Framework Diff Baseline — P-1

**Date**: 2026-05-22
**Scope**: P-1 Phase of Foundation 真 Closeout（spec `docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md`）
**Run by**: P-1 plan agent
**Purpose**: (1) 列 `JudgeResultV2.score` / `coarse_outcome` 在判分链路各层的流向 + 标"断点"；(2) snapshot framework LOC + git SHA 作为 P0 / P1 / P2 / P3 / P4 acid test baseline；(3) `mathjs` 依赖评估笔记（spec §9 Q1）。

## §1 Partial Credit 各层现状

来源：spec §4.1（2026-05-22 verify 记录）。本表把 spec 表 transcribe + 加 actual file:line 引用，固化为 P-1 baseline，供 P3 acid test 3 对照"score 真贯穿"。

| 层 | 现在消费什么 | partial 信号 | 实现位置 |
|---|---|---|---|
| Judge (`judgeAnswer`) | 算出 `JudgeResultV2 { score, coarse_outcome, capabilityRef }` | ✅ 算出来 | `src/server/ai/judges/<judge-answer entry>`；steps@1 见 `src/server/ai/judges/steps-judge.ts` |
| Event log | event.payload.judge 含 score + coarse_outcome | ✅ 留痕完整 | `src/server/events/<append entry>` |
| Review UI 显示 | `JudgeResultPanel` 显示 score + capability label + appeal 按钮 | ✅ 显示 | `src/ui/components/JudgeResultPanel.tsx` |
| Review submit route | `body.rating: FsrsRating` — UI 4 按钮点击 | ❌ **rating 由用户手点，judge.score 不参与映射** | `app/api/review/submit/route.ts` (entry handler) |
| `outcome` 推断 | `body.rating === 'again' ? 'failure' : 'success'` | ❌ **二元，partial 信号丢** | `app/api/review/submit/route.ts:<line>` |
| FSRS scheduler | `scheduleReview(prevState, body.rating, now)` | ❌ **接收 rating 不接收 score** | `src/server/review/fsrs.ts` |
| Mastery view | 读 event.payload.outcome（二元） | ❌ **partial 不进 mastery 计算** | `src/server/review/<mastery module>` |

**结论**：判分→留痕→显示链路通；判分→调度链路在 review submit 那里断了。P3 修这一段；mastery view 这一段（partial → mastery）是 N+1。
```

- [ ] **Step 2: 跑 grep / find 补齐表里 entry / line 占位**

```bash
# 找 review submit outcome 推断行
grep -n "rating === 'again'" app/api/review/submit/route.ts || echo "MISSING: rating-to-outcome inference"

# 找 review submit handler 入口
grep -nE "export (async )?function (POST|handler)" app/api/review/submit/route.ts

# 找 scheduleReview 实现
grep -nE "export (async )?function scheduleReview|export const scheduleReview" src/server/review/fsrs.ts || echo "MISSING: scheduleReview"

# 找 judge-answer entry
find src/server/ai/judges -name '*.ts' -not -name '*.test.ts' | xargs grep -l 'export.*judgeAnswer' || echo "MISSING: judgeAnswer entry"

# 找 event append entry
grep -rEn "export (async )?function (append|writeEvent)" src/server/events/ | head -5

# 找 mastery module
find src/server/review -name '*.ts' -not -name '*.test.ts' | xargs grep -l 'mastery\|outcome.*success.*failure' 2>/dev/null | head -3
```

把实际行号 / 文件名 replace 进 audit doc §1 表的"实现位置"列。如果某行确认"not found"，则在 audit doc 末尾加一句 `**N+1 verify**: <which row> 位置未找到，需 P3 实施时再 locate`，**不要**在 P-1 阶段强行 fix（spec 不要求 P-1 修代码）。

- [ ] **Step 3: Commit**

```bash
git add docs/audit/2026-05-22-partial-credit-trace.md
git commit -m "audit(p-1): partial credit trace doc §1 — current state table"
```

---

### Task 2: Audit doc §2 framework LOC baseline

**Files:**
- Modify: `docs/audit/2026-05-22-partial-credit-trace.md`

- [ ] **Step 1: 跑 LOC + SHA snapshot**

```bash
SHA=$(git rev-parse HEAD)
echo "Baseline SHA: $SHA"
echo

declare -a FILES=(
  src/core/capability/registry.ts
  src/core/capability/types.ts
  src/core/capability/validate-profile.ts
  src/core/capability/judges/exact.ts
  src/core/capability/judges/keyword.ts
  src/core/capability/judges/semantic.ts
  src/core/capability/judges/steps.ts
  src/core/capability/judges/index.ts
  src/core/schema/activity.ts
  src/core/schema/capability.ts
  src/server/ai/judges/index.ts
  src/server/ai/judges/question-contract.ts
  src/server/ai/judges/router.ts
  src/server/ai/judges/steps-judge.ts
  src/server/review/fsrs.ts
  src/server/review/activity-ref.ts
  src/ui/lib/subject.ts
  src/ui/lib/math-markdown.tsx
  src/subjects/profile.ts
  app/api/review/submit/route.ts
  app/api/review/plan/route.ts
  app/api/review/due/route.ts
  app/api/review/appeal/route.ts
)

printf '| File | LOC | Notes |\n|---|---|---|\n'
for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
    loc=$(wc -l < "$f" | tr -d ' ')
    printf '| `%s` | %s | |\n' "$f" "$loc"
  else
    printf '| `%s` | (not found) | verify path |\n' "$f"
  fi
done
echo
echo "src/core/schema/event/ dir total:"
find src/core/schema/event -type f -name '*.ts' -exec wc -l {} + 2>/dev/null | tail -1
```

把输出 transcribe 到 audit doc 新段 §2：

```markdown
## §2 Framework LOC Baseline

**Baseline SHA**: `<paste SHA from above>`
**Date frozen**: 2026-05-22

后续 P0 / P1 / P2 / P3 acid test 与本表对比；`framework diff = 0` 判定基于以下文件 LOC 不变（除 spec 明确允许的 1-2 行 register 调用 / enum +1 项 / route 分支）。

<paste table from above + 在 Notes 列填入下表的"允许差异">

`src/core/schema/event/**.ts` (dir total): <N>

### Notes / 允许的 phase 差异

| File | Allowed delta | 来自哪个 phase |
|---|---|---|
| `src/core/capability/judges/index.ts` | +1 行 `registry.registerJudge(unitDimensionV1Capability)` | P1 |
| `src/core/schema/capability.ts` | ScoreMeaning enum +1 项 `'unit_dimension_v1'` | P1 |
| `src/server/ai/judges/question-contract.ts` | +1 行 route 分支（physics + calculation → 'unit_dimension'） | P1 |
| `src/subjects/profile.ts` | `this.register(physicsProfile)` + DEFAULT_ALIASES 加 `'physics' / 'physical'` 几行 | P0 |
| `app/api/review/submit/route.ts` | +1 字段 `judge_advice?: { rating, reason }` event payload + optional body field | P3 |
| `app/(app)/review/page.tsx` | +1 `<RatingAdvisor>` 组件 | P3（非本 baseline 路径，但记录） |

其余文件 P0 / P1 / P2 / P3 LOC change **= 0**。任何超出本表的 framework diff 触发 phase 回退 + spec deltas 文档。

### Acid Test Reference

- **Acid Test 1 (P0 Foundation B)**: `git diff <SHA> -- src/core src/server/ai src/server/review src/ui app/api`（subject 子目录除外）应当为空
- **Acid Test 2 (P1 Foundation A)**: `src/core/capability/registry.ts` + `src/server/ai/judges/index.ts`（主体）LOC change = 0；只允许上表列出的 3 项 framework diff
- **Acid Test 3 (P3 Foundation C)**: `src/server/review/fsrs.ts` / `scheduleReview` ABI 不变；FSRS 内核 LOC change = 0；UI / submit route 按上表 P3 行允许
```

- [ ] **Step 2: Commit**

```bash
git add docs/audit/2026-05-22-partial-credit-trace.md
git commit -m "audit(p-1): framework LOC baseline + acid test reference"
```

---

### Task 3: Audit doc §3 mathjs evaluation note

**Files:**
- Modify: `docs/audit/2026-05-22-partial-credit-trace.md`

- [ ] **Step 1: 收集 mathjs 数据**

读以下信息（用 WebFetch 或简单 npm 命令）：

```bash
# 命令 (不安装，只查)
npm view mathjs version description repository.url license maintainers.length 2>&1 || true
npm view mathjs dist.unpackedSize 2>&1 || true
```

或者从 https://www.npmjs.com/package/mathjs 网页拿：version / unpacked size / weekly downloads / last publish date / open issues / stars。

捕获关键字段：
- mathjs latest version
- unpacked size (MB)
- weekly downloads
- last publish (天)
- unit lib API smoke: `math.unit('30 km/h').to('m/s').toNumber()` 是否能返 8.333...

- [ ] **Step 2: 写 audit doc §3**

把以下追加到 audit doc：

```markdown
## §3 Capability Path Notes — `unit_dimension@1` 实现选型

P-1 评估 P2 实现路径，**不引依赖**。决策推迟到 P2 plan 启动时由 user / agent 在 P2 task 1 确认。

### Option A: mathjs unit 库（倾向推荐）

| 项 | 值 |
|---|---|
| npm package | `mathjs@<latest-version>` |
| 当前是否引入 | ❌ 未引（P-1 pre-flight `jq '.dependencies + .devDependencies' package.json` 验证） |
| Unpacked size | <X MB> |
| Weekly downloads | <Y> |
| Last publish | <Z 天前> |
| License | <license> |
| Unit API | `math.unit('30 km/h').to('m/s').toNumber()` → 8.333... |
| Bundle bloat 风险 | **server-only 路径**（unit judge 不在 client bundle），冷启动开销估算 ~50ms，可接受 |
| 中文单位风险 | mathjs 不支持"米/秒"、"公里" 等中文 → 需要 LLM fallback 预处理（spec §3 P2 #2 已规划） |

### Option B: 自写 SI base-7 量纲分析

| 项 | 值 |
|---|---|
| 思路 | 7 维向量 `(M, L, T, I, Θ, N, J)` + 有理数指数；解析器接受 "30 km/h" → `{ value: 30, base: 'm/s', mult: 1000/3600 }` |
| 工作量估算 | ~2-3 day（接近 P2 整 phase 预算的 50%） |
| 维护成本 | 单位别名 / SI prefix / 复合单位的覆盖 long tail；命中率难短期到 90%+ |
| 优势 | 0 依赖；学习项目可控；TypeScript 类型严格 |
| 风险 | 工作量挤占 P2 score 合成 + 4 错误路径分类的核心 deliverable |

### Recommendation for P2

倾向 Option A（mathjs）。理由：(1) deterministic accelerator 主路径"包装现成 API"工作量小于"实现量纲库"；(2) LLM fallback 仍要做（中文单位 / 复合形式），与库选型正交；(3) Option B 的 2-3 day 工作量挤占 P2 核心 deliverable。

**Final decision**: 在 P2 plan 开 task 1 时由 user / agent 确认；如果 Option A bundle bloat 测出来 > 1MB 或维护活跃度 < 6 个月 1 release，转 Option B。
```

- [ ] **Step 3: Commit**

```bash
git add docs/audit/2026-05-22-partial-credit-trace.md
git commit -m "audit(p-1): mathjs evaluation note for P2 selection"
```

---

### Task 4: Physics fixtures schema (`index.ts`)

**Files:**
- Create: `src/subjects/physics/fixtures/index.ts`

- [ ] **Step 1: 建目录**

```bash
mkdir -p src/subjects/physics/fixtures
```

- [ ] **Step 2: Write schema + loader**

Mirror `src/subjects/math/fixtures/index.ts` pattern。Write to `src/subjects/physics/fixtures/index.ts`:

```ts
import { z } from 'zod';
import fixtureData from './data.json' with { type: 'json' };

// P-1 (2026-05-22): fixture schema is subject-local — does NOT touch
// framework schema (src/core/schema/*). Adds 4 physics-specific fields
// (reference_value / reference_unit / tolerance / expected_signals) for
// P2 unit_dimension@1 4 错误路径 test coverage.
// See docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md §3 P-1 #3.

export const ExpectedSignal = z.enum([
  'numeric_close',
  'numeric_off',
  'unit_mismatch_same_dimension',
  'dimension_mismatch',
  'missing_unit',
]);
export type ExpectedSignalT = z.infer<typeof ExpectedSignal>;

export const PhysicsFixtureTestCase = z.object({
  case: z.string().min(1),
  student_answer: z.string().min(1),
  expected_signal: ExpectedSignal,
});
export type PhysicsFixtureTestCaseT = z.infer<typeof PhysicsFixtureTestCase>;

export const PhysicsFixtureItemSchema = z.object({
  ref: z.string().min(1),
  kind: z.enum(['single_choice', 'calculation']),
  prompt_md: z.string().min(1),
  choices_md: z.array(z.string().min(1)).optional(),
  reference_md: z.string().min(1),
  reference_value: z.number().optional(), // omitted for dimension-only choice / 字符串答案题
  reference_unit: z.string().optional(),
  tolerance: z.number().min(0).default(0.05),
  difficulty: z.number().int().min(1).max(5),
  knowledge_hint: z.string().min(1),
  expected_signals: z.array(PhysicsFixtureTestCase).min(1),
});
export type PhysicsFixtureItemT = z.infer<typeof PhysicsFixtureItemSchema>;

export const PhysicsFixtureFileSchema = z.object({
  version: z.string(),
  subject_id: z.literal('physics'),
  items: z.array(PhysicsFixtureItemSchema).length(10),
});

export function loadPhysicsFixtures(): PhysicsFixtureItemT[] {
  return PhysicsFixtureFileSchema.parse(fixtureData).items;
}
```

- [ ] **Step 3: Defer typecheck until Task 5**

`data.json` 还不存在，typecheck 会报 `Cannot find module './data.json'`。Task 5 写完 data.json 再 typecheck。

- [ ] **Step 4: 不单独 commit**

合并到 Task 6 一次性 commit（fixture 三件套必须一起 typecheck pass 才有意义）。

---

### Task 5: Physics fixtures data (`data.json`)

**Files:**
- Create: `src/subjects/physics/fixtures/data.json`

**Goal**: 10 道 fixture：5 单位换算 + 3 量纲分析 + 2 公式应用。Refs 命名约定：`physics-{unit,dim,formula}-NNN`。Every fixture has `expected_signals` array，5 类 ExpectedSignal 全局至少各命中 1 次。

- [ ] **Step 1: Write data.json**

Write to `src/subjects/physics/fixtures/data.json`:

```json
{
  "version": "2026-05-22",
  "subject_id": "physics",
  "items": [
    {
      "ref": "physics-unit-001",
      "kind": "calculation",
      "prompt_md": "将 $30 \\text{ km/h}$ 换算为 SI 单位（m/s），保留 2 位小数。",
      "reference_md": "8.33 m/s",
      "reference_value": 8.33,
      "reference_unit": "m/s",
      "tolerance": 0.05,
      "difficulty": 1,
      "knowledge_hint": "速度单位换算",
      "expected_signals": [
        { "case": "数值近", "student_answer": "8.30 m/s", "expected_signal": "numeric_close" },
        { "case": "数值远", "student_answer": "50 m/s", "expected_signal": "numeric_off" },
        { "case": "单位错量纲对", "student_answer": "30 km/h", "expected_signal": "unit_mismatch_same_dimension" },
        { "case": "量纲错", "student_answer": "8.33 m", "expected_signal": "dimension_mismatch" },
        { "case": "缺单位", "student_answer": "8.33", "expected_signal": "missing_unit" }
      ]
    },
    {
      "ref": "physics-unit-002",
      "kind": "calculation",
      "prompt_md": "将 $1 \\text{ atm}$ 换算为 SI 压强单位 Pa。",
      "reference_md": "101325 Pa",
      "reference_value": 101325,
      "reference_unit": "Pa",
      "tolerance": 0.001,
      "difficulty": 2,
      "knowledge_hint": "压强单位换算",
      "expected_signals": [
        { "case": "数值近", "student_answer": "101300 Pa", "expected_signal": "numeric_close" },
        { "case": "单位错量纲对", "student_answer": "1.013 bar", "expected_signal": "unit_mismatch_same_dimension" },
        { "case": "缺单位", "student_answer": "101325", "expected_signal": "missing_unit" }
      ]
    },
    {
      "ref": "physics-unit-003",
      "kind": "calculation",
      "prompt_md": "将 $2 \\text{ cal}$ 换算为 J（取 $1 \\text{ cal} = 4.184 \\text{ J}$）。",
      "reference_md": "8.368 J",
      "reference_value": 8.368,
      "reference_unit": "J",
      "tolerance": 0.01,
      "difficulty": 1,
      "knowledge_hint": "能量单位换算",
      "expected_signals": [
        { "case": "全对", "student_answer": "8.368 J", "expected_signal": "numeric_close" },
        { "case": "单位错", "student_answer": "8.368 cal", "expected_signal": "unit_mismatch_same_dimension" },
        { "case": "量纲错", "student_answer": "8.368 W", "expected_signal": "dimension_mismatch" }
      ]
    },
    {
      "ref": "physics-unit-004",
      "kind": "calculation",
      "prompt_md": "$1.5 \\text{ mol}$ 物质大约含有多少个粒子？取阿伏伽德罗常数 $N_A = 6.022 \\times 10^{23} \\text{ mol}^{-1}$。",
      "reference_md": "9.033e23",
      "reference_value": 9.033e23,
      "tolerance": 0.005,
      "difficulty": 2,
      "knowledge_hint": "阿伏伽德罗常数",
      "expected_signals": [
        { "case": "数值近", "student_answer": "9.03e23", "expected_signal": "numeric_close" },
        { "case": "数值远", "student_answer": "6.022e23", "expected_signal": "numeric_off" }
      ]
    },
    {
      "ref": "physics-unit-005",
      "kind": "calculation",
      "prompt_md": "汽车以 $108 \\text{ km/h}$ 行驶，转换为 m/s。",
      "reference_md": "30 m/s",
      "reference_value": 30,
      "reference_unit": "m/s",
      "tolerance": 0.01,
      "difficulty": 1,
      "knowledge_hint": "速度单位换算",
      "expected_signals": [
        { "case": "全对", "student_answer": "30 m/s", "expected_signal": "numeric_close" },
        { "case": "单位错量纲对", "student_answer": "108 km/h", "expected_signal": "unit_mismatch_same_dimension" },
        { "case": "缺单位", "student_answer": "30", "expected_signal": "missing_unit" }
      ]
    },
    {
      "ref": "physics-dim-001",
      "kind": "single_choice",
      "prompt_md": "下列哪个物理量的量纲是 $M \\cdot L \\cdot T^{-2}$？",
      "choices_md": ["速度", "加速度", "力", "能量"],
      "reference_md": "力",
      "tolerance": 0,
      "difficulty": 2,
      "knowledge_hint": "力的量纲分析",
      "expected_signals": [
        { "case": "全对", "student_answer": "力", "expected_signal": "numeric_close" },
        { "case": "量纲错(选速度)", "student_answer": "速度", "expected_signal": "dimension_mismatch" }
      ]
    },
    {
      "ref": "physics-dim-002",
      "kind": "single_choice",
      "prompt_md": "速度 $v$ 的量纲为？",
      "choices_md": ["$L \\cdot T^{-1}$", "$L \\cdot T$", "$L^2 \\cdot T^{-1}$", "$L \\cdot T^{-2}$"],
      "reference_md": "$L \\cdot T^{-1}$",
      "tolerance": 0,
      "difficulty": 1,
      "knowledge_hint": "速度量纲",
      "expected_signals": [
        { "case": "全对", "student_answer": "L·T^{-1}", "expected_signal": "numeric_close" },
        { "case": "量纲错(指数错)", "student_answer": "L·T^{-2}", "expected_signal": "dimension_mismatch" }
      ]
    },
    {
      "ref": "physics-dim-003",
      "kind": "calculation",
      "prompt_md": "$E = mc^2$ 中 $c^2$ 的量纲是？（用 SI 基本量）",
      "reference_md": "$L^2 \\cdot T^{-2}$",
      "tolerance": 0,
      "difficulty": 3,
      "knowledge_hint": "$E=mc^2$ 量纲检验",
      "expected_signals": [
        { "case": "全对", "student_answer": "L^2 T^{-2}", "expected_signal": "numeric_close" },
        { "case": "量纲错", "student_answer": "L T^{-1}", "expected_signal": "dimension_mismatch" }
      ]
    },
    {
      "ref": "physics-formula-001",
      "kind": "calculation",
      "prompt_md": "自由落体 $3 \\text{ s}$ 后速度（取 $g = 9.8 \\text{ m/s}^2$，初速度为零）。",
      "reference_md": "29.4 m/s",
      "reference_value": 29.4,
      "reference_unit": "m/s",
      "tolerance": 0.02,
      "difficulty": 1,
      "knowledge_hint": "$v = gt$",
      "expected_signals": [
        { "case": "全对", "student_answer": "29.4 m/s", "expected_signal": "numeric_close" },
        { "case": "数值远", "student_answer": "98 m/s", "expected_signal": "numeric_off" },
        { "case": "量纲错", "student_answer": "29.4 m", "expected_signal": "dimension_mismatch" },
        { "case": "缺单位", "student_answer": "29.4", "expected_signal": "missing_unit" }
      ]
    },
    {
      "ref": "physics-formula-002",
      "kind": "calculation",
      "prompt_md": "$F = ma$，已知 $m = 2 \\text{ kg}$，$a = 5 \\text{ m/s}^2$，求 $F$。",
      "reference_md": "10 N",
      "reference_value": 10,
      "reference_unit": "N",
      "tolerance": 0.01,
      "difficulty": 1,
      "knowledge_hint": "牛顿第二定律",
      "expected_signals": [
        { "case": "全对", "student_answer": "10 N", "expected_signal": "numeric_close" },
        { "case": "单位错量纲对", "student_answer": "10 kg·m/s^2", "expected_signal": "unit_mismatch_same_dimension" },
        { "case": "量纲错", "student_answer": "10 J", "expected_signal": "dimension_mismatch" },
        { "case": "缺单位", "student_answer": "10", "expected_signal": "missing_unit" }
      ]
    }
  ]
}
```

- [ ] **Step 2: 验证 JSON valid**

```bash
jq . src/subjects/physics/fixtures/data.json > /dev/null
```

Expected: exit 0 无输出。失败则 PostToolUse JSON guard 也会报。

- [ ] **Step 3: 验证 typecheck pass**

```bash
pnpm typecheck
```

Expected: PASS（`data.json` 通过 Zod schema 推断；`with { type: 'json' }` import 在 tsconfig 已启用 resolveJsonModule + node ESM JSON imports，math fixtures 同样这么写）。

---

### Task 6: Physics fixtures schema test + commit

**Files:**
- Create: `src/subjects/physics/fixtures/schema.test.ts`

- [ ] **Step 1: Write failing test**

Write to `src/subjects/physics/fixtures/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import fixtureData from './data.json' with { type: 'json' };
import {
  ExpectedSignal,
  PhysicsFixtureFileSchema,
  loadPhysicsFixtures,
} from './index';

describe('physics fixtures', () => {
  it('data.json conforms to PhysicsFixtureFileSchema', () => {
    expect(() => PhysicsFixtureFileSchema.parse(fixtureData)).not.toThrow();
  });

  it('loadPhysicsFixtures returns exactly 10 items', () => {
    const items = loadPhysicsFixtures();
    expect(items.length).toBe(10);
  });

  it('每条 fixture 至少 1 个 expected_signals test_case', () => {
    const items = loadPhysicsFixtures();
    for (const item of items) {
      expect(item.expected_signals.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('expected_signals coverage：5 类信号每类至少 1 道 fixture 命中', () => {
    const items = loadPhysicsFixtures();
    const allSignals = new Set<string>();
    for (const item of items) {
      for (const tc of item.expected_signals) {
        allSignals.add(tc.expected_signal);
      }
    }
    for (const signal of ExpectedSignal.options) {
      expect(allSignals).toContain(signal);
    }
  });

  it('fixture 数量分类符合 spec §3 P-1 #3：5 单位换算 + 3 量纲分析 + 2 公式应用', () => {
    const items = loadPhysicsFixtures();
    const unitCount = items.filter((i) => i.ref.startsWith('physics-unit-')).length;
    const dimCount = items.filter((i) => i.ref.startsWith('physics-dim-')).length;
    const formulaCount = items.filter((i) => i.ref.startsWith('physics-formula-')).length;
    expect(unitCount).toBe(5);
    expect(dimCount).toBe(3);
    expect(formulaCount).toBe(2);
  });

  it('refs 全局唯一', () => {
    const items = loadPhysicsFixtures();
    const refs = items.map((i) => i.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
```

- [ ] **Step 2: 跑 schema test**

```bash
pnpm vitest run --config vitest.unit.config.ts src/subjects/physics/fixtures/schema.test.ts
```

Expected: 6 个 test 全 PASS。如果失败：
- "expected_signals coverage" failed → 检查 data.json 是否每类信号都至少命中 1 次
- "fixture 数量分类" failed → 检查 refs 命名是否符合 `physics-{unit,dim,formula}-NNN`
- "PhysicsFixtureFileSchema" parse failed → 跑 `jq . data.json` 看 JSON 是否 valid + 检查 schema 字段类型

- [ ] **Step 3: Commit fixture 三件套**

```bash
git add src/subjects/physics/fixtures/data.json src/subjects/physics/fixtures/index.ts src/subjects/physics/fixtures/schema.test.ts
git commit -m "feat(physics/fixtures): seed 10 fixtures + schema + tests (P-1)"
```

---

### Task 7: Physics README 占位

**Files:**
- Create: `src/subjects/physics/README.md`

- [ ] **Step 1: Write README**

Write to `src/subjects/physics/README.md`:

```markdown
# subjects/physics/

Physics 学科 bundle。Subject #3，用于 Foundation 真 Closeout phase（spec `docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md`）。

## P-1 状态（2026-05-22）

仅 fixture seed：
- `fixtures/data.json` — 10 道 fixture（5 单位换算 + 3 量纲分析 + 2 公式应用）
- `fixtures/index.ts` — Zod schema + `loadPhysicsFixtures()` loader
- `fixtures/schema.test.ts` — schema 验证 + 数量分布 + 信号覆盖测试

## 下一步（按 Foundation 真 Closeout phase 序列）

- **P0**：写 `profile.ts`（SubjectProfile）+ `index.ts` re-export；`src/subjects/profile.ts` 注册 + DEFAULT_ALIASES 加 `'physics' / 'physical'`；profile validator 通过；fixture 端到端跑通（学习 → 答题 → judge → review 队列）；**Foundation B acid test 1**（framework diff = 0）
- **P1**：`src/core/capability/judges/unit_dimension.ts` skeleton + 注册；profile.judgeCapabilities += 'unit_dimension'；**Foundation A acid test 2**（registry / router 0 行 diff）
- **P2**：unit_dimension@1 真实现（deterministic accelerator + LLM fallback + 4 错误路径 score 合成）
- **P3**：rating-advisor + UI advisory；**Foundation C acid test 3**（score 真贯穿 FSRS 调度）
- **P4**：closeout audit + status.md 收口

详 outline doc `docs/superpowers/plans/2026-05-22-foundation-true-closeout-phases.md`。

## 约束

- `core/` 不依赖 `subjects/`；`subjects/` 可依赖 `core/`
- 不在 `core/` 内引 physics-specific 逻辑；prompt fragments / cause taxonomy / 判分政策均在 profile 内声明
```

- [ ] **Step 2: Commit**

```bash
git add src/subjects/physics/README.md
git commit -m "docs(physics): P-1 README + phase 序列引用"
```

---

### Task 8: Regression verification

**Files:** （read-only verification，不 commit）

- [ ] **Step 1: 全量 typecheck**

```bash
pnpm typecheck
```

Expected: PASS。如果有 error 涉及 `src/subjects/math` / `src/subjects/wenyan` —— **回退 P-1**，调查 physics fixtures 是否意外触发 schema 漂移；如果 error 仅在 `src/subjects/physics/` 内，回 Task 4 / 5 / 6 修。

- [ ] **Step 2: Unit tests (no DB)**

```bash
pnpm test:unit
```

Expected: 全 PASS。本 phase 应新增 6 个 physics schema test；其它 wenyan / math / core 测试不应有 regression。

- [ ] **Step 3: Schema audit**

```bash
pnpm audit:schema
```

Expected: PASS。不应有新字段进入 `src/db/schema.ts`（本 phase 不动 DB schema）；如果 audit 抱怨 physics-related 字段，回头检查是否误改了 `src/db/schema.ts`。

- [ ] **Step 4: Partition audit**

```bash
pnpm audit:partition
```

Expected: PASS。`schema.test.ts` 在 unit 分区（无 DB / R2 / AI 依赖），lint 通过。

- [ ] **Step 5: Biome check 触动文件**

```bash
pnpm exec biome check --no-errors-on-unmatched \
  src/subjects/physics \
  docs/audit/2026-05-22-partial-credit-trace.md
```

Expected: 无 lint error。如果有 trailing whitespace / import order 等，跑 `pnpm exec biome check --write` 修后重跑。

- [ ] **Step 6: Framework 0 行改动 verify**

```bash
git diff main -- src/core src/server src/ui app
```

Expected: 完全空输出。如果非空，**phase 回退**：本 P-1 不允许任何 framework 改动，违反即写入 spec deltas 文档并停下找 user。

---

### Task 9: Open PR

**Files:** （pure git operation，git-guard hook 会拦危险操作；触发即停下找 user）

- [ ] **Step 1: 跑 commit history sanity check**

```bash
git log --oneline main..HEAD
```

Expected 5 个 commits（Task 1 / 2 / 3 / 6 / 7）。Task 4 / 5 合并到 Task 6 commit；Task 8 read-only 不 commit。

- [ ] **Step 2: Push branch**

```bash
BRANCH=$(git branch --show-current)
git push -u origin "$BRANCH"
```

(Branch name 建议在 lane 创建时定为：`foundation-closeout/p-1-preflight`。)

- [ ] **Step 3: Open PR**

```bash
gh pr create --title "feat: foundation closeout P-1 — partial credit audit + physics fixtures" --body "$(cat <<'EOF'
## Summary
- Audit doc `docs/audit/2026-05-22-partial-credit-trace.md`：§1 partial credit 各层现状（spec §4.1 transcribe + 加 actual file:line）+ §2 framework LOC baseline（含 git SHA + per-file LOC）+ §3 mathjs 评估笔记
- Physics fixture seed `src/subjects/physics/fixtures/{data.json,index.ts,schema.test.ts}`：10 道（5 单位换算 + 3 量纲分析 + 2 公式应用）+ 5 类 ExpectedSignal 覆盖 + schema 验证
- `src/subjects/physics/README.md`：subject scaffolding 占位说明，明确 P0 起步

## Spec source
`docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md` §3 Phase P-1

## Exit criteria check (spec §3 P-1)
- [x] Partial credit trace audit doc merged 到 main
- [x] Framework diff baseline 写入 audit doc（git rev-parse HEAD + 23 个 framework file LOC）
- [x] 10 道 physics fixture json 落地（schema validation 通过，不接 profile / registry）
- [x] 现有 wenyan + math regression 通过（typecheck + test:unit + audit:schema + audit:partition）

## Boundaries verified (P-1 不做的)
- 不动 framework：`src/core/**` / `src/server/**` / `src/ui/**` / `app/api/**` 0 行改动（`git diff main -- src/core src/server src/ui app` 空）
- 不引 mathjs 依赖（评估只写到 audit doc）
- 不动 `src/subjects/profile.ts`（P0 deliverable）
- 不写 `src/subjects/physics/profile.ts`（P0 deliverable）

## Test plan
- [x] `pnpm typecheck`
- [x] `pnpm test:unit`
- [x] `pnpm audit:schema`
- [x] `pnpm audit:partition`
- [x] `pnpm exec biome check`（touched files only）
- [x] `git diff main -- src/core src/server src/ui app` 空

## Next phase
P0 — Physics profile + Foundation B acid test。outline `docs/superpowers/plans/2026-05-22-foundation-true-closeout-phases.md`。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Phase Exit Criterion 验收

按 spec §3 P-1 exit criterion（line 86-90）：

- [ ] **Partial credit trace audit doc merged 到 main**（Task 1+2+3 + PR merge）
- [ ] **Framework diff baseline 写入 audit doc**（Task 2，含 LOC snapshot + git rev SHA + acid test reference 表）
- [ ] **10 道 physics fixture json 落地**（Task 4-6；schema validation 通过；5 类 ExpectedSignal 全覆盖；不接 profile / registry）
- [ ] **现有 wenyan + math regression 通过**（Task 8）

下一 phase（P0）启动条件：本 PR merge + acid test 1 baseline locked in（`git rev-parse <merge SHA>` 写入 audit doc §2）。
