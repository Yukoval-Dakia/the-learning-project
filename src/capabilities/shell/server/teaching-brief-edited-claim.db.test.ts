// YUK-785 — edited-claim ⇄ probe provenance guard.
//
// The defect this file locks: the owner rewrites conjecture claim A into B on /today
// ("保存并验证"), the SAME accept transaction mints the probe for **A** (serveProbeOnce
// reads `proposed_change.probe_md` / `probe_reference_md`, which the `.strict()`
// corrected_payload can never touch), the judge scores that answer against **A's**
// reference — and the brief then announced the result with **B's** wording
// ("这条判断得到这次探针的支持"). Probe evidence about A was attributed to B.
//
// The guard (contract §2.1 / YUK-785 option 3): the brief still shows the owner's own
// words as `finding.claim_md` (YUK-567's approved behaviour — an edit must stay visible),
// but it now ALSO carries `finding.tested_claim_md` — the claim the served probe actually
// tests — and the probe_ready / outcome copy attributes the probe to that claim instead of
// to the rewrite. Nothing here regenerates a probe at runtime (registry single-writer) and
// nothing widens `corrected_payload`.
//
// Every assertion below drives the WHOLE production chain: the real accept applier
// (acceptAiProposal → acceptConjectureProposal → serveProbeOnce, one transaction) and the
// real probe settlement (answerProbe), never a hand-seeded row.

import { answerProbe } from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { TeachingBriefResponseSchema } from '@/capabilities/shell/api/contracts';
import { loadTeachingBrief } from '@/capabilities/shell/server/teaching-brief';
import { event, question } from '@/db/schema';
import { acceptAiProposal } from '@/server/proposals/actions';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

/** The research team's original judgement — the claim the induced probe discriminates. */
const ORIGINAL_CLAIM = '你把链式法则当成两个导数相乘。';
/** The owner's rewrite. Same KC, materially different mechanism — no probe tests it. */
const OWNER_REWRITE = '你其实是把链式法则的内外层顺序记反了。';
const PROBE_MD = 'd/dx sin(x^2) = ?';
const PROBE_REFERENCE_MD = '2x·cos(x^2)：外层导数 × 内层导数。';

/** The sentence that mis-attributed A's probe evidence to the owner's rewrite. */
const UNQUALIFIED_SUPPORT_COPY = '这条判断得到这次探针的支持';
const UNQUALIFIED_RETIRE_COPY = '这条判断被这次探针排除';

function conjecturePayload() {
  return {
    kind: 'conjecture' as const,
    target: { subject_kind: 'mind_model' as const, subject_id: 'kn_chain_rule' },
    reason_md: '同一 cause×KC 反复失手，且 θ 精度偏低。',
    evidence_refs: [
      { kind: 'event' as const, id: 'evt_a' },
      { kind: 'event' as const, id: 'evt_b' },
    ],
    cooldown_key: 'conjecture:kn_chain_rule',
    proposed_change: {
      claim_md: ORIGINAL_CLAIM,
      knowledge_id: 'kn_chain_rule',
      cause_category: 'concept_misunderstanding',
      confidence: 0.7,
      recurrence_count: 2,
      probe_md: PROBE_MD,
      probe_reference_md: PROBE_REFERENCE_MD,
      discriminating: true,
      predicted_p: 0.3,
      baseline_p_at_induction: 0.6,
    },
  };
}

/** Run the real edited-accept: rate anchor + misconception hop + probe serve, one tx. */
async function acceptWithRewrite(): Promise<{ proposalId: string; probeQuestionId: string }> {
  const db = testDb();
  const proposalId = await writeAiProposal(db, {
    actor_ref: 'research_meeting',
    payload: conjecturePayload(),
  });
  await acceptAiProposal(db, proposalId, {
    corrected_payload: { claim_md: OWNER_REWRITE },
  });
  const [probe] = await db.select().from(question).where(eq(question.source_ref, proposalId));
  if (!probe) throw new Error('edited accept served no probe question');
  return { proposalId, probeQuestionId: probe.id };
}

describe('YUK-785 — an owner rewrite must not inherit the original claim’s probe evidence', () => {
  beforeEach(async () => {
    await resetDb();
    // The promote hop stays dark here; its own alignment is locked in
    // conjecture-accept.db.test.ts under an explicitly flipped flag.
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    delete process.env.MISCONCEPTION_PROMOTE_ENABLED;
  });

  it('serves the ORIGINAL claim’s probe verbatim (the mismatch this guard must disclose)', async () => {
    const { probeQuestionId } = await acceptWithRewrite();
    const [probe] = await testDb().select().from(question).where(eq(question.id, probeQuestionId));

    // Ground truth for every assertion below: `corrected_payload` is `.strict()` to
    // claim_md, so the served question and its grading reference are still A's.
    expect(probe.prompt_md).toBe(PROBE_MD);
    expect(probe.reference_md).toBe(PROBE_REFERENCE_MD);
  });

  it('probe_ready discloses which claim the prepared probe actually tests', async () => {
    const { proposalId } = await acceptWithRewrite();

    const response = await loadTeachingBrief(testDb(), new Date(Date.now() + 1000));
    expect(() => TeachingBriefResponseSchema.parse(response)).not.toThrow();
    const brief = response.brief;
    expect(brief).toMatchObject({
      brief_id: proposalId,
      state: 'probe_ready',
      finding: {
        // The owner's own words stay primary (YUK-567) …
        claim_md: OWNER_REWRITE,
        // … and the brief now says, on the wire, what is actually under test.
        tested_claim_md: ORIGINAL_CLAIM,
      },
      prepared_action: { kind: 'answer_probe', prompt_md: PROBE_MD },
      current_outcome: {
        status: 'awaiting_answer',
        summary_md: '判别题针对的是你改写前的那条判断；你的改写还没有配套的判别题。',
      },
    });
  });

  it('a confirmed outcome credits the pre-edit claim, never the rewrite', async () => {
    const { proposalId, probeQuestionId } = await acceptWithRewrite();
    // The learner errs on the discriminating probe → judge 'incorrect' → confirmed.
    const settled = await answerProbe({
      db: testDb(),
      probeQuestionId,
      outcome: 0,
      resolution: 'confirmed',
    });

    const response = await loadTeachingBrief(testDb(), new Date(Date.now() + 1000));
    expect(() => TeachingBriefResponseSchema.parse(response)).not.toThrow();
    const brief = response.brief;

    // THE regression this ticket exists for: the exact triple
    // (brief claim = rewrite B) × (graded question = A's probe) × (announced as support
    // for the displayed judgement) must no longer be producible.
    expect(brief).toMatchObject({
      brief_id: proposalId,
      state: 'outcome_confirmed',
      finding: { claim_md: OWNER_REWRITE, tested_claim_md: ORIGINAL_CLAIM },
      current_outcome: {
        status: 'confirmed',
        probe_question_id: probeQuestionId,
        probe_result_event_id: settled.probe_result_event_id,
        summary_md: '这次探针支持的是你改写前的那条判断；你的改写还没有被检验。',
      },
    });
    expect(brief?.current_outcome.summary_md).not.toContain(UNQUALIFIED_SUPPORT_COPY);
  });

  it('a retired outcome likewise credits the pre-edit claim', async () => {
    const { probeQuestionId } = await acceptWithRewrite();
    await answerProbe({ db: testDb(), probeQuestionId, outcome: 1, resolution: 'retired' });

    const { brief } = await loadTeachingBrief(testDb(), new Date(Date.now() + 1000));
    expect(brief).toMatchObject({
      state: 'outcome_retired',
      finding: { claim_md: OWNER_REWRITE, tested_claim_md: ORIGINAL_CLAIM },
      current_outcome: {
        status: 'retired',
        summary_md: '这次探针排除的是你改写前的那条判断；你的改写还没有被检验。',
      },
    });
    expect(brief?.current_outcome.summary_md).not.toContain(UNQUALIFIED_RETIRE_COPY);
  });

  // Both current claim schemas trim. Keep this regression because normalization at reader and
  // accept boundaries also protects legacy persisted rows and direct/internal callers.
  it('treats a whitespace-only difference as NO rewrite', async () => {
    const db = testDb();
    const padded = `  ${ORIGINAL_CLAIM}  `;
    const payload = conjecturePayload();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: { ...payload, proposed_change: { ...payload.proposed_change, claim_md: padded } },
    });
    // The owner "rewrites" to exactly the trimmed original — i.e. changes nothing.
    await acceptAiProposal(db, proposalId, {
      corrected_payload: { claim_md: ORIGINAL_CLAIM },
    });

    const response = await loadTeachingBrief(db, new Date(Date.now() + 1000));
    expect(() => TeachingBriefResponseSchema.parse(response)).not.toThrow();
    expect(response.brief).toMatchObject({
      state: 'probe_ready',
      finding: { claim_md: ORIGINAL_CLAIM },
      current_outcome: {
        status: 'awaiting_answer',
        // The plain copy — nothing was really rewritten, so nothing is disclosed.
        summary_md: '判别题已备好；完成后再更新这条判断。',
      },
    });
    expect(response.brief?.finding).not.toHaveProperty('tested_claim_md');

    // Cross-path agreement (codex #1080): the accept path must reach the SAME verdict,
    // otherwise one accept carries two contradictory semantics — the brief saying
    // "nothing was rewritten" while the rate anchor says the owner corrected the AI.
    const [rate] = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
    expect(rate.payload).toMatchObject({ corrected_by_owner: false, calibration_anchor: 'accept' });
    expect(rate.payload).not.toHaveProperty('corrected_claim_md');
  });

  it('a PLAIN accept is byte-identical to today — no rewrite, no disclosure key', async () => {
    const db = testDb();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: conjecturePayload(),
    });
    await acceptAiProposal(db, proposalId);
    const [probe] = await db.select().from(question).where(eq(question.source_ref, proposalId));
    await answerProbe({
      db,
      probeQuestionId: probe.id,
      outcome: 0,
      resolution: 'confirmed',
    });

    const response = await loadTeachingBrief(db, new Date(Date.now() + 1000));
    expect(() => TeachingBriefResponseSchema.parse(response)).not.toThrow();
    expect(response.brief).toMatchObject({
      state: 'outcome_confirmed',
      finding: { claim_md: ORIGINAL_CLAIM },
      current_outcome: {
        status: 'confirmed',
        summary_md: '这条判断得到这次探针的支持；下一步可以针对这个点练习。',
      },
    });
    // Contract §2.1 absent-key discipline: nothing was rewritten, so the key must be
    // ABSENT (not null, not an echo of claim_md).
    expect(response.brief?.finding).not.toHaveProperty('tested_claim_md');
  });
});
