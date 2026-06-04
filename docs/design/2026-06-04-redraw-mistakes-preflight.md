# Redraw Wave-2 — mistakes 重绘 design pre-flight（`/mistakes`：chrome + 错题卡 + 状态态）

> **Status**: Pre-flight（随实现一起 commit；wave-2 自主授权下不单独停等批准，按 CLAUDE.md UI 规则现场逐字引 + 缺口表）。
> **Source**: loom-prototype `screen-mistakes.jsx`（checkpoint `f85aca6d`，提取于 `/tmp/loom-proto/docs/design/loom-prototype/screen-mistakes.jsx`）。YUK-169 / wave-2 L-mistakes。
> **Base**: branch `yuk-169-w2-mistakes`（自 main @ `40165001`，已含 shell + loom primitives/CSS + today/knowledge 重绘层）。

---

## 0. 范围

`/mistakes` 是单 query 纯展示屏（`app/(app)/mistakes/page.tsx`，139 行 react + ~90 行 inline style 对象）。**纯重绘**：唯一 `useQuery(['mistakes'])` + 派生计数 + `<Link>` 跳转**全部保留**，只把 legacy `PageHeader` + `Card` + inline-style 列表换成 loom chrome + `MistakeCard`。

prototype `screen-mistakes.jsx` 同文件里还有 `ScreenInbox`（收件箱/AI 提议裁决）—— **不属本 lane**（那是 inbox 路由，wave 计划归 composer/today proposals，不在 `/mistakes`）。本 lane 只取 `ScreenMistakes` + `MistakeCard` + `AttributionBadge` 三个 export 中的后两加屏本体。

## 1. 组件类型声明（CLAUDE.md 要求）

| 类型 | 物 |
|---|---|
| **设计基座（CSS，additive + scoped）** | `app/globals.css` 追加 `LOOM MISTAKES LAYER — Wave 2` 段：整屏包 `.mistakes-loom` wrapper，新错题卡类（`.mistake-card`/`.mistake-top`/`.mistake-q`/`.mistake-cmp`/`.cmp-label`/`.cmp-wrong`/`.cmp-right`/`.mistake-meta-row`/`.kp-badges`/`.kp-chip`/`.attr-badge`/`.state-badge`/`.mistake-foot`/`.mistake-evlink`）。冲突/共用类策略见 §5。 |
| **page（route）视觉重写** | `app/(app)/mistakes/page.tsx`：`PageHeader`→loom `.page-head`（eyebrow/标题/hero-cta/lead）；列表 `Card`+inline-style→`MistakeCard`（LoomCard）；load/error/empty 三态由手写 `Card` 段换 `<Stateful>` + `<EmptyState>` + `<SkLines>`。 |

> 组件类型 = **route 页内部视觉重绘**（非 drawer / 非 modal / 非新 route）。

## 2. 逐字引原型（`/tmp/loom-proto/docs/design/loom-prototype/screen-mistakes.jsx`）

- **L207-222 `ScreenMistakes` chrome**：`.page.view` > `.page-head`（`.eyebrow`「MISTAKES · 错题归因 · 最近 {N} 条 · 归因中 {pending}」L213；`.page-head-row` > `h1.page-title.serif`「错题本」L215 + `.hero-cta`（`<Btn variant="ghost" size="sm" icon="record" onClick={go("record")}>录新错题`L217 + `<Btn variant="primary" size="sm" icon="review" onClick={go("review")}>重练薄弱点`L218）；`.page-lead`「每条错题是一条 event-sourced 记录：题面 / 错答 / 知识点 / 归因（AI vs 人）/ 纠错状态…」L221）。
- **L224-231 `<Stateful>`**：`state={ds}` `errorText="错题加载失败。"`；`skeleton` = `.grid` 内 3×`<Card pad><SkLines rows={1}/></Card>`（L225）；`empty` = `<EmptyState icon="mistakes" title="还没有错题" text="复习答错或手动录入后，错题会聚到这里并自动归因。" action={<Btn variant="primary" size="sm" icon="record" onClick={go("record")}>+ 录新错题</Btn>}/>`（L226-227）；ok = `.grid.stagger`（gap `--s-3`）内 `DATA.mistakes.map(m => <MistakeCard/>)`（L228-230）。
- **L158-204 `MistakeCard`**：`<Card pad className="mistake-card-v2">`；`.mistake-top`（`.mistake-q.wenyan`{题面}L164 + `.badge.tone-{stateTone}.state-badge`{state，已纠正时前置 check icon}L165-167）；`.mistake-cmp`（`<span><span class="cmp-label">误</span><span class="cmp-wrong">{wrong}</span></span>` + `<span><span class="cmp-label">正</span><span class="cmp-right">{right}</span></span>`L169-172）；`.mistake-meta-row`（`.kp-badges` 内 `m.knowledge.map(k => <button class="chip chip-k mono kp-chip" onClick={go("knowledge")}>{k.label}</button>)`L174-178 + `<AttributionBadge at={m.attribution}/>`L179）；`.mistake-foot`（展开 `.expander`{事件链·N}L182-185 + `.evidence-link.mono`{→ events:{eventId}, `go("events")`}L186-188）；展开时 `.event-chain.fade-key` 内 `m.events.map` 渲染 `.event-row`/`.event-rail`/`.event-dot`/`.event-line`/`.event-body`/`.event-head`/`.event-label`/`.event-note`（L190-202）。
- **L152-156 `AttributionBadge`**：pending→`.badge.tone-hard.attr-badge`「归因中…」(refresh spin)；by==="ai"→`.badge.tone-info.attr-badge`「AI 归因 · {cause}({conf}%)」(sparkle)；else→`.badge.tone-good.attr-badge`「用户归因 · {cause}」(today icon)。**=== 现有 `CauseBadge` primitive 语义完全等价**（§3 映射）。

## 3. 数据映射（唯一 query `useQuery(['mistakes'])` → `/api/mistakes?limit=100`，复用不动）

API 行 = `{ id, question_id, prompt_md, wrong_answer_md, knowledge_ids[], cause, correction_state, created_at }`（`src/server/records/mistakes.ts` L61-72；`cause` = `{source:'user'|'agent', primary_category, secondary_categories?, user_notes, confidence?}|null`）。

| loom 字段 | 来源 |
|---|---|
| chrome eyebrow「最近 N · 归因中 P」 | `rows.length` + `rows.filter(cause===null).length`（现有 `total`/`pending`/`attributed` 派生，保留） |
| chrome CTA 录新错题→/record · 重练薄弱点→/review | 纯导航；现页只有 empty-state `/record` 链接；hero CTA = `Link`-wrap（无新 query/mutation，仅 router 导航，wave 协议「页面里没接线的原型功能不新接」此处指**数据接线**，导航链接属 chrome 等价物，照前几刀 today hero CTA 先例落地）。见 §4 注 |
| `.mistake-q` 题面 | `row.prompt_md` |
| `.state-badge`（纠错状态） | `row.correction_state` → 复用 `<CorrectionStateRenderer state={...} compact/>`（已有 primitive，等价 prototype 的 state badge） |
| `.cmp-wrong` 误 | `row.wrong_answer_md` |
| kp-chip 知识点 | `row.knowledge_ids` → chip，点击 `→/knowledge`（现页用 `<Badge>` 显 raw id，无 name 查询；保留显 id） |
| AttributionBadge 归因 | `row.cause` → 复用 `<CauseBadge cause={...} pendingSinceSec={...}/>`（user/agent/pending/confidence 全覆盖，等价 prototype AttributionBadge） |
| evidence-link「→ 事件链」 | `<Link href={`/events/${row.id}`}>`（现页已有，保留；`row.id` = attempt_event_id） |
| 列表 stagger 进场 | `.stagger`（复用 today-loom 已落的 stagger keyframe，但 scope 在 today-loom 下，本刀在 `.mistakes-loom` 下重声明，见 §5） |

## 4. 缺口 → 处理表（no-mock：后端没有的字段 drop + phase-deferred 注释，绝不假造）

| loom 字段 | 后端实情 | 处理 |
|---|---|---|
| `.cmp-right`「正」解 | 投影行**无** reference_md / 正解（`listMistakeProjectionRows` 只返 prompt_md + wrong_answer_md）。`question.reference_md` 存在于 question 表但未进 `/api/mistakes` 投影 | **DROP「正」对照行**，只渲染「误」侧（`.mistake-cmp` 退化为单 wrong-answer 行）。代码留 `// phase-deferred: 正解(reference_md)未进 /api/mistakes 投影；要补对照需扩 listMistakeProjectionRows 返 reference_md。上下文见 src/server/records/mistakes.ts L61` |
| inline 事件链展开 `m.events[]` + `.expander` | 本页**无**事件 list query（现页只 `<Link>` 到 `/events/{id}` 看完整链） | **DROP inline 展开 + expander**，保留 `→ 事件链` 链接（指向 `/events/{id}` 详情页）。留注释指向 events 详情路由 |
| kp-chip `k.label`（知识点名） | 本页**无** knowledge name 查询（投影只返 `knowledge_ids`） | chip 显 `knowledge_ids`（id 文本，同现页 Badge 行为），点击跳 `/knowledge`。留注释「无 name 查询，显 id；要显名需 fan-out /api/knowledge」 |
| AttributionBadge 三态 icon/文案 | `CauseBadge` primitive 已覆盖 user/agent/pending/conf | **复用 CauseBadge**（不重写 prototype 的 AttributionBadge——语义等价，符合「OSS/已有 primitive 解已解决问题」） |
| state badge 文案/tone | `CorrectionStateRenderer` 已覆盖 active/retracted/marked_wrong/superseded/missing/cycle | **复用 CorrectionStateRenderer compact**（active 默认不显，符合现页行为；prototype 的「已纠正」绿态由 superseded/correction 态体现） |

> 注（hero CTA）：「录新错题→/record」「重练薄弱点→/review」是纯导航 chrome，等价于 today 刀 hero 的 review/record 按钮（已落地先例）。不引入任何新 query/mutation，故不违反「接线不动 / 没接线的原型功能不新接」（该条约束针对**数据接线**）。CTA 用 `Link` 包 `Btn` 走 router 导航。

## 5. CSS scope 策略

grep `app/globals.css` 结果：
- **已存在（复用，不重定义）**：`.event-chain`/`.event-row`/`.event-rail`/`.event-dot`/`.event-line`/`.event-body`/`.event-head`/`.event-label`/`.event-note`（L7723-7769，activity 链）—— 但本刀 **DROP inline 事件链**（§4），故不渲染这些，无需碰。`.chip`/`.chip-k`（L6362）/`.hero-cta`（L7341）/`.nowrap-meta`（L7347）/`.eyebrow`/`.page-head`/`.page-head-row`/`.page-title`/`.page-lead`/`.serif`/`.mono`/`.wenyan`/`.badge`/`.grid`/`.card*` 全已在 globals → **复用不重定义**。
- **`.stagger`**：globals 里 `.stagger` 仅 scope 在 `.today-loom`（L8336-8373）。本刀需要列表进场动效 → 在 `.mistakes-loom` 下**重声明** `.mistakes-loom .stagger > *` + nth-child rise（不动 today-loom 块）。
- **新类（grep=0 全仓零命中，可全局但保险放 `.mistakes-loom` 下）**：`.mistake-card`/`.mistake-top`/`.mistake-q`/`.mistake-cmp`/`.cmp-label`/`.cmp-wrong`/`.cmp-right`/`.mistake-meta-row`/`.kp-badges`/`.kp-chip`/`.attr-badge`/`.state-badge`/`.mistake-foot`/`.mistake-evlink`。
  - 注：prototype 用 `.mistake-card-v2`，本刀改名 `.mistake-card`（grep 确认 `.mistake-card`/`-v2` 仓内零命中，无冲突）。
- **wrapper**：页根 `<main className="page mistakes-page mistakes-loom">`；新 loom 类全 scope 在 `.mistakes-loom` 前缀下（沿 `.today-loom`/`.knowledge-loom` 先例）。`.page` 保留（`.prose` 现页是 no-op，移除）。

## 6. Touch 文件清单

- **MODIFY** `app/(app)/mistakes/page.tsx`：包 `.mistakes-loom` wrapper；`PageHeader`→loom `.page-head`（eyebrow/标题/hero-cta/lead）；load/error/empty/ok 四态 → `<Stateful>` + `<EmptyState>` + `<SkLines>`；列表 `Card`+inline-style→`MistakeCard`（LoomCard + CauseBadge + CorrectionStateRenderer + chip-k + events Link）；删除约 90 行 inline `React.CSSProperties` 对象（被 loom 类取代）。**保留**：`useQuery(['mistakes'])` 全配置（queryKey/queryFn/refetchInterval/refetchOnWindowFocus）、`total`/`pending`/`attributed` 派生、`ApiAuthError` 错误分支文案、`/events/{id}` 链接、`MistakeRow` 接口。
- **MODIFY** `app/globals.css`：尾部追加 `LOOM MISTAKES LAYER — Wave 2` banner 段（scoped `.mistakes-loom` 错题卡类 + stagger 重声明）。append 前已 grep collision-check（§5）。
- **REUSE（不动）**：`Btn`/`LoomCard`/`LoomBadge`/`LoomIcon`/`Stateful`/`EmptyState`/`SkLines`/`CauseBadge`/`CorrectionStateRenderer`/`apiJson`/`formatRelTime` primitives 与既有 loom CSS。
- **DROP（legacy import 移除）**：`PageHeader`、legacy `Card`、legacy `Badge`（chip 改用原生 `.chip.chip-k`）—— 若移除后 grep 确认本文件不再引用即删 import。

## 7. 风险 + 缓解

- **「正解」缺失最显著**：错题本通常对照「误/正」，但投影无正解 → 单 wrong 行 + phase-deferred 注释；视觉上 `.mistake-cmp` 退化为单列，可接受（P-later 扩投影后补）。
- **复用 primitive vs 照搬 prototype**：AttributionBadge/state badge 用现有 `CauseBadge`/`CorrectionStateRenderer`（语义全覆盖），不照搬 prototype 的简化版——避免双套归因展示逻辑漂移（符合反过度工程 / 复用已有 primitive）。
- **stagger scope**：globals stagger 仅 today-loom；本刀在 mistakes-loom 下重声明，不动 today 块，零回归。
- **gate**：`pnpm build` = CSS-layer + route-export 唯一硬 gate（YUK-67）；无该页单测（grep=0）故不跑 vitest。

## 8. Build order

scoped CSS 层（globals append）→ 重写 page（wrapper + chrome + Stateful 四态 + MistakeCard）→ verify gate（biome / typecheck / build）→ commit（preflight + impl）。

---

*本刀纯重绘 `/mistakes`；唯一 query + 派生 + events 链接接线不动；正解对照 / inline 事件链 / 知识点名 三处后端缺口按 §4 drop + 注释，绝不 mock。*
