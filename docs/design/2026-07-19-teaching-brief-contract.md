# 教研简报（Teaching Brief）状态机与只读 wire contract

- **Issue**: YUK-705（P0F/1）
- **Date**: 2026-07-19
- **Status**: P0F contract；后续实现以本文为准
- **Scope**: 一次例会 → 一个关键判断 → 一个已备行动 → 一次结果对账
- **Planned endpoint**: `GET /api/prep-desk/brief`
- **Inputs**: `docs/superpowers/specs/2026-06-18-private-teaching-research-team-vision.md`、
  `docs/design/2026-07-12-prep-desk-card-design.md`、
  `docs/design/handoff/2026-06-27-prep-desk-conjectures.md`

## 0. 产品单位与边界

教研简报是 `/today` 上唯一的一份「为你而备」交付，不是把猜想、探针和结果三个列表拼在
一起。一次响应最多有一个 primary brief：

```json
{ "brief": null }
```

或：

```jsonc
{ "brief": { /* TeachingBrief 的一个判别分支 */ } }
```

它把现有关系脑链路编辑成四块用户内容：

1. `finding`：教研团目前在检验什么；
2. `basis`：为什么提出这条判断，以及可追溯到哪里；
3. `prepared_action`：已经准备好、用户现在可以选择的下一步；
4. `current_outcome`：当前仍待裁决、待作答，还是已得到支持/被排除。

`brief_id`、`state` 和时间戳是 transport metadata，不是第五块产品内容。P0F 不展示多 agent
对话、agent note、task run、思维链或「教研员 A/B」剧场；团队感来自持续负责和可检验的交付。

本文只定义 read projection。P0F/2 才实现 reader 与 route；P0F/3–5 才串 UI、ack 和后续
练习。本文不建表、不加 writer，也不改变任何现有单写者。

## 1. Code-grounded 真相源

以下均为当前已经存在的事实，不是新 lifecycle 字段：

| 阶段 | 当前 SoT | 身份/关联 | 现有实现 |
|---|---|---|---|
| 猜想 | `event.action='experimental:proposal'`；raw event 在 `payload.ai_proposal` 保存 proposal，`ProposalInboxRow.payload.kind='conjecture'` 是解析后的形状 | proposal event `id` 就是 conjecture id | `src/core/schema/proposal.ts` 的 `ConjectureProposalChange`；`src/server/proposals/inbox.ts`；`src/capabilities/shell/server/prep-desk.ts` |
| 用户接受/改写/驳回 | 链到 proposal 的 `event.action='rate'`；`payload.rating` 派生 `accepted` / `dismissed` | `subject_kind='event'`、`subject_id=proposal id` | `src/capabilities/agency/server/conjecture-accept.ts`；`src/server/proposals/inbox.ts` |
| 探针已出 | `question.source='mind_probe'` 的 draft question 行存在；**没有 probe-served event** | `question.source_ref` 及 `metadata.conjecture_proposal_id` 指回 proposal event | `src/capabilities/agency/server/conjecture/probe-lifecycle.ts` |
| 探针待答 | 上述 question 不存在以其为 subject 的 `experimental:probe_result` | `subject_kind='question'`、`subject_id=question.id` | `src/capabilities/shell/server/prep-desk-probes.ts` |
| 探针结论 | 唯一的 `event.action='experimental:probe_result'` | event payload 的 `conjecture_event_id`、event `caused_by_event_id` 指回 proposal | `src/capabilities/agency/server/conjecture/probe-lifecycle.ts` |

proposal 中的 `reason_md` 是 `basis.summary_md` 的当前来源；`evidence_refs` 是归纳证据。探针
question 自身及 result event 依次追加到 evidence trace。projection 不复制这些事实，也不回写
`status`、`served_at`、`answered_at`、`brief_state` 或 `acknowledged_at` 等派生字段。

`src/capabilities/shell/server/overnight-digest.ts` 仍可描述昨夜是否有活动，但其
`new_conjectures_count`、proposal count、run count 和 agent-note count **不参与新 wire**，也不作为
primary badge。尤其 `new_conjectures_count` 是前一 Asia/Shanghai 日历日窗口内的**历史创建数**，
accept/dismiss 后不会减少，绝不能拿它推导 pending、primary 或 CTA 状态。activity facts 与
actionable primary 是两个读模型；简报展示编辑后的一个结论，不展示后台产量。

## 2. `TeachingBrief` 判别联合

P0F/2 应在 `src/capabilities/shell/server/teaching-brief.ts` 导出 `TeachingBrief` 及以下组成类型，
并在 `src/capabilities/shell/api/contracts.ts` 以同形 Zod schema 锁定响应。这里的字段名、必填性
和 `null` 规则是实现契约。

```ts
import type { CauseCategoryT } from '@/core/schema/cause';
import type { ProposalEvidenceRefT } from '@/core/schema/proposal';

export type TeachingBrief =
  | FindingTeachingBrief
  | ProbeReadyTeachingBrief
  | OutcomeConfirmedTeachingBrief
  | OutcomeRetiredTeachingBrief;

export type TeachingBriefEvidenceRef =
  | {
      role: 'induction';
      kind: ProposalEvidenceRefT['kind'];
      id: string;
    }
  | { role: 'probe'; kind: 'question'; id: string }
  | { role: 'outcome'; kind: 'event'; id: string };

export interface TeachingBriefFindingSection {
  claim_md: string;
  knowledge_id: string;
  cause_category: CauseCategoryT;
}

export interface TeachingBriefBasisSection {
  summary_md: string;
  evidence_trace: TeachingBriefEvidenceRef[];
}

export interface TeachingBriefBase {
  /** 稳定身份：原 conjecture proposal event id。 */
  brief_id: string;
  state: 'finding' | 'probe_ready' | 'outcome_confirmed' | 'outcome_retired';
  /** 当前分支最新 SoT 的 created_at：proposal / question / probe_result。 */
  updated_at: string;
  /** finding/outcome 为 ISO-8601；probe_ready 明确为 null。 */
  expires_at: string | null;
  finding: TeachingBriefFindingSection;
  basis: TeachingBriefBasisSection;
}

export interface FindingTeachingBrief extends TeachingBriefBase {
  state: 'finding';
  expires_at: string;
  prepared_action: {
    kind: 'review_finding';
    proposal_id: string;
    probe_preview_md: string;
  };
  current_outcome: {
    status: 'awaiting_decision';
    summary_md: string;
  };
}

export interface ProbeReadyTeachingBrief extends TeachingBriefBase {
  state: 'probe_ready';
  expires_at: null;
  prepared_action: {
    kind: 'answer_probe';
    probe_question_id: string;
    prompt_md: string;
  };
  current_outcome: {
    status: 'awaiting_answer';
    summary_md: string;
  };
}

export interface OutcomeConfirmedTeachingBrief extends TeachingBriefBase {
  state: 'outcome_confirmed';
  expires_at: string;
  prepared_action: { kind: 'none' };
  current_outcome: {
    status: 'confirmed';
    summary_md: string;
    probe_question_id: string;
    probe_result_event_id: string;
  };
}

export interface OutcomeRetiredTeachingBrief extends TeachingBriefBase {
  state: 'outcome_retired';
  expires_at: string;
  prepared_action: { kind: 'none' };
  current_outcome: {
    status: 'retired';
    summary_md: string;
    probe_question_id: string;
    probe_result_event_id: string;
  };
}

export interface TeachingBriefResponse {
  brief: TeachingBrief | null;
}
```

P0F/2 的导出归属固定如下，避免 server type、route schema 出现两个真相源：

- `src/capabilities/shell/server/teaching-brief.ts`：本文全部 TypeScript wire type、
  `TEACHING_BRIEF_FINDING_TTL_MS`、`TEACHING_BRIEF_OUTCOME_TTL_MS` 与
  `loadTeachingBrief`；
- `src/capabilities/shell/api/contracts.ts`：`TeachingBriefSchema` 与
  `TeachingBriefResponseSchema`，字段与 server type 同形。

reader 签名固定为：

```ts
export async function loadTeachingBrief(
  db: Db,
  now: Date = new Date(),
): Promise<TeachingBriefResponse>;
```

`now` 只为确定性 DB 测试注入；route 不接受客户端时钟。

### 2.1 必填、optional 与 `null`

- 四块内容在四个分支都必填；不得用 `undefined`/`null` 省略某块。P0F/2 的 Zod object 必须
  strict，尚不可执行的 action 与未来 section 不得被 schema 静默剥离后接受。
- `finding.knowledge_id` 非空。它来自已通过 `ConjectureProposalChange` 校验的
  `knowledge_id`；关联断裂时跳过候选，不能降成 `null` 后再声称能定向行动。
- `finding.cause_category` 必须由 canonical `CauseCategory` Zod schema 校验；TypeScript 复用
  `CauseCategoryT`，route schema 不得退化成无约束 `z.string()`。
- `basis.summary_md` 取 proposal 的 `reason_md`；不得用 agent 日志或运行错误拼接。
- `basis.evidence_trace` 至少含一条 `role='induction'` 的原 proposal evidence ref。无法建立
  该 trace 的候选 fail-closed；不能制造「基于近期表现」却不给来源的卡。
- probe 分支在 induction refs 后追加 `{role:'probe', kind:'question', id: question.id}`；outcome
  再追加 `{role:'outcome', kind:'event', id: result.id}`。保留 proposal 原顺序并按 role 顺序追加；
  对完全相同的 `(role,kind,id)` 去重。
- 完整链必须同时满足：question `source='mind_probe'`、`draft_status='draft'`、
  `source_ref` 与 `metadata.conjecture_proposal_id` 都等于 proposal id、`knowledge_ids[0]` 等于
  proposal `proposed_change.knowledge_id`、`prompt_md` 等于 proposal
  `proposed_change.probe_md`；result 的 `subject_id` 等于 question id；result
  `payload.conjecture_event_id` 与 `caused_by_event_id` 都等于 proposal id。任一关联不一致都按
  corrupt candidate 跳过。
- result 的合法配对只有 `resolution='confirmed', outcome=0` 或
  `resolution='retired', outcome=1`；不能只分别校验枚举后接受互相矛盾的组合。
- `updated_at` 只做排序/刷新锚，不渲染「已等待 N 天」；`expires_at` 是 reader 计算值，不持久化。
- 唯一允许的 `null` 是 `probe_ready.expires_at`。当前 wire 不声明 `plan_impact`、
  `method_choice`、ack、practice 或 continue action；这些键必须**缺席**，不得传空对象、`null`
  或假内容。
- P0F 不把 `answer_md`、`answer_image_refs`、judge 原文或 `reference_md` 放入简报。结果只表达
  canonical qualitative `resolution`。
- accepted/edit 后的 `finding.claim_md` 优先读对应 accept rate payload 中非空的
  `corrected_claim_md`，否则读 proposal `proposed_change.claim_md`；`knowledge_id` 与
  `cause_category` 仍读 proposal。当前 public decision route 尚未透传 `corrected_payload`，所以
  P0F 不承诺改写 UI，只保证既有 edited event 能被忠实投影。
- P0F/2 尚无 outcome ack 或 remediation SoT，所以 outcome 的 `prepared_action` 必须是
  `{kind:'none'}`。P0F/4 落地 ack、YUK-709 接上现有 KC-scoped practice 时，必须同步升级
  TypeScript 判别联合与 strict Zod schema，才可新增对应 action。不得让当前 schema 提前接受
  尚不可执行的 action。

### 2.2 文案语义

- `finding` 是可证伪的假设，不写成「你的弱点就是……」。
- finding 的 `awaiting_decision` 只表示「这仍是一条待检验的判断」。接受/改写只是认同研究
  方向，**不是**确认弱项。
- `confirmed` 只表示「这条判断得到这次探针的支持，下一步可以针对它练习」，不升级为人格
  定论或永久能力标签。
- `retired` 只表示「这条判断被这次探针排除，原计划可以继续」，不用「你证明了自己」或
  清零成就文案。
- `summary_md` 必须是短、事实性产品文案；不输出概率、后台计算、内部 prompt 或 agent 争论。

## 3. 状态投影与转移

状态由现有事实组合投影，永不写回源表：

| 当前投影 | 必要事实 | 现有动作/事实变化 | 下一投影 |
|---|---|---|---|
| 无 | 有一个未过期、`status='pending'` 的 conjecture proposal | reader 选为 primary | `finding` |
| `finding` | pending proposal；尚无 canonical probe/result | 用户 `accept`；同一 transaction 成功插入 mind-probe question。若未来 route 透传既有 applier 的 `corrected_payload`，edited accept 同样进入此态 | `probe_ready` |
| `finding` | 同上 | 用户 `dismiss`，或 proposal stale，或 finding 到期 | 无（再选下一候选） |
| `probe_ready` | accepted proposal + mind-probe question + 无 result | canonical answer route 写 `resolution='confirmed'` 的 result | `outcome_confirmed` |
| `probe_ready` | 同上 | canonical answer route 写 `resolution='retired'` 的 result | `outcome_retired` |
| 任一 outcome | 完整 proposal → question → result 链 | P0F/4 的持久 acknowledgement，或 outcome 到期 | 无（再选下一候选） |

两个重要的非转移：

1. proposal accept applier 的返回值中 `weakness_confirmed` 始终为 false；rate event 只记录
   `rating='accept'` 与 calibration anchor，不允许
   `finding → outcome_confirmed` 直跳。
2. judge 返回 `partial` / `unsupported` 时 canonical route 422 且不写 result，projection 保持
   `probe_ready`，给用户保留重试机会。

当前 `acceptConjectureProposal` 在 active-probe cap 命中时允许 rate accept 成功但不插 question。
这条 accepted-without-question 链既不是 `finding`（已非 pending），也不是 `probe_ready`（没有可答
question）。P0F/2 必须把它视为不完整候选：fail-closed 跳过并记可观测日志，不能伪造第五态、
不能重放 accept、也不能声称「探针已备好」。修复/补偿 writer 不在 YUK-705/706 范围。

## 4. TTL、ack 与 supersession

### 4.1 固定过期规则

为避免备课台变成历史 backlog，P0F 锁定两个 reader 常量：

```ts
export const TEACHING_BRIEF_FINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TEACHING_BRIEF_OUTCOME_TTL_MS = 7 * 24 * 60 * 60 * 1000;
```

- eligibility 使用半开区间：`created_at <= now && now < created_at + TTL`；恰好到
  `expires_at` 即不再候选。
- `finding.expires_at = proposal event.created_at + 7d`（在 `ProposalInboxRow` 暴露为
  `proposed_at`）。
- `outcome_*.expires_at = probe_result.created_at + 7d`。
- `probe_ready` 不按时钟过期：只要 question 仍 served-but-unanswered，就保持可恢复，
  `expires_at=null`。UI 仍不得显示 overdue、红点或催促。
- 过期只影响简报 eligibility，不 dismiss proposal、不删除 question/event、不改变 proposal inbox。

### 4.2 acknowledgement

- finding 的「已处理」沿用现有 proposal decision：accept/edit 转入 probe；dismiss 退出。
- probe 的「已处理」沿用 canonical `experimental:probe_result`；不另写 probe ack。
- outcome 目前**没有**持久 acknowledgement SoT。P0F/2 不写 ack，也不得假装存在
  `acknowledged_at`，因此它为 outcome 返回 `{kind:'none'}`。P0F/4 将新增 append-only、幂等
  acknowledgement event；其 action literal
  必须在该实现里由 canonical constant 与 reader 一起定义，本文不编造一个当前不存在的 event 名。
- P0F/4 落地后，已 ack 的 result 立即失去 eligibility；ack 只追加事件，绝不更新 proposal、
  question 或 result event。落地前 outcome 仅由 7 天 TTL 收口。

短暂被更高优先级候选遮住不等于 ack 或过期。高优先级简报收口后，仍在 TTL/active 范围的
低优先级候选可以再次成为 primary。

## 5. 唯一 primary 的确定性选择

reader 先为每条完整 provenance chain 计算状态，再从所有 eligible candidates 选一个。固定顺序：

1. **未 ack、未过期 outcome**：`outcome_confirmed` 与 `outcome_retired` 同一优先档，不因
   confirmed 更「严重」而加权；按 result `created_at DESC, event.id DESC` 取一条。
2. **served-but-unanswered probe**：按 question `created_at DESC, question.id DESC` 取一条；
   与当前 `loadActiveProbes` 的 newest-first 口径一致。
3. **未过期 pending finding**：沿用 `loadPrepDeskConjectures` 的内部 salience
   `confidence × recurrence_count DESC`，再以 proposal event
   `created_at DESC, event.id DESC`（即 inbox `proposed_at`）打破
   平局。salience 仅在 server selector 内存在，绝不进入结果对象或日志文案。
4. 没有 eligible、完整候选时返回 `{brief:null}`。

因此全局优先级是：

```text
latest outcome > latest active probe > highest-salience fresh finding > quiet null
```

不得先各取三条再由客户端选；不得用 overnight count、unread、打开次数或 UI 本地顺序选
primary。route 每次对同一 DB snapshot 与 `now` 必须返回同一 `brief_id/state`。

## 6. Wire examples

以下只示例 wire；文案可在不改变语义的前提下微调。示例刻意没有任何 calibration number、
recurrence count、backlog count 或 agent-run 内容。

### 6.1 `finding`

```json
{
  "brief": {
    "brief_id": "evt_conjecture_01",
    "state": "finding",
    "updated_at": "2026-07-18T15:10:00.000Z",
    "expires_at": "2026-07-25T15:10:00.000Z",
    "finding": {
      "claim_md": "你可能在复合层级增加时漏掉内层变化率。",
      "knowledge_id": "kn_chain_rule",
      "cause_category": "concept_misunderstanding"
    },
    "basis": {
      "summary_md": "这个模式在最近几次相关作答中重复出现，值得用一道判别题确认。",
      "evidence_trace": [
        { "role": "induction", "kind": "event", "id": "evt_attempt_a" },
        { "role": "induction", "kind": "question", "id": "q_source_b" }
      ]
    },
    "prepared_action": {
      "kind": "review_finding",
      "proposal_id": "evt_conjecture_01",
      "probe_preview_md": "求 d/dx sin(x²)，并标出每一层变化率。"
    },
    "current_outcome": {
      "status": "awaiting_decision",
      "summary_md": "这仍是一条待检验的判断。"
    }
  }
}
```

### 6.2 `probe_ready`

```json
{
  "brief": {
    "brief_id": "evt_conjecture_01",
    "state": "probe_ready",
    "updated_at": "2026-07-19T01:20:00.000Z",
    "expires_at": null,
    "finding": {
      "claim_md": "你可能在复合层级增加时漏掉内层变化率。",
      "knowledge_id": "kn_chain_rule",
      "cause_category": "concept_misunderstanding"
    },
    "basis": {
      "summary_md": "这个模式在最近几次相关作答中重复出现，值得用一道判别题确认。",
      "evidence_trace": [
        { "role": "induction", "kind": "event", "id": "evt_attempt_a" },
        { "role": "probe", "kind": "question", "id": "q_probe_01" }
      ]
    },
    "prepared_action": {
      "kind": "answer_probe",
      "probe_question_id": "q_probe_01",
      "prompt_md": "求 d/dx sin(x²)，并标出每一层变化率。"
    },
    "current_outcome": {
      "status": "awaiting_answer",
      "summary_md": "判别题已备好；完成后再更新这条判断。"
    }
  }
}
```

### 6.3 `outcome_confirmed`

```json
{
  "brief": {
    "brief_id": "evt_conjecture_01",
    "state": "outcome_confirmed",
    "updated_at": "2026-07-19T02:05:00.000Z",
    "expires_at": "2026-07-26T02:05:00.000Z",
    "finding": {
      "claim_md": "你可能在复合层级增加时漏掉内层变化率。",
      "knowledge_id": "kn_chain_rule",
      "cause_category": "concept_misunderstanding"
    },
    "basis": {
      "summary_md": "这个模式在最近几次相关作答中重复出现，值得用一道判别题确认。",
      "evidence_trace": [
        { "role": "induction", "kind": "event", "id": "evt_attempt_a" },
        { "role": "probe", "kind": "question", "id": "q_probe_01" },
        { "role": "outcome", "kind": "event", "id": "evt_probe_result_01" }
      ]
    },
    "prepared_action": { "kind": "none" },
    "current_outcome": {
      "status": "confirmed",
      "summary_md": "这条判断得到这次探针的支持；下一步可以针对这个点练习。",
      "probe_question_id": "q_probe_01",
      "probe_result_event_id": "evt_probe_result_01"
    }
  }
}
```

### 6.4 `outcome_retired`

```json
{
  "brief": {
    "brief_id": "evt_conjecture_01",
    "state": "outcome_retired",
    "updated_at": "2026-07-19T02:05:00.000Z",
    "expires_at": "2026-07-26T02:05:00.000Z",
    "finding": {
      "claim_md": "你可能在复合层级增加时漏掉内层变化率。",
      "knowledge_id": "kn_chain_rule",
      "cause_category": "concept_misunderstanding"
    },
    "basis": {
      "summary_md": "这个模式在最近几次相关作答中重复出现，值得用一道判别题确认。",
      "evidence_trace": [
        { "role": "induction", "kind": "event", "id": "evt_attempt_a" },
        { "role": "probe", "kind": "question", "id": "q_probe_01" },
        { "role": "outcome", "kind": "event", "id": "evt_probe_result_02" }
      ]
    },
    "prepared_action": { "kind": "none" },
    "current_outcome": {
      "status": "retired",
      "summary_md": "这条判断被这次探针排除；继续原来的安排即可。",
      "probe_question_id": "q_probe_01",
      "probe_result_event_id": "evt_probe_result_02"
    }
  }
}
```

### 6.5 安静空态

```json
{ "brief": null }
```

UI 文案是「教研团暂无需要交付的新判断」。不显示「全部清空」、连续天数、待办数或成就
动效；安静夜是正常产品态。

`insufficient_evidence`、`degraded` 与 `error` **不进入** `TeachingBrief.state`：四态只描述一条
完整、可交付的 domain chain。P0F response 也不另加一个可被 UI 当 lifecycle 的 delivery-state
枚举。没有 eligible 完整候选（包括所有原始候选均因证据不足而 fail-closed）就是
`{brief:null}`；基础设施/查询失败走非 2xx error。这样 UI 只有「有一份可信交付 / 当前没有可信
交付 / 服务失败」三种诚实呈现，不把证据不足包装成第五种学习者结论。

## 7. 失败、损坏与诚实降级

| 情形 | reader 行为 | 用户面 |
|---|---|---|
| DB/查询失败 | route 返回标准非 2xx error；绝不伪装 `{brief:null}` | 「教研简报暂不可用」+ retry |
| 损坏 proposal payload | fail-closed 跳过，记录 proposal id + reason code；继续下一候选 | 若有下一候选则正常显示 |
| orphan/corrupt mind-probe question | 缺 proposal、proposal 非 accepted、`source`/`draft_status` 非 canonical、双 provenance 不一致、KC 或题面与 proposal 漂移时跳过并记录 | 不展示无依据或错配题目 |
| orphan/corrupt result | 缺 canonical question/proposal、回链不一致，或 `resolution/outcome` 不合法时跳过并记录 | 不展示伪结论 |
| accepted proposal 无 question | 跳过并记录 `accepted_without_probe` | 不声称 probe ready |
| 某 evidence 目标已归档/不可展开 | 保留 opaque ref；不伪造详情，也不渲染死链接 | 显示中性来源标签 |
| future plan/method seam 缺席 | 省略 optional key，退回核心 action | 不声称已重排/已选教学法 |
| accept/answer/ack 交互失败 | 保留当前 brief，不乐观转态；允许原位重试 | 清晰、非责备的 inline error |

可观测日志不得包含 claim、answer、图片 ref 或完整 payload；只记 candidate id、state/source 与
有限 reason code。孤儿跳过是数据完整性信号，不是让 UI 编造第五个 `degraded` lifecycle 状态的
理由。

## 8. Anti-guilt、隐私与可访问性

### 8.1 Anti-guilt wire lock

新 response 及 UI 均不得出现：

- `confidence`、`predicted_p`、`baseline_p_at_induction`、retrievability 或任何百分比；
- `recurrence_count`、pending/backlog/unread 数量、overnight run/proposal/conjecture 数量；
- 红点、逾期、`action required`、失败排名或「你又错了」；
- agent note、task run、内部 error、prompt、投票/争论或成本数据。

内部 salience 可以决定 finding 先后，但不得以字段、文案、ARIA label、analytics attribute 或
日志旁路泄漏。`evidence_trace` 是 provenance 列表，不得在 UI 汇总成「N 条证据」。

### 8.2 隐私与最小披露

- route 沿用标准 `/api/*` 内部 token/auth gate；不得新增公开读面。
- 简报只给 evidence 的 `kind/id`。原始作答、手写图片、reference answer 与 judge 细节留在各自
  SoT；需要展开时必须走已有授权读路径。没有授权 read path 就只显示中性来源标签。
- claim/reason/probe 均按不可信学习者/模型文本处理；若使用 Markdown renderer，必须走现有安全
  renderer，禁止注入 HTML、脚本或交互指令。
- analytics 只记录 brief id/state 与动作枚举，不记录正文、答案或 evidence payload。

### 8.3 可访问性

- 四块用可导航的 heading/region 语义；状态不能只靠 coral/green 等颜色表达。
- primary action 有明确 accessible name；finding 的接受文案必须表达「继续验证」，不能被读屏
  读成「确认弱点」。
- 同卡 `finding → probe_ready → outcome` 原位更新后，把焦点移到新状态 heading，并用
  `aria-live='polite'` 宣告一次；不得整页抢焦点或重复朗读 evidence。
- loading 用带可访问标签的 skeleton；error 与 retry 关联；键盘可完成接受/驳回、探针作答与
  结果 acknowledgement。未来若补上改写 affordance，也必须提供完整键盘路径。
- evidence ref 不可展开时渲染文本而非无效链接；图标始终有文本等价物。

## 9. YUK-505 / YUK-506 扩展缝

当前 P0F wire 与 strict schema **不包含**规划脑或教学法脑字段。未来 YUK-505/YUK-506 有真实
SoT 和可执行链路后，只能通过一次显式 contract revision，把 `plan_impact?` / `method_choice?`
加到 `prepared_action` 内；不得增加第五/第六个顶层内容块，也不得仅扩 TypeScript 而漏改 Zod：

- **YUK-505 plan impact**：未来可说明「加/减/保持什么、为什么」，但必须有独立 SoT、
  evidence trace 与用户可改提案语义。P0F 不生成、不推断，也不因为字段缺席显示「规划失败」。
- **YUK-506 method choice**：未来可说明选择 worked example、对照案例、检索等方法及证据；
  不能从 learning style 画像推断。P0F 不选择方法，不把普通 KC-scoped practice 冒充「已按教学法
  设计」。
- 扩展内容同样受 no-probability、privacy、a11y 与 evidence-first 约束；没有可追溯证据就省略。

YUK-709 可以在 confirmed 结果上复用 canonical `knowledge_id` 接现有 KC-scoped practice，但那是
用户点击后的 on-demand action，不代表已自动重排 daily stream，也不等于 YUK-505/506 已实现。

## 10. 明确不做

- 不新增 business table、migration、materialized lifecycle 字段或缓存真相源。
- 不写 proposal/question/result 的派生状态；ack 也只能 append-only。
- 不写或重算 FSRS、`mastery_state`、θ̂、item calibration、misconception 晋升语义。
- 不自动生成练习、不往 daily stream 塞题、不把 accept 解释成 enroll review。
- 不新增 agent、头像、多人聊天、dashboard、计数 chip 或通知 push。
- 不改变现有 `/api/prep-desk/conjectures`、`/api/prep-desk/probes` 与
  `/api/conjecture/probe/[id]/answer` 的 canonical ownership；新 reader 只聚合。

## 11. P0F/2 实现验收清单

- [ ] `GET /api/prep-desk/brief` 严格返回 `{brief: TeachingBrief|null}`。
- [ ] 四个判别分支及同形 Zod schema 均有 DB test。
- [ ] outcome > probe > finding 的确定性顺序及所有 tie-break 有测试。
- [ ] TTL 边界（到期前、恰好到期）与 quiet null 有测试。
- [ ] proposal → question → result 的 evidence trace 完整且顺序稳定。
- [ ] evidence ref 是 role/kind 成对判别联合；`cause_category` 复用 canonical schema。
- [ ] question 的 `source`、`draft_status`、双 provenance、KC 与题面逐项校验；任一漂移均
  fail-closed。
- [ ] orphan/corrupt/accepted-without-probe fail-closed 并留下不含正文的日志。
- [ ] strict response schema 拒绝未来 action 与 plan/method section，直到对应 contract revision。
- [ ] response 深度断言不存在 calibration probability、recurrence/backlog/unread count。
- [ ] reader 零 INSERT/UPDATE/DELETE；不 import FSRS/mastery/θ̂ writer。
- [ ] route failure 与 quiet null 可区分；不把异常吞成安静夜。
