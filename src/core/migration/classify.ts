import type { HistoricalUnknownSubmissionT, PendingStateT } from '../schema/assessment';
import type {
  DeferredReplayEntry,
  MigrationCapture,
  MigrationClassification,
  RecordClassification,
} from './types';

// ====================================================================
// YUK-1048 — native 分类器（grounding §13）—— 纯函数、确定性、无 LLM
// ====================================================================
//
// 输入是 capture 的 rawFacts（不是 live 查询）：分类必须可以从捕获工件
// 离线重放。规则按优先级固定：
//
//   attempt 事件（subject_kind='question'）：
//     1. correction 闭包成员 → correction_cycle_unresolved（+ deferred replay）
//     2. payload.question_snapshot 缺失 → historical_unresolved
//        （缺 issued snapshot —— 绝不用当前 revision 补造当时所见，§3.2/§13）
//     3. payload.unsupported_judge === true → pending_blocked(unjudgeable)
//        （答案已冻结、判分缺失 —— 不是错答，不得伪零分）
//     4. payload.source === 'solve_tutor' 且嵌有 judge 字段 → embedded_tutor_grade
//     5. 存在真实 verdict 的 judge 事件（含带 verdict 的 attribution 占位）
//        → complete_attempt（submission + imported eval/head）
//     6. 仅有无 verdict 的占位 judge → pending_blocked(needs_review)
//     7. 有人工/导入断言镜像（learning_record(mistake/import) 或 generated_by）
//        → human_import_assertion（诚实标注，仅手动学习效应，D9）
//     8. 其余（outcome 存在但判分证据缺失且无断言标记）→ pending_blocked
//        (needs_review/flagged) —— 缺件 blocked，不猜。
//
//   judge 事件：correction 闭包 > historical_unresolved（目标 attempt 缺失/
//   缺 snapshot）> attribution_pending_placeholder > attribution_only >
//   complete_attempt（真实 verdict 的 imported eval 证据）。
//
//   experimental:judge_pending_attempt：已 backfill（event.id=run_id 存在）→
//   pending_resolved_lineage；未 backfill → pending_blocked(infra_failure)，
//   保留 run/request/pending 身份与 response digest 指针（§13 pending 契约）。
//
//   review 事件 → fsrs_review_lineage（用户评级 provenance，D15；不是 submission）。
//   grading_checkpoint / state_snapshot / reproject_deferred → state_snapshot_lineage；
//   reproject_deferred 额外进 deferred replay 工作清单（§10 未完成义务）。
//
//   answer 行：live draft（submitted_at IS NULL）→ live_draft（精确保存，
//   不补造 submission）；frozen → 镜像其 attempt/review 事件的分类；孤儿 →
//   historical_unresolved。

// durable judge 队列名（practice 侧 boss.send('judge_run') 的字面量；core 不得
// import capability，故本地声明并在 db 测试中与 producer 断言对齐）。
const JUDGE_RUN_QUEUE_NAME = 'judge_run';

/**
 * 历史事件 payload 是松散 jsonb：只做安全取键/等值比较，不做形状假设。
 * 值一律 unknown —— 分类器只读 marker（存在性/字面量等值），不消费内容。
 */
interface EventPayload {
  [key: string]: unknown;
}

function payloadOf(payload: unknown): EventPayload {
  return payload !== null && typeof payload === 'object' ? (payload as EventPayload) : {};
}

function hasRealVerdict(payload: EventPayload): boolean {
  return payload.judge_route != null || payload.coarse_outcome != null || payload.score != null;
}

function isAttributionPlaceholder(payload: EventPayload): boolean {
  return payload.attribution_pending === true;
}

function locatorOf(sourceKind: 'event' | 'answer', action: string | null, id: string): string {
  return action === null ? `${sourceKind}:${id}` : `${sourceKind}:${action}:${id}`;
}

/** classification 主入口：capture.rawFacts → 确定性分类 + 工作清单 + unresolved。 */
export function classifyMigrationCapture(capture: MigrationCapture): MigrationClassification {
  const facts = capture.rawFacts;
  const events = facts.events;

  const eventById = new Map(events.map((e) => [e.id, e]));
  const judgesByAttempt = new Map<string, typeof events>();
  for (const e of events) {
    if (e.action === 'judge' && e.subject_kind === 'event') {
      const list = judgesByAttempt.get(e.subject_id) ?? [];
      list.push(e);
      judgesByAttempt.set(e.subject_id, list);
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
  // 未 backfill 的 durable run id 集合（judge_pending_attempt 的 run_id 无对应事件行）。
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

  // ---- correction 闭包（target + replacement + 受影响 attempt） ----
  const correctionMemberIds = new Set<string>();
  for (const e of events) {
    if (e.action !== 'correct' || e.subject_kind !== 'event') continue;
    correctionMemberIds.add(e.subject_id);
    correctionMemberIds.add(e.id);
    const payload = payloadOf(e.payload);
    const replacement = payload.replacement_event_id;
    if (typeof replacement === 'string') correctionMemberIds.add(replacement);
    const target = eventById.get(e.subject_id);
    if (target != null && target.action === 'attempt') {
      correctionMemberIds.add(target.id);
    } else if (target != null && target.action === 'judge' && target.subject_kind === 'event') {
      const attempt = eventById.get(target.subject_id);
      if (attempt != null) correctionMemberIds.add(attempt.id);
    }
  }

  const records: RecordClassification[] = [];
  const deferredReplay: DeferredReplayEntry[] = [];

  const historicalUnknown = (
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

  // ---- attempt 分类 ----
  const classifyAttempt = (attempt: (typeof events)[number]): RecordClassification => {
    const payload = payloadOf(attempt.payload);
    const locator = locatorOf('event', attempt.action, attempt.id);
    const linkedAnswerIds = answersByEventId.get(attempt.id) ?? [];

    if (correctionMemberIds.has(attempt.id)) {
      const affected = [
        attempt.subject_id,
        ...(Array.isArray(payload.referenced_knowledge_ids)
          ? payload.referenced_knowledge_ids
          : []),
      ];
      deferredReplay.push({
        source_kind: 'correction_cycle',
        source_id: attempt.id,
        affected_subject_ids: affected,
        reason:
          'attempt 处于 correction 闭包内 —— effective-truth 链未物化，保持 unresolved，replay 延后（§10/§13）',
      });
      return {
        category: 'correction_cycle_unresolved',
        source_kind: 'event',
        source_id: attempt.id,
        source_locator: locator,
        reason: 'attempt 被纠正链触及（correct 事件的 target/replacement 闭包）',
        evidence_event_ids: [attempt.id],
        native_target: { kind: 'unresolved_correction_cycle' },
      };
    }

    if (payload.question_snapshot == null) {
      return historicalUnknown(
        attempt.id,
        locator,
        'attempt payload 无 question_snapshot —— 缺 issued snapshot，不能用当前 revision 补造当时所见（§3.2/§13）',
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

    if (
      payload.source === 'solve_tutor' &&
      (payload.judge_route != null || payload.judge_score != null || payload.judge != null)
    ) {
      return {
        category: 'embedded_tutor_grade',
        source_kind: 'event',
        source_id: attempt.id,
        source_locator: locator,
        reason:
          'solve_tutor attempt 嵌入判分（judge_route/judge_score/judge 在 payload 内，无独立 judge 事件）',
        evidence_event_ids: [attempt.id],
        native_target: { kind: 'submission_with_embedded_eval', provenance: 'embedded_tutor' },
      };
    }

    const judges = judgesByAttempt.get(attempt.id) ?? [];
    const verdictJudge = judges.find((j) => hasRealVerdict(payloadOf(j.payload)));
    if (verdictJudge != null) {
      return {
        category: 'complete_attempt',
        source_kind: 'event',
        source_id: attempt.id,
        source_locator: locator,
        reason: `attempt 带 issued snapshot，且 judge 事件 ${verdictJudge.id} 携带真实 verdict —— 迁移为 submission + imported eval/head`,
        evidence_event_ids: [attempt.id, verdictJudge.id, ...linkedAnswerIds],
        native_target: {
          kind: 'submission_with_imported_eval',
          judge_event_id: verdictJudge.id,
          has_effective_head: true,
        },
      };
    }

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

  const attemptClassifications = new Map<string, RecordClassification>();
  for (const e of events) {
    if (e.action === 'attempt' && e.subject_kind === 'question') {
      attemptClassifications.set(e.id, classifyAttempt(e));
    }
  }

  // ---- 其余事件分类 ----
  for (const e of events) {
    if (e.action === 'attempt' && e.subject_kind === 'question') continue;
    const locator = locatorOf('event', e.action, e.id);

    if (e.action === 'judge' && e.subject_kind === 'event') {
      if (correctionMemberIds.has(e.id)) {
        records.push({
          category: 'correction_cycle_unresolved',
          source_kind: 'event',
          source_id: e.id,
          source_locator: locator,
          reason: 'judge 事件被纠正链触及（target/replacement 闭包）',
          evidence_event_ids: [e.id],
          native_target: { kind: 'unresolved_correction_cycle' },
        });
        continue;
      }
      const attempt = eventById.get(e.subject_id);
      if (
        attempt == null ||
        attemptClassifications.get(attempt.id)?.category === 'historical_unresolved'
      ) {
        records.push(
          historicalUnknown(
            e.id,
            locator,
            attempt == null
              ? `judge 事件的目标 attempt（${e.subject_id}）不存在 —— 孤儿判分记录，无 submission 可挂`
              : 'judge 事件的目标 attempt 缺 issued snapshot —— 无 submission 可挂',
            [e.id],
            'event',
            'event',
          ),
        );
        continue;
      }
      const payload = payloadOf(e.payload);
      if (isAttributionPlaceholder(payload)) {
        records.push({
          category: 'attribution_pending_placeholder',
          source_kind: 'event',
          source_id: e.id,
          source_locator: locator,
          reason: 'attribution_pending 占位 judge —— 保留为证据；verdict 在则 attempt 侧可导入',
          evidence_event_ids: [e.id],
          native_target: { kind: 'attribution_evidence_only' },
        });
        continue;
      }
      if (!hasRealVerdict(payload)) {
        records.push({
          category: 'attribution_only',
          source_kind: 'event',
          source_id: e.id,
          source_locator: locator,
          reason:
            'judge 事件仅含 cause（无 judge_route/coarse_outcome/score）—— 归因不是分数（§9）',
          evidence_event_ids: [e.id],
          native_target: { kind: 'attribution_evidence_only' },
        });
        continue;
      }
      records.push({
        category: 'complete_attempt',
        source_kind: 'event',
        source_id: e.id,
        source_locator: locator,
        reason: `真实 verdict judge —— ${attempt.id} 的 imported evaluation 证据`,
        evidence_event_ids: [e.id, attempt.id],
        native_target: {
          kind: 'submission_with_imported_eval',
          judge_event_id: e.id,
          has_effective_head: true,
        },
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
          detail: `durable judge run ${runId} 未 backfill（无 event.id=run_id 的 review 事件）${queueNote} —— 保留 run/request/pending 身份与 payload.submit response 事实`,
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
        records.push({
          category: 'pending_resolved_lineage',
          source_kind: 'event',
          source_id: e.id,
          source_locator: locator,
          reason: `judge_pending_attempt 已 backfill（run_id=${String(runId)} 存在对应事件）—— 只作世系`,
          evidence_event_ids: [e.id],
          native_target: { kind: 'lineage_only' },
        });
      }
      continue;
    }

    if (e.action === 'review' && e.subject_kind === 'question') {
      records.push({
        category: 'fsrs_review_lineage',
        source_kind: 'event',
        source_id: e.id,
        source_locator: locator,
        reason: 'FSRS review 事件 —— 用户评级 provenance（D15），不是 submission',
        evidence_event_ids: [e.id],
        native_target: { kind: 'lineage_only' },
      });
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
      // correction 事件本身在闭包构建时已登记；此处给出分类行。
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

    // capture 动作集合是封闭的；走到这里说明 reader 集合与分类器脱同步 ——
    // fail-visible：归类为 unresolved 而不是静默丢弃。
    records.push(
      historicalUnknown(
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
        historicalUnknown(
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
    if (linked.action === 'attempt') {
      const attemptClassification = attemptClassifications.get(linked.id);
      if (attemptClassification == null) {
        records.push(
          historicalUnknown(
            a.id,
            locator,
            `frozen answer 指向的 attempt ${linked.id} 未被分类`,
            [linked.id],
            'answer',
            'answer',
          ),
        );
        continue;
      }
      records.push({
        category: attemptClassification.category,
        source_kind: 'answer',
        source_id: a.id,
        source_locator: locator,
        reason: `frozen answer 镜像其 attempt ${linked.id} 的分类（${attemptClassification.reason}）`,
        evidence_event_ids: [linked.id],
        native_target: attemptClassification.native_target,
      });
      continue;
    }
    // 非 attempt 锚（如 FSRS review 冻结）—— 世系。
    records.push({
      category: linked.action === 'review' ? 'fsrs_review_lineage' : 'state_snapshot_lineage',
      source_kind: 'answer',
      source_id: a.id,
      source_locator: locator,
      reason: `frozen answer 锚定到非 attempt 事件（action=${linked.action}）—— 世系保存`,
      evidence_event_ids: [linked.id],
      native_target: { kind: 'lineage_only' },
    });
  }

  // 确定性输出顺序：attempt/judge/其余 event 先、answer 后，各自按 id 排序。
  const attemptRecordList = [...attemptClassifications.values()];
  const eventRecords = records.filter((r) => r.source_kind === 'event');
  const answerRecords = records.filter((r) => r.source_kind === 'answer');
  const allRecords = [...attemptRecordList, ...eventRecords, ...answerRecords];
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
