# Redraw Today 7B — design pre-flight（/today dashboard strips + WeekHeat 处理）

> **Status**: Pre-flight, awaiting user approval（CLAUDE.md UI 规则）。
> **Source**: loom-prototype `screen-today.jsx` + `loom.css` L248-276/379 + `screens.css` L37-46/189-233/337-349（checkpoint f85aca6d）。YUK-169 / YUK-203 P5。
> **Base**: 新分支 `yuk-169-redraw-today-7b`（自 main，已含 7A hero/kpi/threads + TODAY-7A CSS 层）。

---

## 0. 范围（7A pre-flight §0 既定拆法的后半刀）

- **本刀 7B** = `SectionLabel`「进行中 · 待裁决」+ `.dash-grid` 两列（左 SessionsStrip + AiChangesStrip[真 undo mutation]，右 ProposalStrip + CostRibbon）。**WeekHeat「本周编织」整段省略**（§4 缺口）。
- 完成后 /today 全页 loom 化；页内 legacy `Badge`/`Button`/`Link` 用尽则删 import。legacy CSS（`.session-strip`/`.ss-*`/`.ai-change-strip*`/`.inbox-strip`/`.cost-ribbon`）**本刀只停用不删**——归后续「legacy CSS cleanup pass」（cross-page grep 后统一退役）。

## 1. 组件类型声明

| 类型 | 物 |
|---|---|
| **设计基座（CSS，additive + scoped）** | `app/globals.css` 追加「LOOM TODAY-7B LAYER」，**全 scope 在既有 `.today-loom` 下**：`.dash-grid`/`.dash-col` · `.strip-list`/`.strip`/`.strip-lead(.tone-good/.tone-hard/.tone-coral)`/`.strip-body`/`.strip-title`/`.strip-sub`/`.strip-end`/`.is-undone` · `.prop-summary`/`.prop-summary-n`/`.prop-summary-kinds` · `.tone-chip-info/coral/good/hard/neutral` · `.cost-top`/`.cost-amt`/`.cost-budget`/`.cost-tasks`/`.cost-foot` + 响应式（`.dash-grid→1fr`、`.prop-summary-n` 缩字）。`.week-heat`/`.heat-*` **不 port**（§4）。 |
| **page（route）下半视觉重写** | `app/(app)/today/page.tsx`：4 个 legacy strip 组件 → loom 版（LoomCard + card-head + Stateful/SkLines），渲染处换 `.dash-grid` 布局。query/mutation 零改动。 |

## 2. 逐字引 loom（screen-today.jsx 7B 部分）

- **布局**：`<SectionLabel>进行中 · 待裁决</SectionLabel>` → `.dash-grid` > `.dash-col`(SessionsStrip + AiChangesStrip) + `.dash-col`(ProposalStrip + CostRibbon)。
- **SessionsStrip**：`Card pad` > `.card-head`（icon clock ·「进行中的会话」· meta「review_session」靠右）> `Stateful`（skeleton `SkLines rows=2`，empty「没有进行中的复习会话。」，error「无法读取会话状态。」）> `.strip-list` > `.strip`：`.strip-lead.tone-good/hard`(icon review/undo) · `.strip-body`（`.strip-title`「{subject} · 已复习 {reviewed}」· `.strip-sub.nowrap-meta`：状态 badge +「{dist} · {dur}」）· `.strip-end`（sm Btn「Resume/恢复」→ review）。
- **AiChangesStrip**：`.card-head`（icon undo accent ·「AI 改动 · 近 24h」· badge「可回滚」靠右）> Stateful（empty「过去 24 小时没有 AI 改动。」）> `.strip-list`，`.strip`(+`.is-undone`)：`.strip-lead.tone-coral`(sparkle) · title「**{agent}** 改了 {target}」· sub mono「{ops} ops · {delta} · {ver} · {when}」· end：撤销 ghost sm Btn ↔ `Badge tone=good`「已撤销」。
- **ProposalStrip**：`.card-head`（icon inbox ·「提议收件箱」· sm ghost Btn「去裁决」→inbox 靠右）> Stateful（empty「没有待审提议。」）> `.prop-summary`：`.prop-summary-n.serif.tnum`{total} + `.prop-summary-kinds`（`chip.tone-chip-X`「{label} **{n}**」）。
- **CostRibbon**：`.card-head`（icon bolt ·「今日 AI 成本」· meta「预算 ${budget}」靠右）> Stateful（empty「今日尚无 AI 花费。」，error「成本服务暂不可用。」）> `.cost-top`>`.cost-amt.serif.tnum`「${today}<span class=cost-budget>/ ${budget}</span>」· `.bar`（宽 = today/budget%）· `.cost-tasks`（chip「{task} **${v}**」）· `.cost-foot.nowrap-meta.mono`「tokens {in}k in · {out}k out · {toolCalls} tool calls」。
- **WeekHeat**（引用以记录省略对象）：`SectionLabel`「本周编织」> Card >`.card-head`(target accent ·「7 天活动热力」· badge「+12% 较上周」) > 4×7 `.heat-cell[data-lvl]`，数据 = **硬编码 `seed` 数组**（prototype-only）。

## 3. 数据映射（query/mutation 全复用，后端字段惊喜地全）

| loom 字段 | 来源（现 page.tsx 已有） |
|---|---|
| sessions 行 | `sessionsQ` rows：active(started)/paused/completed 选取逻辑**保留**；title「review · 已复习 {reviewed_count}」；sub = 状态 badge + `rating_counts`「不会 a · 模糊 h · 会了 g」+ `formatDuration(duration_ms)`/`formatDay`；completed 行 `summary_md` 进 sub；end Btn → `/review`（paused → `/review?session={id}`，沿用现有三按钮文案） |
| AI 改动行 | `aiChangesQ` rows：agent=`actor_ref`、target=`artifact_id.slice(0,12)`（保留 →`/events/{event_id}` 链接）、ops=`ops_count`、delta=「新增 {new_blocks} block」、ver=「v{previous}→v{next}」、when=`formatDateTime(created_at)`、`undone`→`.is-undone`+已撤销 badge；**undo = 现 `undoAiChanges` mutation 原样**（单行撤销 + card-head 保留现有「全部撤销」bulk 按钮——prototype 无但属既有功能，放 badge 旁） |
| proposal chips | `proposalKpi.total` + 现 5-group `proposalGroupCounts`（chips：内容 content/学习项 learning/新知识点 nodes/关系 edges/复核 review，tone 按组取）+ `has_more`→「{total}+」；**保留现有「知识图谱」捷径**（nodes+edges>0 时第二个 sm ghost Btn，prototype 无但属既有功能） |
| cost | `costQ`：`today.spend`、budget=**5 硬编码（沿用现行为，非新 mock）**、`by_task` top3 chips（`task_kind`+`spend`）、foot=`tokens_in/out`（÷1000 取 1 位）+ `tool_calls`（`ledger_rows` 可并入 foot） |
| Stateful state | 各 query `isLoading→loading` / `error→error`（onRetry=refetch）/ 空数据→empty / 否则 ok |

## 4. 缺口 → 处理（不 mock；同 7A §4）

| loom 字段 | 后端 | 处理 |
|---|---|---|
| **WeekHeat 整段**（7 天热力 + 「+12% 较上周」badge） | 无 7 天活动聚合 endpoint；prototype 数据 = 硬编码 seed | **整段省略**（SectionLabel「本周编织」一并不渲染）；page 内留 phase-deferred 注释指回本 doc §4，待活动聚合 endpoint 落地再补 |
| sessions `subject`「文言文」 | row 无 subject 字段 | title 用「review · 已复习 N」（type 实值），不假造科目名 |
| cost `budget` | 无预算配置，现页硬编码 5 | 沿用硬编码 5（既有行为）；不引新配置 |
| 空态行为 | 现 legacy 组件空时 `return null` 整卡隐藏 | 改 prototype 行为：**卡常驻 + `quiet-empty` 文案**（设计意图，4 卡构成稳定 dashboard 骨架） |

## 5. CSS scope 策略

- 已 grep `app/globals.css`：`.dash-grid`/`.dash-col`/`.strip`/`.strip-list`/`.strip-*`/`.prop-summary*`/`.cost-top/amt/budget/tasks/foot`/`.tone-chip-*`/`.is-undone` **均无裸定义**（仅 legacy `.ai-change-strip*`/`.session-strip`/`.cost-ribbon`/`.inbox-strip` 是不同名字，不冲突、不动）。照例全放 `.today-loom` 下保险 + append 前再 grep 一次。
- **直接复用不重定义**：`.card-head`/`.card-title`/`.card-icon(.accent)`/`.chip`/`.bar`/`.quiet-empty`(L7358)/`.nowrap-meta`(L7347)/`.serif`/`.tnum`/`.mono` + Stateful/SkLines primitives（slice-1 已 port）。

## 6. Touch 文件清单

**MODIFY**：`app/globals.css`（追加 scoped「LOOM TODAY-7B LAYER」，§1 类清单）· `app/(app)/today/page.tsx`（4 个 strip 组件重写为 loom 版；渲染处包 `.dash-grid`/`.dash-col` + SectionLabel「进行中 · 待裁决」；WeekHeat 省略注释；`Badge`/`Button`/`Link` import 用尽则删——`LoomBadge` 顶上）。
**REUSE（不动）**：8 query + `undoAiChanges` mutation + `KIND_TO_GROUP`/`proposalGroupCounts`/`proposalKpiSub` + `formatDuration`/`formatDay`/`formatDateTime` · loom primitives（LoomCard/Btn/LoomBadge/LoomIcon/SectionLabel/Stateful/SkLines）· 7A 上半 + TODAY-7A CSS 层。
**KEEP（停用不删）**：legacy `.session-strip`/`.ss-*`/`.ai-change-strip*`/`.inbox-strip`/`.cost-ribbon` CSS（归 cleanup pass；`.ai-change-panel` 系 events 页另一物，勿混）。

## 7. 风险 + 缓解

- **undo mutation 回归（最高）**：`undoAiChanges` 逻辑零改动，只换壳；验单行撤销 + 全部撤销 + `undoingIds` pending 态 + `undone` 已撤销态 + invalidate 后刷新。
- **空态行为变化**：null→常驻空卡是设计意图；验 4 卡空态文案渲染。
- **icon 名差异**：prototype 用 clock/undo/sparkle/inbox/bolt/check——LoomIcon registry 若缺名，照 slice-3 先例就近映射 + 注释（不加新 glyph 不报错）。
- **Stateful 接入**：error 态带 onRetry=refetch；不吞错（empty ≠ error）。
- **build = CSS+route gate**；额外验 dash-grid 两列/移动单列 · sessions 三态行 · AI 改动撤销往返 · proposal chips 计数与 KPI 一致 · cost bar 宽度 + foot 数字 · 7A 上半未回归。

## 8. Build order + verify gate

scoped CSS（globals）→ 重写下半 4 strip + dash-grid 布局（+删 WeekHeat 段 + 注释）→ **verify**：typecheck / lint / audit×3 / build / §7 清单。独立 review（+ 读 codex + CodeRabbit）+ push + PR（**你 merge**）。

---

*批准后按 build order 实施。本刀完成 /today 全页 loom 化；WeekHeat 留待活动聚合 endpoint。*
