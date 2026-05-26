# Planning — Note artifact 扩展 note_long（中大型主题阅读形态）

**日期**：2026-05-26
**状态**：草稿（pending ADR-0020）
**来源**：YUK-85 Sub 3 (PR #154) smoke session 用户反馈
**对应 Linear**：[YUK-88](https://linear.app/yukoval-studios/issue/YUK-88)

---

## 1. 问题陈述

当前 Note artifact schema (`docs/architecture.md:421-437`、`docs/modules/notes.md §2-§3`) 只有两态：

- `note_hub`：大纲（`outline_json` + `child_artifact_ids[]`），**不持正文**
- `note_atomic`：5-section 结构化笔记（`definition` / `mechanism` / `example` / `pitfall` / `check`），**1:1 挂 knowledge 叶子**

对中大型主题（如「氧化还原反应」），当前拆法 → 1 hub + ~6 atomic、每 atomic 5 section、每 section 一两句话 → **单页信息量稀薄、跨页阅读割裂、概念间的内在 link 全靠用户脑补**。

用户原话（2026-05-26）：

> 对于末端节点，atomic 这么做确实是好的。但比如氧化还原反应这个大类，可读性很差，信息量太少。大部分中大型知识点都适合参考 Notion 这些笔记软件，允许挂 label / 有 link / 有层级。

## 2. 已下注的链路（不能轻易丢）

- **YUK-87 Living Note**：`NoteRefineTask` 触发器 6 (user mark_wrong) 直读 `getArtifactCorrectionState` —— 依赖 section 颗粒度
- **YUK-85 PR #154 mark_wrong**：section_id 是稳定 anchor，是 correction event 投影的 join key
- **Embedded check**：1-3 题嵌在 atomic note 的 `check` section（`docs/modules/notes.md §6`）
- **Mastery 投影**：在知识叶子层累积；atomic ↔ 叶子 1:1 是计算前提
- **ADR-0019**：section_id 稳定性 invariant
- **ADR-0006 v2**：artifact 表设计、AI 产出落点

## 3. 三象限对比

### A. atomic 内 section 富文本嵌段（不新增 type）

保留 5-section 骨架，但每个 section 内允许 toggle / callout / nested list / link-to-other-artifact / inline math / code 嵌段。

| 收益 | 代价 |
|---|---|
| 增量改动最小 | 不解决"大主题需要一页流"的诉求 |
| 不破 mark-wrong / mastery / living note | section 颗粒不变 → "中大型主题"还是要拆 ~6 atomic |
| AI pipeline 几乎不动 | 5-section 模板对中大型主题仍是镣铐 |

**结论**：必要但不充分。可作为 B 的预备步（让 atomic 本身更厚）。

### B. 引入第三态 `note_long`（**推荐**）

三态并存：

```
note_hub      ─→ 大纲（不持正文）
note_atomic   ─→ 5-section 结构化（叶子）
note_long     ─→ Notion 式自由 doc（中层节点 / 大主题）
```

`note_long` 特性：
- **挂载粒度**：可挂中层 knowledge 节点（不强制叶子）
- **内容形态**：rich block tree（`body_blocks JSONB`），支持 heading / paragraph / list / callout / toggle / quote / code / math / image / artifact_ref / cross_link
- **生成路径**：新 `NoteLongGenerateTask` —— 独立 prompt，不共享 NoteGenerateTask 的 5-section schema 约束
- **mark_wrong 颗粒**：扩展为 block_id（ADR-0019 后续 ADR-0020 落契约）
- **Living Note**：YUK-87 `NoteRefineTask` 兼容 long block 颗粒（v0 可只对 atomic 生效）

| 收益 | 代价 |
|---|---|
| 增量、可逐步 land | schema + AI pipeline + 阅读视图三套独立流 |
| 不破现有 atomic / mark-wrong / mastery / embedded check 链路 | ADR-0020 + ADR-0019 扩展（mark-wrong block-id 颗粒） |
| YUK-87 Living Note 可分期支持 | 两类 note 的 verification / refine prompt 各写一套 |
| 用户对中大型主题立即有"Notion-like 一页流"体验 | 阅读组件复用率低（atomic vs long 不共用） |

### C. 重写整层 —— 统一一种 `note` + section anchor

取消 hub / atomic 区分，所有 note 都是自由 doc；mastery / mark_wrong 改挂 anchor。

| 收益 | 代价 |
|---|---|
| 最像 Notion / 最自由 | 推翻 ADR-0006 v2 + ADR-0019 + LearningIntent orchestrator + NoteGenerate-Verify + Living Note 全链路 |
| schema 最简 | 月级工程；推翻已 ship 的 4+ ADR |
| Mastery / embedded check 全部重设投影 |

**结论**：成本不可承受。否决。

## 4. 推荐方向：B

理由：
- **增量**：不破 ship 中的 mark-wrong / mastery / embedded check
- **可逐步**：P1 ADR + schema → P2 AI pipeline → P3 阅读视图 → P4 mark-wrong + living note 兼容
- **兼容 YUK-87**：Living Note v0 可只对 atomic 生效，long 后跟进
- **用户立即受益**：中大型主题的"Notion-like 一页流"在 P3 就可见

## 5. 阶段拆分

### P1 — ADR + Schema（~3 pts）

- ADR-0020：`note_long` 第三态契约
  - schema 字段（`type='note_long'`、`body_blocks JSONB`、block_id 稳定性 invariant）
  - 挂载约束（可挂中层节点 / 不强制叶子 / 与 hub-atomic 互斥）
  - mark-wrong 颗粒契约（block_id 扩展 ADR-0019）
- Drizzle migration：`artifact` 表加 `body_blocks JSONB nullable`
- `audit:schema` allowlist 处理（body_blocks 暂无 write path）

### P2 — AI Pipeline（~5 pts）

- `NoteLongGenerateTask` 注册 + handler
- `NoteLongVerifyTask` 注册 + handler
- `LearningIntent` orchestrator 路由：按知识节点层级 / outline hint 决定 atomic vs long
  - 中层节点 → `note_long`
  - 叶子节点 → `note_atomic`
- pg-boss `note_long_generate` queue + worker

### P3 — 阅读视图（~5 pts）

- `<NoteLongRenderer>` 独立 component（不复用 ArtifactSections）
- block-tree 渲染器（heading / paragraph / list / callout / toggle / quote / code / math / image / artifact_ref / cross_link）
- 嵌 atomic block_ref → 内联展开 / link-jump 二选一
- 跨知识点 cross_link → 解析为 knowledge_id / artifact_id

### P4 — mark-wrong + Living Note 兼容（~3 pts）

- ADR-0019 扩展：block_id 作为 mark-wrong subject scope
- POST `/api/artifacts/[id]/correct` 接受 `block_id`
- 投影 `getArtifactCorrectionState` 扩展返回 blocks map
- UI：long doc 内 block hover → 标错入口
- Living Note (YUK-87) `NoteRefineTask` v0 仍只读 atomic；long 颗粒留 future

**Total**：~16 pts；可分 4 PR chain-merge

## 6. 待决问题（P1 ADR 解决）

1. **block tree 是否走 ProseMirror / TipTap schema** vs 自定义 JSON？
   - ProseMirror 节点已有大量周边（serialize / extension），但学习曲线 + bundle size
   - 自定义 JSON 更轻，但要自己写 ser/de + 编辑器（如果要编辑）
2. **note_long 是否支持 inline 编辑**？
   - v0 read-only（AI 写）就够；编辑器留 future
3. **note_long 与 note_hub.outline_json 的关系**？
   - 选项 a：long 取代 hub（hub 退化为只是一个 long 实例）
   - 选项 b：long 嵌套在 hub 下，作为 hub 的"长版叙述"
   - 选项 c：完全独立，hub 仍管大纲，long 独立挂中层节点
   - 倾向 c（隔离最强、增量最稳）
4. **embedded check 是否可挂在 note_long**？
   - v0 不挂；check 仍是 atomic 专属
   - future：long 内 callout-style check block
5. **跨 artifact link 的语义**：
   - cross_link 是否会触发 mastery 联动？
   - 是否走 knowledge graph 边？

## 7. 风险

| 风险 | 缓解 |
|---|---|
| AI pipeline 两套 prompt 维护成本 | 共享 system prompt 骨架；differ 部分在 user prompt 模板 |
| 用户混淆 atomic / long 边界 | 不暴露 type 给用户；按知识节点层级自动路由 |
| long doc 太自由，AI 输出失控 | NoteLongVerifyTask 做结构 + 覆盖度 check（同 NoteVerifyTask 路径） |
| YUK-87 Living Note 推迟 long 支持 | v0 文档显式声明：long 不参与 Living Note v0 |

## 8. 相关 docs

- `docs/architecture.md` § Artifact 多态化
- `docs/modules/notes.md` § 1-§7
- ADR-0006 v2（artifact 表）
- ADR-0019（section_id 稳定性）
- ADR-0020（待写：note_long 契约）
- YUK-85（mark-wrong section 颗粒）
- YUK-87（Living Note）

## 9. Open

- 是否要先做 A（atomic section 嵌段）作为 B 的预备步？
- LearningIntent orchestrator 的 atomic vs long 路由信号：层级硬规则 vs AI 软判断？
- block tree schema 拍板时机（P1 ADR 时 vs P2 实现时）
