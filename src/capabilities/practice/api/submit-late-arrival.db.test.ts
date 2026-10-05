// Native ordered replay replaces the retired deferred writer's evidence-only skip.
// Unknown newer projections remain fail-closed; pending originals never pretend to be scores.
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@/core/ids';
import { HIERARCHICAL_ELO_ENABLED } from '@/core/theta';
import { event, knowledge, mastery_state, material_fsrs_state } from '@/db/schema';
import { upsertMasteryState } from '@/server/mastery/state';
import { nativeSoloHttpFixture } from '../../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { commitFormalAttempt, prepareFormalAttemptSubmission } from '../server/assessment/attempt';
import { recordJudgePendingAttempt } from '../server/judge-run-dispatch';

const OLDER = new Date('2026-10-04T08:00:00.000Z');
const NEWER = new Date('2026-10-04T09:00:00.000Z');
beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
async function original(ids: string[], at: Date, answer = 'A') {
  const f = await nativeSoloHttpFixture(testDb(), { knowledgeIds: ids });
  const request = { ...f.issued.assessment(answer), now: at };
  return {
    ...f,
    request,
    prepare: () => prepareFormalAttemptSubmission(testDb(), 'solo_submit', f.id, request),
    commit: () => commitFormalAttempt(testDb(), 'solo_submit', f.id, request),
  };
}
async function state() {
  return {
    theta: await testDb().select().from(mastery_state).orderBy(mastery_state.subject_id),
    fsrs: await testDb().select().from(material_fsrs_state).orderBy(material_fsrs_state.subject_id),
  };
}
async function external(
  subjectKind: 'knowledge' | 'ability_global',
  subjectId: string,
  at = NEWER,
) {
  await upsertMasteryState(testDb(), {
    subject_kind: subjectKind,
    subject_id: subjectId,
    theta_hat: 0.5,
    evidence_count: 1,
    success_count: 1,
    fail_count: 0,
    last_outcome_at: at,
  });
}
async function historicalPending(
  questionId: string,
  ids: string[],
  globals: string[],
  frozen?: Record<string, string>,
) {
  return recordJudgePendingAttempt(testDb(), {
    runId: newId(),
    sessionId: null,
    questionId,
    knowledgeIds: ids,
    abilityGlobalIds: globals,
    submit: {
      body: {
        question_id: questionId,
        rating: 'good',
        auto_rate: true,
        response_md: '历史未判原件',
      },
      question_id: questionId,
      subject_profile: {},
      question_snapshot: { knowledge_ids: ids },
      ...(frozen ? { ability_global_by_knowledge_id: frozen } : {}),
      submitted_at: NEWER.toISOString(),
    },
    submittedAt: NEWER,
  });
}

describe('native late arrival and frozen learning scope', () => {
  it.each<{
    name: string;
    ids: string[];
    globals: string[];
    map: Record<string, string> | undefined;
  }>([
    { name: 'filtered root', ids: [], globals: [], map: {} },
    {
      name: 'legacy root',
      ids: ['seed:math:root'],
      globals: ['math'],
      map: { 'seed:math:root': 'math' },
    },
    { name: 'legacy root without map', ids: ['seed:math:root'], globals: ['math'], map: undefined },
    {
      name: 'mixed unrelated KC',
      ids: ['seed:math:root', 'k2'],
      globals: ['math', 'history'],
      map: { 'seed:math:root': 'math', k2: 'history' },
    },
    { name: 'filtered real sibling', ids: ['k2'], globals: ['math'], map: { k2: 'math' } },
    { name: 'legacy real sibling without map', ids: ['k2'], globals: ['math'], map: undefined },
  ])(
    'retains $name pending history without using its unexecuted answer as learning evidence',
    async ({ ids, globals, map }) => {
      const first = await original(['k1'], OLDER);
      const pendingId = await historicalPending('historical-other-question', ids, globals, map);
      const history = await testDb().select().from(event).where(eq(event.id, pendingId));
      expect((await state()).theta).toHaveLength(0);
      expect(await first.commit()).toMatchObject({
        status: 'effective',
        activation: { effect: 'applied' },
      });
      expect(await testDb().select().from(event).where(eq(event.id, pendingId))).toEqual(history);
      expect((await state()).fsrs.map((row) => row.subject_id)).toEqual(['k1']);
      expect((await state()).theta.map((row) => row.subject_id)).not.toContain('seed:math:root');
    },
  );

  it.each(['root-knowledge', 'root-domain', 'real-knowledge', 'real-domain'] as const)(
    'protects newer real projections while ignoring synthetic targets: %s',
    async (target) => {
      const f = await original(['seed:math:root', 'k1'], OLDER);
      await testDb()
        .update(knowledge)
        .set({ domain: 'anchor-domain' })
        .where(eq(knowledge.id, 'seed:math:root'));
      const isRoot = target.startsWith('root');
      const kind = target.endsWith('domain') ? 'ability_global' : 'knowledge';
      const id =
        kind === 'ability_global'
          ? isRoot
            ? 'anchor-domain'
            : 'math'
          : isRoot
            ? 'seed:math:root'
            : 'k1';
      await external(kind, id);
      const before = await state();
      expect(await f.commit()).toMatchObject({
        status: 'effective',
        activation: { effect: isRoot ? 'applied' : 'failed_pending' },
      });
      const [preserved] = await testDb()
        .select()
        .from(mastery_state)
        .where(and(eq(mastery_state.subject_kind, kind), eq(mastery_state.subject_id, id)));
      expect(preserved).toEqual(before.theta[0]);
      if (!isRoot) expect(await state()).toEqual(before);
      else expect((await state()).fsrs.map((row) => row.subject_id)).toEqual(['k1']);
    },
  );

  it('preserves an unresolved later original and later settles both overlapping KC observations in order', async () => {
    const first = await original(['k1'], OLDER);
    const later = await original(['k1', 'k2'], NEWER);
    await later.prepare();
    expect((await state()).theta).toHaveLength(0);
    expect(await first.commit()).toMatchObject({ activation: { effect: 'applied' } });
    expect(await later.commit()).toMatchObject({ activation: { effect: 'applied' } });
    const final = await state();
    expect(final.fsrs.map((row) => [row.subject_id, row.state.reps])).toEqual([
      ['k1', 2],
      ['k2', 1],
    ]);
    expect(
      final.theta
        .filter((row) => row.subject_kind === 'knowledge')
        .map((row) => [row.subject_id, row.evidence_count, row.last_outcome_at?.toISOString()]),
    ).toEqual([
      ['k1', 2, NEWER.toISOString()],
      ['k2', 1, NEWER.toISOString()],
    ]);
  });

  it('replays a later sibling on the shared domain without requiring overlapping KC IDs', async () => {
    expect(HIERARCHICAL_ELO_ENABLED).toBe(true);
    const run = async (reverse: boolean) => {
      const first = await original(['k1'], OLDER, 'B');
      const later = await original(['k2'], NEWER, 'A');
      for (const item of reverse ? [later, first] : [first, later])
        expect(await item.commit()).toMatchObject({ activation: { effect: 'applied' } });
      const final = await state();
      return {
        theta: final.theta.map((row) => ({
          kind: row.subject_kind,
          id: row.subject_id,
          theta: row.theta_hat,
          count: row.evidence_count,
          at: row.last_outcome_at,
        })),
        fsrs: final.fsrs.map((row) => ({
          id: row.subject_id,
          reps: row.state.reps,
          at: row.state.last_review,
        })),
      };
    };
    const chronological = await run(false);
    await resetDb();
    expect(await run(true)).toEqual(chronological);
    const receipts = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_settlement'));
    expect(receipts.some((row) => typeof row.payload.replay_of === 'string')).toBe(true);
  });

  it('does not hide an untracked newer domain write behind more than 200 unrelated receipts', async () => {
    const first = await original(['k1'], OLDER);
    await external('ability_global', 'math');
    const now = new Date(NEWER.getTime() + 1_000);
    await testDb()
      .insert(event)
      .values(
        Array.from({ length: 205 }, (_, i) => ({
          id: `historical_pending_${i}`,
          actor_kind: 'user' as const,
          actor_ref: 'self',
          action: 'experimental:judge_pending_attempt',
          subject_kind: 'question',
          subject_id: `unrelated_${i}`,
          payload: {
            knowledge_ids: [`other_${i}`],
            ability_global_ids: ['history'],
            submit: { submitted_at: now.toISOString() },
          },
          created_at: now,
        })),
      );
    const before = await state();
    expect(await first.commit()).toMatchObject({ activation: { effect: 'failed_pending' } });
    expect(await state()).toEqual(before);
  });

  it('its own pending original cannot suppress its first legitimate learning effect', async () => {
    const f = await original(['k1'], OLDER);
    await f.prepare();
    await f.prepare();
    expect(await f.commit()).toMatchObject({ activation: { effect: 'applied' } });
    expect((await state()).fsrs).toMatchObject([{ state: { reps: 1 } }]);
  });

  it('unrelated newer projections do not block an earlier assessment on a different domain', async () => {
    const f = await original(['k1'], OLDER);
    await external('knowledge', 'unrelated-kc');
    await external('ability_global', 'history');
    const before = await state();
    expect(await f.commit()).toMatchObject({ activation: { effect: 'applied' } });
    const final = await state();
    for (const row of before.theta)
      expect(final.theta.find((after) => after.id === row.id)).toEqual(row);
    expect(final.fsrs).toHaveLength(1);
  });

  it('an older external domain row does not suppress a legitimate advance', async () => {
    const f = await original(['k1'], NEWER);
    await external('ability_global', 'math', OLDER);
    expect(await f.commit()).toMatchObject({ activation: { effect: 'applied' } });
    const [global] = await testDb()
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_kind, 'ability_global'));
    expect(global.evidence_count).toBe(2);
    expect(global.last_outcome_at?.toISOString()).toBe(NEWER.toISOString());
  });

  it('uses the accepted original domain after the KC is reparented while evaluation waits', async () => {
    const f = await original(['k1'], OLDER);
    await testDb().update(knowledge).set({ domain: 'math-before' }).where(eq(knowledge.id, 'k1'));
    await f.prepare();
    await testDb().update(knowledge).set({ domain: 'math-after' }).where(eq(knowledge.id, 'k1'));
    expect(await f.commit()).toMatchObject({ activation: { effect: 'applied' } });
    expect(
      (await state()).theta
        .filter((row) => row.subject_kind === 'ability_global')
        .map((row) => row.subject_id),
    ).toEqual(['math-before']);
  });
});
