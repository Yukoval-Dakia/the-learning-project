# 教研简报（Teaching Brief）· /today 主交付单元 — UI 设计稿 (FINAL)

- **Issue**: YUK-707（P0F/3 — teaching brief on /today；消费 yuk-706 的只读 read model）
- **Date**: 2026-07-19
- **Status**: **FINAL — 三镜对抗 review 后终裁定稿**。所有 blocker/major/nit 判词已就地落实（见每节 `[裁决 N]` 标注 + 文末《判词落实对照》）。实现前仍需按 CLAUDE.md「UI Design Compliance」pre-flight 复核 touch 文件清单。
- **契约权威（LAW）**: `docs/design/2026-07-19-teaching-brief-contract.md`（YUK-705，P0F wire contract；当前落在 `yuk-705-teaching-brief-contract` 分支，随 P0F 链合入 main）。本稿任何决策若与该契约冲突，以契约为准。
- **消费读模型（yuk-706，worktree `/Users/yuqi/yukoval-projects/tlp-wt-yuk706`，分支 `yuk-706-teaching-brief-read-model`）**:
  - `src/capabilities/shell/api/contracts.ts` → `TeachingBriefSchema` / `TeachingBriefResponseSchema` / `TeachingBriefEvidenceRefSchema` / `TeachingBriefFindingSectionSchema` / `TeachingBriefBasisSectionSchema` / `teachingBriefCommon`
  - `src/capabilities/shell/server/teaching-brief.ts` → `TeachingBrief` 判别联合 + `loadTeachingBrief`（分支选择器 `loadOutcomeBrief` / `loadProbeBrief` / `loadFindingBrief`；fail-closed 日志 `warnSkipped`；TTL 常量 `TEACHING_BRIEF_FINDING_TTL_MS` / `TEACHING_BRIEF_OUTCOME_TTL_MS`）。
- **视觉基线复用**: `docs/design/2026-07-12-prep-desk-card-design.md`（备课台 felt 面 §3 inline 展开）+ 已 live 的 `PrepDeskConjectures` / `ProbeAnswers`（`ProbeAnswerCard`）卡样式（`web/src/globals.css` `.prep-desk-*` / `.pd-*` / `.pa-*` 族）。
- **情感内核**: `docs/superpowers/specs/2026-06-18-private-teaching-research-team-vision.md` §2（「为你而备、你不在也在转」= pull not push）+ §8（红线：规划只出提案、engagement 是头号过滤器、pull not push）。

> **锚点约定（[裁决 9b]）**：本稿一律用 **符号锚点**（函数名 / schema 名 / 组件名 / CSS selector / contract §节号）指代代码，不写会随实现漂移的行号。

---

## 0. Pre-flight（CLAUDE.md「UI Design Compliance」三件套）

### 0.1 逐字引用相关 design doc / contract 段落

- 契约 §0：「教研简报是 `/today` 上**唯一的一份「为你而备」交付**，不是把猜想、探针和结果三个列表拼在一起。一次响应最多有一个 primary brief。」四块用户内容：`finding` / `basis` / `prepared_action` / `current_outcome`；「`brief_id`、`state` 和时间戳是 transport metadata，**不是第五块产品内容**」。
- 契约 §1：`overnight-digest` 的 `new_conjectures_count`、proposal count、run count、agent-note count **不参与新 wire**，也**不作为 primary badge**；`new_conjectures_count` 是历史创建数，accept/dismiss 后不减少，「绝不能拿它推导 pending、primary 或 CTA 状态」。「activity facts 与 actionable primary 是两个读模型。」
- 契约 §5：全局唯一 primary 的确定性顺序 = `latest outcome > latest active probe > highest-salience fresh finding > quiet null`；「不得先各取三条再由客户端选；不得用 overnight count、unread、打开次数或 UI 本地顺序选 primary。」
- 契约 §8.3：「四块用可导航的 heading/region 语义；状态不能只靠 coral/green 等颜色表达。」「同卡 `finding → probe_ready → outcome` 原位更新后，把焦点移到新状态 heading，并用 `aria-live='polite'` 宣告一次；不得整页抢焦点或重复朗读 evidence。」
- 卡设计 §3：「`/today` 内的 **inline 展开面**（section/panel）……非新 route、非 modal……与『夜链·交班』带同源……守 pull-not-push。」
- vision §2：「一个**为你准备好东西、欢迎你回来的团队**让人想回来 → pull。」

### 0.2 组件类型声明

**Inline band（route page section），不是 route / 不是 modal / 不是 drawer。** 见 §1。

### 0.3 将 touch 的文件（创建 vs 修改，明细见 §8）

- **创建**：`TeachingBrief.tsx`（`TeachingBriefBand`）、`teaching-brief-api.ts`、`TeachingBrief.unit.test.tsx`（+ `TeachingBrief.interaction.unit.test.tsx`）、`web/src/globals.css` 增 `.tb-*` 段。
- **修改**：
  - `TodayPage.tsx`（挂 brief 为主 + 新增私有 `DegradedKindsFlags` 上提到位置 1 + `OvernightDigestBand` 活动面降级为二级折叠盘）。
  - `ProbeAnswers.tsx`（`export ProbeAnswerCard`，加 optional `onAnswered`；submit 后追加 `['teaching-brief']` 失效）。
  - `tests/usability/api-fixtures.ts`（补 `GET /api/prep-desk/brief` fixture）。

---

## 1. 组件类型：inline band on /today（确认，非 route/modal）

**结论：新建 `TeachingBriefBand`，作为 `TodayPage` workbench 块的 inline band，default-visible，排在 workbench Stateful 块的活动区首屏（`DegradedKindsFlags` 之后、`OvernightDigestBand` 之前）。**

论证：

1. **契约 §0 明令它是 `/today` 上唯一一份「为你而备」交付** → 它是页内一等内容块，不是需要用户先导航过去的目的地。新 route 与契约「pull、来访时呈现」相悖。
2. **与已 live 的 `OvernightDigestBand` 同源同页**（都是「你不在时团队做的」）；brief 采同一 inline band 形态并列，视觉与语义一致。
3. **不是 modal / drawer**：契约 §8.3 要求「同卡 `finding → probe_ready → outcome` **原位更新**后把焦点移到新状态 heading」——原位状态演进要求常驻 inline band，弹出层无法承载跨 accept/answer 的原位状态推进。
4. **不是「从 chip 展开」**：验收要求 brief **default-visible**、是**主 handoff 单元**；chip-gated 展开是次级 pull。被降级的夜间活动面才走「展开才可见」的待遇（§2.4）。

---

## 2. 信息架构（四块 × 每态布局 + degraded 上提 + 夜间活动降级）

### 2.1 契约四块 → 卡内布局骨架（真 heading + prose-only evidence）

`TeachingBriefBand` 渲染一张 `LoomCard`（复用 `.prep-desk-card` felt：coral 左脊），卡头为**真 `<h2>`** 卡标题，卡内四个内容块各为 **`<section aria-labelledby>` + 真 `<h3>`**（[裁决 7]：用真 heading，不用 `role="group"` eyebrow 作为主承载）：

| 契约块 | wire 字段 | 卡内 region | heading（真 `<h3>`） | 渲染 |
|---|---|---|---|---|
| **发现** `finding` | `finding.claim_md` | `<section>` | `教研团在检验什么` | claim_md 作主文（serif，`.tb-claim` ← `.pd-claim` 语系）。framing = 可证伪假设（契约 §2.2） |
| **依据** `basis` | `basis.summary_md` + `basis.evidence_trace[]` | `<section>` | `为什么这么判断` | summary_md 作正文（`.tb-basis`）；evidence_trace **逐条**经 `evidenceReadable()` 渲成**纯文本 chip**（详见下方 [裁决 8]） |
| **已备行动** `prepared_action` | 见 §5 | `<section>` | `已经为你备好` | 按 `prepared_action.kind` 分支渲染（`review_finding` / `answer_probe` / `none`），见 §5 |
| **当前结果** `current_outcome` | `current_outcome.summary_md`（+ `status`） | `<section>` | `当前结果` | summary_md 作结论文本 + 状态图标/文字（非仅颜色）。这是原位状态演进的 announce 落点（§6） |

**heading 结构（[裁决 7]）**：卡头 `<h2 id="tb-title" className="card-title">为你而备</h2>`；四块各 `<section aria-labelledby="tb-h-finding">…<h3 id="tb-h-finding" className="tb-block-title">教研团在检验什么</h3>…`。四个 `<h3>` 视觉压到与 `.pd-eyebrow` 同密度（小字、coral-ink、宽字距），但语义上是真标题 → 屏读器 heading 导航（h2→h3×4）与「focus 移到新状态 heading」（§6）**同时字面可满足**。`<h3>` 携 `tabIndex={-1}` + ref，供 §6 编程聚焦。

**evidence chip（[裁决 8]，最强防泄漏）**：
- `basis.evidence_trace` **逐条一枚 chip**（`evidence_trace.map((ref, i) => …)`），**永不合并、永不加 `×N` / 计数后缀**（契约 §8.1 禁 evidence 计数）。server 已按 `(role,kind,id)` 去重（`dedupeEvidence`），故每条都是不同 provenance；即便两条同 kind 白话文案相同（如两枚 induction event 都渲成「源自一次 AI 判定事件」）也照渲两枚，不折叠。
- **不用** `inbox-api` 的 `dedupeEvidence`（它会带 `count`）。
- chip **纯文本（prose-only）**：只取 `evidenceReadable(ref).text`，**忽略 `.route`**——即便 knowledge/artifact 返回可导航 route 也渲成 `<span>` 而非 `<a>`（navigable evidence 推迟到有授权 read path 再做，契约 §8.2「没有授权 read path 就只显示中性来源标签」）。
- DOM 里**不出现任何 raw id**：id 不进文本、不进 `title`/`href`/`data-*`/`aria-*`，React `key` 用**下标 `i`** 而非 `ref.id`（避免任何 id 泄漏面）。测试深断言 DOM 全文（含属性）无 `×` / 计数 token、无任何 raw id（§9.2）。

**渲染规则（跨块）**：`claim_md` / `summary_md` / `probe_preview_md` / `prompt_md` 一律**按纯文本渲染**（React 自动转义），**不引入 Markdown renderer**——沿用 `PrepDeskConjectures` / `ProbeAnswerCard` 既有 idiom（`{probe.prompt_md}` 纯文本），天然满足契约 §8.2。富文本是另开 slice 接现有安全 renderer，本稿不做。

### 2.2 四态 × 布局差异

四块在四态**都必填**（契约 §2.1，Zod strict）；差异只在 `prepared_action` / `current_outcome` 形态：

- **`finding`**：发现 + 依据 + 「已经为你备好」显 `prepared_action.probe_preview_md`（团队正要问的题**预览文本**，非作答框，框 = 「团队正要问你的一道题」tripwire framing，复用 `.pd-probe`）+ 双 CTA（就按这个方向验证 / 不太像）；当前结果 = `awaiting_decision` summary。
- **`probe_ready`**：发现 + 依据（evidence 已含 probe ref）+ 「已经为你备好」显 `prepared_action.prompt_md` + 单 CTA「现在就试做这道题」（就地 reveal 单枚 `ProbeAnswerCard`，§5.2）；当前结果 = `awaiting_answer` summary。
- **`outcome_confirmed` / `outcome_retired`**：发现 + 依据（evidence 已含 outcome ref）+ 「已经为你备好」= **无 CTA**（`prepared_action.kind='none'`，契约 §2.1 / §4.2）；当前结果 = 对账结论（confirmed→`check`/good tone；retired→`checkCircle`/neutral tone），**显示态、无动作**。

### 2.3 degraded_kinds 红旗上提为独立元素（silent-failure，位置 1，永在 brief 之前）[裁决 1 · BLOCKER]

- degraded_kinds **不在 brief wire 上**（`TeachingBriefSchema` 无此字段）。它来自既有 `overnight-digest` 查询（`OvernightDigestResponseSchema.degraded_kinds`）。
- **本稿把红旗行从 `OvernightDigestBand` 内部 hoist 出来**，成为一个**微型 presentational 组件 `DegradedKindsFlags`**，渲染在 workbench **位置 1，在 `TeachingBriefBand` 之上**：
  - `DegradedKindsFlags` 自持一个 `useQuery({ queryKey: ['overnight-digest'], queryFn: getOvernightDigest })`——与 `OvernightDigestBand` 的**同 key 查询被 react-query 去重**，零额外网络（沿用 `OvernightDigestBand` / probe-queue 各自持同 key 查询的既有 idiom）。
  - 渲染逻辑就是原 `OvernightDigestBand` 里 `d && d.degraded_kinds.length > 0` 那段 JSX（`LoomBadge tone="again"` + `LoomIcon "alert"` + `{aiTaskLabel(dk.task_kind)}失败 {dk.error_count} 次`，`title={learnerFailureSummary(dk.recent_error_messages)}`）**整段迁移过来，不改文案**。
  - **静默降级**：loading / error / `degraded_kinds` 为空时 `DegradedKindsFlags` 返回 `null`（位置 1 不出 skeleton，红旗是横切标红条不是主 surface）。
- **`OvernightDigestBand` 不再渲染 degraded 行**（该 JSX 已迁出，不双渲）；它**保留全部 observable facts**（活动 chips、quiet-empty、去裁决 foot、待你试做 queue）——仅层级变化（红旗上提），无信息删除（[裁决 1] 明确「ticket-allowed」）。
- 验收「degraded_kinds silent-failure red flags stay directly visible, never hidden behind the narrative card」由此满足：narrative card = teaching brief；红旗是独立读模型，永远在 brief **之前、之上、无折叠**渲染。
- `learnerFailureSummary()` + `aiTaskLabel()` 仍是 `TodayPage.tsx` 模块级 helper，`DegradedKindsFlags` 与（若仍存在的）其它消费方共用，不迁不改。

> **删掉草稿旧注**：草稿 §2.5「不需要把 degraded_kinds 提到独立组件」一句作废——本裁决就是要把它提为独立元素。

### 2.4 夜间活动面降级为二级折叠盘（demote-not-delete，both surfaces 保留可达）[裁决 5 · MAJOR]

- 现状：`OvernightDigestBand` 的活动 chips（夜间任务 / 笔记精炼 / 图谱提议 / 备课猜想 / AI 观察）由 `buildDigestChips()` 平铺；`备课猜想 chip` 是 toggle → 内联展开 `PrepDeskConjectures`；`待你试做` 是独立 probe-queue → toggle 展开 `ProbeAnswers`。
- **裁决：REJECT 草稿「删 `待你试做` queue + `PrepDeskConjectures` 面板」的 D1 推荐。改采「both demote into 二级折叠盘」——两者都保留、都可达，只降一级。** demote-not-delete 是本仓库锁定产品原则（pre-AI 功能只降级不移除）。
- **降级形态（hierarchy only，保留 observable facts）**：
  - `OvernightDigestBand` 内新增一个 **default-collapsed 一级折叠盘**（disclosure，summary 行「昨夜 AI 还替你做了这些」+ `aria-expanded`）。活动 chips 行 + `待你试做` probe-queue 都收进这个折叠盘。
  - 折叠盘展开后：活动 chips 仍是**中性观察计数**（无红点、无「N 条待处理」、无 action-required 样式，契约 §8.1）；`备课猜想 chip` **仍是能 toggle 出 `PrepDeskConjectures` 的二级展开**（不去 toggle 化、不降成纯 count）；`待你试做 chip` **仍能 toggle 出 `ProbeAnswers`**。二级展开即「demote 后仍可达」。
  - 既有的 auto-collapse effect（`conjOpen`/`probeOpen` 在计数归零时自动收起）保留；只是外层再包一层 `activityOpen` 折叠盘。
- 首屏无「两个『为你而备』入口」之忧：brief 是唯一 default-visible 的主交付；猜想面/探针面藏在二级折叠盘里，需用户主动展开两层才见——primary 唯一性（契约 §0/§5）与「pull not push」两全。
- `去裁决` foot（proposals → `/inbox`）保留不动：它服务图谱 proposal 裁决，与 teaching brief 链路无关。

### 2.5 workbench 块新排序（TodayPage 内，additive + 层级重排）

```
<Stateful summary>                         （既有）
  1. <DegradedKindsFlags/>                 ← 新增独立元素 · 位置 1 · 读 ['overnight-digest']（去重）· degraded 空则渲 null（§2.3 · [裁决 1]）
  2. <TeachingBriefBand/>                  ← 新增 · 主 handoff 单元 · default-visible（§1）
  3. <OvernightDigestBand/>（降级）         ← degraded 行已迁出；活动 chips + 待你试做 queue 收进「昨夜 AI 还替你做了这些」二级折叠盘（§2.4 · [裁决 5]）
  4. <KpiRow/> …（其余 workbench 不动）
```

> 实现注：`DegradedKindsFlags`、`TeachingBriefBand` 都是 `TodayPage.tsx` 内的独立子树，挂在现 `<OvernightDigestBand navigate={navigate} />` 之上两行（`OvernightDigestBand` 留原位但内部层级重排）。`DegradedKindsFlags` 可作 `TodayPage.tsx` 内私有组件（与 `OvernightDigestBand` 同文件，直接复用模块级 `learnerFailureSummary`/`aiTaskLabel`，免 export 扰动）。

---

## 3. UI 状态全枚举（每态 → 触发它的确切 wire 条件）

数据源：`getTeachingBrief()` → `GET /api/prep-desk/brief` → `{ brief: TeachingBrief | null }`（react-query key `['teaching-brief']`）。状态机由 `q.isLoading / q.isError / q.data.brief` + `brief.state` 派生（用 if/else `statefulStatus()` 惯例，规避链式三元 OCR flag）。

| # | UI 状态 | 确切 wire / query 条件 | 呈现 |
|---|---|---|---|
| 1 | **loading** | `q.isLoading === true` | `Stateful status="loading"` → `SkLines`（带 aria 标签，§6）。契约 §8.3 |
| 2 | **route error** | `q.isError === true`（非 2xx；契约 §7「DB/查询失败 route 返回非 2xx，绝不伪装 `{brief:null}`」） | `Stateful status="error"` → `ErrorState`（`role="alert"` + 重试）。文案「教研简报暂不可用。」 |
| 3 | **quiet null** | `q.data.brief === null` | `.tb-quiet`（复用 `.quiet-empty`）文案「教研团暂无需要交付的新判断。」（契约 §6.5）。**无「全部清空」/连续天数/待办数/成就动效** |
| 4 | **finding** | `brief.state === 'finding'`（`loadFindingBrief`；触发 = 未过期 pending conjecture proposal，契约 §3） | 四块 + probe 预览 + 双 CTA（§2.2 / §5.1） |
| 5 | **probe_ready** | `brief.state === 'probe_ready'`（`loadProbeBrief`；触发 = accepted proposal + served-but-unanswered mind_probe question；`expires_at===null`） | 四块 + prompt + 「现在就试做」CTA → reveal 单枚 `ProbeAnswerCard`（§5.2） |
| 6 | **outcome_confirmed** | `brief.state === 'outcome_confirmed'`（`loadOutcomeBrief`；触发 = probe_result `resolution='confirmed', outcome=0`） | 四块 + 对账结论（confirmed），**无 CTA** |
| 7 | **outcome_retired** | `brief.state === 'outcome_retired'`（`loadOutcomeBrief`；触发 = probe_result `resolution='retired', outcome=1`） | 四块 + 对账结论（retired），**无 CTA** |
| 8 | **degraded_kinds present**（横切，非 brief 态） | `overnight-digest` query `d.degraded_kinds.length > 0`（与 brief 正交） | `DegradedKindsFlags` 位置 1 直显（§2.3）；**与 1-7 任一态叠加共存** |

**关键非态（契约 §6.5 明令）**：`insufficient_evidence` / `degraded` / `error` **不是 `TeachingBrief.state`**。证据不足候选在 server 端 fail-closed 跳过（`warnSkipped`），对 UI 呈现为 `{brief:null}`（态 3）或下一候选（态 4-7）；基础设施失败呈现为态 2。**UI 只有三种诚实呈现**：有可信交付（4-7）/ 当前没有可信交付（3）/ 服务失败（2）——**不造第五个「degraded」lifecycle 态**。

---

## 4. CSS 方案（命名复用既有 token / class）

**原则**：复用既有 design-system token 与 felt 语系，不造平行样式。新增 `.tb-*` 前缀类，落 `web/src/globals.css`，紧邻 `.prep-desk-*` 段，同属「为你而备」felt 家族。

### 4.1 直接复用（不新写）

- **卡容器**：`LoomCard pad` + `.prep-desk-card`（coral 左脊）→ `className="prep-desk-card tb-card"`。
- **卡头**：`.card-head` / `.card-icon.accent` / `.card-title`（`.card-title` 视觉挂到真 `<h2>`）。
- **eyebrow → block 真 heading 视觉**：`.pd-eyebrow` 的密度语言用于 `.tb-block-title`（真 `<h3>`，见 §4.2）。
- **claim 主文**：`.pd-claim serif`。
- **probe 预览框**：`.pd-probe` / `.pd-probe-lbl` / `.pd-probe-md`（paper-sunk 内嵌 + coral 标签 + serif 题面）——finding 的 `probe_preview_md` 套它（probe_ready 的作答面直接用既有 `ProbeAnswerCard` 自带 `.pa-*`）。
- **evidence chip**：`.pd-ev-chip`（渲为 `<span>`，永不 `<a>`，[裁决 8]）+ `evidenceReadable().text`。
- **CTA 按钮**：`Btn`（`variant="primary"|"ghost"`）。
- **empty**：`.quiet-empty`。**error**：`ErrorState`。**skeleton**：`SkLines`。
- **状态 badge / 图标**：`LoomBadge tone="good"|"neutral"` + `LoomIcon`（`check`/`checkCircle`/`sparkle`/`target` 均在 icon 集）。
- **二级折叠盘 / probe reveal 容器**：`.prep-desk-expand`（既有）。

### 4.2 新增 `.tb-*`（薄，全部引用既有 token）

- `.tb-card` — 若需与 prep-desk 卡拉开一档间距/强调；否则纯复用 `.prep-desk-card`。
- `.tb-block` — 四 `<section>` 纵向分隔：`display:grid; gap:var(--s-2)`，region 间 `border-top:1px dashed var(--line)`。
- `.tb-block-title` — 真 `<h3>` 视觉（[裁决 7]，压到 eyebrow 密度）：`font-size:var(--fs-meta); color:var(--coral-ink); letter-spacing:var(--ls-wide); font-weight:var(--fw-medium); margin:0`。承 `tabIndex={-1}` 时 `:focus-visible` 用 `var(--shadow-focus)`。
- `.tb-claim` / `.tb-basis` — 主文/正文，全引 `.pd-claim` / 正文 token。
- `.tb-actions` — CTA 行：复用 `.pd-actions`（`display:flex; gap:var(--s-2)`）。
- `.tb-outcome` — 结论行：`display:inline-flex; align-items:center; gap:6px`，图标+文字（confirmed 用 `--good-ink`，retired 用 `--ink-3`）。
- `.tb-live` — `aria-live` 视觉隐藏区（§6）：既有 visually-hidden idiom（`.sr-only` 或等价）。
- **窄屏无横向溢出**（验收）：所有 chip/meta/actions 行 `flex-wrap:wrap`（同 `.digest-chips`/`.pd-meta`）；probe/claim 文本容器 `min-width:0`；无固定 px 宽块。
- **减弱动效**：折叠盘 chevron/过渡包 `@media (prefers-reduced-motion: reduce)`。

> 不新增颜色、不新增间距刻度、不新增字体——全部 `var(--*)`。

---

## 5. 交互规格（CTA 连线）

### 5.1 finding — accept / dismiss（走既有 decision route）

- **数据**：`brief.prepared_action`（kind `review_finding`）带 `proposal_id`（= `brief_id`）。
- **双 CTA**（验收指定文案）：
  - primary「**就按这个方向验证**」→ `decideProposal(proposal_id, 'accept')`
  - ghost「**不太像**」→ `decideProposal(proposal_id, 'dismiss')`
- **route**：`decideProposal()`（`inbox-api.ts`）→ `POST /api/proposals/:id/decisions`——**与已 live 的 `PrepDeskConjectures` 同一条既有裁决管道**，零新后端。契约 §3「用户 accept；同一 transaction 成功插入 mind-probe question」→ 投影转 `probe_ready`。CTA 文案是「验证方向」非「加进复习」（契约 §8.3 + §10「不把 accept 解释成 enroll review」）。
- **成功后**：`invalidateQueries(['teaching-brief'])`（重投影：accept→probe_ready / dismiss→下一候选或 null）+ `['overnight-digest']`（备课猜想 count 变化）+ `['prep-desk-probes']`（accept 铸出 probe → 二级 `待你试做` queue 计数变化）。镜像 `PrepDeskConjectures` 的 invalidation 集。
- **失败**：契约 §7「保留当前 brief，不乐观转态；允许原位重试」→ 不乐观移除卡，`.tb-error`（`role="alert"`）显「操作失败，请重试」，CTA 复位可重试。
- **焦点/announce**：accept 成功后 brief 原位转 `probe_ready`（同 `brief_id`）→ 触发 §6 前进宣告 + 焦点移到「已经为你备好」`<h3>`；dismiss 后 brief 换下一候选或 null（`brief_id` 变或消失）→ **不宣告、不移焦**（§6）。

### 5.2 probe_ready — reveal 单枚既有作答卡（[裁决 2] + [裁决 3]）

- **数据**：`brief.prepared_action`（kind `answer_probe`）带 `probe_question_id` + `prompt_md`；`finding.knowledge_id` 供构造。
- **本 slice 决策**：单 CTA primary「**现在就试做这道题**」→ **就地 reveal 一枚 `ProbeAnswerCard`**（`aria-expanded` + `aria-controls` 指向 reveal region），**不在 brief 卡内重建作答/上传/判分流，也不铺开整张多探针 `ProbeAnswers` 列表**。
- **[裁决 3 · 单探针 scope，机械 extract]**：
  - `ProbeAnswers.tsx` 里的 per-probe 卡已经是独立函数 `ProbeAnswerCard`（当前 module-private）。本 slice **把它 `export`**，签名扩为 `ProbeAnswerCard({ probe, onAnswered }: { probe: PrepDeskProbeWire; onAnswered?: (resolution: 'confirmed' | 'retired') => void })`。
  - `ProbeAnswers`（既有多探针 queue 面）与 brief **复用同一 `ProbeAnswerCard`**；queue 面 `.map` 出多枚，brief 只渲**一枚**，scope 到 `brief.prepared_action.probe_question_id`。
  - brief 从 brief 数据**就地构造单探针 wire**，无需再打 `GET /api/prep-desk/probes`：
    ```ts
    const probeWire: PrepDeskProbeWire = {
      probe_question_id: brief.prepared_action.probe_question_id,
      prompt_md: brief.prepared_action.prompt_md,
      knowledge_id: brief.finding.knowledge_id,
    };
    // reveal:
    <div className="prep-desk-expand"><ProbeAnswerCard probe={probeWire} /></div>
    ```
    （`ProbeAnswerCard` 只用到 `probe.probe_question_id` / `probe.prompt_md`；`knowledge_id` 传 `finding.knowledge_id` 满足类型，不影响渲染。）
- **[裁决 2 · probe_ready → outcome 原位联动]**：草稿「不碰 `ProbeAnswers`」的自设约束**作废**（它不是 ticket 边界）。`ProbeAnswerCard` 的 `onSubmit` 在记下 verdict 后**追加一行** `qc.invalidateQueries({ queryKey: ['teaching-brief'] })`：
  - 作答成功 → `['teaching-brief']` 失效 → brief refetch → 投影转 `outcome_confirmed`/`outcome_retired` → brief 原位演进到 outcome 态（§6 前进宣告 + 焦点移到「当前结果」`<h3>`）。
  - **不在 submit 上 `invalidate(['prep-desk-probes'])`**——那条留在既有 `onDismiss`（「知道了」按钮）上，**保持不变**。
  - 该 `['teaching-brief']` 失效落在**共享的** `ProbeAnswerCard.onSubmit` 里，故 queue 面与 brief 面**任一入口作答都会刷新 brief**（brief 未挂载时 invalidate 为 no-op，无害）。`onAnswered?.(res.resolution)` 在 `setVerdict` 后调用，作为 extract 契约对称点（本 slice brief 的 outcome 转态由上面的 `['teaching-brief']` 失效 + §6 state-advance effect 驱动，不强依赖 `onAnswered`；prop 留作复用/未来用）。
- **理由（justify）**：作答本身（文本+拍照+judge 结算）是 `ProbeAnswerCard` 已 live 的完整实现（`uploadAsset`、`allSettled` 批量上传容错、422 fail-closed 重试）。brief 内重建 = 重复该复杂流，违反「no full-page rewrite」+ reuse。P0F/4 才做 brief 内原位作答；本 slice（P0F/3）link 到既有作答卡即可。

### 5.3 outcome_confirmed / outcome_retired — 纯显示，无 CTA

- 契约 §2.1 + §4.2：outcome 的 `prepared_action = {kind:'none'}`；P0F **无持久 ack SoT，不写 ack**。
- **UI**：`current_outcome.summary_md` 作对账结论（server 供，见 §7.2）+ 状态图标（非仅颜色）。**无任何按钮**（验收「outcome display only, no CTA per contract §4.2」）。
- **不做**：不加「知道了」ack 按钮（区别于 `ProbeAnswerCard` verdict 的「知道了」，那是 dismiss probe query 非 ack；brief outcome 由 7 天 TTL 收口，契约 §4.2）。不接 YUK-709 练习入口（契约 §9，本 slice out of scope）。

---

## 6. a11y 规格（逐条对齐契约 §8.3）

| 契约 §8.3 要求 | 实现 |
|---|---|
| **四块用可导航 heading/region 语义** | 卡头真 `<h2 id="tb-title">为你而备`；四块各 `<section aria-labelledby="tb-h-*">` + 真 `<h3 id="tb-h-*" tabIndex={-1}>`（发现/依据/已经为你备好/当前结果）。h2→h3×4 heading 导航 + labelled region 双满足（[裁决 7]） |
| **状态不能只靠颜色** | confirmed/retired/awaiting 三态都配 `LoomIcon`（check/checkCircle/sparkle）+ 文本标签；`.tb-outcome` 图标始终带文本等价 |
| **primary action 有明确 accessible name；accept 文案表达「继续验证」不被读成「确认弱点」** | accept 按钮可见文本即 accessible name「就按这个方向验证」（含「验证」，非「确认/弱点/加进复习」）；测试断言（§9.4） |
| **原位 finding→probe_ready→outcome 更新后，焦点移到新状态 heading + `aria-live='polite'` 宣告一次；不整页抢焦点、不重复朗读 evidence** | 见下方《前进宣告算法》（[裁决 4]）。`aria-live="polite"` 视觉隐藏区（`.tb-live`）只在**前进**时被赋值一次；evidence 不进 live 区 |
| **loading 用带可访问标签的 skeleton** | `Stateful` skeleton `SkLines` 外包 `aria-busy="true"` + `aria-label="正在载入教研简报"` |
| **error 与 retry 关联；键盘可完成 accept/驳回、探针作答、结果 ack** | `ErrorState`（`role="alert"` + 重试）；accept/dismiss/probe-reveal 均 `<button>`/`Btn`（原生键盘可达）；作答键盘路径由既有 `ProbeAnswerCard`（label+file input 保 tab order）承接；outcome 本 slice 无 ack（契约 §4.2） |
| **evidence ref 不可展开时渲文本而非死链** | `evidenceReadable()` 全 kind 渲纯文本 `<span>`（[裁决 8] 连 route≠null 的 kind 也不渲 `<a>`），无死链 |
| **anti-guilt salience 不经 ARIA label 旁路泄漏**（§8.1） | 无 aria-label / data-attr / title 携带 confidence/salience/count/raw id；evidence 不汇总成「N 条」、不带 `×N`（[裁决 8]） |

**前进宣告算法（[裁决 4 · 唯前进、同 brief_id、非 mount/swap]）**：

- **触发条件**：仅当 **同一 `brief_id` 沿 `finding → probe_ready → outcome` 前进**时，才 announce + 移焦。**绝不**在初次 mount / 首次 query 成功时触发；**绝不**在 `brief_id` 切换（换下一候选）时触发。`brief_id` 全生命周期稳定（server 每态都置 `brief_id = proposal.id`），故「同 id、态前进」客户端可判。
- **实现**：用 `ref` 追踪 `{ brief_id, rank }`；`rank` 映射 `finding=0 / probe_ready=1 / outcome_confirmed=2 / outcome_retired=2`。
  ```ts
  const prevRef = useRef<{ brief_id: string; rank: number } | null>(null);
  const preparedHeadingRef = useRef<HTMLHeadingElement>(null); // 「已经为你备好」
  const outcomeHeadingRef  = useRef<HTMLHeadingElement>(null); // 「当前结果」
  const [liveMsg, setLiveMsg] = useState('');

  useEffect(() => {
    if (!brief) { prevRef.current = null; return; }        // null → 复位，不宣告
    const rank = STATE_RANK[brief.state];
    const prev = prevRef.current;
    const forward = prev != null && prev.brief_id === brief.brief_id && rank > prev.rank;
    prevRef.current = { brief_id: brief.brief_id, rank };   // 每次都更新基线
    if (!forward) return;                                   // mount / swap / 无变化 → 不触发
    setLiveMsg(brief.current_outcome.summary_md);           // aria-live 宣告一次
    (brief.state === 'probe_ready' ? preparedHeadingRef : outcomeHeadingRef).current?.focus();
  }, [brief]);
  ```
- **焦点落点**：
  - **accept → `probe_ready`**：焦点移到 **「已经为你备好」`<h3>`**——新态的可操作核心（`prompt_md` 预览 + 「现在就试做这道题」CTA 就在其下），键盘用户直达下一步。
  - **作答 → `outcome_*`**：焦点移到 **「当前结果」`<h3>`**——outcome 无后续 CTA（`kind:'none'`），落在结论 heading 即对。
  - **dismiss（finding 被驳回）**：**焦点不动**——band 自然 re-render 出下一候选或 null，属 `brief_id` swap，不宣告不移焦。
- **announce 内容**：始终为 `current_outcome.summary_md`（server 供），只在前进时赋值一次；evidence 永不进 live 区。

---

## 7. 文案表（学习者可见 Chinese strings，守契约 §2.2）

**区分 UI-authored（本组件硬编码）vs server-provided（wire 供，逐字渲染，UI 不改写、测试不硬编码字面）**：

### 7.1 UI-authored（组件内固定）

| 位置 | 文案 | 依据 |
|---|---|---|
| 卡头 `<h2>` | `为你而备` | vision §2 / 卡设计 |
| 发现 `<h3>` | `教研团在检验什么` | 契约 §0 finding 语义 |
| 依据 `<h3>` | `为什么这么判断` | 契约 §0 basis 语义 |
| 已备行动 `<h3>` | `已经为你备好` | 契约 §0 prepared_action 语义 |
| 当前结果 `<h3>` | `当前结果` | 契约 §0 current_outcome 语义 |
| probe 预览框标签 | `团队正要问你的一道题` | 卡设计 §4 tripwire framing |
| finding accept CTA | `就按这个方向验证` | 验收指定；契约 §8.3「继续验证」不「确认弱点」 |
| finding dismiss CTA | `不太像` | 验收指定；软驳回语（与 `PrepDeskConjectures` 同语气） |
| probe_ready CTA | `现在就试做这道题` | §5.2；「试做」非「测验/考你」（pull 语气） |
| quiet 空态 | `教研团暂无需要交付的新判断。` | 契约 §6.5 逐字 |
| route error | `教研简报暂不可用。` | 契约 §7 |
| 操作失败 inline | `操作失败，请重试` | 契约 §7「清晰、非责备的 inline error」 |
| skeleton aria-label | `正在载入教研简报` | 契约 §8.3 |
| 二级折叠盘 summary | `昨夜 AI 还替你做了这些` | §2.4；活动 chips 计数保留 |

### 7.2 server-provided（逐字渲染，UI 不改写；测试结构断言，**不硬编码字面**）[裁决 9a]

> outcome / awaiting summary 由 server（`loadOutcomeBrief` / `loadProbeBrief` / `loadFindingBrief`）owns。UI 逐字渲染；**单测断言其「出现在当前结果 region + 配状态图标」的结构，绝不 `toContain` 硬编码 server 字面**（server 改文案不该震碎 UI 测试）。下列为当前 server 实际值，仅供对照：

| 字段 / 来源 | 当前 server 实际值 | 约束 |
|---|---|---|
| `finding.claim_md` | （每卡不同）如「你可能在复合层级增加时漏掉内层变化率。」 | 契约 §2.2 可证伪假设，非「你的弱点就是」 |
| `basis.summary_md`（= proposal `reason_md`） | （每卡不同）如「这个模式在最近几次相关作答中重复出现，值得用一道判别题确认。」 | 契约 §2.2 短事实文案；不输出概率/后台/prompt |
| `finding` `current_outcome.summary_md`（`loadFindingBrief`） | `这仍是一条待检验的判断。` | 契约 §2.2「接受/改写只是认同研究方向，不是确认弱项」 |
| `probe_ready` `current_outcome.summary_md`（`loadProbeBrief`） | `判别题已备好；完成后再更新这条判断。` | — |
| `outcome_confirmed` `current_outcome.summary_md`（`loadOutcomeBrief`） | `这条判断得到这次探针的支持；下一步可以针对这个点练习。` | 契约 §2.2 不升级为人格定论 |
| `outcome_retired` `current_outcome.summary_md`（`loadOutcomeBrief`） | `这条判断被这次探针排除；原计划可以继续。` | 契约 §2.2 不用「你证明了自己」（**注**：server 实际返回此句，与契约 §6.4 example「继续原来的安排即可」措辞不同——以 server 为准） |
| `prepared_action.probe_preview_md` / `prompt_md`（= proposal `probe_md`） | （每卡不同）如「求 d/dx sin(x²)，并标出每一层变化率。」 | tripwire framing，纯文本 |
| `basis.evidence_trace[]` | → `evidenceReadable()` → 「源自一道题目」/「源自一次 AI 判定事件」等 | 契约 §8.1 不汇总「N 条证据」、不显 raw id（[裁决 8]） |

### 7.3 禁用文案（负向断言，验收 + 契约 §8.1）[裁决 9c 扩充]

**全卡永不出现**：任何 `%` / `confidence` / `置信` / `把握` / `predicted` / `predicted_p` / `baseline_p`（契约 §8.1）；`recurrence_count` / `反复出现 N 次`（brief **不显** recurrence，区别于 `PrepDeskConjectures`——契约 §8.1 明列禁显）；backlog/未读/待办/`N 条等待`/`待裁决`；红点/`逾期`/`action required`/`你又错了`；**agent note / agent 观察正文、task run / 任务运行、内部 error、prompt / 提示词、投票、争论**（[裁决 9c] 新增，契约 §8.1「agent note、task run、内部 error、prompt、投票/争论或成本数据」）；成本/`成本`；`全部完成`/`全部搞定`/连续天数/streak/成就（契约 §6.5）；内部 id（`brief_id`/`knowledge_id`/`proposal_id`/`probe_question_id`/`probe_result_event_id`/evidence raw id 均不渲染，契约 §8.2）。

---

## 8. 将 touch 的文件（创建/修改 + 职责）

### 创建

| 文件 | 职责 |
|---|---|
| `src/capabilities/shell/ui/teaching-brief-api.ts` | client wire type 镜像（`TeachingBrief` 判别联合 + `TeachingBriefResponse`，逐字镜像 server `teaching-brief.ts` 的 export type，沿用 `prep-desk-api.ts` / `probe-answer-api.ts` 手动镜像 idiom，保 client bundle 不 import server 模块 + 注释 anti-guilt 字段缺席）+ `getTeachingBrief = () => apiJson<TeachingBriefResponse>('/api/prep-desk/brief')` |
| `src/capabilities/shell/ui/TeachingBrief.tsx` | `TeachingBriefBand` 组件：query `['teaching-brief']` → `Stateful`（loading/error/ok）→ null 空态 / 四态卡（真 h2+h3×4 region + 分支 CTA + §6 前进宣告/焦点）。decide 复用 `decideProposal`（`inbox-api.ts`）；probe_ready reveal 单枚 `ProbeAnswerCard`（构造单探针 wire）。**不含** `DegradedKindsFlags`（后者在 `TodayPage.tsx`） |
| `src/capabilities/shell/ui/TeachingBrief.unit.test.tsx` | SSR + 断言（§9.1/9.2/9.4-结构）。交互态（accept/dismiss 调 route、focus/aria-live 转移、probe reveal）拆 `TeachingBrief.interaction.unit.test.tsx`（对照既有 `PrepDeskConjectures.interaction.unit.test.tsx` / `ProbeAnswers.interaction.unit.test.tsx`） |
| `web/src/globals.css` 增 `.tb-*` 段 | §4.2 薄样式，紧邻 `.prep-desk-*` 段，全引 `var(--*)` |

### 修改

| 文件 | 改动 |
|---|---|
| `src/capabilities/shell/ui/TodayPage.tsx` | ① 新增私有组件 `DegradedKindsFlags`（自持 `['overnight-digest']` query，渲原 degraded 行 JSX，空则 `null`），挂 workbench 位置 1；② 位置 2 挂 `<TeachingBriefBand navigate={navigate}/>`；③ `OvernightDigestBand` 内：**移除** degraded 行 JSX（已迁 `DegradedKindsFlags`），活动 chips 行 + `待你试做` probe-queue 收进新 default-collapsed「昨夜 AI 还替你做了这些」二级折叠盘（[裁决 5]，`备课猜想`/`待你试做` 二级 toggle 保留可达）。**不碰** 后端读模型 / route / decide 管道 / KpiRow 以下 workbench |
| `src/capabilities/shell/ui/ProbeAnswers.tsx` | ① `export` `ProbeAnswerCard`，签名加 optional `onAnswered?:(resolution)=>void`（[裁决 3]）；② `onSubmit` 记 verdict 后追加 `qc.invalidateQueries({queryKey:['teaching-brief']})` + `onAnswered?.(res.resolution)`（[裁决 2]）；`onDismiss` 的 `['prep-desk-probes']` 失效**保持不变**。`ProbeAnswers` 列表面渲染逻辑不变（仍 `.map` 出多枚 `ProbeAnswerCard`） |
| `tests/usability/api-fixtures.ts` | 补一行 `if (key === 'GET /api/prep-desk/brief') return fulfill(route, { brief: null });`（紧邻 `GET /api/prep-desk/probes` fixture）。`{brief:null}` 覆盖 `existing-evidence` 与 mobile 场景（mobile spec 复用 `existing-evidence` fixture，故单条无条件 fixture 即覆盖两者）（[裁决 6]） |

**不碰**：`PrepDeskConjectures.tsx` 组件本体；`inbox-api.ts` / `overnight-digest` server / brief read model（yuk-706 owns）；`contracts.ts`（schema 已在 yuk-706 定稿）。

> **[裁决 6] follow-up（optional，本 slice 不强做）**：另加一个「非 null brief」usability 场景（返回一份 finding/outcome brief，验证 brief 首屏渲染 + a11y 焦点顺序）是 desirable 的，但不阻塞本 slice；可留作 P0F/3 收尾或独立 Linear 票。

---

## 9. 测试计划（`TeachingBrief.unit.test.tsx` + `TeachingBrief.interaction.unit.test.tsx`）

**Harness**：`renderToString` + `QueryClientProvider`，`qc.setQueryData(['teaching-brief'], {brief})` 预填（镜像 `PrepDeskConjectures.unit.test.tsx`）。fixture builder `brief(state, overrides)` 造四态。交互断言（route 调用、focus、reveal）用 `@testing-library/react` + `userEvent` + `vi.mock('./inbox-api')` / `vi.mock('./ProbeAnswers')`，落 `.interaction.unit.test.tsx`。

### 9.1 态渲染（正向）

1. `finding` → 含 `claim_md`、依据 `summary_md`、`probe_preview_md`、四 `<h3>` heading（教研团在检验什么/为什么这么判断/已经为你备好/当前结果）、双 CTA 文案「就按这个方向验证」「不太像」。
2. `probe_ready` → 含 `prompt_md`、CTA「现在就试做这道题」；断言 brief 卡内**无** textarea/上传（作答不在 brief 内，reveal 前）。
3. `outcome_confirmed` → **结构断言**：出「当前结果」region + confirmed 状态图标 + 该 region 内渲出 `current_outcome.summary_md`（用 fixture 传入值断言，**非硬编码 server 字面**，[裁决 9a]）；断言**无任何 button/CTA**。
4. `outcome_retired` → 同上（retired 图标）；断言无 CTA。
5. `brief:null` → 「教研团暂无需要交付的新判断。」；断言无「全部完成」「全部搞定」「连续」「caught up」。
6. loading（`status="loading"`）→ skeleton 存在 + `aria-label="正在载入教研简报"` + `aria-busy`。
7. error（`status="error"`）→ 「教研简报暂不可用。」+ 重试可见。

### 9.2 anti-guilt 深断言（契约 §8.1 / §11，逐态跑）[裁决 8 + 9c]

- `not.toContain`（对渲染后 HTML 全文，含属性）：`%`、`confidence`、`置信`、`把握`、`预测`、`predicted`、`baseline`、`recurrence`、`反复出现`、`等待`、`待裁决`、`未读`、`backlog`、`逾期`、`action required`、`你又错了`、`全部完成`、`连续`、`成本`，**并新增**（[裁决 9c]）：`agent note`、`任务运行`、`task run`、`prompt`、`提示词`、`投票`、`争论`。
- **无内部 id（含属性）**：`not.toContain` fixture 里的 `brief_id`/`knowledge_id`/`proposal_id`/`probe_question_id`/`probe_result_event_id`/evidence raw id（如 `evt_attempt_a`、`q_probe_01`）——断言它们**在整段 HTML（含 `href`/`title`/`data-*`/`aria-*` 属性）里都不出现**（[裁决 8]：raw id 不进 DOM 任何角落；React key 用下标不用 id）。
- **evidence 不汇总、不带乘数**（[裁决 8]）：`not.toContain` `条证据` / `× ` / `x2` / 任何计数 token；构造含**两条同 kind 不同 id 的 induction** 的 fixture，断言渲**两枚**中性 chip（`getAllByText('源自一次 AI 判定事件').length === 2`），无 `×2`；断言 evidence chip 是 `<span>` 非 `<a>`（`container.querySelector('a')` 在 basis region 内为 null，即便含 knowledge/artifact ref）。

### 9.3 CTA 连线（interaction）

- finding accept 点击 → `decideProposal` 被以 `(proposal_id, 'accept')` 调用；dismiss → `(proposal_id,'dismiss')`。
- accept 成功 → `invalidateQueries(['teaching-brief'])`（+ `['overnight-digest']` + `['prep-desk-probes']`）触发（spy qc）。
- accept 失败（mock reject）→ 卡保留 + `role="alert"` inline error「操作失败，请重试」，不乐观移除（契约 §7）。
- probe_ready CTA 点击 → reveal region 出现（`aria-expanded` 翻 true），渲出**一枚** `ProbeAnswerCard`（mock 或真组件）；brief 卡本身仍无作答框；断言 reveal 只含单探针（`getAllByRole('button', {name:/提交作答/}).length === 1`）。
- （在 `ProbeAnswers.*.unit.test.tsx` 补）`ProbeAnswerCard.onSubmit` 成功 → `invalidateQueries(['teaching-brief'])` 触发、`onAnswered` 被以 resolution 调用；`onDismiss` 仍只 `invalidateQueries(['prep-desk-probes'])`（[裁决 2]）。

### 9.4 a11y（契约 §8.3）[裁决 4 + 7]

- 四块可导航：`getByRole('heading', {level:2, name:'为你而备'})` + 四个 `getByRole('heading', {level:3, name})`；`getByRole('region', {name})` 四个（`aria-labelledby` 生效）。
- accept 按钮 accessible name 含「验证」，`not` 含「确认弱点」「加进复习」。
- **前进宣告（[裁决 4]）**：
  - `finding→probe_ready`（同 `brief_id`，rerender 换 fixture / 或 mock accept 触发 refetch）→ `.tb-live` 文本更新为新 `current_outcome.summary_md`（fixture 值断言）；焦点落 **「已经为你备好」`<h3>`**（`document.activeElement`）。
  - `probe_ready→outcome`（同 `brief_id`）→ `.tb-live` 更新；焦点落 **「当前结果」`<h3>`**。
  - **初次 mount / 首次成功**：`.tb-live` 为空、焦点不被抢（断言 `document.activeElement` 非 heading）。
  - **`brief_id` swap**（换不同 `brief_id` 的下一候选）与 **→null**：不宣告、不移焦。
- outcome 图标带文本等价（状态不仅靠颜色）。

### 9.5 窄屏 / 溢出（补充，非 SSR 强测）

- 断言 chip/meta/actions 容器 className 含 wrap 类（`.tb-actions`→`.pd-actions`、evidence 行 wrap）；真溢出为视觉 QA（manual），单测只锁「无固定 px 宽块」结构。
- usability fixture（[裁决 6]）：`existing-evidence` + mobile 场景下 `GET /api/prep-desk/brief` 返 `{brief:null}` → 首屏无 brief 卡、`unexpectedRequests` 保持空（brief 请求已被 fixture 覆盖）。

---

## 10. 待 owner 判词的决策（其余）

> **已由三镜对抗 review 终裁、本稿落实、不再是 open decision**：
> - ~~D1 备课猜想 chip + 待你试做 queue 去留~~ → **[裁决 5]**：both demote 进二级折叠盘、保留可达（demote-not-delete），非删除。
> - ~~D3 region heading 用真 h3 vs eyebrow+aria-label~~ → **[裁决 7]**：用真 h2+h3，视觉压到 eyebrow 密度。

- **D2 · brief CSS 落点**：`web/src/globals.css`（紧邻 prep-desk 段，本稿推荐）vs `shell.css`（TodayPage 局部）。推荐 globals（同 felt 家族）。
- **D4 · 视觉保真**：本稿只定 contract-grounded 骨架 + token 复用；卡的最终视觉密度/motif 是否过 claude.ai/design 出正稿（同卡设计 §8 悬而未决项），留 owner 定。

---

## 附：契约红线速查（实现期贴身核对）

1. 只读、零写（契约 §10、§11「reader 零 INSERT/UPDATE/DELETE」）——UI 亦不制造写路径，除 accept/dismiss 复用既有 `decideProposal` route + probe 复用既有 `submitProbeAnswer` route。
2. 唯一 primary 由 server `loadTeachingBrief` 定（契约 §5），UI **不做客户端选择/排序**，直渲 `brief`。
3. 四态 = 完整可交付 domain chain；`insufficient_evidence`/`degraded`/`error` 不是态（契约 §6.5）——UI 三诚实呈现。
4. anti-guilt wire lock（§8.1）+ 无内部 id（§8.2）——测试深断言锁死（§9.2），含属性面、无 `×N`、无 raw id（[裁决 8]）。
5. degraded_kinds 上提位置 1 独立元素、永在 brief 之前直显（§2.3 · [裁决 1]）；夜间面降级为二级折叠盘、both surfaces 可达不删（§2.4 · [裁决 5]）。
6. probe_ready 本 slice reveal 单枚既有 `ProbeAnswerCard`（[裁决 3]）+ submit 联动 `['teaching-brief']` 失效使原位转 outcome（[裁决 2]）；不做 brief 内原位作答（P0F/4 才做）。
7. 原位状态演进只在**同 `brief_id` 前进**时 announce+移焦（[裁决 4]），非 mount/swap。
