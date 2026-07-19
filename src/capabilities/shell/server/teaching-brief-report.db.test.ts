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
import { BRIEF_SEEN_ACTION, PROBE_RESULT_ACTION } from '@/core/schema/conjecture';
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
  opts: { dismiss?: boolean; answerAt?: Date } = {},
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
    // Stamp the probe_result's created_at to place the ANSWER inside or outside the report window
    // independently of when the probe was served (defaults to real now = in-window).
    ...(opts.answerAt ? { now: opts.answerAt } : {}),
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

  it('a probe served in-window but answered out-of-window is not counted as completed', async () => {
    // Served at real now (in-window); answered ~100 days ago (out-of-window). The completion
    // query shares the window, so this must NOT inflate the completion rate — and its outcome is
    // likewise absent, keeping the two consistent (round-1 codex P2).
    await seedChain('confirmed', {
      answerAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
    });

    const { from, to } = windowAroundNow();
    const report = computeTeachingBriefReport(
      await loadTeachingBriefReportInput(testDb(), from, to),
    );

    expect(report.probes_served).toBe(1);
    // 0/1 completion (answer is out-of-window), NOT a fabricated 1/1.
    expect(report.probe_completion).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    // The out-of-window outcome is absent too — completion and outcomes stay consistent.
    expect(report.outcomes).toEqual({ confirmed: 0, retired: 0 });
  });

  it('drops a brief_seen row whose local_day is malformed (no phantom empty day)', async () => {
    const today = learnerLocalDay(new Date());
    // A foreign / corrupt row: a valid brief_seen action but a local_day that passes the SQL string
    // range yet is not a real calendar date. The loader's isLearnerLocalDay guard must drop it
    // (never coerce to '' and phantom-count a day).
    await writeEvent(testDb(), {
      id: 'bseen_malformed',
      actor_kind: 'user',
      actor_ref: 'self',
      action: BRIEF_SEEN_ACTION,
      subject_kind: 'event',
      subject_id: 'b_foreign',
      payload: {
        brief_state: 'finding',
        local_day: `${today}-extra`,
        seen_at: new Date().toISOString(),
      },
      ingest_at: new Date(),
    });

    const { from, to } = windowAroundNow();
    const report = computeTeachingBriefReport(
      await loadTeachingBriefReportInput(testDb(), from, to),
    );
    expect(report.days_with_briefs).toBe(0);
    expect(report.brief_days_seen).toBe(0);
    expect(report.total_brief_seen_events).toBe(0);
  });

  it('excludes a chain-broken probe_result from confirmed/retired and counts it as missing data', async () => {
    // A structurally deliverable-LOOKING result (canonical body: legal confirmed/0 pair,
    // self-consistent provenance) but a BROKEN chain — its probe question does not exist. The
    // reader/ack would skip it, so the report must too: it is NOT a confirmed outcome, and it is
    // surfaced as missing data rather than silently inflating the denominator (round-4 codex P2).
    await writeEvent(testDb(), {
      id: 'res_broken',
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: PROBE_RESULT_ACTION,
      subject_kind: 'question',
      subject_id: 'q_missing_probe',
      payload: { conjecture_event_id: 'p_orphan', outcome: 0, resolution: 'confirmed' },
      caused_by_event_id: 'p_orphan',
      ingest_at: new Date(),
    });
    // Plus one fully-canonical confirmed chain, so we prove the good one still counts.
    await seedChain('confirmed');

    const { from, to } = windowAroundNow();
    const report = computeTeachingBriefReport(
      await loadTeachingBriefReportInput(testDb(), from, to),
    );
    expect(report.outcomes).toEqual({ confirmed: 1, retired: 0 });
    expect(report.skipped_corrupt_outcomes).toBe(1);
  });
});
