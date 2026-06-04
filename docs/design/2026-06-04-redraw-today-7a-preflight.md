# Redraw Today 7A — design pre-flight（/today hero + KPIs + threads）

> **Status**: Pre-flight, awaiting user approval（CLAUDE.md UI 规则）。
> **Source**: loom-prototype `screen-today.jsx`（checkpoint f85aca6d）。YUK-169 / YUK-203 P5。
> **Base**: branch `yuk-169-redraw-today`（自 main，已含 shell + NoteReader + knowledge detail/list/drawer + loom primitives/CSS）。

---

## 0. 范围（研究 agent 建议拆 2 刀，已采纳）

/today 大（714 行 / 8 query / 7 段 / 1 mutation / 2 CSS 冲突）。拆：

- **本刀 7A** = LoomHero（问候 + eyebrow + CTA 含 Copilot）+ KPI row（4 卡）+ `SectionLabel` + threads-grid（3 卡：复习/意图/Coach）。上半屏核心，**无 mutation、无缺口数据**。
- **7B（后续）** = dashboard `.dash-grid`（SessionsStrip + AiChangesStrip[带 undo mutation] | ProposalStrip + CostRibbon）+ WeekHeat。重、带唯一 mutation + prototype-only 数据。

单文件 `app/(app)/today/page.tsx` 里 7A 只重绘上半（hero/kpi/threads），下半 strips（sessions/ai-changes/inbox/cost）暂留 legacy，7B 再绘。混用正常（同 knowledge slice 拆法）。

## 1. 组件类型声明

| 类型 | 物 |
|---|---|
| **设计基座（CSS，additive + scoped）** | `app/globals.css` 追加 today loom 类，**整页包 `.today-loom` wrapper**，冲突类 scope 其下（见 §5）：`.loom-hero`/`.hero-weave`(+weave keyframe)/`.hero-inner` · `.kpi-row`/loom `.kpi`(冲突→scoped)/`.kpi-val`/`.kpi-foot`/`.kpi-go` · loom `.section-label`(冲突→scoped flex+rule+count) · `.threads-grid`/`.thread-card`/`.thread-top`/`.thread-ic.tone-*`/`.thread-label`/`.thread-title`/`.thread-sub`/`.thread-cta`/`.thread-arrow` · `.stagger`(+rise keyframe)。 |
| **page（route）部分视觉重写** | `app/(app)/today/page.tsx` 上半：`PageHeader`→LoomHero、`.kpi-strip`→`.kpi-row`(KpiCard + useCountUp)、`lanes`→`.threads-grid`(ThreadCard)。**移除页内 `<TodayCopilotDrawer/>` 重复 mount**（shell 已挂）。下半 strips 留 legacy。 |

## 2. 逐字引 loom（screen-today.jsx，hero+kpi+threads 部分）

- **LoomHero**：`Card.loom-hero.padLg` > `.hero-weave`（装饰 svg，3×`.wv` path）+ `.hero-inner`（`.eyebrow`「TODAY · {date} · phase 1c」· `h1.page-title.hero-title`「{greet}，{name}。」· `p.page-lead` · `.hero-cta`：开始今日复习/录入/刷新/打开 Copilot 4 个 `Btn`）。
- **KPI row**：`.kpi-row.stagger` 4×`KpiCard`（`Card.kpi.hover`，`useCountUp` on value）：`{icon,label,value,sub,route}` → `.kpi-label`/`.kpi-val.tnum`/`.kpi-foot.kpi-sub`/`.kpi-go`（hover 箭头）。
- **`<SectionLabel count="3 缕">今日之线`**。
- **threads-grid**：`.threads-grid.stagger` 3×`ThreadCard`（`Card.thread-card.hover`）：`{tone,icon,badge,label,title,sub,cta,route}` → `.thread-top`/`.thread-ic.tone-X`/`.thread-label.meta`/`.thread-title.serif`/`.thread-sub`/`.thread-cta`/`.thread-arrow`。

## 3. 数据映射（8 query 全复用；7A 用到的）

| loom 字段 | 来源 |
|---|---|
| KPI 到期 | `dueQ.rows.length`（`/api/review/due?limit=200`） |
| KPI 待归因 | `mistakesQ` `cause===null` 计数 |
| KPI AI 提议待审 | `proposalKpiQ.total`（`/api/today/proposals`，保留现有 5-group `KIND_TO_GROUP` 逻辑） |
| KPI 知识点 | `knowledgeQ.rows.length` |
| hero eyebrow / 问候 | client `Date`（time-of-day 问候 + ISO date + phase 1c） |
| thread 复习 | due 计数 + → `/review`（CTA「开始复习」） |
| thread 意图 | `itemsQ` `status!=='done'` 计数 + → `/learning-items` |
| thread Coach | → `/coach`（CTA「查看周报」） |

## 4. 缺口 → 处理（不 mock；同前几刀 FSRS/数据 gap）

| loom 字段 | 后端 | 处理 |
|---|---|---|
| hero `user.name`「知微」 | 单用户工具，无 user model | **drop name** → 纯 time-of-day 问候（如「晚上好。」），不假造名字 |
| KPI prop sub「block_merge 2 · …」(raw kinds) | proposalKpiQ.by_kind 有，但当前页用 5-group | sub 用现有 5-group 计数（或省略 sub）；不引 raw-kind 串 |
| thread 复习 sub「again 1 · hard 2 · good 9 · 逾期 12」 | `/api/review/due` rows 只有 `{question_id}`，**无 grade 分布/逾期** | **drop sub 细分** → 只显 due 计数 + CTA |
| thread 意图 sub「hub 2 · atomic 3 · 待拆解 1」 | `LearningItem` 只有 `{id,status}`，**无 type 细分** | **drop sub 细分** → 只显在途计数 + CTA |
| thread Coach sub「84 reviews · 71% 正确」 | /today 不取 coach 周 stats | **drop stats** → 只显「查看周报」CTA（或静态「本周报表」文案） |
| thread `badge` | 部分 prototype 装饰 | 有数据才显（如 due>0 显数字 Badge），否则省 |

> threads 比 loom 简化：只显计数 + CTA，缺口 sub 留空不 mock。P3 FSRS / coach-stats endpoint 落地后可补。

## 5. CSS scope 策略（2 个冲突，最高风险）

研究确认 globals 已有 **legacy `.kpi`（L708）+ legacy `.section-label`（L1258）**，与 loom 同名不同义（slice 之前故意没 port loom 版）。

→ **方案（同 slice-3 `.knowledge-loom` 先例）**：today 页根 `<main className="today-page today-loom">`；loom 冲突类**全 scope 在 `.today-loom` 下**：`.today-loom .kpi{…loom…}`、`.today-loom .section-label{flex+rule+count}`。新非冲突类（`.loom-hero`/`.thread-card`/`.kpi-row`/`.threads-grid`/`.stagger`/`.thread-*`/`.kpi-val`/`.kpi-go`）也放 `.today-loom` 下保险。已有复用类（`.card`/`.btn`/`.badge`/`.chip`/`.card-head`/`.bar`/`.hero-cta`/`.dot-sep`/`.eyebrow`/`.page-title`/`.page-lead`/`.serif`/`.tnum`/Stateful/SkLines）不重定义。
- **SectionLabel 注意**：knowledge-detail 用的是降级 legacy `.section-label`（无 rule line）。scope 在 `.today-loom` 下只影响 today，不动 knowledge-detail（保持现状，可接受）。

## 6. Touch 文件清单

**MODIFY**：`app/globals.css`（追加 scoped `.today-loom` hero/kpi/section-label/threads 层 + keyframes，banner「LOOM TODAY-7A LAYER」，grep collision-check）· `app/(app)/today/page.tsx`（包 `.today-loom` wrapper；PageHeader→LoomHero、kpi-strip→kpi-row、lanes→threads-grid；**删 `<TodayCopilotDrawer/>` import + inline mount**；hero Copilot 按钮点 `[data-testid="copilot-drawer-trigger"]`；下半 strips 留 legacy）。
**REUSE（不动）**：8 个 query + `KIND_TO_GROUP` 5-group 逻辑 · `TodayCopilotDrawer`（由 shell 挂，不在页内）· loom primitives（LoomCard/Btn/LoomBadge/LoomIcon/SectionLabel/Stateful/SkLines/useCountUp）· 既有 loom CSS。
**KEEP-LEGACY（7B 退役）**：下半 SessionStrip/AiChangeActivityStrip（undo mutation）/InboxStrip/CostRibbon + 它们的 `Badge`/`Button`/`.session-strip`/`.ai-change-strip`/`.inbox-strip`/`.cost-ribbon` + `undoAiChanges` mutation。`Badge`/`Button` import 若仍被下半用则留（grep 确认）；上半改用 LoomBadge/Btn。

## 7. 风险 + 缓解

- **.kpi / .section-label 冲突（最高）**：全 scope 在 `.today-loom` 下，append 前 grep 防裸重定义；不动 legacy 块（其它 surface + 下半 strips 仍用）。
- **Copilot 双挂**：删页内 mount（shell 已挂）；hero 按钮复用 hidden-trigger click（不引 `window.__openCopilot` 全局）。这其实修了个双挂 bug。
- **混用 legacy+loom 同文件**：7A 只换上半，下半 strips + undo mutation 原样；保留 8 query + KIND_TO_GROUP；build 验全页仍渲染 + copilot 仍能开。
- **缺口数据**：threads sub 细分 / hero name / weekheat 等留空不 mock（§4）。
- **build = CSS+route gate**；额外验 KPI 数字 + threads 链接 + hero CTA + copilot 开 + 下半 strips 仍 working。

## 8. Build order + verify gate

scoped CSS（globals）→ 重写上半（hero/kpi/threads + wrapper + 删 copilot 双挂）→ **verify**：typecheck / lint / audit×3 / build / KPI 4 卡数字 + 链接 · threads 3 卡 + CTA · hero CTA(review/record/refresh/copilot) · copilot 打开 · 下半 strips 仍渲染 + undo 仍 working · 移动断点。独立 review（+ 读 codex + CodeRabbit）+ push + PR（**你 merge**）。

---

*批准后按 build order 实施。本刀只重绘 /today 上半（hero+KPI+threads）；dashboard strips + WeekHeat 留 7B。*
