import type { HistoricalUnknownSubmissionT, PendingStateT } from '../schema/assessment';
import { AttemptQuestionSnapshot } from '../schema/question-evidence-snapshot';
import type {
  DeferredReplayEntry,
  MigrationCapture,
  MigrationClassification,
  RecordClassification,
} from './types';

// ====================================================================
// YUK-1048 — native 分类器（grounding §13；review P1-3/4/5/7 修订）
// ====================================================================
//
// 纯函数、确定性、无 LLM。输入是 capture 的 rawFacts（可从工件离线重放）。
//
// ── occurrence 与 effective head（P1-4）──────────────────────────────
// 「一次作答」的锚（anchor）= attempt 事件 或 携带作答的 review 事件
// （review-settlement 的 durable 回填/solo review submit 都把 user_response_md
// + embedded judge 写进 review 事件本体）。correct 闭包按 anchor 级传播：
// 纠正锚 ⇒ 该锚的全部 judge 评估都不可再声明 effective head；纠正 judge ⇒ 其
// 锚也入闭包。多 verdict 只按 legacy newest-judge-wins（practice-read 的读
// 语义）选至多一个 head，其余保留为 imported evaluation（not_selected）；
// created_at 并列 ⇒ 无法可辩护选头 ⇒ ambiguous_held（anchor pending）。
//
// ── snapshot/verdict 完整性（P1-5）──────────────────────────────────
// issued snapshot 必须是【被识别的冻结形状】：
//   - attempt/solve_tutor 事件：AttemptQuestionSnapshot（question-evidence-snapshot.ts）
//   - durable pending 输入：FrozenQuestionSnapshot 结构（practice 侧
//     judge-run-payload.ts 的 schema；core 不得 import capability，此处做
//     结构等价校验并在注释中声明接缝）。
// 形状不识别 ⇒ historical_unresolved —— 绝不用当前 revision 补造。
// verdict = coarse_outcome/score（judge_route 只说明跑了哪条 runner，不是判词）。
//
// ── review 双形态（P1-3）────────────────────────────────────────────
// review-settlement.ts:534–565 的 review 事件可能携带完整作答与判分：
//   - rating-only（无 user_response_md/answer_image_refs/judge 块）⇒ FSRS 评级
//     provenance（D15），不是 submission。
//   - answer-bearing：durable（pending.run_id=review.id 且 pending 携带冻结
//     snapshot）⇒ 完整链可导入；durable 缺 snapshot（pre-snapshot payload 判的
//     是当前行）或 solo review（判的是 live 行，无冻结 issuance）⇒
//     historical_unresolved —— 证据保留，不补造。answer-bearing 无判词 ⇒
//     自评作答（manual provenance only，D9/D15）。
//
// ── 因果/证据闭包（P1-7）────────────────────────────────────────────
// capture 捕获全部 event 分区；attempt/judge/review/correct/评估态事件之外的
// 事件是闭包引用（caused_by、kc_typed evidence_event_ids 等）⇒
// causal_closure_lineage（只作引用世系，不产生 submission/evaluation 语义）。

// durable judge 队列名（practice 侧 boss.send('judge_run') 的字面量；core 不得
// import capability，故本地声明并在 db 测试中与 producer 断言对齐）。
const JUDGE_RUN_QUEUE_NAME = 'judge_run';

/** 分类器有显式规则的 action（其余被捕获事件 → causal_closure_lineage）。 */
const RULE_COVERED_ACTIONS = new Set([
  'attempt',
  'judge',
  'review',
  'correct',
  'experimental:judge_pending_attempt',
  'experimental:grading_checkpoint',
  'experimental:state_snapshot',
  'experimental:reproject_deferred',
]);

/**
 * 历史事件 payload 是松散 jsonb：只做安全取键/等值比较，不做形状假设。
 * 值一律 unknown —— 分类器只读 marker（存在性/字面量等值），不消费内容。
 */
interface EventPayload {
  [key: string]: unknown;
}

function payloadOf(payload: unknown): EventPayload {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as EventPayload)
    : {};
}

/** verdict = 判词（coarse_outcome/score）。judge_route 不是 verdict（P1-5）。 */
function hasRealVerdict(payload: EventPayload): boolean {
  return payload.coarse_outcome != null || payload.score != null;
}

function isAttributionPlaceholder(payload: EventPayload): boolean {
  return payload.attribution_pending === true;
}

/** attempt/solve_tutor 事件的冻结 issued snapshot（AttemptQuestionSnapshot 形状）。 */
function attemptSnapshotIssue(payload: EventPayload): { ok: boolean; reason: string } {
  const snapshot = payload.question_snapshot;
  if (snapshot == null) {
    return { ok: false, reason: 'attempt payload 无 question_snapshot —— 缺 issued snapshot' };
  }
  const parsed = AttemptQuestionSnapshot.safeParse(snapshot);
  if (!parsed.success) {
    return {
      ok: false,
      reason:
        'question_snapshot 不符合 AttemptQuestionSnapshot 冻结契约（question-evidence-snapshot.ts）—— 形状不识别，不能用当前 revision 补造当时所见',
    };
  }
  return { ok: true, reason: '' };
}

/**
 * durable pending 输入的冻结 snapshot 结构校验（接缝声明：生产 schema 是
 * practice 侧 FrozenQuestionSnapshotSchema —— kind/prompt_md/.../version/
 * updated_at；core 不得 import capability，这里做结构等价校验：非空对象 +
 * string kind + string prompt_md + number version + string updated_at）。
 */
function durableSnapshotIssue(payload: EventPayload): { ok: boolean; reason: string } {
  const snapshot = payloadOf(payload.submit).question_snapshot;
  if (snapshot == null) {
    return {
      ok: false,
      reason:
        'durable pending 输入无冻结 question_snapshot（pre-snapshot payload —— worker 曾按【当前】题行判分，judge-run-payload legacy 读活行路径）—— 无法重构当时 issuance',
    };
  }
  const s = payloadOf(snapshot);
  if (
    typeof s.kind !== 'string' ||
    s.kind.length === 0 ||
    typeof s.prompt_md !== 'string' ||
    typeof s.version !== 'number' ||
    typeof s.updated_at !== 'string'
  ) {
    return {
      ok: false,
      reason: 'durable 冻结 snapshot 不符合 FrozenQuestionSnapshot 结构（接缝校验失败）',
    };
  }
  return { ok: true, reason: '' };
}

function locatorOf(sourceKind: 'event' | 'answer', action: string | null, id: string): string {
  return action === null ? `${sourceKind}:${id}` : `${sourceKind}:${action}:${id}`;
}

/** review 事件是否携带作答（user_response_md / 图片 / embedded judge 块）。 */
function reviewIsAnswerBearing(payload: EventPayload): boolean {
  const judge = payload.judge;
  return (
    payload.user_response_md != null ||
    (Array.isArray(payload.answer_image_refs) && payload.answer_image_refs.length > 0) ||
    (judge !== null && typeof judge === 'object' && !Array.isArray(judge))
  );
}

/** review 的 embedded judge 块是否携带 verdict。 */
function reviewEmbeddedVerdict(payload: EventPayload): boolean {
  const judge = payloadOf(payload.judge);
  return judge.coarse_outcome != null || judge.score != null;
}

/** solve_tutor attempt 的嵌入判分是否携带 verdict（judge_score/judge.coarse_outcome）。 */
function solveTutorEmbeddedVerdict(payload: EventPayload): boolean {
  const judge = payloadOf(payload.judge);
  return payload.judge_score != null || judge.coarse_outcome != null;
}

interface HeadDecision {
  headJudgeId: string | null;
  rule: 'sole_verdict' | 'legacy_newest_judge' | 'not_selected' | 'ambiguous_held';
  ambiguous: boolean;
}

/**
 * 一次 anchor 的 effective head 选择（P1-4）：eligible = 未入纠正闭包的
 * verdict judge。>1 时按 legacy newest-judge-wins（created_at 最新；读语义同
 * practice-read.ts:269–308 的 newest-judge）选头；created_at 并列 ⇒ 无法辩护
 * ⇒ ambiguous_held（全部不选，anchor 侧 pending）。
 */
function selectHead(
  eligibleJudges: ReadonlyArray<{ id: string; created_at: string }>,
): HeadDecision {
  if (eligibleJudges.length === 0) {
    return { headJudgeId: null, rule: 'not_selected', ambiguous: false };
  }
  if (eligibleJudges.length === 1) {
    return { headJudgeId: eligibleJudges[0].id, rule: 'sole_verdict', ambiguous: false };
  }
  const sorted = [...eligibleJudges].sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1,
  );
  const newest = sorted[0];
  const tied = sorted.filter((j) => j.created_at === newest.created_at);
  if (tied.length > 1) {
    return { headJudgeId: null, rule: 'ambiguous_held', ambiguous: true };
  }
  return { headJudgeId: newest.id, rule: 'legacy_newest_judge', ambiguous: false };
}

/** classification 主入口：capture.rawFacts → 确定性分类 + 工作清单 + unresolved。 */
export function classifyMigrationCapture(capture: MigrationCapture): MigrationClassification {
  const facts = capture.rawFacts;
  const events = facts.events;

  const eventById = new Map(events.map((e) => [e.id, e]));

  // judges 按 anchor（subject 事件 id）索引 —— anchor 可以是 attempt 或 review。
  const judgesByAnchor = new Map<string, typeof events>();
  for (const e of events) {
    if (e.action === 'judge' && e.subject_kind === 'event') {
      const list = judgesByAnchor.get(e.subject_id) ?? [];
      list.push(e);
      judgesByAnchor.set(e.subject_id, list);
    }
  }

  const mirrorByAttempt = new Map<string, (typeof facts.learning_record_mirrors)[number]>();
  for (const m of facts.learning_record_mirrors) {
    if (m.attempt_event_id !== null && !mirrorByAttempt.has(m.attempt_event_id)) {
      mirrorByAttempt.set(m.attempt_event_id, m);
    }
  }
  const answersByEventId = new Map<string, string[]>();
  for (const a of facts.answers) {
    if (a.event_id !== null) {
      const list = answersByEventId.get(a.event_id) ?? [];
      list.push(a.id);
      answersByEventId.set(a.event_id, list);
    }
  }

  // durable pending：run_id → pending 事件（review.id = run_id 即 backfill 锚）。
  const pendingByRunId = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    if (e.action === 'experimental:judge_pending_attempt') {
      const runId = payloadOf(e.payload).run_id;
      if (typeof runId === 'string' && !pendingByRunId.has(runId)) {
        pendingByRunId.set(runId, e);
      }
    }
  }
  const unbackfilledRunIds = new Set<string>();
  for (const e of events) {
    if (e.action === 'experimental:judge_pending_attempt') {
      const runId = payloadOf(e.payload).run_id;
      if (typeof runId === 'string' && !eventById.has(runId)) {
        unbackfilledRunIds.add(runId);
      }
    }
  }
  const judgeRunQueues = capture.queues.filter(
    (q) => q.name === JUDGE_RUN_QUEUE_NAME && q.state !== 'completed',
  );

  // ---- 纠正闭包（fixpoint，P1-4 传播）----
  // 种子：correct 的 target + replacement。传播：成员 anchor 的全部 judge；
  // 成员 judge 的 anchor；成员 judge 的 caused_by 链上的 judge（replacement 之外
  // 不再外扩 —— 语义上只沿「同一 occurrence 的评估」与「纠正关系」传播）。
  const members = new Set<string>();
  for (const e of events) {
    if (e.action !== 'correct' || e.subject_kind !== 'event') continue;
    members.add(e.subject_id);
    members.add(e.id);
    const replacement = payloadOf(e.payload).replacement_event_id;
    if (typeof replacement === 'string') members.add(replacement);
  }
  // fixpoint：anchor↔judge 双向传播。
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of events) {
      if (e.action !== 'judge' || e.subject_kind !== 'event') continue;
      const anchorIn = members.has(e.subject_id);
      const judgeIn = members.has(e.id);
      if (anchorIn && !judgeIn) {
        members.add(e.id);
        changed = true;
      } else if (judgeIn && !anchorIn) {
        members.add(e.subject_id);
        changed = true;
      }
    }
  }

  // ---- 逐 anchor 分类（attempt / answer-bearing review）----
  const records: RecordClassification[] = [];
  const deferredReplay: DeferredReplayEntry[] = [];
  const anchorClassifications = new Map<string, RecordClassification>();
  // anchor → head 决策（供 judge 事件引用，保证一致性）。
  const headDecisions = new Map<string, HeadDecision>();
  // 纠正闭包成员 anchor 的 reason 复用。
  const correctionClosureReason =
    '纠正链闭包成员（correct target/replacement，或其 anchor↔judge 传播）—— effective-truth 未物化，保持 unresolved';

  const historicalUnknownClassification = (
    sourceId: string,
    locator: string,
    reason: string,
    evidence: string[],
    sourceKind: 'event' | 'answer',
    sourceKindName: string,
  ): RecordClassification => {
    const record: HistoricalUnknownSubmissionT = {
      record_kind: 'historical_unknown',
      source_kind: sourceKindName,
      source_id: sourceId,
      source_locator: locator,
      note: reason,
    };
    return {
      category: 'historical_unresolved',
      source_kind: sourceKind,
      source_id: sourceId,
      source_locator: locator,
      reason,
      evidence_event_ids: evidence,
      native_target: { kind: 'historical_unknown', record },
    };
  };

  /** 通用：anchor（attempt/review）被纠正 ⇒ unresolved + deferred replay。 */
  const correctionMemberClassification = (
    anchor: (typeof events)[number],
    affectedSubjects: string[],
  ): RecordClassification => {
    deferredReplay.push({
      source_kind: 'correction_cycle',
      source_id: anchor.id,
      affected_subject_ids: affectedSubjects,
      reason:
        '记录处于 correction 闭包内 —— effective-truth 链未物化，保持 unresolved，replay 延后（§10/§13）',
    });
    return {
      category: 'correction_cycle_unresolved',
      source_kind: 'event',
      source_id: anchor.id,
      source_locator: locatorOf('event', anchor.action, anchor.id),
      reason: correctionClosureReason,
      evidence_event_ids: [anchor.id],
      native_target: { kind: 'unresolved_correction_cycle' },
    };
  };

  /** verdict judge 集合（排除纠正闭包成员）→ head 决策（缓存 per anchor）。 */
  const headDecisionFor = (anchor: (typeof events)[number]): HeadDecision => {
    const cached = headDecisions.get(anchor.id);
    if (cached) return cached;
    const judges = judgesByAnchor.get(anchor.id) ?? [];
    const eligible = judges
      .filter((j) => !members.has(j.id) && hasRealVerdict(payloadOf(j.payload)))
      .map((j) => ({ id: j.id, created_at: j.created_at }));
    const decision = selectHead(eligible);
    headDecisions.set(anchor.id, decision);
    return decision;
  };

  // —— attempt 分类 ——
  const classifyAttempt = (attempt: (typeof events)[number]): RecordClassification => {
    const payload = payloadOf(attempt.payload);
    const locator = locatorOf('event', attempt.action, attempt.id);
    const linkedAnswerIds = answersByEventId.get(attempt.id) ?? [];

    if (members.has(attempt.id)) {
      return correctionMemberClassification(attempt, [
        attempt.subject_id,
        ...(Array.isArray(payload.referenced_knowledge_ids)
          ? (payload.referenced_knowledge_ids as string[])
          : []),
      ]);
    }

    const snapshotIssue = attemptSnapshotIssue(payload);
    if (!snapshotIssue.ok) {
      return historicalUnknownClassification(
        attempt.id,
        locator,
        `${snapshotIssue.reason}（§3.2/§13 —— 不用当前 revision 补造当时所见）`,
        [attempt.id, ...linkedAnswerIds],
        'event',
        'event',
      );
    }

    if (payload.unsupported_judge === true) {
      const pending: PendingStateT = {
        reason: 'unjudgeable',
        detail:
          '答案已冻结但该槽位未判（unsupported_judge；照片作答落入纯文本判分路线）—— 不是错答，不得伪零分',
      };
      return {
        category: 'pending_blocked',
        source_kind: 'event',
        source_id: attempt.id,
        source_locator: locator,
        reason: 'unsupported_judge=true：已接收未判分',
        evidence_event_ids: [attempt.id, ...linkedAnswerIds],
        native_target: { kind: 'pending_carried', pending },
      };
    }

    if (payload.source === 'solve_tutor') {
      if (solveTutorEmbeddedVerdict(payload)) {
        return {
          category: 'embedded_tutor_grade',
          source_kind: 'event',
          source_id: attempt.id,
          source_locator: locator,
          reason:
            'solve_tutor attempt 嵌入判分（judge_score/judge.coarse_outcome 在 payload 内，无独立 judge 事件）',
          evidence_event_ids: [attempt.id],
          native_target: { kind: 'submission_with_embedded_eval', provenance: 'embedded_tutor' },
        };
      }
      const pending: PendingStateT = {
        reason: 'needs_review',
        trigger: 'flagged',
        detail:
          'solve_tutor attempt 声明嵌入判分但无 verdict（judge_score/judge.coarse_outcome 均缺）—— 判分证据不完整，blocked 不猜',
      };
      return {
        category: 'pending_blocked',
        source_kind: 'event',
        source_id: attempt.id,
        source_locator: locator,
        reason: 'solve_tutor 嵌入判分缺 verdict',
        evidence_event_ids: [attempt.id, ...linkedAnswerIds],
        native_target: { kind: 'pending_carried', pending },
      };
    }

    const decision = headDecisionFor(attempt);
    if (decision.ambiguous) {
      const pending: PendingStateT = {
        reason: 'needs_review',
        trigger: 'flagged',
        detail:
          '多个 verdict judge 的 created_at 并列 —— 无法按 legacy newest-judge-wins 辩护选头，ambiguous held（P1-4）',
      };
      return {
        category: 'pending_blocked',
        source_kind: 'event',
        source_id: attempt.id,
        source_locator: locator,
        reason: 'verdict judge 并列，effective head 不可判定',
        evidence_event_ids: [attempt.id, ...linkedAnswerIds],
        native_target: { kind: 'pending_carried', pending },
      };
    }
    if (decision.headJudgeId !== null) {
      return {
        category: 'complete_attempt',
        source_kind: 'event',
        source_id: attempt.id,
        source_locator: locator,
        reason: `attempt 带已识别 issued snapshot，且 judge 事件 ${decision.headJudgeId} 携带真实 verdict（${decision.rule}）—— 迁移为 submission + imported eval/head`,
        evidence_event_ids: [attempt.id, decision.headJudgeId, ...linkedAnswerIds],
        native_target: {
          kind: 'submission_with_imported_eval',
          judge_event_id: decision.headJudgeId,
          has_effective_head: true,
          head_selection: decision.rule,
        },
      };
    }

    const judges = judgesByAnchor.get(attempt.id) ?? [];
    const placeholderJudge = judges.find((j) => isAttributionPlaceholder(payloadOf(j.payload)));
    if (placeholderJudge != null) {
      const pending: PendingStateT = {
        reason: 'needs_review',
        trigger: 'flagged',
        detail: 'judge 占位（attribution_pending）且无 verdict —— 归因未完成，评估缺件 blocked',
      };
      return {
        category: 'pending_blocked',
        source_kind: 'event',
        source_id: attempt.id,
        source_locator: locator,
        reason: `仅有无 verdict 的 attribution 占位 judge（${placeholderJudge.id}）`,
        evidence_event_ids: [attempt.id, placeholderJudge.id],
        native_target: { kind: 'pending_carried', pending },
      };
    }

    const mirror = mirrorByAttempt.get(attempt.id);
    if (mirror != null || payload.generated_by != null) {
      const assertion: 'human' | 'import' =
        mirror == null ? 'import' : mirror.source === 'manual' ? 'human' : 'import';
      return {
        category: 'human_import_assertion',
        source_kind: 'event',
        source_id: attempt.id,
        source_locator: locator,
        reason:
          mirror != null
            ? `outcome 来自人工/导入断言（learning_record ${mirror.id}，source=${mirror.source}）—— 无判分证据，诚实标注`
            : 'outcome 来自导入路径断言（payload.generated_by）—— 无判分证据，诚实标注',
        evidence_event_ids: [attempt.id, ...linkedAnswerIds],
        native_target: { kind: 'manual_provenance_only', assertion },
      };
    }

    const pending: PendingStateT = {
      reason: 'needs_review',
      trigger: 'flagged',
      detail:
        'outcome 存在但既无 judge 证据也无人工/导入断言标记 —— 判分 provenance 未知，缺件 blocked，不猜',
    };
    return {
      category: 'pending_blocked',
      source_kind: 'event',
      source_id: attempt.id,
      source_locator: locator,
      reason: '判分证据缺失且无断言标记',
      evidence_event_ids: [attempt.id, ...linkedAnswerIds],
      native_target: { kind: 'pending_carried', pending },
    };
  };

  // —— review 分类（P1-3）——
  const classifyReview = (review: (typeof events)[number]): RecordClassification => {
    const payload = payloadOf(review.payload);
    const locator = locatorOf('event', review.action, review.id);

    if (members.has(review.id)) {
      return correctionMemberClassification(review, [review.subject_id]);
    }

    if (!reviewIsAnswerBearing(payload)) {
      return {
        category: 'fsrs_review_lineage',
        source_kind: 'event',
        source_id: review.id,
        source_locator: locator,
        reason: 'rating-only FSRS review —— 用户评级 provenance（D15），不是 submission',
        evidence_event_ids: [review.id],
        native_target: { kind: 'lineage_only' },
      };
    }

    // answer-bearing：issued snapshot 只可能来自 durable pending 输入。
    const pending = pendingByRunId.get(review.id);
    if (pending === undefined) {
      return historicalUnknownClassification(
        review.id,
        locator,
        'answer-bearing review 无 durable pending 锚（solo review submit 按判分时【live】题行判分，无冻结 issuance）—— 不能用当前 revision 补造当时所见（§13）',
        [review.id],
        'event',
        'event',
      );
    }
    const snapshotIssue = durableSnapshotIssue(payloadOf(pending.payload));
    if (!snapshotIssue.ok) {
      return historicalUnknownClassification(
        review.id,
        locator,
        `${snapshotIssue.reason}（§13）`,
        [review.id, pending.id],
        'event',
        'event',
      );
    }

    // durable 完整链：verdict 来自 embedded judge 块和/或配对 judge 事件。
    const decision = headDecisionFor(review);
    const embeddedVerdict = reviewEmbeddedVerdict(payload);
    if (!embeddedVerdict && decision.headJudgeId === null && !decision.ambiguous) {
      // 作答已接收、自评（无判词）—— D9/D15：manual provenance only。
      return {
        category: 'human_import_assertion',
        source_kind: 'event',
        source_id: review.id,
        source_locator: locator,
        reason:
          'durable 回填 review 携带作答但无判词（embedded judge 块与配对 judge 均无 verdict）—— 自评作答，仅手动学习效应（D9/D15）',
        evidence_event_ids: [review.id, pending.id],
        native_target: { kind: 'manual_provenance_only', assertion: 'human' },
      };
    }
    if (decision.ambiguous) {
      const pendingState: PendingStateT = {
        reason: 'needs_review',
        trigger: 'flagged',
        detail: '配对 verdict judge 的 created_at 并列 —— head 不可判定，ambiguous held（P1-4）',
      };
      return {
        category: 'pending_blocked',
        source_kind: 'event',
        source_id: review.id,
        source_locator: locator,
        reason: 'durable review 的 verdict judge 并列，effective head 不可判定',
        evidence_event_ids: [review.id, pending.id],
        native_target: { kind: 'pending_carried', pending: pendingState },
      };
    }
    const headJudgeId = decision.headJudgeId; // embedded-only 时为 null，head_selection 为 sole_verdict/not_selected
    return {
      category: 'complete_attempt',
      source_kind: 'event',
      source_id: review.id,
      source_locator: locator,
      reason:
        headJudgeId !== null
          ? `durable 回填 review：冻结输入（pending ${pending.id} 的 submit.question_snapshot）+ 作答 + verdict（配对 judge ${headJudgeId}${embeddedVerdict ? ' 与 embedded judge 块' : ''}）—— submission + imported eval/head`
          : `durable 回填 review：冻结输入（pending ${pending.id}）+ 作答 + embedded judge 块 verdict —— submission + imported eval/head`,
      evidence_event_ids: [review.id, pending.id, ...(headJudgeId !== null ? [headJudgeId] : [])],
      native_target: {
        kind: 'submission_with_imported_eval',
        judge_event_id: headJudgeId,
        has_effective_head: true,
        head_selection: headJudgeId !== null ? decision.rule : 'sole_verdict',
      },
    };
  };

  for (const e of events) {
    if (e.action === 'attempt' && e.subject_kind === 'question') {
      anchorClassifications.set(e.id, classifyAttempt(e));
    } else if (e.action === 'review' && e.subject_kind === 'question') {
      anchorClassifications.set(e.id, classifyReview(e));
    }
  }

  // ---- 其余事件分类 ----
  for (const e of events) {
    const anchorClassification = anchorClassifications.get(e.id);
    if (anchorClassification !== undefined) continue;
    const locator = locatorOf('event', e.action, e.id);

    if (e.action === 'judge' && e.subject_kind === 'event') {
      if (members.has(e.id)) {
        records.push({
          category: 'correction_cycle_unresolved',
          source_kind: 'event',
          source_id: e.id,
          source_locator: locator,
          reason: correctionClosureReason,
          evidence_event_ids: [e.id],
          native_target: { kind: 'unresolved_correction_cycle' },
        });
        continue;
      }
      const target = eventById.get(e.subject_id);
      const targetIsAnchor =
        target != null &&
        (target.action === 'attempt' || target.action === 'review') &&
        target.subject_kind === 'question';
      if (target == null || !targetIsAnchor || anchorClassifications.get(target.id) === undefined) {
        records.push(
          historicalUnknownClassification(
            e.id,
            locator,
            target == null
              ? `judge 事件的目标事件（${e.subject_id}）不存在 —— 孤儿判分记录，无 submission 可挂`
              : !targetIsAnchor
                ? `judge 事件的目标（${e.subject_id}，action=${target.action}）不是作答锚（attempt/review）—— 无 submission 可挂`
                : 'judge 事件的目标锚未被分类（内部不一致）',
            [e.id],
            'event',
            'event',
          ),
        );
        continue;
      }
      const targetClassification = anchorClassifications.get(target.id);
      if (
        targetClassification != null &&
        (targetClassification.category === 'historical_unresolved' ||
          targetClassification.category === 'correction_cycle_unresolved')
      ) {
        // 目标锚不可导入 ⇒ judge 证据一并不可导入（镜像类别，独立 locator/record）。
        records.push(
          targetClassification.category === 'historical_unresolved'
            ? historicalUnknownClassification(
                e.id,
                locator,
                `目标锚（${target.id}）缺可用 issued snapshot —— judge 证据随之不可导入`,
                [e.id, target.id],
                'event',
                'event',
              )
            : {
                category: 'correction_cycle_unresolved',
                source_kind: 'event',
                source_id: e.id,
                source_locator: locator,
                reason: `目标锚（${target.id}）处于纠正闭包 —— judge 证据随之不可导入`,
                evidence_event_ids: [e.id, target.id],
                native_target: { kind: 'unresolved_correction_cycle' },
              },
        );
        continue;
      }
      const payload = payloadOf(e.payload);
      if (hasRealVerdict(payload)) {
        // verdict judge：是否 effective head 取决于锚的 head 决策（P1-4 一致性）。
        // verdict 优先于 attribution_pending 标记（review-settlement 的配对
        // review_judge 事件带真实 coarse_outcome/score + attribution_pending——
        // 分数是真实的，只是失败归因延后）。
        const decision = headDecisionFor(target);
        const isHead = decision.headJudgeId === e.id;
        records.push({
          category: 'complete_attempt',
          source_kind: 'event',
          source_id: e.id,
          source_locator: locator,
          reason: isHead
            ? `真实 verdict judge —— ${target.id} 的 effective imported evaluation（${decision.rule}${isAttributionPlaceholder(payload) ? '；attribution_pending：归因未完成，分数真实' : ''}）`
            : `真实 verdict judge —— ${target.id} 的 imported evaluation 证据（非 head：${decision.ambiguous ? '并列 held' : 'legacy newest-judge-wins 未选中'}）`,
          evidence_event_ids: [e.id, target.id],
          native_target: {
            kind: 'submission_with_imported_eval',
            judge_event_id: e.id,
            has_effective_head: isHead,
            head_selection: isHead
              ? decision.rule
              : decision.ambiguous
                ? 'ambiguous_held'
                : 'not_selected',
          },
        });
        continue;
      }
      if (isAttributionPlaceholder(payload)) {
        records.push({
          category: 'attribution_pending_placeholder',
          source_kind: 'event',
          source_id: e.id,
          source_locator: locator,
          reason: 'attribution_pending 占位 judge（无 verdict）—— 保留为证据，无分数语义',
          evidence_event_ids: [e.id, target.id],
          native_target: { kind: 'attribution_evidence_only' },
        });
        continue;
      }
      records.push({
        category: 'attribution_only',
        source_kind: 'event',
        source_id: e.id,
        source_locator: locator,
        reason: 'judge 事件仅含 cause（无 coarse_outcome/score）—— 归因不是分数（§9）',
        evidence_event_ids: [e.id, target.id],
        native_target: { kind: 'attribution_evidence_only' },
      });
      continue;
    }

    if (e.action === 'experimental:judge_pending_attempt') {
      const runId = payloadOf(e.payload).run_id;
      if (typeof runId === 'string' && unbackfilledRunIds.has(runId)) {
        const queueNote =
          judgeRunQueues.length > 0
            ? `；judge_run 队列观测：${judgeRunQueues.map((q) => `${q.state}=${q.count}`).join(', ')}`
            : '；pgboss schema 不存在或 judge_run 队列为空';
        const pending: PendingStateT = {
          reason: 'infra_failure',
          retryable: true,
          detail: `durable judge run ${runId} 未 backfill（无 event.id=run_id 的 review 事件）${queueNote} —— 保留 run/request/pending 身份与 payload.submit 冻结输入`,
        };
        records.push({
          category: 'pending_blocked',
          source_kind: 'event',
          source_id: e.id,
          source_locator: locator,
          reason: `judge_pending_attempt 未 backfill（run_id=${runId}）`,
          evidence_event_ids: [e.id],
          native_target: { kind: 'pending_carried', pending },
        });
      } else {
        const backfill = typeof runId === 'string' ? eventById.get(runId) : undefined;
        records.push({
          category: 'pending_resolved_lineage',
          source_kind: 'event',
          source_id: e.id,
          source_locator: locator,
          reason: `judge_pending_attempt 已 backfill（run_id=${String(runId)} 存在对应 review 事件${backfill !== undefined ? '' : '（run_id 缺失 —— 形态异常，仅世系保留）'}）—— 冻结输入由 backfill review 的分类承接`,
          evidence_event_ids: [e.id, ...(backfill !== undefined ? [backfill.id] : [])],
          native_target: { kind: 'lineage_only' },
        });
      }
      continue;
    }

    if (e.action === 'experimental:reproject_deferred') {
      deferredReplay.push({
        source_kind: 'reproject_deferred_marker',
        source_id: e.id,
        affected_subject_ids: [e.subject_id],
        reason: 'reproject_deferred 标记 —— rejudge 侧未完成的 reproject 义务（§10）',
      });
    }

    if (
      e.action === 'experimental:grading_checkpoint' ||
      e.action === 'experimental:state_snapshot' ||
      e.action === 'experimental:reproject_deferred'
    ) {
      records.push({
        category: 'state_snapshot_lineage',
        source_kind: 'event',
        source_id: e.id,
        source_locator: locator,
        reason: '状态快照/检查点/挂起标记 —— revert bracket 世系，不是作答记录',
        evidence_event_ids: [e.id],
        native_target: { kind: 'lineage_only' },
      });
      continue;
    }

    if (e.action === 'correct') {
      records.push({
        category: 'correction_cycle_unresolved',
        source_kind: 'event',
        source_id: e.id,
        source_locator: locator,
        reason: 'correct 事件 —— 纠正链成员，保持 unresolved',
        evidence_event_ids: [e.id],
        native_target: { kind: 'unresolved_correction_cycle' },
      });
      continue;
    }

    if (!RULE_COVERED_ACTIONS.has(e.action)) {
      // P1-7：完整 event 分区捕获带进了非评估事件（caused_by / evidence_event_ids
      // 等闭包引用）—— 只作引用世系，不产生 submission/evaluation 语义。
      records.push({
        category: 'causal_closure_lineage',
        source_kind: 'event',
        source_id: e.id,
        source_locator: locator,
        reason: `非评估事件（action=${e.action}）—— 因 evidence/causal 闭包被捕获，只作引用世系`,
        evidence_event_ids: [e.id],
        native_target: { kind: 'lineage_only' },
      });
      continue;
    }

    // rule-covered 但无分支 —— reader/分类器脱同步，fail-visible。
    records.push(
      historicalUnknownClassification(
        e.id,
        locator,
        `captured action '${e.action}' 无分类规则 —— reader/分类器脱同步`,
        [e.id],
        'event',
        'event',
      ),
    );
  }

  // ---- answer 分类 ----
  for (const a of facts.answers) {
    const locator = locatorOf('answer', null, a.id);
    if (a.submitted_at == null) {
      records.push({
        category: 'live_draft',
        source_kind: 'answer',
        source_id: a.id,
        source_locator: locator,
        reason: 'answer 行 submitted_at IS NULL —— live draft，精确保存，不补造 submission',
        evidence_event_ids: [],
        native_target: { kind: 'draft_preserved' },
      });
      continue;
    }
    const linked = a.event_id !== null ? eventById.get(a.event_id) : undefined;
    if (linked == null) {
      records.push(
        historicalUnknownClassification(
          a.id,
          locator,
          'frozen answer 的 event_id 缺失或目标事件不存在 —— 无 attempt/review 锚点',
          [],
          'answer',
          'answer',
        ),
      );
      continue;
    }
    const anchorClassification = anchorClassifications.get(linked.id);
    if (linked.action === 'attempt' || linked.action === 'review') {
      if (anchorClassification == null) {
        records.push(
          historicalUnknownClassification(
            a.id,
            locator,
            `frozen answer 指向的锚 ${linked.id} 未被分类`,
            [linked.id],
            'answer',
            'answer',
          ),
        );
        continue;
      }
      records.push({
        category: anchorClassification.category,
        source_kind: 'answer',
        source_id: a.id,
        source_locator: locator,
        reason: `frozen answer 镜像其锚 ${linked.id}（action=${linked.action}）的分类（${anchorClassification.reason}）`,
        evidence_event_ids: [linked.id],
        native_target: anchorClassification.native_target,
      });
      continue;
    }
    // 非锚事件 —— 世系。
    records.push({
      category: 'state_snapshot_lineage',
      source_kind: 'answer',
      source_id: a.id,
      source_locator: locator,
      reason: `frozen answer 锚定到非作答事件（action=${linked.action}）—— 世系保存`,
      evidence_event_ids: [linked.id],
      native_target: { kind: 'lineage_only' },
    });
  }

  // 确定性输出顺序：锚/judge/其余 event 先、answer 后，各自按 id 排序。
  const anchorRecordList = [...anchorClassifications.values()];
  const eventRecords = records.filter((r) => r.source_kind === 'event');
  const answerRecords = records.filter((r) => r.source_kind === 'answer');
  const allRecords = [...anchorRecordList, ...eventRecords, ...answerRecords];
  allRecords.sort((x, y) =>
    x.source_kind === y.source_kind
      ? x.source_id < y.source_id
        ? -1
        : x.source_id > y.source_id
          ? 1
          : 0
      : x.source_kind === 'event'
        ? -1
        : 1,
  );

  const rollup: Record<string, number> = {};
  for (const r of allRecords) {
    rollup[r.category] = (rollup[r.category] ?? 0) + 1;
  }

  const unresolved = allRecords
    .filter(
      (r) => r.category === 'historical_unresolved' || r.category === 'correction_cycle_unresolved',
    )
    .map((r) => ({
      source_kind: r.source_kind,
      source_id: r.source_id,
      source_locator: r.source_locator,
      reason: r.reason,
    }));

  deferredReplay.sort((x, y) =>
    x.source_id < y.source_id ? -1 : x.source_id > y.source_id ? 1 : 0,
  );

  return {
    records: allRecords,
    rollup,
    deferred_replay: deferredReplay,
    unresolved,
  };
}
