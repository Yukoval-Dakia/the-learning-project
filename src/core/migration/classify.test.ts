import { describe, expect, it } from 'vitest';

import { classifyMigrationCapture } from './classify';
import { SNAPSHOT, emptyCapture, ev, judgeEvent, withEvents } from './test-fixtures';
import type { MigrationCapture } from './types';

// YUK-1048 — native 分类器单测（grounding §13）。纯函数、确定性、无 LLM。

function attemptOf(id: string, payload: Record<string, unknown>, questionId = 'q-1') {
  return ev({ id, action: 'attempt', subject_kind: 'question', subject_id: questionId, payload });
}

describe('classifyMigrationCapture — 五类代表性历史形状', () => {
  it('完整 attempt（snapshot + 真实 verdict judge）→ complete_attempt + imported eval/head', () => {
    const attempt = attemptOf('a1', { answer_md: '2', question_snapshot: SNAPSHOT });
    const judge = judgeEvent({
      id: 'j1',
      subject_id: 'a1',
      caused_by_event_id: 'a1',
      payload: { judge_route: 'exact', coarse_outcome: 'correct', score: 1 },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, judge]));

    const attemptRow = out.records.find((r) => r.source_id === 'a1');
    expect(attemptRow?.category).toBe('complete_attempt');
    expect(attemptRow?.native_target).toEqual({
      kind: 'submission_with_imported_eval',
      judge_event_id: 'j1',
      has_effective_head: true,
    });
    // verdict judge 事件本身也是 complete_attempt 分组（imported eval 证据）。
    const judgeRow = out.records.find((r) => r.source_id === 'j1');
    expect(judgeRow?.category).toBe('complete_attempt');
  });

  it('embedded tutor grade（solve_tutor 嵌入判分）→ embedded_tutor_grade', () => {
    const attempt = attemptOf('a2', {
      question_snapshot: SNAPSHOT,
      source: 'solve_tutor',
      judge_route: 'semantic',
      judge_score: 0.8,
      judge: { coarse_outcome: 'partial' },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt]));
    const row = out.records.find((r) => r.source_id === 'a2');
    expect(row?.category).toBe('embedded_tutor_grade');
    expect(row?.native_target).toEqual({
      kind: 'submission_with_embedded_eval',
      provenance: 'embedded_tutor',
    });
  });

  it('pending（durable run 未 backfill）→ pending_blocked，保留 run/request 身份与 infra 语义', () => {
    const pending = ev({
      id: 'p1',
      action: 'experimental:judge_pending_attempt',
      outcome: null,
      payload: {
        run_id: 'run_missing',
        caller: 'submit',
        knowledge_ids: ['kc-1'],
        submit: {
          body: { answer_md: 'x' },
          question_id: 'q-1',
          submitted_at: '2026-09-20T00:00:00.000Z',
        },
      },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [pending]));
    const row = out.records.find((r) => r.source_id === 'p1');
    expect(row?.category).toBe('pending_blocked');
    expect(row?.native_target.kind).toBe('pending_carried');
    if (row?.native_target.kind === 'pending_carried') {
      const pending = row.native_target.pending;
      expect(pending.reason).toBe('infra_failure');
      if (pending.reason === 'infra_failure') {
        expect(pending.retryable).toBe(true);
      }
      expect(JSON.stringify(pending)).toContain('run_missing');
    }
  });

  it('已 backfill 的 judge_pending_attempt → pending_resolved_lineage', () => {
    const review = ev({
      id: 'run_present',
      action: 'review',
      outcome: 'success',
      payload: { rating: 2 },
    });
    const pending = ev({
      id: 'p2',
      action: 'experimental:judge_pending_attempt',
      outcome: null,
      payload: {
        run_id: 'run_present',
        caller: 'submit',
        knowledge_ids: [],
        submit: { question_id: 'q-1', submitted_at: '2026-09-20T00:00:00.000Z' },
      },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [review, pending]));
    expect(out.records.find((r) => r.source_id === 'p2')?.category).toBe(
      'pending_resolved_lineage',
    );
    expect(out.records.find((r) => r.source_id === 'run_present')?.category).toBe(
      'fsrs_review_lineage',
    );
  });

  it('缺 issued snapshot → historical_unresolved（不用当前 revision 补造）', () => {
    const attempt = attemptOf('a3', { answer_md: '旧答案' }); // 无 question_snapshot
    const judge = judgeEvent({
      id: 'j3',
      subject_id: 'a3',
      payload: { judge_route: 'semantic', coarse_outcome: 'correct' },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, judge]));
    expect(out.records.find((r) => r.source_id === 'a3')?.category).toBe('historical_unresolved');
    // 连带 judge 也无 submission 可挂 —— historical_unresolved。
    expect(out.records.find((r) => r.source_id === 'j3')?.category).toBe('historical_unresolved');
    const unresolvedEntry = out.unresolved.find((u) => u.source_id === 'a3');
    expect(unresolvedEntry?.source_locator).toBe('event:attempt:a3');
  });

  it('correction cycle（correct 触及 judge 链）→ 全链 correction_cycle_unresolved + deferred replay', () => {
    const attempt = attemptOf('a4', { answer_md: '2', question_snapshot: SNAPSHOT });
    const judge = judgeEvent({
      id: 'j4',
      subject_id: 'a4',
      payload: { judge_route: 'exact', coarse_outcome: 'correct' },
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

    expect(out.records.find((r) => r.source_id === 'a4')?.category).toBe(
      'correction_cycle_unresolved',
    );
    expect(out.records.find((r) => r.source_id === 'j4')?.category).toBe(
      'correction_cycle_unresolved',
    );
    expect(out.records.find((r) => r.source_id === 'j4b')?.category).toBe(
      'correction_cycle_unresolved',
    );
    expect(out.records.find((r) => r.source_id === 'c4')?.category).toBe(
      'correction_cycle_unresolved',
    );

    const replay = out.deferred_replay.find((d) => d.source_id === 'a4');
    expect(replay?.source_kind).toBe('correction_cycle');
    expect(replay?.affected_subject_ids).toContain('q-1');
  });

  it('correction 直接触及 attempt（无 judge）→ attempt 亦保持 unresolved', () => {
    const attempt = attemptOf('a5', { question_snapshot: SNAPSHOT });
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
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, correct]));
    expect(out.records.find((r) => r.source_id === 'a5')?.category).toBe(
      'correction_cycle_unresolved',
    );
  });
});

describe('classifyMigrationCapture — 其余 native 语义位', () => {
  it('attribution-only judge（仅 cause 无 verdict）→ attribution_only，永不冒充分数', () => {
    const attempt = attemptOf('a6', { question_snapshot: SNAPSHOT });
    const attributionJudge = judgeEvent({
      id: 'j6',
      subject_id: 'a6',
      payload: { cause: { primary_category: '概念不清', analysis_md: '...', confidence: 0.8 } },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, attributionJudge]));
    expect(out.records.find((r) => r.source_id === 'j6')?.category).toBe('attribution_only');
    // attempt 只有归因、没有 verdict —— 缺件 blocked，不猜。
    expect(out.records.find((r) => r.source_id === 'a6')?.category).toBe('pending_blocked');
  });

  it('attribution 占位（attribution_pending + verdict）→ judge=placeholder，attempt=complete', () => {
    const attempt = attemptOf('a7', { question_snapshot: SNAPSHOT });
    const placeholder = judgeEvent({
      id: 'j7',
      subject_id: 'a7',
      payload: { attribution_pending: true, coarse_outcome: 'incorrect', score: 0 },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, placeholder]));
    expect(out.records.find((r) => r.source_id === 'j7')?.category).toBe(
      'attribution_pending_placeholder',
    );
    expect(out.records.find((r) => r.source_id === 'a7')?.category).toBe('complete_attempt');
  });

  it('无 verdict 的占位 judge → attempt pending_blocked(needs_review)', () => {
    const attempt = attemptOf('a8', { question_snapshot: SNAPSHOT });
    const placeholder = judgeEvent({
      id: 'j8',
      subject_id: 'a8',
      payload: { attribution_pending: true },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt, placeholder]));
    const row = out.records.find((r) => r.source_id === 'a8');
    expect(row?.category).toBe('pending_blocked');
    if (row?.native_target.kind === 'pending_carried') {
      expect(row.native_target.pending.reason).toBe('needs_review');
    }
  });

  it('人工错题断言（learning_record mirror source=manual）→ human_import_assertion(human)', () => {
    const attempt = attemptOf('a9', { question_snapshot: SNAPSHOT, wrong_answer_md: '我写的' });
    const capture = emptyCapture();
    capture.rawFacts.learning_record_mirrors = [
      { id: 'lr9', kind: 'mistake', source: 'manual', attempt_event_id: 'a9', question_id: 'q-1' },
    ];
    const out = classifyMigrationCapture(withEvents(capture, [attempt]));
    const row = out.records.find((r) => r.source_id === 'a9');
    expect(row?.category).toBe('human_import_assertion');
    expect(row?.native_target).toEqual({ kind: 'manual_provenance_only', assertion: 'human' });
  });

  it('导入断言（enroll mirror source=import / generated_by）→ human_import_assertion(import)', () => {
    const attempt = attemptOf('a10', { question_snapshot: SNAPSHOT, generated_by: 'auto_capture' });
    const capture = emptyCapture();
    capture.rawFacts.learning_record_mirrors = [
      {
        id: 'lr10',
        kind: 'mistake',
        source: 'import',
        attempt_event_id: 'a10',
        question_id: 'q-1',
      },
    ];
    const out = classifyMigrationCapture(withEvents(capture, [attempt]));
    const row = out.records.find((r) => r.source_id === 'a10');
    expect(row?.category).toBe('human_import_assertion');
    expect(row?.native_target).toEqual({ kind: 'manual_provenance_only', assertion: 'import' });
  });

  it('unsupported_judge（已接收未判）→ pending_blocked(unjudgeable)，不是错答', () => {
    const attempt = attemptOf('a11', {
      question_snapshot: SNAPSHOT,
      unsupported_judge: true,
      answer_image_refs: ['asset-1'],
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [attempt]));
    const row = out.records.find((r) => r.source_id === 'a11');
    expect(row?.category).toBe('pending_blocked');
    if (row?.native_target.kind === 'pending_carried') {
      expect(row.native_target.pending.reason).toBe('unjudgeable');
    }
  });

  it('孤儿 judge（目标 attempt 不存在）→ historical_unresolved', () => {
    const judge = judgeEvent({
      id: 'j12',
      subject_id: 'missing-attempt',
      payload: { judge_route: 'exact', coarse_outcome: 'correct' },
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [judge]));
    expect(out.records.find((r) => r.source_id === 'j12')?.category).toBe('historical_unresolved');
  });

  it('FSRS review 事件 → fsrs_review_lineage（D15 用户评级 provenance，不是 submission）', () => {
    const review = ev({ id: 'r13', action: 'review', outcome: 'success', payload: { rating: 3 } });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [review]));
    const row = out.records.find((r) => r.source_id === 'r13');
    expect(row?.category).toBe('fsrs_review_lineage');
    expect(row?.native_target).toEqual({ kind: 'lineage_only' });
  });

  it('reproject_deferred 标记 → state_snapshot_lineage + deferred replay 工作清单', () => {
    const marker = ev({
      id: 'rp14',
      action: 'experimental:reproject_deferred',
      subject_kind: 'event',
      subject_id: 'some-judge',
      payload: {},
    });
    const out = classifyMigrationCapture(withEvents(emptyCapture(), [marker]));
    expect(out.records.find((r) => r.source_id === 'rp14')?.category).toBe(
      'state_snapshot_lineage',
    );
    expect(out.deferred_replay).toEqual([
      {
        source_kind: 'reproject_deferred_marker',
        source_id: 'rp14',
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
    const row = out.records.find((r) => r.source_id === 'ans1');
    expect(row?.category).toBe('live_draft');
    expect(row?.native_target).toEqual({ kind: 'draft_preserved' });
  });

  it('frozen answer 镜像其 attempt 分类', () => {
    const attempt = attemptOf('a15', { answer_md: '2', question_snapshot: SNAPSHOT });
    const judge = judgeEvent({
      id: 'j15',
      subject_id: 'a15',
      payload: { coarse_outcome: 'correct', score: 1 },
    });
    const out = classifyMigrationCapture(
      captureWithAnswers(
        [
          {
            id: 'ans15',
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
            event_id: 'a15',
          },
        ],
        [attempt, judge],
      ),
    );
    expect(out.records.find((r) => r.source_id === 'ans15')?.category).toBe('complete_attempt');
  });

  it('frozen 孤儿 answer（event_id 悬空）→ historical_unresolved', () => {
    const out = classifyMigrationCapture(
      captureWithAnswers([
        {
          id: 'ans16',
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
    expect(out.records.find((r) => r.source_id === 'ans16')?.category).toBe(
      'historical_unresolved',
    );
  });
});

describe('classifyMigrationCapture — 确定性与空形状', () => {
  it('空 capture（D19 形状：无 answers、少量 judge）→ 多为 historical_unresolved 或干净类别', () => {
    // D19 观测：114 questions / 0 answers / 9 judge events（其目标 attempt 可能缺）。
    const orphanJudges = [
      judgeEvent({
        id: 'cj-1',
        subject_id: 'old-1',
        payload: { coarse_outcome: 'correct', score: 1 },
      }),
      judgeEvent({
        id: 'cj-2',
        subject_id: 'old-2',
        payload: { judge_route: 'semantic', coarse_outcome: 'partial', score: 0.5 },
      }),
    ];
    const out = classifyMigrationCapture(withEvents(emptyCapture(), orphanJudges));
    expect(out.rollup.historical_unresolved).toBe(2);
    expect(out.records).toHaveLength(2);
  });

  it('完全空 capture → 空输出，无异常', () => {
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
