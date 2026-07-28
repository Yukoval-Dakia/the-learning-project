import { PROBE_RESOLUTION_RULE_VERSION } from '@/core/schema/conjecture';
import { event, question } from '@/db/schema';
import {
  type AccountabilityCandidate,
  loadPredictionAccountabilityByKey,
  rankEvidenceCellsByAccountability,
} from '@/server/conjectures/accountability';
import { gatherDissociationRecordsByIdentity } from '@/server/conjectures/hard-confirm';
import { eq } from 'drizzle-orm';
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
  options: { discriminating?: boolean } = {},
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
          target: { subject_kind: 'mind_model', subject_id: cellValue.knowledge_id },
          reason_md: 'accountability test fixture',
          evidence_refs: [{ kind: 'event', id: `evidence_${id}` }],
          cooldown_key: `conjecture:${id}`,
          proposed_change: {
            claim_md: `claim ${id}`,
            cause_category: cellValue.cause_category,
            knowledge_id: cellValue.knowledge_id,
            confidence: 0.7,
            recurrence_count: 2,
            probe_md: `probe ${id}`,
            probe_reference_md: `reference ${id}`,
            followup_probe_md: `followup ${id}`,
            followup_probe_reference_md: `followup reference ${id}`,
            discriminating: options.discriminating ?? true,
            predicted_p: 0.2,
            baseline_p_at_induction: 0.8,
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
    includeProbeQuestionId?: boolean;
  } = {},
): Promise<void> {
  const probeResultId = `result_${id}`;
  const questionId = `question_${id}`;
  const resolution = options.resolution ?? (outcome === 0 ? 'evidence_for' : 'retired');
  await writeProbeQuestion(questionId, conjectureId, cellValue.knowledge_id, 1, minute);
  await writeProbeResult(probeResultId, conjectureId, questionId, minute, resolution, outcome);
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
        ...(options.includeProbeQuestionId === false ? {} : { probe_question_id: questionId }),
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

async function writeProbeQuestion(
  id: string,
  conjectureId: string,
  knowledgeId: string,
  sequence: 1 | 2,
  minute: number,
): Promise<void> {
  const now = new Date(`2026-07-28T10:${String(minute).padStart(2, '0')}:30.000Z`);
  await testDb()
    .insert(question)
    .values({
      id,
      kind: 'short_answer',
      prompt_md: sequence === 1 ? `probe ${conjectureId}` : `followup ${conjectureId}`,
      reference_md:
        sequence === 1 ? `reference ${conjectureId}` : `followup reference ${conjectureId}`,
      knowledge_ids: [knowledgeId],
      source: 'mind_probe',
      source_ref: conjectureId,
      draft_status: 'draft',
      metadata: {
        conjecture_proposal_id: conjectureId,
        probe_sequence: sequence,
      },
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();
}

async function writeProbeResult(
  id: string,
  conjectureId: string,
  questionId: string,
  minute: number,
  resolution: 'evidence_for' | 'confirmed' | 'retired' = 'evidence_for',
  outcome: 0 | 1 = resolution === 'retired' ? 1 : 0,
  independentProbeQuestionIds?: readonly string[],
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
        outcome,
        resolution,
        ...(independentProbeQuestionIds
          ? {
              resolution_rule_version: PROBE_RESOLUTION_RULE_VERSION,
              independent_probe_question_ids: [...independentProbeQuestionIds],
            }
          : {}),
      },
      caused_by_event_id: conjectureId,
      created_at: new Date(`2026-07-28T11:${String(minute).padStart(2, '0')}:00.000Z`),
    })
    .onConflictDoNothing();
}

async function writeTerminalProjection(
  id: string,
  conjectureId: string,
  cellValue: AccountabilityCandidate,
  preliminaryQuestionId: string,
  minute: number,
): Promise<void> {
  const probeResultId = `result_${id}`;
  const terminalQuestionId = `question_${id}`;
  const lineage = [preliminaryQuestionId, terminalQuestionId];
  await writeProbeQuestion(terminalQuestionId, conjectureId, cellValue.knowledge_id, 2, minute);
  await writeProbeResult(
    probeResultId,
    conjectureId,
    terminalQuestionId,
    minute,
    'confirmed',
    0,
    lineage,
  );
  await testDb()
    .insert(event)
    .values({
      id,
      actor_kind: 'system',
      actor_ref: 'research_meeting',
      action: 'experimental:probe_result_projected',
      subject_kind: 'event',
      subject_id: probeResultId,
      payload: {
        conjecture_event_id: conjectureId,
        probe_result_event_id: probeResultId,
        probe_question_id: terminalQuestionId,
        knowledge_id: cellValue.knowledge_id,
        outcome: 0,
        resolution: 'confirmed',
        projection_kind: 'recurrence_without_prediction',
        independent_probe_question_ids: lineage,
      },
      created_at: new Date(`2026-07-28T11:${String(minute).padStart(2, '0')}:30.000Z`),
    });
}

describe('loadPredictionAccountabilityByKey (YUK-795)', () => {
  beforeEach(resetDb);

  it('isolates duplicate identity aliases without aborting the accountability batch', async () => {
    const target = cell('concept::kc_collision', 2);
    const alias = { ...target, key: 'unexpected_alias' };

    const profiles = await loadPredictionAccountabilityByKey(testDb(), [target, alias]);
    expect(profiles.get(target.key)?.state).toBe('watch');
    expect(profiles.get(alias.key)?.state).toBe('watch');
  });

  it('rejects a mis-stamped score when both payload and proposal KCs are in the batch', async () => {
    const payloadTarget = cell('concept::kc_payload', 2);
    const proposalTarget = cell('concept::kc_proposal', 2);
    await writeConjecture('conjecture_cross_kc', proposalTarget, 1);
    await writeScore('score_cross_kc', 'conjecture_cross_kc', payloadTarget, 0, 1);

    const profiles = await loadPredictionAccountabilityByKey(testDb(), [
      payloadTarget,
      proposalTarget,
    ]);

    expect(profiles.get(payloadTarget.key)).toMatchObject({
      state: 'watch',
      score_event_ids: [],
    });
    expect(profiles.get(proposalTarget.key)).toMatchObject({
      state: 'watch',
      score_event_ids: [],
    });
  });

  it('rejects a score anchor that borrows an active result from another conjecture', async () => {
    const sourceTarget = cell('concept::kc_source', 2);
    const forgedTarget = cell('method::kc_forged', 2);
    await writeConjecture('conjecture_source', sourceTarget, 1);
    await writeConjecture('conjecture_forged', forgedTarget, 2);
    await writeScore('score_source', 'conjecture_source', sourceTarget, 0, 1);

    await testDb()
      .insert(event)
      .values({
        id: 'score_forged_anchor',
        actor_kind: 'system',
        actor_ref: 'research_meeting',
        action: 'experimental:prediction_score',
        subject_kind: 'event',
        subject_id: 'result_score_source',
        payload: {
          conjecture_event_id: 'conjecture_forged',
          probe_result_event_id: 'result_score_source',
          probe_question_id: 'question_forged',
          knowledge_id: forgedTarget.knowledge_id,
          predicted_p: 0.2,
          baseline_p: 0.8,
          outcome: 0,
          resolution: 'evidence_for',
          discriminating: true,
          context: 'forged',
        },
        created_at: new Date('2026-07-28T11:02:00.000Z'),
      });

    const profiles = await loadPredictionAccountabilityByKey(testDb(), [forgedTarget]);
    expect(profiles.get(forgedTarget.key)).toMatchObject({
      state: 'watch',
      consecutive_count: 0,
      score_event_ids: [],
    });
  });

  it.each([
    ['predicted probability', { predicted_p: 0.9, baseline_p: 0.8 }],
    ['baseline probability', { predicted_p: 0.2, baseline_p: 0.1 }],
  ] as const)(
    'rejects a score anchor whose %s drifts from the proposal',
    async (label, probabilities) => {
      const target = cell(`concept::kc_probability_${label.replace(' ', '_')}`, 2);
      const conjectureId = `conjecture_probability_${label.replace(' ', '_')}`;
      const questionId = `question_probability_${label.replace(' ', '_')}`;
      const resultId = `result_probability_${label.replace(' ', '_')}`;
      await writeConjecture(conjectureId, target, 1);
      await writeProbeQuestion(questionId, conjectureId, target.knowledge_id, 1, 1);
      await writeProbeResult(resultId, conjectureId, questionId, 1, 'evidence_for', 0);

      await testDb()
        .insert(event)
        .values({
          id: `score_probability_${label.replace(' ', '_')}`,
          actor_kind: 'system',
          actor_ref: 'research_meeting',
          action: 'experimental:prediction_score',
          subject_kind: 'event',
          subject_id: resultId,
          payload: {
            conjecture_event_id: conjectureId,
            probe_result_event_id: resultId,
            probe_question_id: questionId,
            knowledge_id: target.knowledge_id,
            ...probabilities,
            outcome: 0,
            resolution: 'evidence_for',
            discriminating: true,
            context: 'symbolic',
          },
          created_at: new Date('2026-07-28T11:01:00.000Z'),
        });

      const profiles = await loadPredictionAccountabilityByKey(testDb(), [target]);
      expect(profiles.get(target.key)).toMatchObject({
        state: 'watch',
        consecutive_count: 0,
        score_event_ids: [],
      });
    },
  );

  it('rejects a score that changes the proposal-authored discriminating fact', async () => {
    const target = cell('concept::kc_discriminating_drift', 2);
    await writeConjecture('conjecture_discriminating_drift', target, 1, {
      discriminating: false,
    });
    await writeScore('score_discriminating_drift', 'conjecture_discriminating_drift', target, 0, 1);

    const profiles = await loadPredictionAccountabilityByKey(testDb(), [target]);
    expect(profiles.get(target.key)).toMatchObject({
      state: 'watch',
      consecutive_count: 0,
      score_event_ids: [],
    });
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

  it('drops anchored direct evidence after its proposal-specific question chain drifts', async () => {
    const target = cell('concept::kc_stale_question', 2);
    await writeConjecture('conjecture_stale_question', target, 1);
    await writeScore('score_stale_question', 'conjecture_stale_question', target, 0, 1);

    const before = await loadPredictionAccountabilityByKey(testDb(), [target]);
    expect(before.get(target.key)?.consecutive_count).toBe(1);

    await testDb()
      .update(question)
      .set({ prompt_md: 'generic edit changed the tested claim', version: 1 })
      .where(eq(question.id, 'question_score_stale_question'));

    const after = await loadPredictionAccountabilityByKey(testDb(), [target]);
    expect(after.get(target.key)).toMatchObject({
      state: 'watch',
      consecutive_count: 0,
      score_event_ids: [],
    });
  });

  it.each([
    ['reference', { reference_md: 'edited reference' }],
    ['choices', { choices_md: ['A', 'B'] as string[] }],
    ['kind', { kind: 'choice' }],
  ] as const)(
    'drops anchored direct evidence after its %s grading contract changes',
    async (label, patch) => {
      const target = cell(`concept::kc_stale_${label}`, 2);
      const conjectureId = `conjecture_stale_${label}`;
      const scoreId = `score_stale_${label}`;
      await writeConjecture(conjectureId, target, 1);
      await writeScore(scoreId, conjectureId, target, 0, 1);

      await testDb()
        .update(question)
        .set({ ...patch, version: 1 })
        .where(eq(question.id, `question_${scoreId}`));

      const profile = await loadPredictionAccountabilityByKey(testDb(), [target]);
      expect(profile.get(target.key)).toMatchObject({
        state: 'watch',
        consecutive_count: 0,
        score_event_ids: [],
      });
    },
  );

  it('drops anchored direct evidence after the owner retracts its source proposal', async () => {
    const target = cell('concept::kc_retracted_proposal', 2);
    const conjectureId = 'conjecture_retracted_proposal';
    await writeConjecture(conjectureId, target, 1);
    await writeScore('score_retracted_proposal', conjectureId, target, 0, 1);

    await testDb()
      .insert(event)
      .values({
        id: 'correction_retracted_proposal',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'correct',
        subject_kind: 'event',
        subject_id: conjectureId,
        outcome: 'success',
        payload: {
          correction_kind: 'retract',
          reason_md: 'the conjecture was withdrawn',
          affected_refs: [{ kind: 'open_inquiry', id: conjectureId }],
        },
        created_at: new Date('2026-07-28T12:00:00.000Z'),
      });

    const profile = await loadPredictionAccountabilityByKey(testDb(), [target]);
    expect(profile.get(target.key)).toMatchObject({
      state: 'watch',
      consecutive_count: 0,
      score_event_ids: [],
    });
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

  it('folds a corrected prediction-score anchor out of the live streak', async () => {
    const target = cell('concept::kc_corrected_anchor', 2);
    await writeConjecture('conjecture_anchor_1', target, 1);
    await writeConjecture('conjecture_anchor_2', target, 2);
    await writeScore('score_anchor_1', 'conjecture_anchor_1', target, 0, 1);
    await writeScore('score_anchor_2', 'conjecture_anchor_2', target, 0, 2);

    const before = await loadPredictionAccountabilityByKey(testDb(), [target]);
    expect(before.get(target.key)?.state).toBe('supported');

    await testDb()
      .insert(event)
      .values({
        id: 'correction_score_anchor_2',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'correct',
        subject_kind: 'event',
        subject_id: 'score_anchor_2',
        outcome: 'success',
        payload: {
          correction_kind: 'mark_wrong',
          reason_md: 'the derived score anchor was invalid',
          affected_refs: [{ kind: 'open_inquiry', id: 'score_anchor_2' }],
        },
        created_at: new Date('2026-07-28T12:00:00.000Z'),
      });

    const corrected = await loadPredictionAccountabilityByKey(testDb(), [target]);
    expect(corrected.get(target.key)).toMatchObject({
      state: 'watch',
      consecutive_count: 1,
      score_event_ids: ['score_anchor_1'],
    });
  });

  it('orders dissociation by terminal confirmation while preserving score streak chronology', async () => {
    const target = cell('concept::kc_confirmation_time', 2);
    await writeConjecture('conjecture_timeline_confirm', target, 1);
    await writeConjecture('conjecture_timeline_retired', target, 2);
    await writeScore('score_timeline_confirm', 'conjecture_timeline_confirm', target, 0, 1, {
      resolution: 'evidence_for',
      mDiagnostic: true,
      context: 'symbolic',
      // Pre-YUK-795 anchors omitted probe_question_id; the reader must
      // recover it from the immutable backing probe_result envelope.
      includeProbeQuestionId: false,
    });
    await writeScore('score_timeline_retired', 'conjecture_timeline_retired', target, 1, 2, {
      resolution: 'retired',
      mDiagnostic: true,
      context: 'transfer',
    });
    await writeTerminalProjection(
      'projection_timeline_confirm',
      'conjecture_timeline_confirm',
      target,
      'question_score_timeline_confirm',
      3,
    );

    const profiles = await loadPredictionAccountabilityByKey(testDb(), [target]);

    expect(profiles.get(target.key)).toMatchObject({
      // Dissociation sees retired@02 followed by confirmation@03, so the
      // terminal confirmation resets the asymmetry counter.
      hard_confirm_verdict: 'EMERGING',
      // Prediction accountability still orders the calibrated scores at
      // sequence-1@01 then retired@02; the score-free terminal event does not
      // reorder or fabricate a prediction.
      latest_direction: 'miss',
      consecutive_count: 1,
      rank_multiplier: 1,
    });
  });

  it('does not confirm a score from projection lineage that disagrees with its source result', async () => {
    const target = cell('concept::kc_lineage_drift', 2);
    const conjectureId = 'conjecture_lineage_drift';
    const preliminaryQuestionId = 'question_score_lineage_drift';
    const terminalQuestionId = 'question_terminal_lineage_drift';
    const terminalResultId = 'result_terminal_lineage_drift';
    await writeConjecture(conjectureId, target, 1);
    await writeScore('score_lineage_drift', conjectureId, target, 0, 1, {
      resolution: 'evidence_for',
    });
    await writeProbeQuestion(terminalQuestionId, conjectureId, target.knowledge_id, 2, 2);
    await writeProbeResult(terminalResultId, conjectureId, terminalQuestionId, 2, 'confirmed', 0, [
      preliminaryQuestionId,
      terminalQuestionId,
    ]);
    await testDb()
      .insert(event)
      .values({
        id: 'projection_lineage_drift',
        actor_kind: 'system',
        actor_ref: 'research_meeting',
        action: 'experimental:probe_result_projected',
        subject_kind: 'event',
        subject_id: terminalResultId,
        payload: {
          conjecture_event_id: conjectureId,
          probe_result_event_id: terminalResultId,
          probe_question_id: terminalQuestionId,
          knowledge_id: target.knowledge_id,
          outcome: 0,
          resolution: 'confirmed',
          discriminating: true,
          projection_kind: 'recurrence_without_prediction',
          independent_probe_question_ids: ['question_from_another_claim', terminalQuestionId],
        },
        created_at: new Date('2026-07-28T11:02:30.000Z'),
      });

    const records = await gatherDissociationRecordsByIdentity(testDb(), [
      {
        key: target.key,
        causeCategory: target.cause_category,
        knowledgeId: target.knowledge_id,
      },
    ]);
    expect(records.get(target.key)).toHaveLength(1);
    expect(records.get(target.key)?.[0]?.resolution).toBe('evidence_for');
  });

  it('consumes the live hard-confirm flag without allowing the nightly caller to hard-confirm', async () => {
    const target = cell('concept::kc_emerging', 2);
    await writeConjecture('conjecture_emerging_1', target, 1);
    await writeConjecture('conjecture_emerging_2', target, 2);
    await writeScore('score_emerging_1', 'conjecture_emerging_1', target, 0, 1, {
      resolution: 'evidence_for',
      mDiagnostic: true,
      context: 'symbolic',
    });
    await writeScore('score_emerging_2', 'conjecture_emerging_2', target, 0, 2, {
      resolution: 'evidence_for',
      mDiagnostic: true,
      context: 'transfer',
    });
    // Production v2 never writes a confirmed prediction_score. Each terminal
    // sequence-2 result is score-free and confirms the calibrated sequence-1
    // observation through immutable question lineage.
    await writeTerminalProjection(
      'projection_emerging_1',
      'conjecture_emerging_1',
      target,
      'question_score_emerging_1',
      3,
    );
    await writeTerminalProjection(
      'projection_emerging_2',
      'conjecture_emerging_2',
      target,
      'question_score_emerging_2',
      4,
    );

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

      await testDb()
        .insert(event)
        .values([
          {
            id: 'correction_projection_emerging_1',
            actor_kind: 'user',
            actor_ref: 'self',
            action: 'correct',
            subject_kind: 'event',
            subject_id: 'projection_emerging_1',
            outcome: 'success',
            payload: {
              correction_kind: 'retract',
              reason_md: 'the first terminal projection was invalid',
              affected_refs: [{ kind: 'open_inquiry', id: 'projection_emerging_1' }],
            },
            created_at: new Date('2026-07-28T12:00:00.000Z'),
          },
          {
            id: 'correction_projection_emerging_2',
            actor_kind: 'user',
            actor_ref: 'self',
            action: 'correct',
            subject_kind: 'event',
            subject_id: 'projection_emerging_2',
            outcome: 'success',
            payload: {
              correction_kind: 'retract',
              reason_md: 'the second terminal projection was invalid',
              affected_refs: [{ kind: 'open_inquiry', id: 'projection_emerging_2' }],
            },
            created_at: new Date('2026-07-28T12:00:01.000Z'),
          },
        ]);
      const correctedProjection = await loadPredictionAccountabilityByKey(testDb(), [target]);
      expect(correctedProjection.get(target.key)).toMatchObject({
        state: 'supported',
        rank_multiplier: 1.15,
        hard_confirm_verdict: 'INSUFFICIENT',
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
