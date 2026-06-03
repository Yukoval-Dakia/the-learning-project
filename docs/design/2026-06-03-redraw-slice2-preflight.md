# Redraw Slice 2 — design pre-flight（knowledge detail `/knowledge/[id]`）

> **Status**: Pre-flight, awaiting user approval（CLAUDE.md UI 规则）。
> **Source**: loom-prototype `screen-knowledge-detail.jsx`（checkpoint f85aca6d，claude.ai/design `loom-refresh`）。YUK-169 slice 2 / YUK-203 P5。
> **Base**: branch `yuk-169-redraw-slice2`（自 merge 后的 main，已含 slice-1 基座 + shell + loom primitives）。

---

## 0. 范围与收窄

- slice-2 **只做 knowledge DETAIL**（`/knowledge/[id]`，当前 529 行）。knowledge LIST（`/knowledge`，1129 行，含 mesh/graph）因体量 + 图谱复杂度留 **slice-3**。
- 直接和 slice-1 NoteReader 配对：NoteReader 的 `?from=knowledge` 返回 `/knowledge/[id]`；本页把后端**已提供但当前未消费**的 `notes: NoteSummary[]`（P1 ADR-0027 多 note 列表）首次 surface 出来 → 知识点 → 笔记导航闭环视觉补全。
- additive：复用 slice-1 落地的 globals loom class 层 + loom primitives；**新增 loom `Card` + `Badge`**（slice-1 未建、本页重度依赖）；退役本页的 4 个 legacy primitive。其它 surface 不动。

## 1. 组件类型声明（CLAUDE.md 要求）

| 类型 | 物 |
|---|---|
| **设计基座（新 primitive，additive）** | `src/ui/primitives/Card.tsx`（loom `.card`/`.card-head`/`.card-title` + `pad`/`hover` props）· `src/ui/primitives/Badge.tsx`（loom `.badge` + tone：neutral/again/good/info…）。新名，与 legacy `Card`/`Badge` 并存，barrel `index.ts` 追加导出。 |
| **page（route）视觉重写** | `app/(app)/knowledge/[id]/page.tsx` 由「PageHeader + 4 个 Card section」→ loom **2-column `.kd-grid`**（kd-main + kd-side），复用现有 `/api/knowledge/[id]` 数据层。 |

## 2. 逐字引 loom-prototype（设计依据）

`docs/design/loom-prototype/screen-knowledge-detail.jsx`（f85aca6d）：

- **header**：`<button className="back-link">…知识网`；`.page-head` → `.eyebrow`「KNOWLEDGE · {node.tag} · {node.kind}」`；`.kd-head` = `<MasteryRing pct={node.mastery} size={64}/>` + `.page-title.serif` 标题 + `.kd-metrics`（`{evidence} evidence` · decay-bucket · `{mistakes} 错题` Badge）+ `.hero-cta`「复习此点」→ review。
- **`.kd-grid` = `.kd-main` + `.kd-side`**。
- **kd-main · 笔记**：`<SectionLabel>笔记` + hint「knowledge_id 是笔记上的标签 · 笔记按 note_atomic / note_hub / note_long 区分，一条笔记可挂多个知识点」；`notesByKindForKnowledge` → `{primary, atomic[], hub[], long[]}`。primary = `.kd-primary-note`（`note-kind-tag note-kind-atomic` + 标题 + verify-badge + **inline body** + acts「在阅读器中打开」→ `notes/{id}~k~{nodeId}`）；其余按 kind 分组为 `.note-link-row`（icon + 标题 + verify-badge + updated + thread-arrow → NoteReader）。空态 `EmptyState`。
- **kd-main · 标注笔记**：`<SectionLabel count>` + `annotationsForKnowledge` 行（actor/text/anchor/when）。
- **kd-main · 邻居·按关系分组**：`.kd-rel-block` 层级（parent/children + 子节点 MasteryRing）+ 按 `byRel`（typed relations，`REL_CUE` glyph+label）分组 `.rel-row`。
- **kd-side · 反向链接·按来源类型**：`backlinksByArtifact` → `{question,note,learning_item,mistake,session}`，每组 icon+label+count + `.bl-row`（label/meta/thread-arrow）。
- **kd-side · 活动**：`.event-chain`（`.event-row` rail dot/line + label/t + note，tone 着色）。

## 3. 数据映射 KnowledgeNodePage → loom（基于 agent 实测）

后端 `loadKnowledgeNodePage`（`src/server/knowledge/node-page.ts`）经 `GET /api/knowledge/[id]`，read-only。**干净/reshape**：

| loom 字段 | 来源 |
|---|---|
| 标题 | `name` |
| eyebrow tag | `id`（短 8 位，沿用当前页做法；后端无 slug `tag`） |
| Mastery Ring | `mastery`（0..1）×100；**保留 evidence-guard**：`evidence_count < 3`→「证据不足」、`=0`→「未练习」（不回归 MasteryBadge 语义） |
| evidence | `evidence_count` |
| 笔记（primary + atomic/hub/long） | **`notes: NoteSummary[]`（当前未用！）** client 按 `.type` 分组；primary body 复用 `primary_atomic` + `BlockTreeRenderer`（非 loom `NoteEditor`） |
| verify-badge | `NoteSummary.verification_status` → verified / 草稿 |
| 邻居 typed | `mesh_neighbors[]`（`relation_type`/`direction`）client 按 relation 分组，label 用现有 `RELATION_LABEL` |
| 层级 parent | `parent_id`/`parent_name`（仅 parent） |
| 反向链接 | `backlinks[]`（`from_type` ∈ note_atomic/hub/long/tool_quiz）按 from_type 分组 |
| 活动 | `timeline[]`（action/actor_kind/outcome/created_at）→ label(现有 `ACTION_LABEL`)/relTime/tone(outcome) |
| CTA 复习此点 | → `/review` |

## 4. 缺口 → 处理（**不造假 prototype-only 字段**）

| loom 字段 | 后端 | 处理 |
|---|---|---|
| `node.kind` | 无 kind 列 | **drop**（eyebrow 只「KNOWLEDGE · {id8}」） |
| decay / retention bucket | 本分支无 knowledge-level FSRS（ADR-0028 在 yuk-203-p3 分支，未合）| **drop**（不渲染 decay-bucket；待 P3 FSRS PR-B 合入后另起 slice 补） |
| per-node mistakes count | projection 无 | **drop** 错题 badge（不假造；需新 count 查询 = 后端工作） |
| 标注笔记 annotations | 无 annotation 表 | **omit** 整段（prototype-only） |
| 邻居 children[] | projection 仅 parent | **仅渲染 parent**（children 需后端 child 查询，留后续） |
| 反向链接 5-way | 后端仅 note+tool_quiz | 只渲染**有数据的组**（note→笔记组、tool_quiz→测验组）；question/learning_item/mistake/session 组无源不渲染 |
| note `from`（作者） | 不在 NoteSummary | omit 作者行 |
| 活动 `note` 文案 | 无 per-event 人读 note | omit（只 label + 时间 + tone） |

> 缺口里 **decay / mistakes-count / children / 5-way backlinks** 是真后端缺口（非本 slice 范围）。本刀渲染后端撑得起的部分，缺口处**留空/省略**而非 mock。是否补这些后端能力 = 后续 YUK 决策（与 P3 FSRS PR-B 相关）。

## 5. Touch 文件清单

**NEW（additive primitive）**：`src/ui/primitives/Card.tsx` · `src/ui/primitives/Badge.tsx` · 追加 `src/ui/primitives/index.ts` barrel 导出。
**MODIFY**：`app/(app)/knowledge/[id]/page.tsx`（**只换视觉 JSX + 新消费 `notes`**，复用 `/api/knowledge/[id]` 查询 / `BlockTreeRenderer` / `formatRelTime` / 现有 `RELATION_LABEL`+`ACTION_LABEL` map）。
**REUSE（不动）**：`/api/knowledge/[id]` route + `node-page.ts` 后端（零改）· `BlockTreeRenderer` · slice-1 的 loom primitives（LoomIcon/Btn/IconBtn/Ring/SectionLabel/EmptyState/…）· globals loom class 层。
**KEEP-LEGACY（本刀不删）**：`src/ui/primitives/{Badge,Card,MasteryBadge,PageHeader}` —— 仍被 knowledge LIST + ~38 其它 surface 引用，随各自 slice 退役。本页**改用新 loom Card/Badge + Ring + inline page-head**，不再 import 这 4 个 legacy。

## 6. 风险 + 缓解

- **Ring 丢 evidence-guard**：loom `Ring` 无「证据不足」守卫 → 显式在 header 渲染 guard 文案（evidence<3/=0），保留 MasteryBadge 语义。
- **新 Card/Badge 撞 legacy**：新名 `Card`/`Badge` 放 `src/ui/primitives/`，与 legacy 同名？→ legacy 也叫 `Card.tsx`/`Badge.tsx`。**冲突**：需用不同文件名/导出名（如 loom `Card`→既有文件已占用）。**决策**：loom 版命名 `LoomCard`/`LoomBadge`（文件 `Card`→`LoomCard.tsx`），barrel 导出 loom 名，避免与 legacy `Card`/`Badge` 文件/导出撞。（与 slice-1 `LoomIcon` 命名一致。）
- **notes vs primary_atomic 去重**：`notes[]` 含全部 atomic，`primary_atomic` 是其中最新一条 → primary 区用 `primary_atomic`，其余 atomic 列表排除 primary.id，防重复（同 slice-1 版本时间线去重教训）。
- **build 是 CSS-layer + route-export 唯一 gate**（YUK-67）。

## 7. Build order + verify gate

新 `LoomCard`/`LoomBadge` + barrel → 重写 `/knowledge/[id]` 视觉（消费 notes 分组 + neighbors 分组 + backlinks 分组 + timeline）→ **verify**：typecheck / lint / audit×3 / build（route + CSS）/ `/knowledge/[id]` read（含 notes 列表、邻居、反向链接、活动）/ `?from=` 往返 NoteReader。像素打磨留后。独立 review + PR（rebase，CI 绿后 merge）。

---

*批准后按 build order 实施。本刀只重绘 knowledge detail + 新增 LoomCard/LoomBadge；knowledge list（mesh/graph）留 slice-3。*
