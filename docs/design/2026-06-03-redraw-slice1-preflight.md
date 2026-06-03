# Redraw Slice 1 — design pre-flight（基座 + app shell + NoteReader）

> **Status**: Pre-flight, awaiting user approval（CLAUDE.md UI 规则：动 UI 代码前先 pre-flight + 批准）。
> **Source**: loom-prototype（`docs/design/loom-prototype/`，claude.ai/design `loom-refresh` 导出）+ workflow `wosy6p2l2` 逐字抽取。YUK-169 / YUK-203 P5。

---

## 0. 重大前提修正（workflow 实测，已 grep 核实）

- `app/globals.css` **已经是 6600 行 Tailwind v4 `@theme` 的 loom token port**（`--color-coral #d97757`、`--color-paper #faf9f5`…）。loom 视觉 token **已在仓库**——**不删、只扩**。
- 老 `src/ui/primitives/*` 被 **~40 文件** import（Button×23 / Badge×21 / PageHeader×18 / Card×14 / Icon×8）。一次删 = 炸所有未重绘 surface。
- 结论：**"drop 老 UI" = additive + per-slice 退役**，不是 mass-delete。新 loom primitives 用**新名**与 legacy 并存；每个 surface 重绘落地时退役它依赖的 legacy 件。globals/`(admin)` group 保留。

## 1. 组件类型声明（CLAUDE.md 要求）

| 类型 | 物 |
|---|---|
| **设计基座** | self-host 字体（next/font/local）· `globals.css` 扩展（dark mirror + shell vars + 组件 class 层 + note-reader class）· 新 `src/ui/primitives/` loom 件（additive） |
| **layout（app shell）** | `app/(app)/layout.tsx` 由 TopNav+TabBar → **sidebar-primary** shell（左 rail + topbar + mobile tabbar + drawer） |
| **page（route）** | `app/(app)/notes/[id]/page.tsx` 视觉层重写为 loom **3-column NoteReader**（复用 codex 数据层） |

## 2. 逐字引 loom-prototype（设计依据）

**基座 · tokens.css** — `docs/design/loom-prototype/tokens.css`：
- L4-11「The single source of truth for Loom's visual language. A warm, Claude-ish system tuned for Chinese-first reading: one coral accent, everything else warm paper + warm ink.」
- L27-51 paper/ink/line/coral 原语（`--paper #FAF9F5`、`--ink #1F1E1D`、`--coral #D97757`…）；L58-79 FSRS 语义色（again/hard/good + info）；L85-94 字体（`--font-serif: "Source Serif 4"…`、`--font-sans: "Noto Sans SC"…`）；L96-118 type scale + lh + ls；L123-155 4pt spacing / radii / shadow / motion / caps（`--cap-prose 680 / --cap-wide 1200`）。

**shell · app.jsx** — `docs/design/loom-prototype/app.jsx`：
- 左 `<aside className="sidebar">`：BrandMark → 分组 `<nav>`（section「织造」today/review(12)/record，「整理」inbox(9)/mistakes(3)/questions/items/knowledge）→ `sidebar-foot`（Copilot · Admin→admin/runs · profile + theme toggle）。
- 右 `<div className="main">`：`<header className="topbar">`（mobile menu · rail 折叠 · 面包屑 Loom/<title>/<param> · 搜索 ⌘K · Copilot）+ `<main key={route}>` 挂 Screen。
- mobile `<nav className="mobile-tabbar">`（today/review/record/knowledge/更多）。
- 路由：hash `parseRoute` 首个 `/` 切 `{base,param}` → **映射 Next App Router**：`base`→`(app)/<surface>/page.tsx`，`base+"/"`→`[id]/page.tsx`，`go(r)`→`router.push('/'+r)`，active 用 `usePathname()`。
- **admin 独立 shell**：`base==='admin'` 只渲染 AdminShell——已对应仓库现有 `app/(admin)/` group，sidebar 仅 link 过去。

**NoteReader · screen-note-reader.jsx + note-reader.css**：
- `.note-reader-grid: 220px minmax(0,1fr) 300px`：左 `.note-rail-left`(Outline) · 中 `.note-doc-col`(max `--cap-prose`) · 右 `.note-rail-right`(Context)。`.note-topbar`（back-link by entry context · `/notes/{id}` pill · outline toggle · read/edit seg · context toggle）。响应式 ≤1180 隐右 rail（抽屉）、≤880 单列（左 rail 抽屉）。
- 中列：`.note-entry-banner`（"你经由 {知识点|学习项} … 打开这篇笔记 · 同一篇另有 N 个入口"，driven by `?from=`）· `.note-doc-head`（eyebrow `NOTE · note_id · labels[]` / serif 标题 / label chips / verify badge / 更新·from）· `.note-entries-strip`（入口 pills，当前门 `.is-here`）· read body / NoteEditor。
- 右 Context 四段：属性（状态/更新/作者/块数）· 被这些 knowledge 标签命中 · 相关学习项 · 活动·版本 timeline。

## 3. Touch 文件清单

**NEW — loom primitives（additive，新名不撞 legacy）**：`src/ui/primitives/` 下 `LoomIcon.tsx`（components.jsx ICONS 逐字 port，size18/stroke1.8）· `Btn.tsx` · `IconBtn.tsx` · `BrandMark.tsx` · `SectionLabel.tsx` · `EmptyState.tsx` · `Ring.tsx`(+`useCountUp.ts`) · `SkLines.tsx` · `ErrorState.tsx` · `Stateful.tsx`(+`useFocusTrap.ts`) · `index.ts`（barrel，**不** re-export legacy）。

**NEW — shell**：`src/ui/shell/` 下 `AppSidebar.tsx` · `AppTopbar.tsx` · `MobileTabBar.tsx` · `nav-config.ts`（NAV/MOBILE_NAV/TITLES/ROUTE_MAP/activeFromPath，含 inbox/coach/events/sessions/notes/questions）。`src/ui/lib/note-actor.ts`（从 history[].by 派生 作者/版本 actor + ACTOR_ICON）。

**MODIFY**：`app/layout.tsx`（self-host 字体 next/font/local，暴露 `--font-serif/--font-sans`）· `app/globals.css`（**扩展**：fonts swap 去 Google CDN + dark mirror + shell vars + 组件 class 层 + note-reader class + 响应式 @media；**不重复已有 @theme token**）· `app/(app)/layout.tsx`（换 sidebar shell；保 TokenGate；theme 复用现有 `data-theme`+localStorage、不引第二 key）· `app/(app)/notes/[id]/page.tsx`（**只换视觉 JSX**，复用 codex 的 query/`?from=`/BlockTreeRenderer/ArtifactBlockTree 数据层）。

**REUSE（不动）**：`src/ui/block-tree/*`（读=BlockTreeRenderer，编辑=ArtifactBlockTree——**不**重造 prototype 的 note-editor）· `src/ui/lib/{api,math-markdown,utils(formatRelTime)}` · `src/ui/Providers.tsx` · `src/server/artifacts/note-page.ts`（后端 GET /api/notes/[id]）· `Card.tsx`/`Button.tsx`（已 className 化，非 shell 处续用）。

**KEEP-LEGACY（本刀不删）**：`src/ui/primitives/{Button,Badge,Card,Icon,PageHeader,TopNav,TabBar,…}` + 其它 surface 的 `app/(app)/*/page.tsx`——它们在新 shell 下继续跑老视觉，随各自 slice 退役。

## 4. 数据映射 NotePage → NoteReader

**干净映射**：id/type/title/knowledge_ids+labels/verification_status(+summary)/version+history/body_blocks(→BlockTreeRenderer)/sections+embedded_questions(→ArtifactBlockTree)/related_learning_items/created_at+updated_at(→formatRelTime)/`?from=`(client)。

**缺口 + 处理**：
1. **作者/版本 actor**：后端无顶层 author，只 history[].by(AgentRef)。→ 新 `note-actor.ts` 派生；history 空则省略 作者 行。
2. **embedded-quiz 答案揭示**：prototype 是 mock；后端 embedded_questions 无 answer。→ 走 BlockTreeRenderer 既有 check 渲染，**不** port 答案揭示。
3. **BlockLinkCard mastery%**：prototype mock；后端无 per-link mastery。→ 本刀 **drop pct**（cross_link 仍经 BlockTreeRenderer 渲染）。
4. **related-item icon/color**：后端只 {id,title,status,relation}。→ 默认 items 图标 + relation 着色（primary→coral / label→info）。
5. **backlinks（额外保留）**：后端有 backlinks_by_type，prototype NoteReader 没这区，但 codex 现页有"反向链接"——**保留**为额外 drawer-sec（后端撑得起，比 prototype 多一块功能，不丢）。

## 5. 风险 + 缓解

- **老 primitive 级联（最高）**：~40 文件引 legacy → 新件 additive、legacy 留到各 surface 重绘；barrel 不盖 legacy 名。
- **globals 不是旧 Vite 文件**：已是 6600 行 @theme port → **扩展非替换**，append 前先 audit 防 `--color-*`/selector 重复。
- **字体**：MiSans-Normal.ttf 8.2MB → next/font/local subset/preload，别裸 @font-face 发 8MB；只有 Regular/Normal 单字重，@theme 引 400/500/600 → 可能合成粗体或补字重。
- **Tailwind v4**：loom.css 的 reset/组件 class 必须在 `@theme` 外（raw CSS / `@layer`），别打架 preflight；`pnpm build` 是唯一能抓 CSS-layer + Next route-export 的 gate（YUK-67）。
- **dark mode**：复用现有 `data-theme` + localStorage `loom-theme`（THEME_BOOT 已落），新 theme toggle 不引第二 key。
- **Copilot**：复用现有 `TodayCopilotDrawer`，不 port prototype 的 `window.__openCopilot` 全局。

## 6. Build order + verify gate

字体 → globals 扩展（`pnpm build` 早验 CSS）→ loom primitives → shell 件 + nav-config → 换 `(app)/layout.tsx`（验所有 surface 仍挂载）→ note-actor → 重写 `/notes/[id]` 视觉 → **verify**：typecheck / lint(touched) / build（route+CSS）/ 跑 /notes/[id] read+edit + `?from=` + 移动断点。像素打磨按项目规则留后。

---

*批准后按 build order 实施（TDD where applicable，gate 全绿 + 独立 review + PR）。本刀只立基座 + shell + NoteReader，其它 surface 各自后续 slice。*
