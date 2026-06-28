# 收件箱 · 读 vs 判（出手强度三档分流）— 功能 handoff（给 claude design）

- **date**: 2026-06-28
- **status**: functional handoff（零风格规定）—— 视觉稿由 claude design (claude.ai/design) 出，回来 slice-by-slice 实现
- **form-axis epic**: YUK-354 缺口 A4（`docs/design/2026-06-15-rethink-implementation-gate.md` §2 形态轴）
- **权威决策锚**: `docs/design/2026-06-14-product-rethink-decisions-ledger.md` §A4（行 109-112）

> 这是**功能** handoff：只描述收件箱该让 owner**理解什么、能做什么**，**不规定任何视觉风格/布局/配色/组件选型**——那是 claude design 的活。实现回来后按项目 design tokens / primitives（loom 系统）落地。

---

## owner 想解决的问题

收件箱是 AI 单编排者把「软提议」交还给 owner 裁决的面。现状的失败模式：**所有 AI 提议被压成一条无差别的「逐条人审」流**——不管这条是「AI 已经做了、你瞄一眼能撤销」的低后果动作，还是「需要你停下来斟酌方向」的高后果裁决，还是「根本不该占用你决策注意力」的纯状态记录，全都长成同一种卡、排在同一条队列里、要同样的点击成本。

owner 想要的是**按出手强度分流**：让 AI 替自己扛掉本不该扛的决策劳动，把注意力只留给真正需要「判」的少数。这正是「代理信任」北极星锚的落地面——信任到敢让 AI 乐观出手（A 档），同时对真正承重的决策保持人审（B 档），而纯状态噪音（C 档）压根不进决策车道。

---

## 权威语义：A/B/C 三档 = 出手强度（可逆性 × 后果）

> 逐字引用 ledger §A4（行 110-111）：
> - 「**全局出手强度表 A/B/C**(可逆性 × 后果):A 自动 + 撤销窗口(乐观应用,不打断不强制确认)/ B 逐条人审 / C 纯状态不进队列。」
> - 「A 档 kind 用**静态可逆性**兜底(不靠 confidence,数据基础不足);defer/archive/judge_retraction 移出裁决面(snooze / agent-notes 旁观)。」
> - 「指标落两档健康信号(A 档 revert 率 / B 档 dismiss 率),不追抽象 appropriate-rate。」

三档的**体验语义**（功能层，非视觉）：

| 档 | 出手强度 | owner 的动作模型 | 「读 vs 判」 |
|---|---|---|---|
| **A** | AI 已乐观应用 + 撤销窗口 | **读过** —— 它已经做了，瞄一眼，错了能撤销；不打断、不强制确认 | 主要是「读」（事后审查 + 撤销可供性），不是「判」 |
| **B** | 逐条人审 | **判** —— 必须由 owner accept / dismiss（可逆性不足以让 AI 自动出手） | 真正的「判」车道——唯一该占决策注意力的地方 |
| **C** | 纯状态不进队列 | **不裁决** —— defer / archive / judge_retraction 移出裁决面，降为旁观（snooze / agent-notes） | 既不读也不判——视觉上彻底移出主裁决流 |

> **⚠️ 给 claude design 与 owner 的口径校准（须 surface）**：本 epic 派单时把三档描述成「A=一眼读过 / B=快速二选 / C=需斟酌裁决」的**决策成本梯度**。这与 ledger §A4 的权威定义**不是同一根轴**——ledger 的轴是**出手强度（AI 自动 vs 人审 vs 不入队）**，不是「人审内部的斟酌深浅」。两者最大冲突在 C 档：ledger 的 C = **纯状态、压根不进队列**（最轻、移出视线），而派单框架的 C = **需斟酌的最重裁决**。本 handoff **以 ledger 为准**。claude design 据此出稿；若 owner 想要的其实是「人审车道内部再分轻重的梯度」，那是叠加在 B 档之上的二级体验，需 owner 明确（见末尾开放决策）。

---

## 现状反模式（锚真代码，先 Read 后引用）

1. **零出手强度分流——按 kind-type 平铺**：`src/capabilities/shell/ui/InboxPage.tsx:175` `visibleKinds.map((k) => …)` 把提议按 **kind 类型**分 lane（每个 kind 一节，`SectionLabel` + 卡片网格），筛选器也是「类型」（`InboxPage.tsx:126` eyebrow「INBOX · AI 提议 · 按类型筛选」、`InboxPage.tsx:149` `FilterRow label="类型"`）。**组织轴是「这是什么 kind」，不是「这要不要我出手 / 出多重的手」**——A4 要的 A/B/C 出手强度维度在 UI 里完全不存在。

2. **C 档 kind 没被移出裁决流，只是 Accept 按钮藏了**：`src/capabilities/shell/ui/ProposalCard.tsx:182` `isAcceptSupported(p.kind) && <Btn …>` 对 defer / archive / judge_retraction **仍渲染在同一条裁决流里**，只是隐掉 Accept CTA、留下「忽略」（`ProposalCard.tsx:215-223`）。ledger §A4 行 111 要求这三个 kind **移出裁决面**（snooze / agent-notes 旁观）——现状它们还坐在 B 档队列中间，半残地占着决策注意力。证据锚：`src/capabilities/shell/ui/inbox-api.ts:47-57`（注释明说这三个 kind「不渲 Accept CTA，只留忽略」）。

3. **不存在「乐观应用 + 撤销窗口」（A 档核心）**：`ProposalCard.tsx:95-117` `decide()` 是**显式 accept、阻塞式**（`busy` 态 + `setBusy`），裁决前提议一直 pending、什么都没发生。没有任何「AI 已自动应用、给你一个撤销窗口」的路径。A 档的「不打断、乐观出手、可 revert」体验在代码里零基础。

4. **裁决留痕活在内存、刷新即失**：`InboxPage.tsx:60` `const [resolved, setResolved] = useState<Record<string, string>>({})` 是本地 React state；文件头注释 `InboxPage.tsx:8` 明说「裁决后卡片淡化留痕，**刷新后消失**」。A 档的「revert 率」、B 档的「dismiss 率」两档健康信号（ledger §A4 行 112）在前端没有可持久观测的留痕面。

5. **无批量**：每张卡单独裁决（`ProposalCard` per-card `decide`）。A 档「一批同型低后果提议一眼扫过」、C 档「一键全部旁观」这类批量动作不存在。

6. **失信兜底已有局部、但散在 per-card**：block_merge stale（`ProposalCard.tsx:105` `isBlockMergeStale` → 页级 toast）、已裁决 409（`src/server/proposals/applier-helpers.ts:54-56` `'conflict' … already decided`）。这些是真实存在的故障态，但都绑在「逐条人审」单卡上，没有三档分流后的统一兜底口径。

---

## 数据契约（wire 形状 + 真实 sample，no-mock）

**端点**：`GET /api/proposals?status=pending` → `{ rows: ProposalInboxRow[]; next_cursor: string | null }`（`inbox-api.ts:107-110`）。
**裁决**：`POST /api/proposals/:id/decide` body `{ decision: 'accept'|'reverse'|'change_type'|'dismiss', new_relation_type?, user_note? }`（`inbox-api.ts:112-126`）。

**wire 行形状**（`inbox-api.ts:91-105` `ProposalInboxRow`，server `src/server/proposals/inbox.ts:526-536` 投影，Date→ISO string）：

```ts
interface ProposalInboxRow {
  id: string;
  kind: string;                 // aiProposalKinds 之一（全量 ~18，见下）
  target: { subject_kind: string; subject_id: string | null };
  payload: {                    // ProposalPayloadWire（各 kind proposed_change 形态不同）
    kind: string;
    reason_md: string;          // AI 白话理由（display-only，可含不透明 raw-id）
    evidence_refs: { kind: 'event'|'question'|'knowledge'|'artifact'|'record'; id: string }[];
    confidence?: number;        // 0..1，可缺
    proposed_change?: { from_knowledge_id?; to_knowledge_id?; relation_type?; weight?; [k]: unknown };
    [k: string]: unknown;
  };
  status: string;               // 'pending' | …
  proposed_at: string;          // ISO
  decided_at: string | null;
  actor_ref: string;            // 产出者轨道（可观测分轨）
  task_run_id: string | null;
  cost_micro_usd: number | null;
  source_action: string;
  source_subject_kind: string;
  signals: Record<string, unknown> | null;
}
```

**真实 sample（三档各一条，字段取自真 producer / schema，非 mock）**：

```jsonc
{
  "rows": [
    // —— B 档（逐条人审）：知识关系，可逆性靠人审，confidence 不足以自动出手 ——
    {
      "id": "prop_01h…edge",
      "kind": "knowledge_edge",
      "target": { "subject_kind": "knowledge_edge", "subject_id": "edge_8f2a…" },
      "payload": {
        "kind": "knowledge_edge",
        "reason_md": "你在『宾语前置』连续答错时，常把『定语后置』也判错——两者结构上是对比关系。",
        "evidence_refs": [
          { "kind": "event", "id": "evt_3c91…" },
          { "kind": "knowledge", "id": "kc_binyu…" }
        ],
        "confidence": 0.72,
        "proposed_change": {
          "edge_op": "create",
          "from_knowledge_id": "kc_binyu_qianzhi",
          "to_knowledge_id": "kc_dingyu_houzhi",
          "relation_type": "contrasts_with",
          "weight": 1
        }
      },
      "status": "pending",
      "proposed_at": "2026-06-28T03:12:00.000Z",
      "decided_at": null,
      "actor_ref": "dreaming",
      "task_run_id": "run_7a…",
      "cost_micro_usd": 1840,
      "source_action": "experimental:proposal",
      "source_subject_kind": "knowledge_edge",
      "signals": null
    },
    // —— B 档（逐条人审）：诊断推测（propose-only，conjecture）——
    {
      "id": "prop_01h…conj",
      "kind": "conjecture",
      "target": { "subject_kind": "mind_model", "subject_id": "kc_huoziju" },
      "payload": {
        "kind": "conjecture",
        "reason_md": "我猜你把『使动用法』和『意动用法』混了——它们的判别探针你连续两次都按使动答。",
        "evidence_refs": [{ "kind": "event", "id": "evt_aa12…" }],
        "confidence": 0.61,
        "proposed_change": {
          "claim_md": "把意动用法误当使动用法",
          "knowledge_id": "kc_huoziju",
          "cause_category": "concept_confusion",
          "confidence": 0.61,
          "recurrence_count": 2,
          "probe_md": "下面这句『孔子登东山而小鲁』的『小』是使动还是意动？",
          "discriminating": true,
          "predicted_p": 0.35,
          "baseline_p_at_induction": 0.58
        }
      },
      "status": "pending",
      "proposed_at": "2026-06-28T03:14:00.000Z",
      "decided_at": null,
      "actor_ref": "research_meeting",
      "task_run_id": "run_7b…",
      "cost_micro_usd": 2200,
      "source_action": "experimental:proposal",
      "source_subject_kind": "mind_model",
      "signals": null
    },
    // —— C 档（纯状态不进队列）：延后安排——ledger §A4 要求移出裁决面、降为旁观 ——
    {
      "id": "prop_01h…defer",
      "kind": "defer",
      "target": { "subject_kind": "learning_item", "subject_id": "li_92f…" },
      "payload": {
        "kind": "defer",
        "reason_md": "这道题今天到期但你已练满 30 分钟，我把它顺延到明天首屏。",
        "evidence_refs": [],
        "proposed_change": { "defer_until": "2026-06-29", "reason": "daily_cap_reached" }
      },
      "status": "pending",
      "decided_at": null,
      "proposed_at": "2026-06-28T03:15:00.000Z",
      "actor_ref": "coach",
      "task_run_id": "run_7c…",
      "cost_micro_usd": 0,
      "source_action": "experimental:proposal",
      "source_subject_kind": "learning_item",
      "signals": null
    }
  ],
  "next_cursor": null
}
```

> 注：当前 wire **没有** `tier`（A/B/C）字段——分档目前只能由前端按 kind 推。完整 kind→A/B/C 映射是基础设施缺口 ①（见末尾）。在它落地前，claude design 可按「B 档 = 绝大多数现有 kind / C 档 = defer·archive·judge_retraction / A 档 = 待映射」三分来出稿；映射表落地后字段从后端带下来。

---

## 收件箱应呈现什么（功能层，非视觉）

1. **三档分流是主组织轴**：把「出手强度」（A 读过 / B 判 / C 旁观）抬成收件箱的一级结构，取代现状的「按 kind 类型」平铺。owner 第一眼应能分清「哪些是 AI 已经替我做了的（只需扫一眼）/ 哪些真需要我裁决 / 哪些只是状态噪音」。

2. **B 档 = 唯一的主裁决车道**：逐条人审的提议（知识关系、诊断推测、题目草稿、目标范围……）是收件箱的主体与注意力焦点。每条带白话理由（`reason_md`）+ 可读证据（`evidence_refs` 白话化，`inbox-api.ts:154-172`）+ accept / dismiss（+ 关系类提议的改方向 / 改关系，`ProposalCard.tsx:193-214`）。

3. **A 档 = 事后审查 + 撤销可供性（非裁决）**：AI 已乐观应用的低后果动作，呈现为「已做 + 可撤销」而非「待你确认」。视觉上**降权于 B 档**——不抢注意力、不要求点击，只在 owner 想审查时可展开。**撤销窗口**是它的核心可供性（对应 ledger 的 A 档 revert 率信号）。

4. **C 档 = 移出主裁决流的旁观面**：defer / archive / judge_retraction 不进决策队列，降为「AI 旁注 / 已自动处理」的旁观条目（snooze / agent-notes 语义）。owner 可选择性查看，但它绝不占据主裁决视线。**这是相对现状最大的行为变更**（现状它们还混在 B 档里）。

5. **裁决留痕（两档健康信号的可见落点）**：A 档 revert 率 / B 档 dismiss 率应有可观测的留痕呈现（ledger §A4 行 112）。现状留痕仅本地内存、刷新即失——视觉稿应预留「裁决历史 / 健康信号」承载位（数据持久化是 follow-up，但 UI 形态现在定）。

6. **批量可供性**：A 档「一批同型一眼扫过 / 全部确认无误」、C 档「全部收进旁观」应支持批量，避免逐条点击低后果项的疲劳。B 档保持逐条（真裁决不批量）。

---

## 空态 / 失信兜底 / 故障态（显式功能约束）

> 单列章节——这些不是「nice to have」，是收件箱的功能契约。claude design 须为每态出稿。

**空态（多态，非单态）**
- **全空**：无任何 pending 提议。现状已有 `clearedEmpty`（`InboxPage.tsx:110-121`，「收件箱已清空 / 新提议会在下次 Dreaming session 后出现」+ 去看知识图 CTA）——三档版要保留这个「下次 dreaming 后出现」的解释性空态。
- **只剩 C 档**：B 档（真裁决）已清空，但还有 C 档旁观条目。这应呈现为**「决策已清零」的正向空态**（主车道空了），而非「还有 N 条待处理」——否则 C 档噪音会让 owner 误以为还有活要干。这是三档分流新引入的空态，须显式设计。
- **筛选后空**：现状 `InboxPage.tsx:159-170` 已有「没有匹配的提议 / 清除筛选」——三档筛选后同样要有。

**失信兜底（AI 提议本身可能已失效 / 不可信）**
- **裁决目标已失效（stale）**：block_merge 在题块离开 draft 后 accept 会软拒（`ProposalCard.tsx:103-110` + `inbox-api.ts:131-148` `isBlockMergeStale`，返 200 `{stale:true}`、不写事件、提议保持 pending）→ 须有「该提议已失效、已跳过」的兜底态，**不能标成已裁决**。
- **重复裁决（已决）**：同一提议被二次裁决返 409（`applier-helpers.ts:54-56` `'conflict' … already decided`）→ 须有「这条已经处理过了」的兜底态。
- **不透明 raw-id 污染理由**：`reason_md` 可能含 `block-<cuid>` 等不透明 ID（`inbox-api.ts:202-230` `splitReasonIds` 把 raw 段切出、`ProposalCard.tsx:149-164` 包进 `<code .ev-rawid>` 视觉去权重）→ 理由文案的「技术引用 chip」形态须在三档卡里保留。
- **证据不可达**：部分 `evidence_refs`（event/question/record）详情页未迁 SPA，`route=null` 渲为纯文本不可点（`inbox-api.ts:154-172`）→ 可达 vs 不可达证据须二态可分。

**故障态（系统层失败）**
- **列表不可用**：`InboxPage.tsx:152-158` `Stateful` 的 `error` 态（「提议列表暂不可用」+ 重试）——保留。
- **单条裁决失败**：`ProposalCard.tsx:112-114` `decide()` catch → 页级 toast（`InboxPage.tsx:209-216` `pf-toasts`）。三档版须明确：A 档撤销失败、C 档旁观失败各自的反馈口径。
- **熔断触发态（新）**：单位时间裁决量超护栏时（基础设施缺口 ②），收件箱须有**「今天裁决得有点多 / 已暂缓」的告知态**——warning 水位只告知不打断、硬顶才软拦（按 `feedback_guardrail_warning_vs_hard_limit` 分层语义）。这是新功能态，须 owner 先拍护栏形态（见缺口 ②）再出稿。

---

## 不在本 handoff 范围

- 不改提议的产出 / accept applier 逻辑（`src/server/proposals/*`）——本面纯前端分流 + 体验。
- 不定 A/B/C 的**完整 kind 映射**（缺口 ①，owner + 实现动作）——本稿按「B 为主 / C=三个旁观 kind / A 待映射」三分出稿。
- 不实现裁决量护栏的**阈值实参**（缺口 ②，先埋点后定数）——本稿只定「熔断告知态」的体验形态。
- 不做 C 档旁观条目的持久化存储模型（裁决留痕持久化是 follow-up）。

---

## 边界提醒（给实现者，非 claude design）

- 收件箱是 shell 域既有页（`src/capabilities/shell/ui/InboxPage.tsx`），按既有 loom 卡 / primitives（`LoomCard` / `SectionLabel` / `EmptyState` / `Stateful` / `Btn`）落地。
- 动 UI 代码前仍走项目的 design-doc pre-flight；本 handoff + claude design 视觉稿 = pre-flight 的输入。
- A/B/C 分档一旦从后端带 `tier` 字段下来（缺口 ① 实现后），前端按 kind 推的临时三分要换成读 wire 字段——预留这个 seam。

---

## 基础设施缺口（needs issue）

> 以下两条是**实现动作 / 数据缺口**，不硬塞进本 handoff。返回 issue 草案，owner 批后开 Linear。

### 缺口 ① 完整 `aiProposalKind → A/B/C 出手强度` 映射表

**现状**：ledger §A4 给了**原则**（行 110「A 用静态可逆性兜底、不靠 confidence」）+ **3 个显式 C 档 kind**（行 111 defer / archive / judge_retraction）。但 `src/core/schema/proposal.ts:7-77` 全量 **~18 个 `aiProposalKinds`** 到 A/B/C 的**完整逐 kind 指派从未写下**——grep 全仓无此映射表（`inbox-api.ts:18-41` 的 `KIND_META` 只给 label/icon/tone，无强度档；`acceptSupportedProposalKinds` 只区分「能否 accept」，不是出手强度）。这是 owner 留白 + 实现动作：每个 kind 的「静态可逆性」要逐条裁定，才能决定它进 A（自动+撤销）/ B（人审）/ C（旁观）。

**issue 草案**：
- **标题**：YUK-354 A4 — 钉死 aiProposalKind → A/B/C 出手强度完整映射表
- **why**：A4 三档分流的前端 + 后端 `tier` 字段都依赖这张表；缺它则收件箱只能按 kind-type 平铺（现状反模式），三档形态无法落地。
- **scope**：(a) 对全量 `aiProposalKinds`（`src/core/schema/proposal.ts:7-77`）逐 kind 按「静态可逆性 × 后果」裁定 A/B/C；(b) 落为 `core/schema` 里的声明式映射（仿 `acceptSupportedProposalKinds` 的单点真相 + 分区单测防漂移）；(c) server inbox 投影（`src/server/proposals/inbox.ts:526`）带 `tier` 字段下 wire；(d) `inbox-api.ts` `ProposalInboxRow` 加 `tier`。
- **锚点**：`docs/design/2026-06-14-product-rethink-decisions-ledger.md` §A4 行 110-111（原则 + 3 C kind）；`src/core/schema/proposal.ts:7-77`（全量 kind）；`src/core/schema/proposal.ts:89-110`（`acceptSupportedProposalKinds` 单点真相先例）；`src/capabilities/shell/ui/inbox-api.ts:18-41`（KIND_META，待加 tier 维度）。
- **owner 留白**：A 档（乐观自动出手）该收哪些 kind 是最敏感的一档——「自动应用 + 撤销窗口」意味着 AI 先斩后奏，owner 须逐 kind 拍可逆性是否足够。建议默认保守（A 档先空 / 只收最低后果可逆 kind，其余全 B），日用后再上提。

### 缺口 ② 单人裁决量熔断（decision-rate 护栏，分层）

**现状**：grep `src/capabilities/shell` / `src/server/proposals` / `src/capabilities/agency` **无任何裁决量 / rate-limit / 熔断**机制（唯一命中是 `src/capabilities/shell/ui/TodayPage.tsx:87` 的成本预算 TODO，是 $ 花费、与裁决频次无关）。单人工具里，AI 一夜产出大量提议、owner 疲劳连点裁决是真实事故面（误判、橡皮图章式 accept）。

**issue 草案**：
- **标题**：YUK-354 A4 — 收件箱单人裁决量护栏（warning 水位 + 硬顶，分层）
- **why**：A4 北极星锚是「代理信任」——但信任的前提是 owner 不被提议洪流淹没 / 不疲劳橡皮图章。无护栏则三档分流的「把决策劳动还给 AI」目标在高产出夜会被反噬。
- **scope**：按 `feedback_guardrail_warning_vs_hard_limit` 分层——(a) **warning 水位**：单位时间裁决量过高时**零干预只告知 + 可观测**（收件箱顶「今天裁决得有点多」告知态，不拦）；(b) **硬顶 3-5×**：仅防事故级连点，软拦（暂缓 + 解释），绝不卡死正常重型 review。(c) 埋点先行：先记裁决频次遥测 N 周，再定实参阈值（不预设静态数）。
- **锚点**：memory `feedback_guardrail_warning_vs_hard_limit`（warning 零干预 / 硬顶 3-5× 防事故分层）；`src/capabilities/shell/ui/ProposalCard.tsx:95-117`（per-card decide，护栏挂载点）；`src/server/proposals/applier-helpers.ts:54`（裁决写入点，frequency 计数挂载点）；`src/capabilities/shell/ui/TodayPage.tsx:87`（既有成本护栏 TODO 先例，分层语义同构）。
- **owner 留白**：阈值实参（每小时 / 每 session 多少条触 warning、多少触硬顶）= 先埋点后定，不在本 issue 拍数。

---

## 返回给 team-lead

- **doc 路径**：`docs/design/2026-06-28-form-axis-A4-handoff.md`
- **一句话 scope**：收件箱按「出手强度 A/B/C」三档分流——A=AI 乐观应用+撤销窗口（读过非判）/ B=逐条人审（唯一主裁决车道）/ C=defer·archive·judge_retraction 移出裁决面降为旁观——取代现状「按 kind-type 平铺、C 档混在 B 档里只藏 Accept 按钮」的无差别裁决流。
- **基础设施 issue 草案**：① 完整 kind→A/B/C 映射表（ledger §A4 行 110-111 给原则+3 C kind，全量 ~18 kind 逐 kind 指派是 owner 留白+实现动作；锚 `core/schema/proposal.ts:7-77`）；② 单人裁决量熔断（grep 全仓无 rate-limit，分层 warning+硬顶；锚 memory `feedback_guardrail_warning_vs_hard_limit` + `ProposalCard.tsx:95` + `applier-helpers.ts:54`）。
- **留 owner 拍的开放决策**：
  1. **「读 vs 判」轴 ≠ ledger A/B/C 轴的口径冲突**（本稿「权威语义」节已 surface）：派单把 C 描述成「需斟酌的最重裁决」，ledger 的 C 是「纯状态不进队列」（最轻、移出视线）。本稿以 ledger 为准。若 owner 真正想要的是「B 人审车道**内部**再按决策成本分轻重的二级梯度」，那是叠加在 B 档之上、与 A/B/C 出手强度正交的另一根轴——须 owner 明确要不要、以及与三档如何并存。
  2. **A 档收哪些 kind**（同缺口 ① owner 留白）：乐观自动出手是最敏感档，建议默认保守起步（A 档先空 / 只收最低后果可逆 kind）。
