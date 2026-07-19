// YUK-710 (P0F/6) — teaching-brief survival report DB loader contract.
//
// Validates loadTeachingBriefReportInput's SQL against a real seeded chain: the interaction
// local-day filter, the conjecture-decision EXISTS join (accept/dismiss), the mind_probe served +
// completion subquery, and the confirmed/retired outcome filter. The pure math itself is pinned in
// scripts/report-teaching-brief.test.ts; here we prove the loader shapes the right facts.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  answerProbe,
  serveProbeOnce,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { learnerLocalDay } from '@/core/learner-day';
import { writeEvent } from '@/server/events/queries';
import { writeAiProposal } from '@/server/proposals/writer';
import { computeTeachingBriefReport } from '../../../../scripts/lib/teaching-brief-report';
import { loadTeachingBriefReportInput } from '../../../../scripts/report-teaching-brief';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { recordBriefSeen, recordPrimaryActionStarted } from './teaching-brief-interactions';

const KC_ID = 'kn_chain_rule';

// A window comfortably bracketing "now" (real-now events land inside regardless of the exact
// instant vs the Shanghai midnight boundary).
function windowAroundNow(): { from: string; to: string } {
  const now = Date.now();
  return {
    from: learnerLocalDay(new Date(now - 24 * 60 * 60 * 1000)),
    to: learnerLocalDay(new Date(now + 24 * 60 * 60 * 1000)),
  };
}

async function seedChain(
  resolution: 'confirmed' | 'retired',
  opts: { dismiss?: boolean } = {},
): Promise<{ proposalId: string; resultId: string }> {
  const proposalId = await writeAiProposal(testDb(), {
    actor_ref: 'research_meeting',
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: KC_ID },
      reason_md: 'recurrent cause×KC failure cell',
      evidence_refs: [{ kind: 'event', id: 'evt_a' }],
      cooldown_key: `conjecture:${KC_ID}:${resolution}:${Math.random()}`,
      proposed_change: {
        claim_md: 'you treat the chain rule as multiplying derivatives',
        knowledge_id: KC_ID,
        cause_category: 'concept_misunderstanding',
        confidence: 0.7,
        recurrence_count: 2,
        probe_md: 'd/dx sin(x^2) = ?',
        probe_reference_md: '2x·cos(x^2)',
        discriminating: true,
        predicted_p: 0.3,
        baseline_p_at_induction: 0.6,
      },
    },
  });
  // A dismissed proposal records only the dismiss rate (no probe / result).
  if (opts.dismiss) {
    await writeEvent(testDb(), {
      id: `rate_${proposalId}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: { rating: 'dismiss' },
      caused_by_event_id: proposalId,
    });
    return { proposalId, resultId: '' };
  }
  await writeEvent(testDb(), {
    id: `rate_${proposalId}`,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    payload: { rating: 'accept', conjecture_id: proposalId, calibration_anchor: 'accept' },
    caused_by_event_id: proposalId,
  });
  const served = await serveProbeOnce({
    db: testDb(),
    conjectureProposalId: proposalId,
    knowledgeId: KC_ID,
    probeMd: 'd/dx sin(x^2) = ?',
    referenceMd: '2x·cos(x^2)',
  });
  if (served.status !== 'served') throw new Error(`expected served, got ${served.status}`);
  const result = await answerProbe({
    db: testDb(),
    probeQuestionId: served.probe_question_id,
    outcome: resolution === 'confirmed' ? 0 : 1,
    resolution,
  });
  return { proposalId, resultId: result.probe_result_event_id };
}

describe('loadTeachingBriefReportInput (YUK-710)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('empty DB → a report of zeros and n/a rates', async () => {
    const { from, to } = windowAroundNow();
    const input = await loadTeachingBriefReportInput(testDb(), from, to);
    const report = computeTeachingBriefReport(input);
    expect(report.days_with_briefs).toBe(0);
    expect(report.brief_to_action.rate).toBeNull();
    expect(report.probe_completion.rate).toBeNull();
    expect(report.outcomes).toEqual({ confirmed: 0, retired: 0 });
    expect(report.time_to_action.count).toBe(0);
  });

  it('loads a full confirmed + retired + dismissed chain with interactions', async () => {
    const confirmedChain = await seedChain('confirmed');
    await seedChain('retired');
    await seedChain('confirmed', { dismiss: true }); // decided as dismiss (no probe/result)

    // Interactions on the confirmed brief: opened, accepted, and started scoped practice.
    await recordBriefSeen(testDb(), {
      briefId: confirmedChain.proposalId,
      briefState: 'outcome_confirmed',
    });
    await recordPrimaryActionStarted(testDb(), {
      briefId: confirmedChain.proposalId,
      actionKind: 'accept_probe',
    });
    await recordPrimaryActionStarted(testDb(), {
      briefId: confirmedChain.proposalId,
      actionKind: 'scoped_practice',
      resultEventId: confirmedChain.resultId,
    });

    const { from, to } = windowAroundNow();
    const report = computeTeachingBriefReport(
      await loadTeachingBriefReportInput(testDb(), from, to),
    );

    expect(report.days_with_briefs).toBe(1);
    expect(report.brief_days_seen).toBe(1);
    // The one seen brief-day also started an action → 1/1.
    expect(report.brief_to_action).toEqual({ numerator: 1, denominator: 1, rate: 1 });
    expect(report.action_starts_by_kind.accept_probe).toBe(1);
    expect(report.action_starts_by_kind.scoped_practice).toBe(1);
    // Decisions: two accepts (confirmed + retired chains) + one dismiss.
    expect(report.decisions).toEqual({ accept: 2, edit: 0, dismiss: 1 });
    // Two probes served (confirmed + retired), both answered.
    expect(report.probes_served).toBe(2);
    expect(report.probe_completion).toEqual({ numerator: 2, denominator: 2, rate: 1 });
    expect(report.outcomes).toEqual({ confirmed: 1, retired: 1 });
    // The one confirmed outcome had a scoped_practice start joined by result_event_id.
    expect(report.confirmed_to_scoped_practice).toEqual({ numerator: 1, denominator: 1, rate: 1 });
    // seen → first action pairing on the confirmed brief-day.
    expect(report.time_to_action.count).toBe(1);
    expect(report.time_to_action.median_ms).not.toBeNull();
    expect(report.time_to_action.median_ms ?? -1).toBeGreaterThanOrEqual(0);
  });

  it('excludes interactions and decisions outside the window', async () => {
    const chain = await seedChain('confirmed');
    await recordBriefSeen(testDb(), { briefId: chain.proposalId, briefState: 'outcome_confirmed' });

    // A window entirely in the past → nothing in range.
    const input = await loadTeachingBriefReportInput(testDb(), '2020-01-01', '2020-01-14');
    const report = computeTeachingBriefReport(input);
    expect(report.days_with_briefs).toBe(0);
    expect(report.decisions).toEqual({ accept: 0, edit: 0, dismiss: 0 });
    expect(report.probes_served).toBe(0);
    expect(report.outcomes).toEqual({ confirmed: 0, retired: 0 });
  });
});
