# ADR-0030 — 变式轮换探针：by-kind 选题路由 + 变式家族轮换

**Status**: Proposed（merge 即 Accepted）
**日期**: 2026-06-07
**Part of**: YUK-203（领域模型重构）· P3 收尾（设计稿 §5/§7.1 唯一未兑现的核心承诺，re-map R-P3-1）。Linear: YUK-282（C0）。
**Supersedes**: ADR-0028 §决定③ 末句「The deterministic seam rotates away from the last reviewed question when another linked question is available. A later AI scheduler can replace only this selection seam.」——本 ADR 把那个「单条避让」seam 替换成 **by-kind 路由的确定性选题**，且仍保持「A later AI scheduler can replace only this selection seam」这一可替换边界不变。
**Decision source**: `docs/design/2026-06-03-target-domain-model.md` §5（「应用/变式重的题 → 转 per-知识点/技能 FSRS + 变式轮换（探针）；落地为按 subject/question-kind 路由的混合」）+ §7.1（「到期的是知识点，由 AI 选题/变式去探测（变式轮换）」）+ owner 2026-06-07 Q4 拍板（YUK-203 评论 a7db1f40）。
**Related**: ADR-0028（知识级 FSRS——本 ADR 只动其选题 seam，不动调度单元/存储/event 形状）· ADR-0018（mistake variant lifecycle + variants_max=3——本 ADR 是变式家族的**读侧**消费者，不写 variant 血缘）· ADR-0014（capability registry 按 kind 路由判判——本 ADR 复用「按 kind 路由」的同构思路到调度选题）· ADR-0012（mastery 派生 view——knowledge_mastery 作为家族轮换的旁路信号，本轮不接线）。

---

## 背景

ADR-0028 把 FSRS 调度单元从 per-question 改为 per-knowledge：到期的是**知识点**（`material_fsrs_state.subject_kind='knowledge'`），`/api/review/due` 先读到期知识行，再为每个知识点**选一道**具体 non-draft 题作为「探针」呈现给用户作答。ADR-0028 当时只铺了一个最朴素的确定性 seam：

```sql
-- src/server/review/due-list.ts pickQuestionForKnowledge（现状）
ORDER BY
  CASE WHEN <lastQuestionId> IS NOT NULL AND id = <lastQuestionId> THEN 1 ELSE 0 END,
  created_at ASC, id ASC
```

即「把上次做过的那一道排到最后，其余按 created_at 升序」——一条**单题避让**规则，对所有题型一视同仁。

设计稿 §5 给出的目标形态比这更细：选题策略应**按 question-kind 路由**，因为两类题的「重复见同题」语义相反：

1. **纯回忆题**（背诵型）：`fill_blank` / `translation`。重复见**同一道题**正是目的——FSRS 在测「你还记不记得这个具体答案」。换一道「变式」去考同一个回忆点没有意义（甚至有害：把单一事实拆成多张记忆卡，错粒度）。
2. **应用/解题题**：`short_answer` / `reading` / `choice`。重复见同一道题 = **背答案**（有害）；该靠**换变式**练同一技能。ADR-0018 已经把「同一原题的变式家族」物化为 `root_question_id` 家族（`variant_depth` 血缘 + variants_max=3 封顶），本 ADR 在选题时**消费**这个家族做轮换探测。

设计稿把这个差异点列为 §5「本稿最大的开放决策」，owner 2026-06-07 拍板了 by-kind 的路由边界（见下表）。本 ADR 把该边界正式落为 ADR-0028 selection-seam 的替换决策。

> 题型命名对齐：owner 评论使用产品语 `reading_comprehension` / `single_choice`；代码侧 `QuestionKind` enum（`src/core/schema/business.ts`）对应值是 `reading` / `choice`。本 ADR 与实现一律用 enum 值，映射在 §决定·路由表内显式记录。

---

## 决定

### 1. by-kind 路由表（owner 2026-06-07 拍板）

每个到期知识点选探针时，先看「上次为该知识点呈现的那道题」的 `kind`，按下表分流：

| 路由类 | question.kind（enum 值） | owner 产品语 | 选题语义 |
|---|---|---|---|
| **recall** | `fill_blank`, `translation` | fill_blank / translation | **原题重复**——重新呈现上次那一道（per-question 选题语义） |
| **application** | `short_answer`, `reading`, `choice` | short_answer / reading_comprehension / single_choice | **变式家族轮换**——在 `root_question_id` 家族内轮换，避开上次那一道 |

**未在拍板表内的 kind**（`essay`, `computation`, `derivation`, `true_false`）→ **降级走 application 轮换**（与现状「单条避让」行为最接近、最安全：这些都是开放/解题型，背答案有害同理；若家族只有原题则自然退化为原题重复，见决定·3）。该默认归类写死在路由函数内并注释「未拍板 kind 的保守默认」，新增 kind 时强制经过该分支显式归类。

路由所依据的 kind = **上次为该知识点呈现的那道题的 kind**（由 `material_fsrs_state.last_review_event_id → event.subject_id → question.kind` 解析）。当该知识点从未被复习过（`last_review_event_id IS NULL`）时无「上次题」可据 → 走 **application 默认**（首次探测优先轮换族里 created_at 最早的根题，行为与现状 created_at ASC 首选一致，见决定·3）。

> **为什么按「上次题的 kind」而非「知识点的 kind」**：知识点没有 kind；一个知识点可挂多种 kind 的题。以「上次呈现题」的 kind 作路由键，使路由稳定锚在用户刚经历的题型上，且与 FSRS「这次复习是对上次那道题的延续」语义一致。

### 2. recall 选题语义（原题重复 + immediate-last 取舍）

recall 类直接重新选**上次那道题**（`event.subject_id`），不轮换：

- 命中且该题仍 non-draft、仍标该知识点 → 呈现它。
- 上次题已被删/降为 draft/解标该知识点（边角）→ 降级到该知识点下 `created_at ASC, id ASC` 首个 non-draft 题（与现状 fallback 同序）。

**取舍记录（防背答案 vs 回忆目的）**：application 类显式「避开 immediate-last」；recall 类**不避开**，反而锚定 immediate-last。理由：recall 题的 FSRS 卡测的就是「这个具体回忆项的记忆强度」，换题等于换了被测对象、污染 FSRS 信号。「背答案」风险在 recall 类不成立——回忆题的「答案」就是被测知识本身，记住它 = 学会了，不是作弊。故 recall 不引入避让。（对照：application 题的「答案」是某道具体题的解，记住它 ≠ 掌握技能，所以要换变式。）

### 3. 变式家族轮换算法（application 类，确定性）

给定到期知识点 K + 上次呈现题 Q_last（kind ∈ application），轮换在 Q_last 的 **`root_question_id` 家族**内进行：

```
familyRoot   := Q_last.root_question_id ?? Q_last.id     // 原题自身即 root（variant_gen 约定）
family       := { q : q.root_question_id = familyRoot OR q.id = familyRoot }
                  ∩ { q : q non-draft }                  // draft_status IS NULL OR <> 'draft'
                  ∩ { q : K ∈ q.knowledge_ids }          // 仍标该知识点（家族跨知识点边界，见下）
                  − usedQuestionIds                       // 本次 due 页已被别的知识点选走的题
```

**轮换序（确定性规则）**：family 按 `(variant_depth ASC, created_at ASC, id ASC)` 排序成一个稳定环。从该序中取「Q_last 之后的下一个」：

```
ordered := sort(family, by (variant_depth ASC, created_at ASC, id ASC))
idx     := indexOf(ordered, Q_last.id)
chosen  := idx >= 0 ? ordered[(idx + 1) mod len(ordered)]   // Q_last 之后的下一个，环绕
                    : ordered[0]                            // Q_last 不在 family（已删/解标）→ 取序首
```

- **「按家族内 last-reviewed 之后的下一个 variant_depth 序循环」**（SPEC 建议的确定性规则）即此：以 `variant_depth` 为主序、`created_at`/`id` 破平手，从 Q_last 位置 +1 环绕。同输入恒定同输出。
- **无变式家族（family 仅含原题，len=1）**：`(idx+1) mod 1 = idx` → chosen = 原题自身 → **自然降级为原题重复**，无需特判。这是与 recall 行为收敛的安全点。
- **单题家族 / Q_last 不在 family**：取 ordered[0]（确定性序首）。

**与 variant_depth 封顶（ADR-0018 variants_max=3）的交互**：variants_max 是**生成侧**配额（in-flight draft+active ≤ 3，控制 LLM 繁殖），不是轮换侧约束。本 ADR 只读已物化、已 accept（active）的家族成员，对 family 大小无独立上限——家族实际能有多少个轮换探针，由 ADR-0018 的生成配额间接决定（稳态 ≤ 1 原题 + 3 变式 = 4 个轮换位）。`variant_depth` 在本 ADR 仅作**排序键**用，不做截断。

> **生产期 depth 分布（已核 `variant_gen.ts:161` + `task-prompts.ts:452`）**：variant_gen 只允许 depth 0（原题）spawn depth 1；depth 1 **不**再 spawn（`parent.variant_depth >= 1 → skip:max_depth`，spec §3.4.4「不超过 2 代」）。故生产家族恒为 **1 个 depth-0 原题 + 至多 3 个 depth-1 变式**，不存在 depth ≥ 2 的成员。`variant_depth` 主序在实际数据里只把「原题」排在「全部变式」之前；变式之间同为 depth 1，由 `created_at ASC, id ASC` 完全定序。轮换序仍 100% 确定，但「原题→浅变式→深变式」的多级阶梯在生产中退化为「原题→变式（按 created_at）」两级——这是有意接受的形态，不是缺陷。`variant_depth` 作主序仍保留，是为防御未来若放宽 depth cap 时排序仍稳定。

**家族跨知识点边界**：一道变式可标多个 `knowledge_ids`，因此可同属多个知识点的探针池。轮换的 family 始终**先按当前到期知识点 K 过滤**（`K ∈ q.knowledge_ids`）再排序——即「K 的探针池 = 标了 K 的家族成员」，不会把家族里只标别的知识点的成员误选进 K 的复习。这与现状 `pickQuestionForKnowledge` 的 `knowledge_ids @> [K]` 过滤同语义，叠加在家族之上。

**与 due 页知识级排除/去重的交互**：保留现状 `usedQuestionIds` 跨知识点去重——一道题在单次 due 页里只作为一个探针出现一次（一道多标题被知识点 A 选走后，知识点 B 的轮换会跳过它取家族内下一个）。轮换从 family 中先减去 `usedQuestionIds` 再排序选取；若减完为空，降级到该知识点 `created_at ASC` 首个未用 non-draft 题（与现状 fallback 同语义），仍找不到则该知识点本轮不产出探针（`continue`，与现状一致）。ADR-0028 在 never-reviewed 切片做的「knowledge-level already-reviewed 排除」逻辑**完全不动**——本 ADR 只替换 overdue 切片里 `pickQuestionForKnowledge` 这一个选题函数的内部。

### 4. 与 knowledge_mastery 信号的关系

ADR-0012 的 `knowledge_mastery`（派生 view）当前**不进入**本轮的轮换决策——轮换是纯 SQL/确定性的，不读 mastery。设计稿 §5 提到「和 knowledge_mastery 对齐」指的是**调度单元**的对齐（ADR-0028 已把 FSRS 键对到知识点，与 mastery 同粒度），而非用 mastery 加权选题。把 mastery 信号引入选题（如「掌握度低的知识点优先轮深变式」）属于**未来 AI scheduler** 的范畴——正是本 ADR 保留可替换的那个 seam。本轮显式不接线，避免在确定性兜底通道里引入 mastery 读依赖。

### 5. 保留 AI-scheduler 可替换边界

本 ADR 替换的是 ADR-0028 §3 的「单条避让」实现，**不收窄**其可替换性承诺：`pickQuestionForKnowledge`（现改为 by-kind 分流）仍是一个**纯函数式 seam**——输入（到期知识点、上次 event、已用题集），输出（一道探针题或 null），无副作用、确定性。owner Q2 拍板「AI scheduler 与 due 队列暂不统一，并存为有意形态（due=确定性兜底，AI=paper 通道）」（YUK-203 评论 a7db1f40）。故本 ADR 是**确定性兜底通道**的精化，AI 通道走 paper（ReviewPlanTask，ADR-0029），二者并存不互斥。未来若要把 AI 选题接进 due 兜底，仍只需替换这一个 seam。

---

## 后果

**正面**
- 设计稿 §5/§7.1 的「变式轮换探针」承诺兑现，YUK-203 P3 核心收尾。
- 回忆题（fill_blank/translation）保持「同题复现」——FSRS 信号不被换题污染。
- 应用题（short_answer/reading/choice）在变式家族内轮换——抑制「背答案」，让同一知识点的多次复习真正考到技能而非记忆。
- 纯 SQL/确定性：同输入同输出，可单测、可回放、无 LLM 成本、无外部依赖，符合「due=确定性兜底」定位。
- seam 边界保持——未来 AI scheduler 仍可只替换这一个选题函数。

**代价 / 风险**
- 选题逻辑从「一条 ORDER BY」变成「按上次题 kind 分流 + 家族读」，单个知识点的选题多一次 `question.kind` 解析（lastReviewEventId → subject_id → kind）和一次家族 SELECT。due 页知识点数有 candidateWindow 上界（现 ≤400），逐知识点选题已是现状的 N 次查询模式；本 ADR 在每次选题内多一个家族 SELECT，量级不变（仍 O(due 知识点数)），可接受。
- 「未拍板 kind 默认走 application」是保守约定，若未来新增一个本质是回忆型的 kind 而忘了归类，会被错误轮换——由路由函数内强制分支 + 注释 + 测试守护降低风险（新 kind 进 enum 时测试会暴露未归类）。
- 家族轮换序依赖 `variant_depth` / `created_at` / `id` 的稳定性；这三者都是不可变写入字段（variant_gen 一次性写），无漂移风险。
- recall 不避让 immediate-last 是刻意取舍（见决定·2）；若日后 owner 认为回忆题也需轻度避让防「短时记忆作弊」，是本 seam 的局部调整，不影响 application 分支。

---

## 关联

- Design: `docs/design/2026-06-03-target-domain-model.md` §5 / §7.1
- Owner 拍板: Linear YUK-282 描述 + YUK-203 评论 `a7db1f40`（Q4，2026-06-07）
- Code: `src/server/review/due-list.ts`（`pickQuestionForKnowledge` 替换为 by-kind 分流 + 家族轮换辅助）
- Tests: `app/api/review/due/route.test.ts`（+ 可能新增 `app/api/review/due/variant-rotation.test.ts`）
- 被消费的血缘: ADR-0018 `question.{root_question_id, parent_variant_id, variant_depth}`（variant_gen 写、本 ADR 读）
- 不动: ADR-0028 FSRS 存储/调度/event 形状、`/api/review/due` wire 契约（纯选题逻辑替换）
