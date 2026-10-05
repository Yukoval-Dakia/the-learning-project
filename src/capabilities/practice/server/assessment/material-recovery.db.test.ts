import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { assessment_issuance, question, question_revision } from '@/db/schema';
import {
  type NormalizableQuestionRow,
  contractIntegrityDigest,
  normalizeQuestionGroupToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { issueAssessment } from './issue';
import { getIssuanceState } from './submit';

const NOW = new Date('2026-10-04T00:00:00.000Z');
const ORIGINAL =
  '阅读材料：沿坡面流动的雨水。\n\n' +
  '保持水量，比较坡度；$v = \\sqrt{2gh}$，单位 m/s。\n'.repeat(30) +
  '|坡度|流速|\n|5°|0.4|\n|10°|0.8|';
const REPLACEMENT = '重新发布的材料：原记录不得用这份替换。';
const PRIVATE = {
  reference_solution: {
    final_answer: 'PRIVATE ANSWER: 坡度与流速',
    expected_signals: ['控制变量'],
    answer_equivalents: ['流速增大'],
  },
  criteria: [{ name: '控制变量', weight: 2, descriptor: '保持水量' }],
};

async function seed() {
  const common = {
    kind: 'choice' as const,
    knowledge_ids: [],
    difficulty: 3,
    source: 'web_sourced' as const,
    variant_depth: 0,
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  };
  await testDb()
    .insert(question)
    .values({ ...common, id: 'reading-root', prompt_md: ORIGINAL, rubric_json: PRIVATE });
  await testDb()
    .insert(question)
    .values({
      ...common,
      id: 'reading-child',
      parent_question_id: 'reading-root',
      prompt_md: '哪项解释最符合材料？',
      reference_md: 'A',
      choices_md: ['流速增大', '流速不变'],
    });
}

async function publish(
  legacy: boolean,
  expectedRevision: string | null,
  expectedGeneration: number | null,
) {
  const db = testDb();
  const [root] = await db.select().from(question).where(eq(question.id, 'reading-root'));
  const [child] = await db.select().from(question).where(eq(question.id, 'reading-child'));
  const normalized = normalizeQuestionGroupToContract(root as NormalizableQuestionRow, [
    child as NormalizableQuestionRow,
  ]);
  if (legacy) {
    // Construct the historical, unmarked JSON before publishing, never mutate a stored revision.
    for (const material of normalized.structure.materials) delete material.visibility;
  }
  normalized.integrity_digest = contractIntegrityDigest(normalized);
  const result = await publishQuestionGroup(db, {
    group_id: normalized.group_id,
    contract: normalized,
    expectedCurrentRevision: expectedRevision,
    expectedAdmissionGeneration: expectedGeneration,
    availability: 'general_pool',
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: null,
      },
    },
    actorRef: 'test:material-recovery',
    now: NOW,
  });
  if (result.status !== 'published') throw new Error(`publish: ${result.status}`);
  return result;
}

describe('YUK-1047 frozen public material recovery', () => {
  beforeEach(resetDb);

  it.each([false, true])(
    'restores exact material bytes after republish; legacy unmarked=%s',
    async (legacy) => {
      await seed();
      const first = await publish(legacy, null, null);
      const issued = await issueAssessment(testDb(), {
        group_id: 'reading-root',
        revision_id: first.revision_id,
        issuance_id: 'reading-issuance',
        now: NOW,
      });
      expect(issued.status).toBe('issued');
      if (issued.status !== 'issued') throw new Error(issued.status);
      const [frozenRevision] = await testDb()
        .select()
        .from(question_revision)
        .where(eq(question_revision.revision_id, first.revision_id));
      const [frozenIssuance] = await testDb()
        .select()
        .from(assessment_issuance)
        .where(eq(assessment_issuance.issuance_id, 'reading-issuance'));
      const privateMaterial = frozenRevision.structure.materials.find((m) =>
        m.asset.asset_id.startsWith('rub_'),
      );
      expect(privateMaterial?.content_md).toContain('PRIVATE ANSWER');
      expect(privateMaterial?.visibility).toBe(legacy ? undefined : 'private');
      expect(issued.issuance.binding.material_bindings).toHaveLength(3);
      expect(
        frozenRevision.structure.materials.find((material) =>
          material.asset.asset_id.startsWith('sol_'),
        ),
      ).toMatchObject({ content_md: 'A' });
      expect(issued.practice_dto.materials).toHaveLength(1);
      expect(issued.practice_dto.materials[0].content_md).toBe(ORIGINAL);
      expect(issued.practice_dto.faces[0].prompt_md).toBe('哪项解释最符合材料？');
      expect(issued.practice_dto.faces[0].material_ids).toEqual([
        issued.practice_dto.materials[0].material_id,
      ]);
      expect(JSON.stringify(issued.practice_dto)).not.toMatch(/PRIVATE|rub_|sol_/);

      await testDb()
        .update(question)
        .set({
          prompt_md: REPLACEMENT,
          rubric_json: {
            ...PRIVATE,
            reference_solution: { ...PRIVATE.reference_solution, final_answer: 'NEW PRIVATE' },
          },
        })
        .where(eq(question.id, 'reading-root'));
      const second = await publish(false, first.revision_id, first.admission_generation);
      expect(second.revision_id).not.toBe(first.revision_id);
      const current = await issueAssessment(testDb(), { group_id: 'reading-root', now: NOW });
      if (current.status !== 'issued') throw new Error(current.status);
      expect(current.practice_dto.materials[0].content_md).toBe(REPLACEMENT);

      const recovered = await getIssuanceState(testDb(), 'reading-issuance');
      expect(recovered.practice_dto).toEqual(issued.practice_dto);
      expect(recovered.issuance?.binding).toEqual(issued.issuance.binding);
      const replay = await issueAssessment(testDb(), {
        group_id: 'reading-root',
        revision_id: first.revision_id,
        issuance_id: 'reading-issuance',
        now: NOW,
      });
      expect(replay.status).toBe('replayed');
      if (replay.status !== 'replayed') throw new Error(replay.status);
      expect(replay.practice_dto).toEqual(issued.practice_dto);
      expect(replay.issuance.binding).toEqual(issued.issuance.binding);
      const [afterRevision] = await testDb()
        .select()
        .from(question_revision)
        .where(eq(question_revision.revision_id, first.revision_id));
      const [afterIssuance] = await testDb()
        .select()
        .from(assessment_issuance)
        .where(eq(assessment_issuance.issuance_id, 'reading-issuance'));
      expect(afterRevision).toEqual(frozenRevision);
      expect(afterIssuance).toEqual(frozenIssuance);
    },
  );
});
