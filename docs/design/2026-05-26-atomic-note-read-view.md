# Design — atomic note 阅读页 UI/UX redesign

**日期**：2026-05-26
**状态**：草稿（post-grill 2026-05-26 修订 —— 已对齐 YUK-88 的 Y 路径）
**来源**：YUK-85 Sub 3 (PR #154) smoke session 用户反馈 + CCG synthesis + grill-with-docs session
**对应 Linear**：[YUK-89](https://linear.app/yukoval-studios/issue/YUK-89)

> **post-grill 关键更新（2026-05-26）**：
> YUK-88 路径在 grill 后从 B（增量引入 note_long）升级到 Y（atomic 也变 block tree、ADR-0019 section_id 废止）。这意味着 atomic 不再有物理 5-section 结构，5 个 visual idiom（definition / mechanism / example / pitfall / check）**改为按 `block.attrs.semantic_kind` 渲染**，而不是按 section kind。
>
> 本 doc 的视觉决策（5→3 idiom 合并、字重 + 墨色拉对比、hover 低对比稳态、Lucide AlertTriangle、不要 ⋯ 菜单）**完全 hold**，只是数据层从 `sections[]` 改成 `body_blocks` 内带 `attrs.semantic_kind` 的 block。落地 phase 与 YUK-88 的 P2 (TipTap 接入) + P6 (read-view) 合并。
>
> **解耦声明**：本 doc 仍只处理**叶子级 `note_atomic` 的阅读体验**；编辑态 UX、note_long / note_hub 阅读、Living Note mutation 入口见 YUK-88 post-grill §0。

---

## 1. 问题陈述

当前 `/learning-items/[id]` 的 ArtifactView 区域（`src/ui/components/ArtifactSections.tsx:374` + `app/globals.css:2030-2120`）功能 correct，但视觉/信息层级紊乱：

| # | 病灶 | 当前实现 |
|---|---|---|
| 1 | 控件常驻 | 每 section 右上角永远 `[标错] [Edit]`（marked_wrong 时多 `[撤销标错]`） |
| 2 | section 类型视觉无差异 | definition / mechanism / example / pitfall 同款 `border-left: 2px coral + paper-sunk` |
| 3 | "AI 单 pass" tier chip 每条必现 | mono uppercase 灰底 chip，元数据噪音 |
| 4 | 技术词漏到用户面 | "note · note_atomic" eyebrow（`note_atomic` 是 schema 词，对用户无意义） |
| 5 | 状态条常驻 | `已就绪` / `无需验证` 两个 chip 99% 时间稳态 |
| 6 | section 间距不分节奏 | 全部 `gap: var(--s-4)` 平铺 |
| 7 | section body 字体 ✅ 保留 | `wenyan 15px / lh 1.7` 本身合理 |

## 2. 设计原则

1. **Reading first**：默认态把视觉权重让给正文；controls 退到背景
2. **类型即视觉**：section 类型差异化用 visual idiom 而不是 strong 文字
3. **稳态隐形**：99% 时间稳态的元数据（tier / verification status）折叠
4. **节奏感**：definition / mechanism 默认正文（靠字重 + 墨色 + 段落间距分层）→ example 引用 → pitfall warning → check 嵌测；偏离主干才上 chrome
5. **不退化功能**：mark-wrong / edit / 撤销标错 全路径保留（低对比稳态，键盘可达，触屏不依赖 hover）

## 3. Block semantic_kind 视觉差异化方案

> **数据层**（post-grill 后）：渲染按 `block.attrs.semantic_kind` 分支，不是物理 section kind。block 是 TipTap PM doc 内的 node，semantic_kind 是 attrs 的标签（YUK-88 §0.2 拍板）。
>
> **CCG synthesis 修正**：原 5 种独立 idiom 有"小丑服效应"风险（5 套 chrome 同屏 → 喧宾夺主）。
> 减到 3 类视觉处理：`definition + mechanism` 合并为**默认正文态**；只有偏离主干的信息（example / pitfall）才上 chrome；check 保持嵌测 card。

| `semantic_kind` | 视觉 idiom | 用途 |
|---|---|---|
| `definition` | **默认正文 + 字重强调** —— wenyan 15px / `font-weight: 500-600` / `color: var(--ink-1)`；无 chrome、无 eyebrow、无字号变化 | 「这是什么」第一印象，用**字重 + 墨色**而非字号拉层级 |
| `mechanism` | **默认正文** —— wenyan 15px / `font-weight: 400` / `color: var(--ink-2)`；无装饰 | 「怎么运转」结构化阐述；和 definition 共享版式、靠段落间距 + 顺序自然区分 |
| `example` | **Quote 风** —— 左侧 `var(--ink-4)` 2px 浅竖线 + 缩进 + 微 paper-raised 底 | 「举个例子」语义上是引用，弱 chrome |
| `pitfall` | **Warning callout** —— 左侧 `var(--again-line)` 3px 竖线 + `var(--again-tint)` 微红底 + **Lucide `AlertTriangle` 图标**（stroke `--again-line`，size 14px） | 「易错！」唯一需要视觉权重拉起警觉的 idiom |
| `check` | **嵌测 card**（独立 paper-raised 块） —— 实际是 `{ type: 'artifact_ref', target: { artifact_id, kind: 'tool_quiz' } }` block，inline 渲染独立 quiz artifact（YUK-88 Q13.d）| embedded tool_quiz；与 standalone quiz artifact 共享底层 |

**节奏对比比例**：definition (weight 500-600, ink-1) ↔ mechanism (weight 400, ink-2) 字号都 15px。比"17px vs 15px"（≈1.13 太弱、像 bug）更稳，且不破 wenyan 行高节奏（CCG Gemini 建议）。

## 4. ASCII mock

```
┌──────────────────────────────────────────────────────────────────┐
│ ← 返回                                              📝 阅读 / 学习 │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   「弗之怠」中「之」的宾语前置                                    │  ← 标题：现有 h2 字号（无 ⋯ 菜单；技术词不进 UI）
│   文言文 · 进行中                                                │  ← subtle subhead；状态 chip 收进这一行
│                                                                  │
│ ─────────────────────────────────────────────────────────────── │
│                                                                  │
│   之 在「弗之怠」中作宾语前置代词，复指动词后被省略的宾语「学」。│  ← definition：默认正文 + weight 500/600 + ink-1，无 chrome、无字号变化
│                                                                  │
│   关键机制                                                       │  ← mechanism：小 eyebrow（11px mono caps） 取代 strong
│   ─                                                              │
│   「之」在动词后跨过否定词「弗」提前 ... [略]                    │
│                                                                  │
│   │ 例：「弗之怠」≈「弗怠之」：不懈怠它（指学习）。             │  ← example：左竖线 + 缩进 + 微深底
│   │                                                              │
│                                                                  │
│   ┌─⚠ 易错 ─────────────────────────────────────────────────┐  │  ← pitfall：warning callout
│   │ 把「之」误读为定语「的」—— 此处「之」是代词不是结构助词。 │  │
│   └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│   ┌─ 自检 ────────────────────────────────────────────────────┐  │  ← check：嵌 tool_quiz（保持现状）
│   │ Q1. 「沛公军霸上」中「军」的词性 ...                       │  │
│   └────────────────────────────────────────────────────────────┘  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

Hover 任一 section：
   ┌─⚠ 易错 ─────────────────────────────────────────[标错 编辑]┐  ← 右上角浮现，淡出
   │ 把「之」误读为定语「的」...                                  │
   └─────────────────────────────────────────────────────────────┘

Section marked_wrong 后稳态：
   ┌─⚠ 易错  [已标错]  ─────────────────────────[撤销标错 编辑]─┐  ← 徽章上来，常驻；控件仍 hover
   │ 把「之」误读为定语「的」...                                  │
   └─────────────────────────────────────────────────────────────┘
```

## 5. 控件隐现规则

> **CCG synthesis 修正**：原"opacity: 0 完全隐藏 → hover 才出"对触屏 / 键盘用户都有 discoverability 隐患（焦点跳到看不见的控件）。
> 改为**低对比度稳态**：默认 `opacity: 0.2` / `color: var(--ink-5)`，hover / focus-within 恢复正常对比度。Affordance 仍在，只是退背景。

| 控件 | 默认态 | hover / focus-within 时 | 触发态 |
|---|---|---|---|
| `标错` button | 低对比稳态（`opacity: 0.2`，仍可点 / 仍 tab-able） | 恢复正常对比度（100ms 过渡） | active 状态可点 |
| `Edit` button | 低对比稳态 | 恢复正常 | active 状态可点 |
| `撤销标错` button | marked_wrong 时低对比稳态（其他态隐藏） | 恢复正常 | marked_wrong 时可点 |
| `已标错` 徽章 | marked_wrong 时**常驻全对比** | — | 状态变化时切换 |
| 类型 label（定义 / 易错 ...） | 隐藏（视觉 idiom 代替） | — | pitfall 例外：Lucide ⚠ + "易错" 常驻 callout 框上 |
| `AI 单 pass` tier chip | **完全移除**（开发者信息收到全局 debug toggle，见 §11） | — | — |
| 生成状态 / verification chip | 异常态显形（pending / failed / needs_review）；ready + not_required 隐藏 | — | — |
| 标题旁 `⋯` 菜单 | **不做**（CCG 砍）。`note · note_atomic` 直接移走，技术词不进 UI | — | — |

## 6. 触达性

- 所有 hover-only 控件**键盘 focus 时也显形**（`:focus-within` on section）
- 控件 `tab` 顺序：标错 → 编辑 → 撤销标错 → 下一 section
- 触屏：long-press section 显示 sheet 菜单（不依赖 hover）

## 7. Token 映射

完全复用 `app/globals.css` 现有 tokens，**不引入任何新 token**（CCG 修正：原 `--fs-lead: 17px` 砍掉，用字重 + 墨色而非新字号）：

| 用途 | 现有 token |
|---|---|
| definition 字重 | `font-weight: 500` 或 `600`（项目 `--fw-medium / --fw-semibold` 若存在则用 token；否则原值） |
| definition 墨色 | `var(--ink-1)` |
| mechanism 墨色 | `var(--ink-2)` |
| example 左竖线 | `var(--ink-4)` 2px |
| pitfall warning 底 | `var(--again-tint)` |
| pitfall warning 边 | `var(--again-line)` 3px |
| pitfall ⚠ 图标 | Lucide `AlertTriangle`，`stroke: var(--again-line)`，size 14px |
| section 间距 | `var(--s-5)`（比 `--s-4` 大，给阅读节奏） |
| 控件低对比稳态 | `opacity: 0.2`（或 `color: var(--ink-5)` 二选一，实施时取观感更稳的） |

## 8. 实施计划

> **post-grill**：实施合入 YUK-88 phase 表（§0.5）。本 redesign 落在 **P2（TipTap 接入，建 NodeView）+ P6（read-view 落地）**。原有 `ArtifactSections.tsx` 不再是入口 —— 整个组件树被 TipTap-based 渲染替换。下方步骤是 P6 内的 sub-tasks，不独立 PR。

| Step | 内容 | 出处 |
|---|---|---|
| 1 | 实现 `<BlockTreeRenderer>` SSR-only 模式（不加载 editor bundle），共享 P2 的 NodeView 组件按 `block.attrs.semantic_kind` 渲染 5→3 idiom | YUK-88 P2/P6 |
| 2 | css：`.block-semantic--definition` (字重 + ink-1) / `.block-semantic--mechanism` (默认正文 + ink-2) / `.block-semantic--example` (quote 风) / `.block-semantic--pitfall` (warning callout + Lucide) / quiz NodeView 复用 ArtifactRefBlock 样式 | P6 |
| 3 | mark-wrong UI：block hover 浮现 [标错][编辑] 低对比稳态（opacity 0.2）→ hover/focus 全对比；marked_wrong 时「已标错」徽章常驻；触屏 long-press → sheet 菜单。UI 默认聚合到 `nearest_semantic_kind_ancestor` 级展示，可钻取到具体 block（YUK-88 Q10.a） | P6 |
| 4 | `/learning-items/[id]` page：技术词 `note · note_atomic` 移除，标题旁不要 ⋯ 菜单（YUK-88 Q19 接受）；异常态 verification chip 显形规则不变 | P6 |
| 5 | 测试：替换原 ArtifactSections.test.tsx → 新增 `BlockTreeRenderer.test.tsx` 含 5 种 semantic_kind SSR 断言、mark-wrong hover 显形、低对比稳态 a11y 检查；P7 一起跑 | YUK-88 P6/P7 |
| 6 | Smoke：标错 / 撤销 / edit / re-mark 循环不退化（PR #154 smoke 路径在 block 颗粒下重跑） | P6 closeout |

## 9. Out of scope

- **修改 sections schema**（kind 枚举、section_id 稳定性）—— 不动
- **note_long / 中大型主题** —— 独立 planning doc
- **mark-wrong UX 行为**（PR #154 ship 的契约）—— 只重排不改逻辑
- **embedded check 内部布局** —— 保持现状
- **TeachingDrawer** —— 不动

## 10. 相关 docs

- `docs/modules/notes.md §3`（section kind 模板）
- `docs/design/2026-05-25-yuk-54-note-section-edit-in-place.md`（in-place edit 交互）
- `docs/design/loom-design-v2.1/`（design system tokens 来源）
- PR #154 (YUK-85 Sub 3) —— mark-wrong UX 不能退化

## 11. Open

CCG synthesis 已解的：

- ✅ definition 字号 → **不改字号**；用字重 (500/600) + 墨色 (--ink-1) 拉对比，保 wenyan 15px 行高节奏
- ✅ ⋯ 菜单 → **不做**；`note · note_atomic` 直接移走
- ✅ pitfall 图标 → **Lucide `AlertTriangle`**（emoji 跨 OS 渲染割裂；纯色对色盲不友好；Lucide 与 loom-design 一致）

仍 Open：

- **开发者 debug toggle**：用什么键 / 怎么暴露？（CCG 建议全局快捷键如 `~`，但项目目前是否已有 debug 模式 hook 待查）
- `--fw-medium / --fw-semibold` token 在项目里是否已存在？不存在的话本 redesign 是否要引入两个字重 token？（解决方案：实施前 grep 一次 globals.css；缺则当下加，纳入 design system 而非 ad-hoc）
- 控件低对比稳态选 `opacity: 0.2` 还是 `color: var(--ink-5)`？两者都行，落地时取观感稳的；测试阶段对比一次

## 12. CCG synthesis 备注（2026-05-26）

本文档已根据 CCG（Codex + Gemini 双 advisor）建议修订：

- §3 5 idiom → 3（definition + mechanism 合并为默认正文态；用字重 + 墨色而非字号区分）
- §5 控件改为低对比稳态而非 opacity: 0；`⋯` 菜单砍掉
- §7 移除 `--fs-lead` 新 token；纯复用现有 token
- §11 关闭 3 个 open 决策（字号 / ⋯ 菜单 / pitfall 图标）

Gemini artifact: `.omc/artifacts/ask/gemini-ai-next-js-15-app-router-…-2026-05-26T12-30-49-084Z.md`
