// YUK-567 slice-2 — loadActiveProbes read model. A probe is "active" (in the 待你试做
// queue) while its mind_probe question has no experimental:probe_result event; once
// answered it drops out. Ordered newest-first, capped at ACTIVE_PROBES_MAX.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { answerProbe, serveProbeOnce, servePublishedProbe } from '@/capabilities/agency/public';
import { PrepDeskProbesResponseSchema } from '@/capabilities/shell/api/contracts';
import { assessment_issuance, event, question, question_group_lifecycle } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { publishPaperModelFixture } from '../../../../tests/fixtures/assessment-paper';

import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from '../api/prep-desk-probes';
import { loadActiveProbes } from './prep-desk-probes';

let seq = 0;
async function serve(
  probeMd: string,
  now: Date,
  admitted = true,
): Promise<{ probeQuestionId: string; conjectureProposalId: string }> {
  seq += 1;
  const conjectureProposalId = `conj_${seq}`;
  await writeAiProposal(testDb(), {
    id: conjectureProposalId,
    actor_ref: 'research_meeting',
    created_at: now,
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: 'kn_x' },
      reason_md: 'fixture evidence for an active probe',
      evidence_refs: [{ kind: 'event', id: `evidence_${seq}` }],
      cooldown_key: `conjecture:prep-desk-probe:${seq}`,
      proposed_change: {
        claim_md: `fixture conjecture ${seq}`,
        knowledge_id: 'kn_x',
        cause_category: 'concept_misunderstanding',
        confidence: 0.7,
        recurrence_count: 2,
        probe_md: probeMd,
        probe_reference_md: `reference ${seq}`,
        discriminating: true,
        predicted_p: 0.3,
        baseline_p_at_induction: 0.6,
      },
    },
  });
  await writeEvent(testDb(), {
    id: `rate_${conjectureProposalId}`,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: conjectureProposalId,
    outcome: 'success',
    payload: {
      rating: 'accept',
      conjecture_id: conjectureProposalId,
      calibration_anchor: 'accept',
    },
    caused_by_event_id: conjectureProposalId,
  });
  const served = await serveProbeOnce({
    db: testDb(),
    conjectureProposalId,
    knowledgeId: 'kn_x',
    probeMd,
    referenceMd: `reference ${seq}`,
    now,
  });
  if (served.status !== 'served') throw new Error(`expected served, got ${served.status}`);
  if (admitted) {
    await publishPaperModelFixture(testDb(), served.probe_question_id);
    await servePublishedProbe(testDb(), served.probe_question_id);
  }
  return { probeQuestionId: served.probe_question_id, conjectureProposalId };
}

describe('loadActiveProbes', () => {
  beforeEach(async () => {
    await resetDb();
    seq = 0;
  });

  it('withholds unadmitted probes and serves a frozen occurrence only after admission', async () => {
    const probe = await serve('原始题干：说明链式法则中的内层导数。', new Date(), false);
    expect(await loadActiveProbes(testDb())).toEqual({ probes: [] });
    expect(await testDb().select().from(assessment_issuance)).toHaveLength(0);
    expect(
      await testDb()
        .select()
        .from(question_group_lifecycle)
        .where(
          and(
            eq(question_group_lifecycle.group_id, probe.probeQuestionId),
            eq(question_group_lifecycle.scoring_admission_state, 'withheld'),
          ),
        ),
    ).toHaveLength(1);
    const nextContract = await publishPaperModelFixture(testDb(), probe.probeQuestionId);
    await servePublishedProbe(testDb(), probe.probeQuestionId);
    const served = await loadActiveProbes(testDb());
    expect(served.probes).toHaveLength(1);
    await testDb()
      .update(question)
      .set({ prompt_md: '不应重新读取的 mutable 题干' })
      .where(eq(question.id, probe.probeQuestionId));
    expect(await loadActiveProbes(testDb())).toEqual(served);
    expect(await testDb().select().from(assessment_issuance)).toHaveLength(1);
    const [lifecycle] = await testDb()
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, probe.probeQuestionId));
    nextContract.structure.parts[0].prompt_md = '下一版题干：不能替换已经送达的探针。';
    nextContract.integrity_digest = contractIntegrityDigest(nextContract);
    expect(
      await publishQuestionGroup(testDb(), {
        group_id: probe.probeQuestionId,
        contract: nextContract,
        expectedCurrentRevision: lifecycle.current_revision_id,
        expectedAdmissionGeneration: lifecycle.scoring_admission_generation,
        availability: lifecycle.availability,
        actorRef: 'test:later-probe-publication',
        now: new Date(),
        admission: { state: 'admitted', evidence: lifecycle.scoring_admission_evidence },
      }),
    ).toMatchObject({ status: 'published' });
    expect(await servePublishedProbe(testDb(), probe.probeQuestionId)).toMatchObject({
      status: 'replayed',
    });
    expect(await loadActiveProbes(testDb())).toEqual(served);
    expect(await testDb().select().from(assessment_issuance)).toHaveLength(1);
  });

  it('reading an admitted, unissued probe never writes an issuance', async () => {
    const probe = await serve('等待显式发题的探针：请解释非零分母的条件。', new Date(), false);
    await publishPaperModelFixture(testDb(), probe.probeQuestionId);
    const before = await testDb().select().from(assessment_issuance);
    const eventsBefore = await testDb().select().from(event);
    const lifecycleBefore = await testDb().select().from(question_group_lifecycle);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ probes: [] });
    await GET();
    expect(await testDb().select().from(assessment_issuance)).toEqual(before);
    expect(await testDb().select().from(event)).toEqual(eventsBefore);
    expect(await testDb().select().from(question_group_lifecycle)).toEqual(lifecycleBefore);
  });

  it('lists served-but-unanswered probes, newest first', async () => {
    const p1 = await serve('probe A', new Date('2026-07-13T00:00:01Z'));
    const p2 = await serve('probe B', new Date('2026-07-13T00:00:02Z'));

    const { probes } = await loadActiveProbes(testDb());
    expect(() => PrepDeskProbesResponseSchema.parse({ probes })).not.toThrow();
    expect(probes.map((p) => p.probe_question_id)).toEqual([
      p2.probeQuestionId,
      p1.probeQuestionId,
    ]); // newest first
    expect(probes[0]).toMatchObject({ prompt_md: 'probe B', knowledge_id: 'kn_x' });
  });

  it('excludes answered probes (those with a probe_result event)', async () => {
    const p1 = await serve('unanswered', new Date('2026-07-13T00:00:01Z'));
    const p2 = await serve('answered', new Date('2026-07-13T00:00:02Z'));
    await answerProbe({ db: testDb(), probeQuestionId: p2.probeQuestionId, outcome: 1 });

    const { probes } = await loadActiveProbes(testDb());
    expect(probes.map((p) => p.probe_question_id)).toEqual([p1.probeQuestionId]);
  });

  it('excludes corrected conjectures without letting newer stale probes hide active ones', async () => {
    const active = await serve('active probe', new Date('2026-07-13T00:00:01Z'));
    const stale = await serve('stale probe', new Date('2026-07-13T00:00:02Z'));
    await writeEvent(testDb(), {
      id: `correct_${stale.conjectureProposalId}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: stale.conjectureProposalId,
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: 'owner retracted this conjecture',
        affected_refs: [{ kind: 'open_inquiry', id: stale.conjectureProposalId }],
      },
      caused_by_event_id: stale.conjectureProposalId,
    });

    const { probes } = await loadActiveProbes(testDb());

    expect(probes.map((probe) => probe.probe_question_id)).toEqual([active.probeQuestionId]);
    expect(probes.some((probe) => probe.probe_question_id === stale.probeQuestionId)).toBe(false);
  });

  it('returns a calm empty list when there are no active probes', async () => {
    const { probes } = await loadActiveProbes(testDb());
    expect(probes).toEqual([]);
  });

  it('caps at the concurrent-probe max (3)', async () => {
    await serve('a', new Date('2026-07-13T00:00:01Z'));
    await serve('b', new Date('2026-07-13T00:00:02Z'));
    await serve('c', new Date('2026-07-13T00:00:03Z'));

    const { probes } = await loadActiveProbes(testDb());
    expect(probes).toHaveLength(3);
  });
});
