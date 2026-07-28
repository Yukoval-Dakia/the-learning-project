import { event } from '@/db/schema';
import {
  type AccountabilityCandidate,
  loadPredictionAccountabilityByKey,
  rankEvidenceCellsByAccountability,
} from '@/server/conjectures/accountability';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

function cell(key: string, recurrence: number): AccountabilityCandidate {
  const [cause, knowledgeId] = key.split('::');
  return {
    key,
    cause_category: cause,
    knowledge_id: knowledgeId,
    recurrence_count: recurrence,
    probe_here: true,
  };
}

async function writeConjecture(
  id: string,
  cellValue: AccountabilityCandidate,
  minute: number,
): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      id,
      actor_kind: 'agent',
      actor_ref: 'research_meeting',
      action: 'experimental:proposal',
      subject_kind: 'mind_model',
      subject_id: cellValue.knowledge_id,
      payload: {
        ai_proposal: {
          kind: 'conjecture',
          proposed_change: {
            cause_category: cellValue.cause_category,
            knowledge_id: cellValue.knowledge_id,
          },
        },
      },
      created_at: new Date(`2026-07-28T10:${String(minute).padStart(2, '0')}:00.000Z`),
    });
}

async function writeScore(
  id: string,
  conjectureId: string,
  cellValue: AccountabilityCandidate,
  outcome: 0 | 1,
  minute: number,
  options: {
    resolution?: 'evidence_for' | 'confirmed' | 'retired';
    mDiagnostic?: boolean;
    context?: string;
    anchorCreatedAt?: Date;
  } = {},
): Promise<void> {
  const probeResultId = `result_${id}`;
  const resolution = options.resolution ?? (outcome === 0 ? 'evidence_for' : 'retired');
  await writeProbeResult(probeResultId, conjectureId, `question_${id}`, minute, resolution);
  await testDb()
    .insert(event)
    .values({
      id,
      actor_kind: 'system',
      actor_ref: 'research_meeting',
      action: 'experimental:prediction_score',
      subject_kind: 'event',
      subject_id: probeResultId,
      payload: {
        conjecture_event_id: conjectureId,
        probe_result_event_id: probeResultId,
        probe_question_id: `question_${id}`,
        knowledge_id: cellValue.knowledge_id,
        predicted_p: 0.2,
        baseline_p: 0.8,
        outcome,
        resolution,
        discriminating: true,
        ...(options.mDiagnostic === undefined ? {} : { m_diagnostic: options.mDiagnostic }),
        context: options.context ?? `question_${id}`,
      },
      created_at:
        options.anchorCreatedAt ??
        new Date(`2026-07-28T11:${String(minute).padStart(2, '0')}:00.000Z`),
    });
}

async function writeProbeResult(
  id: string,
  conjectureId: string,
  questionId: string,
  minute: number,
  resolution: 'evidence_for' | 'confirmed' | 'retired' = 'evidence_for',
): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      id,
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: 'experimental:probe_result',
      subject_kind: 'question',
      subject_id: questionId,
      payload: {
        conjecture_event_id: conjectureId,
        outcome: 0,
        resolution,
      },
      caused_by_event_id: conjectureId,
      created_at: new Date(`2026-07-28T11:${String(minute).padStart(2, '0')}:00.000Z`),
    })
    .onConflictDoNothing();
}

describe('loadPredictionAccountabilityByKey (YUK-795)', () => {
  beforeEach(resetDb);

  it('fails loudly when two output keys alias the same conjecture identity', async () => {
    const target = cell('concept::kc_collision', 2);
    const alias = { ...target, key: 'unexpected_alias' };

    await expect(loadPredictionAccountabilityByKey(testDb(), [target, alias])).rejects.toThrow(
      'Duplicate conjecture identity target concept × kc_collision',
    );
  });

  it('turns repeated prediction misses into an observable candidate downweight', async () => {
    const target = cell('concept::kc_high', 4);
    const neutral = cell('method::kc_neutral', 2);
    await writeConjecture('conjecture_miss_1', target, 1);
    await writeConjecture('conjecture_miss_2', target, 2);
    await writeScore('score_miss_1', 'conjecture_miss_1', target, 1, 1);
    await writeScore('score_miss_2', 'conjecture_miss_2', target, 1, 2);

    const profiles = await loadPredictionAccountabilityByKey(testDb(), [target, neutral]);

    expect(profiles.get(target.key)).toMatchObject({
      state: 'downweighted',
      latest_direction: 'miss',
      consecutive_count: 2,
      rank_multiplier: 0.25,
      hard_confirm_verdict: 'INSUFFICIENT',
    });
    expect(
      rankEvidenceCellsByAccountability([target, neutral], profiles).map(
        (candidate) => candidate.key,
      ),
    ).toEqual([neutral.key, target.key]);
  });

  it('turns persistent hits into an observable boost while one hit remains neutral', async () => {
    const target = cell('concept::kc_target', 2);
    await writeConjecture('conjecture_hit_1', target, 1);
    await writeScore('score_hit_1', 'conjecture_hit_1', target, 0, 1);

    const once = await loadPredictionAccountabilityByKey(testDb(), [target]);
    expect(once.get(target.key)).toMatchObject({
      state: 'watch',
      consecutive_count: 1,
      rank_multiplier: 1,
    });

    await writeConjecture('conjecture_hit_2', target, 2);
    await writeScore('score_hit_2', 'conjecture_hit_2', target, 0, 2);
    const repeated = await loadPredictionAccountabilityByKey(testDb(), [target]);
    expect(repeated.get(target.key)).toMatchObject({
      state: 'supported',
      latest_direction: 'hit',
      consecutive_count: 2,
      rank_multiplier: 1.15,
      hard_confirm_verdict: 'INSUFFICIENT',
    });
  });

  it('orders legacy same-batch score anchors by their backing probe-result timestamps', async () => {
    const target = cell('concept::kc_legacy_chronology', 2);
    const legacyBatchTime = new Date('2026-07-28T23:00:00.000Z');
    await writeConjecture('conjecture_legacy_1', target, 1);
    await writeConjecture('conjecture_legacy_2', target, 2);
    await writeConjecture('conjecture_legacy_3', target, 3);
    // Event ids sort hit/hit/miss, but source time is miss/hit/hit. Pre-YUK-795
    // anchors shared one nightly created_at, so the reader must recover chronology
    // from the immutable backing probe results rather than opaque score ids.
    await writeScore('z_miss_oldest', 'conjecture_legacy_1', target, 1, 1, {
      anchorCreatedAt: legacyBatchTime,
    });
    await writeScore('a_hit_middle', 'conjecture_legacy_2', target, 0, 2, {
      anchorCreatedAt: legacyBatchTime,
    });
    await writeScore('b_hit_latest', 'conjecture_legacy_3', target, 0, 3, {
      anchorCreatedAt: legacyBatchTime,
    });

    const profiles = await loadPredictionAccountabilityByKey(testDb(), [target]);

    expect(profiles.get(target.key)).toMatchObject({
      state: 'supported',
      latest_direction: 'hit',
      consecutive_count: 2,
      rank_multiplier: 1.15,
    });
  });

  it('folds a corrected score out and restores it without rewriting score history', async () => {
    const target = cell('concept::kc_correctable', 2);
    await writeConjecture('conjecture_correctable_1', target, 1);
    await writeConjecture('conjecture_correctable_2', target, 2);
    await writeProbeResult('result_score_correctable_1', 'conjecture_correctable_1', 'q_1', 1);
    await writeProbeResult('result_score_correctable_2', 'conjecture_correctable_2', 'q_2', 2);
    await writeScore('score_correctable_1', 'conjecture_correctable_1', target, 0, 1);
    await writeScore('score_correctable_2', 'conjecture_correctable_2', target, 0, 2);

    const before = await loadPredictionAccountabilityByKey(testDb(), [target]);
    expect(before.get(target.key)?.state).toBe('supported');

    await testDb()
      .insert(event)
      .values({
        id: 'correction_score_correctable_2',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'correct',
        subject_kind: 'event',
        subject_id: 'result_score_correctable_2',
        outcome: 'success',
        payload: {
          correction_kind: 'retract',
          reason_md: 'the second probe result was invalid',
          affected_refs: [{ kind: 'open_inquiry', id: 'result_score_correctable_2' }],
        },
        created_at: new Date('2026-07-28T12:00:00.000Z'),
      });
    const corrected = await loadPredictionAccountabilityByKey(testDb(), [target]);
    expect(corrected.get(target.key)).toMatchObject({
      state: 'watch',
      consecutive_count: 1,
      rank_multiplier: 1,
    });

    await testDb()
      .insert(event)
      .values({
        id: 'restore_score_correctable_2',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'correct',
        subject_kind: 'event',
        subject_id: 'result_score_correctable_2',
        outcome: 'success',
        payload: {
          correction_kind: 'restore',
          reason_md: 'the second probe result was revalidated',
          affected_refs: [{ kind: 'open_inquiry', id: 'result_score_correctable_2' }],
        },
        created_at: new Date('2026-07-28T12:01:00.000Z'),
      });
    const restored = await loadPredictionAccountabilityByKey(testDb(), [target]);
    expect(restored.get(target.key)?.state).toBe('supported');
  });

  it('consumes the live hard-confirm flag without allowing the nightly caller to hard-confirm', async () => {
    const target = cell('concept::kc_emerging', 2);
    await writeConjecture('conjecture_emerging_1', target, 1);
    await writeConjecture('conjecture_emerging_2', target, 2);
    await writeScore('score_emerging_1', 'conjecture_emerging_1', target, 0, 1, {
      resolution: 'confirmed',
      mDiagnostic: true,
      context: 'symbolic',
    });
    await writeScore('score_emerging_2', 'conjecture_emerging_2', target, 0, 2, {
      resolution: 'confirmed',
      mDiagnostic: true,
      context: 'transfer',
    });

    const original = process.env.MISCONCEPTION_HARD_CONFIRM_ENABLED;
    try {
      process.env.MISCONCEPTION_HARD_CONFIRM_ENABLED = '0';
      const disabled = await loadPredictionAccountabilityByKey(testDb(), [target]);
      expect(disabled.get(target.key)).toMatchObject({
        state: 'supported',
        rank_multiplier: 1.15,
        hard_confirm_verdict: 'EMERGING',
        hard_confirm_enabled: false,
      });

      process.env.MISCONCEPTION_HARD_CONFIRM_ENABLED = '1';
      const enabled = await loadPredictionAccountabilityByKey(testDb(), [target]);
      expect(enabled.get(target.key)).toMatchObject({
        state: 'supported',
        rank_multiplier: 1.25,
        // ownerFreshlyConfirmed is hard-coded false in the nightly reader, so
        // even flag-on evidence can only be EMERGING, never HARD_CONFIRM.
        hard_confirm_verdict: 'EMERGING',
        hard_confirm_enabled: true,
      });
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(process.env, 'MISCONCEPTION_HARD_CONFIRM_ENABLED');
      } else {
        process.env.MISCONCEPTION_HARD_CONFIRM_ENABLED = original;
      }
    }
  });
});
