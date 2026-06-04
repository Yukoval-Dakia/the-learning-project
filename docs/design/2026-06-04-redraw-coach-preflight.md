# Redraw Coach — design pre-flight（/coach 周报视图：KPIs + 评分分布 + 归因 + 逐日 + 失败排行）

> **Status**: Pre-flight（wave-2 lane L-coach，CLAUDE.md UI 规则）。
> **Source**: loom-prototype `screen-coach.jsx`（checkpoint f85aca6d，`/tmp/loom-proto/docs/design/loom-prototype/`）。YUK-169 / wave 2。
> **Base**: branch `yuk-169-w2-coach`（自 main @ 40165001，已含 shell + loom primitives/CSS + today/knowledge loom 层）。
> **统合上下文**：`docs/design/2026-06-04-u0-decisions.md`（D5）。

---

## 0. 范围裁定（重要：current `/coach` = 纯只读周报，无 TodayPlan/strand）

lane 任务描述提到「TodayPlan/strand/周报视图 loom 化；goal strand（ADR-0025）展示接线保留」。
**实测**（grep `app/(app)/coach/` + `app/(app)/today/`）：

- current `app/(app)/coach/page.tsx` 唯一接线 = `useQuery(['weekly-review', days])` → `GET /api/review/weekly?days={7|30|90}`，纯只读周报。
- **页面里没有任何 TodayPlan / strand / goal-strand / `today-plan` 接线**（`coach/today-plan` route 存在于后端，但 `(app)/` 下零消费者；它属未来 Coach-engine 出 brief 的载体，不在本页）。

→ 本刀 = **纯重绘现有只读周报视图**（screen-coach.jsx 正是这个：KPIs + dist-bar + cause-list + stack-chart + fail-row，注释开篇即「read-only. 3-tier rating dist.」）。
→ TodayPlan/strand/goal-strand 是 **D5 两级流水线（Coach brief → ReviewPlanTask）的未来产物**，当前后端未对本页暴露 → 记入 §4 缺口表 drop + phase-deferred，不假造（no-mock 铁律）。

## 1. 组件类型声明

| 类型 | 物 |
|---|---|
| **设计基座（CSS，additive + scoped）** | `app/globals.css` 追加 coach loom 层，整页包 `.coach-loom` wrapper；冲突类 scope 其下（见 §5）。port 自 `screens-2b.css` L186-218 + responsive L311-322。 |
| **page（route）视觉重写** | `app/(app)/coach/page.tsx`：`PageHeader`→loom page-head、`.coach-window-tabs`→`.seg`、`.kpi-strip`→`.coach-kpis`(CoachKpi + useCountUp)、`.session-rating-bar`→`.dist-bar`、归因 `TopList`→`.cause-list`、`.coach-daily`→`.stack-chart`、易错 `TopList`→`.fail-row`、load/err/empty→`Stateful`。接线（query/state/CAUSE_LABELS）全留。 |

> 组件类型：**route（page）部分视觉重写**（非 drawer / modal）。

## 2. 逐字引原型（screen-coach.jsx + screens-2b.css，文件+行号）

- **CoachKpi**（`screen-coach.jsx` L2-6）：`div.coach-kpi` > `div.coach-kpi-n.serif.tnum`{`{prefix}{shown}`+`span.coach-kpi-u`{unit}} + `div.coach-kpi-l.meta`{label}；`useCountUp(value,{start:active,dur:900})`，整数 round / 否则 `.toFixed(2)`。
- **page-head**（L20-28）：`div.page-head` > `div.eyebrow`「COACH · 只读分析 · 近 {win} 天」+ `div.page-head-row`（`h1.page-title.serif`「Coach 周报」+ `div.seg`（`["7","30","90"]` map，`button.on` when `win===w`，文案「{w} 天」））+ `p.page-lead`「复盘最近的复习与错题…只读，不改数据。」。
- **Stateful**（L30-32）：`state=ds` · `skeleton={<Card pad><SkLines rows={4}/></Card>}` · `empty={<EmptyState icon="target" title="窗口内无数据" text="该时间窗内还没有复习记录。"/>}` · errorText「分析数据加载失败。」。
- **coach-kpis**（L33-38）：`div.coach-kpis.stagger` 4×`CoachKpi`：reviews / 正确率(unit「%」) / 新增错题 / AI 成本(prefix「$」)。
- **coach-grid**（L40-67）：2 列。① 评分分布 `Card pad`：`.card-head`(`.card-icon`<Icon review 18>+`.card-title`「评分分布」+`.meta`{distTotal}「次」)；`.dist-bar`（3×`span.dist-seg.tone-{again|hard|good}` width=占比）；`.dist-legend`（3×span，`.dist-key.tone-X`+文案「不会/模糊/会了」+`b.mono`{n}）。② 归因分布 `Card pad`：`.card-head`(<Icon bolt 18>+「归因分布」+`.meta`「只读」)；`.cause-list`→N×`.cause-row`（`.cause-name`{name}+`.cause-track > span`(width 占比)+`.mono.cause-n`{pct}%）。
- **逐日**（L69-91，`c.perDay &&`）：`<SectionLabel>逐日复习量</SectionLabel>` + `Card pad`：`.stack-chart`→col map：`.stack-col` > `.stack-bars`(style height:140) 含 3×`span.stack-seg.tone-{good|hard|again}`(height=占 140px) + `span.stack-x.meta`{周标} + `span.stack-total.mono`{total}。
- **失败排行**（L93-103）：`<SectionLabel>失败排行 · 按知识点</SectionLabel>` + `Card pad`：N×`button.fail-row` onClick `go("knowledge/"+tag)`：`span.wenyan.fail-name`{name}+`.fail-track > span.tone-again`(width 占 maxFail)+`span.mono.fail-n`{n}「次」+`<Icon arrow 14 .thread-arrow>`。
- **CSS**（`screens-2b.css` L186-218 + L311-322 responsive）：逐字 port，详 §5。

## 3. 数据映射（全部复用现有 `WeeklyResponse`，无新 endpoint / 无新 query）

current `WeeklyResponse`：`{ window:{days,from,to}, totals:{reviews,failures,cost_usd}, ratings:{again,hard,good,easy}, daily:[{date,count,correct}], top_causes:[{category,count}], top_knowledge:[{id,name,failure_count}] }`。

| loom 字段 | 来源（current page） |
|---|---|
| seg 7/30/90 | `days` state + `WINDOW_OPTIONS`（保留 `useState<Window>`） |
| KPI reviews | `totals.reviews` |
| KPI 正确率 % | `(ratings.good+ratings.easy)/totals.reviews*100`（保留 current 算法，含 `>0` guard） |
| KPI 新增错题 | `totals.failures` |
| KPI AI 成本 $ | `totals.cost_usd`（保留 `.toFixed`） |
| dist-bar / legend | `ratings.{again,hard,good,easy}`（**4 档**，见 §4-A：保留 easy，不退化成原型 3 档） |
| cause-list | `top_causes` map（`CAUSE_LABELS[c.category] ?? c.category` + count）；占比 = count / Σcount |
| stack-chart 逐日 | `daily[]`：`count`/`correct` → 对(good 色)/错(again 色) 两段堆叠（**2 段**，见 §4-B：无 hard 档逐日数据） |
| fail-row 易错 | `top_knowledge` map（`name` + `failure_count`）；fail-row click → `router.push('/knowledge/'+k.id)`（保留 current 无 click → 新增导航见 §4-D） |
| Stateful 态 | `q.isLoading`/`q.isError`/`q.isSuccess` + 空数据判定（`totals.reviews===0`） |

## 4. 缺口 → 处理表（no-mock：后端没有的 drop + phase-deferred 注释，绝不假造）

| 原型字段 | 后端现状 | 处理 |
|---|---|---|
| **A. dist-bar / legend 3 档**（again/hard/good，原型 L43-52 无 easy） | current `ratings` **有 4 档**（again/hard/good/easy） | **不退化**——保留 4 档（current 已正确显示 easy「熟练」）。原型只是早期 3 档假数据；真后端更全，按真数据渲染 4 段 + 4 图例。这是「按真数据丰富」非缺口。 |
| **B. stack-chart 逐日 3 段**（again/hard/good，原型 L74-82） | current `daily[{count,correct}]` 只有「总数 + 对数」，**无 again/hard/good 三档逐日拆分** | **降级为 2 段**（对=good 色 / 错=again 色，沿 current `DailyBars` 真实语义），不假造 hard 档逐日。phase-deferred：逐日三档拆分需 FSRS event 流按日 group-by rating（P3 FSRS 落地后可补）→ 注释指向 `docs/design/2026-06-04-u0-decisions.md` D1/D5。 |
| **C. TodayPlan / strand / goal-strand 展示**（lane 描述提及） | current `/coach` 页 **零接线**（grep 确认 `(app)/` 下无 today-plan 消费者；goal 仅在 coach spec 设计层，无 UI 数据源） | **drop**（本页不引入）。phase-deferred：Coach brief（`review_session_proposal` 扩展）+ ReviewPlanTask 两级流水线是 D5 未来事，goal strand 展示是 ADR-0025 北极星 + Coach-engine 落地后的新 surface，当前后端未对本页暴露 → 注释指向 `docs/design/2026-06-04-u0-decisions.md` D5。**不 mock strand/goal 卡片。** |
| **D. fail-row click → 知识点**（原型 `go("knowledge/"+tag)` L96） | current fail 行**无 click**；`top_knowledge[].id` 是真实 knowledge id，`/knowledge/[id]` 路由存在 | **接上真导航**：`useRouter().push('/knowledge/'+k.id)`（id 真实、路由已存在 → 非假造，是补上原型已设计的真实跳转）。 |
| **E. KPI sub「action=review · {N}d」等 trend 文案**（current page L109/129/134 有，原型 CoachKpi 无 sub） | current 有这些 debug-ish trend 串 | **drop**（原型 CoachKpi 无 sub 行，更干净）；window 天数已在 eyebrow「近 {win} 天」表达，不在每张卡重复。 |
| **F. `causeTotal` / `maxFail` / `maxDay` / `distTotal`** 派生量 | 原型 L14-17 client 算 | **保留**（纯 client 派生，按真数据算）。 |

## 5. CSS scope 策略（冲突 → 全 scope 在 `.coach-loom` 下）

grep `app/globals.css` 结果：
- **新类 grep=0（安全，仍 scope 保险）**：`.coach-kpi(s)`/`.coach-kpi-n/-u/-l`、`.dist-bar/-seg/-key/-legend`、`.cause-list/-name/-track/-n`、`.stack-chart/-col/-bars/-seg/-x/-total`、`.fail-row/-name/-track/-n`。
- **`.coach-grid`（L1608/1673）= legacy coach 页自有 grid**（本刀正在重写该页）→ 我的 `.coach-grid` 全 scope 在 `.coach-loom .coach-grid` 下；legacy 块留给 L-cleanup 收口刀删（grep=0 后），本刀不碰。
- **`.cause-row`（L3400 = `.review-stage .cause-row`）**：已 scope 在 review-stage 下，与我的 `.coach-loom .cause-row` 不撞 → 仍把我的 scope 在 `.coach-loom` 下双保险。
- **chrome 类 `.page-head`/`.eyebrow`/`.page-title`/`.page-lead`/`.seg`**：globals 有 legacy 同名（~40 surface 依赖）→ 全 scope 在 `.coach-loom` 下（沿 `.knowledge-loom .page-head` / `.today-loom .eyebrow` 先例 L7813-7872 / L8105-8120）。
- **复用不重定义**（已在 globals）：`.card`/`.card-pad`/`.card-head`/`.card-icon`(+`.accent`)/`.card-title`/`.serif`/`.tnum`/`.mono`/`.meta`/`.wenyan`/`.thread-arrow`/`.tone-{again,hard,good}`/`.section-label`(+ rule/count)/Stateful 系(`.empty*`/`.sk*`/ErrorState)。
- **globals 追加段顶部 banner**：`/* LOOM COACH LAYER — Wave 2 */`。

## 6. Touch 文件清单

**MODIFY**：
- `app/globals.css` —— 追加 scoped `.coach-loom` 层（kpis/grid/dist/cause/stack/fail + responsive，banner「LOOM COACH LAYER — Wave 2」；append 前 grep collision-check 已做）。
- `app/(app)/coach/page.tsx` —— 包 `.coach-loom` wrapper；`PageHeader`→loom page-head、tabs→`.seg`、KPI strip→`.coach-kpis`(CoachKpi+useCountUp)、rating-bar→`.dist-bar`、归因→`.cause-list`、daily→`.stack-chart`、易错→`.fail-row`(+真 router 导航)、load/err/empty→`Stateful`。**保留**：`useQuery(['weekly-review',days])`、`days` state、`WINDOW_OPTIONS`、`CAUSE_LABELS`、`ApiAuthError`/`apiJson`、`correctRate` 算法。

**REUSE（不动）**：`/api/review/weekly` 查询 · loom primitives（`LoomCard`/`Btn`?/`LoomIcon`/`SectionLabel`/`Stateful`/`SkLines`/`EmptyState`/`useCountUp`）· 既有 loom CSS。

**KEEP-LEGACY（本刀退役、留 L-cleanup 收口删）**：legacy `.coach-window-tabs`/`.coach-panel`/`.coach-daily`(+`-bars`/`-labels`/`-bar`)/`.kpi-strip`/`.kpi`/`.session-rating-bar`(+legend)/`.coach-grid`(L1608)/`TopList` row 类。本刀重写后这些类在本页 grep=0，但**不在本刀删**（cleanup lane 全仓 grep=0 验证后单独删，避免误删别页仍用的）。

**NOT-TOUCH**：所有 `*.test.ts`（coach 相关测试全是后端 route/handler 测，不覆盖本 UI 页）· `app/api/coach/today-plan`（后端，非本页接线）。

## 7. 缺口/风险小结

- **C（TodayPlan/strand/goal）= 本刀最大的「不做」**：current 页根本没接这些线，按 no-mock 铁律 drop，phase-deferred 指向 D5。绝不为「视觉完整」假造 strand 卡。
- **B 逐日降级 2 段**：真后端逐日只有 count/correct，按真语义 2 段堆叠，不假造三档。
- chrome / coach-grid 同名冲突 → 全 scope `.coach-loom` 下，append 前 grep 已验。
- **接线不动**：query/state/CAUSE_LABELS/correctRate 全留；唯一新增 = fail-row 真 router 导航（id 真实、路由存在，非假造）。
- gate = touched-file biome + typecheck + `DATABASE_URL=postgres://placeholder pnpm build`（CSS+route export）；本页无单测覆盖。

## 8. Build order

scoped CSS（globals append + banner）→ 重写 page.tsx（wrapper + page-head/seg + KPIs + grid(dist/cause) + stack + fail + Stateful）→ gate（biome/typecheck/build）→ commit。

---

*本刀只重绘现有只读周报视图。TodayPlan/strand/goal-strand 当前后端未对本页暴露 → drop + phase-deferred（D5），不 mock。*
