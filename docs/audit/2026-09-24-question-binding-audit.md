# YUK-1032 — 历史题绑定审计：seed:*:root / 空 knowledge_ids 普查与口径核对

日期：2026-09-24 · 分支 `yuk-1032-binding-audit` · 基线 `769a016d6`（origin/main）
性质：**只读审计**（YUK-1009 follow-up）。全部库访问为 `docker exec
the-learning-project-postgres-1 psql -U loom -d loom` 单条 SELECT（首条包在
`BEGIN READ ONLY` 事务内）；零 INSERT/UPDATE/DELETE/DDL，未触 pg-boss 表。

## 方法

1. 原样执行票面三段 SQL（§1–§3），记录行数与明细。
2. 补 four 组只读辅查（§4），定位「这些绑定是否真会被练习面服务」——
   `material_fsrs_state` / `event` / `learning_item` / `goal` / `knowledge_edge` /
   `mastery_state` 六表的存在性证据。
3. 代码侧核对：`resolveSubjectKnowledgeIds` 排除契约 + 全部练习取题路径
   （placement / due / stream / matcher / intervention）是否把 seed-root 绑题、
   空绑题服务给用户。

## §1 票面 SQL 一 —— 总量 + 两类可疑绑定计数

```sql
SELECT
  count(*) FILTER (WHERE knowledge_ids = '[]'::jsonb) AS empty_knowledge_ids,
  count(*) FILTER (WHERE knowledge_ids @> '["seed:math:root"]'::jsonb) AS bound_to_seed_root,
  count(*) AS total
FROM question;
```

结果（1 行）：

| empty_knowledge_ids | bound_to_seed_root | total |
|---|---|---|
| 3 | 4 | 114 |

对照 09-17 观察（2 空绑 / 3 seed-root）：两类各 +1。背景分布：114 题 =
66 active + 48 draft；source = web_sourced 72 / quiz_gen 32 / mind_probe 6 /
intervention_diagnostic 3 / manual 1。

## §2 票面 SQL 二 —— source × draft_status × 月份分布

```sql
SELECT source, coalesce(draft_status,'active') AS draft_status,
       date_trunc('month', created_at) AS month, count(*)
FROM question
WHERE knowledge_ids = '[]'::jsonb
   OR knowledge_ids @> '["seed:math:root"]'::jsonb
GROUP BY 1,2,3 ORDER BY 3;
```

结果（4 行）：

| source | draft_status | month | count |
|---|---|---|---|
| intervention_diagnostic | active | 2026-07 | 2 |
| intervention_diagnostic | draft | 2026-07 | 1 |
| web_sourced | active | 2026-09 | 3 |
| web_sourced | draft | 2026-09 | 1 |

补充逐题拆分（两类在 source 上不重叠，分布完全可分）：

| id | source | draft_status | created_at | knowledge_ids | 类 |
|---|---|---|---|---|---|
| intervention:int_d7c65598dd0a65788200c7294c20984c:v1:transfer | intervention_diagnostic | active | 2026-07-31 | `[]` | empty |
| intervention:int_d7c65598dd0a65788200c7294c20984c:v1:delayed | intervention_diagnostic | active | 2026-07-31 | `[]` | empty |
| intervention:int_d7c65598dd0a65788200c7294c20984c:v1:immediate | intervention_diagnostic | draft | 2026-07-31 | `[]` | empty |
| tilosr8qwq65odahd434a7iq | web_sourced | draft | 2026-09-14 | `["seed:math:root"]` | seed_root |
| s6xkn5p91ekx54s9bdds2fty | web_sourced | active | 2026-09-14 | `["seed:math:root"]` | seed_root |
| i3vczztadey3hf0syqr341uk | web_sourced | active | 2026-09-14 | `["seed:math:root"]` | seed_root |
| sh2ls82bo9hax9krksavmbea | web_sourced | active | 2026-09-14 | `["seed:math:root"]` | seed_root |

- 3 道空绑全部来自同一 intervention（`int_d7c65598dd0a65788200c7294c20984c`
  的 v1 immediate/delayed/transfer 三窗口探针）。
- 4 道 seed-root 绑全部来自同一批 09-14 jyeoo 抓取（web_sourced）。

## §3 票面 SQL 三 —— `seed:%:root` 泛化查询

```sql
SELECT q.id, q.source, q.draft_status, q.created_at, q.knowledge_ids
FROM question q
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements_text(q.knowledge_ids) AS kid
  WHERE kid LIKE 'seed:%:root'
);
```

结果：4 行，即 §2 表中全部 seed_root 行；**无其他 subject 的 seed root 绑题**
（`seed:yuwen:root` / `seed:physics:root` 节点存在且活跃，但无题绑之）。

## §4 辅查证据（只读，审计自增）

| 查询 | 结果 | 含义 |
|---|---|---|
| `material_fsrs_state` 中 `seed:%:root` / 7 道嫌疑题的行 | `knowledge`/`seed:math:root` 一行，`due_at=2026-09-14 14:15:33`（已到期），`last_review_event_id=ctzbdu8f9ptnjabnbcwmo4ui`；`question`/`v1:delayed`（due 08-07）与 `v1:transfer`（due 08-21）各一行 | seed:math:root 被当成普通 KC 建了 FSRS 卡且已到期；两道 active 空绑诊断题有题级到期卡 |
| `event WHERE id='ctzbdu8f9ptnjabnbcwmo4ui'` | `subject_kind=question, subject_id=s6xkn5p91ekx54s9bdds2fty, action=experimental:source_verify, outcome=success` | seed:math:root 的 FSRS 卡正是该题 source_verify promote 时 enroll 产生的 |
| `material_fsrs_state` `subject_kind='knowledge'` 总数 | 13 行，其中 `seed:%:root` 1 行 | seed root 卡不是孤例噪声，是 enroll 路径的系统性产物 |
| `event` 中 7 道嫌疑题的 attempt/review | 4 道 seed-root 题只有 store/verify 事件（tilosr8q… source_verify=failure → 留在 draft；另 3 道 success → active）；`v1:immediate` 有一条 review success（07-31） | seed-root 题尚未被作答；诊断题按窗口调度推进 |
| `learning_item` / `goal.scope_knowledge_ids` 含 `seed:%:root` 或空绑 | 0 行 / 0 行 | new_check 与 placement tier-1 当前无 seed-root 通道 |
| `knowledge_edge` 触 `seed:%:root` | 2 行 prerequisite（`seed:math:root`→yuk792 canary 两 KC），均 `archived_at=2026-09-17`（YUK-1010 清理） | frontier 闭包当前不含 seed root，暴露面为零 |
| `mastery_state` `seed:%:root` | 0 行 | θ̂ 尚未污染结构根（无 attempt） |
| `knowledge` 中 `seed:%:root` | yuwen/math/physics 三根均 live | 结构锚正常 |

## §5 代码口径判定 —— **不一致，且当前活跃**

### 契约侧（subject KC 集 —— 排除是一致的）

- `src/kernel/read-models/knowledge-tree.ts:163,193` —
  `resolveSubjectKnowledgeIds` 按 ID pattern 排除 `seed:<subj>:root`
  （"structural anchor, never content"）。下游全部 subject 轴消费方继承此口径：
  `?subject=` 题库列表（`src/capabilities/practice/api/questions-list.ts:90` →
  `src/kernel/read-models/questions.ts:267-273`，空集→`sql\`false\``）、
  placement tier-2 scope（`placement-scope.ts:41`）、leaning 偏好
  （`placement-select.ts:59`）、goal scope nightly、copilot `query_questions`、
  notes-list、knowledge edges。
- `src/capabilities/practice/server/placement-scope.ts:48-57` — tier-3 全树兜底
  也用 `SYNTHETIC_SUBJECT_ROOT_RE`（:64）剥掉 seed root；唯一例外是 roots-only
  day-one 树（`contentOnly.length > 0` 才替换）——文档化的有意例外，目的是让冷启
  probe 能诚实报 sourcingNeeded 而非 400。
- `src/capabilities/practice/server/question-supply/placement-starter-store.ts:111`
  — 付费供给 KC 目标同样 `NOT LIKE 'seed:%:root'`。

即：**凡是「subject → KC 集」的派生轴，seed root 都被一致地排除**。seed-root
绑题在 `?subject=math` 题库面、subject scope 取题面均不可见。

### 服务侧（FSRS/attempt 锚定 —— 不经过 subject 轴，排除不发生）

- **写入侧**：jyeoo hints 匹配失败时 `plan-executor.ts:563-570` 走
  `findSubjectRootKnowledgeId`（`jyeoo-hint-match.ts:120-127`，domain 直查返回的
  就是 seed root）→ `knowledge_ids=['seed:math:root']`、`attribution_state='coarse'`。
  绑定本身是设计内 coarse fallback。
- **enroll 侧**：`source_verify.ts:664-692` / `verify-and-promote.ts:209-228`
  （quiz_verify 同款约定）promote 时对 `knowledge_ids` **逐 id**
  `enrollIfAbsent('knowledge', id)` —— **不过滤 `seed:%:root`**；空数组才落
  `enrollIfAbsent('question', questionId)` 题级兜底。生产证据：
  `material_fsrs_state('knowledge','seed:math:root')` 行的 `last_review_event_id`
  正指向 `s6xkn5p91ekx54s9bdds2fty` 的 source_verify success 事件（§4）。
- **取题侧**：`/api/review/due`（`due-list.ts:252-299`）对每个到期 KC 行调
  `selectProbeFromPrefetch` → `prefetchProbeSelection`
  （`variant-rotation.ts:199-223`）做 `knowledge_ids @> [kc]` 召回非 draft 题。
  `seed:math:root` 卡已到期 → 召回集 = 3 道 active seed-root 绑题（§4 已模拟该
  WHERE，命中恰为这 3 题）→ 进入 due 页与 `composeDailyStream` 的 dueItems
  （`stream-store.ts:180-216`）。**今天它们就可被服务给用户**。
- 其他 KC 锚定通道（new_check `stream-store.ts:277-289`、frontier
  `stream-store.ts:313-330`、placement tier-1/2、matcher `poolFetch`）当前无
  seed-root 载体（§4：learning_item/goal/prereq 边均不含），但一旦上游把
  seed root 写进任一 KC 集，这些路径会同样服务——因为它们只认
  `knowledge_ids` 字面包含，不回看「该 id 是否内容节点」。

### 空绑题

- 3 道全是 `intervention_diagnostic`，且 `knowledge_ids: []` 是**写入侧硬编码**
  （`intervention-diagnostics.ts` 题插值处；真实 KC 存
  `metadata.data.knowledgeId`）。服务通道是题级 FSRS 固定窗口调度：
  `due-list.ts:301-342` 题级切片按 question id 直取（无 knowledge_ids 谓词）+
  `stream-store.ts:196-216` `protectedInterventionRows` 前置并集（YUK-792：
  "approved learner delivery"）。生产证据：`v1:delayed`/`v1:transfer` 各有一张
  到期题级卡（08-07 / 08-21），`v1:immediate` 为 draft 被 `notDraftPredicate`
  挡在池外（符合窗口机制设计）。
- 空绑题对**所有 KC 锚定通道**天然不可见（`knowledge_ids @> [kc]` 永假）；
  对**题级/事件锚定通道**（due 题级切片、never-reviewed failure 切片、变式家族
  轮转、paper、solve-by-id）绑定为空不构成任何障碍。

### 判定

「subject KC 集排除 seed root」与「练习取题面服务 seed-root 绑题」**两个口径
并存且都在生效**：同一道题在 `?subject=math` 轴下不存在，在 due/stream 轴下
可被服务。根因不是取题面做错了 containment——是 verify-enroll 把
`seed:%:root` 当内容 KC 建了调度卡，让「结构锚」获得了一个本不该存在的
FSRS 主体身份。属**独立 bug**（enroll 面缺合成根过滤），建议另开票；
规模小（1 张卡 / 3 道可服务题），但每过一道 coarse-fallback verify 就新增一张。

## §6 处置建议（只列建议，未执行任何写操作）

1. **4 道 seed-root 绑题 → attribution proposal 补绑真实 KC**（propose→accept
   流，禁 SQL 直改）。3 道 active（s6xkn5p91ekx54s9bdds2fty /
   i3vczztadey3hf0syqr341uk / sh2ls82bo9hax9krksavmbea）按题干语义归到数学
   真实 KC；1 道 draft（tilosr8qwq65odahd434a7iq，source_verify 已 failure）
   建议补绑后重验或直接 dismiss/archive。
2. **口径不一致另开 bug 票**（本票不修）：enroll 面
   （`source_verify.ts:668-680` / `verify-and-promote.ts:221-228` /
   `quiz_verify` 同款）对 `knowledge_ids` 加 `SYNTHETIC_SUBJECT_ROOT_RE` 过滤
   ——与 `placement-scope.ts:64` 复用同一 pattern；配套决定
   `material_fsrs_state('knowledge','seed:math:root')` 现存行的处置
   （走 proposal/ops 正规路径，非 SQL 直删）。可选加固：plan-executor coarse
   fallback 改写空绑 + 自动起 attribution proposal（避免再生产 seed-root 绑）；
   与/或 due 探针对 `seed:%:root` 主体行不生成 probe（防御纵深）。
3. **3 道空绑 intervention_diagnostic 题：设计内，不需补绑**。空
   `knowledge_ids` 是该 source 的契约形状（KC 在 `metadata.data.knowledgeId`，
   投递走题级 FSRS 窗口）。若 owner 想让统计/归属口径统一，可把
   `metadata.data.knowledgeId` 回填进 `knowledge_ids` —— 但这会改变 KC 级
   FSRS/θ̂ 归属语义，属产品裁决而非数据修复；建议仅在 Linear 记一条
   optional follow-up。
4. **θ̂ 污染预防**：`mastery_state` 当前无 seed root 行；一旦 seed-root 绑题被
   作答，`updateThetaForAttempt` 会把 θ̂ 写到结构根。建议 2 的 enroll 过滤落地
   后此面自然收敛；在那之前建议 1 的补绑优先于任何作答暴露。

## 附：本次执行的全部只读查询（审计自增部分）

```sql
-- §4-a 嫌疑题 + seed root 的 FSRS 投影
SELECT subject_kind, subject_id, due_at, last_review_event_id IS NOT NULL AS has_last_review
FROM material_fsrs_state
WHERE subject_id LIKE 'seed:%:root'
   OR subject_id IN ('i3vczztadey3hf0syqr341uk','tilosr8qwq65odahd434a7iq',
                     's6xkn5p91ekx54s9bdds2fty','sh2ls82bo9hax9krksavmbea',
                     'intervention:int_d7c65598dd0a65788200c7294c20984c:v1:transfer',
                     'intervention:int_d7c65598dd0a65788200c7294c20984c:v1:delayed',
                     'intervention:int_d7c65598dd0a65788200c7294c20984c:v1:immediate')
ORDER BY subject_kind, subject_id;

-- §4-b 逐题绑定分类（§2 的拆分版）
SELECT q.id, q.source, q.draft_status, q.created_at, q.knowledge_ids,
       CASE WHEN q.knowledge_ids = '[]'::jsonb THEN 'empty'
            WHEN q.knowledge_ids @> '["seed:math:root"]'::jsonb THEN 'seed_root'
            ELSE 'other' END AS binding_class
FROM question q
WHERE q.knowledge_ids = '[]'::jsonb
   OR q.knowledge_ids @> '["seed:math:root"]'::jsonb
ORDER BY binding_class, q.created_at;

-- §4-c 通道载体存在性
SELECT id, status, knowledge_ids FROM learning_item
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(knowledge_ids) k
              WHERE k LIKE 'seed:%:root')
   OR knowledge_ids = '[]'::jsonb;
SELECT id, subject_id, scope_mode, scope_knowledge_ids FROM goal
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(scope_knowledge_ids) k
              WHERE k LIKE 'seed:%:root');
SELECT id, relation_type, from_knowledge_id, to_knowledge_id, archived_at
FROM knowledge_edge
WHERE from_knowledge_id LIKE 'seed:%:root' OR to_knowledge_id LIKE 'seed:%:root';
SELECT count(*) FROM mastery_state WHERE subject_id LIKE 'seed:%:root';

-- §4-d 嫌疑题事件史 + seed root 事件 + enroll 留痕回指
SELECT subject_id, action, outcome, created_at FROM event
WHERE subject_kind='question' AND subject_id IN (<同上 7 id>) ORDER BY 1,4;
SELECT subject_id, action, outcome, created_at FROM event
WHERE subject_id='seed:math:root' ORDER BY created_at DESC LIMIT 10;
SELECT id, subject_kind, subject_id, action, outcome FROM event
WHERE id='ctzbdu8f9ptnjabnbcwmo4ui';

-- §4-e due 探针召回集模拟（variant-rotation.ts:205-213 同款 WHERE）
SELECT id, draft_status FROM question
WHERE (draft_status IS NULL OR draft_status <> 'draft')
  AND knowledge_ids @> '["seed:math:root"]'::jsonb
ORDER BY created_at, id;

-- §4-f 背景分布
SELECT id, name, domain, parent_id, archived_at FROM knowledge WHERE id LIKE 'seed:%:root';
SELECT coalesce(draft_status,'active') AS draft_status, count(*) FROM question GROUP BY 1;
SELECT source, count(*) FROM question GROUP BY 1 ORDER BY 2 DESC;
```
