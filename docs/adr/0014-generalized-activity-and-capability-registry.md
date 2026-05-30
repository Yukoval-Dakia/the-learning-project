# ADR-0014 — Generalized Learning Activity + Capability Registry

**状态**：accepted
**日期**：2026-05-18（accepted 2026-05-29 — Foundation A/B/C 全 ship，core 抽象已落地）
**前置**：ADR-0006 v2（event-driven core）、ADR-0008（multi-type session）、ADR-0010（knowledge mesh）、ADR-0012（mastery as view）
**来源**：`docs/discussion/summary.md`（Claude Code + Codex + Human, 7 轮跨 agent 讨论）

> **2026-05-29 status update (T-PD11)**：本 ADR 的核心决策已全部实现 —— `ActivityRef`/`ActivityKind`（`src/core/schema/activity.ts`）、Capability Registry（`src/core/capability/registry.ts` + `judges/index.ts` + `validate-profile.ts`，`pnpm audit:profile` 启动期强制校验）、SubjectProfile 纯数据（§3）、JudgeResult v2（§4）、correction event 一等公民（§6，`src/server/events/corrections.ts`）。status.md Foundation A/B/C 标 ✅。`§C 选项`早已自标 (**accepted**)，header 同步为 accepted（解除 §12 R-2 风险）。

> **2026-05-30 status update (T-QP / YUK-165)**：§1 `question_part` 从 type-only stub → **实现（slice 1）**。模型决策：part 即一行 `question`（`kind='question_part'`），经新增 `question.parent_question_id` + `question.part_index` 链到父题，owner 为 `src/server/questions/parts.ts`。因 part 本身是 question，它走**现有** `fsrs_question` 调度/复习/due 路径不变（`subject_kind='question'`、part 自己的 question id），独立调度由"part 是独立 question 行"自然得出——未新建调度算法。§5 scheduler 半边落地：`SchedulerCapabilityRunner`（`src/core/capability/schedulers/`）+ registry `registerScheduler/resolveScheduler/...` + `fsrs` scheduler capability（声明 `supports_activity_kinds: ['question','question_part']`）+ `validateProfile` 校验 `schedulingHints.default_policy` 解析到已注册 scheduler。**DEFERRED**：parent-level 聚合调度（line 250，仅当观察到碎片化）、part 在 review UI 的呈现（需 design pre-flight）、多 part 源自动拆分（随 T-OC）。详见 `docs/superpowers/plans/2026-05-30-yuk165-question-part-lane.md`。

---

## 决策

框架的核心抽象从 `question` 提升为 `LearningActivity`。`question` 是一种 activity kind，不是唯一的 activity kind。所有新接口使用 `ActivityRef { kind, id }` 而非 `question_id`。

科目特定行为通过 **Capability Registry** 分发：judge、renderer、scheduler 是注册制能力模块，`SubjectProfile` 声明使用哪些能力。框架本身不懂任何科目。

归因分类法完全 profile-driven：每个 SubjectProfile 定义自己的完整错因分类，不存在运行时共享的 universal base enum。

实现节奏遵循 **C tempo, B interfaces**：当前只实现 question adapter，但接口设计预留所有 activity kind。

---

## 背景

Phase 1c 完成了 event-driven core、knowledge mesh、SubjectProfile prompt routing。审计显示：

- **数据模型**层面完全泛化（零 wenyan 耦合列）
- **AI 层**已有 SubjectProfile 抽象（4 个 task profile-aware）
- **前端**近零科目感知（字体、metadata、API 调用硬编码 wenyan）
- **Judge 路由**仅 2/7 实现（exact、keyword），且不感知 SubjectProfile
- **归因模型** 10 类硬编码在 `CauseCategory` enum 和 `AttributionTask` prompt 中
- **Review 调度**完全不感知科目边界

10 个真实使用场景（文言文、数学、物理、化学、英语、编程、读书笔记、日语词汇、技能学习、CPA 备考）暴露了 5 个结构性问题：question-centric 假设、归因不泛化、跨科目调度缺失、评估引擎不够 pluggable、前端科目上下文为零。

---

## 核心概念

### 1. ActivityRef — 统一身份

```typescript
type ActivityKind =
  | 'question'
  | 'question_part'
  | 'record'
  | 'recall_prompt'
  | 'practice_log'
  | 'project_milestone'
  | 'open_inquiry';

interface ActivityRef {
  kind: ActivityKind;
  id: string;
}
```

新模块的函数签名使用 `ActivityRef`，不直接使用 `question_id`。老模块通过 compatibility shim 过渡：`{ activity_ref: { kind: 'question', id }, question_id /* compat */ }`。

### 2. Capability Registry — 能力注册

框架提供扩展点；科目特定行为作为能力模块注册。

```typescript
interface CapabilityManifest {
  id: string;                              // 'semantic', 'steps', 'katex', 'fsrs', 'external_judge'
  kind: 'judge' | 'renderer' | 'scheduler';
  version: string;                         // semver
  inputSchema: string;                     // Zod schema name or inline description
  outputSchema: string;
  costClass: 'local' | 'cheap_llm' | 'expensive_llm' | 'external';
  latencyClass: 'sync' | 'async';
  stability: 'experimental' | 'stable' | 'deprecated';
  replacedBy?: string;
}

interface CapabilityRef {
  id: string;
  version: string;   // exact resolved version
}
```

能力是跨科目共享的：`semantic` judge 服务文言文翻译、英语写作、CPA 案例分析；`katex` renderer 服务数学、物理、化学。每个新能力让所有后续科目更便宜。

### 3. SubjectProfile — 声明式、版本化、纯数据

```typescript
interface SubjectProfile {
  id: string;                              // 'wenyan' | 'math' | 'physics' | ...
  version: string;                         // profile 自身版本
  displayName: string;

  // --- 能力声明 ---
  judgeCapabilities: string[];             // 引用 registry 中的 judge id
  renderConfig: {
    fontFamily: string;                    // 'system' | 'serif-cjk' | 'monospace'
    notation: string | null;               // 'katex' | null
    codeHighlight: string | null;          // 'typescript' | 'python' | null
  };
  schedulingHints: {
    defaultPolicy: string;                 // 'fsrs' | 'cadence' | 'none_evidence_only'
  };

  // --- 归因分类 ---
  causeCategories: Array<{
    id: string;                            // profile-scoped stable id
    label: string;
    description?: string;
    sourcePack?: { id: string; version: string };  // authoring-time provenance only
  }>;

  // --- prompt fragments (现有字段保留) ---
  promptFragments: { ... };
  noteTemplate: { ... };
  grounding: { ... };
  // ...现有字段
}
```

**运行时 profile 必须完全展开**——不依赖动态继承或隐式 base category。Authoring-time 可以使用 materialized packs 避免重复，但产出物是 standalone 的 causeCategories 数组。

Profile validator 在 build/test time 检查：声明的能力是否存在、版本是否解析、cause id 是否唯一稳定。

### 4. JudgeResult — 连续分数 + 语义标注

```typescript
interface JudgeResult {
  score: number;                           // 0-1, required
  scoreMeaning: 'correctness' | 'mastery_estimate' | 'rubric_weighted' | 'external_verdict';
  coarseOutcome: 'correct' | 'partial' | 'incorrect' | 'unsupported';
  confidence: number;                      // 0-1
  capabilityRef: CapabilityRef;
  feedbackMd: string;
  evidenceJson: Record<string, unknown>;
}
```

不同能力的 0.8 分不假设可比较。调度策略自行解释分数（FSRS 映射 score → rating；practice cadence 用趋势；records 可忽略）。

### 5. SchedulingPolicy — FSRS 是一种策略，不是唯一策略

```typescript
interface SchedulingPolicy {
  id: string;
  activityKinds: ActivityKind[];
  computeNext(input: SchedulingInput): SchedulingDecision;
}
```

初始策略：`fsrs_question`（当前行为）、`none_evidence_only`（records 仅作为 proposal 证据，不进 review 队列）。统一调度入口返回 `ActivityQueueItem[]`，首期只包含 question items。

### 6. Correction Event — 一等公民纠错

```typescript
// 新增 KnownEvent：action='correct'
interface CorrectEventPayload {
  correctionKind: 'supersede' | 'retract' | 'mark_wrong' | 'restore';
  replacementEventId?: string;
  reasonMd: string;
  affectedRefs: Array<{ kind: string; id: string }>;
}
```

Event log 保持 append-only 不可变。Projection 查询 correction events 判断有效真相。`RateEvent` 保留为用户反馈记录，不承担语义撤回职责。

### 7. 跨科目归因分析

runtime 不要求共享分类体系。跨科目分析通过显式 mapping table：

```typescript
// 配置数据，非运行时 enum
{ profileId: 'physics', causeId: 'unit_error', mapsTo: [{ axis: 'error_mode', value: 'unit_or_dimension' }] }
{ profileId: 'math', causeId: 'invalid_transformation', mapsTo: [{ axis: 'error_mode', value: 'formal_reasoning' }] }
```

Dashboard 按 axis 聚合，不要求 profile 共享 runtime taxonomy。

---

## 选项

### A. 双循环（question loop + record loop 并行）

独立维护两个循环，AI 在共享 knowledge graph 上发现关联。

**拒绝理由**：
- question loop 永远是「正统」，record loop 永远二等
- 每增加一种 activity 催生新循环（practice loop, project loop...）
- 跨循环调度变成集成问题
- 容易开始，昂贵收场——和「B interfaces」目标矛盾

### B. Unified Activity 无 Registry（所有行为直接 switch-case）

框架直接按 activity_kind 分支处理。

**拒绝理由**：
- 每加一个科目需要在 router 中加 case——特调陷阱
- 能力复用（semantic judge 多科目共享）无法表达
- 版本化和降级策略难以统一

### C. Unified Activity + Capability Registry（**accepted**）

统一 Activity 身份 + 注册制能力分发 + 声明式 profile。

**优点**：
- 框架 subject-neutral
- 每个新能力让所有后续科目更便宜
- Profile 是纯数据，~50 行即可上线新科目
- 与现有 event-driven core、knowledge graph、FSRS 调度自然兼容
- TS 框架 + 外部能力（Python sidecar、OJ、API）通过 capability latencyClass/costClass 接入

---

## 实施路径

### Phase N+1: Registry Foundation

- `ActivityRef` / `ActivityKind` core types
- `CapabilityManifest` / `CapabilityRef` types + registry
- `JudgeResult` v2（score + scoreMeaning + capabilityRef）
- 迁移 existing exact/keyword 进 registry
- SubjectProfile 扩展（version, causeCategories, renderConfig）
- Profile validator（build/test time）
- Subject identity normalization

### Phase N+2: First New Capabilities

- `semantic@1` judge
- `external_judge@1`（manual import）
- `question_part` ActivityKind
- `katex@1` renderer
- Record → proposal evidence
- Correction event（minimal）
- 剩余 AI task 的 SubjectProfile 覆盖

### Phase N+3: Scaling

- `steps` judge
- Cross-subject scheduling v1
- `symbolic` judge（如需要，Python sidecar）

---

## 触发重新评估

- 如果 profile 数量超过 10 个且 ~80% 的 capability 声明相同 → 考虑 profile 模板机制
- 如果 capability 版本升级频繁导致 golden fixture 维护负担 > 编写能力本身 → 简化版本策略
- 如果跨科目 mapping table 膨胀且无人维护 → 重新考虑 universal base + extension 模型
- 如果 question_part FSRS 独立调度导致碎片化复习体验 → 考虑 parent-level 聚合调度

---

## 演化关系

- **承接** ADR-0006 v2：event 是统一 action log，`ActivityRef` 取代 `subject_kind='question'` 硬编码
- **承接** ADR-0008：`learning_session.type` 已是多态的，`ActivityKind` 扩展这个思路到 material 层
- **承接** ADR-0012：mastery 从 event stream 派生，ActivityRef 让 event 涵盖更多 activity kind
- **扩展** SubjectProfile（Phase 2A/B/C）：从 prompt-only 抽象扩展到 judge + render + schedule + attribution 全能力声明
