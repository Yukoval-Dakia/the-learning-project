# YUK-282 — 变式轮换探针：by-kind 选题路由 + 变式家族轮换（实现计划）

**Linear**: YUK-282（C0，YUK-203 P3 收尾）
**ADR**: `docs/adr/0030-variant-rotation-probe-by-kind-selection.md`
**Branch / worktree**: `yuk-282-variant-rotation-seam` @ `.claude/worktrees/yuk282-variant-rotation`
**风险面**: 纯选题逻辑替换。FSRS 存储/调度/event 形状不动；`/api/review/due` wire 契约不变。零冲突于在飞的 copilot/chat/Dock/questions API lane。

---

## 0. 红线（贯穿全程）

- 不碰 copilot / chat / Dock / questions API。
- 不动 FSRS 存储/调度单元（ADR-0028 已锁）、不动 event 写路径、不动 `material_fsrs_state` schema。
- `/api/review/due` 返回 wire 形状不变（`{ rows: [...] }`，每行字段集不变）。
- 不引入 LLM——纯 SQL/确定性（AI scheduler 是 Q2 拍板暂不统一的另一条路）。
- never-reviewed 切片 + ADR-0028 knowledge-level already-reviewed 排除 + round-robin + goal soft-bias 全部**不动**——只替换 overdue 切片里 `pickQuestionForKnowledge` 这一个函数的内部。

---

## 1. 文件清单

| 文件 | 创建/修改 | 内容 |
|---|---|---|
| `docs/adr/0030-variant-rotation-probe-by-kind-selection.md` | 创建（已完成） | by-kind 路由决策 ADR |
| `docs/superpowers/plans/2026-06-07-yuk282-variant-rotation.md` | 创建（本文件） | 实现计划 |
| `src/server/review/variant-rotation.ts` | 创建 | by-kind 路由 + 家族轮换的纯选题逻辑（从 due-list 抽出，便于单测） |
| `src/server/review/due-list.ts` | 修改 | `pickQuestionForKnowledge` 改调用 variant-rotation；删除现状单条 `CASE WHEN id=lastQuestionId` 内联 SQL |
| `src/server/review/variant-rotation.test.ts` | 创建 | DB 测试（family 轮换序、降级、跨知识点边界、确定性、recall 原题重复） |
| `app/api/review/due/route.test.ts` | 修改（按需） | 若现有 due 测试断言假设旧选题序，更新断言；新增 by-kind 端到端用例 |

> 抽出 `variant-rotation.ts` 的理由：现状 `pickQuestionForKnowledge` 内联在 due-list.ts，逻辑要从「一条 ORDER BY」扩到「kind 解析 + 家族读 + 轮换序」，抽成独立模块让核心算法可被聚焦 DB 测试覆盖，且 due-list.ts 的 orchestration 保持薄。模块仍接收 `Db` handle（deps-injectable 风格，与 due-list 现状一致），不引新抽象层。

---

## 2. 实现步骤

### Step 1 — `variant-rotation.ts`：路由分类 + 纯选题

导出：

```ts
// 路由分类（纯函数，无 IO）——新 kind 进 enum 时强制经此分支
export type RotationClass = 'recall' | 'application';
export function rotationClassForKind(kind: QuestionKindT): RotationClass;
//   recall:      'fill_blank' | 'translation'
//   application: 'short_answer' | 'reading' | 'choice'
//   默认(未拍板): 'essay'|'computation'|'derivation'|'true_false' → 'application'（保守，注释）

// 主选题入口（替换 pickQuestionForKnowledge 内核；带 IO）
export async function pickProbeForKnowledge(
  dbHandle: Db,
  input: {
    knowledgeId: string;
    lastReviewEventId: string | null;
    usedQuestionIds: Set<string>;
  },
): Promise<SelectedProbe | null>;
```

`pickProbeForKnowledge` 流程：
1. 解析 `lastQuestionId`（复用现有 `lastReviewedQuestionIdForEvent`，或在本模块内联同 SQL）。
2. 若 `lastQuestionId` 存在 → 读 `Q_last`（id, kind, root_question_id, knowledge_ids, draft_status）。
3. 分类：`cls = lastQuestionId ? rotationClassForKind(Q_last.kind) : 'application'`（无上次题 → application 默认）。
4. **recall 分支**：选 `lastQuestionId` 本身（若仍 non-draft 且标 K 且未被 used）；否则降级到 K 下 `created_at ASC, id ASC` 首个未用 non-draft 题。
5. **application 分支**：
   - `familyRoot = Q_last.root_question_id ?? Q_last.id`（无上次题时该步走 fallback 直接选 K 下 created_at 最早根题）。
   - 单条 SQL 取 family：`WHERE (root_question_id = familyRoot OR id = familyRoot) AND knowledge_ids @> [K] AND (draft_status IS NULL OR <> 'draft')`，先减 `usedQuestionIds`。
   - 在应用层按 `(variant_depth ASC, created_at ASC, id ASC)` 排序成稳定环，取 `Q_last` 之后下一个（环绕）；`Q_last` 不在序中 → 取序首。
   - family 减 used 后为空 → 降级到 K 下首个未用 non-draft 题；仍无 → 返回 null。
6. 命中后 `usedQuestionIds.add(chosen.id)` + 返回 `SelectedProbe`（字段同现状 `pickQuestionForKnowledge` 返回：question_id, prompt_md, reference_md, knowledge_ids, created_at, source, metadata）。

> 注意保持现状返回投影里的 `source` / `metadata`（YUK-226 tier 派生依赖），避免回归。

### Step 2 — `due-list.ts`：接线

- `pickQuestionForKnowledge` 改为薄 wrapper（或直接在 `handleReviewDue` 的 `for (stateRow of knowledgeStateRows)` 循环里调 `pickProbeForKnowledge`）。
- 删除现状内联的 `CASE WHEN ${lastQuestionId}::text ... THEN 1` SQL 块。
- `lastReviewedQuestionIdForEvent` 若被新模块复用则保留导出；否则保持私有。
- 其余 due-list 逻辑（legacy question-level 切片、never-reviewed、round-robin、goal rerank）**逐字不动**。

### Step 3 — 测试（DB config，核心架构变更要求）

`variant-rotation.test.ts`（`vitest.db.config.ts`）覆盖：
1. **recall 原题重复**：fill_blank/translation 题，lastQuestionId 命中 → 重选同题（非轮换）。
2. **recall 降级**：上次题被降 draft → 退到 K 下 created_at 首个 non-draft。
3. **application 家族轮换序（生产形态）**：root(depth0) + 2 个 depth-1 变式 V1/V2（这是 variant_gen 唯一能产出的形态——depth≥2 被 `variant_gen.ts:161` 封死，见 §3 备忘）。序 = `(variant_depth ASC, created_at ASC, id ASC)` → `[root, V1, V2]`（V1/V2 同 depth=1，靠 created_at 定序）。lastQuestionId=root → 选 V1；last=V1 → 选 V2；last=V2 → 环绕回 root。断言确定性序，并显式断言两个变式 depth 相等（守护「variant_depth 在生产中只分隔原题/变式」的不变量）。
   - **(可选) 前向兼容守护**：单独构造一个**直插**的 depth-2 行（绕过 variant_gen），断言排序键在 depth 0/1/2 混合时仍稳定。明确标注此 fixture 是 forward-compat guard，**不代表生产数据分布**，仅防未来放宽 depth cap 时排序回归。
4. **无变式降级**：application 题家族仅原题（len=1）→ 选回原题自身。
5. **单题家族 / Q_last 不在 family**：last 已删 → 取序首。
6. **家族跨知识点边界**：变式标 [K1,K2]，root 只标 [K1]；K2 到期时 family 只含标 K2 的成员，不误选只标 K1 的 root。
7. **与 used 去重交互**：一道多标题被 K_A 选走 → K_B 轮换跳过取家族下一个。
8. **确定性**：同输入连跑两次字节一致。
9. **未拍板 kind 默认**：essay/computation 题 → 走 application 轮换（守护默认归类）。

`route.test.ts`：跑现有套件确认无回归；旧断言若依赖「created_at ASC 首选」隐式序且现仍成立（单题/recall 场景）则不改；新增 1-2 个 by-kind 端到端用例确认 wire 形状不变。

### Step 4 — Gate

- `pnpm vitest run --config vitest.db.config.ts src/server/review/variant-rotation.test.ts`
- `pnpm vitest run --config vitest.db.config.ts app/api/review/due/route.test.ts`
- 触碰文件 Biome；`pnpm typecheck`。
- PR 前全 gate（typecheck/lint/audit:schema/audit:partition/audit:profile/test/build）。
- `audit:schema`：本 ADR 不新增 schema 字段（只读既有 root_question_id/variant_depth/kind），无 allowlist 改动。

---

## 3. 题型映射备忘（owner 产品语 ↔ enum）

| owner 拍板用语 | `QuestionKind` enum 值 | 路由类 |
|---|---|---|
| fill_blank | `fill_blank` | recall |
| translation | `translation` | recall |
| short_answer | `short_answer` | application |
| reading_comprehension | `reading` | application |
| single_choice | `choice` | application |
| （未点名）essay/computation/derivation/true_false | 同名 | application（保守默认） |

> `reading_comprehension`→`reading`、`single_choice`→`choice` 是 owner 产品语到 enum 的映射；enum 无 `reading_comprehension`/`single_choice` 字面值（已核 `src/core/schema/business.ts`）。

---

## 4. 验收

- ADR-0030 merge 即 Accepted，supersede ADR-0028 §3 末句的「单条避让」描述。
- due 选题对 recall 类复现原题、对 application 类家族轮换；二者确定性。
- 全 gate 绿；`/api/review/due` wire 不变；零冲突于在飞 lane。
