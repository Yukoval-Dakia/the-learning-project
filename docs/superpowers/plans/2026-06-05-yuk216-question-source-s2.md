# YUK-216 题源扩展（Strategy D · S2）— Implementation Plan

- **状态**：planner 初稿（2026-06-05），对 fresh main HEAD `9f349949` 现场勘察 + §8 待实证项落地
- **Binding 输入**：
  - 设计定稿 `docs/superpowers/specs/2026-06-05-question-source-expansion-design.md`（owner 五轮批准）
  - SDK 对齐审计 `docs/audit/2026-06-05-agent-sdk-alignment.md`（矩阵 #1 迁移地图 / #2 #12 spike 与本 plan 关系）
  - 前置 spike `YUK-217`（`Options.skills` 在隔离 `CLAUDE_CONFIG_DIR` 下可用性 —— 只卡 slice 4）
- **S1 可复用先例**：make-paper / `ingestion_paper` 第四 paper 源；route-resolve leaf（`IMAGE_CONSUMING_JUDGE_ROUTES`）；`unsupported_judge` 加性标志（枚举不动、payload 加性扩展）
- **纪律**：反过度工程；evidence 留痕；零 migration（spec 已定）；测试分区规则；外网/UI 不碰（spec §7）
- **关联 Linear**：YUK-216（本体）· YUK-217（前置 spike）· YUK-199（强化对象 QuizGen）· YUK-214（S1 前序）

---

## 0. §8 待实证项落地（现场勘察结论）

三项 spec 标「plan 时仍待实证」的开放点，已对 fresh main 逐一勘察并钉死落点。**这三项是 slice 排程的地基，先于切片展开。**

### 实证 1 — tier 1 推导落点：ingestion session 引用的具体键名

**结论：键名 = `question.metadata.ingestion_session_id`（顶层，非嵌套）。**

- **写入侧**：`app/api/ingestion/[id]/import/route.ts:400-408` 构造 `questionMetadata` 顶层对象，含 `ingestion_session_id: sessionId` + `source_document_id` + `question_block_id` + 两个 legacy `prompt_image_*`。`question.source` 列同时写 `sessionEntrypoint`（route.ts:416）—— 即 spec §2 所述「`source=session.entrypoint`，裸枚举判断会混层」的实证：`source` 值是 `vision_paper` / `vision_single` 等 entrypoint，**不带 tier 语义**。
- **反查侧（已落地先例）**：make-paper `src/server/ingestion/make-paper.ts:230,250` 已用 `${question.metadata}->>'ingestion_session_id' = ${sessionId}` 做反查 —— **S1 刚验证过这个键名是可靠反查锚**。
- **裁决**：`deriveSourceTier` 的 tier 1 判据 = `metadata.ingestion_session_id` 存在且非空（provenance 优先，不靠裸 `source`）。
- **混层防御反例的真实写路径取证（Cross-统合修订 R1）**：原 plan 断言「手动错题 `source='manual'` 的 metadata 无 ingestion_session_id」**缺 file:line 且前提不准**。实证：**`question` 表根本没有 `source='manual'` 的写路径** —— `'manual'` 是 `mistake`/`learning_item`/`record` 表的 source 枚举（`app/api/mistakes/route.ts:115,146`、`learning-items/route.ts:161`、`solve.ts:397` 写的都不是 question 表）。`question` 表的真实写入者：`auto-enroll.ts:332`（ingestion，metadata **有** `ingestion_session_id`）、`embedded_check_generate.ts:237-258`（`source:'embedded'`，metadata **无** `ingestion_session_id`，只有 `source_ref`）、`quiz_gen.ts:375`、`variant_gen`、`materialize-ask-check.ts:70`。**混层防御的真实反例锚 = `embedded_check_generate.ts:237-258`**（非 ingestion 来源题入 question 表、metadata 无 ingestion 键 → deriveSourceTier 正确落 tier 4 而非 tier 1）。2.5 测试矩阵的混层防御 fixture 应取自此真实形状（`{source:'embedded', metadata:{source_document_id?, ...无 ingestion_session_id}}`），而非纯手构 `{source:'manual', metadata:{}}`。
- **note**：`source_document_id` 也在 metadata 顶层（auto-enroll/embedded 都有）。tier 1 推导**只需** `ingestion_session_id` 一个键（最小判据，embedded 题虽有 `source_document_id` 但无 `ingestion_session_id` → 不误判 tier 1），provenance 链展示（§6 deferred 到 UI wave）可三键齐用。

### 实证 2 — SourcingTask 抽取形状对 `StructuredQuestion` 的复用度

**结论：低复用 / 不直接复用 `StructuredQuestion`；高复用 `QuizGenQuestion`。**

- `StructuredQuestion`（`src/core/schema/structured_question.ts:118-147`）是**OCR 抽取证据树**：递归 stem/sub/standalone、bbox、`extraction_evidence`（handwriting / tencent_grading）、`page_index`、`FigureRef`。这些字段是「从图片/扫描件抽题」的产物，**SourcingTask（从网页文本抽现成题）没有 bbox / 手写 / 页码语义** —— 强行复用会拖入一堆 `undefined` 可选字段，是错误的抽象借用。
- `QuizGenQuestion`（`src/core/schema/quiz_gen.ts:85-105`）才是对的形状：`kind / prompt_md / reference_md / choices_md? / judge_kind_override? / rubric_json? / difficulty / knowledge_ids / source_refs`。SourcingTask 抽的是「一道现成题的题面+答案+选项+知识点」，与 QuizGen 输出的「一道生成题」结构**同构**，差异仅在 provenance（sourced 来自 URL 抓取，generated 来自搜索片段+原创）。
- **裁决**：SourcingTask 的 LLM 输出 schema = **新建 `SourcedQuestion`（仿 `QuizGenQuestion` 裁剪 + 加 sourcing-specific provenance 字段）**，落在 `src/core/schema/` 下新文件（如 `sourcing.ts`），**不复用 `StructuredQuestion`**。题入库走 `question` 表（与 quiz_gen 同表同列），`source='web_sourced'`，provenance 走 `metadata.web_sourced`（§2.1 合约）。`judge_kind_override` 约束沿用 `QuizGenQuestion` 同款（只允许 `exact|keyword|semantic`，理由同 quiz_gen.ts:90-97 注释 —— 防 unsupported judge 进池）。

### 实证 3 — few-shot 检索的实现位：SQL 直查 vs 既有检索原语

**结论：SQL 直查既有 jsonb 包含原语，无新检索系统。**

- 先例就在 `src/server/review/due-list.ts:208-225`：`WHERE knowledge_ids @> ${JSON.stringify([knowledgeId])}::jsonb AND (draft_status IS NULL OR draft_status <> 'draft') ORDER BY ... LIMIT 20`。这正是 spec §5 轨 2「filter = subject + kind + tier + `draft_status='active'`，排序 = tier → 知识点重叠数（jsonb 包含查询，§5 点名 `due-list.ts:215` 同款先例）→ 最近，LIMIT 2-4」需要的全部原语。
- **裁决**：few-shot 检索器 = **一个纯 SQL 函数**（新文件如 `src/server/quiz/fewshot-retrieve.ts`），用 `knowledge_ids @> jsonb` + `draft_status='active'` filter + tier 派生排序 + LIMIT。**不引入向量检索 / 不新建索引 / 不动 schema**。tier 排序在 SQL 层无法直接表达（tier 是 `deriveSourceTier` 推导函数），故 SQL 拉候选集（按 subject+kind+knowledge 重叠 + active）后在 TS 层 `deriveSourceTier` 排序取 top N —— 候选集 LIMIT 放宽（如 20）保证 tier 排序有料可选，最终 slice 2-4。

### 实证旁证 — 验证门泛化 + solve-check 选型（slice 1 设计输入）

- **验证门泛化形态**：`quiz_verify.ts` + `variant_verify.ts` 是**双先例**（claim → idempotency event guard → run task → parse → 单 txn persist + writeEvent + catch-bottom）。tier 2/3/4 验证门**复用这个骨架**，不新建框架抽象 —— 泛化 = 「按 tier 选检查项集合」的配置层，物理结构沿用 quiz_verify。
- **solve-check capability 选型（反过度工程裁决）**：**复用既有 `SolutionGenerateTask`（registry.ts:592）作 solver**，不新建 task。该 task 已是「text-only 单次结构化调用，输入 bare question → 输出 reference_solution + final_answer + answer_equivalents」（YUK-193），正是 solve-check 需要的「独立 solver 真解一遍题」能力，task/prompt 维度与出题不同（满足 spec §4 solve-check「与出题不同 capability」的 prompt 维度）。solve-check = 调 `SolutionGenerateTask` 得 solver 答案 → 与题带 `reference_md`/`answers` 比对（语义比对可走既有 `SemanticJudge` 或简单 normalize 比对，slice 1 定）。**若**比对需语义判断（开放题），复用 `SemanticJudgeTask`；选择题/精确答案用 normalize 字符串比对。**不新建 solve task。**
  - **⚠ model 维度待 owner（Cross-统合修订 R2，升 OWNER-FORK OF-4）**：实证 `SolutionGenerateTask.defaultModel='mimo-v2.5-pro'`（registry.ts:597）与 `QuizGenTask.defaultModel='mimo-v2.5-pro'`（registry.ts:613）**同一 model**。若 owner 的「不同 capability」意图含 **model 多样性**（避免同模型同盲点 —— 出题错的题 solver 也解错 → solve-check 假阳性放行），则复用 `SolutionGenerateTask` 部分削弱 solve-check 有效性（spec §4「对内容质量最硬的自动手段」根基）。「不同 capability」仅指 task/prompt 维度 vs 含 model 异源，**不静默自决** → 并入 OF-4 由 owner 裁。default（owner 不回时）：先用同 model（task/prompt 已异），solver model 异源作为后续可调旋钮（per-tier `override` 已支持换 model，零结构改动）。

---

## 1. 切片排程与依赖图

spec §6.2 五切片 + YUK-217 spike。依赖图（spike 与 slice 1 可并行是关键裁决）：

```
                   ┌─────────────────────────────────────────┐
   YUK-217 spike   │  slice 1 地基（provenance 合约 + tier    │
   (Options.skills │  + 验证门泛化 + solve-check + enum 扩容） │  ← 纯后端，不依赖 spike
   在隔离 config   │                                          │
   下可用性)       └──────────────┬───────────────────────────┘
        │                         │
        │ 只卡 slice 4            ├──────────────┬──────────────┐
        │ 不卡 1/2/3/5            ▼              ▼              ▼
        │                  slice 2          slice 3        slice 5
        │                  在线检索线        素材生成线      消费端
        │                  (SourcingTask)   (material_      (tier 偏好 +
        │                  依赖①合约+门      grounded)       读模型扩宽)
        │                                   依赖①           依赖①(tier 推导)
        ▼                                                   §3.2 次序需 2/3 落地
   ┌─────────────────────────────────────┐                 才完整,但接线面独立
   │  slice 4 规范双轨                    │
   │  (profile section + Agent Skill 目录 │
   │   + runner 接线三处 + few-shot +     │  ← spike 绿后才动 runner 接线
   │   验证门接 skill)                    │
   └─────────────────────────────────────┘
```

**执行序裁决：**

| 序 | 项 | 并行度 | 依赖 |
|---|---|---|---|
| 并行起跑 | **slice 1** + **YUK-217 spike** | 二者无共享文件，**同时开** | slice 1 无依赖；spike 独立 |
| 1 绿后 | **slice 2** / **slice 3** / **slice 5(接线面)** | 三者依赖 slice 1 合约，相互独立可并行 | slice 1 |
| spike 绿 + 1 绿后 | **slice 4** | runner 接线需 spike 结论；few-shot 需 slice 1 tier | YUK-217 + slice 1 |
| 全部后 | **slice 5(§3.2 次序完整接线)** | 次序的 step 2/3 需 SourcingTask/material 存在 | slice 1/2/3 |

**关键并行度**：spike 与 slice 1 物理隔离（spike 动 runner.ts 试验 + 一个临时 pass-through skill；slice 1 动 `src/core/schema/` + `src/server/quiz|boss/`），**第一波两条同时跑**。slice 4 是唯一被 spike 卡的切片 —— 若 spike 判定 `Options.skills` 在隔离 config dir 下不可用，slice 4 的 runner 接线方案需改（见 §5 风险 R1），但 slice 1/2/3/5 已可独立交付价值（tier + 检索线 + 素材线 + 消费偏好），**S2 不因 spike 失败而整体阻塞**。

### PR 策略裁决：**独立 PR，非 chain**

- 每切片 = 独立 Linear issue（spec §6.2 已定「每片独立绿，各自 Linear issue」）+ **独立 PR 直接对 main**。
- 理由：(a) slice 1 是纯加性地基（新 enum 值 + 新函数 + 新合约），无破坏性，可独立 merge 并立即被后续 slice 依赖；(b) slice 2/3/5 相互独立，chain 会人为串行化本可并行的工作；(c) 项目既有协议（memory `project_yuk203_domain_model_drive`）= gate + 独立 review + rebase-merge（禁 merge-commit），逐 PR 走更干净。
- **唯一例外**：slice 5 的「§3.2 次序完整接线」依赖 slice 2/3 已 merge。故 slice 5 拆两段：**5a 读模型扩宽 + tier 偏好接线**（依赖 slice 1，可早做）；**5b 四线次序编排**（依赖 1/2/3 全 merge）。5a/5b 可同 PR（若 2/3 已 merge）或 5b 单独跟进 PR。
- 每 PR 标题含 `YUK-216`（或子 issue 号），commit message `Closes <子issue>`（触发 Linear attach），repeat keyword 不用 shorthand。

---

## 2. Slice 1 — 地基（字段级展开）

**范围**：纯后端。`deriveSourceTier` + provenance metadata Zod 合约（§2.1 四条）+ enum 扩容 + 验证门框架泛化（含 solve-check）+ tests。**provenance 合约是核心交付**，钉死后 2/3/5 才不糊。
**分区**：core schema / 纯函数 → **unit**；验证门 handler（碰 DB/event）→ **db**。

### 2.1 文件级步骤

| # | 文件 | 创建/修改 | 内容 |
|---|---|---|---|
| 1.1 | `src/core/schema/business.ts:30` | 修改 | `QuestionSource` enum 加 `'web_sourced'`（Zod-enum 加值，零 DDL —— 与 `quiz_gen` 加值同手法，line 41 注释先例） |
| 1.2 | `src/core/schema/quiz_gen.ts:44` | 修改 | `QuizGenGenerationMethod` enum 加 `'material_grounded'`（代码合约改动非 DDL） |
| 1.3 | `src/core/schema/provenance.ts` | **创建** | 四条 provenance Zod 合约（见 2.2 字段级） + `deriveSourceTier(question)` 签名与实现（见 2.3） |
| 1.4 | `src/core/schema/provenance.test.ts` | **创建** | unit：四合约 parse 正反例 + `deriveSourceTier` 四 tier 判定矩阵（含混层防御：非 ingestion 来源题 metadata 无 `ingestion_session_id` → 不落 tier 1，fixture 取 `embedded` 真实形状，见 §0 实证 1 / R1） |
| 1.5 | `src/core/schema/quiz_gen.ts` | 修改 | `QuizGenMetadata` 加可选 `material_source_document_id?: string`（§2.1 第二条，material_grounded 才填）；加可选 `source_ref_kind` 语义（见 2.2 第四条落点裁决） |
| 1.6 | `src/server/quiz/verify-framework.ts` | **创建** | tier→检查项集合的配置层 + solve-check 实现（见 2.4）；**不新建 handler 框架**，导出供 slice 2/3 的 verify handler 复用的 check 函数 |
| 1.7 | `src/server/quiz/verify-framework.test.ts` | **创建** | unit（mock runTaskFn）：solve-check pass/fail + 各 tier 检查项集合选择正确 |
| 1.8 | `scripts/audit-schema-allowlist.json` | **预期不改（已定论，N1）** | `audit:schema` 仅扫顶层 business 列的 write path，metadata jsonb 内键不在扫描面；新来源走 jsonb metadata + enum 加值（不新增列）→ **不触 audit:schema**（allowlist 现有条目全是顶层列如 `question.judge_route_override`，无 jsonb 内键先例佐证）。enum 加值与 `quiz_gen`/`unsupported_judge` 先例同手法（已绿）。slice 1 仍跑 `pnpm audit:schema` 兜底确认；若意外报漂移再按 `resolves_when` 登记 |

### 2.2 §2.1 四条 provenance 合约的 Zod 形状

落 `src/core/schema/provenance.ts`：

```ts
// 合约一：web_sourced（tier 2）
export const WebSourcedProvenance = z.object({
  url: z.string().url(),
  title: z.string().min(1),
  fetched_at: z.string().min(1),          // ISO 字符串（与 quiz_gen source_pack.searched_at 同款 string）
  whitelist_match: z.boolean(),           // 是否命中 profile 源白名单（§5 cold-start 用）
  extraction_hash: z.string().optional(), // 抽取内容指纹（去重/审计旁证）
});
// 落点：question.metadata.web_sourced

// 合约二：material_grounded（tier 3）—— 复用 quiz_gen metadata 命名空间
//   §2.1 明确「question 表无 source_document_id 列」→ 素材引用走 metadata
//   落点：question.metadata.quiz_gen.material_source_document_id（见 1.5，加进 QuizGenMetadata）

// 合约三：source_ref 消歧（所有新来源通用）
export const SourceRefKind = z.enum([
  'trigger_ptr',    // quiz_gen 现状：source_ref 是触发对象指针（quiz_gen.ts:375 附近）
  'url',            // sourced：source_ref = 抓取 URL
  'ingestion_session', // 反查锚（tier 1，与 metadata.ingestion_session_id 一致）
  'source_document',
]);
// 落点：每个新来源写 source_ref 时同写 metadata.*.source_ref_kind（避免语义多义）

// 合约四：tier 推导依据（authentic 必须有 ingestion provenance）
//   不是独立 Zod 合约，而是 deriveSourceTier 的判据（见 2.3）
```

**裁决（合约三落点）**：`source_ref_kind` 不进顶层 `question` 列（零 migration），写进对应来源的 metadata 命名空间内（sourced → `metadata.web_sourced` 旁加，或独立 `metadata.source_ref_kind`）。slice 1 定一处统一落点，避免每来源各写各的。**推荐 `metadata.source_ref_kind`（顶层），单一真相，与 `source_ref` 列对齐。**

### 2.3 `deriveSourceTier` 函数签名与落点

```ts
// src/core/schema/provenance.ts
export type SourceTier = 1 | 2 | 3 | 4;
export type SourceTierName = 'authentic' | 'sourced' | 'material' | 'generated';

// 输入是 question 行的最小子集（不绑 Drizzle row 类型，便于 unit 测 + 跨调用点复用）
export interface SourceTierInput {
  source: string;                          // question.source 列
  metadata: Record<string, unknown> | null; // question.metadata jsonb
}

export function deriveSourceTier(q: SourceTierInput): { tier: SourceTier; name: SourceTierName };
```

**判定顺序（provenance 优先，spec §2 表）：**
1. `metadata.ingestion_session_id` 存在且非空字符串 → **tier 1 authentic**（不看 `source`，混层防御核心）
2. `source === 'web_sourced'` 且 `metadata.web_sourced` 通过 `WebSourcedProvenance` parse → **tier 2 sourced**
3. `source === 'quiz_gen'` 且 `metadata.quiz_gen.generation_method === 'material_grounded'` 且有 `material_source_document_id` → **tier 3 material**
4. 其余（`quiz_gen` search_grounded/closed_book、`variant_gen`）→ **tier 4 generated**

**落点**：纯函数在 `core/schema/`（无 IO，cross-subject，符合 layering）。消费点 import：slice 5 读模型扩宽（review-plan-tools / context-readers）、验证门强度选择（verify-framework）、组卷偏好（slice 5b）。

### 2.4 验证门框架泛化的模块边界（QuizVerify 改造面 vs 新建面）

| 面 | 裁决 | 理由 |
|---|---|---|
| **新建** `src/server/quiz/verify-framework.ts` | tier→检查项集合映射 + 可插拔 check 函数（结构完整性 / solve-check / 源一致性 / 素材 grounding / 题型规范 / 去重）| spec §4「可插拔 checker」+ 反过度工程：导出函数供各 verify handler 调，不是继承式框架 |
| **保持不动** `quiz_verify.ts` handler 物理结构 | tier 4 现状（grounding/copy_safety/knowledge-hit 三检）**不退化**；slice 4 再加「题型规范符合」+ solve-check | slice 1 只建框架 + solve-check，不重写已绿的 tier 4 流程（避免回归既有 §2 验证逻辑） |
| **新建** slice 2/3 各自 verify handler | 仿 `variant_verify.ts`/`quiz_verify.ts` 骨架，调 verify-framework 的 check 集合 | 双先例，不抽象提取公共 handler 基类（YAGNI，第二个消费方=slice 2 出现时才知道哪些真共用） |
| **solve-check** | `src/server/quiz/verify-framework.ts` 内 `runSolveCheck(question, runTaskFn)`：调 `SolutionGenerateTask` 得 solver 答案 → 比对 question 答案 | 复用既有 task，不新建（实证旁证裁决） |

### 2.5 测试矩阵

| 测试 | 分区 | 断言 |
|---|---|---|
| `provenance.test.ts` | unit | 四合约 parse 正反例；`deriveSourceTier` 四 tier 全覆盖 + 混层防御 fixture **取自真实写路径形状**（`embedded_check_generate.ts:237-258` 的 `source:'embedded'` + metadata 无 `ingestion_session_id` → tier 4，非 tier 1；非纯手构 `{source:'manual',metadata:{}}`，R1）|
| `verify-framework.test.ts` | unit | solve-check：solver 答案=题答案→pass，不符→fail；tier→检查项集合映射正确 |
| `business.test.ts` / `quiz_gen.test.ts` | unit | 新 enum 值被接受（既有 schema 测扩展） |

### 2.6 验收线

- `deriveSourceTier` 四 tier 全绿 + 混层防御测试通过。
- 四条 provenance 合约 parse 正反例全绿。
- solve-check 在 mock solver 下 pass/fail 路径全绿。
- `pnpm audit:schema`/`audit:partition`/`audit:profile` 绿（enum 加值不引漂移；如引则按 allowlist 流程登记并记 `resolves_when`）。
- `pnpm test:unit` + 相关 `pnpm test:db`（若 verify handler 触 DB）绿。

---

## 3. Slice 2 — 在线检索线（SourcingTask → tier 2）

**范围**：纯后端。唯一全新件 SourcingTask（输入「学科+考点/题型+数量」→ 按 profile 源白名单检索 → 抽取结构化题 → 自动落库 draft + `source='web_sourced'` → 链式 enqueue 验证）。依赖 slice 1 合约 + 验证门。
**分区**：core schema(SourcedQuestion) → unit；handler + 落库 + enqueue → db。

### 文件级步骤

| # | 文件 | 创建/修改 | 内容 |
|---|---|---|---|
| 2.1 | `src/core/schema/sourcing.ts` | 创建 | `SourcedQuestion`（仿 `QuizGenQuestion` 裁剪 + `WebSourcedProvenance`）+ `SourcingTaskOutput`（questions[] + per-question url provenance）。**不复用 `StructuredQuestion`**（实证 2） |
| 2.2 | `src/core/schema/sourcing.test.ts` | 创建(unit) | output schema 正反例；judge_kind_override 约束（只 exact/keyword/semantic）|
| 2.3 | `src/ai/registry.ts` | 修改 | 加 `SourcingTask` 定义（tool-calling agent，仿 `QuizGenTask` budget/provider；allowedTools=[] handler 注入 Tavily）|
| 2.4 | `src/ai/task-prompts.ts` | 修改 | `buildSourcingPrompt(profile)` —— 任务描述骨架（角色=找现成题、输出 SourcedQuestion 契约、白名单约束）；领域内容 slice 4 迁 skill（本片先 minimal 留代码）|
| 2.5 | `src/server/boss/handlers/sourcing.ts` | 创建 | handler：resolve trigger → mount Tavily+domain MCP（**仿 `quiz_gen.ts:275-295` MCP-mount 段** —— `buildMcpServer` + Tavily cfg + `allowedTools` 构造；注：`quiz_gen.ts:271` 注释本身是「copy chat.ts:298-306」，sourcing 仿的是 quiz_gen 的 mount 段，R3）→ run SourcingTask → parse → 落库 `question`（source='web_sourced' + `metadata.web_sourced` + `source_ref`=URL + `source_ref_kind='url'` + `draft_status='draft'`）→ enqueue tier-2 verify |
| 2.6 | `src/server/boss/handlers/sourcing.test.ts` | 创建(db) | 落库形状 + provenance 合约写入 + verify enqueue 链；白名单外源处理（spec §5 cold-start：只引用不入库 或 降权 —— **见 OWNER-FORK**） |
| 2.7 | `src/server/boss/handlers/source_verify.ts` | 创建 | tier-2 verify handler（仿 quiz_verify 骨架，调 verify-framework 的 tier-2 检查集：结构完整性+solve-check+源一致性+去重）|
| 2.8 | `src/server/boss/handlers/source_verify.test.ts` | 创建(db) | verify 各检查项 + Option-B gate（pass→active+FSRS enroll；fail→留 draft）|
| 2.9 | `src/server/boss/handlers.ts` | 修改 | 在 `registerHandlers`（`handlers.ts:42`）内注册 `sourcing` / `source_verify` queue：每队 `await boss.createQueue('<q>')` + `await boss.work('<q>', …, build<Q>Handler(db))` 双行，**参照 `handlers.ts:213-214`（quiz_gen）/ `:225-226`（quiz_verify）先例**。注：`scripts/worker.ts:34` 只调 `registerHandlers(boss, db)`，**不含 per-queue 注册**，真实接线点是 `handlers.ts`（R3）|

**测试矩阵**：schema → unit；handler 落库/enqueue/verify → db。
**验收线**：SourcingTask mock 输出 → 落库 tier-2 draft（provenance 合约齐）→ verify 过门 promote / 不过门留 draft；`deriveSourceTier` 对落库行返回 tier 2；audit 全绿。

---

## 4. Slice 3 — 素材生成线（material_grounded → tier 3）

**范围**：纯后端。QuizGen 扩展 `generation_method='material_grounded'`：先检索真实素材（阅读原文/真实数据）→ 素材持久化入既有 `source_document` 表（带 URL provenance）→ 出题强制引用素材 → 验证门额外校验「题确实考这份素材」。阅读题真原文判据由此兑现。依赖 slice 1。
**分区**：素材持久化 + handler → db；schema/纯函数 → unit。

### 文件级步骤

| # | 文件 | 创建/修改 | 内容 |
|---|---|---|---|
| 3.1 | `src/server/boss/handlers/quiz_gen.ts` | 修改 | 加 `material_grounded` 路径：检索素材 → INSERT `source_document`（URL provenance）→ 出题引用 → 落 `metadata.quiz_gen.material_source_document_id` + `generation_method='material_grounded'` |
| 3.2 | `src/core/schema/quiz_gen.ts` | 修改 | `QuizGenOutput` superRefine 扩展：`material_grounded` 时强制 `material_source_document_id` 存在（已在 1.5 加字段，此处加校验）|
| 3.3 | `src/server/boss/handlers/quiz_verify.ts` | 修改 | tier-3 分支：额外「素材 grounding」检查（题确实考素材）+ solve-check + 题型规范（题型规范走 slice 4 skill；本片先 solve-check + 素材 grounding）|
| 3.4 | `source_document` 写入登记 | 修改(若需) | 新写入者按 spec §7.2「step9 invariant 白名单流程登记」；确认 audit:schema 是否需 allowlist 条目 |
| 3.5 | 对应 `.test.ts` | 创建/修改(db) | 素材持久化 + material_source_document_id 落库 + tier-3 verify grounding 检查；`deriveSourceTier`→tier 3 |

**测试矩阵**：schema superRefine → unit；素材持久化 + tier-3 verify → db。
**验收线**：material_grounded run → 素材入 `source_document` + 题带 `material_source_document_id` → `deriveSourceTier`→tier 3 → tier-3 verify 校验素材 grounding；阅读题原文可追。audit 全绿。

---

## 5. Slice 4 — 规范双轨（字段级展开）

**范围**：后端 + profile + skill 文件。profile 瘦 section（白名单/次序/题型 key 表，无注册表）+ 标准 Agent Skill 目录（`src/subjects/<id>/skills/quiz-gen-<kind>/`）+ runner 接线三处 + few-shot 检索器 + 验证门接 skill + AF spec §1.3 加注 doc rider。
**前置**：YUK-217 spike 绿（`Options.skills` 在隔离 `CLAUDE_CONFIG_DIR` 下可用）。
**分区**：profile schema + few-shot 纯 SQL 函数 → unit（few-shot 触 DB 则 db）；runner 接线 → 需 AI task，测法见下。

### 5.1 SKILL.md 目录 / frontmatter 草案（spec §5 雏形）

目录结构（每题型一个 skill）：

```
src/subjects/<id>/skills/quiz-gen-<kind>/
  SKILL.md              # frontmatter: name==目录名, description（做什么/何时用）
  references/
    rubric.md           # 评分细则（验证门「题型规范符合」+ judge 细则共用 —— §8 展望「judge 判分细则 skill」顺手对齐）
    anti-patterns.md     # 坏题反例
  assets/
    few-shot.json        # 精选范例（L3 按需，不命中不烧 token）
```

SKILL.md frontmatter 草案：

```markdown
---
name: quiz-gen-reading_comprehension
description: 出「阅读理解」题型的规范包 —— 题型结构、答案格式、坏题反例。当为某学科生成 reading_comprehension 题时加载。
---

# 阅读理解出题规范

（成段规范内容：题型结构要求、passage 与 sub_questions 关系、答案格式约定…）

## 引用资源
- references/rubric.md — 评分细则（验证门「题型规范符合」检查 + judge 共用）
- references/anti-patterns.md — 坏题反例
- assets/few-shot.json — 精选范例（轨 2 检索器命中时注入）
```

**裁决（首批做哪几个 subject × kind）**：spec「先强化现有学科 math/physics/wenyan」+ 痛点是「题型不像真题」。**首批最小集 = 痛点最尖锐的 2-3 个 (subject, kind)**：
- `wenyan × translation`（文言翻译 —— 题型规范性强，wenyan 是 Phase 1 主数据集）
- `wenyan × reading_comprehension`（阅读题 —— spec 点名「阅读题直奔素材线」，规范包价值高）
- `math × calculation` 或 `math × proof`（数学题型规范 —— 与 wenyan 验证跨学科泛化）

降级链（spec §5）：`quiz-gen-<kind>` 缺失 → subject 通用 → 无（不阻塞，回退现状 promptFragments）。**首批不求全覆盖**，验证接线 + 降级链工作即可，其余 (subject,kind) 后续纯增目录。

> **SoT 位置标注（Cross-统合修订 R4）**：SKILL.md 的 source-of-truth = `src/subjects/<id>/skills/`，**两种 spike 结论一致**（结论 A 直接 SoT，结论 B SoT 不变但 runner 启动需 copy/symlink 进隔离 dir）。**接线机制 + 是否需 runner copy 步骤待 YUK-217 spike 二选一**（见 §5.2「(b) spike 结论分叉」）；结论 B 的 runner copy/symlink 步骤 + 测试由 slice 4 lane 在 spike 出结论后现场补，不预写。

### 5.2 runner 三处接线的具体 diff 面

| 接线 | 文件:行 | 现状 | 改造 |
|---|---|---|---|
| **(a) buildQueryOptions 透传 skills + 发现目录** | `runner.ts:243-263` `buildQueryOptions` | 返回 Options **不含** `skills` 字段 | 加 `skills: ctx.skills`（从 ctx 透传）+ skill 发现目录设置。**具体机制待 spike 二选一**（结论 A：`settingSources`/`additionalDirectories` 指向 `src/subjects/<id>/skills/`；结论 B：SKILL.md 预置进隔离 config dir + (b) 的 copy 步骤 —— 审计第一候选，见「(b) spike 结论分叉」R4）|
| **(b) 隔离内精确发现 skills 根** | `runner.ts:211-220` `getIsolatedClaudeConfigDir` | mkdtemp 空 tmpdir，SDK skills 当前不可用（审计「不动清单」第 3 条 audit:81 + spike 定义 audit:99，§3 头号技术前置）| 保持隔离前提下让 SDK 能加载 `src/subjects/<id>/skills/`，**不整体取消隔离**（否则泄漏开发机 `~/.claude/`）。**机制待 YUK-217 spike 二选一**（见下「(b) spike 结论分叉」，R4）|
| **(c) quiz_gen handler 键控白名单** | `quiz_gen.ts:275-295`（MCP mount + `allowedTools` 构造同一条缝；`:271` 注释是「copy chat.ts:298-306」，R3）| 注入 MCP server + allowedTools，**无 skills** | 按 `(subject, kind)` 把 `ctx.skills = ['quiz-gen-<kind>']` 白名单到唯一一个（键控为主，确定性由 key 保证）。与既有 per-handler 注入同构 |

**(b) spike 结论分叉（Cross-统合修订 R4 —— 与审计候选次序对齐）**：审计「不动清单」第 3 条（audit:81）+ spike 任务定义（audit:99）+ 迁移顺序建议（audit:73）的**第一候选是「在隔离 config dir 内预置受控 SKILL.md」**，「确认 SDK 是否支持 skills 路径与 config dir 分离（`additionalDirectories`/`settingSources`）」是**第二候选**。原 plan §5.2(a)/(b) 主推第二候选，与审计首选倒置。两种 spike 结论的分叉后果：

| spike 结论 | §5.1 SKILL.md 物理 SoT | runner 启动序 | §5.1 是否返工 |
|---|---|---|---|
| **A（第二候选成立）** `additionalDirectories`/`settingSources` 能在隔离 config dir 下指向项目内 skills 根 | `src/subjects/<id>/skills/`（§5.1 目录即 SoT，无 copy）| `buildQueryOptions` 加一个目录指向字段 | 不返工 |
| **B（审计第一候选）** 须把 SKILL.md **预置进隔离 config dir** | SoT 仍在 `src/subjects/<id>/skills/`，但 runner 启动时需 **copy/symlink 进隔离 dir**（`getIsolatedClaudeConfigDir` 初始化后多一步）+ 验证隔离未破（不泄漏 `~/.claude/`）| `getIsolatedClaudeConfigDir` 后新增「填充 skills 子目录」步骤 + 其测试 | 目录 SoT 不变，但 slice 4 字段级步骤需补一行 runner copy/symlink + 测试 |

故 spike 不止卡 runner 接线机制，**也卡 SKILL.md 物理组织与 runner 启动序**（§5.1 据此标注，见 5.1 末注）。

> **SPIKE 修正注记（YUK-217 spike 已结，2026-06-05；slice 4 实施据此落地）**：spike 实证裁定走**结论 B（审计第一候选）**，并对本 §5.2 原推方案做两条颠覆性勘误（实证报告 `.omc/research/2026-06-05-yuk217-spike-report.md` §3）：
> 1. **发现机制 = `$CLAUDE_CONFIG_DIR/skills/` 预置**，**不是** `additionalDirectories`/`settingSources` 指向项目 skills 根（结论 A 不成立）。`additionalDirectories` 只放宽文件读权限，非 skills 发现根。
> 2. **`settingSources` 必须 OMITTED，不可传 `[]`** —— 传 `[]`（SDK isolation mode）会连带禁用 `CONFIG_DIR/skills/` auto-load，预置的 skill 不被发现（CLEAN-PRESEED 案 L1/L2 双 NO 实证）。
>
> 据此 slice 4 的 runner 接线最终形态（与原 §5.2 表「结论 B」行一致、(a)/(b) 措辞按上勘误）：`getIsolatedClaudeConfigDir()` mkdtemp 后**一次性把全部 `src/subjects/*/skills/` copy 进 `<isolatedDir>/skills/`**（进程级单例兼容，`populateIsolatedSkills`）；`buildQueryOptions` 仅在 `ctx.skills` 非空时透传 `skills`，`settingSources` 保持不传；quiz_gen / quiz_verify handler 按 (subject, kind) 键控 `skills` 白名单 + 降级链（无 skill 目录 → 不传 → promptFragments 现状）。隔离 caveat（plugin marketplace skills 在开发机本地泄漏，生产 NAS 容器无 `~/.claude/plugins/` 故无暴露面）记录于 spike 报告 §4，不阻塞 slice 4。

**RunTaskCtx 改造**：`buildQueryOptions` 签名读 `ctx.skills`，故 `RunTaskCtx` 类型加 `skills?: string[]`（runner.ts ctx 类型定义处）。

### 5.3 其余文件级步骤

| # | 文件 | 创建/修改 | 内容 |
|---|---|---|---|
| 4.x | `src/subjects/profile-schema.ts` | 修改 | 加瘦 section：`sourceWhitelist: z.array(z.string())`（SourcingTask 过滤）+ `sourcingRoutePreference`（per-题型找题次序偏好 §3.2）+ 题型 key 表（已有 `questionKinds`，复用）。**不建 skill 注册表**（spec §5 第五轮定稿）|
| 4.x | `src/subjects/{wenyan,math,physics}/profile.ts` | 修改 | 填首批 `sourceWhitelist` 域名（**见 OWNER-FORK**）+ 路由偏好 |
| 4.x | `src/server/quiz/fewshot-retrieve.ts` | 创建 | 纯 SQL 检索器（实证 3）：`knowledge_ids @> jsonb` + `draft_status='active'` filter，候选集 LIMIT 20 → TS 层 `deriveSourceTier` 排序（tier→重叠→最近）取 top 2-4 |
| 4.x | `src/server/quiz/fewshot-retrieve.test.ts` | 创建(db) | 检索 filter + tier 优先排序 + 0 命中降级 |
| 4.x | quiz_gen/quiz_verify handler | 修改 | 出题注入 few-shot block；验证门加载同一 skill 做「题型规范符合」检查（出题/验题对齐同一份）|
| 4.x | `specs/2026-06-04-agent-framework-design.md` §1.3 | 修改(doc rider) | 加注：出题规范 skill 与交互 skill 是同一 SKILL.md 生态两消费端；`src/server/copilot/skills/` 是同名陷阱（实证含 `solve-skill.ts`/`solve-skill.test.ts` 纯 TS service，非 SDK SKILL.md）。**加一句命名约定（N2）**：`src/subjects/<id>/skills/`（新，SDK SKILL.md 目录）vs `src/server/copilot/skills/`（旧，TS service）命名空间冲突 —— 给约定（如后者加 README 标注「TS service，非 SDK skill 根」或后续 rename），避免后续 agent 二次踩坑 |

### 5.4 审计 §3 迁移地图 P0 项纳入裁决

审计 §3 P0 = `AttributionTask` / `Note*` / `Quiz*`。

**裁决：本 slice 只做 `Quiz*`（QuizGen/QuizVerify 的出题规范段），`Attribution*` / `Note*` 留后续 wave。**

- 理由：(a) YUK-216 痛点是「题型不像真题」，**直接对象是出题规范**（Quiz*），不是错因分类（Attribution）或笔记模板（Note）；(b) 审计 §5 明确「§3 迁移地图作为 YUK-216 拆 slice 的 task 清单输入」但**不要求全迁** —— spec §7 不做清单 + 反过度工程要求最小切口；(c) runner 接线「一次建成」后（本 slice 交付），Attribution/Note 迁移是**纯增目录 + handler 键控**，无 runner 改造，适合独立 issue 跟进（spec §8 展望已列「judge 细则 skill 在 YUK-216 内顺手；教学法/note 风格等信号」）。
- **本 slice 内顺手项**：spec §8 展望「judge 判分细则 skill 与出题 skill 共用 `references/rubric.md`」标「YUK-216 内顺手」—— 故 `quiz-gen-<kind>/references/rubric.md` 的设计**同时供 solve-check 题型规范检查 + 未来 judge 细则**，一份三方对齐（出题/solve-check/判分）。但 judge 接 skill 的 handler 改造**不在本 slice**（judge 链是 R1-R7 红线密集区，审计 §4-4 要求红线留代码侧，单独 issue 谨慎处理）。
- **后续 wave issue（建议新开，链 YUK-216）**：`AttributionTask` prompt→skill 迁移（审计点名「最纯领域知识、示范性最强」）；`Note*` 三 task 共享模板迁移。

### 5.5 测试矩阵 + 验收线

| 测试 | 分区 | 断言 |
|---|---|---|
| profile-schema 扩展 | unit | 新 section parse；`audit:profile` 绿 |
| `fewshot-retrieve.test.ts` | db | filter + tier 排序 + 0 命中降级 |
| runner 接线 | **手动 AI 冒烟 + 集成**（mimo 第三方 endpoint，`tsc`/biome/vitest bypass 实际调用 —— 审计 §4-7）| `Options.skills` 透传 → `SDKSystemMessage.skills` 可观测（spike 已验证机制，本 slice 验证真 task 加载）|

**验收线**：spike 绿 → runner 透传 skills → 一个 (subject,kind) 的 SKILL.md 被加载（`SDKSystemMessage.skills` 留痕可见）→ 出题注入 few-shot + 验证门用同一 skill；降级链工作；`pnpm build`（catch Next route export + 生产校验）绿。**runner 接线必须跑一次真实 AI task 冒烟**（不能只靠 vitest）。

---

## 6. Slice 5 — 消费端（tier 偏好 + 读模型扩宽）

**范围**：纯后端。组卷/召回按 tier 偏好选题（§3.2 次序）+ 读模型扩宽（`ReviewCandidateSchema` / `get_review_due` 输出加 source/tier）。
**拆分**：**5a**（读模型扩宽 + tier 偏好接线，依赖 slice 1）+ **5b**（四线次序完整编排，依赖 1/2/3 全 merge）。
**分区**：schema → unit；读模型 SQL + 组卷接线 → db。

> **Cross-统合修订（B1，BLOCKER）**：原 5a 把「读模型扩宽」当成「输出 schema 加可选字段」的轻改，**穿透深度严重不足**。实证 `due-list.ts:213-214`（raw SQL）+ `due-list.ts:323-327`（drizzle builder `legacyQuestionStateRows`）的 candidate SELECT **只投影** `id, prompt_md, reference_md, knowledge_ids, created_at` —— **不取 `source`，不取 `metadata`**。而 `deriveSourceTier(SourceTierInput{source, metadata})` 两个输入都要这两列。`ReviewCandidateSchema`/`GetReviewDueOutputSchema` 的 rows 都从 `due.rows`（即 `ScheduledDueRow`）map 出，料不在 `due.rows` 里则 tier 派生悬空。**5a 必须穿透到 `due-list.ts` 核心 SELECT 拓宽投影**——且 `due-list.ts` 是 review 调度热路径（FSRS 投影、Gate-B draft filter `:280` `notDraftQuiz`），改它有回归面，测试矩阵必须补 due-list 回归断言「既有 reason / round-robin / Gate-B 路径不退化」。

### 文件级步骤

| # | 段 | 文件 | 内容 |
|---|---|---|---|
| 5a.0 | **读模型穿透（B1 新增，前置）** | `src/server/review/due-list.ts` | **拓宽 candidate SELECT 投影**：(i) raw SQL `pickQuestionForKnowledge` `:213-214` 的 `SELECT id, prompt_md, ...` 加 `source, metadata`；其 row 类型 `:206-211/:222-228` + 返回对象 `:233-239` 同步加 `source`/`metadata`。(ii) drizzle builder `legacyQuestionStateRows` `:318-338` 的 `.select({...})` 加 `source: question.source, metadata: question.metadata`，push 对象 `:343-353` 同步带上。`ScheduledDueRow` 类型加 `source?`/`metadata?`。**不动 WHERE / ORDER / Gate-B filter**（纯加投影列，零行为变更）|
| 5a.1 | 读模型 | `src/server/ai/tools/review-plan-tools.ts:275` `ReviewCandidateSchema` | 加 `source?: string` + `tier?: number`；tier 由 `deriveSourceTier({source, metadata})` 派生（料来自 5a.0 拓宽后的 `due.rows`）|
| 5a.2 | 读模型 | `src/server/ai/tools/context-readers.ts:690` `GetReviewDueOutputSchema` | rows 加 `source`/`tier` 字段；映射点用 5a.0 拓宽后的 `source`+`metadata` 调 `deriveSourceTier` 派生 tier（**不在此处另起 SELECT** —— 料已由 due-list 投影上来）|
| 5a.3 | 偏好 | 组卷/召回选题点 | tier 偏好排序（高 tier 优先），接 §3.2 第 1 步「先查已入库，优先高 tier」|
| 5b.1 | 次序编排 | **见下「§6.1 5b 同步/异步边界裁决」** | §3.2 四步统一入口的落点 + 同步/异步分界（B2 重写）|
| 5.x | tests | 对应 `.test.ts` | **due-list 回归（db）**：拓宽投影后既有 reason / round-robin / Gate-B draft filter 不退化（断言现有测试全绿 + 新增「tier 1 ingestion 题 source/metadata 投影正确」）；读模型字段(unit/db) + tier 偏好排序(db) + 次序编排(db) |

### 6.1 5b 同步/异步边界裁决（B2，BLOCKER）

> **Cross-统合修订（B2，BLOCKER）**：原 5b.1 文件列「缺题找题次序统一入口」，但**该入口在代码里不存在**（实证：`review_plan` ReviewPlanTask 缺题时只 **声明 `needs[]`** —— `ReviewPlanNeedSchema:426` + `question_generation` literal `:433`，硬约束明写「不做任何 question CRUD」；`select_review_question_candidates` 只查 due 队列；`quiz_gen` 触发是独立 handler；三者各走各的，无统一入口）。原 plan 既没指认新建/改建，也没处理「§3.2 第 2/3 步是异步 pg-boss 入库 job，不能在一次同步组卷调用里等它入库再选」的本质矛盾。这是 plan 里粒度最粗、与 slice 1-4 字段级断层的黑洞，必须补齐才能进实施。

**(a) 入口落点 = 新建 `src/server/quiz/sourcing-sequence.ts`**（不改 `review_plan` needs[] 路径 —— ReviewPlanTask 的「只声明不执行」语义是其 systemPrompt 硬约束 + write-tool 边界设计级约束，`review-plan-tools.ts` 明写「不做任何 question CRUD、唯一写是 write_review_plan」，不破坏）。该模块是「知识点 X 缺题」时的统一编排函数，被组卷/弱点专项/补题场景调用。

**(b) 同步/异步分界（核心修法）**：§3.2 四步**不在一次调用内串完**，而是「同步快路径 + 异步 enqueue + needs[] 标记」：

| 步 | §3.2 | 同步 / 异步 | 落点 |
|---|---|---|---|
| 1 | 先查已入库（高 tier 优先）| **同步** | `sourcing-sequence.ts` 直接查 `question` 表（复用 5a.0 拓宽投影 + `deriveSourceTier` 排序）→ 命中即返回，组卷可即时用 |
| 2 | 外部检索 SourcingTask | **异步 enqueue** | step 1 不足 → `boss.send('sourcing', …)`（slice 2 队列）+ 在编排结果标记一条 need（复用 `question_generation` 先例形状，扩 `kind` 或加 `source` 字段，slice 5b 定）|
| 3 | 素材生成 material_grounded | **异步 enqueue** | 同上 → `boss.send('quiz_gen', {generation_method:'material_grounded', …})`（slice 3 路径）+ 标记 need |
| 4 | 闭卷兜底 closed_book / variant | **异步 enqueue** | 同上 → `boss.send('quiz_gen', {…})` / variant_gen + 标记 need |

- **关键**：同步调用只能兑现 step 1（即时返回已入库高 tier 题）；step 2/3/4 是「触发后台生产 + 标记缺口」，**下一轮组卷**才看到新入库题（与 §3.2「题库是用出来的，次序天然有记忆性」一致）。
- **per-题型偏好**：读 profile `sourcingRoutePreference`（slice 4 加）决定 step 2/3/4 的 enqueue 优先级（如阅读题直奔 step 3）。
- **need 形状**：复用 `ReviewPlanNeedSchema` 的 `question_generation` 先例（`review-plan-tools.ts:426-433`），不新建并行机制；若需区分四线来源（sourcing vs material vs closed_book）则在该 schema 加性扩 `source?` 判别字段（**枚举不动、payload 加性** —— S1 `unsupported_judge` 先例同手法）。

**(c) 字段级步骤（5b）**：

| # | 文件 | 创建/修改 | 内容 |
|---|---|---|---|
| 5b.1 | `src/server/quiz/sourcing-sequence.ts` | 创建 | 统一编排函数：step 1 同步查库（高 tier 优先）→ 不足则按 profile 偏好 `boss.send` step 2/3/4 + 返回 needs[]。**不阻塞等待异步入库** |
| 5b.2 | `src/server/quiz/sourcing-sequence.test.ts` | 创建(db) | step 1 命中即返回（不 enqueue）；step 1 不足 → 按偏好 enqueue 正确队列 + needs[] 标记；偏好 routing（阅读题→step 3） |
| 5b.3 | `review-plan-tools.ts`(若接入) | 修改(可选) | 缺题场景若由 review_plan 触发，则其 `needs[]` 消费侧（非 ReviewPlanTask 本身）调 `sourcing-sequence`——保持 ReviewPlanTask「只声明」语义不破 |

**裁决（5a/5b 是否同 PR）**：5a（含 5a.0 due-list 穿透）依赖 slice 1，可早做并独立 PR。5b 依赖 slice 2/3 已 merge（step 2/3 的队列/路径需存在）→ 单独跟进 PR。**5a.0 due-list 穿透不可与 5b 合并延后** —— 它是读模型基础，5a 自身价值（tier 徽章数据层）即靠它。
**验收线**：`get_review_due` / `ReviewCandidateSchema` 输出带 tier（料来自 due-list 拓宽投影）；due-list 既有路径回归全绿；组卷优先高 tier；§3.2 次序在缺题场景 step 1 同步返回 + step 2/3/4 异步触发 + needs[] 标记（5b）。**不做统计面板**（spec §6.1 边界，deferred UI wave）。audit 全绿。

---

## 7. 风险与回滚

| # | 风险 | 缓解 | 回滚 |
|---|---|---|---|
| R1 | **YUK-217 spike 判定 `Options.skills` 在隔离 config dir 下不可用** | spike 与 slice 1 并行，失败只卡 slice 4；slice 1/2/3/5 独立交付。spike 探多方案：settingSources / additionalDirectories / 预置 SKILL.md 进隔离 config dir | slice 4 改方案（如不走 SDK skills，退回 promptFragments 成段内容 —— 但这违背 owner 哲学，spike 失败需 surface 给 owner）|
| R2 | **solve-check 误杀**（solver 弱解不出合法真题→fail 拒候选）| spec §4 缓解：拒题留 draft + 拒因 event 可人工捞回；per-tier 阈值可调。slice 1 solve-check 设保守阈值 | 调阈值 / 跳过 solve-check（feature flag 式）|
| R3 | **mimo endpoint 不保证 SDK skills 协议**（审计 §4-5/4-7）| slice 4 runner 接线**必须**跑真实 AI 冒烟（非 vitest）；spike 在 mimo 真 endpoint 上验证 | skills 加载失败 → 降级链回 promptFragments（不阻塞出题）|
| R4 | **enum 加值引 audit:schema 漂移** | metadata 是 jsonb，audit:schema 不扫 jsonb 内键；enum 加值与 quiz_gen 先例同（已绿）。slice 1 跑 audit 确认 | 按 allowlist 流程登记 `resolves_when` |
| R5 | **source_document 新写入者触 invariant 白名单**（spec §7.2 step9）| slice 3 素材持久化按既有登记流程；确认 audit | 登记白名单 + 注明解除条件 |
| R6 | **SourcingTask 入库未验证内容污染池** | Q5 拍板「人不挡入库，验证门裁决」：落 draft 即入但 `draft_status='draft'` 不进池，verify 过门才 active。draft 永不被组卷选中（due-list `draft_status<>'draft'` filter 先例）| draft 留库可删；verify gate 是池准入唯一门 |
| R7 | **零 migration 被破坏** | 全程 jsonb metadata + enum 加值；任何想加列的冲动 → 停，走 metadata。slice 全程 `pnpm test:migration` 不应有新 DDL | 任何 migration 出现即 plan 偏离，回 spec §7.2 |

---

## 8. OWNER-FORK 清单（需 owner 输入的产品级分叉）

| # | 分叉点 | 待 owner 决定 | 卡哪个 slice | 默认（owner 不回时）|
|---|---|---|---|---|
| **OF-1** | **源白名单首批域名** | profile `sourceWhitelist` 填哪些可信域名（首批 per subject）。spec §8「owner 初期需在 profile 填首批可信域名」明确是 cold-start 必需 owner 输入 | slice 4（profile 填值）+ slice 2（SourcingTask 用白名单过滤）| 留空数组 + SourcingTask 对空白名单**只引用不入库**（最保守，不污染）；owner 后补域名即生效 |
| **OF-2** | **白名单外源处理策略** | spec §5「SourcingTask 对白名单外源只引用不入库（或降权），plan 阶段定」—— 二选一：(a) 只引用不入库 / (b) 入库但降权标记 | slice 2（handler 逻辑分支）| **(a) 只引用不入库**（保守优先，符合 Q3「分层验证门」+ R6 不污染池）；owner 若要 (b) 降权需定降权语义 |
| **OF-3** | **首批 (subject × kind) skill 范围确认** | §5.1 建议 wenyan×translation / wenyan×reading_comprehension / math×calculation\|proof —— owner 确认或调整首批清单 | slice 4 | 按 §5.1 建议三个起步；降级链保证未覆盖 kind 不报错 |
| **OF-4** | **solve-check 比对严格度（开放题）+ solver model 是否需与 generator 异源** | (i) 开放题 solver 答案 vs 题答案的「对不上」判据 —— 字符比对 / 语义判断 / per-tier 阈值（涉误杀容忍度 R2）。(ii) **【R2 并入】** solve-check 的「不同 capability」是否含 model 异源 —— solver 现复用 `SolutionGenerateTask`（`mimo-v2.5-pro`）与 `QuizGenTask` 同 model，同模型同盲点可能假阳性放行错题。是否要求 solver model 与 generator 异源？是产品取舍 | slice 1（solve-check 实现）| (i) 选择题/精确答案=normalize 比对；开放题=SemanticJudge + 保守阈值（宁可漏过不误杀真题）。(ii) 先同 model（task/prompt 已异）；solver model 异源作后续可调旋钮（`override` 换 model 零结构改动）。owner 可调 |

**非 OWNER-FORK（planner 已自决，记录备查）**：SourcingTask 输出形状不复用 StructuredQuestion（实证 2）；few-shot 走 SQL 直查（实证 3）；solve-check 复用 SolutionGenerateTask 不新建 task（反过度工程）；验证门泛化复用 quiz_verify 骨架不建基类（YAGNI）；PR 独立非 chain（gate+独立review 协议）；审计 P0 仅做 Quiz*，Attribution/Note 后续 wave（最小切口）。

---

## 9. SDK 审计 #2/#12 与本 plan 的关系（显式定位）

spec/审计要求显式定位矩阵 #2（outputFormat spike）/#12（SDK 升级）与本 plan 的关系：

| 矩阵项 | 与本 plan 关系 | 裁决 |
|---|---|---|
| **#1 prompt→SKILL.md** | **纳入** —— slice 4 是其载体（审计 §5「并入 YUK-216 轨 1」）；本 plan 只做 Quiz* 子集，Attribution/Note 后续 wave | 纳入（slice 4，部分）|
| **#2 outputFormat json_schema spike** | **排除** —— 独立 spike issue（审计 §5 建议 #2），mimo 是否支持 `json_schema` 未验证，与题源扩展正交。本 plan 各 task 继续用既有 parse+Zod（quiz_verify.ts:76 `indexOf('{')` 先例）| 排除（独立 issue，不阻塞 YUK-216）|
| **#12 SDK 0.3.143→0.3.165 升级** | **排除** —— 审计 §5 明确「单独落 issue，不阻塞 YUK-216」。本 plan 用的 `Options.skills`（sdk.d.ts:1721）已在 0.3.143 内，无需升级即可做 slice 4 | 排除（独立 chore issue）。**冒烟拆开不合并（Cross-统合修订 N3）**：slice 4 先在 **0.3.143** 上验 skills 接线绿；#12 升级冒烟单独跑。合并跑会让两个独立变量（SDK 版本 bump + skills 接线）耦合在一次冒烟，失败难归因 |
| **YUK-217 spike** | **纳入为前置** —— 审计 §5 建议 #1 即 YUK-217，只卡 slice 4，与 slice 1 并行 | 纳入（前置，并行 slice 1）|

---

## 10. Linear 落单建议

- **YUK-216**（本体）：保留为 S2 epic / 父，挂五切片子 issue。
- **子 issue（建议建，各对一切片）**：S2-slice1 地基 / S2-slice2 检索线 / S2-slice3 素材线 / S2-slice4 规范双轨 / S2-slice5 消费端。每个 6-section 模板。
- **YUK-217**：前置 spike，已存在，链 slice 4。
- **后续 wave issue（建议新开，链 YUK-216）**：`AttributionTask` prompt→skill 迁移；`Note*` 模板迁移；judge 链接 skill（红线谨慎，独立）。
- **独立 chore（审计建议，不阻塞）**：#2 outputFormat spike；#12 SDK 升级。
- **本 plan 自身**：planning 任务，无新增代码 follow-up 未登记 —— 切片即 follow-up，由上述子 issue 承载。

---

## 11. Cross-统合修订记录（2026-06-05）

Cross-统合 agent（有否决权）对 planner 初稿 + plan-critic 对抗评审逐条裁决。critic 报告 2 BLOCKER + 4 REVISE + 3 NIT，**全部 ACCEPT**（无 REJECT），其中 R1/R2 在落实时基于二次实证做了**更精确的修正**。所有 critic 锚点经独立 file:line 复验（B1 due-list SELECT 投影面、B2 §3.2 入口不存在、R1 manual 写路径、R3 worker 注册点 + quiz_gen 注释、R4 审计候选次序）。

| # | 类 | 裁决 | 落实位置 | 复验证据 |
|---|---|---|---|---|
| **B1** | BLOCKER | **ACCEPT** | §6 加 5a.0 due-list 穿透步骤 + due-list 回归测试 + B1 修订框 | `due-list.ts:213-214`（raw SQL）+ `:323-327`（builder）实证只投影 `id,prompt_md,reference_md,knowledge_ids,created_at`，无 `source`/`metadata`；`ScheduledDueRow` 定义在 `:169` |
| **B2** | BLOCKER | **ACCEPT** | §6.1 新建小节：入口=新建 `sourcing-sequence.ts` + 同步/异步分界表 + 5b 字段级步骤 | §3.2 统一入口实证**不存在**；`ReviewPlanNeedSchema:426` + `question_generation:433` 是现成「声明 needs[] 不同步串完」先例 |
| **R1** | REVISE | **ACCEPT（修正前提）** | §0 实证 1 + 1.4 + 2.5 测试矩阵 | critic 前提「manual 题入 question 表」**不准** —— question 表无 `source='manual'` 写路径（manual 是 mistake/learning_item/record 表的源）。真实混层反例锚 = `embedded_check_generate.ts:237-258`（`source:'embedded'`，metadata 无 `ingestion_session_id`），比 critic 建议更精确 |
| **R2** | REVISE | **ACCEPT（升 OWNER-FORK）** | §0 solve-check 裁决加 model 维度警示 + 并入 OF-4(ii) | `SolutionGenerateTask`(`:597`) 与 `QuizGenTask`(`:613`) 同 `defaultModel='mimo-v2.5-pro'`；solver model 是否需异源是产品取舍，不静默自决 |
| **R3** | REVISE | **ACCEPT** | step 2.9（worker.ts→`handlers.ts:42`）+ step 2.5/§5.2(c)（`:271-314`→`:275-295`）| worker.ts 不含 per-queue 注册（只调 `registerHandlers`）；真实注册点 `handlers.ts:213-214/225-226`。`quiz_gen.ts:271` 注释实为「copy chat.ts:298-306」 |
| **R4** | REVISE | **ACCEPT** | §5.2 加「(b) spike 结论分叉」表 + §5.1 SoT 标注 + (a)/(b) 措辞改 | 审计第一候选是「预置进隔离 config dir」(audit:73/81/99)，plan 原主推第二候选(`additionalDirectories`)，倒置；spike 也卡 SKILL.md 物理组织 |
| **N1** | NIT | **ACCEPT** | step 1.8 去悬置，直接定论 | audit:schema 仅扫顶层 business 列，jsonb 内键不在扫描面；enum 加值不触漂移（可确认，无需「确认后定」）|
| **N2** | NIT | **ACCEPT** | §5.3 doc-rider 加命名约定 | `src/server/copilot/skills/` 实证含 `solve-skill.ts` 纯 TS service；与新 `src/subjects/<id>/skills/` 命名空间冲突，需约定 |
| **N3** | NIT | **ACCEPT** | §9 #12 行：冒烟拆开不合并 | slice 4 skills 接线（0.3.143）与 #12 SDK 升级是两个独立变量，合并冒烟失败难归因 |

**全局一致性核验（Cross-统合职责）**：
- **S1 先例交互**：`ingestion_paper`（intent_source enum `index.ts:145/152`）、`unsupported_judge`（`event/known.ts:50` 加性 optional 标志）、make-paper 反查锚（`make-paper.ts:177` advisory lock + metadata `->>'ingestion_session_id'`）全部健在；plan 复用的「枚举不动、payload 加性」手法（B2 needs[] 扩 `source?`、tier 1 反查键）与 S1 一致，无冲突。
- **ADR 一致性**：ADR-0026（workflow-judge confidence gate + flag-gated auto-enroll）+ ADR-0028（knowledge-level FSRS scheduling）均落在 due-list/FSRS 调度热路径 —— **B1 的 5a.0 due-list 投影拓宽碰的正是这两条 ADR 的路径**，故 B1 修订强制 due-list 回归测试（断言 FSRS 投影 / Gate-B filter / round-robin 不退化），与 ADR 约束对齐。`deriveSourceTier` 不影响调度（spec §7 第 3 条「tier 只影响选哪题，不影响何时复习」），无 ADR-0028 语义冲突。
- **measure 措辞精度修正（Cross-统合自检）**：§6.1(a) 原写「ReviewPlanTask 只声明是 ADR 级约束」夸大 —— 实为 systemPrompt 硬约束 + write-tool 边界设计级约束（无具名 ADR），已改正避免误导后续 agent 找不存在的 ADR。
- **audit:schema allowlist**：本 plan 全程 jsonb metadata + enum 加值，不新增列 → 不触 audit:schema（N1 定论）；slice 3 `source_document` 新写入者按 spec §7.2 step9 invariant 白名单流程登记（plan step 3.4 已列）。
- **YUK-211/212/221**：均无 status.md / 代码硬引用与本 plan 范围交叉（题源扩展不碰这些 issue 的面）；无需在本 plan 处理。

**OWNER-FORK 清单（Cross-统合不擅自拍板，原样上呈 + R2 并入）**：见 §8。共 **4 项**：OF-1 源白名单首批域名（卡 slice 2/4）/ OF-2 白名单外源策略（卡 slice 2）/ OF-3 首批 (subject×kind) skill 范围（卡 slice 4）/ **OF-4 solve-check 比对严格度 + solver model 异源（卡 slice 1，R2 已并入第 (ii) 问）**。

**裁决：SHIP（修订后）**。B1+B2 已补齐字段级穿透 + 同步/异步边界；R1-R4 已落实（R1/R2 带二次实证修正）；N1-N3 已定稿；全局一致性无冲突。slice 1-4 可放行实施，slice 5（含 5a.0 due-list 穿透 + 5b 异步边界）按修订后落点执行。OWNER-FORK 4 项需主 session 走 Linear 捕获门时一并上呈 owner。

## §12 OWNER 拍板记录（2026-06-05 深夜，开工授权）

| Fork | 拍板 | 备注 |
|---|---|---|
| **OF-1** 白名单首批域名 | **委托 agent 调研提名**（「你自己找一些」） | agent 按学科调研可信题源站点 → 候选清单入 slice 4 PR 供 owner review；调研期间 slice 2 按空白名单逻辑开发不阻塞 |
| **OF-2** 白名单外源 | **(b) 入库但降权** | 降权语义（agent 技术定义，记录于此）：复用 §2.1 既有 `metadata.web_sourced.whitelist_match=false` 字段；同 tier 2 内组卷/召回排序后置于 `whitelist_match=true`；验证门**不减强度**（solve-check 等全门照过——降权只影响选题优先级，不降质量门槛） |
| **OF-3** 首批 skill | **按建议三个**：wenyan×translation / wenyan×reading_comprehension / math×calculation\|proof | 降级链兜底未覆盖题型 |
| **OF-4** solve-check | **默认组合**：精确题 normalize 比对；开放题 SemanticJudge 保守阈值（宁漏过不误杀）；solver 先同 model（task/prompt 已异源），model 异源留作 per-tier override 旋钮 | R2 警示已记录，旋钮零结构改动 |

**实施自此开工**：第一波 = slice 1 + YUK-217 spike 并行（§1 依赖图）。
