# Foundation B M1 真 Closeout — Reconciliation Phase

**Status**: phase spec ready for /launch-phase。
**Date**: 2026-05-25（rev 4 after 第三次实现面审）。
**Scope**: 把 Foundation B M1 "Profile validator + prompt 提取" 三条 stale issue（YUK-5 / YUK-6 / YUK-12）reconcile 掉。本 phase 主要工作：
- registry 3 处 wenyan-coupled fallback string 中性化（YUK-5 / YUK-6）
- generic AI route hardening（**默认方案 A**：删 client.ts dead code + route 仅允许 `ReviewIntentTask`，VisionExtract* 是 manual_rescue_only 拒绝；方案 B 为 explicit override，见 §0.3）
- math 引入 Foundation B 的 archeology audit（YUK-12 不可作 LOC threshold 验证，改 archeology）
- 同步更新 architecture.md / status.md / src/ai/README.md 防止文档 stale（见 §0.3 finding 1 修正）

**Anchor**: [ADR-0014 §3/§10](../../adr/0014-generalized-activity-and-capability-registry.md)、[v0.3 §1.5 Foundation B](../../planning/v0.3-generalized-ai-learning-framework.md)、[status.md §Foundation B](../status.md)。
**Predecessor**: Foundation B M3 (physics PR #91)、M4/M5 (unit_dimension@1, YUK-35/36)、Math MVP closeout。
**Non-scope**: 引入 subject #4、prompt 重写改语义、SubjectProfile schema 升级（如 audit 强烈要求 → follow-up issue）、`defaultSubjectProfile` 选型重审。

## 0. Implementation-side fact check（rev 3 修订）

### 0.1 真实 grep 命中（验收 baseline）

```
$ grep -rn "文言\|classical chinese\|繁简" src/ai/ src/server/ai/
src/ai/registry.ts:176   '...文言文示例首选经典原文...'   (NoteGenerateTask.systemPrompt, DEPRECATED fallback)
src/ai/registry.ts:309   '...文言文示例首选经典原文...'   (VariantGenTask.systemPrompt, DEPRECATED fallback)
src/ai/registry.ts:327   '你是文言文学习教练...'           (TeachingTurnTask.systemPrompt, DEPRECATED fallback)
src/ai/task-prompts.test.ts:32,39,43,56,83,92,100         (test expectations，应保留)
```

3 处 registry fallback 都已 marked `// DEPRECATED (2026-05-22 M1)`，注释说"runtime renders via getTaskSystemPrompt(task, profile)"。**rev 3 决议**：本 phase 内中性化这 3 处字符串，删 wenyan 字面，保留 type-required 占位 + DEPRECATED 注释。

### 0.2 实际 TaskKind 数量与覆盖分类

`src/ai/registry.ts` 注册 **18 个** TaskKind：

| # | TaskKind | Prompt 来源 | 类别 |
|---|---|---|---|
| 1 | AttributionTask | `buildAttributionPrompt(profile)` | profile-driven |
| 2 | KnowledgeProposeTask | `buildKnowledgeProposePrompt(profile)` | profile-driven |
| 3 | KnowledgeEdgeProposeTask | `buildKnowledgeEdgeProposePrompt(profile)` | profile-driven |
| 4 | SessionSummaryTask | `buildSessionSummaryPrompt(profile)` | profile-driven |
| 5 | KnowledgeReviewTask | `buildKnowledgeReviewPrompt(profile)` | profile-driven |
| 6 | LearningIntentOutlineTask | `buildLearningIntentOutlinePrompt(profile)` | profile-driven |
| 7 | NoteGenerateTask | `buildNoteGeneratePrompt(profile)` | profile-driven |
| 8 | NoteVerifyTask | `buildNoteVerifyPrompt(profile)` | profile-driven |
| 9 | EmbeddedCheckGenerateTask | `buildEmbeddedCheckGeneratePrompt(profile)` | profile-driven |
| 10 | SemanticJudgeTask | `buildSemanticJudgePrompt(profile)` | profile-driven |
| 11 | UnitDimensionFallback | `buildUnitDimensionFallbackPrompt(profile)` | profile-driven |
| 12 | StepsJudgeTask | `buildStepsJudgePrompt(profile)` | profile-driven |
| 13 | VariantGenTask | `buildVariantGenPrompt(profile)` | profile-driven |
| 14 | VariantVerifyTask | `buildVariantVerifyPrompt(profile)` | profile-driven |
| 15 | TeachingTurnTask | `buildTeachingTurnPrompt(profile)` | profile-driven |
| 16 | VisionExtractTask | `tasks[task].systemPrompt` | subject-neutral pass-through |
| 17 | VisionExtractTaskHeavy | `tasks[task].systemPrompt` | subject-neutral pass-through |
| 18 | ReviewIntentTask | `tasks[task].systemPrompt` | subject-neutral pass-through（subject voice via summary payload） |

Builder 使用的 SubjectProfile 字段不只 `promptFragments`，还包括 `displayName`、`languageStyle`、`causeCategories`、`grounding`、`judgePolicy` 等 —— 验收 phrasing 统一用 **"SubjectProfile-driven"**。

### 0.3 Generic AI route runtime 漏点 + 实际 caller 调查（rev 3 修正 finding 3）

[app/api/ai/\[task\]/route.ts:31](../../../app/api/ai/[task]/route.ts:31) 调 `runTask(task, body.input ?? {}, { db, r2: getR2() })` —— **不传 `subjectProfile`**。`getTaskSystemPrompt` default = wenyan。理论上经此 route 调用所有 profile-driven task 都会渲染 wenyan voice。

但实际 production caller 调查显示：

```
$ grep -rn "/api/ai/\|callAi\|runTaskOnClient" --include='*.ts' --include='*.tsx' src/ app/ \
    | grep -v test | grep -v client.ts
(empty)
```

唯一引用是 [src/ai/client.ts:25](../../../src/ai/client.ts:25) 自身的 `runTask()`，且 client.ts:5 用 `import.meta.env.VITE_INTERNAL_TOKEN` —— **Vite 语法残余**（项目已迁 Next.js App Router），意味着 client.ts 是 stack migration 死代码。

**本 phase 决议** —— rev 4 默认走方案 A，B 为 explicit override（不再 block phase 启动）：

- **方案 A（DEFAULT）**：删 `src/ai/client.ts` dead code + server route.ts 显式拒绝所有 profile-driven task **以及** `invocation === 'manual_rescue_only'` 的 task。`registry.ts:72/86` 显示 [VisionExtractTask](../../../src/ai/registry.ts:62) / [VisionExtractTaskHeavy](../../../src/ai/registry.ts:76) 都是 `manual_rescue_only`（应走 ingestion rescue 领域入口，不该被 generic route 暴露）—— 所以方案 A 实际只允许 **`ReviewIntentTask`** 一个 task 经 generic route。其他 task 返回 400 `requires_domain_route` 或 `profile_required`。客户端无 caller（client.ts 是 Vite 残余 + grep 命中数 = 0，见上文）。
- **方案 B（explicit override）**：保留 client.ts + route.ts，加 `subject_id` 可选参数，resolve profile 传给 runTask；client.ts 修 `import.meta.env` → Next.js 兼容语法。仅当 user 在 phase start 时显式说"走方案 B"才执行。

⚠️ **决策点**：本 phase 默认实施方案 A，user 在 lane A start 前可显式 override 选 B。**不再** block phase 启动等待 user 回应；若沉默 = 执行 A。

### 0.4 Math profile 引入是 SubjectProfile schema 扩展的同一 commit（rev 3 修正 finding 1）

`git log --diff-filter=A -- src/subjects/math/profile.ts` 返回 1 行：

```
903009c feat(subjects): extend SubjectProfile with version, causeCategories,
        renderConfig, schedulingHints, judgeCapabilities (ADR-0014 §3)
```

**math profile 跟 SubjectProfile schema 扩展（Foundation B 本体）是同一个 commit**。意味着 YUK-12 原始 acceptance "math profile ≤50 行 + 0 framework changes" 在因果上根本不可能成立 —— 当时 framework 也在改。

行数演进（实测）：
- `903009c`（math profile 首次出现，伴随 SubjectProfile schema 扩展）—— 行数 (待 lane B 跑)
- `da906a4`（PR #77，math MVP M-1/M0，multimodal columns）—— **101 行**
- `dff8f34`（PR #84，math MVP M3 closeout）—— **103 行**
- `9191c160`（baseline candidate，rev 2 写的）—— **111 行**
- `main` 当前 HEAD —— **111 行**

**rev 3 结论**：Lane B 不再做 "math 引入 framework delta = 0?" 的 LOC threshold 验证（前提不成立）。改做 **archeology audit** —— 列 math profile 出生的 commit、之后每次扩张的 commit + 触发原因，归类 "subject-private 变化" / "framework schema 扩展（Foundation B 本体）" / "framework hook（builder/registry 接入）"。结论定性："Foundation B schema 与 math profile 互相验证；加新 subject（physics）后 framework 真泛化（physics 落地 framework diff = 0，见 PR #91）"。

### 0.5 Linear `Closes` 关单触发依赖 push event（rev 3 新增 / finding 5）

按 [feedback_linear_workflow.md](../../../../.claude/memory/feedback_linear_workflow.md)：commit message `Closes YUK-NN` 自动 attach 到 Linear issue **依赖 push 到 origin**，本地 commit 不会触发。

launch-phase skill 默认本地 ff-merge 后**不自动 push**（[SKILL.md:108](../../../.claude/skills/launch-phase/SKILL.md:108)）。所以 phase exit 必须含**用户手动 `git push origin main`**步骤；rev 2 写"每条 lane 单独 PR" 与 skill 模型冲突，rev 3 改成 lane 内不开 PR、chain-merge 到 local main、phase 结束 user 手动 push。

## 1. Goal

3 条断言通过真实运行被验证：

1. **`grep -rn "文言\\|classical chinese\\|繁简" src/ai/ src/server/ai/` 命中 ≤ 7 行**（仅 task-prompts.test.ts test expectations）。
2. **18 个 TaskKind 全部分类清楚 + generic AI route 漏点已 close（方案 A 或 B）**（YUK-5/6 共同验收）。
3. **Math 引入 Foundation B 的 archeology audit 写进 status.md**（YUK-12）—— 不再用 LOC threshold，改"哪些 commit + 性质分类 + 结论"。

## 2. Drivers / 选型记录

### 2.1 Reconciliation phase 性质

15 个 SubjectProfile-driven prompt builder + 3 subject-neutral pass-through + test-suite 互不污染回归已落地（[task-prompts.ts](../../../src/ai/task-prompts.ts) + [task-prompts.test.ts](../../../src/ai/task-prompts.test.ts)，详细分类见 §0.2）。YUK-5/6/12 主要是 **doc/issue drift + 3 处 registry fallback wenyan 残余 + 1 处 generic route 漏点 + YUK-12 原 acceptance 不现实 + architecture/status/README 文档将随方案 A 一起 stale**。

### 2.2 SubjectProfile-driven 不只是 promptFragments

builder 用了 `displayName`/`languageStyle`/`causeCategories`/`grounding`/`judgePolicy`/`promptFragments` 多字段。验收 phrasing 用 "SubjectProfile-driven"。

### 2.3 Generic route hardening 必须在本 phase 内做

rev 2 写 "拆 follow-up issue 不在本 phase 内做"。User finding 3 指出：YUK-6 验收"AI runner 不再 wenyan-coupled"如果留着 generic route 漏点关单过于乐观。rev 3 把它纳入 lane A scope，给 2 个最小方案。

### 2.4 YUK-12 改 archeology audit

LOC delta 方法学因 §0.4 证据失败。改 archeology = honest reading of YUK-12 body 自己说的 "decide whether to revise this issue into a realistic audit target"。

### 2.5 Lane 拆分 = 2 lane

- **Lane A** = registry 中性化 + generic route hardening + audit doc + 关 YUK-5/6
- **Lane B** = math archeology audit + status.md 追加 + 关 YUK-12

文件零重叠：lane A 改 `src/ai/registry.ts` + 可能 `src/ai/client.ts` + `app/api/ai/[task]/route.ts` + `docs/audit/`；lane B 改 `docs/superpowers/status.md` + Linear。

### 2.6 Chain order: Lane A 先 → Lane B 后（rev 3 修正 finding 4）

Lane B 写 status.md 时要引用 Lane A 创建的 audit doc。Lane A 必须先 merge 到 local main，lane B 在 main 基础上做。

## 3. Phase 序列（2 lane）

### Lane A — Prompt Profile Coverage Audit + Fallback 中性化 + Generic Route Hardening + 文档同步（YUK-5 + YUK-6）

**Pre-req**: 无（默认方案 A，不阻塞）。若 user 显式说"走方案 B"则切换；否则按 A 跑。

**Deliverable**:
- 新建 `docs/audit/2026-05-25-prompt-profile-coverage.md`：
  - Section 1: 18 TaskKind 完整表（同 §0.2）+ "callsite default profile" 列 + "invocation policy" 列（auto / manual_rescue_only）。
  - Section 2: Generic AI route hardening 方案（A 或 B）实施记录 + 决议链接。
  - Section 3: registry 3 处 fallback string 中性化前后 diff 摘要。
- 修改 `src/ai/registry.ts` 三处（line 176 / 309 / 327）：删 wenyan 字面，替换为中性占位（如 `'(see getTaskSystemPrompt(task, profile) — fallback not for runtime)'`），保留 DEPRECATED 注释。
- **方案 A（DEFAULT）实施**：
  - 删 `src/ai/client.ts`（broken Vite 残余 dead code）
  - 修改 `app/api/ai/[task]/route.ts`：白名单仅 `ReviewIntentTask`（subject-neutral + invocation=auto）；profile-driven task 返回 400 `profile_required`；`manual_rescue_only` task（VisionExtractTask / VisionExtractTaskHeavy）返回 400 `requires_domain_route` + hint 指向 ingestion rescue 入口
  - 新建 `app/api/ai/[task]/route.test.ts`：覆盖三类 400（profile_required / requires_domain_route / tool_task_requires_domain_route）+ ReviewIntentTask 200 happy path
- **方案 B 实施（仅 user explicit override）**：见 §0.3 方案 B 描述。补单测覆盖 default + 指定 profile 路径。
- 修改 `src/ai/task-prompts.test.ts` —— **不**改 wenyan ↔ math 互不污染回归（test 期望保留"文言文"是 wenyan profile 正确输出）；仅当有 test 断言 fallback 字符串内容才调整。
- **文档同步**（finding 1 修正，方案 A 必须）:
  - `src/ai/README.md:10` / `:19` / `:33` —— generic route 描述改成 "**仅 `ReviewIntentTask`**；profile-driven / tool-calling / manual-rescue task 走领域路径"。删/改 client.ts 相关段落。
  - `docs/architecture.md:142` / `:193` / `:200` —— 同上语义更新；client.ts 段落删除或标为"v0.x removed"。
  - `docs/superpowers/status.md:23` / `:164` —— "AI surface" 行 + "浏览器代码不持 API key" 行更新到方案 A 实际行为；keep auth gist（`x-internal-token` middleware）。

**Touched files（方案 A）**:
- 新建：`docs/audit/2026-05-25-prompt-profile-coverage.md`、`app/api/ai/[task]/route.test.ts`
- 修改：`src/ai/registry.ts`、`app/api/ai/[task]/route.ts`、`src/ai/README.md`、`docs/architecture.md`、`docs/superpowers/status.md`
- 删除：`src/ai/client.ts`

**Touched files（方案 B，备用）**:
- 新建：`docs/audit/2026-05-25-prompt-profile-coverage.md`、`app/api/ai/[task]/route.test.ts`
- 修改：`src/ai/registry.ts`、`app/api/ai/[task]/route.ts`、`src/ai/client.ts`（修 Vite 残余 + 加 subjectId 签名）、`src/ai/README.md`、`docs/architecture.md`、`docs/superpowers/status.md`

**Acceptance**:
- `grep -rn "文言\\|classical chinese\\|繁简" src/ai/ src/server/ai/` 命中 ≤ 7 行，全部在 `src/ai/task-prompts.test.ts`。
- `pnpm test` 全绿（含新增 route.test.ts）。
- `pnpm typecheck` / `pnpm lint` / `pnpm audit:schema` / `pnpm audit:partition` / `pnpm audit:profile` 全绿。
- audit doc 18 task 表完整 + callsite + invocation 两列填齐 + 方案 A/B 记录。
- 方案 A 下：`grep -rn "src/ai/client\|/api/ai/\[task\]" src/ai/README.md docs/architecture.md docs/superpowers/status.md` 描述与实际行为一致（即所有提及都已按方案 A 更新）。
- YUK-5 关单（commit message 含 `Closes YUK-5`）。
- YUK-6 关单（commit message 含 `Closes YUK-6`）。

---

### Lane B — Math 引入 Foundation B 的 Archeology Audit（YUK-12）

**Pre-req**: Lane A 已 chain-merge 到 local main（lane B status.md 引用 lane A audit doc）。

**Archeology 方法**:
- 起点：`git log --diff-filter=A --oneline -- src/subjects/math/profile.ts` → 一行结果：`903009c`（已 verify 见 §0.4）。
- 各阶段 LOC 演进用 `git show <sha>:src/subjects/math/profile.ts | wc -l`（已 verify 数据见 §0.4 表）。
- math 相关 squash SHA 列表（已 verify 见 §0.2 lane B subagent 输出）：`da906a4` / `b42c03a` / `77b969c` / `fda9785` / `a23694a` / `dff8f34`。
- 框架/profile 路径 LOC delta 用 `git diff --numstat`（**不**用 `--stat`，后者是 pretty 格式不可靠累加）。具体命令：
  ```bash
  # 每个 math PR 累计 framework + math-local LOC delta
  for sha in da906a4 b42c03a 77b969c fda9785 a23694a dff8f34; do
    echo "=== $sha ==="
    git diff --numstat "${sha}^..${sha}" -- \
      src/subjects/math/ \
      src/subjects/profile.ts src/subjects/profile-schema.ts \
      tests/subjects/profile.test.ts scripts/audit-profile.ts \
      src/core/ src/server/ai/ src/server/review/ \
      src/ui/ app/api/ src/ai/task-prompts.ts src/ai/registry.ts
  done
  # numstat 输出三列：added deleted filename
  # binary 文件输出 "-  -  filename"，rename 输出新文件名 + 行 delta；archeology 报告内只统计 text 文件文本行 delta，rename 标注不另计
  ```
- 分类规则（rev 4 补全 finding 2 漏的核心 schema/registry 文件）:
  - **Subject-private**: `src/subjects/math/**`、`tests/subjects/profile.test.ts` 中 math 用例、`scripts/audit-profile.ts` 中 math 用例、`src/subjects/profile.ts` 中 math 注册行 + `DEFAULT_ALIASES` math 别名行
  - **Framework schema 扩展（Foundation B 本体）**: `src/subjects/profile-schema.ts` schema 字段扩展、`src/subjects/profile.ts` 中 SubjectRegistry / validator 接入、`src/core/capability/validate-profile.ts`、`src/core/schema/capability.ts`
  - **Framework hook**: `src/ai/task-prompts.ts` builder 改造、`src/ai/registry.ts` task 注册 / 字段、`src/server/ai/judges/**` capability 路径
  - **Subject-driven framework feature**: `src/server/ai/steps-judge.ts`（multimodal vision，math 推导用）、partial credit UI（`src/ui/**` math 题特定）—— 这类**计入 framework**，但是"被 subject 驱动的 framework 升级"

**Deliverable**:
- 在 `docs/superpowers/status.md` §Foundation B 末尾追加段落：
  - 引用 `docs/audit/2026-05-25-prompt-profile-coverage.md`（lane A 产物）
  - math archeology timeline：903009c → da906a4 → ... → dff8f34，每个 PR 写 (framework, math-local, schema) numstat 累计
  - 量化结论："Foundation B schema 扩展与 math profile 引入是同 commit；math MVP 6 PR 累计 framework delta = F 行（其中 H 行 framework hook 复用、S 行 schema 扩展 Foundation B 本体、M 行 multimodal vision/partial credit 是 subject-driven framework feature）；math-local = L 行。**Acid test 真验证**在 physics PR #91：physics profile 落地后 framework diff = 0（status.md 已记），证 math MVP 引入的 hook + 扩展真泛化。"
- 在 Linear 上 edit YUK-12 description：
  - 删 `≤50 行` 硬指标
  - 删 `needs-info` + `drift` 标签
  - 新 acceptance："math 引入 Foundation B 的 archeology audit 写进 status.md；framework hook + schema 扩展性质由 physics acid test (PR #91, framework diff = 0) 验证"
- 关单（commit message 含 `Closes YUK-12`）

**Touched files**:
- `docs/superpowers/status.md`（追加段落）
- Linear（issue body edit + state change，不走 git）

**Acceptance**:
- status.md 含 math archeology timeline + numstat 数据 + 量化结论 + 引用 lane A audit doc
- YUK-12 description 更新 + 状态 → Done
- 与 lane A 无文件 conflict
- `pnpm typecheck` / `pnpm lint`（doc-only 改动，仍跑全 gate）

---

### Lane integration（无）

Lane A 改 src/ + app/api/ + docs/audit/；Lane B 改 docs/superpowers/。文件零重叠。

## 4. Chain-merge 顺序

1. **Lane A 先**（lane B 引用 lane A audit doc）
2. **Lane B 次**（基于 lane A merge 后的 local main）

每 lane 在 worktree 内 commit，**不在 lane worktree 开 PR / push**；chain-merge 走 launch-phase 默认 ff-merge 路径（[SKILL.md:61](../../../.claude/skills/launch-phase/SKILL.md:61)）。Phase 结束 user 手动 `git push origin main`，push event 触发 Linear `Closes YUK-*` 关单 attach（见 §0.5）。

每 lane ff-merge gate：`pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test`。

**Lane B 额外 gate**（finding 6）：因 lane B 改 `status.md`（Linear-sync 文档）+ edit YUK-12 description，merge 前必须跑 `pnpm docs:linear-manifest` 并把生成的 manifest summary 包进 lane B audit deliverable，避免 Linear-doc 索引漂移。参考 [linear-doc-migration.md:53/93](../../agents/linear-doc-migration.md:53)。

## 5. Acid test（phase 出口准则）

phase 结束（user push 之后）必须满足：

- [ ] YUK-5 / YUK-6 / YUK-12 状态 = Done（Linear 校对）
- [ ] `grep -rn "文言\\|classical chinese\\|繁简" src/ai/ src/server/ai/` 命中 ≤ 7 行，且全部在 `src/ai/task-prompts.test.ts`
- [ ] `docs/audit/2026-05-25-prompt-profile-coverage.md` 含 18 task 完整表 + callsite + invocation policy 两列 + generic route hardening 方案记录
- [ ] 方案 A 文档同步通过：`src/ai/README.md` / `docs/architecture.md` / `docs/superpowers/status.md` 不再把 client.ts 或 "generic `/api/ai/[task]` 接受所有 non-tool task" 写成正式 surface
- [ ] `docs/superpowers/status.md` §Foundation B 含 math archeology + numstat 数据 + 量化结论 + 引用 lane A audit doc，"M1 — Profile validator + prompt 提取" 不再 Backlog
- [ ] Generic AI route 漏点 close：profile-driven task 经此 route 调用不再隐式 wenyan（方案 A: 返回 400；方案 B: 必须传 subject_id）；`manual_rescue_only` task 不可经 generic route 触发
- [ ] `pnpm test` 全绿；`pnpm docs:linear-manifest` 通过且 manifest 与 lane B 改动一致
- [ ] `git push origin main` 完成；Linear webhook attach 三个 issue 的 commit

不达 → 回 lane，不 force-close。

## 6. Risks

| Risk | 概率 | Mitigation |
|---|---|---|
| Lane A 中性化 registry fallback 后某未发现的 codepath 仍 fallback 到 systemPrompt | 低 | `tasks[task].systemPrompt` 实际 callsite 仅 3 个 subject-neutral pass-through（VisionExtract*/ReviewIntent）；lane A 内 grep `tasks\[.*\]\.systemPrompt` 双查 |
| Lane A 方案 B 选定后 client.ts 修复破 Next.js 环境变量约定 | 中 | spec §0.3 已标 client.ts 用 Vite 语法，方案 B 必须改成 Next 兼容；route.test.ts 覆盖 happy path |
| Lane B archeology numstat 跨 binary / rename 不可靠 | 低 | `--numstat` 对 binary 输出 `-` `-`，对 rename 输出新名 + delta；lane B 只算文本文件 + 注明 rename 不另计 |
| Lane B 解析 squash SHA 失败（PR squash 后 SHA 改变） | 低 | §3 已钉死 6 个 SHA（已 verify 见 §0.4 表）；lane B 第一步用 `git cat-file -e <sha>` 复查存在 |
| User 沉默不确认方案 | 低 | rev 4 改成默认 A，sphase 启动不阻塞；user 显式 override 才走 B |
| Lane A 改 architecture/status/README 与他人在飞分支冲突 | 低 | 这 3 个 doc 当前 `main` HEAD 干净（`git status` clean），lane A 在 worktree 内独立 commit；chain-merge 时 ff-merge 校验拓扑 |
| Lane B `pnpm docs:linear-manifest` 在 sandbox 失败 EPERM | 中 | [linear-doc-migration.md:96](../../agents/linear-doc-migration.md:96) 已有 rerun guidance；lane B subagent 若首次失败按文档 rerun 并把 retry 记录写进 audit |

## 7. Follow-ups（**不**在本 phase 实施）

- **`defaultSubjectProfile` 重审** —— 当前 default = wenyan。如未来 wenyan 不再 primary subject，需调整。本 phase 不动。
- **SubjectProfile schema 升级** —— 仅当 lane A audit 发现某 prompt 残余无法用现有字段抽时创建。
- **`VARIANT_CAUSE_STRATEGIES` 是否进 SubjectProfile** —— 当前有 fallback 不算 hardcode，可不动。
- **Generic AI route 长期规划** —— 方案 A/B 二选一后续可能再升级（如方案 A 后续要重新引入 dev/debug surface），lane A 内 audit doc 记录决议。

---

## Phase launch checklist（给 /launch-phase）

- [x] Phase spec ready（本文件 rev 4）
- [ ] User approves spec + 2 lane 拆分
- [ ] **默认方案 A**；user 若要走 B 在 lane A 启动前显式说明
- [ ] /launch-phase 起 lane A worktree → chain-merge 到 local main → 起 lane B worktree
- [ ] Per-lane subagent 现场写 plan SoT（不预写，避免 stale —— 见 [feedback_lane_plan_pattern](../../../../.claude/memory/feedback_lane_plan_pattern.md)）
- [ ] Lane B 跑 `pnpm docs:linear-manifest`（Linear-doc 索引同步）
- [ ] phase 结束 → user 手动 `git push origin main` → Linear webhook 关 3 个 issue
- [ ] emit lane state 表 + Foundation B project 状态截图
