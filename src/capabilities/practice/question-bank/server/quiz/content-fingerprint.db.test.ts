import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { QuestionDraftDocument } from '@/core/schema/question-draft';
import { db } from '@/db/client';
import { event, knowledge, material_fsrs_state, question } from '@/db/schema';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { draftCanonicalIdentity, draftDocumentToContract } from '@/kernel/records/question-draft-contract';
import { resetDb } from '../../../../../../tests/helpers/db';
import {
  canonicalQuestionContentHash,
  canonicalTypedQuestionContentHash,
  mergeExactQuestionDuplicateKnowledgeIds,
} from './content-fingerprint';

async function seed(id: string, draftStatus: string | null, knowledgeIds: string[] = []) {
  const content = { promptMd: 'P', referenceMd: 'A', choicesMd: ['x', 'y'] };
  const hash = canonicalQuestionContentHash(content);
  await db.insert(question).values({
    id,
    kind: 'choice',
    prompt_md: content.promptMd,
    reference_md: content.referenceMd,
    choices_md: content.choicesMd,
    source: 'manual',
    draft_status: draftStatus,
    knowledge_ids: knowledgeIds,
    canonical_content_hash: hash,
    created_at: new Date(),
    updated_at: new Date(),
  });
  return hash;
}

async function seedKnowledge(...ids: string[]) {
  const now = new Date();
  await db.insert(knowledge).values(
    ids.map((id) => ({
      id,
      name: id,
      domain: 'yuwen',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved' as const,
      created_at: now,
      updated_at: now,
      version: 0,
    })),
  );
}

describe('findExactQuestionDuplicate', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant data: a legacy hash can merge across KCs only when full current grading content agrees, without rewriting historical hashes
  // @fails-if shape/tolerance/unit differences collide, unknown peers are trusted, or legacy-equal content cannot merge after ids and source URLs change
  it.each(['answer_shape', 'tolerance', 'unit'] as const)(
    'verifies %s at the real publication and exact-merge boundary', async (field) => {
      await seedKnowledge('typed-a', 'typed-b');
      const document = QuestionDraftDocument.parse({ schema_version: 2, parts: [{
        part_id: 'part-a', prompt_md: '填写这个数值', units: [{
          unit_id: 'unit-a', slot_id: 'slot-a', response_class: 'blank',
          response_spec: { kind: 'blank', format: 'math', answer_shape: {
            version: 'k1-math-v1', value: { kind: 'number',
              unit: { unit: 'm', accepts_bare_number: true } }, notation: ['decimal', 'fraction'],
          } },
          key: { kind: 'blank', key: { kind: 'numeric', value: 1,
            unit: 'm', tolerance: { kind: 'absolute', value: 0 } } },
          points: 1, method: { kind: 'exact' }, rule: { version: 1,
            cases: [{ when: { correct: { eq: 1 } }, award: { points: 1 } }], otherwise: { points: 0 } },
        }] }], source: { kind: 'sourcing_web', ref: 'https://example.org/original' },
      });
      const identity = draftCanonicalIdentity(document);
      const legacyHash = canonicalQuestionContentHash(identity);
      const now = new Date();
      await db.insert(question).values({ id: 'typed-original', kind: 'short_answer',
        prompt_md: identity.promptMd, reference_md: identity.referenceMd,
        canonical_content_hash: legacyHash, source: 'web_sourced', knowledge_ids: ['typed-a'],
        draft_status: 'active', created_at: now, updated_at: now });
      const contract = draftDocumentToContract(document, 'typed-original');
      const published = await publishQuestionGroup(db, { group_id: 'typed-original',
        contract: { structure: contract.structure, response_spec: contract.response_spec,
          scoring_basis: contract.scoring_basis, execution_plan: contract.execution_plan,
          integrity_digest: contract.integrity_digest },
        expectedCurrentRevision: null, expectedAdmissionGeneration: null,
        admission: { state: 'admitted', evidence: { marking_provenance: 'official',
          verification: { structural_check_passed: true, independent_verification: null }, model_slice: null } },
        availability: 'general_pool', actorRef: 'test:typed-content', now,
      });
      expect(published.status, JSON.stringify(published)).toBe('published');
      await db.insert(question).values({ id: 'unknown-peer', kind: 'short_answer',
        prompt_md: identity.promptMd, reference_md: identity.referenceMd, source: 'manual',
        canonical_content_hash: 'unverified-peer-content', knowledge_ids: ['typed-a'],
        created_at: now, updated_at: now });
      const changed = structuredClone(document);
      const unit = changed.parts[0].units[0];
      if (unit.response_spec.kind !== 'blank' || unit.key?.kind !== 'blank' ||
          unit.key.key.kind !== 'numeric' || unit.response_spec.answer_shape?.value.kind !== 'number' ||
          unit.response_spec.answer_shape.value.unit == null) throw new Error('invalid numeric fixture');
      if (field === 'answer_shape') unit.response_spec.answer_shape.value.unit.accepts_bare_number = false;
      if (field === 'tolerance') unit.key.key.tolerance = { kind: 'absolute', value: 0.1 };
      if (field === 'unit') {
        unit.key.key.unit = 'cm'; unit.response_spec.answer_shape.value.unit.unit = 'cm';
      }
      const merge = (candidate: typeof document) => db.transaction((tx) =>
        mergeExactQuestionDuplicateKnowledgeIds(tx, { document: candidate,
          canonicalContentHash: canonicalTypedQuestionContentHash(candidate),
          knowledgeIds: ['typed-b'], actorRef: 'sourcing', now }));
      expect(await merge(changed)).toBeNull();
      const same = structuredClone(document);
      same.parts[0].part_id = 'different-part';
      same.parts[0].units[0].unit_id = 'different-unit';
      same.parts[0].units[0].slot_id = 'different-slot';
      same.source = { kind: 'sourcing_web', ref: 'https://example.org/another-transport' };
      same.metadata = { request_id: 'different-request' };
      expect(await merge(same)).toMatchObject({ id: 'typed-original',
        disposition: 'merged', knowledgeIds: ['typed-a', 'typed-b'] });
      const [kept] = await db.select().from(question).where(eq(question.id, 'typed-original'));
      expect(kept.canonical_content_hash).toBe(legacyHash);
      const [unknown] = await db.select().from(question).where(eq(question.id, 'unknown-peer'));
      expect(unknown.knowledge_ids).toEqual(['typed-a']);
    },
  );

  it('atomically appends missing KCs, preserves lifecycle, audits once, and no-ops on retry', async () => {
    await seedKnowledge('k-a', 'k-b');
    const hash = await seed('q-cross-kc', 'active', ['k-a']);
    const now = new Date('2026-07-19T11:00:00.000Z');

    const first = await db.transaction((tx) =>
      mergeExactQuestionDuplicateKnowledgeIds(tx, {
        canonicalContentHash: hash,
        knowledgeIds: ['k-a', 'k-b', 'k-b'],
        actorRef: 'quiz_gen',
        taskRunId: 'task-run-merge',
        now,
      }),
    );
    expect(first).toMatchObject({
      id: 'q-cross-kc',
      draftStatus: 'active',
      previousKnowledgeIds: ['k-a'],
      knowledgeIds: ['k-a', 'k-b'],
      addedKnowledgeIds: ['k-b'],
      enrolledKnowledgeIds: ['k-b'],
      previousVersion: 0,
      version: 1,
      eventId: expect.any(String),
    });

    const [row] = await db.select().from(question).where(eq(question.id, 'q-cross-kc'));
    expect(row).toMatchObject({
      knowledge_ids: ['k-a', 'k-b'],
      draft_status: 'active',
      version: 1,
      updated_at: now,
    });
    const editEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:question_edit'));
    expect(editEvents).toHaveLength(1);
    expect(editEvents[0]).toMatchObject({
      actor_kind: 'agent',
      actor_ref: 'quiz_gen',
      subject_kind: 'question',
      subject_id: 'q-cross-kc',
      payload: {
        previous_version: 0,
        next_version: 1,
        before: { knowledge_ids: ['k-a'] },
        after: { knowledge_ids: ['k-a', 'k-b'] },
        reason: 'cross_kc_exact_duplicate',
        added_knowledge_ids: ['k-b'],
        enrolled_knowledge_ids: ['k-b'],
        task_run_id: 'task-run-merge',
        preserved_draft_status: 'active',
      },
    });
    const enrolled = await db
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, 'k-b'));
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0]).toMatchObject({
      subject_kind: 'knowledge',
      last_review_event_id: first?.eventId,
    });

    const retry = await db.transaction((tx) =>
      mergeExactQuestionDuplicateKnowledgeIds(tx, {
        canonicalContentHash: hash,
        knowledgeIds: ['k-b'],
        actorRef: 'sourcing',
        now: new Date('2026-07-19T12:00:00.000Z'),
      }),
    );
    expect(retry).toMatchObject({ addedKnowledgeIds: [], version: 1, eventId: null });
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:question_edit')),
    ).toHaveLength(1);
  });
});
