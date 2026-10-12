import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GET as readLegacyProposals } from '@/capabilities/knowledge/api/proposals-list';
import { event } from '@/db/schema';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET as readTeachingBrief } from './prep-desk-brief';
import { GET as readProposals } from './proposals-list';

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

// @invariant security: stored private evidence never crosses any learner proposal/brief read boundary
// @fails-if a real route exposes raw secrets through payload, legacy reasoning, presentation, or brief summary
it('reads private proposal evidence safely without rewriting its stored history', async () => {
  const db = testDb();
  const reason =
    'recent_failure_count_30d=1; api_key=sk-proj-private-example; email=other@example.test';
  await writeAiProposal(db, {
    id: 'privacy-archive',
    payload: {
      kind: 'archive',
      target: { subject_kind: 'learning_item', subject_id: 'item-1' },
      reason_md: reason,
      evidence_refs: [{ kind: 'event', id: 'original-evidence' }],
      proposed_change: { archived_reason: reason, reason, expected_version: 7 },
      rollback_plan: { reasoning: reason },
    },
  });
  await writeAiProposal(db, {
    id: 'privacy-knowledge',
    payload: {
      kind: 'knowledge_node',
      target: { subject_kind: 'knowledge', subject_id: null },
      reason_md: reason,
      evidence_refs: [{ kind: 'event', id: 'original-evidence' }],
      proposed_change: { mutation: 'propose_new', name: '数列', parent_id: null },
      rollback_plan: { reasoning: reason },
    },
  });
  await writeAiProposal(db, {
    id: 'privacy-finding',
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: 'kc-chain-rule' },
      reason_md: reason,
      evidence_refs: [{ kind: 'event', id: 'original-evidence' }],
      cooldown_key: 'privacy-conjecture',
      proposed_change: {
        claim_md: '需要检验复合函数求导方法。',
        knowledge_id: 'kc-chain-rule',
        cause_category: 'concept_misunderstanding',
        confidence: 0.7,
        recurrence_count: 2,
        probe_md: '求 sin(x²) 的导数。',
        probe_reference_md: '2x cos(x²)。',
        discriminating: true,
        predicted_p: 0.3,
        baseline_p_at_induction: 0.6,
      },
    },
  });
  const storedBefore = await db.select().from(event).orderBy(event.id);
  const modern = await readProposals(new Request('http://localhost/api/proposals'));
  const legacy = await readLegacyProposals(new Request('http://localhost/api/knowledge/proposals'));
  const brief = await readTeachingBrief();
  expect([modern.status, legacy.status, brief.status]).toEqual([200, 200, 200]);
  const modernBody: unknown = await modern.json();
  const legacyBody: unknown = await legacy.json();
  const briefBody: unknown = await brief.json();
  const ids = z.object({ rows: z.array(z.object({ id: z.string() })) });
  expect(ids.parse(modernBody).rows.map((row) => row.id)).toEqual(
    expect.arrayContaining(['privacy-archive', 'privacy-knowledge', 'privacy-finding']),
  );
  expect(ids.parse(legacyBody).rows.map((row) => row.id)).toContain('privacy-knowledge');
  expect(briefBody).toMatchObject({
    brief: {
      brief_id: 'privacy-finding',
      state: 'finding',
      basis: { summary_md: '这条提议暂无可读的依据说明，请核实后再决定是否采纳。' },
    },
  });
  const wire = JSON.stringify({ modernBody, legacyBody, briefBody });
  expect(wire).not.toContain('sk-proj-private-example');
  expect(wire).not.toContain('other@example.test');
  expect(wire).not.toContain('recent_failure_count_30d');
  expect(wire).toContain('original-evidence');
  expect(await db.select().from(event).orderBy(event.id)).toEqual(storedBefore);
  const [stored] = await db.select().from(event).where(eq(event.id, 'privacy-archive'));
  expect(JSON.stringify(stored.payload)).toContain(reason);
});
