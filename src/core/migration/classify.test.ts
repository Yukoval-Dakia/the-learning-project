import { describe, expect, it } from 'vitest';

import { classifyMigrationCapture } from './classify';
import {
  SNAPSHOT,
  answeredReviewEvent,
  durablePendingEvent,
  emptyCapture,
  ev,
  judgeEvent,
  withEvents,
} from './test-fixtures';
import type { MigrationCapture } from './types';

// YUK-1048 — native 分类器单测（grounding §13；review P1-3/4/5/7 修订）。
// 纯函数、确定性、无 LLM。

function attemptOf(id: string, payload: Record<string, unknown>, questionId = 'q-1') {
  return ev({ id, action: 'attempt', subject_kind: 'question', subject_id: questionId, payload });
}

describe('classifyMigrationCapture — 五类代表性历史形状', () => {
  it('完整 attempt（真实契约 snapshot + verdict judge）→ complete_attempt + sole head', () => {
    const attempt = attemptOf('a1', { answer_md: '2', question_snapshot: SNAPSHOT });
    const judge = judgeEvent({
      id: 'j1',
      subject_id: 'a1',
      caused_by_event_id: 'a1',
      payload: { judge_route: 'exact', coarse_outcome: 'correct', score: 1 },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, judge]));

    expect(out.records.find((r) => r.source_id === 'a1')).toMatchObject({
      category: 'complete_attempt',
      native_target: {
        kind: 'submission_with_imported_eval',
        judge_event_id: 'j1',
        has_effective_head: true,
        head_selection: 'sole_verdict',
      },
    });
    expect(out.records.find((r) => r.source_id === 'j1')).toMatchObject({
      category: 'complete_attempt',
      native_target: { has_effective_head: true, head_selection: 'sole_verdict' },
    });
  });

  it('embedded tutor grade（solve_tutor 嵌入 verdict）→ embedded_tutor_grade', () => {
    const attempt = attemptOf('a2', {
      question_snapshot: SNAPSHOT,
      source: 'solve_tutor',
      judge_route: 'semantic',
      judge_score: 0.8,
      judge: { coarse_outcome: 'partial' },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt]));
    expect(out.records.find((r) => r.source_id === 'a2')).toMatchObject({
      category: 'embedded_tutor_grade',
      native_target: { kind: 'submission_with_embedded_eval', provenance: 'embedded_tutor' },
    });
  });

  it('pending（durable run 未 backfill，真实 submit 冻结输入）→ pending_blocked(infra_failure)', () => {
    const pending = durablePendingEvent({ id: 'p1', runId: 'run_missing', responseMd: '我的作答' });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [pending]));
    const row = out.records.find((r) => r.source_id === 'p1');
    expect(row?.category).toBe('pending_blocked');
    expect(row?.native_target.kind).toBe('pending_carried');
    if (row?.native_target.kind === 'pending_carried') {
      const pendingState = row.native_target.pending;
      expect(pendingState.reason).toBe('infra_failure');
      if (pendingState.reason === 'infra_failure') {
        expect(pendingState.retryable).toBe(true);
      }
      expect(JSON.stringify(pendingState)).toContain('run_missing');
    }
  });

  it('缺 issued snapshot → historical_unresolved（连带 judge 不可导入）', () => {
    const attempt = attemptOf('a3', { answer_md: '旧答案' });
    const judge = judgeEvent({
      id: 'j3',
      subject_id: 'a3',
      payload: { judge_route: 'semantic', coarse_outcome: 'correct', score: 1 },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, judge]));
    expect(out.records.find((r) => r.source_id === 'a3')?.category).toBe('historical_unresolved');
    expect(out.records.find((r) => r.source_id === 'j3')?.category).toBe('historical_unresolved');
    const unresolvedEntry = out.unresolved.find((u) => u.source_id === 'a3');
    expect(unresolvedEntry?.source_locator).toBe('event:attempt:a3');
  });

  it('correction cycle（correct 触及 judge 链）→ 全链 correction_cycle_unresolved + deferred replay', () => {
    const attempt = attemptOf('a4', { answer_md: '2', question_snapshot: SNAPSHOT });
    const judge = judgeEvent({
      id: 'j4',
      subject_id: 'a4',
      payload: { judge_route: 'exact', coarse_outcome: 'correct', score: 1 },
    });
    const correct = ev({
      id: 'c4',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'j4',
      actor_kind: 'agent',
      actor_ref: 'rejudge',
      payload: {
        correction_kind: 'supersede',
        replacement_event_id: 'j4b',
        reason_md: '答案键缺陷',
        affected_refs: [{ kind: 'question', id: 'q-1' }],
      },
    });
    const replacement = judgeEvent({
      id: 'j4b',
      subject_id: 'a4',
      payload: { judge_route: 'exact', coarse_outcome: 'incorrect' },
    });
    const out = classifyMigrationCapture(
      withEvents(emptyCapture(), [attempt, judge, correct, replacement]),
    );

    for (const id of ['a4', 'j4', 'j4b', 'c4']) {
      expect(out.records.find((r) => r.source_id === id)?.category).toBe(
        'correction_cycle_unresolved',
      );
    }
    const replay = out.deferred_replay.find((d) => d.source_id === 'a4');
    expect(replay?.source_kind).toBe('correction_cycle');
    expect(replay?.affected_subject_ids).toContain('q-1');
  });

  it('P1-4 传播：correct 触及 attempt 本身 ⇒ 同锚的其余 judge 也不可声明 head', () => {
    const attempt = attemptOf('a5', { question_snapshot: SNAPSHOT });
    const judge1 = judgeEvent({
      id: 'j5a',
      subject_id: 'a5',
      payload: { coarse_outcome: 'correct', score: 1 },
    });
    const correct = ev({
      id: 'c5',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'a5',
      actor_kind: 'user',
      payload: {
        correction_kind: 'mark_wrong',
        reason_md: '标错',
        affected_refs: [{ kind: 'question', id: 'q-1' }],
      },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, judge1, correct]));
    expect(out.records.find((r) => r.source_id === 'a5')?.category).toBe(
      'correction_cycle_unresolved',
    );
    // 传播：attempt 入闭包 ⇒ 其 judge 也入闭包（不可声称 head）。
    expect(out.records.find((r) => r.source_id === 'j5a')?.category).toBe(
      'correction_cycle_unresolved',
    );
    expect(out.records.find((r) => r.source_id === 'j5a')?.native_target).toEqual({
      kind: 'unresolved_correction_cycle',
    });
  });
});

describe('P1-4 — 多 verdict 的 effective head 选择', () => {
  const snapshot = SNAPSHOT;

  it('多个不同时刻的 verdict ⇒ legacy newest-judge-wins 恰选一头，其余 not_selected', () => {
    const attempt = attemptOf('a6', { question_snapshot: snapshot });
    const older = judgeEvent({
      id: 'j6-old',
      subject_id: 'a6',
      payload: { coarse_outcome: 'incorrect', score: 0 },
      created_at: '2026-09-20T00:00:00.000Z',
    });
    const newer = judgeEvent({
      id: 'j6-new',
      subject_id: 'a6',
      payload: { coarse_outcome: 'correct', score: 1 },
      created_at: '2026-09-21T00:00:00.000Z',
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, older, newer]));

    expect(out.records.find((r) => r.source_id === 'a6')).toMatchObject({
      category: 'complete_attempt',
      native_target: {
        judge_event_id: 'j6-new',
        has_effective_head: true,
        head_selection: 'legacy_newest_judge',
      },
    });
    expect(out.records.find((r) => r.source_id === 'j6-new')).toMatchObject({
      native_target: { has_effective_head: true, head_selection: 'legacy_newest_judge' },
    });
    expect(out.records.find((r) => r.source_id === 'j6-old')).toMatchObject({
      category: 'complete_attempt',
      native_target: { has_effective_head: false, head_selection: 'not_selected' },
    });
  });

  it('created_at 并列 ⇒ ambiguous_held：anchor pending、两头都不选', () => {
    const attempt = attemptOf('a7', { question_snapshot: snapshot });
    const j1 = judgeEvent({
      id: 'j7-a',
      subject_id: 'a7',
      payload: { coarse_outcome: 'correct', score: 1 },
      created_at: '2026-09-20T00:00:00.000Z',
    });
    const j2 = judgeEvent({
      id: 'j7-b',
      subject_id: 'a7',
      payload: { coarse_outcome: 'incorrect', score: 0 },
      created_at: '2026-09-20T00:00:00.000Z',
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, j1, j2]));

    expect(out.records.find((r) => r.source_id === 'a7')?.category).toBe('pending_blocked');
    for (const id of ['j7-a', 'j7-b']) {
      expect(out.records.find((r) => r.source_id === id)).toMatchObject({
        native_target: { has_effective_head: false, head_selection: 'ambiguous_held' },
      });
    }
  });

  it('被纠正的旧 judge 不参与选头：新 judge（未被纠正）独占 head', () => {
    const attempt = attemptOf('a8', { question_snapshot: snapshot });
    const oldJudge = judgeEvent({
      id: 'j8-old',
      subject_id: 'a8',
      payload: { coarse_outcome: 'correct' },
    });
    const correct = ev({
      id: 'c8',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'j8-old',
      actor_kind: 'agent',
      actor_ref: 'rejudge',
      payload: {
        correction_kind: 'retract',
        reason_md: '误判',
        affected_refs: [{ kind: 'question', id: 'q-1' }],
      },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, oldJudge, correct]));
    // retract 无 replacement ⇒ 无 eligible verdict ⇒ attempt 回到无判词分支（pending/断言），
    // 且旧 judge + attempt 都在纠正闭包内。
    expect(out.records.find((r) => r.source_id === 'j8-old')?.category).toBe(
      'correction_cycle_unresolved',
    );
    expect(out.records.find((r) => r.source_id === 'a8')?.category).toBe(
      'correction_cycle_unresolved',
    );
  });
});

describe('P1-3 — review 双形态', () => {
  it('rating-only review → fsrs_review_lineage（D15 评级 provenance，不是 submission）', () => {
    const review = ev({
      id: 'r13',
      action: 'review',
      outcome: 'success',
      payload: { fsrs_rating: 3, user_response_md: null, answer_image_refs: [] },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [review]));
    expect(out.records.find((r) => r.source_id === 'r13')).toMatchObject({
      category: 'fsrs_review_lineage',
      native_target: { kind: 'lineage_only' },
    });
  });

  it('durable 完整链：pending（冻结输入）+ answer-bearing review（embedded verdict）→ complete_attempt', () => {
    const pending = durablePendingEvent({ id: 'p14', runId: 'run-14', responseMd: '我的手写作答' });
    const review = answeredReviewEvent({ id: 'run-14', responseMd: '我的手写作答' });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [pending, review]));

    const reviewRow = out.records.find((r) => r.source_id === 'run-14');
    expect(reviewRow?.category).toBe('complete_attempt');
    expect(reviewRow?.native_target).toEqual({
      kind: 'submission_with_imported_eval',
      judge_event_id: null,
      has_effective_head: true,
      head_selection: 'sole_verdict',
    });
    expect(reviewRow?.evidence_event_ids).toContain('p14');
    // pending 行本身只作世系（冻结输入由 review 分类承接）。
    expect(out.records.find((r) => r.source_id === 'p14')?.category).toBe(
      'pending_resolved_lineage',
    );
  });

  it('durable 完整链 + 配对 judge 事件（review_judge）→ judge 是 head 证据', () => {
    const pending = durablePendingEvent({ id: 'p15', runId: 'run-15' });
    const review = answeredReviewEvent({ id: 'run-15' });
    const judge = judgeEvent({
      id: 'j15',
      subject_id: 'run-15',
      actor_ref: 'review_judge',
      caused_by_event_id: 'run-15',
      payload: {
        judge_route: 'exact',
        coarse_outcome: 'correct',
        score: 1,
        attribution_pending: true,
      },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [pending, review, judge]));

    expect(out.records.find((r) => r.source_id === 'run-15')).toMatchObject({
      category: 'complete_attempt',
      native_target: { judge_event_id: 'j15', has_effective_head: true },
    });
    // 配对 judge 带 verdict（占位标记只表示归因 pending）→ 评估证据。
    expect(out.records.find((r) => r.source_id === 'j15')?.category).toBe('complete_attempt');
  });

  it('durable pre-snapshot（pending 无冻结 snapshot）→ historical_unresolved', () => {
    const pending = durablePendingEvent({ id: 'p16', runId: 'run-16', withSnapshot: false });
    const review = answeredReviewEvent({ id: 'run-16' });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [pending, review]));
    const row = out.records.find((r) => r.source_id === 'run-16');
    expect(row?.category).toBe('historical_unresolved');
    expect(row?.reason).toContain('无冻结 question_snapshot');
  });

  it('solo answer-bearing review（无 durable 锚，判的是 live 行）→ historical_unresolved', () => {
    const review = answeredReviewEvent({ id: 'r17', responseMd: '2' });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [review]));
    const row = out.records.find((r) => r.source_id === 'r17');
    expect(row?.category).toBe('historical_unresolved');
    expect(row?.reason).toContain('无冻结 issuance');
  });

  it('durable 自评作答（无判词）→ human_import_assertion（manual provenance only，D9/D15）', () => {
    const pending = durablePendingEvent({ id: 'p18', runId: 'run-18' });
    const review = answeredReviewEvent({ id: 'run-18', withVerdict: false });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [pending, review]));
    expect(out.records.find((r) => r.source_id === 'run-18')).toMatchObject({
      category: 'human_import_assertion',
      native_target: { kind: 'manual_provenance_only', assertion: 'human' },
    });
  });
});

describe('P1-5 — snapshot/verdict 完整性', () => {
  it('snapshot 形状不识别（自造 {prompt_md,kind}）→ historical_unresolved，绝不用当前 revision 补造', () => {
    const attempt = attemptOf('a20', {
      question_snapshot: { prompt_md: '1+1=?', kind: 'short_answer' },
    });
    const judge = judgeEvent({
      id: 'j20',
      subject_id: 'a20',
      payload: { coarse_outcome: 'correct', score: 1 },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, judge]));
    const row = out.records.find((r) => r.source_id === 'a20');
    expect(row?.category).toBe('historical_unresolved');
    expect(row?.reason).toContain('AttemptQuestionSnapshot');
  });

  it('snapshot 为空对象/字符串 → historical_unresolved', () => {
    const attempt1 = attemptOf('a21a', { question_snapshot: {} });
    const attempt2 = attemptOf('a21b', { question_snapshot: 'q-1 v0' });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt1, attempt2]));
    expect(out.records.find((r) => r.source_id === 'a21a')?.category).toBe('historical_unresolved');
    expect(out.records.find((r) => r.source_id === 'a21b')?.category).toBe('historical_unresolved');
  });

  it('judge_route 单独不构成 verdict → attribution-only，attempt 缺件 blocked', () => {
    const attempt = attemptOf('a22', { question_snapshot: SNAPSHOT });
    const routeOnlyJudge = judgeEvent({
      id: 'j22',
      subject_id: 'a22',
      payload: {
        judge_route: 'exact',
        cause: { primary_category: 'x', analysis_md: '...', confidence: 0.5 },
      },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, routeOnlyJudge]));
    expect(out.records.find((r) => r.source_id === 'j22')?.category).toBe('attribution_only');
    expect(out.records.find((r) => r.source_id === 'a22')?.category).toBe('pending_blocked');
  });

  it('solve_tutor 声明嵌入判分但无 verdict（judge_score/coarse_outcome 均缺）→ pending_blocked', () => {
    const attempt = attemptOf('a23', {
      question_snapshot: SNAPSHOT,
      source: 'solve_tutor',
      judge_route: 'semantic',
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt]));
    expect(out.records.find((r) => r.source_id === 'a23')?.category).toBe('pending_blocked');
  });
});

describe('P1-7 — 因果/证据闭包', () => {
  it('非评估事件（闭包引用，如被 caused_by/evidence_event_ids 指向的 propose）→ causal_closure_lineage', () => {
    const attempt = attemptOf('a24', { question_snapshot: SNAPSHOT });
    const judge = judgeEvent({
      id: 'j24',
      subject_id: 'a24',
      caused_by_event_id: 'prop-1',
      payload: { coarse_outcome: 'correct', score: 1 },
    });
    const propose = ev({
      id: 'prop-1',
      action: 'propose',
      subject_kind: 'knowledge',
      subject_id: 'kc-9',
      actor_kind: 'cron',
      actor_ref: 'nightly',
      payload: { title: '候选 KC' },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, judge, propose]));
    expect(out.records.find((r) => r.source_id === 'prop-1')).toMatchObject({
      category: 'causal_closure_lineage',
      native_target: { kind: 'lineage_only' },
    });
    // 闭包事件的存在不影响锚分类。
    expect(out.records.find((r) => r.source_id === 'a24')?.category).toBe('complete_attempt');
  });
});

describe('classifyMigrationCapture — 其余 native 语义位', () => {
  it('attribution-only judge（仅 cause 无 verdict）→ attribution_only，永不冒充分数', () => {
    const attempt = attemptOf('a30', { question_snapshot: SNAPSHOT });
    const attributionJudge = judgeEvent({
      id: 'j30',
      subject_id: 'a30',
      payload: { cause: { primary_category: '概念不清', analysis_md: '...', confidence: 0.8 } },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, attributionJudge]));
    expect(out.records.find((r) => r.source_id === 'j30')?.category).toBe('attribution_only');
    expect(out.records.find((r) => r.source_id === 'a30')?.category).toBe('pending_blocked');
  });

  it('无 verdict 的占位 judge → attempt pending_blocked(needs_review)', () => {
    const attempt = attemptOf('a31', { question_snapshot: SNAPSHOT });
    const placeholder = judgeEvent({
      id: 'j31',
      subject_id: 'a31',
      payload: { attribution_pending: true },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, placeholder]));
    const row = out.records.find((r) => r.source_id === 'a31');
    expect(row?.category).toBe('pending_blocked');
    if (row?.native_target.kind === 'pending_carried') {
      expect(row.native_target.pending.reason).toBe('needs_review');
    }
  });

  it('人工错题断言（learning_record mirror source=manual）→ human_import_assertion(human)', () => {
    const attempt = attemptOf('a32', { question_snapshot: SNAPSHOT, wrong_answer_md: '我写的' });
    const capture = emptyCapture();
    capture.rawFacts.learning_record_mirrors = [
      {
        id: 'lr32',
        kind: 'mistake',
        source: 'manual',
        attempt_event_id: 'a32',
        question_id: 'q-1',
      },
    ];
    const out = classifyMigrationCapture(withEvents(capture, [attempt]));
    expect(out.records.find((r) => r.source_id === 'a32')).toMatchObject({
      category: 'human_import_assertion',
      native_target: { kind: 'manual_provenance_only', assertion: 'human' },
    });
  });

  it('导入断言（enroll mirror source=import / generated_by）→ human_import_assertion(import)', () => {
    const attempt = attemptOf('a33', { question_snapshot: SNAPSHOT, generated_by: 'auto_capture' });
    const capture = emptyCapture();
    capture.rawFacts.learning_record_mirrors = [
      {
        id: 'lr33',
        kind: 'mistake',
        source: 'import',
        attempt_event_id: 'a33',
        question_id: 'q-1',
      },
    ];
    const out = classifyMigrationCapture(withEvents(capture, [attempt]));
    expect(out.records.find((r) => r.source_id === 'a33')).toMatchObject({
      category: 'human_import_assertion',
      native_target: { kind: 'manual_provenance_only', assertion: 'import' },
    });
  });

  it('unsupported_judge（已接收未判）→ pending_blocked(unjudgeable)，不是错答', () => {
    const attempt = attemptOf('a34', {
      question_snapshot: SNAPSHOT,
      unsupported_judge: true,
      answer_image_refs: ['asset-1'],
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt]));
    const row = out.records.find((r) => r.source_id === 'a34');
    expect(row?.category).toBe('pending_blocked');
    if (row?.native_target.kind === 'pending_carried') {
      expect(row.native_target.pending.reason).toBe('unjudgeable');
    }
  });

  it('孤儿 judge（目标事件不存在）→ historical_unresolved', () => {
    const judge = judgeEvent({
      id: 'j35',
      subject_id: 'missing-attempt',
      payload: { coarse_outcome: 'correct', score: 1 },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [judge]));
    expect(out.records.find((r) => r.source_id === 'j35')?.category).toBe('historical_unresolved');
  });

  it('reproject_deferred 标记 → state_snapshot_lineage + deferred replay 工作清单', () => {
    const marker = ev({
      id: 'rp36',
      action: 'experimental:reproject_deferred',
      subject_kind: 'event',
      subject_id: 'some-judge',
      payload: {},
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [marker]));
    expect(out.records.find((r) => r.source_id === 'rp36')?.category).toBe(
      'state_snapshot_lineage',
    );
    expect(out.deferred_replay).toEqual([
      {
        source_kind: 'reproject_deferred_marker',
        source_id: 'rp36',
        affected_subject_ids: ['some-judge'],
        reason: expect.stringContaining('reproject'),
      },
    ]);
  });
});

describe('classifyMigrationCapture — answer 行', () => {
  function captureWithAnswers(
    answers: MigrationCapture['rawFacts']['answers'],
    events = [] as MigrationCapture['rawFacts']['events'],
  ): MigrationCapture {
    const capture = withEvents(emptyCapture(), events);
    capture.rawFacts.answers = answers;
    return capture;
  }

  it('live draft（submitted_at NULL）→ live_draft，精确保存不补造 submission', () => {
    const out = classifyMigrationCapture(
      captureWithAnswers([
        {
          id: 'ans1',
          question_id: 'q-1',
          learning_item_id: null,
          input_kind: 'text',
          content_md: '写了一半',
          image_refs: [],
          vision_extracted: null,
          tags: [],
          submitted_at: null,
          session_id: 's-1',
          paper_artifact_id: null,
          part_ref: null,
          event_id: null,
        },
      ]),
    );
    expect(out.records.find((r) => r.source_id === 'ans1')).toMatchObject({
      category: 'live_draft',
      native_target: { kind: 'draft_preserved' },
    });
  });

  it('frozen answer 镜像其 attempt 分类', () => {
    const attempt = attemptOf('a40', { answer_md: '2', question_snapshot: SNAPSHOT });
    const judge = judgeEvent({
      id: 'j40',
      subject_id: 'a40',
      payload: { coarse_outcome: 'correct', score: 1 },
    });
    const out = classifyMigrationCapture(
      captureWithAnswers(
        [
          {
            id: 'ans40',
            question_id: 'q-1',
            learning_item_id: null,
            input_kind: 'text',
            content_md: '2',
            image_refs: [],
            vision_extracted: null,
            tags: [],
            submitted_at: '2026-09-20T00:00:00.000Z',
            session_id: 's-1',
            paper_artifact_id: null,
            part_ref: null,
            event_id: 'a40',
          },
        ],
        [attempt, judge],
      ),
    );
    expect(out.records.find((r) => r.source_id === 'ans40')?.category).toBe('complete_attempt');
  });

  it('frozen answer 锚定到 answer-bearing review → 镜像 review 分类', () => {
    const pending = durablePendingEvent({ id: 'p41', runId: 'run-41' });
    const review = answeredReviewEvent({ id: 'run-41' });
    const out = classifyMigrationCapture(
      captureWithAnswers(
        [
          {
            id: 'ans41',
            question_id: 'q-1',
            learning_item_id: null,
            input_kind: 'text',
            content_md: '2',
            image_refs: [],
            vision_extracted: null,
            tags: [],
            submitted_at: '2026-09-20T00:00:00.000Z',
            session_id: null,
            paper_artifact_id: null,
            part_ref: null,
            event_id: 'run-41',
          },
        ],
        [pending, review],
      ),
    );
    expect(out.records.find((r) => r.source_id === 'ans41')?.category).toBe('complete_attempt');
  });

  it('frozen 孤儿 answer（event_id 悬空）→ historical_unresolved', () => {
    const out = classifyMigrationCapture(
      captureWithAnswers([
        {
          id: 'ans42',
          question_id: 'q-1',
          learning_item_id: null,
          input_kind: 'text',
          content_md: '?',
          image_refs: [],
          vision_extracted: null,
          tags: [],
          submitted_at: '2026-09-20T00:00:00.000Z',
          session_id: null,
          paper_artifact_id: null,
          part_ref: null,
          event_id: 'no-such-event',
        },
      ]),
    );
    expect(out.records.find((r) => r.source_id === 'ans42')?.category).toBe(
      'historical_unresolved',
    );
  });
});

describe('classifyMigrationCapture — 确定性与空形状', () => {
  it('空 capture（D19 形状）→ 空输出，无异常', () => {
    const out = classifyMigrationCapture(emptyCapture());
    expect(out.records).toEqual([]);
    expect(out.unresolved).toEqual([]);
    expect(out.deferred_replay).toEqual([]);
  });

  it('同输入两次分类输出逐字节一致（确定性）', () => {
    const attempt = attemptOf('a-dup', { question_snapshot: SNAPSHOT });
    const judge = judgeEvent({
      id: 'j-dup',
      subject_id: 'a-dup',
      payload: { coarse_outcome: 'correct' },
    });
    const capture = withEvents(emptyCapture(), [attempt, judge]);
    expect(JSON.stringify(classifyMigrationCapture(capture))).toBe(
      JSON.stringify(classifyMigrationCapture(capture)),
    );
  });

  it('rollup 与 records 一致，且输出按 (source_kind, source_id) 有序', () => {
    const attempt = attemptOf('a-ord', { question_snapshot: SNAPSHOT });
    const review = ev({ id: 'r-ord', action: 'review', outcome: 'success', payload: {} });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [review, attempt]));
    const total = Object.values(out.rollup).reduce((a, b) => a + b, 0);
    expect(total).toBe(out.records.length);
    const ids = out.records.map((r) => `${r.source_kind}:${r.source_id}`);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('终轮 review P1-1/P1-2/P1-3 — reviewer repro 形状（可执行核对）', () => {
  it('P1-1 repro：4 字段残缺 durable snapshot + 作答 + verdict ⇒ NOT complete', () => {
    const pending = durablePendingEvent({
      id: 'p-r1',
      runId: 'run-r1',
      responseMd: '作答',
      snapshotOverride: {
        kind: 'short_answer',
        prompt_md: '1+1=?',
        version: 0,
        updated_at: '2026-09-01T00:00:00Z',
      },
    });
    const review = answeredReviewEvent({ id: 'run-r1', responseMd: '作答' });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [pending, review]));
    const row = out.records.find((r) => r.source_id === 'run-r1');
    expect(row?.category).toBe('historical_unresolved');
    expect(row?.reason).toContain('FrozenQuestionSnapshot');
  });

  it('P1-1 repro：{score:false, coarse_outcome:"bogus"} ⇒ judge 损坏不可 effective，attempt blocked', () => {
    const attempt = attemptOf('a-r2', { question_snapshot: SNAPSHOT });
    const bogusJudge = judgeEvent({
      id: 'j-r2',
      subject_id: 'a-r2',
      payload: { coarse_outcome: 'bogus', score: false },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, bogusJudge]));
    const judgeRow = out.records.find((r) => r.source_id === 'j-r2');
    expect(judgeRow?.category).toBe('historical_unresolved');
    expect(judgeRow?.reason).toContain('JudgeResultV2');
    expect(judgeRow?.native_target.kind).toBe('historical_unknown');
    // attempt：无有效判词 ⇒ 缺件 blocked（不冒充 complete）。
    expect(out.records.find((r) => r.source_id === 'a-r2')?.category).toBe('pending_blocked');
  });

  it('P1-1：值域边界 —— correct score 0.5 非法；partial 0.5 合法；unsupported 无 score 合法', () => {
    const mk = (id: string, payload: Record<string, unknown>) =>
      judgeEvent({ id, subject_id: 'a-r3', payload });
    const attempt = attemptOf('a-r3', { question_snapshot: SNAPSHOT });
    const correctLowScore = mk('j-r3a', { coarse_outcome: 'correct', score: 0.5 });
    const outA = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, correctLowScore]));
    expect(outA.records.find((r) => r.source_id === 'j-r3a')?.category).toBe(
      'historical_unresolved',
    );

    const partial = mk('j-r3b', { coarse_outcome: 'partial', score: 0.5 });
    const outB = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, partial]));
    expect(outB.records.find((r) => r.source_id === 'a-r3')?.category).toBe('complete_attempt');

    const unsupported = mk('j-r3c', { coarse_outcome: 'unsupported' });
    const outC = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, unsupported]));
    expect(outC.records.find((r) => r.source_id === 'a-r3')?.category).toBe('complete_attempt');
  });

  it('P1-1 repro：q-other 的 attempt 携带 q-1 的有效快照 ⇒ unresolved（身份不绑定）', () => {
    const attempt = attemptOf('a-r4', { question_snapshot: SNAPSHOT }, 'q-other');
    const judge = judgeEvent({
      id: 'j-r4',
      subject_id: 'a-r4',
      payload: { coarse_outcome: 'correct', score: 1 },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, judge]));
    expect(out.records.find((r) => r.source_id === 'a-r4')?.category).toBe('historical_unresolved');
    expect(out.records.find((r) => r.source_id === 'j-r4')?.category).toBe('historical_unresolved');
  });

  it('P1-2 repro：auto_rate 声明（judge 块）+ 作答 + 无 verdict ⇒ blocked，不是 human', () => {
    const pending = durablePendingEvent({ id: 'p-r5', runId: 'run-r5', responseMd: '作答' });
    const review = ev({
      id: 'run-r5',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q-1',
      outcome: 'success',
      payload: {
        fsrs_rating: 'good',
        user_response_md: '作答',
        answer_image_refs: [],
        // 机器判分已声明（auto_rate 路径）但判词缺失。
        judge: { route: 'exact', auto_rated: true, feedback_md: '' },
      },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [pending, review]));
    expect(out.records.find((r) => r.source_id === 'run-r5')?.category).toBe('pending_blocked');
  });

  it('P1-2 肯定证据：无任何机器判分声明的自评作答 ⇒ human（manual provenance）', () => {
    const pending = durablePendingEvent({ id: 'p-r6', runId: 'run-r6', responseMd: '作答' });
    const review = answeredReviewEvent({ id: 'run-r6', withVerdict: false });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [pending, review]));
    expect(out.records.find((r) => r.source_id === 'run-r6')?.category).toBe(
      'human_import_assertion',
    );
  });

  it('P1-3 repro：unsupported_judge + 无效/无判词 ⇒ anchor pending 且 judge 绝不声明 head', () => {
    const attempt = ev({
      id: 'a-r7',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q-1',
      payload: {
        question_snapshot: SNAPSHOT,
        unsupported_judge: true,
        answer_image_refs: ['asset-1'],
      },
    });
    const attributionOnly = judgeEvent({
      id: 'j-r7',
      subject_id: 'a-r7',
      payload: { cause: { primary_category: 'x', analysis_md: '...', confidence: 0.5 } },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, attributionOnly]));
    expect(out.records.find((r) => r.source_id === 'a-r7')?.category).toBe('pending_blocked');
    const judgeRow = out.records.find((r) => r.source_id === 'j-r7');
    expect(judgeRow?.category).toBe('attribution_only');
    expect(judgeRow?.native_target.kind).toBe('attribution_evidence_only');
  });

  it('P1-3 一致提升：unsupported_judge + 后到有效 verdict ⇒ anchor complete 且 judge 为 head', () => {
    const attempt = ev({
      id: 'a-r8',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q-1',
      payload: {
        question_snapshot: SNAPSHOT,
        unsupported_judge: true,
        answer_image_refs: ['asset-1'],
      },
    });
    const lateVerdict = judgeEvent({
      id: 'j-r8',
      subject_id: 'a-r8',
      payload: { coarse_outcome: 'correct', score: 1 },
      created_at: '2026-09-21T00:00:00.000Z',
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, lateVerdict]));
    expect(out.records.find((r) => r.source_id === 'a-r8')).toMatchObject({
      category: 'complete_attempt',
      native_target: { judge_event_id: 'j-r8', has_effective_head: true },
    });
    expect(out.records.find((r) => r.source_id === 'j-r8')).toMatchObject({
      native_target: { has_effective_head: true },
    });
  });
});
