# Phase 1c Spec Addendum — Loom Design System 对齐

**Date**: 2026-05-15
**Status**: addendum，覆盖 / 修订 `docs/superpowers/specs/2026-05-14-phase1c-design.md` 中与 UI 相关的决策
**Source**: `docs/design/loom-design/`（HTML/CSS/JS 高保真原型，2026-04-24 至 2026-05-10 设计迭代产物）

---

## 为什么

`docs/design/loom-design/` 是 Yukoval Studios 用 Claude Design 做的完整 design system —— 不是 mockup，是 **design tokens + voice / content guidelines + 6 个 screen 原型**。Phase 1c spec D6 + D2 写的"待 frontend-design grill 后选自建 vs shadcn / UI 页面分配"在 loom 里**已经有具体答案**，且比我 sketch 时拍的更系统。

本 addendum 把 loom 的产物 import 进 Phase 1c spec，并更新若干 D-decision。

---

## L1（updates D2 + 推翻 shadcn 决策）：组件库 = loom Primitives，不用 shadcn

**修订原因**：
- shadcn 带 Radix 默认审美 + 自己的 token 体系；loom 的核心 brand decision 是 **warm paper + 单一 coral + 零装饰**，引入 shadcn 等于把 brand 让位给框架默认。
- loom 已经写好 `Primitives.jsx`：`<Brand> <Icon> <Button> <Badge> <StatusBadge> <CauseBadge> <Card> <PageHeader> <TopNav> <TabBar>`——共 10 个原子，~130 行。比装 shadcn 还少。
- 用 OSS 解成熟问题这条原则在此**不适用**：审美决策无现成 OSS 等价物可替。

**新做法**：
- 直接 port loom 的 Primitives.jsx 到 RSC + Tailwind v4
- 用 **`lucide-react`** 替 loom 的 inline SVG（loom README 自己说"closest match is lucide-react directly"——只是 prototype 时为了 zero-dep 内联）
- design tokens 来自 `docs/design/loom-design/project/colors_and_type.css` —— port 进 `app/globals.css` 的 Tailwind v4 `@theme` 块
- 复杂组件（dialog / sheet / popover / select / form）**按需自建**或在 loom 没覆盖时引入 `@radix-ui/react-*` 头部（不上整个 shadcn）

**接受的代价**：
- 启动慢 0.5-1 day（vs shadcn `pnpm dlx init` 5 分钟）
- accessibility 自己保证（loom 没明确写但代码里有 aria-hidden / type="button" / kbd 等基础姿势）

**回滚条件**：如果 6 个月内发现 loom 风格难维护、用户希望换 mainstream 审美 → 切 shadcn 是机械 PR（CSS 变量换名 + 组件文件换实现）。

---

## L2（updates Phase 1c.2 plan 页面列表）：6 页 + 1 拆 1 合

**原 Phase 1c.2 sketch 的 5 页**：`/review` + `/inbox` + `/capture` + `/knowledge` + `/history`

**loom 拍板的 6 页**（按导航顺序）：

| 路由 | screen | 关键 |
|---|---|---|
| `/today` | TodayScreen + OrchestratorPanel | **新增 · 最高价值**：4 KPI strip（FSRS 到期 / 归因中 / 学习项 / 知识点数）+ 3-lane orchestrator（A Review / B Learning Intent / C Coach）+ Task Dispatcher details + cost ledger 链接 |
| `/record` | RecordScreenUnified | **合并** `/capture` + `/inbox`：3 mode tab（manual / vision_single / vision_paper），全部走同一 IngestionSession 状态机；vision tab 内含 pipeline trace + block 编辑 + 合并 + 批量 import |
| `/review` | ReviewScreen | 与 sketch 一致 + 键盘 1/2/3 评分 + cause 顶部显示 |
| `/mistakes` | MistakesScreen | **新增**：错题列表（post-1c.1 改 encounter where outcome='wrong'），CauseBadge 显示 AI/user provenance + confidence |
| `/learning-items` | ItemsScreen | **新增**：学习项 TODO，segmented filter + 状态 transitions（pending → in_progress → done → 重学） |
| `/knowledge` | KnowledgeScreen | 与 sketch 一致 + AI proposals 链接（`/knowledge/proposals` 留 Phase 1d） |

**砍掉 `/history`**：loom 在 `/today` 顶部"KPI strip"+ "今日学习安排"+底部"近期"已经覆盖了"看自己干了啥"的需求；全 session 历史延到 Phase 1d（learning_session 多 type 都活起来后再统一画）。

**Mobile**：loom TabBar 有 5 个 tab（drop `/learning-items`），按 760px 切换。

---

## L3（new D9）：design tokens lift 进 `app/globals.css` Tailwind v4 `@theme`

`docs/design/loom-design/project/colors_and_type.css` 是 single source of truth。port path：

```css
/* app/globals.css */
@import "tailwindcss";

@theme {
  /* ── paper / ink / line（来自 colors_and_type.css） */
  --color-paper: #FAF9F5;
  --color-paper-sunk: #F5F1E8;
  --color-paper-raised: #FFFFFF;
  --color-ink: #1F1E1D;
  --color-ink-2: #3D3B36;
  /* ... 完整列表见 source */

  /* ── coral 单一 accent */
  --color-coral: #D97757;
  --color-coral-hover: #C2553A;
  --color-coral-press: #A93F26;

  /* ── FSRS · 3 档（仅 review buttons + CauseBadge 用） */
  --color-again: #B5341B;     /* 不会 */
  --color-hard: #A87519;      /* 模糊 */
  --color-good: #4A7C59;      /* 会了 */

  /* ── fonts */
  --font-serif: "Source Serif 4", "Noto Serif SC", "Songti SC", serif;
  --font-sans: "MiSans", "PingFang SC", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Source Han Mono", monospace;

  /* ── radii / spacing / shadows / motion 同 source */
}
```

**字体配送**：
- `Source Serif 4` / `Noto Serif SC` / `JetBrains Mono` 通过 Google Fonts CDN（loom 已确认 CDN 路径）
- `MiSans` 无公开 CDN —— 若要 ship，下载 ttf 放 `public/fonts/MiSans-Normal.ttf` + `@font-face`；否则回落 PingFang SC（Apple OS 原生）

---

## L4（Sub 0c 集成）：`/record` vision flow 需要重写

loom 的 `Ingest.jsx` 是 Sub 0c **之前**写的，pipeline 只有 4 阶段（uploaded → extracted → reviewed → imported），用 "模拟上传 + 提取" 单次 click 完成。现实是 Sub 0c 异步 lane：

**1c.2 实施时需要把 vision flow 改成**：

```
uploaded → (用户点 "开始抽取") → POST /api/ingestion/[id]/extract
  → 状态进 queued + boss.send
  → 同时 GET /api/ingestion/[id]/events 开 SSE
  → 收到 ingestion.extracting → UI 进度条进 30%
  → 收到 ingestion.extraction_completed → UI 显示 blocks + layout_quality badge
  → 若 layout_quality='partial' → 用户可点 block "救援 Tier 2/3"
     → POST /api/ingestion/[id]/rescue → 同步替换该 block
  → 用户合并 / 编辑 / 标记 ignore
  → 点 "批量导入" → POST /api/ingestion/[id]/import
```

**新增/扩展 UI 元素**（loom 没画）：
- **SSE 进度条** 替代 loom 的 "模拟" 按钮 → 每个 stage 实时 dot 推进
- **layout_quality badge** —— `structured` 不显，`partial` 显 amber `布局部分识别`，`text_only` 显 amber `仅文本识别`
- **救援按钮** per block —— `Vision Tier 2` (haiku) / `Vision Tier 3` (sonnet)，显示成本估算
- **extraction_evidence 展示** —— Tencent 内置判分（`evidence.tencent_grading`）用 info-tone badge "Tencent · {RightAnswer}"；手写答案（`evidence.handwriting[]`）以 highlight bbox 形式画在原图上

loom 已有的 vision flow shape（IngestPipelineTrace + block-list + merge）保留；只把假数据换成 SSE 真数据 + 上述新元素。

---

## L5（Phase 1c.1 encounter rename 影响 UI 文案）

design 写于 encounter 抽象之前，文案里 "错题 / mistake" 出现 ~30 处。Phase 1c.1 落地时同步 refresh：

| 当前 loom 文案 | 1c.1 后 |
|---|---|
| 「错题列表」（MistakesScreen）| 保留——`/mistakes` 是 `/encounters?outcome=wrong` 的别名路由 |
| 「+ 录新错题」 | 「+ 录新 encounter」 ✘ —— **保留中文 "错题"**（这是用户语义不是 entity 名） |
| `mistakes` table reference / `Mistake` entity 命名 | 改 `encounter` / `Encounter` |
| `cause` 字段 | 改 `evidence.cause`（per-outcome Zod schema） |
| `wrong_answer_md` | 改 `evidence.wrong_answer_md` |
| KPI "归因中" 计数 | 仍用 `cause` 字段—— `encounter where outcome='wrong' AND evidence.cause IS NULL` |

**原则**：**用户面中文不变**（"错题"、"归因中"、"复习" 是 domain 语言），**code 层 entity 名变**。

---

## L6（chat caveat → Phase 1d / Phase 2 工作）

loom 设计师自陈未画 / stub：

- **B lane（Learning Intent）+ C lane（Coach）** —— OrchestratorPanel 里 disabled stub。本 Phase 不做；Phase 2A 后才有 learning_intent 数据。
- **`Passage` / 长文阅读 layout** —— 文言文长段落渲染（line-height 1.85 + 字体）；CSS token 已有，但 page 形态待 SourcePack 落地一并设计。
- **`SourcePack` / Exa retrieval** —— Phase 2 SourceRetrievalTask 相关 UI。
- **AI auto-merge（BlockAssemblyTask）** —— Phase 2；当前是用户手动合并（B path）。
- **`/knowledge/proposals` review queue** —— Phase 1d 加（dreaming_proposal 表已存在，路由占位）。
- **BackgroundTask retry UI** —— pg-boss 重试在 `/api/_/logs/jobs` 看，UI 暂不画。
- **`/_/inspect` debug page** —— 管理端，Phase 2+。
- **dark mode** —— 不做。

---

## L7（资源清单）：1c.1/1c.2 实施时直接 ingest

| 资源 | 路径 | 用途 |
|---|---|---|
| Design tokens | `docs/design/loom-design/project/colors_and_type.css` | port 进 `app/globals.css` `@theme` 块 |
| 品牌 monogram | `docs/design/loom-design/project/assets/loom-monogram.svg` | `<Brand>` 组件 |
| 品牌 wordmark | `docs/design/loom-design/project/assets/loom-wordmark.svg` | logo lockup |
| PWA icons | `docs/design/loom-design/project/assets/icon-{192,512}.png` | `public/` 直接复制 |
| Primitives 模板 | `docs/design/loom-design/project/ui_kits/loom-app/Primitives.jsx` | port 到 `src/ui/primitives/` 各文件 |
| 6 个 screen 模板 | `Today.jsx` / `Ingest.jsx` / `Screens.jsx` | port 到 `app/today/page.tsx` 等 |
| 单卡 preview（颜色 / 字体 / 间距 / 组件 / 行为 等 22 张） | `docs/design/loom-design/project/preview/*.html` | 设计 reference，浏览器打开比对 |
| Voice / content / brand guideline | `docs/design/loom-design/project/README.md` § Content + Visual Foundations | 写代码时遵循（emoji ban / 中英混排规则 / 案 verb 列表） |

---

## L8（残留待 grill 的 3 件事）

| # | 问题 | 默认答 |
|---|---|---|
| 1 | MiSans 自带 ttf vs 回落 PingFang SC？ | 默认**回落 PingFang SC**——Apple OS 用户体验已足够；Android/Windows 用户暂忽略（单用户工具）。如果以后想多设备，再 ship ttf。 |
| 2 | `/today` orchestrator 的 B/C lane disabled stub 显示与否？ | 默认**保留 disabled stub**——loom 设计意图是让用户"看见这个 phase 的 roadmap"，不只是空 UI；与 brand voice 一致（"show the mechanism"）。 |
| 3 | `KnowledgeScreen` 当前是 read-only table（拘谨）；要不要加 tree 视图 + 节点点击展开 `encounter`？ | 倾向**保持 table**——loom 设计就这么定的，符合 brand "warm paper" 而不是 dashboard。tree 视图扩展到 Phase 1d。 |

---

## 下一步

1. 把本 addendum 提交进 PR（小 PR，pure docs）
2. Phase 1c.1 实施时 D9 / D6 / D2 都按本 addendum 覆盖执行
3. 1c.2 plan sketch 需要 refresh（drop shadcn 决定 + 重排页面 6 个 + 把 loom 资源清单作为 lift-shift 起点）

——本 addendum 不改 D1 / D3 / D4 / D5（encounter 重构 / source_kind 占位 / goal trail 延后 / 单用户）；它们与 UI 解耦。
