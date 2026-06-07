# 题库 UI (question bank) — claude design 视觉源

> Refs YUK-288 · Refs YUK-203（领域模型重构）。

这是 claude design (claude.ai/design) handoff bundle 的**视觉源**存档，供后续切片实现与 review 对照。
**它们是视觉参考，不是要照搬的实现结构** —— 复刻视觉输出，不照搬 mock 内部数据模型。

## 真实现位置

- 列表页 `/questions` → `app/(app)/questions/page.tsx` + `src/ui/questions/`
- 详情页 `/questions/[id]` → `app/(app)/questions/[id]/page.tsx`
- 样式（`qb-`/`qd-` 命名空间）追加进 `app/globals.css`（全仓唯一 CSS 文件惯例；mock 自带的 `questions.css`/`tokens.css` 仅作对照、不进运行时）。

## 字段映射（mock → 真 API）

mock 用 `stem/options[{key,text}]/answer/knowledge/source/composite/children/passage`；真 API
（`src/server/questions/list.ts` + `detail.ts`）用 `prompt_md / choices_md:string[] / reference_md /
labels:[{id,name}] / 派生 source_tier / parent_question_id+part_index`。完整映射表见实施计划
`docs/superpowers/plans/2026-06-08-yuk288-qbank-ui.md` §4。

## 红线（实测记录）

- **fade-in 易碎 keyframe**：chat4 实录，modal 入场动画曾把 `opacity:0` 卡死在 frame 0。终稿改为
  「只 animate transform，绝不用 opacity 0→1 门控可见性」。实现照此，不要复活 opacity-gated 入场。
- **写操作（编辑/删除）属 YUK-281**：S1 只读侧只按外形 render 编辑/删除控件并 disabled，不接 PATCH/DELETE。
- **composite 小题展开**：phase-1 真实数据当前无 composite 题（0 个 `question_part` / 0 个 `structured`
  子树）。reader 已就近暴露 `parent_question_id`/`part_index` + `parts[]`，UI 在无 parts 时优雅降级
  （不显示展开 affordance）。

## bundle 内容

- `screen-questions.jsx` — 列表页终稿（视觉源）
- `screen-question-detail.jsx` — 详情页终稿（视觉源）
- `questions.css` — mock 样式（`qb-`/`qd-` 命名空间，对照用；真实现用 repo 现有 tokens）
- `data-questions.jsx` — mock 数据 + helper（纯行为参考，真实现走 API）
- `chat4.md` — 终稿意图对话（含 fade-in 坑记录）
