# Design — atomic note 阅读页 UI/UX redesign

**日期**：2026-05-26
**状态**：草稿
**来源**：YUK-85 Sub 3 (PR #154) smoke session 用户反馈
**对应 Linear**：[YUK-89](https://linear.app/yukoval-studios/issue/YUK-89)

> **解耦声明**：本 doc 只处理**叶子级 `note_atomic` 的阅读体验**，不动 schema / 不动 AI pipeline / 不动 ADR。
> 中大型主题阅读形态（`note_long`）见 `docs/planning/2026-05-26-note-rich-doc.md`，独立架构线。

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
4. **节奏感**：definition lead → mechanism 主干 → example 引言 → pitfall warning → check 嵌测
5. **不退化功能**：mark-wrong / edit / 撤销标错 全路径保留（hover 出，键盘可达）

## 3. Section 类型差异化方案

| kind | 视觉 idiom | 用途 |
|---|---|---|
| `definition` | **Lead paragraph** —— 加大字号 (17px)、轻微上 padding、无 chrome | 「这是什么」第一印象 |
| `mechanism` | **主干段** —— 默认 wenyan 15px、无装饰 | 「怎么运转」结构化阐述 |
| `example` | **Quote 风** —— 左侧 `var(--ink-4)` 2px 浅竖线 + 轻 paper-raised 底 + 缩进 | 「举个例子」语义上是引用 |
| `pitfall` | **Warning callout** —— 左侧 `var(--again-line)` 3px 竖线 + `var(--again-tint)` 微红底 + ⚠ 图标可选 | 「易错！」需要视觉权重拉起警觉 |
| `check` | **嵌测 card** —— 独立 paper-raised 块 + 题目编号 + 互动控件（保持现状） | embedded tool_quiz |

## 4. ASCII mock

```
┌──────────────────────────────────────────────────────────────────┐
│ ← 返回                                              📝 阅读 / 学习 │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   「弗之怠」中「之」的宾语前置                              [⋯ ]  │  ← 标题：17px 加粗 + ⋯ 菜单（替代 note · note_atomic 技术词）
│   文言文 · 进行中                                                │  ← subtle subhead；状态 chip 收进这一行
│                                                                  │
│ ─────────────────────────────────────────────────────────────── │
│                                                                  │
│   之 在「弗之怠」中作宾语前置代词，复指动词后被省略的宾语「学」。│  ← definition：17px lead，无 chrome，无类型 label
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

| 控件 | 默认态 | hover section 时 | 触发态 |
|---|---|---|---|
| `标错` button | 隐藏 | 浮现（淡入 100ms） | active 状态可点 |
| `Edit` button | 隐藏 | 浮现 | active 状态可点 |
| `撤销标错` button | 隐藏 | 浮现 | marked_wrong 时可点 |
| `已标错` 徽章 | marked_wrong 时**常驻** | — | 状态变化时切换 |
| 类型 label（定义 / 易错 ...） | 隐藏（视觉 idiom 代替） | — | pitfall 例外：⚠ 图标 + "易错" 一直在 callout 框上 |
| `AI 单 pass` tier chip | 隐藏 | 浮现（折叠在右上角 meta） | — |
| 生成状态 / verification chip | 异常态显形（pending / failed / needs_review）；ready + not_required 隐藏 | — | — |
| `⋯` 菜单 | 标题旁常驻 | — | 含「查看 raw」「note_atomic 元信息」给开发用 |

## 6. 触达性

- 所有 hover-only 控件**键盘 focus 时也显形**（`:focus-within` on section）
- 控件 `tab` 顺序：标错 → 编辑 → 撤销标错 → 下一 section
- 触屏：long-press section 显示 sheet 菜单（不依赖 hover）

## 7. Token 映射

复用 `app/globals.css` 现有 tokens，不引入新 token：

| 用途 | 现有 token |
|---|---|
| definition lead 字号 | `--fs-lead`（新加，17px）或复用 `--fs-h3` |
| example 左竖线 | `--ink-4` 2px |
| pitfall warning 底 | `--again-tint` |
| pitfall warning 边 | `--again-line` 3px |
| pitfall warning 文字 | `--ink`（不改 ink，靠底色对比） |
| section 间距 | `--s-5`（拉到比 --s-4 大，给阅读节奏） |

如需新增：仅 `--fs-lead: 17px`，加在 `:root` 字号区。

## 8. 实施计划

| Step | 内容 | 文件 |
|---|---|---|
| 1 | 改 ArtifactSections.tsx：section type → visual idiom 映射；控件 hover 隐现；状态 chip 折叠 | `src/ui/components/ArtifactSections.tsx` |
| 2 | 改 globals.css：`.artifact-section--definition / --mechanism / --example / --pitfall / --check` 类型差异化 css；hover 控件浮现；状态 chip 折叠 | `app/globals.css:2030-2120` |
| 3 | 改 `/learning-items/[id]` page.tsx：`note · note_atomic` eyebrow 改语义化文案或隐藏；状态条折叠 | `app/(app)/learning-items/[id]/page.tsx:478-507` |
| 4 | 测试：ArtifactSections.test.tsx 12 例不退化 + 新增 visual 类型差异化 SSR 断言 | `src/ui/components/ArtifactSections.test.tsx` |
| 5 | Smoke：标错 / 撤销 / edit / re-mark 循环不退化（重跑 PR #154 smoke 路径） | Playwright |

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

- definition 用 17px 还是 16px？（受 `--fs-lead` 决策影响）
- ⋯ 菜单内容是否值得做？还是单纯把 `note · note_atomic` 移走就够？
- pitfall ⚠ 图标走 icon font (lucide) 还是 emoji？项目里现有 icon 系统倾向？
