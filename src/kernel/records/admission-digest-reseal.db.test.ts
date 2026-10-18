import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { question, question_group_lifecycle, question_revision } from '@/db/schema';
import { resealAdmissionDigests } from '@/kernel/records/admission-digest-reseal';
import {
  contractIntegrityDigest,
  normalizeQuestionRowToContract,
  publishedContractSeal,
} from '@/kernel/records/assessment-normalization';
import { resetDb, testDb } from '../../../tests/helpers/db';

const NOW = new Date('2026-10-18T00:00:00.000Z');

async function seedCallerOrder() {
  const db = testDb();
  const groupId = 'reseal-q';
  await db.insert(question).values({
    id: groupId,
    kind: 'choice',
    prompt_md: '哪项是受控变量？',
    reference_md: 'B',
    choices_md: ['坡度', '水量与材质', '测得的流速'],
    knowledge_ids: [],
    difficulty: 3,
    source: 'web_sourced',
    variant_depth: 0,
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
  const [row] = await db.select().from(question).where(eq(question.id, groupId));
  if (row == null) throw new Error('missing question');
  const contract = normalizeQuestionRowToContract(row);
  const slot = contract.response_spec.slots[0];
  if (slot == null) throw new Error('missing slot');
  slot.placement = { row: 0, col: 0, label: '1' };
  const callerDigest = contractIntegrityDigest(contract);
  const canonical = publishedContractSeal(contract).canonical;
  const revisionId = 'reseal-rev';
  await db.insert(question_revision).values({
    revision_id: revisionId,
    group_id: groupId,
    revision_ordinal: 1,
    integrity_digest: callerDigest,
    structure: contract.structure,
    response_spec: contract.response_spec,
    scoring_basis: contract.scoring_basis,
    execution_plan: contract.execution_plan,
    availability: 'general_pool',
    published_at: NOW,
  });
  await db.insert(question_group_lifecycle).values({
    group_id: groupId,
    current_revision_id: revisionId,
    availability: 'general_pool',
    scoring_admission_state: 'withheld',
    scoring_admission_withheld_reason: 'owner_hold',
    scoring_admission_generation: 0,
    claim_policy: 'unbounded',
    suspended: false,
    withdrawn: false,
    created_at: NOW,
    updated_at: NOW,
  });
  return { groupId, revisionId, callerDigest, canonical };
}

describe('resealAdmissionDigests', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant data: apply appends a canonical revision and leaves the caller-order digest in place
  // @fails-if apply updates question_revision in place, or a second apply appends another revision
  it('appends one canonical revision and a rerun appends none', async () => {
    const db = testDb();
    const seeded = await seedCallerOrder();
    const first = await resealAdmissionDigests(db, { apply: true });
    const rows = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.group_id, seeded.groupId));
    const kept = rows.find((row) => row.revision_id === seeded.revisionId);
    expect(kept?.integrity_digest).toBe(seeded.callerDigest);
    expect(rows.map((row) => row.integrity_digest)).toContain(seeded.canonical);
    expect(first.appended).toBe(1);
    const second = await resealAdmissionDigests(db, { apply: true });
    const after = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.group_id, seeded.groupId));
    expect(second.appended).toBe(0);
    expect(after).toHaveLength(rows.length);
  });
});
