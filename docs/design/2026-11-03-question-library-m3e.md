# 题目（题库）列表与单题页：M3E 呈现

YUK-1473 · 2026-11-03 · 交付阶段：第一天能用（删旧界面第 1 页）

## 设计 preflight

1. 设计依据（逐字）：
   - `docs/design/2026-10-27-m3e-direction-and-migration.md:95`（§5「其余真实页面」）：「先统一题库 `practice/ui/library/` 的行/详情/编辑呈现，再录入 `ingestion/ui/record/` 的列表/详情/复核呈现」；同行保留栏：「题库 `library-client.tsx`、`use-library.ts`、`use-question-writes.ts`、`library-api.ts` 的读取/写/失效 … 归各线」。
   - 同文件 `:98`：「未迁页面保留旧基座外观；以后每片消费 M3E 后退出自己的旧样式，不按目标行数批量拆组件。」
   - 同文件 `:100`：「作用域、无全局污染、同源资源、无业务规则等承重限制保留。… 具体实施需列出发生冲突的规则及依据，不静默扩大路径权限。」
2. 组件类型：page ×2（`/questions` 列表、`/questions/$id` 单题），无新路由、弹窗或抽屉。
3. 文件：
   - 新建：`src/ui-next/primitives/FoldList.tsx`；本文件。
   - 修改：`src/ui-next/components.css`（FoldList 样式）；`src/capabilities/practice/ui/library/` 下 `library.css`、`library-rows.css`、`question-history.css`、`MistakesView.tsx`、`MyHistory.tsx`、`QuestionPaper.tsx`。

## 做了什么

- **颜色**：两页的 `main` 列把旧 `--un-*` 颜色别名改指到 Google M3 角色（surface 层级、on-surface / on-surface-variant、outline / outline-variant、primary / on-primary、secondary-container、error-container）。M3 角色由外壳 `RootShell` 的 M3E 作用域提供，随应用主题切换亮暗。
  - 改指写在 `main` 上，而不写在 `[data-ui-next]` 根上：基础 token 的暗色规则以更高特异度命中根节点，写在根上会被暗色主题覆盖回旧配色。
  - `--un-hairline` 是线宽，不改。positive / caution 没有对应的 M3 角色，保留原语义色。
- **字体**：页面标题从衬线 `fs-6` 改为与今日、练习列表一致的 `600 32px/1.25`（窄屏 24px）。
- **折叠列表**：做错记录、作答历史、题面附件三处，从 `src/ui/primitives/CollapsibleList`（旧基座）换成 ui-next 的 `FoldList`。行为相同：默认显示 3 条、折叠项不渲染、`aria-expanded`/`aria-controls`；图标改用 lucide。

## 不变

查询 key、分页、筛选、计数、partial 读、错误与重试、写入与失效、审核与删除恢复、URL 视图与范围、伙伴焦点发布：都没有改。没有改 TSX 结构，也没有新增 effect。

## 与 `src/ui-next/AGENTS.md` 的冲突

该文件写着「never edit `src/ui/`」（I4）。本片遵守，没有修改或删除 `src/ui/primitives/CollapsibleList`：它还有知识详情、笔记阅读、事件详情、做题、今日 AI 改动条 5 个使用方。按上面 `:98` 的规则，每个使用方页面迁到 M3E 时换成 `FoldList`；最后一个换完的那一片删除旧组件。届时会列出与 I4 的冲突，依据是 Owner 2026-10-20「旧界面全部删除」和 2026-11-03 的目标。

## 验收边界

- 本地：typecheck、lint、build、CI 三组 audit。
- 未做：真实浏览器亮暗、窄屏与键盘观察；交付回执里如实标注。
