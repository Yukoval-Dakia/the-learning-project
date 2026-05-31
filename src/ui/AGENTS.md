# src/ui — 共享 React 设计系统

> 客户端组件层（React 19 + Tailwind v4 CSS-first + Zustand + TanStack Query）。**写任何 UI 前先做 design-doc pre-flight**（见 [CLAUDE.md § UI Design Compliance](../../CLAUDE.md)）：逐字引用 design doc 段落 + 声明组件类型 + 列出 touch 文件，等批准再动手。

## WHERE TO LOOK
| 目录 | 职责 |
|------|------|
| `primitives/` | 设计系统底层原子（design-system tokens / 基础组件）——优先复用，别重造 |
| `lib/` | 共享 hooks / client helpers / fetch 封装 |
| `components/` | 跨页面复合组件；`NoteRenderer/` 渲染 Living Note body-blocks |
| `block-tree/` | block tree 编辑/展示（TipTap 相关）|
| `correction/` | 批改 / 错题修正 UI |
| `review/` · `today/` · `admin/` | review 流 / today plan / 管理面专用组件 |
| `KnowledgeGraph.tsx` | cytoscape + fcose 知识图谱可视化 |
| `Providers.tsx` | 全局 Provider（Query client / store）——app layout 挂载 |

## CONVENTIONS
- 组件落地必须用既有 design-system tokens / primitives；pre-flight 与 tokens 规则叠加生效。
- 编辑器栈 = TipTap 3（`@tiptap/*`）；图谱 = cytoscape；数学 = KaTeX（`rehype-katex`/`remark-math`）。
- 纯 UI/组件测试进 unit config（无 DB）：`pnpm test:unit:watch`。

## ANTI-PATTERNS
- 浏览器代码**不持** provider key——所有 LLM 调用走 `/api/*` route。
- 别在客户端直接 import `src/server/*`（server-only）。
