# Redraw Sessions — design pre-flight（`/learning-sessions` 列表 + `/learning-sessions/[id]` 详情 + `/events/[id]` 事件链）

> **Status**: Pre-flight（wave-2 自主实施，YUK-169）。
> **Source**: loom-prototype `screen-sessions.jsx` + `screen-events.jsx`（checkpoint f85aca6d，`/tmp/loom-proto/docs/design/loom-prototype/`）。
> **Base**: branch `yuk-169-w2-sessions`（自 main @ 40165001，已含 shell + loom primitives + globals loom 层）。
> **Lane**: L-sessions（wave-2 计划 §1，两小屏合一）。

---

## 0. 路由勘察结论（计划要求"现场勘路由"）

三条路由**已存在**，本 lane 纯重绘、不新建 route：

| 路由 | 文件 | 现状 |
|---|---|---|
| `/learning-sessions` | `app/(app)/learning-sessions/page.tsx` | 列表（review-only 查询，见缺口 §4-G1）+ resume/reopen 接线 |
| `/learning-sessions/[id]` | `app/(app)/learning-sessions/[id]/page.tsx` | 详情：meta + rating bar + AI 总结 stub + 逐事件流 |
| `/events/[id]` | `app/(app)/events/[id]/page.tsx` | 事件链：caused_by → focal → downstream → corrections + correction 写入面板 |

**events 无独立 list route**（原型 `screen-events.jsx` 也是 `/events/[id]` detail-only，无 list）。→ **不新建 `/events` route**。原型 `screen-sessions.jsx` 把列表+详情两个 screen 放一文件，但真实代码已拆成 `page.tsx` + `[id]/page.tsx` 两文件 —— 沿用现有拆分，分别重绘。

---

## 1. 组件类型声明（CLAUDE.md 要求）

| 类型 | 物 |
|---|---|
| **route page（部分视觉重写）** | `app/(app)/learning-sessions/page.tsx` —— 列表 chrome + 行卡 loom 化 |
| **route page（部分视觉重写）** | `app/(app)/learning-sessions/[id]/page.tsx` —— 详情 meta/rating/总结/事件流 loom 化 |
| **route page（部分视觉重写）** | `app/(app)/events/[id]/page.tsx` —— 事件链 loom 化（**correction 写入面板接线不动**，只换视觉壳） |
| **设计基座（CSS，additive + scoped）** | `app/globals.css` 追加 SESSIONS+EVENTS loom 层；冲突类 scope 在页级 `.sessions-loom` / `.events-loom` wrapper 下（见 §5）；banner `/* LOOM SESSIONS LAYER — Wave 2 */`。 |

> drawer / modal **零**：三个都是 route page。

---

## 2. 逐字引原型（文件 + 行号 = 设计依据）

### 2.1 `screen-sessions.jsx` 列表（`ScreenSessions`，L14-57）

- **back-link**（L18）：`<button className="back-link"><Icon name="arrowL" size={14} />今日`。
- **page-head**（L19-23）：`.eyebrow`「SESSIONS · LearningSession · {N} 条」(L20) + `h1.page-title.serif`「学习会话」(L21) + `p.page-lead`「过往复习与录入会话。复习会话可重开或恢复；录入会话带 ingestion 生命周期状态。」(L22)。
- **Stateful 包**（L25-27）：`skeleton={<Card pad><SkLines rows={4}/></Card>}`、`empty={<EmptyState icon="history" title="还没有会话" .../>}`、`errorText="会话历史加载失败。"`。
- **表头行**（L29-31）：`.sess-head-row.meta`：会话 / 状态 / 已复习 / 评分 / 时长 / （空）。
- **行**（L33-51）：`.sess-row`：
  - `.sess-id`（L34-41）：`.sess-type-ic.tone-{coral|info}`（L35，`type==="review"` coral+review icon / 否则 info+record icon）+ `.mono.sess-id-t`{id}（L37）+ `.meta.nowrap-meta`{started}+ `.chip.chip-k.mono`{每个 knowledge}（L38）+ optional `.meta`{note}（L39）。
  - `<StatusBadge status={s.status}/>`（L42）。
  - `.mono.sess-reviewed`{reviewed||"—"}（L43）。
  - `<MiniDist dist={s.dist}/>`（L44，见 2.3）。
  - `.mono`{dur}（L45）。
  - `.sess-acts`（L46-50）：`<Btn size="sm" variant="secondary" onClick=详情>` + review&done → `<Btn size="sm" variant="ghost" icon="refresh">重开`（L48）+ in_progress|partial → `<Btn size="sm" variant="ghost" icon="undo">恢复`（L49）。

### 2.2 `screen-sessions.jsx` 详情（`ScreenSessionDetail`，L59-116）

- **back-link**（L65）→「学习会话」`go("learning-sessions")`。
- **page-head**（L66-72）：`.eyebrow`「SESSION · {id}」+ `.page-head-row`（`h1.page-title.serif`「会话详情」+ `<StatusBadge>`）。
- **sess-summary 网格**（L74-78）：5×`.sess-sum-cell`（`.sess-sum-n.serif`{值} + `.meta`{标签}）：类型/时长/复习数/成本/模型。
- **评分分布 Card**（L80-92）：`Card pad` → `.card-head`（`.card-icon`+review icon + `.card-title`「评分分布」+ `.meta`{total}次）+ `.dist-bar`（3×`.dist-seg.tone-{again|hard|good}` width%）+ `.dist-legend`（3×`.dist-key.tone-*` + 不会/模糊/会了 + `.mono`计数）。
- **AI 会话总结 Card**（L94-97）：`Card pad sunk borderColor:var(--coral-line)` → `.card-head`（`.card-icon.accent`+sparkle + 「AI 会话总结」）+ `.prose-cn`{aiSummary}。
- **逐事件流**（L99-113）：`<SectionLabel>逐事件流` + `Card pad` → `.event-chain`（L101）内 `.event-row.event-link`（button，L103）：`.event-rail`（`.event-dot` style bg `var(--{tone})` + `.event-line` 非末行，L104）+ `.event-body`（`.event-head.nowrap-meta`：`.mono.event-label`{label} + `.meta`{t}；`.meta.mono`「→ events:{id}」L107）+ `<Icon name="arrow" className="thread-arrow"/>`（L109）。

### 2.3 `MiniDist`（L1-12）

`.mini-dist`（title「不会 X · 模糊 Y · 会了 Z」）内 3×`<span className="tone-{again|hard|good}" style={width:pct}>`；`dist` null → `.meta`「—」。

### 2.4 `screen-events.jsx` 事件链（`ScreenEvents`，L4-83）

- **back-link**（L15）→「错题」`go("mistakes")`。
- **page-head**（L16-20）：`.eyebrow`「EVENT · {focal.id} · adr-0006」+ `h1.page-title.serif`「事件链」+ `p.page-lead`「每个事件是不可变记录，带 actor、caused_by 链与成本。…」。
- **Stateful 包**（L22-23）：skeleton `SkLines rows=3`、empty「无此事件」、errorText「事件加载失败。」。
- **caused_by lane**（L26-33）：`.ev-lane` → `.ev-lane-label.meta`「caused_by · 由什么导致」+ `.ev-node.ev-cause`（button，`.ev-actor`+ACTOR_ICON icon + label + `.thread-arrow`）+ `.ev-connector`。
- **focal**（L36-47）：`.ev-focal` → `.ev-focal-head`（`.badge.tone-again`「focal」+ `.ev-actor`+actor + `.meta.mono`{when}）+ `.ev-focal-title.serif`「{action}:{outcome} · {subject}」+ `.raw-toggle`（slash icon + 展开/收起 raw payload）+ `<pre className="raw-payload fade-key">`（rawOpen）。
- **downstream lane**（L50-59）：`.ev-connector` + `.ev-lane-label`「导致了 · downstream」+ 每个 `.ev-node`（`.ev-dot.tone-{tone}` + label + `.ev-actor-mini.mono`{actor}）。
- **corrections**（L62-79）：`<SectionLabel count>corrections · 纠正` + `Card pad` → 每个 `.corr-row`（`.ev-dot.tone-good` + label + `.meta`{when·actor}）+ add 态 `.corr-add`（field-input + 添加/取消 Btn）/ `.corr-add-btn`（plus icon「添加纠正」）。
- `ACTOR_ICON`（L2）：`{user:"today", agent:"sparkle", cron:"moon", system:"bolt"}`。

---

## 3. 数据映射（全部来自现有 query/API，无新 endpoint）

### 3.1 列表（`/api/learning-sessions?type=review&limit=50`，route.ts L27-121）

| loom 字段 | 来源 |
|---|---|
| 行 id / `.sess-id-t` | `row.id`（mono，截断显示同现状 `slice(0,12)`） |
| type icon tone | `row.type`（"review"→coral+review / 其它→info+record） |
| started `.meta` | `formatRelTime(started_at*1000)` |
| knowledge chips | `row.knowledge_touched`（`.chip.chip-k.mono`，截前若干） |
| StatusBadge | `row.status` → 复用 `StatusBadge` primitive |
| reviewed | `row.reviewed_count`（0 → "—"） |
| MiniDist | `row.rating_counts {again,hard,good}` |
| dur | `row.duration_ms` → 复用现有 `formatDuration` |
| 详情 Btn | `<Link href={/learning-sessions/${id}}>` |
| 恢复 Btn | status==='paused' → `<Link href={/review?session=${id}}>`（**YUK-57/63 接线保留**） |
| Resume(reopen) Btn | status==='abandoned' → `reopenM.mutate(id)`（**YUK-57/63 接线保留**） |

### 3.2 详情（`/api/learning-sessions/[id]`）

| loom 字段 | 来源（现有 SessionView 已算） |
|---|---|
| sess-sum 类型 | `TYPE_LABEL[type]` |
| sess-sum 时长 | `formatDuration(duration_ms)` |
| sess-sum 复习数 | `reviewEvents.length`（client filter，现有逻辑） |
| sess-sum 成本 | `totalCostUsd`（events cost_micro_usd 求和，现有逻辑） |
| dist-bar / legend | client `ratingCounts`（现有，4 档 again/hard/good/easy） |
| AI 总结 | `summary_md`（null → stub 文案，现有） |
| 事件流 | `session.events[]` → 复用现有 `.event-chain` loom 类 + `<Link href={/events/${id}}>` |
| 状态 Badge | `session.status` → StatusBadge |

### 3.3 事件链（`/api/events/[id]`，EventChainResponse）

| loom 字段 | 来源 |
|---|---|
| eyebrow focal id | `event.id` |
| caused_by lane | `chain.caused_by`（null 则不渲染该 lane） |
| focal 卡 | `event`（action/outcome/actor_kind/actor_ref/subject_id/payload/cost） |
| downstream lane | `chain.caused_events[]` |
| corrections | `chain.corrections[]` + **现有 CorrectionControls 写入面板**（retract/mark_wrong/restore mutation，**接线全留**） |
| raw payload | `event.payload`（`<pre>` JSON）；现状用 `<details>`，loom 化为 `.raw-toggle` |
| CorrectionStateRenderer | 现有 primitive，保留 |

---

## 4. 缺口 → 处理（no-mock：后端没有的 drop + phase-deferred 注释）

| # | loom 字段 | 后端现状 | 处理 |
|---|---|---|---|
| **G1** | 列表含 **ingestion** 会话（type icon record/info、ingestion 生命周期状态 extracted/failed、note 文案、dist=null） | 列表 query **写死 `type=review`**（route.ts L36-38），page 仅取 review。API **支持** `type` 不传=全类型 + `status` filter | **本刀不改 query 范围**（避免 scope 蔓延 + 影响 reopen 语义）。type-icon 逻辑按 `row.type` 写（review→coral / 否则 info+record），数据上当前恒为 review 但**结构对未来 ingestion 留好**；page-lead 仍写「复习与录入会话」（真实文案，非 mock）。→ phase-deferred 注释标注：放开 `type` 过滤属独立产品决策（关联 ingestion session surface），不在 redraw lane 内做。 |
| **G2** | MiniDist / dist 含 ingestion 的 `dist:null` 态（显 "—"） | review 行 rating_counts 恒有值；ingestion 行当前不出现 | MiniDist 写 null-guard（`dist` 全 0 → `.meta`「—」），结构保留；当前数据下恒有值。 |
| **G3** | 详情 sess-sum **模型** 列（"Haiku"） | session 行/events 无 model 字段聚合 | **drop 模型 cell** → sess-sum 4 列（类型/时长/复习数/成本），不假造模型名。phase-deferred：model 维度需 task_run 关联聚合（events.task_run_id 有，但需额外 join），留后。 |
| **G4** | 详情 dist 原型 3 档（again/hard/good）；真实 4 档（含 easy） | API 含 easy 评分 | **保留真实 4 档**（again/hard/good/easy），比原型多一档 = 数据真实，不裁剪。dist-bar/legend 渲染 4 段。 |
| **G5** | 事件链 eyebrow「adr-0006」装饰串 | 装饰文案 | 保留「EVENT · {id}」，**drop 「· adr-0006」** 装饰（非数据，避免硬编码 ADR 号漂移）。或保留为静态——默认 drop。 |
| **G6** | events focal `.ev-focal-title`「{action}:{outcome} · {subject 中文}」（"之 · 用法"） | API 有 action/outcome/subject_kind/subject_id，**无人类可读 subject 中文名** | title 用 `{action}:{outcome} · {subject_kind}:{subject_id}`（真实标识），不假造中文学名。 |
| **G7** | events corrections 行的「redo · 答对」语义化 label + 原型 inline `addCorrection`（前端假写） | 真实 corrections 来自 `chain.corrections[]`（不可变事件），写入走 **CorrectionControls**（retract/mark_wrong/restore + reason_md API） | **不引原型的 inline 假写 add**（它是 prototype-only setState mock）。保留真实 `CorrectionControls` 面板（loom 化壳），corrections 列表渲染 `chain.corrections[]`，label 用 `{action}` + CorrectionStateRenderer。 |
| **G8** | events downstream 行点击跳转（原型 `m*`→mistakes / 否则 null） | 真实 downstream = `caused_events[]`，每条有自己的 `/events/{id}` | downstream 行 → `<Link href={/events/${id}}>`（真实事件跳转），不做 mistakes 特判（更通用）。 |

> 总原则：**结构按原型，数据缺口 drop 不 mock，多出的真实维度（easy 档）保留**。所有 mutation/query/memo 接线零改动。

---

## 5. CSS scope 策略（冲突点）

grep `app/globals.css`（Python 精确计数）结论：

- **零冲突、可全局**（grep=0）：`.sess-row` `.sess-head-row` `.sess-id` `.sess-id-t` `.sess-type-ic` `.sess-acts` `.sess-reviewed` `.sess-summary` `.sess-sum-cell` `.sess-sum-n` `.mini-dist` `.dist-bar` `.dist-seg` `.dist-legend` `.dist-key` `.event-link` `.ev-lane` `.ev-lane-label` `.ev-node` `.ev-cause` `.ev-focal` `.ev-focal-head` `.ev-focal-title` `.ev-actor` `.ev-actor-mini` `.ev-dot` `.ev-connector` `.raw-toggle` `.raw-payload` `.corr-row` `.corr-add` `.corr-add-btn` `.sessions-loom` `.events-loom`。保险起见仍放页级 wrapper 下。
- **已存在 = 直接复用，不重定义**：
  - `.event-chain` `.event-row` `.event-rail` `.event-dot` `.event-line` `.event-body` `.event-head` `.event-label`（globals L7723-7764，**已是 loom 事件链类**，knowledge/[id] 已用）→ 详情逐事件流**直接复用**。
  - `.page-head` `.page-head-row` `.page-title` `.page-lead` `.eyebrow` `.back-link` `.page-narrow` `.card-icon` `.chip-k` `.wenyan` `.tone-*` `.card-title` `.mono` `.meta` `.prose-cn` `.thread-arrow` `.fade-key`(0 但 keyframe 可能在) `.field-input` `.nowrap-meta`（prior-wave loom chrome / 共享）→ 复用。
- **冲突处理**：page-head/eyebrow/page-title/page-lead 既有多处定义（含 legacy + loom）。沿 `.knowledge-loom`/`.today-loom` 先例，**列表页根包 `.sessions-loom`、事件页根包 `.events-loom`**，新 loom chrome 规则若与 legacy 同名则 scope 其下；新独有类（sess-*/dist-*/ev-*）也放 wrapper 下统一。
- globals 追加两段，顶部 banner `/* LOOM SESSIONS LAYER — Wave 2 */` 与 `/* LOOM EVENTS LAYER — Wave 2 */`。

---

## 6. Touch 文件清单

**MODIFY**：
- `app/(app)/learning-sessions/page.tsx` —— 列表：`PageHeader`→loom page-head + back-link、`.event-card` 行→`.sess-row` 表格、Button→Btn、Badge→StatusBadge、loading/error/empty→Stateful；包 `.sessions-loom` wrapper。**reopenM / 恢复 Link / reopen 接线全留**。
- `app/(app)/learning-sessions/[id]/page.tsx` —— 详情：`PageHeader`→loom page-head、`.session-meta`→`.sess-summary` 网格、rating bar→`.dist-bar`+legend、AI 总结→sunk Card、事件流复用 `.event-chain`；包 `.sessions-loom`。SessionView 计算逻辑不动。
- `app/(app)/events/[id]/page.tsx` —— 事件链：`PageHeader`→loom page-head、`.event-card` lane→`.ev-lane`/`.ev-focal`/`.ev-node`、`<details>`→`.raw-toggle`+`.raw-payload`；包 `.events-loom`。**CorrectionControls + CorrectionStateRenderer + 三个 mutation 接线全留**（只换外壳类名）。
- `app/globals.css` —— 追加 SESSIONS + EVENTS loom 层（banner、scoped wrapper、grep collision-checked）。

**REUSE（不动）**：`/api/learning-sessions`(+`[id]`)、`/api/events/[id]`(+correct mutation)、`/api/review/sessions/[id]/reopen`、loom primitives（Btn/LoomIcon/LoomCard/StatusBadge/SectionLabel/Stateful/EmptyState/SkLines/ErrorState）、`.event-chain` 既有 loom 类、`formatRelTime`/`formatDuration`、`CorrectionStateRenderer`/`affectedRefsForCorrection`。

**KEEP-LEGACY → 退役评估**：旧 `.learning-session-list`/`.learning-session-row`/`.event-card`/`.ec-*`/`.session-meta`/`.session-rating-*`/`.session-summary`/`.meta-cell` 等 —— 本刀这三页改用 loom 后这些类在本页不再引用，但**可能被其它未重绘屏（inbox / knowledge detail / mistakes 重绘前）仍用** → 删类交 **L-cleanup 收口刀**（grep=0 全仓验证后删），本刀不删 globals 既有类。

---

## 7. 风险 + 缓解

- **chrome class 冲突**：page-head 系全 scope 在 `.sessions-loom`/`.events-loom` 下，append 前已 grep；新独有类 grep=0。
- **`.event-chain` 复用**：详情事件流复用既有 loom 类（knowledge/[id] 同款），零新增、零冲突。
- **接线零改**：reopen / 恢复 Link / correction 三 mutation / CorrectionStateRenderer 全部原样，只换视觉壳。
- **G1 ingestion 范围**：不擅自放开 `type` 过滤（产品决策），结构留好。
- **build = 唯一 route+CSS gate**（YUK-67）；额外验三页渲染 + 恢复/reopen/correction 仍 working。

---

## 8. Build order + verify gate

scoped CSS（globals 两段）→ 列表页重绘 → 详情页重绘 → 事件页重绘 → **gate**：touched-file biome / typecheck / `DATABASE_URL=postgres://placeholder pnpm build` / 无对应 unit 测试（页级无 .test.tsx，server/API 测试不受 UI 影响）→ commit。

---

*本 lane 重绘 `/learning-sessions` 列表 + 详情 + `/events/[id]` 三 route page；events 无 list route（detail-only，同原型）；接线全保留；缺口 drop 不 mock；删 legacy 类交 cleanup 收口刀。*
