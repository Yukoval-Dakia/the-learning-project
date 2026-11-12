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

// @invariant security: stored credentials never cross any learner proposal/brief read boundary
// @fails-if a real route exposes a raw credential through payload, legacy reasoning, presentation, or brief summary
it('masks credentials in proposal reasons without rewriting their stored history', async () => {
  const db = testDb();
  // Credential shapes that previously slipped past the masker: underscore-
  // prefixed key names, JSON/YAML quoted-colon forms, and a BEGIN block with no
  // END. Separators around a masked value must survive.
  const cases = [
    {
      id: 'privacy-archive',
      reason:
        'recent_failure_count_30d=1; OPENAI_API_KEY=sk-proj-private-example; email=other@example.test',
      masked: 'recent_failure_count_30d=1; OPENAI_API_KEY=[已遮蔽凭据]; email=other@example.test',
    },
    {
      id: 'privacy-knowledge',
      reason: 'dump {"password":"hunter2-json-secret"} tail',
      masked: 'dump {"password":"[已遮蔽凭据]"} tail',
    },
    {
      id: 'privacy-finding',
      reason: 'prose head -----BEGIN RSA PRIVATE KEY-----\nMIBleaked-body-no-end-marker',
      masked: 'prose head [已遮蔽凭据]',
    },
  ] as const;
  const secrets = [
    'sk-proj-private-example',
    'hunter2-json-secret',
    'MIBleaked-body-no-end-marker',
    'obj-secret-9',
    'PRIVATE KEY',
  ];
  const [archiveCase, knowledgeCase, findingCase] = cases;
  await writeAiProposal(db, {
    actor_ref: 'dreaming',
    id: archiveCase.id,
    payload: {
      kind: 'archive',
      target: { subject_kind: 'learning_item', subject_id: 'item-1' },
      reason_md: archiveCase.reason,
      evidence_refs: [{ kind: 'event', id: 'original-evidence' }],
      proposed_change: {
        archived_reason: archiveCase.reason,
        reason: archiveCase.reason,
        expected_version: 7,
      },
      rollback_plan: { reasoning: archiveCase.reason },
    },
  });
  await writeAiProposal(db, {
    actor_ref: 'dreaming',
    id: knowledgeCase.id,
    payload: {
      kind: 'knowledge_node',
      target: { subject_kind: 'knowledge', subject_id: null },
      reason_md: knowledgeCase.reason,
      evidence_refs: [{ kind: 'event', id: 'original-evidence' }],
      proposed_change: { mutation: 'propose_new', name: '数列', parent_id: null },
      // Non-string reason payloads never render — fixed fallback sentence.
      rollback_plan: { reasoning: { password: 'obj-secret-9' } },
    },
  });
  await writeAiProposal(db, {
    actor_ref: 'dreaming',
    id: findingCase.id,
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: 'kc-chain-rule' },
      reason_md: findingCase.reason,
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
    expect.arrayContaining(cases.map((c) => c.id)),
  );
  expect(ids.parse(legacyBody).rows.map((row) => row.id)).toContain(knowledgeCase.id);
  expect(briefBody).toMatchObject({
    brief: {
      brief_id: findingCase.id,
      state: 'finding',
      basis: {
        summary_md: findingCase.masked,
      },
    },
  });
  const reasonRows = z.object({
    rows: z.array(z.object({ id: z.string(), payload: z.object({ reason_md: z.string() }) })),
  });
  const reasonById = new Map(
    reasonRows.parse(modernBody).rows.map((row) => [row.id, row.payload.reason_md] as const),
  );
  for (const c of cases) {
    expect(reasonById.get(c.id)).toBe(c.masked);
  }
  const wire = JSON.stringify({ modernBody, legacyBody, briefBody });
  for (const secret of secrets) {
    expect(wire).not.toContain(secret);
  }
  // Non-credential content passes through as written.
  expect(wire).toContain('email=other@example.test');
  expect(wire).toContain('recent_failure_count_30d');
  expect(wire).toContain('original-evidence');
  expect(await db.select().from(event).orderBy(event.id)).toEqual(storedBefore);
  const [stored] = await db.select().from(event).where(eq(event.id, archiveCase.id));
  expect(JSON.stringify(stored.payload)).toContain(archiveCase.reason);
});
