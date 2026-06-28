# 收件箱 · 出手强度三车道（A/B/C）— 功能 handoff（给 claude design）

- **date**: 2026-06-28
- **status**: functional handoff（零风格规定）—— 视觉稿由 claude design 出，回来 slice-by-slice 实现
- **form-axis epic**: YUK-354 缺口 A4（出手强度轴）
- **权威决策锚**: `docs/design/2026-06-14-product-rethink-decisions-ledger.md` §A4（行 108-111）
- **数据前置**: YUK-521（已落 Linear——强度映射表 + 单人裁决熔断，见末尾）

> ⚠️ **这是既有屏的「增量」，不是重画整屏。** 收件箱（`src/capabilities/shell/ui/InboxPage.tsx`）已上线、有完整 loom 视觉语言（`LoomCard` / `SectionLabel` / `EmptyState` / `Stateful` / `Btn` / `kind-tag` 色系）。claude design 要画的是**一个新维度——「出手强度」分流——的视觉形态**，并让它与既有 loom 语言协调；**不是**从空白重做这块屏。既有的卡片解剖（白话理由 + 证据 chip + 裁决按钮 + 置信条）原样保留，只是被重新归组、并新增 A 档与 C 档两类此前不存在的呈现。
>
> 本 handoff 只描述收件箱该让 owner**理解什么、能做什么** + 硬功能约束 + 各态契约。**不规定任何视觉风格 / 布局 / 配色 / 组件选型 / 间距 / 动效**——那是 claude design 的活。

---

## owner 想解决的问题

收件箱是 AI 单编排者把「软提议」交还给 owner 裁决的面。现状失败模式：**所有 AI 提议被压成一条无差别的「逐条人审」流**——不管这条是「AI 已替你做了、瞄一眼能撤销」的低后果动作，还是「需要你停下斟酌方向」的高后果裁决，还是「根本不该占你决策注意力」的纯状态记录，全长成同一种卡、排同一条队列、要同样的点击成本。

owner 要的是**按出手强度分流**：让 AI 替自己扛掉本不该扛的决策劳动，把注意力只留给真正需要「判」的少数。这是「代理信任」北极星锚的落地面——信任到敢让 AI 乐观出手（A 档），同时对真正承重的决策保持人审（B 档），而纯状态噪音（C 档）压根不进决策车道。

---

## 权威语义：A/B/C = 出手强度（可逆性 × 后果）

> 逐字引用 ledger §A4（行 109-110）：
> - 「**全局出手强度表 A/B/C**(可逆性 × 后果):A 自动 + 撤销窗口(乐观应用,不打断不强制确认)/ B 逐条人审 / C 纯状态不进队列。」
> - 「A 档 kind 用**静态可逆性**兜底(不靠 confidence,数据基础不足);defer/archive/judge_retraction 移出裁决面(snooze / agent-notes 旁观)。」
> - 「指标落两档健康信号(A 档 revert 率 / B 档 dismiss 率),不追抽象 appropriate-rate。」

三档的**体验语义**（功能层，非视觉）：

| 档 | 出手强度 | owner 动作模型 | 「读 vs 判」 |
|---|---|---|---|
| **A** | AI 已乐观应用 + 撤销窗口 | **读过** —— 它已经做了，瞄一眼，错了能撤销；不打断、不强制确认 | 主要是「读」（事后审查 + 撤销可供性），不是「判」 |
| **B** | 逐条人审 | **判** —— 必须 owner accept / dismiss（可逆性不足以让 AI 自动出手） | 真正的「判」车道——**唯一**该占决策注意力的地方 |
| **C** | 纯状态不进队列 | **不裁决** —— defer / archive / judge_retraction 移出裁决面、降旁观（snooze / agent-notes） | 既不读也不判——彻底移出主裁决流 |

---

## 🔴 三轴正交红线（本 handoff 的头号约束，须 surface 给 claude design 与 owner）

收件箱里有**三根互不相同的轴**，历史上它们被混着用过；A4 这次新增的「出手强度轴」绝不能与另两根轴耦合或互相反推。逐轴有代码证据：

| 轴 | 是什么 | 代码锚（已 Read 核对） | 取值 |
|---|---|---|---|
| **① 出手强度轴**（A4 / 本 handoff 新增） | AI 自动出手 vs 人审 vs 不入队 | **代码中尚不存在**——`ProposalInboxRow`（`inbox-api.ts:91-105`）无 `tier` 字段；待 YUK-521 带下来 | A / B / C |
| **② accept-applier 轴**（YUK-44） | 后端 `dispatchAccept` **能否** apply 该 kind | `inbox-api.ts:53-57` `isAcceptSupported` + `inbox-api.ts:47-49` 注释「归 YUK-44」；门控点 `ProposalCard.tsx:182` | 二元（能 accept / 不能 accept） |
| **③ KIND_META.tone 视觉轴** | 卡片色系（纯视觉语义） | `inbox-api.ts:15` tone 类型 + `inbox-api.ts:18-41` 每 kind tone | info / coral / good / hard / neutral |

**陷阱（必须显式告知）**：`defer` / `archive` / `judge_retraction` 这三个 kind **恰好同时**是「② 不能 accept」+「① C 档」——但这是这三个 kind 的**巧合，不是定义同一**。

- 别用 `isAcceptSupported`（②）反推强度档（①）：很多「能 accept」的 kind 仍应是 B 档（人审），不是 A 档；A 档（自动出手）该收哪些 kind 是**独立裁定**（YUK-521 + owner 留白），与「后端能不能 apply」无关。
- 别用 `tone`（③，如 `hard` / `neutral`）反推强度档（①）：tone 只是色系，`defer` 与 `block_merge` 同为 `hard` tone 却分属 C 与 B。
- claude design 出稿时，三档分流是**全新的一根组织轴**，不可由现有 tone 色或 accept-CTA 有无推导。

---

## 现状反模式（锚真代码，已 Read 后引用）

1. **零出手强度分流——按 kind-type 平铺**：`InboxPage.tsx:175` `visibleKinds.map((k) => …)` 把提议按 **kind 类型**分 lane（每个 kind 一节，`SectionLabel` + 卡网格），筛选器也是「类型」（`InboxPage.tsx:126` eyebrow「INBOX · AI 提议 · 按类型筛选」、`InboxPage.tsx:149` `FilterRow label="类型"`）。组织轴是「这是什么 kind」，不是「这要不要我出手 / 出多重的手」——A4 的 A/B/C 维度在 UI 里完全不存在。

2. **C 档 kind 没被移出裁决流，只是 Accept 按钮藏了**：`ProposalCard.tsx:182` `isAcceptSupported(p.kind) && <Btn …>` 对 defer / archive / judge_retraction **仍渲染在同一条裁决流里**，只隐掉 Accept CTA、留「忽略」（`ProposalCard.tsx:215-223`）。ledger §A4 行 110 要求这三个 kind **移出裁决面**（旁观）——现状它们还坐在 B 档队列中间，半残地占着决策注意力。证据锚：`inbox-api.ts:47-49`（注释明说这三个 kind 归 YUK-44、不渲 Accept CTA、只留忽略）。

3. **不存在「乐观应用 + 撤销窗口」（A 档核心）**：`ProposalCard.tsx:95-117` `decide()` 是**显式 accept、阻塞式**（`busy` 态 + `setBusy`），裁决前提议一直 pending、什么都没发生。没有任何「AI 已自动应用、给你一个撤销窗口」的路径——A 档的「不打断、乐观出手、可 revert」体验在代码里零基础。

4. **裁决留痕活在内存、刷新即失**：`InboxPage.tsx:60` `const [resolved, setResolved] = useState…({})` 是本地 React state；文件头注释 `InboxPage.tsx:8` 明说「裁决后卡片淡化留痕，**刷新后消失**」。A 档 revert 率 / B 档 dismiss 率两档健康信号（ledger §A4 行 111）在前端没有可持久观测的留痕面。

5. **无批量**：每卡单独裁决（`ProposalCard` per-card `decide`）。A 档「一批同型低后果一眼扫过」、C 档「批量全部旁观」不存在。

6. **置信被当一等可视、但 ledger 明令 A 档不靠它**：`ProposalCard.tsx:124-234` 渲染置信条（`confidence` 存在才渲）。⚠️ 这与「① 强度轴」也正交：ledger §A4 行 109 明令 **A 档用静态可逆性兜底、不靠 confidence**。置信是卡内显示信号，**不决定**强度档——别让视觉上把高置信暗示成「可自动出手」。

---

## 数据契约（wire 形状 + 关键缺口）

**端点**：`GET /api/proposals?status=pending` → `{ rows: ProposalInboxRow[]; next_cursor: string | null }`（`inbox-api.ts:107-110`）。
**裁决**：`POST /api/proposals/:id/decide` body `{ decision: 'accept'|'reverse'|'change_type'|'dismiss', new_relation_type?, user_note? }`（`inbox-api.ts:112-126`）。
**行形状**：`ProposalInboxRow`（`inbox-api.ts:91-105`）—— `kind` / `payload.reason_md`(白话理由) / `payload.evidence_refs[]` / `payload.confidence?`(可缺) / `actor_ref`(产出轨道) / `cost_micro_usd`。`KIND_META`（`inbox-api.ts:18-41`）当前有 **19 个 kind**（全量真身在 `src/core/schema/proposal.ts` 的 `aiProposalKinds`）。

> **关键缺口（先告知，再出稿）**：wire **没有** `tier`（A/B/C）字段——分档目前只能由前端按 kind 推。完整 `kind → A/B/C` 映射是数据前置（YUK-521）。在它落地前，claude design 可按「**B 档 = 绝大多数现有 kind / C 档 = defer·archive·judge_retraction 三个 / A 档 = 待映射、初期可能为空**」三分出稿；映射表落地后 `tier` 从后端带下来。

---

## 收件箱应呈现什么（功能层，非视觉）

1. **三档分流是主组织轴**：把「出手强度」（A 读过 / B 判 / C 旁观）抬成收件箱一级结构，取代现状「按 kind 类型」平铺。owner 第一眼应能分清「哪些 AI 已替我做了（扫一眼）/ 哪些真需我裁决 / 哪些只是状态噪音」。

2. **B 档 = 唯一主裁决车道**：逐条人审的提议（知识关系、诊断推测、题目草稿、目标范围……）是收件箱主体与注意力焦点。每条带白话理由（`reason_md`）+ 可读证据（`evidence_refs` 白话化，`inbox-api.ts:154-172`）+ accept / dismiss（+ 关系类提议的改方向 / 改关系，`ProposalCard.tsx:193-214`）。

3. **A 档 = 事后审查 + 撤销可供性（非裁决）**：AI 已乐观应用的低后果动作，呈现为「已做 + 可撤销」而非「待你确认」。**降权于 B 档**——不抢注意力、不要求点击，owner 可按需看到完整内容（默认不占主视线，呈现机制留 claude design）。**撤销窗口**是核心可供性（对应 A 档 revert 率信号）。

4. **C 档 = 移出主裁决流的旁观面**：defer / archive / judge_retraction 不进决策队列，降为「AI 旁注 / 已自动处理」旁观条目。owner 可选择性查看，但它绝不占主裁决视线。**这是相对现状最大的行为变更**（现状它们还混在 B 档里）。

5. **裁决留痕（两档健康信号落点）**：A 档 revert 率 / B 档 dismiss 率应有可观测留痕呈现（ledger §A4 行 111）。现状留痕仅内存、刷新即失——视觉稿应预留「裁决历史 / 健康信号」承载位（数据持久化是 follow-up，UI 形态现在定）。

6. **批量可供性（提案 · 待 owner 确认）**：ledger §A4 与 owner lock 未含批量——本条为 handoff 提议，非锁定项。A 档「一批同型一眼扫过 / 全部确认无误」、C 档「全部收进旁观」**可考虑**支持批量，B 档保持逐条（真裁决不批量）。owner 未确认前 claude design 不当锁定项设计。

---

## 空态 / 失败态 / 低置信态（显式功能约束——claude design 须为每态出稿）

**空态（多态）**
- **全空**：无任何 pending 提议。现状已有 `clearedEmpty`（`InboxPage.tsx:110-121`，「收件箱已清空 / 新提议会在下次 Dreaming session 后出现」+ 去看知识图 CTA）——三档版保留这个解释性空态。
- **只剩 C 档（三档新引入，须显式设计）**：B 档（真裁决）已清空，但还有 C 档旁观条目。应呈现为**「决策已清零」的正向空态**（主车道空了），而非「还有 N 条待处理」——否则 C 档噪音会让 owner 误以为还有活要干。
- **A 档为空（三档新引入，绑 owner 决策 §1）**：若初期 A-list 取空，收件箱**退化成 B/C 两车道**——A 区不该显示成「坏了 / 加载中」，而应是一个不打扰、不显眼的空区（hide / collapse / 不渲该车道——三选由设计定）。claude design 须为「A 档存在 vs A 档为空」两形态各出稿。
- **筛选后空**：现状 `InboxPage.tsx:159-170` 已有「没有匹配的提议 / 清除筛选」——三档筛选后同样保留。

**失败态 / 失信兜底**
- **裁决目标已失效（stale）**：block_merge 在题块离开 draft 后 accept 软拒（`ProposalCard.tsx:103-110` + `inbox-api.ts:131-148` `isBlockMergeStale`，返 200 `{stale:true}`、不写事件、提议保持 pending）→ 须有「该提议已失效、已跳过」兜底态，**不能标成已裁决**。
- **重复裁决（已决）**：同提议二次裁决返 409（`ProposalCard.tsx:93` `locked` 锁 + 后端 already-decided）→ 须有「这条已处理过」兜底态。
- **列表不可用**：`InboxPage.tsx:152-158` `Stateful` 的 `error` 态（「提议列表暂不可用」+ 重试）——保留。
- **单条裁决失败**：`ProposalCard.tsx:112-114` catch → 页级 toast（`InboxPage.tsx:209-216`）。三档版须明确：A 档**撤销失败**、C 档**旁观失败**各自的反馈口径。
- **不透明 raw-id 污染理由**：`reason_md` 可能含 `block-<cuid>` 等不透明 ID（`inbox-api.ts:202-230` `splitReasonIds` + `ProposalCard.tsx:149-164` 包进 `<code .ev-rawid>` 去权重）→「技术引用 chip」形态须在三档卡里保留。
- **证据不可达**：部分 `evidence_refs`（event/question/record）详情页未迁 SPA，`route=null` 渲纯文本不可点（`inbox-api.ts:154-172` + `ProposalCard.tsx:51-65` disabled chip）→ 可达 vs 不可达证据须二态可分。
- **熔断告知态（新，绑数据前置 YUK-521）**：单位时间裁决量超护栏时，收件箱须有「今天裁决得有点多 / 已暂缓」告知态——warning 水位只告知不打断、硬顶才软拦（分层语义）。阈值实参先埋点后定。

**低置信态**
- **置信缺失**：`payload.confidence` 可缺（`inbox-api.ts:81`）；`ProposalCard.tsx:124` 缺时 `null`、`L226` 不渲置信条 → 须有「无置信条」的合法形态，不是空洞。
- **置信偏低**：置信条渲低百分比（`ProposalCard.tsx:226-234`）。低置信是 B 档卡内显示信号 → 设计上可强化「这条 AI 自己也不确定、值得你看」。⚠️ 但**置信不决定强度档**（红线 §6 / ledger 行 109）——别让低置信视觉暗示「该降 C」或高置信暗示「该升 A」。

---

## 不在本 handoff 范围

- 不改提议产出 / accept applier 逻辑（`src/server/proposals/*`）——本面纯前端分流 + 体验。
- 不定 A/B/C 的**完整 kind 映射**（YUK-521，owner + 实现动作）——本稿按「B 为主 / C=三个旁观 kind / A 待映射、可能初期为空」三分出稿。
- 不实现裁决量护栏的**阈值实参**（YUK-521，先埋点后定数）——本稿只定「熔断告知态」体验形态。
- 不做 C 档旁观条目的持久化存储模型 + 裁决留痕持久化（follow-up）。
- **不规定任何视觉风格 / 布局 / 配色 / 组件选型 / 间距 / 动效**——claude design 的活。

---

## owner 留白（须 owner 拍的开放决策）

1. **A 档收哪些 kind（最敏感档）**：A 档=「乐观自动出手 + 撤销窗口」意味着 AI 先斩后奏，owner 须**逐 kind 按静态可逆性裁定**（YUK-521 scope）。建议默认保守起步：**A 档先空 / 只收最低后果可逆 kind，其余全 B**，日用后再上提。
   > **此为本 brief 的硬决策点**：若 A-list 初期为空，三档分流**退化成 B/C 两车道**——这不是 bug，是保守默认。claude design 须把「A 档存在」与「A 档为空退化」当**两个并存形态**出稿（见空态 §A 档为空）。owner 须明确接受退化形态、或先指定至少一个 A 档 kind。

2. **「读 vs 判」轴 ≠ A/B/C 强度轴的可能口径分歧**：A4 派单曾把三档描述成「A=一眼读过 / B=快速二选 / C=需斟酌裁决」的**决策成本梯度**，与 ledger §A4 的**出手强度**轴在 C 档冲突（ledger C=最轻、移出视线；派单 C=最重裁决）。**本稿以 ledger 为准。** 若 owner 真正想要的是「B 人审车道**内部**再按斟酌深浅分轻重」的二级梯度，那是叠加在 B 档之上、与 A/B/C **正交的第四根轴**——须 owner 明确要不要、以及与三档如何并存。

---

## 数据前置依赖（YUK-521，已落 Linear，**未实现**）

三档分流的前端 + 后端 `tier` 字段都阻塞在 YUK-521：

- **① 完整 `aiProposalKind → A/B/C` 出手强度映射表**：ledger §A4 行 109-110 给了**原则**（静态可逆性兜底、不靠 confidence）+ **3 个显式 C 档 kind**（defer/archive/judge_retraction），但全量 19 个 kind（`src/core/schema/proposal.ts` `aiProposalKinds` + `inbox-api.ts:18-41` `KIND_META`）的逐 kind 指派**从未写下**（grep 全仓无此映射表）。落地后 `tier` 字段经 server inbox 投影下 wire、`ProposalInboxRow` 加 `tier`。**在它落地前，claude design 按本稿三分临时分组出稿即可**——映射表是数据来源，不阻塞视觉形态设计。
- **② 单人裁决量熔断（分层 warning + 硬顶）**：grep 全仓 `src/capabilities/shell` / `src/server/proposals` 无任何 rate-limit / 熔断。提供上文「熔断告知态」的数据来源。阈值实参先埋点后定。

> 给 claude design 的实操口径：**视觉形态现在就能定**（三车道 + A/B/C 各态 + 空/失败/低置信态）；只有「分档的真值从哪来」依赖 YUK-521。实现回来后，前端按 kind 推的临时三分换成读 wire `tier` 字段——预留这个 seam。
