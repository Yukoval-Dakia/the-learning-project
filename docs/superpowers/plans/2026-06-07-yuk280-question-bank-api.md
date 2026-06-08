# YUK-280 — P4 题库 backend API（文件级实施计划）

> 规划者（只读）产出。Refs YUK-280 / YUK-203。
> 代码基线：worktree `yuk-280-question-bank-api` @ `28fc615d`（= origin/main，2026-06-07）。
> Re-map 报告：`.omc/research/yuk203-remap-2026-06-07.md`（R-P4-1~6 → 本计划 A1a~A1e）。
> 纯 backend（零 UI）。auth 走既有 `middleware.ts`（`x-internal-token`），无新鉴权面。测试进 db 分区。

---

## 0. 勘察确认（复用锚点 + 红线核对，已逐个核实）

| 主题 | 结论（带证据） |
|------|----------------|
| **route 落地点** | `app/api/questions/` 已存在（`quiz-gen/`、`[id]/{solve,timeline}/`），但**无 `route.ts`、无 `[id]/route.ts`**。本计划新建这两个 + server reader module。greenfield 确认（C2）。 |
| **`question` 表轴列** | `src/db/schema.ts:151-199`：`knowledge_ids jsonb[]`、`source text`、`kind text`、`difficulty integer`(CHECK 1-5)、`visual_complexity text`(nullable)、`draft_status text`(nullable)、变式血缘 `variant_depth`/`root_question_id`/`parent_variant_id`、`metadata jsonb`、`created_at`。**无 `source_tier` 列**（D-P4-1 红线已确认）。 |
| **draft 排除惯例** | `src/server/quiz/sourcing-sequence.ts:116` + `due-list` 现行写法：`(question.draft_status IS NULL OR question.draft_status <> 'draft')`。**沿用此惯例**（不是 `<> 'draft'` 单边——nullable 列必须带 IS NULL 分支）。 |
| **`deriveSourceTier` / `compareBySourceTierThenWhitelist`** | 实际在 **`src/core/schema/provenance.ts:129 / :188`**（SPEC 写的 `src/server/.../provenance.ts` 是误指；`src/server/ai/provenance.ts` 是另一个无关文件）。`deriveSourceTier(q: {source, metadata})→{tier:1|2|3|4, name}`；comparator 入参 `{tier:number|null, whitelistMatch:boolean|null}`。 |
| **whitelist_match 读法** | `sourcing-sequence.ts:70-76` `readWhitelistMatch(metadata)` —— 读 `metadata.web_sourced.whitelist_match`，非 web_sourced 行返回 null。内存排序需复刻这一小段（comparator 本身复用，不重实现排序语义）。 |
| **内存 derive 量级假设** | `sourcing-sequence.ts:98-103` 已立先例并注释：单节点活跃题池「tens, not millions」。本计划列表跨节点，但单用户题库百-千级（SPEC 给定），**先 SQL 轴收窄候选集 + cap 上限**再内存 derive，注释写明假设。 |
| **聚合 reader 模式** | `loadNotePage`（`src/server/artifacts/note-page.ts`）/ `loadKnowledgeNodePage`（`src/server/knowledge/node-page.ts`）：单 module 把多读路径聚到一个 server call，route 仅 `Response.json(page)` + 404，返回 null→404。**A1d 照搬此结构**。 |
| **`masteryDecayBucket`** | `src/server/knowledge/node-page.ts:378` `export function masteryDecayBucket(evidenceCount, lastEvidenceAt, now?)`。A1e 复用，**聚合 question 的 knowledge_ids 节点 bucket，不给 question 单建 bucket**（R-P4-5 红线）。 |
| **FSRS/mastery 现状读** | FSRS 知识级：`material_fsrs_state(subject_kind='knowledge', subject_id=knowledge_id)`（`schema.ts:666-683`）；mastery：`knowledge_mastery` view（`schema.ts:805`，keyed by `knowledge_id`）。题级 FSRS/mastery = **聚合该题 knowledge_ids 的知识级状态**（与 §7 per-knowledge 决策一致），unlabeled legacy 题可 fallback 读 `material_fsrs_state(subject_kind='question', subject_id=question_id)`。 |
| **事件时间线** | `getQuestionTimeline(db, questionId, limit)`（`src/server/events/queries.ts:584`）：返回 attempt+review 链（含 judge cause hydrate、active-row 过滤）。A1d **复用此函数**，不重写。 |
| **题级 backlink 数据源** | 生成的 embedded_check 与 tool_quiz 都把 question 引用存进 **`artifact.tool_state.question_ids`**（embedded_check_generate.ts:276-277 建独立 `tool_kind='embedded_check'` artifact；make-paper.ts:77 / paper / quiz_gen 建 `type='tool_quiz'`）。统一查询 = `artifact.tool_state->'question_ids' @> [id]`（jsonb 容器查询），按 `tool_kind` / `intent_source` 区分来源。inline check 经 body_blocks 引 embedded_check artifact，仍归并到同一 artifact backlink。 |
| **list route 分页惯例** | `app/api/learning-items/route.ts:18-22`：`limit` 解析 `Number.parseInt` + `Math.min(Math.max(x,1),200)` clamp；zod `safeParse` 校验 filter；`errorResponse(err)` 包裹。**A1a 照此**，offset/cursor 取 offset（owner 量级足够）。 |
| **route 读 db + auth** | `app/api/notes/[id]/route.ts`：`import { db } from '@/db/client'`、`export const runtime='nodejs'`、zod params、`ApiError`/`errorResponse`。auth 由 `middleware.ts:33-43` 上游强制（`x-internal-token`），handler 不重做。 |
| **DB-test helper** | `tests/helpers/db.ts`（`resetDb`）、`tests/helpers/request.ts` `buildAuthedRequest(url, init, token='test-token')`。route 测试若 mock 不掉 db/r2/ai → 进 **db 分区**（`*.test.ts` fall-through，不改 `vitest.shared.ts`）。 |

**红线复核（全部已编码进下方设计）**：
1. A1b **禁** SQL `WHERE`/`ORDER BY source_tier`——纯内存 `deriveSourceTier` + comparator。
2. 纯 backend，零 UI 文件。
3. 不触 `runner.ts` / `budgets.ts` / `vitest.shared.ts` / copilot/chat（与 #347/#348 零冲突）。
4. auth 无新面；测试 db 分区 fall-through。
5. decay 不给 question 单建 bucket → 聚合 knowledge 节点 bucket。

---

## 1. 文件总览（创建 vs 修改）

| 文件 | C/M | 归属 slice |
|------|-----|-----------|
| `src/server/questions/list.ts` | **创建** | A1a/A1b/A1c |
| `src/server/questions/list.test.ts` (db) | **创建** | A1a/A1b/A1c |
| `app/api/questions/route.ts` | **创建** | A1a/A1b/A1c |
| `app/api/questions/route.test.ts` (db) | **创建** | A1a/A1b/A1c |
| `src/server/questions/detail.ts` | **创建** | A1d/A1e |
| `src/server/questions/detail.test.ts` (db) | **创建** | A1d/A1e |
| `app/api/questions/[id]/route.ts` | **创建** | A1d/A1e |
| `app/api/questions/[id]/route.test.ts` (db) | **创建** | A1d/A1e |

**零修改既有源文件**（复用全部走 import：`deriveSourceTier`/comparator from `@/core/schema/provenance`；`masteryDecayBucket` from `@/server/knowledge/node-page`；`getQuestionTimeline` from `@/server/events/queries`）。

> 注：`masteryDecayBucket` 当前从 `node-page.ts` export。A1e import 它即可，**不移动、不复制**。若 reviewer 认为跨 module import 一个 UI-page reader 的导出不洁，备选是把 `masteryDecayBucket` 抽到 `src/server/knowledge/decay.ts`（纯函数，零依赖）——但那会**修改 node-page.ts**（改 import），与「零修改」目标冲突，故**默认直接 import，抽取留作 reviewer 触发的可选项**，不在本计划预先做。

---

## 2. 子 slice 详细设计

### A1a 基础列表 + SQL 轴 — `src/server/questions/list.ts` + `app/api/questions/route.ts`

**server reader：`listQuestions(db, params)`**

```
ListQuestionsParams {
  knowledgeIds?: string[];        // 任一匹配 → OR of `knowledge_ids @> [id]`（复用 sourcing-sequence:114 容器写法）
  source?: string;                // eq(question.source, x)
  kind?: string;                  // eq(question.kind, x)（canonical 持久形；不做 kindsMatch 归一——列表是精确轴）
  difficulty?: number;            // eq；1-5
  visualComplexity?: string;      // eq（nullable 列：传值才过滤）
  includeDrafts?: boolean;        // 默认 false → draft 排除惯例
  limit: number;                  // clamp 1..200
  offset: number;                 // >=0
  // A1b/A1c 字段见各 slice
}
ListQuestionsResult {
  items: QuestionListItem[];      // {id, kind, prompt_md(截断? 见下), source, source_tier{tier,name}, difficulty,
                                  //  visual_complexity, knowledge_ids, root_question_id, variant_depth, draft_status,
                                  //  created_at_sec}  ← unix 秒，非 ISO（见下「时间戳契约」）
  total: number;                  // count(*)::int over 同 WHERE（不含 limit/offset）—— 分页需要
  computed_at_sec: number;        // Math.floor(Date.now()/1000)
}
```

**时间戳契约（critic 核实，2026-06-07）**：既有 list route（`learning-items/route.ts:91-93`、`mistakes/route.ts`）统一用 **unix 秒**（`Math.floor(getTime()/1000)`），且同资源族 `app/api/questions/[id]/timeline/route.ts:46/65` 也是 `*_sec`。本 list route 全部时间字段用 unix 秒 + `_sec` 后缀，**不用 ISO**，与全仓 API 时间形对齐。

**响应信封（critic 核实，2026-06-07）**：既有 list route house-style 是 `{ rows }`（knowledge/mistakes/learning-items 全是）；**无任何现存 list route 返回 `total`/`computed_at` 信封**。本计划改用 `{ items, total, computed_at_sec }` 是**有意的分页增强**（offset 分页真需要 total），属可接受的偏离——但实现时 reader 与 route 测试需 assert 这个新信封形，且 `total` 走 `sql<number>\`count(*)::int\``（**必须 `::int` 显式 cast**：postgres-js 裸 `count(*)` 回 bigint→string，不 cast 会让 `total` 变字符串污染 JSON 数字契约）。
```
```

- WHERE 组装：`and(...filters)`，`filters` 按上面各轴 push（mirror learning-items:35-46）。draft：`includeDrafts` 为 false 时 push `sql\`(${question.draft_status} IS NULL OR ${question.draft_status} <> 'draft')\``。
- `knowledgeIds` 多值：`or(...ids.map(id => sql\`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb\`))`（复用 note-page:262 OR-容器写法）。
- ORDER BY：`desc(question.created_at), asc(question.id)`（稳定二级序，mirror sourcing-sequence:119）。**注意**：A1b 介入后排序语义改变（见下），A1a 单独时用 created_at desc。
- `prompt_md`：列表项保留**前 N 字截断**（如 200）避免 payload 膨胀；详情页给全文。注释写明截断阈值与理由。
- `total`：`db.select({count: sql<number>\`count(*)::int\`}).from(question).where(and(...filters))`（同 filters，无 limit；**`::int` cast 必须**，否则 postgres-js 回 bigint→string 污染数字契约——critic 核实）。

**route：`GET /api/questions`**

- query 解析：`url.searchParams.getAll('knowledge_id')`（多值）、`get('source'|'kind'|'difficulty'|'visual_complexity'|'limit'|'offset'|'include_drafts')`。
- zod `ListQuerySchema.safeParse`：`difficulty` coerce int 1-5；`limit`/`offset` coerce + clamp；非法 → `ApiError('validation_error', ..., 400)`。
- `Response.json(result)`；`errorResponse(err)` 包裹；`export const runtime='nodejs'`。

**测试（db 分区，`list.test.ts` + `route.test.ts`）**：
- seed 多题（不同 source/kind/difficulty/visual_complexity/knowledge_ids/draft_status）。
- 断言：单轴过滤命中集、组合轴（knowledge+source+difficulty）交集、draft 默认排除 / `include_drafts=1` 含 draft、`total` 正确、`limit`/`offset` 分页切片、空结果 200+`items:[]`。
- route 测试用 `buildAuthedRequest`，断言 401 无 token（如已有 middleware 测试覆盖则只测 200 路径 + 400 校验）。

---

### A1b grounding 轴 — 同 `list.ts`（内存 derive + 排序），**禁 SQL source_tier**

**核心约束（D-P4-1 红线）**：`source_tier` 派生非列。流程：**先 SQL 轴收窄候选集 → 内存 `deriveSourceTier` → 筛选/排序 → 再 slice 分页**。

`ListQuestionsParams` 增字段：
```
sourceTier?: SourceTier[];        // 1|2|3|4 任一 → 内存 filter（derive 后）
sortBy?: 'created_at' | 'source_tier';  // 默认 created_at desc；'source_tier' → comparator
```

实现：
1. SQL 阶段拉候选：`select({id, kind, prompt_md, source, metadata, knowledge_ids, difficulty, visual_complexity, root_question_id, variant_depth, draft_status, created_at})`（必须投影 `source`+`metadata` 供 derive），WHERE = A1a 全部 SQL 轴，**ORDER BY created_at asc 作稳定基序**（comparator 是稳定二级排序，依赖基序）。
2. **候选集上限护栏**：当 `sourceTier` 或 `sortBy='source_tier'` 介入时，SQL 不能用 limit/offset 截断（会在 derive 前丢高 tier 行——sourcing-sequence:98-103 同款教训）。改为拉**全 WHERE 命中集**，但加一个 `CANDIDATE_CAP`（如 2000，注释写明「单用户题库百-千级，cap 是 OOM 护栏非业务上限；命中即记 warn」）。命中 cap 时 `truncated:true` 标进结果。
3. 内存 derive：每行 `tier = deriveSourceTier({source, metadata}).tier`、`whitelistMatch = readWhitelistMatch(metadata)`（复刻 sourcing-sequence:70-76 那一小段）。
4. filter：`sourceTier` 给定 → 保留 `sourceTier.includes(tier)`。
5. sort：`sortBy==='source_tier'` → `items.sort(compareBySourceTierThenWhitelist)`（高 tier 先 + OF-2 demotion，基序 created_at asc 在等键内保留）；否则保持 created_at（A1a 行为，但注意基序此时是 asc，列表语义若要 newest-first 需在 A1a 非-tier 路径 reverse 或保留 desc 双路径——实现时显式选定，注释写明）。
6. `total` = filter 后长度；分页 = filter+sort 后 `slice(offset, offset+limit)`。
7. `QuestionListItem.source_tier = {tier, name}`（每项都带，derive 一次复用）。

route：query 增 `source_tier`（getAll，coerce 1-4）、`sort_by`（enum 校验）。

**测试**：
- 构造覆盖四 tier 的题：tier1（metadata.ingestion_session_id）、tier2（source=web_sourced + source_ref_kind=url + web_sourced 块，含 whitelist_match true/false）、tier3（quiz_gen + material_grounded + material_source_document_id）、tier4（其余）。
- 断言：`source_tier` 过滤命中正确 tier；`sort_by=source_tier` 顺序 = 1→4 且 tier2 内 whitelist_match=false 排 true 之后（OF-2）；每项 `source_tier.{tier,name}` 正确；**断言无 SQL 报错关于 source_tier 列**（结构性证明走应用层）；cap 截断标志（可用小 cap 注入或跳过，注释说明）。

---

### A1c 变式家族 — 同 `list.ts`（家族聚合 + 展开子查询）

两个能力：

**(1) 家族聚合视图**（列表按 root 聚合）：
- `groupByFamily?: boolean`。为 true 时：候选行按 `root_question_id ?? id` 分组（root 自身 root_question_id 为 null，用自身 id 作 family key）。
- 返回 `families: QuestionFamily[]`：`{root_question_id, root_prompt_md(截断), variant_count, max_variant_depth, member_ids[], representative: QuestionListItem(root 或最浅)}`。
- 实现：SQL 拉候选（同 A1b 投影 + `root_question_id`/`variant_depth`），内存 group by family key，统计 count/maxDepth/members。分页作用在 family 维度（slice families）。
- 与 grounding 叠加：family 的 representative 仍带 `source_tier`。

**(2) 展开某 root 全部变式子查询**：
- `expandRoot?: string`（root question id）。给定时：返回该 root 家族全部成员（`where root_question_id = X OR id = X`），按 `variant_depth asc, created_at asc` 排，每项完整 `QuestionListItem`。
- 这是「展开某 root」专用路径，绕过聚合，直接列家族成员。

route：query 增 `group_by_family`（bool）、`expand_root`（string）。三态互斥优先级：`expand_root` > `group_by_family` > 普通列表（注释 + zod refine 写明：同时给多个时取最高优先并 warn，或 400——实现时定，倾向 400 防歧义）。

**测试**：
- seed root + 2-3 变式（不同 variant_depth）。
- 断言：`group_by_family=1` 返回 families，variant_count/max_variant_depth 正确，representative 是 root；`expand_root=<root_id>` 返回全家族按 depth 排；无变式的孤题 family variant_count=1（仅自身）;非法组合参数 400。

---

### A1d 单题详情 — `src/server/questions/detail.ts` + `app/api/questions/[id]/route.ts`

**server reader：`loadQuestionDetail(db, questionId): Promise<QuestionDetail | null>`**（照搬 `loadNotePage` 结构，null→404）

聚合内容（逐项对 R-P4-4）：
1. **question 行**（全字段，含 `prompt_md` 全文、`reference_md`、`choices_md`、`rubric_json`、`kind`、`difficulty`、`source`、`source_ref`、`visual_complexity`、`metadata`、`figures`/`image_refs`、`variant_depth`/`root_question_id`/`parent_variant_id`、`draft_status`、`created_at`/`updated_at`）。`where eq(question.id, id)`（**不排 draft**——详情页要能看 draft 题；列表才默认排）。无行 → return null。
2. **派生 source_tier**：`deriveSourceTier({source, metadata})` → `{tier, name}`。
3. **知识点 label 解析**：`knowledge_ids` → `select {id,name} from knowledge where id in (...) and archived_at is null`（复用 note-page:127-135 archived-drop 写法）。返回 `labels: {id,name}[]`。
4. **变式家族**：family key = `root_question_id ?? id`；查 `where root_question_id = key OR id = key`，返回 `family: {root_question_id, members: {id, variant_depth, kind, is_self}[], variant_count}`。复用 A1c expand 逻辑（detail.ts 内联一个小 helper，或从 list.ts export 共享——倾向 list.ts export `loadFamilyMembers(db, rootKey)` 给两处复用）。
5. **FSRS/mastery 现状**（聚合 knowledge_ids，与 R-P4-5/§7 一致）：
   - 对每个 knowledge_id 读 `knowledge_mastery` view（mastery/evidence_count/last_evidence_at）+ `material_fsrs_state(subject_kind='knowledge', subject_id=knowledge_id)`（due_at/state）。
   - unlabeled fallback：`knowledge_ids` 为空时读 `material_fsrs_state(subject_kind='question', subject_id=questionId)`（legacy per-question，re-map R-P3-3 确认 unlabeled 仍活跃）。
   - 返回 `scheduling: { per_knowledge: {knowledge_id, name, mastery, evidence_count, last_evidence_at, decay_bucket, due_at}[], legacy_question_fsrs?: {due_at} | null }`。
   - `decay_bucket` = `masteryDecayBucket(evidence_count, last_evidence_at)`（import from node-page；**不给 question 单建 bucket**，逐 knowledge 节点算，详情层只是聚合呈现）。
6. **事件时间线**：`getQuestionTimeline(db, questionId, limit)`（复用，limit 默认 10 / query 可调，clamp 50）。返回其 `QuestionTimelineEntry[]`。**时间戳契约（critic 核实，2026-06-07）**：同路径 sibling `app/api/questions/[id]/timeline/route.ts:46/65` 已确立 **unix 秒** 形（`created_at_sec = Math.floor(getTime()/1000)`、`computed_at_sec`）。本 detail route 与其同处 `app/api/questions/[id]/` 命名空间，**必须沿用 unix 秒**（`*_sec` 后缀），否则同一资源族两个端点时间形不一致。所有时间字段（question `created_at`/`updated_at`、scheduling `last_evidence_at`/`due_at`、timeline、顶层 `computed_at`）统一 `Math.floor(getTime()/1000)` + `_sec` 后缀，**不用 ISO**。注释引此行。
7. **题级 backlink**（A1e，见下）合并进 detail 返回。

**route：`GET /api/questions/[id]`**
- zod params `{id: string.min(1)}`；`loadQuestionDetail` → null 则 `ApiError('not_found', ..., 404)`；否则 `Response.json(detail)`。镜像 `notes/[id]/route.ts`。
- query 可选 `timeline_limit`。

**测试（db）**：
- seed 一题 + 知识点 + 变式 + 若干 attempt/review 事件 + FSRS 行。
- 断言：返回结构含 row/source_tier/labels/family/scheduling/timeline/backlinks；缺失 id → null（route 404）；archived knowledge label 被 drop；unlabeled 题走 legacy fallback；timeline 复用 getQuestionTimeline（attempt+review 顺序）。

---

### A1e decay/backlink — 并入 `detail.ts`（聚合层），同 `loadQuestionDetail`

**(1) decay bucket（R-P4-5 红线）**：
- **不给 question 单建 bucket**。在 A1d 第 5 步 `scheduling.per_knowledge[].decay_bucket` 即逐 knowledge 节点 `masteryDecayBucket(...)` 聚合。题级「整体新鲜度」如需单值，取 per_knowledge bucket 的最差档（stale > mild > fresh > untrained > unknown 优先级，注释写明聚合规则），命名 `aggregate_decay_bucket`，**显式标注是聚合派生非 question 自有状态**。

**(2) 题级 backlink（R-P4-6）**：
- 数据源 = `artifact.tool_state.question_ids @> [questionId]`（embedded_check 与 tool_quiz 统一，见 §0 表）。
- 查询：
  ```
  select {id, type, title, tool_kind, intent_source, archived_at, generation_status, created_at}
  from artifact
  where sql`${artifact.tool_state}->'question_ids' @> ${JSON.stringify([questionId])}::jsonb`
  ```
- 读时过滤（mirror note-page XC-5 风格）：drop `archived_at != null`；可选 drop 非-ready（视 backlink 语义——倾向保留全部但标 `generation_status`，让 UI 决定；注释写明不做 ready 过滤的理由：题库管理要看到所有引用包括草稿卷）。
- 返回 `backlinks: { artifact_id, type, title, tool_kind, intent_source, generation_status, created_at }[]` + `backlinks_by_intent_source`（按 `intent_source` ∈ {review_plan, quiz_gen, embedded_check, ingestion_paper} 分组，mirror node-page `backlinks_by_type` 的 group helper 思路，但按 intent_source 维度——可内联小 groupBy，不强求复用 `groupBacklinksByArtifactType`，因后者 keyed by `from_type`）。

**测试（db）**：
- seed 一题 + 多个引用它的 artifact（tool_quiz intent_source=quiz_gen / embedded_check / ingestion_paper，含一个 archived）。
- 断言：backlinks 命中非-archived 引用，按 intent_source 分组正确，archived 被 drop，无引用时 `backlinks:[]`；decay aggregate 取最差档。

---

## 3. Commit 切分建议（2-3 原子 commit）

> 每 commit 自洽（typecheck + 该 commit 引入的 db 测试绿）。trailer 每条都带 `Refs YUK-203` + Co-Author；**仅最后一条用 `Closes YUK-280`**，前面用 `Refs YUK-280`。

**Commit 1 — list reader + route（A1a/A1b/A1c）**
```
feat(questions): GET /api/questions list reader — SQL axes + in-memory grounding tier + variant families (Refs YUK-280)

新建 src/server/questions/list.ts（多轴 SQL 筛选 + draft 排除惯例 + 内存 deriveSourceTier
grounding 轴 + compareBySourceTierThenWhitelist 排序 + 变式家族聚合/展开）与
app/api/questions/route.ts。grounding 轴严格内存 derive，零 SQL source_tier WHERE/ORDER BY
（D-P4-1）。候选集 cap 护栏 + truncated 标志。db 测试覆盖各轴 + tier 排序 + 家族。

Refs YUK-280
Refs YUK-203
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

**Commit 2 — detail reader + route（A1d/A1e）**
```
feat(questions): GET /api/questions/[id] detail aggregate — tier + labels + family + per-knowledge FSRS/decay + timeline + backlinks (Closes YUK-280)

新建 src/server/questions/detail.ts（聚合 reader，照搬 loadNotePage 模式）与
app/api/questions/[id]/route.ts。decay 聚合该题 knowledge_ids 的节点 bucket，不给
question 单建 bucket（R-P4-5）；题级 backlink 走 tool_state.question_ids jsonb 容器查询，
按 intent_source 分组（R-P4-6）。复用 getQuestionTimeline / masteryDecayBucket /
deriveSourceTier。db 测试覆盖聚合各分支 + 404 + archived-label drop + legacy fallback。

Closes YUK-280
Refs YUK-203
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

> **可选 3-commit 变体**：若 A1b grounding 内存 derive + 排序体量大到值得独立审查，把 Commit 1 拆为「1a SQL 轴 + 基础列表」(Refs) 和「1b grounding 内存 derive + 变式家族」(Refs)，detail 仍是末 commit（Closes）。默认 2-commit；reviewer 反馈 diff 过大再拆。

切分原则：list 与 detail 文件无交叉（仅可能共享 `loadFamilyMembers` —— 若共享则该 helper 必须在 Commit 1 落地、Commit 2 import，保证 Commit 1 自洽）。

---

## 4. 回退方案

| 风险 | 触发信号 | 回退 |
|------|---------|------|
| 内存 derive 量级误判（题库远超千级） | cap warn 频繁 / 列表延迟高 | 已内置 `CANDIDATE_CAP` + `truncated` 标志 → 不 OOM；后续若需真分页，开 Linear 后续 issue 引入「tier 物化列 + 触发器」或「按 source 粗筛 + 游标」，**不在本 PR**。回退仅需把默认 `sort_by` 退回 created_at（SQL 可分页路径），grounding 排序降级为可选重查询。 |
| `masteryDecayBucket` 跨 module import 被 reviewer 否 | review 提出 node-page 耦合 | 抽 `src/server/knowledge/decay.ts`（纯函数）+ node-page 改 import（此时**才**修改 node-page.ts，单行 import 变更，附带其测试不动）。已在 §1 注明为 reviewer-triggered 可选项。 |
| backlink jsonb 查询性能（artifact 全表扫 tool_state） | EXPLAIN 显示 seq scan 慢 | 当前 artifact 表单用户量级可接受（无新增索引在 scope 内）。若慢，后续 issue 加 GIN index on `(tool_state jsonb_path_ops)` —— DDL 变更不在本 backend-read PR scope，回退为「backlink 限 N 条 + 按 created_at desc」。 |
| 整 PR 回滚 | gate red 不可收敛 | 全部为**新增文件、零既有源修改**（除非走 decay 抽取备选）→ `git revert` 两个 commit 即净回退，无 schema/migration、无既有路径行为变更，无回滚副作用。 |

---

## 5. Gate / 验证（实现 lane 跑，规划者不跑）

- `pnpm typecheck`、`pnpm lint`（touched files Biome）。
- `pnpm test:db:watch src/server/questions/list.test.ts` / `detail.test.ts` 开发环；PR 前 `pnpm test`（含 db 分区）。
- `pnpm audit:schema`：**本计划零 schema 变更**，应 no-op 通过（无新表/字段 → 无 write-path / allowlist 动作）。
- `pnpm audit:partition`：确认两个 `*.test.ts` 落 db 分区（import `@/db/client` → fall-through 即 db；不改 `vitest.shared.ts`）。
- `pnpm build`：catch Next.js route export 校验（两个新 route.ts 的 `GET` + `runtime` 导出）。
- 红线自检 checklist（实现末轮）：grep 新文件确认无 `source_tier` 出现在任何 drizzle `.where`/`.orderBy`/`sql\`...source_tier...\``；确认零 UI 文件；确认未 import/touch runner/budgets/copilot；确认 decay 无 question 维 bucket 写入。

---

## 6. Linear issue 捕获 gate

本计划为**只读规划产出**，未写代码。YUK-280（P4 题库 backend API）已是承载 issue，本计划 A1a~A1e 对应其 R-P4-1~6，**无需新建 Linear issue**。

回退方案 §4 中标注的两个「后续可能」（tier 物化列 / artifact tool_state GIN index）属**性能优化的未来项**，当前量级不触发、且超出 P4 backend-read scope —— 规划者**不预建** issue（避免在未证实的性能假设上造 backlog；实现 lane 若 EXPLAIN 实测命中再开，届时带证据）。其余 R-P3/R-P5 项已在 re-map 报告 §2 序列中，由 owner 按 Wave 推进，非本 lane 范围。
