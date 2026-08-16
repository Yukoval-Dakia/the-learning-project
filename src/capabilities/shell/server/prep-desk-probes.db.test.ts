// YUK-567 slice-2 — loadActiveProbes read model. A probe is "active" (in the 待你试做
// queue) while its mind_probe question has no experimental:probe_result event; once
// answered it drops out. Ordered newest-first, capped at ACTIVE_PROBES_MAX.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  answerProbe,
  serveProbeOnce,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { PrepDeskProbesResponseSchema } from '@/capabilities/shell/api/contracts';
import { writeEvent } from '@/kernel/events';
import { writeAiProposal } from '@/kernel/proposals/writer';

import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadActiveProbes } from './prep-desk-probes';

let seq = 0;
async function serve(
  probeMd: string,
  now: Date,
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
  return { probeQuestionId: served.probe_question_id, conjectureProposalId };
}

describe('loadActiveProbes', () => {
  beforeEach(async () => {
    await resetDb();
    seq = 0;
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
