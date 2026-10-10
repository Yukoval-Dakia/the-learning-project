// Phase 0 关系脑 (YUK-406 / YUK-440) — conjecture accept applier lifecycle.
// Enters through the public dispatch shell (acceptAiProposal / dismissAiProposal)
// to cover the whole 「壳路由 → agency applier」 chain. Asserts the three
// semantics (accept = calibration anchor / edit → mem0 CORE / reject → digest),
// idempotency, and the ND-5 red line: NO FSRS / review row is ever written.

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_CONCURRENT_ACTIVE_PROBES,
  PROBE_QUESTION_SOURCE,
  countActiveProbes,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { PROBE_SLOTS_FULL_CODE } from '@/capabilities/agency/server/conjecture-accept';
import {
  event,
  material_fsrs_state,
  misconception,
  misconception_edge,
  question,
} from '@/db/schema';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { acceptAiProposal } from '@/server/proposals/actions';
import { resetDb, testDb } from '../../../../tests/helpers/db';

function baseConjecture() {
  const primaryProbeSpec = {
    schema_version: 2 as const,
    prompt_md: 'd/dx sin(x^2) = ?',
    reference_md: '2x·cos(x^2) — outer cos × inner 2x (chain rule: outer-deriv × inner-deriv).',
    expected_target_error_answer_md: 'cos(x²) + 2x',
    elicits_target_error_reason_md: 'Requires composing the two derivative layers.',
    context_kind: 'abstract' as const,
    representation_kind: 'symbolic' as const,
    response_mode: 'answer_with_reason' as const,
    gold_response_signature: {
      kind: 'answer_with_reason' as const,
      answer_md: '2x·cos(x²)',
      required_reason_features_md: ['outer derivative multiplied by inner derivative'],
    },
    target_error_response_signature: {
      kind: 'answer_with_reason' as const,
      answer_md: 'cos(x²) + 2x',
      required_reason_features_md: ['outer and inner derivatives added'],
    },
  };
  const followupProbeSpec = {
    schema_version: 2 as const,
    prompt_md: 'A changing area follows cos(t^3); explain its instantaneous rate.',
    reference_md: '-3t²·sin(t³), with outer and inner derivatives multiplied.',
    expected_target_error_answer_md: '-sin(t³) + 3t²',
    elicits_target_error_reason_md: 'Retains the same layer-composition decision in context.',
    context_kind: 'applied' as const,
    representation_kind: 'natural_language' as const,
    response_mode: 'answer_with_reason' as const,
    gold_response_signature: {
      kind: 'answer_with_reason' as const,
      answer_md: '-3t²·sin(t³)',
      required_reason_features_md: ['outer derivative multiplied by inner derivative'],
    },
    target_error_response_signature: {
      kind: 'answer_with_reason' as const,
      answer_md: '-sin(t³) + 3t²',
      required_reason_features_md: ['outer and inner derivatives added'],
    },
  };
  return {
    kind: 'conjecture' as const,
    target: { subject_kind: 'mind_model' as const, subject_id: 'kn_chain_rule' },
    reason_md: 'recurrent cause×KC failure cell + low θ precision',
    evidence_refs: [
      { kind: 'event' as const, id: 'evt_a' },
      { kind: 'event' as const, id: 'evt_b' },
    ],
    cooldown_key: 'conjecture:kn_chain_rule',
    proposed_change: {
      claim_md: 'you treat the chain rule as multiplying derivatives',
      knowledge_id: 'kn_chain_rule',
      cause_category: 'concept_misunderstanding',
      confidence: 0.7,
      recurrence_count: 2,
      probe_md: 'd/dx sin(x^2) = ?',
      probe_reference_md:
        '2x·cos(x^2) — outer cos × inner 2x (chain rule: outer-deriv × inner-deriv).',
      followup_probe_md: 'A changing area follows cos(t^3); explain its instantaneous rate.',
      followup_probe_reference_md: '-3t²·sin(t³), with outer and inner derivatives multiplied.',
      diagnostic_spec: {
        schema_version: 1 as const,
        target_error_rule_md: 'Adds outer and inner derivatives instead of multiplying them.',
        trigger_conditions_md: 'A composite function must be differentiated.',
        scope_boundary_md: 'Does not claim other differentiation rules are misunderstood.',
        expected_wrong_answer_signature_md: 'Outer derivative + inner derivative.',
      },
      probe_spec: primaryProbeSpec,
      followup_probe_spec: followupProbeSpec,
      probe_quality: {
        schema_version: 3 as const,
        passed: true as const,
        attempts: [
          {
            attempt: 1,
            outcome: 'passed' as const,
            failure_codes: [],
            explanation_md: 'verified',
            author_task_run_id: 'author_run',
            reviewer_task_run_id: 'review_run',
          },
        ],
        final_review: {
          verdict: 'pass' as const,
          failure_codes: [],
          explanation_md: 'verified',
        },
        reviewed_hypothesis: {
          kind: 'proposal' as const,
          claim_md: 'you treat the chain rule as multiplying derivatives',
          knowledge_id: 'kn_chain_rule',
          evidence_event_ids: ['evt_a', 'evt_b'],
          diagnostic_spec: {
            schema_version: 1 as const,
            target_error_rule_md: 'Adds outer and inner derivatives instead of multiplying them.',
            trigger_conditions_md: 'A composite function must be differentiated.',
            scope_boundary_md: 'Does not claim other differentiation rules are misunderstood.',
            expected_wrong_answer_signature_md: 'Outer derivative + inner derivative.',
          },
          cause_category: 'concept_misunderstanding',
          recurrence_count: 2,
        },
        reviewed_package: {
          primary: primaryProbeSpec,
          followup: followupProbeSpec,
          predicted_p: 0.3,
        },
      },
      discriminating: true,
      predicted_p: 0.3,
      baseline_p_at_induction: 0.6,
    },
  };
}

async function rateEvents(proposalId: string) {
  const db = testDb();
  return db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
}

async function fsrsRowCount(): Promise<number> {
  const db = testDb();
  const rows = await db.select().from(material_fsrs_state);
  return rows.length;
}

async function misconceptionRows() {
  return testDb().select().from(misconception);
}

async function misconceptionEdgeRows() {
  return testDb().select().from(misconception_edge);
}

async function allProbeQuestions() {
  return testDb().select().from(question).where(eq(question.source, PROBE_QUESTION_SOURCE));
}

describe('acceptConjectureProposal lifecycle', () => {
  beforeEach(async () => {
    await resetDb();
    // YUK-531 PR-3 — every test starts with the promotion flag OFF (dark default).
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    delete process.env.MISCONCEPTION_PROMOTE_ENABLED;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    delete process.env.MISCONCEPTION_PROMOTE_ENABLED;
  });

  it('re-accept is idempotent — single durable rate event and no FSRS', async () => {
    const db = testDb();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: baseConjecture(),
    });

    await acceptAiProposal(db, proposalId, {
      corrected_payload: { claim_md: 'edited claim' },
    });
    const again = await acceptAiProposal(db, proposalId, {
      corrected_payload: { claim_md: 'edited claim' },
    });

    expect(again).toMatchObject({ idempotent: true, corrected_by_owner: true });
    // Exactly one rate event survives — no double-anchor.
    const rates = await rateEvents(proposalId);
    expect(rates).toHaveLength(1);
    expect(await fsrsRowCount()).toBe(0);
  });

  // YUK-531 PR-3 — the dark, flag-gated misconception promotion hop.
  describe('misconception promotion (YUK-531 PR-3)', () => {
    it('flag ON — re-accept is idempotent: one misconception, one edge, one rate', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();
      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });

      await acceptAiProposal(db, proposalId);
      await acceptAiProposal(db, proposalId);

      // The rate-event idempotency guard short-circuits the 2nd accept BEFORE the
      // promotion hop, so nothing double-writes.
      expect(await rateEvents(proposalId)).toHaveLength(1);
      expect(await misconceptionRows()).toHaveLength(1);
      expect(await misconceptionEdgeRows()).toHaveLength(1);
    });
  });

  // YUK-711 — the probe-slot-cap rollback. When all MAX_CONCURRENT_ACTIVE_PROBES
  // slots are taken, the accept must NOT commit a rate anchor / dark promotion with
  // no probe (the accepted-without-probe dangling chain the idempotency guard then
  // permanently blocks). Instead it throws a typed `probe_slots_full` ApiError inside
  // the accept tx so everything rolls back and the proposal stays pending for retry.
  describe('probe slot cap rollback (YUK-711)', () => {
    it('(4) concurrent accepts are bounded by the advisory lock — exactly MAX succeed, the rest roll back with no orphan rate anchor', async () => {
      const db = testDb();
      // Start from an empty slate and fire MAX+2 accepts of distinct fresh conjectures
      // concurrently. The transaction-scoped advisory lock serializes each serve's
      // count-read + insert, so the cap can never be raced past.
      const overflow = 2;
      const proposalIds = await Promise.all(
        Array.from({ length: MAX_CONCURRENT_ACTIVE_PROBES + overflow }, () =>
          writeAiProposal(db, { actor_ref: 'research_meeting', payload: baseConjecture() }),
        ),
      );

      const settled = await Promise.allSettled(proposalIds.map((id) => acceptAiProposal(db, id)));
      const fulfilled = settled.filter((s) => s.status === 'fulfilled');
      const rejected = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];

      // Exactly MAX accepts win a slot; the overflow ones fail with probe_slots_full.
      expect(fulfilled).toHaveLength(MAX_CONCURRENT_ACTIVE_PROBES);
      expect(rejected).toHaveLength(overflow);
      for (const r of rejected) {
        expect(r.reason).toMatchObject({ code: PROBE_SLOTS_FULL_CODE, status: 409 });
      }

      // Active probes never exceeded the cap, and the failed accepts left NO orphan
      // rate anchor — exactly MAX rate(accept) events and MAX probe questions survive.
      expect(await countActiveProbes(db)).toBe(MAX_CONCURRENT_ACTIVE_PROBES);
      expect(await allProbeQuestions()).toHaveLength(MAX_CONCURRENT_ACTIVE_PROBES);
      const acceptRates = await testDb()
        .select()
        .from(event)
        .where(and(eq(event.action, 'rate'), eq(event.subject_kind, 'event')));
      const anchors = acceptRates.filter(
        (e) => (e.payload as { rating?: string }).rating === 'accept',
      );
      expect(anchors).toHaveLength(MAX_CONCURRENT_ACTIVE_PROBES);
      expect(await fsrsRowCount()).toBe(0);
    });
  });
});
