# 备课台 (Prep-Desk) Conjecture Card — 设计稿 (DRAFT, 待 owner 批)

- **Issues**: YUK-567 (conjecture-wire S3b — prep-desk conjecture card UI + probe 作答区, design-gated) · YUK-406/440 (教研团 Phase 0 / A13 conjecture 引擎)
- **Date**: 2026-07-12
- **Status**: **DRAFT — 待 owner 判词**。UI 代码零动，等批。
- **契约权威**: `docs/design/handoff/2026-06-27-prep-desk-conjectures.md`（functional handoff）
- **视觉北极星**: `docs/design/loom-refresh/project/handoff-band.jsx`（晨间交班带 · conjecture chip 形态）
- **背景补**: YUK-567 明说「card 组件尚不存在，需 claude.ai/design pass」——本稿是 contract-grounded 设计 brief + 推荐切法，**视觉细节仍应过 claude.ai/design**。

---

## 0. 这是什么

备课台 = 私人教研团「**为你而备**」的界面：夜间 research-meeting job 从**反复出现的失败格**归纳出对学习者的**猜想**（misconception belief），每条配一道**尚未跑的判别 probe**（团队*正要问*你的题）。**不是** backlog / todo / inbox / nag。至多 **3** 条，salience 排序，有限、无愧疚。

## 1. Ground truth（已 live vs 缺口）

- **后端全 live**：`GET /api/prep-desk/conjectures`（`loadPrepDeskConjectures`，top ≤3 pending，salience DESC，`confidence` 永不过线）。
- **入口 chip 已建**：`/today` 的 `OvernightDigestBand`（「夜链·交班」带）已渲「**备课猜想 N**」chip（`TodayPage.tsx:225` `d.new_conjectures_count`，icon `teach`）。
- **缺口 = 目的地**：点了那个 count 之后，看不到那 ≤3 张真卡。**YUK-567 = 建这批卡 + probe 作答区。**
- **conjecture 现状**：`KIND_META.conjecture` 已存在（`inbox-api.ts:40`「诊断推测」），但注释明说「现有通用 ProposalCard 渲染（非备课台）；propose-only，无 Accept CTA」——即现在 conjecture 掉进通用收件箱、无 accept。备课台卡是**专属 felt 面**，非通用 ProposalCard。

## 2. 绑定契约（卡片 MUST 守，逐字引 handoff）

- **(a) 任何内部校准数字永不渲染**（handoff §2a）：`confidence` / `predicted_p` / `baseline_p` 都不在 wire 上。「不得渲 confidence %、『73% 把握』badge、『我们预测你会错』概率或任何伪精度数字……卡上一个数字就是明确的 anti-guilt KILL 判据」。要强调只能求**非数字**的 server 信号（如 `emphasis` enum），不许裸概率。
- **(b) 无 backlog / todo / 未读计数**（§2b）：不显示「12 条等待」/增长队列。cap=3，只显 0..3。0 条 = 平静空态「教研团暂无新猜想」，非「全清空！」成就 nag。
- **(c) 无 push / 催促**（§2c）：无红点、无「action required」、无逾期样式。framing = 团队*为你备好了*，你来访时呈现——**pull 非 push**。
- **Anki-export tripwire**（§4）：`claim` + `evidence` + **未跑 `probe_md`** = 有据猜想，**不可导出成 flashcard**。probe_md 必须以「**团队正要问你的题**」framing 呈现，**绝不**做成可翻转卡正反面。
- **ND-5 红线**（§3）：accept/edit/reject 皆**不写 FSRS / review / 不 enroll learning item**。卡不得把 accept 呈现为「加进我的复习」。

## 3. 组件类型 + 挂载

**组件类型**：`/today` 内的 **inline 展开面**（section/panel），从既有「备课猜想 N」digest chip 展开——非新 route、非 modal。

**理由**：入口 chip 已在 `OvernightDigestBand` 里；备课台语义（「团队为你备好、来访时呈现」）与「夜链·交班」带同源（都是「你不在时团队做的」）。就地展开 = 复用既有入口 + 守 pull-not-push，避免新增 route 的导航重量。

**备选（列出等 owner/claude.ai/design 定）**：
- B1（推荐）：chip → 就地 inline 展开 ≤3 卡（同 band 内）。
- B2：chip → 专属 `/prep-desk` route（loom 那套完整晨间交班带的一部分；更重，band 本身也没建）。
- B3：`/today` 独立 section（不挂 digest chip）。

## 4. 卡片解剖（每字段守 §2 invariant）

单张 pending conjecture 卡（consume `PrepDeskConjecture`）：

| 元素 | 数据 | 处理 |
|---|---|---|
| kind 标 | — | `KIND_META.conjecture` 升级成教研团 framing（「教研团的猜想 / 备课」），coral tone，icon `teach`/`sparkle`（§handoff §1 KIND_META TODO） |
| claim | `claim` | 主文，**framing = 假设非测量**（「教研团猜：你把链式法则当成导数相乘」）。绝不「你的弱点是」 |
| cause chip | `cause_category` | 小 chip（白话映射，复用 tone 语系） |
| 复现 | `recurrence_count` | 「反复出现 N 次」——**这是失败格计数、非校准概率**，handoff 明确 `recurrence_count` 在 wire 上、允许显（≥2）。是唯一许显的「数字」 |
| discriminating | `discriminating` | 可选微标「只有这个误区会错」（true 时） |
| probe | `probe_md` | 「**团队正要问你的题**」framing 区（§4 tripwire）。pending 态 = 只显题**文本**，非作答、非 flashcard |
| evidence | `evidence[]` | 复用既有 `evidenceReadable` / `dedupeEvidence`（inbox-api.ts）→ 「源自一道题 / 一次判定」back-link chip |
| corrected 标 | `corrected_by_owner` | true 时微标「你改过」 |
| **无** | ~~confidence/predicted_p~~ | invariant (a)：一个数字都不出 |

**动作**（→ 既有 `/api/proposals/[id]/decide`，§3）：
- **Accept = 认可非确认**：「对，往这个方向想」——calibration anchor，**非**已确认弱点。绝不「加进复习」。
- **Edit**：改写 claim（`corrected_by_owner` + mem0 CORE seam），仍不 auto-confirm。
- **Reject**：dismiss + digest，卡掉出备课台。

## 5. 流 / 状态（多切片）

pending 卡本身是切片 1。完整 conjecture 判别流是多态的：

1. **pending 卡**：claim + 「正要问」probe 文本 + evidence + accept/edit/reject。（**S3b 主切片**）
2. **accept 后 → probe served**：accept 经 `acceptConjectureProposal` → `serveProbeOnce` 铸出可答的 probe question → **probe 作答区**出现（YUK-567 标题的「probe 作答区」）。⚠️ 这是**切片 2**，与 pending 卡不同态——建议分片，先落 pending 卡（切片 1），作答区（切片 2）随后。
3. **probe 答完 → confirm/refute**：probe one-shot 结算，铸/否 confirmed weakness。（后端已 live，UI 结算态属切片 2 尾）

**空/异常态**（§2b/loom 对齐）：
- 0 条：平静空态「教研团暂无新猜想」（非成就 nag）。
- loading：骨架（复用既有 SkLines / loom `HBLoading` 语系）。
- error：「备课暂不可用」+ retry（复用 `Stateful`，同 digest band 口径）。

## 6. 将 touch 的文件

**创建**：
- `src/capabilities/shell/ui/PrepDeskConjectures.tsx`（备课台卡面组件 + 展开容器）——切片 1
- `src/capabilities/shell/ui/prep-desk-api.ts`（client：`getPrepDeskConjectures` + `PrepDeskConjecture` wire 类型镜像；decide 复用 `inbox-api.ts` 既有 `decideProposal`）
- 对应 `.unit.test.tsx`（SSR render 锁 anti-guilt invariant：断言**无** confidence/predicted_p/`%`、无 backlog count、probe 非 flashcard framing）
- CSS：备课台卡样式（globals.css 增一段，复用既有 tone/card token；视觉过 claude.ai/design）

**修改**：
- `src/capabilities/shell/ui/inbox-api.ts`：`KIND_META.conjecture` 升级教研团 framing（label/icon/copy）
- `src/capabilities/shell/ui/TodayPage.tsx`：「备课猜想 N」chip → 展开 `PrepDeskConjectures` 面（挂载点）
- `docs/design/handoff/2026-06-27-prep-desk-conjectures.md` §5 Design-lane TODO 勾掉对应项

**不碰**：后端读模型 / route / proposal decide 管道（全 live）；`ProposalCard.tsx`（通用收件箱，非备课台）。

## 7. 推荐切法

- **切片 1（本稿主张先落）**：pending 备课台卡（claim + 正要问 probe + evidence + accept/edit/reject）+ KIND_META 升级 + /today chip 展开挂载 + anti-guilt 锁测。**零后端改动**。
- **切片 2（随后单开）**：probe 作答区（accept → served probe 答题 → confirm/refute 结算态）。
- 每片：design pre-flight → TDD → 全量 gate → 独立 review。

## 8. 待 owner / claude.ai/design 定的决策
1. **挂载**：B1 inline 展开（推荐）vs B2 专属 route vs B3 /today section？
2. **视觉保真**：本稿只定 contract-grounded 骨架；卡的实际视觉（loom 缕带/交班帖语系、密度、织线 motif 用不用）要不要过 claude.ai/design 出正稿？
3. **切片边界**：pending 卡（切片 1）与 probe 作答区（切片 2）分开落，认可否？
4. **emphasis 信号**：要不要现在就让后端加个**非数字** `emphasis: 'high'|'normal'` enum（§2 允许），还是先不加、全平铺？
