// Cold-start day-one e2e — 方向 B「可开始用」S2 verify (Refs YUK-478 / YUK-571).
//
// Pins the FULL upload→placement→profile chain across the seams the per-module suites never
// cross together: REAL migrate-time subject-root seeding (thin tree, roots carry no embedding)
// → REAL tagKnowledge PROPOSE (embed/name injected deterministically — no LLM, no network)
// minting an auto-approved child KC under the subject root → a question landed in the
// auto-enroll shape → a tier-2 day-one goal (empty frozen scope + subject) → placement-start
// SERVES that question (the "scope 内有题可 serve" explicit check the re-ground flagged as the
// chain's un-grounded link) → the answered trail (review event + mastery_state row, what
// /api/review/submit writes) → placement-profile surfaces the tested KC with band fields and
// the untested root as an honest tested:false row.
//
// PLACEMENT_PROBE_ENABLED is getter-mocked true (dark-ship default false — same pattern as
// placement-api.db.test.ts); everything else is the production code path. If any seam here
// regresses, the "product is openable" contract breaks before the flag ever flips.

import { newId } from '@/core/ids';
import { event, goal, knowledge, mastery_state, question } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const placementFlag = { value: true };
vi.mock('@/server/session/placement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/session/placement')>();
  return {
    ...actual,
    get PLACEMENT_PROBE_ENABLED() {
      return placementFlag.value;
    },
  };
});

import { seedKnowledge as seedSubjectRoots } from '@/capabilities/knowledge/server/seed';
import { tagKnowledge } from '@/capabilities/knowledge/server/tag-knowledge';
import { EMBED_DIMS } from '@/server/ai/embed';
import { GET as getProfile } from './placement-profile';
import { POST as startPlacement } from './placement-start';

const db = testDb();

beforeEach(() => {
  placementFlag.value = true;
  return resetDb();
});

function jsonReq(body: unknown): Request {
  return new Request('http://t/placement', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function profileReq(goalId: string): Request {
  return new Request(`http://t/api/placement/profile?goal=${encodeURIComponent(goalId)}`);
}

async function seedDayOneGoal(id: string): Promise<void> {
  const now = new Date();
  await db.insert(goal).values({
    id,
    title: '文言文进阶',
    subject_id: 'wenyan',
    scope_knowledge_ids: [], // day-one shape: declared on a thin tree → frozen scope stays empty
    sequence_hint: 0,
    status: 'active',
    source: 'manual',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

// The placement-eligibility-faithful landed shape: draft_status 'active' + tagged KC match
// auto-enroll's structural-verify output exactly (the two fields eligibility gates on);
// `source` differs (auto-enroll lands sessionEntrypoint, not 'manual') and is inert here.
async function seedUploadedQuestion(id: string, kcs: string[]): Promise<void> {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: '「学而时习之，不亦说乎」中「说」字如何解？',
    knowledge_ids: kcs,
    difficulty: 3,
    source: 'manual',
    draft_status: 'active',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

// The answered trail /api/review/submit leaves behind: a review event chained to the probe
// session + the θ̂ projection row. The judge→θ̂ write itself is pinned by the submit suites;
// this file pins that the PROFILE reads that trail back out for a tier-2-resolved KC.
async function seedAnsweredTrail(sessionId: string, questionId: string, kcId: string) {
  const now = new Date();
  await db.insert(event).values({
    id: newId(),
    session_id: sessionId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'review',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'success',
    payload: {},
    created_at: now,
  });
  await db.insert(mastery_state).values({
    id: newId(),
    subject_kind: 'knowledge',
    subject_id: kcId,
    theta_hat: 0.4,
    evidence_count: 1,
    success_count: 1,
    fail_count: 0,
    theta_precision: 1.2,
    updated_at: now,
  });
}

describe('cold-start day-one e2e (upload-shaped KC → placement → profile)', () => {
  it('thin tree: tagKnowledge PROPOSEs an auto-approved child KC the placement+profile tiers can reach', async () => {
    const seeded = await seedSubjectRoots(db);
    expect(seeded.inserted).toBeGreaterThan(0);

    // Upload-pipeline tagging on a thin tree. The injected vector is NON-empty and
    // EMBED_DIMS-sized (production embedText always returns a full vector or throws), so the
    // REAL retrieval SQL runs and returns no candidate because the seed roots carry NULL
    // embedding — `embedding IS NOT NULL` (match-similarity) is exactly the structural guard
    // against the 2026-06-22 "questions pile on the root" regression, and this path exercises
    // it (review F1: an `[]` vec would short-circuit at the TS guard and never touch the SQL).
    const basisVec = Array.from({ length: EMBED_DIMS }, (_, i) => (i === 0 ? 1 : 0));
    const tag = await tagKnowledge(
      { db, embedFn: async () => basisVec, nameKcFn: async () => ({ kc_name: '通假字' }) },
      { questionText: '「说」通「悦」，愉快之意。', subjectRootId: 'seed:wenyan:root' },
    );
    expect(tag.kind).toBe('propose');
    const kcId = tag.knowledge_ids[0];
    expect(kcId).toBeTruthy();

    // The minted KC is exactly what the placement tiers consume: an ACTIVE (non-archived),
    // auto-APPROVED child of the subject root, domain inherited via the parent chain.
    const [kcRow] = await db
      .select({
        parent_id: knowledge.parent_id,
        approval_status: knowledge.approval_status,
        archived_at: knowledge.archived_at,
        domain: knowledge.domain,
      })
      .from(knowledge)
      .where(eq(knowledge.id, kcId));
    expect(kcRow.parent_id).toBe('seed:wenyan:root');
    expect(kcRow.approval_status).toBe('approved');
    expect(kcRow.archived_at).toBeNull();
    expect(kcRow.domain).toBeNull(); // inherits 'wenyan' through the parent chain (subject=view)

    await seedUploadedQuestion('q-upload', [kcId]);
    await seedDayOneGoal('g1');

    // placement-start on the day-one goal (tier-2: empty frozen scope + subject) must scope in
    // the proposed child KC AND actually serve the uploaded question — "scope 内有题可 serve".
    const startRes = await startPlacement(jsonReq({ goalId: 'g1' }));
    expect(startRes.status).toBe(200);
    const start = await startRes.json();
    expect(start.knowledgeIds).toContain(kcId);
    expect(start.question?.questionId).toBe('q-upload');
    expect(start.sourcingNeeded).toBe(false);

    // Answered trail → the placement-done 起始档案 reads it back out through the SAME tier-2
    // resolution (YUK-516): the tested KC surfaces with band fields, the subject root stays an
    // honest untested row.
    await seedAnsweredTrail(start.sessionId, 'q-upload', kcId);
    const profileRes = await getProfile(profileReq('g1'));
    expect(profileRes.status).toBe(200);
    const profile = await profileRes.json();

    const byId = Object.fromEntries(
      profile.kcs.map((k: { id: string }) => [k.id, k]) as Array<[string, Record<string, unknown>]>,
    );
    const tested = byId[kcId];
    expect(tested).toBeDefined();
    expect(tested.tested).toBe(true);
    expect(tested.name).toBe('通假字');
    expect(tested.evidence_count).toBe(1);
    // Range-tight (review F2): `typeof NaN === 'number'`, so a broken band would pass a bare
    // typeof check. p(L) is a probability, SE is strictly positive.
    expect(tested.p_l).toBeGreaterThan(0);
    expect(tested.p_l).toBeLessThan(1);
    expect(tested.theta_se).toBeGreaterThan(0);
    const root = byId['seed:wenyan:root'];
    expect(root).toBeDefined();
    expect(root.tested).toBe(false);
    expect(profile.testedCount).toBe(1);
    expect(profile.totalKcs).toBeGreaterThanOrEqual(2);
  });

  it('honesty leg: roots alone serve no question — start reports sourcingNeeded instead of faking a probe', async () => {
    await seedSubjectRoots(db);
    await seedDayOneGoal('g1');

    const res = await startPlacement(jsonReq({ goalId: 'g1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.question).toBeNull();
    expect(body.sourcingNeeded).toBe(true);
  });
});
