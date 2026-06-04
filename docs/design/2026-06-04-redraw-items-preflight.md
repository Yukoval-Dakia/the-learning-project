# Redraw Wave-2 L-items — design pre-flight（/learning-items 列表 + [id] 详情 + D11 健康条）

> **Status**: Pre-flight（wave-2 lane 现场写，对 fresh main @ `40165001`）。
> **Source**: loom-prototype `screen-items.jsx` + `screen-item-detail.jsx`（checkpoint f85aca6d，`/tmp/loom-proto/docs/design/loom-prototype/`）。
> **设计依据**: wave-2 计划 `docs/superpowers/plans/2026-06-04-redraw-wave2-plan.md` §1 L-items 行 + `docs/design/2026-06-04-u0-decisions.md` D11③（健康条）+ CO spec §2.4 derived-consumer 注记。
> **Branch**: `yuk-169-w2-items`（worktree `/tmp/wave2-items`）。

---

## 0. 范围

两页 loom 化 + **新增 D11 健康条**：

- **列表 `/learning-items`**：page-head chrome（eyebrow/标题/CTA/lead）+ status-tabs（按状态过滤）+ `ItemCard` grid（含 **每卡健康条**）+ archived 折叠区（TDM 决策3）+ Stateful 空/载/错。intent 输入面 + 新增表单 + 改知识点 inline editor + delete confirm **接线全保留**，只换视觉。
- **详情 `/learning-items/[id]`**：back-link + page-head（title-input + 教学/复习 CTA）+ source-event/retract 区 + **item 级健康条** + 属性卡（状态流 / 知识点 / 父项 picker）+ artifact note view + 子项列表。**TeachingDrawer 挂载 + teaching 接线原样不动（红线，AF S4 才吸收）**。

单文件增量重绘正常态（混 loom + 既有结构）。

## 1. 组件类型声明（CLAUDE.md 要求）

| 类型 | 物 |
|---|---|
| **设计基座（CSS，additive + scoped）** | `app/globals.css` 追加 `LOOM ITEMS LAYER — Wave 2` 段，**整页包 `.items-loom` wrapper**，所有新 loom 类 scope 在 `.items-loom` 下（沿 `.today-loom`/`.knowledge-loom` 先例）。 |
| **page（route）视觉重写 ×2** | `app/(app)/learning-items/page.tsx` + `app/(app)/learning-items/[id]/page.tsx`：结构 + 类名换 loom，全部 query/mutation/state/memo 接线保留。 |
| **健康条（page 内子组件，非新文件）** | `ItemHealthBar`（两页各自页内定义的纯展示函数；读已有 query 派生，零 state、零写路径、零新 endpoint）。 |

## 2. 逐字引原型（文件 + 行号）

### 列表 `screen-items.jsx`
- **page-head**（L104-113）：`.page view` > `.page-head` > `.eyebrow`「ITEMS · learning_item · {live} 活跃 · {archived} 归档」+ `.page-head-row`（`h1.page-title.serif`「学习项」+ `.hero-cta`（`Btn ghost icon=history`「会话历史」））+ `.page-lead`。
- **status-tabs**（L117-129）：`<SectionLabel>学习项</SectionLabel>` + `.status-tabs[role=tablist]`：每 tab `.status-tab(+.on)` = `.status-glyph`(STATUS_META icon) + label + `.mono.status-tab-n`(计数)。tabs = `["全部", ...ITEM_STATUSES.filter(≠archived)]`（L102）。
- **ItemCard**（L61-90）：`Card.pad.hover.item-card` > `.item-head`（`.item-ic.{color}`(L67) + 标题块 `.item-title`/`.item-sub.wenyan` + `<Ring percent=pct>`(L72)）+ `.item-tags.nowrap-meta`（kind `.badge` + `StatusBadge` + 子项数 `.meta.mono`）+ `.bar`(L79) + `.item-stats`（`.item-stat`×2 `.s-n.serif.tnum`/`.s-l` + `.item-foot-acts`（transition `Btn sm ghost` + 打开 `Btn sm secondary iconEnd=arrow`））。
- **IntentDecompose**（L9-59）：`Card.pad.intent-card`，含 `.card-head`/`.decomp-hub`/`.decomp-atomics`/`.decomp-atomic`。
- **archived 折叠**（L141-166）：`.archive-zone` > `.archive-toggle[aria-expanded]`（`archive` icon + 「归档项」+ `.mono.archive-n` + `.archive-caret` arrow rotate）+ 展开 `.archive-list.fade-key` > `.archive-row`（`.item-ic.info` + `.archive-main` + meta + 取出归档 `Btn sm secondary icon=undo`）。
- **Stateful**（L131-139）：`<Stateful state skeleton empty>` 包 `.items-grid.stagger`。

### 详情 `screen-item-detail.jsx`
- **back-link**（L35）：`.back-link`（`arrowL` icon + 「学习项」）。
- **page-head**（L36-45）：`.eyebrow`「LEARNING_ITEM · {id} · {kind}」+ `.page-head-row`（`input.title-input.serif` + `.hero-cta`（对话教学 `Btn secondary icon=teach` + 复习 `Btn primary icon=review`））。
- **origin-card**（L50-63）：`Card.pad.origin-card` AI 拆解提议（撤回 CTA）。
- **kd-grid**（L47-148）：`.kd-grid` > `.kd-main`（关联笔记 / 子项）+ `.kd-side`（`SectionLabel`「属性」+ `Card.pad`：`.prop-field`×4 状态流 `.status-flow`/`.status-step` + 知识点 `.chip-set` + 父项 `ParentPicker` + artifact seg）。
- **子项**（L102-115）：`.child-row`（`.item-ic` + `.wenyan` + `StatusBadge` + `<Ring>` + `.thread-arrow`）。
- **TeachingDrawer**（L150）：`<TeachingDrawer open onClose item>` —— **红线保留，本刀不碰**。

### 健康条设计依据（逐字）
- `docs/design/2026-06-04-u0-decisions.md` D11③ L60：「学习项**健康条** = 读时聚合其 knowledge_ids 的 knowledge_mastery + due 状态（ADR-0012 同族，零拥有 state）——已落 CO §2.4 derived-consumer 注记 + CONTEXT.md」。
- wave-2 计划 §1 L24：「含 **D11 健康条**（读时聚合 knowledge_mastery + due，零新 state）」；§4 L45：「items 健康条的读聚合：只读现成 view/表，不得新增写路径（audit:schema 零增项）」。
- 任务卡：「N 个知识点 · M 个到期 · 平均掌握 X%」条；低 evidence 沿 Ring evidence-guard 先例显 muted。

## 3. 数据映射

### 列表 / 详情接线（全复用，零改）
| loom 字段 | 来源 |
|---|---|
| 列表 items | `itemsQ`（`/api/learning-items?limit=200[&status=]`），现有 |
| 详情 item / parent / children / artifact | `detailQ`（`/api/learning-items/[id]`），现有 |
| 知识点名 chip | `knowledgeQ`（`/api/knowledge`，现页已查 `['knowledge']`） |
| status-tab 计数 | client filter `rows`（同现有 filter state） |
| StatusBadge | 现有 `StatusBadge` primitive（已含 6 状态 zh label + tone） |
| Ring pct | **见缺口表**——列表 row 无 cards/mastered，drop Ring，改用健康条 |

### D11 健康条数据路径（**零新表 / 零写路径 / 零新 endpoint**）
| 健康条字段 | 来源（全是已有 GET） |
|---|---|
| 「N 个知识点」 | `item.knowledge_ids.length`（已在两页 payload） |
| 「平均掌握 X%」 | 对 `item.knowledge_ids` 在 **`/api/knowledge`**（`knowledgeQ`，`loadTreeSnapshot` → `knowledge_mastery` view 的 `mastery`/`evidence_count`）逐 id 查 mastery，求 evidence>0 节点的平均 ×100 |
| 「M 个到期」 | 对 `item.knowledge_ids` 在 **`/api/knowledge/review-due-summary`**（已有端点，返回 `summary[knowledge_id]={overdue,due_soon}`，源自 `material_fsrs_state ⨝ question` GROUP BY）求 `overdue` 之和 |
| evidence-guard muted | 若 item 所有 knowledge 节点 `evidence_count` 均 < 3 → 健康条整体 `muted` 态（不显误导掌握%），沿 Ring evidence-guard + slice-2/3 先例 |

> **关键事实**：`/api/knowledge`（mastery/evidence_count）与 `/api/knowledge/review-due-summary`（per-node overdue/due_soon）**都已是现成 GET 端点**。健康条只在前端 fan-out item.knowledge_ids 做交集聚合，新增两个只读 `useQuery`（`['knowledge']` 列表页已有；`['review-due-summary']` 为本刀新增的轻量只读子查询）。`audit:schema` 检查 schema 字段写路径——本刀**不碰 schema、不加表、不加写路径**，零增项。

## 4. 缺口 → 处理表（no-mock；后端没有的 drop + phase-deferred 注释）

| loom 字段 | 后端现状 | 处理 |
|---|---|---|
| ItemCard `Ring percent`（mastered/cards 比例，L62/72） | `LearningItem` list payload 无 `cards`/`mastered`（卡片数是 FSRS/question 派生，列表未聚合） | **drop per-card Ring**，改用 **D11 健康条**（聚合 knowledge mastery，是真实数据）。phase-deferred 注释：cards/mastered 细分需 question 计数聚合，未在 list endpoint，留 P4 题库链路 |
| ItemCard `.bar` 进度条（width=pct，L79） | 同上无 mastered/cards | **drop**（与 Ring 同因）；健康条的平均掌握 % 替代进度语义 |
| ItemCard `.item-stats`「{cards} 卡片 / {mastered} 已掌握」（L80-82） | 同上 | **drop 两个 stat 数字**；底部只留 `.item-foot-acts`（transition + 打开）。phase-deferred：题库聚合后补 |
| ItemCard `.item-ic.{color}` + `it.icon`（L67） | `LearningItem` 无 `color`/`icon` 字段（prototype 装饰） | icon 固定用 `items`（hub）/`review`（atomic，按 kind 派生）；color 按 **status tone** 派生（不假造 prototype 的 per-item color），或统一 neutral。不引入假字段 |
| ItemCard kind badge「hub/atomic」（L75） | list payload 无 `kind`；详情有 `parent_learning_item_id` 但 list 行无 | list 行**无可靠 hub/atomic 信号** → drop kind badge（详情页有 parent 关系可显）。phase-deferred：list endpoint 未投影 kind |
| ItemCard 子项数「{n} 子项」（L77） | list payload 无 `children` 计数 | **drop**（list 未聚合 children count）。phase-deferred：同上 |
| IntentDecompose（L9-59 整块 prototype 自带拆解面） | 现页**已有真实 intent 接线**（`intentPlanM`/`intentAcceptM` → `/api/learning-intents`），结构不同于 prototype 的 mock `DATA.intentProposal` | **保留现有真实 intent 接线**，只 loom 化其视觉（套 `.intent-card`/`.decomp-*` 类）；不引 prototype 的 setTimeout mock |
| 详情 origin-card「AI 拆解提议 + confidence + when」（L50-63） | 现页用真实 `SourceEventBlock`（source_event + CorrectionStateRenderer + retract → `/api/proposals/[id]/retract`）；prototype 的 `it.origin` 是 mock | **保留现有 `SourceEventBlock` 真实接线**，loom 化视觉（套 `.origin-card`）；不引 mock origin |
| 详情关联笔记区（L65-99 `notesForItem`） | 现页**未实现独立笔记关联区**（只有 `primary_artifact` note view）；`notesForItem` 是 prototype helper | **不新接**（接线不动原则）；保留现有 `ArtifactView`（primary artifact）。phase-deferred：独立 note↔item 关联面非本刀，记缺口 |
| 详情 artifact seg「块树/大纲/只读」（L142-145） | 现页 `ArtifactBlockTree` 无 view-mode seg（prototype 装饰） | **drop seg**（无接线）；保留现有 block-tree 渲染 |
| 详情知识点「添加/删除 chip」（L133-135 带 ×/+ 按钮） | 现详情页知识点为只读 Badge 展示（编辑在列表页 inline editor） | 保留现状（详情只读 Badge）；不新接详情页知识点编辑（接线不动）。loom 化为 `.chip.chip-k` 只读样式 |
| 健康条 evidence_count（用于 muted 判定） | `/api/knowledge` 每节点已含 `evidence_count`（COALESCE 0） | 直接用；无缺口 |

## 5. CSS scope 策略

新段 `LOOM ITEMS LAYER — Wave 2`，**整页根 `<main className="page prose items-loom">`**，所有 loom 类 scope 在 `.items-loom` 下。

- **冲突类（globals 已有 legacy，必须 scope）**：`.page-head`/`.eyebrow`/`.page-title`/`.page-lead`（grep 命中 legacy + knowledge-loom/today-loom scoped）→ port loom 值到 `.items-loom .page-head` 等。
- **已被 slice-2/3 scoped 的复用类**：`.kd-grid`/`.kd-side`/`.field-label`/`.chip-set`/`.back-link`/`.note-ref`（grep 命中，但都 scope 在 `.knowledge-loom` 或 globals 全局）→ 详情页同样放 `.items-loom` 下重声明（值取自 prototype `screens-2b.css`），不动其它 scope。
- **grep=0 新类（可全局，保险起见仍 scope `.items-loom`）**：`.status-tabs`/`.status-tab`/`.status-tab-n`/`.status-glyph`/`.status-badge`/`.item-card`/`.item-head`/`.item-ic(.coral/.info/.good/.hard)`/`.item-title`/`.item-sub`/`.item-tags`/`.item-foot-acts`/`.items-grid`/`.s-n`/`.s-l`/`.archive-zone`/`.archive-toggle`/`.archive-list`/`.archive-row`/`.archive-main`/`.archive-caret`/`.archive-n`/`.intent-card`/`.decomp-hub`/`.decomp-atomics`/`.decomp-atomic`/`.title-input`/`.status-flow`/`.status-step`/`.child-row`/`.parent-picker`/`.picker-trigger`/`.picker-pop`/`.picker-opt`/`.origin-card`/`.prop-field` + **新健康条类** `.item-health`/`.item-health.muted`/`.health-seg`/`.health-n`/`.health-l`。
- **复用不重定义（grep 确认已在 globals）**：`.card(+pad/hover/sunk)` · `.btn*` · `.badge(+tones)` · `.chip`/`.chip-k` · `.card-head`/`.card-title`/`.card-icon(.accent)` · `.bar`(若用) · `.hero-cta` · `.ring`/`.ring-val` · `.serif`/`.mono`/`.tnum`/`.meta`/`.wenyan` · `.thread-arrow` · `.section-label`(loom 版已在 today/knowledge scoped——items 也需自己 scope 一份，因 SectionLabel primitive 渲染 `.section-label`) · `.empty*`/`.sk*`/Stateful 类 · `.fade-key`/`.nowrap-meta`(若已有)。
- **新键帧**：复用 today-loom 的 `loom-rise`（`.items-loom .stagger`）；若 `.stagger` 已全局可直接复用，否则在 `.items-loom` 下重声明。append 前 `grep -n` 复核 `.fade-key`/`.nowrap-meta`/`.stagger` 是否已全局。

## 6. Touch 文件清单

**MODIFY**：
- `app/globals.css` —— 追加 scoped `.items-loom` 层（banner `/* LOOM ITEMS LAYER — Wave 2 */`，chrome + item-card + status-tabs + archive + intent/decomp + detail kd-grid/status-flow/picker + 健康条类 + section-label/stagger scoped），append 前 grep collision-check。
- `app/(app)/learning-items/page.tsx` —— 包 `.items-loom`；PageHeader→loom head、TabBar→`.status-tabs`、Card 列表→`ItemCard`（loom）、新增 archived 折叠区（纯 UI 过滤 TDM 决策3）、加 `ItemHealthBar`、新增 `['review-due-summary']` 只读 query；**保留** itemsQ/knowledgeQ/createM/updateM/deleteM/intentPlanM/intentAcceptM + 全部 filter/editor/delete state。
- `app/(app)/learning-items/[id]/page.tsx` —— 包 `.items-loom`；back-link/page-head/属性卡/子项 loom 化、加 item 级 `ItemHealthBar`、新增 `['knowledge']`+`['review-due-summary']` 只读 query；**保留** detailQ/candidatesQ/updateM/detachChildM/retractM + SourceEventBlock + ArtifactView + **TeachingDrawer 挂载与全部 teach state（红线）**。

**REUSE（不动）**：loom primitives（Btn/Ring/LoomBadge/LoomCard/LoomIcon/SectionLabel/Stateful/EmptyState/SkLines/useCountUp）· StatusBadge · CorrectionStateRenderer · TeachingDrawer · ArtifactBlockTree/NoteRenderer · 所有 API 端点（含已有 `/api/knowledge/review-due-summary`）。

**KEEP-LEGACY（本刀仍引）**：详情页 `Badge`（subjectModel displayName tone=info）、`ArtifactView` 内部既有结构（W8-1 状态条逻辑不动）。

## 7. 缺口 / 红线小结

- **红线**：`learning-items/[id]` 的 `TeachingDrawer` import + `teachOpen` state + `setTeachOpen(true)` 触发 + `<TeachingDrawer .../>` 挂载**原样保留**，本刀不碰 teaching 任何文件（AF S4 吸收）。
- **TDM 决策3 archived 折叠**：列表页现状 archived 走 status-tab 过滤（点「归档」tab 才显），原型是底部独立折叠区默认收起。本刀**实现原型折叠区**（`.archive-zone`，纯 UI 过滤 `rows.filter(status==='archived')`，默认折叠），与现有「归档」tab 行为叠加（两者皆只读派生，不改 mutation）。
- **no-mock 兜底**：所有 drop 的 prototype 字段（cards/mastered/Ring/进度条/kind badge/子项数/artifact seg/origin mock/notesForItem）均不假造，留 phase-deferred 注释指向 P4 题库链路 / 独立 note 关联面。

## 8. Build order + lane gate

scoped CSS（globals，grep check）→ 列表页重绘 + 健康条 + archived 折叠 → 详情页重绘 + 健康条（保 TeachingDrawer）→ **gate**：
1. `pnpm exec biome check --write <touched>`
2. `pnpm typecheck`
3. `DATABASE_URL=postgres://placeholder:5432/x pnpm build`（standalone，慢）
4. 改动文件若有单测覆盖 → 对应 `pnpm vitest run --config vitest.unit.config.ts <file>`

---

*本刀两页 loom 化 + D11 健康条（零新表 / 零写路径 / 复用现成 GET）；TeachingDrawer 红线保留；缺口 no-mock drop + phase-deferred。*
