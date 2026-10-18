import { beforeEach, expect, it } from 'vitest';
import { question, question_group_lifecycle, question_revision } from '@/db/schema';
import { resealAdmissionDigests } from '@/kernel/records/admission-digest-reseal';
import * as norm from '@/kernel/records/assessment-normalization';
import { resetDb, testDb } from '../../../tests/helpers/db';

const NOW = new Date('2026-10-18T00:00:00.000Z');
beforeEach(resetDb);
// @invariant data: apply appends a canonical revision and leaves the caller-order digest
// @fails-if apply updates question_revision in place, or a second apply appends another revision
it('appends one canonical revision and a rerun appends none', async () => {
  const db = testDb();
  const raw =
    '{"id":"q","kind":"choice","prompt_md":"哪项是受控变量？","reference_md":"B","rubric_json":null,"choices_md":["坡度","水量","流速"],"judge_kind_override":null,"structured":null,"source":"web_sourced"}';
  const contract = norm.normalizeQuestionRowToContract(
    JSON.parse(raw) as norm.NormalizableQuestionRow,
  );
  contract.response_spec.slots[0]!.placement = { row: 0, col: 0, label: '1' };
  const caller = norm.contractIntegrityDigest(contract);
  const canonical = norm.publishedContractSeal(contract).canonical;
  const q = { id: 'q', kind: 'x', prompt_md: 'x', source: 'm', created_at: NOW, updated_at: NOW };
  await db.insert(question).values(q);
  await db.insert(question_revision).values({
    ...{ revision_id: 'r', group_id: 'q', revision_ordinal: 1, integrity_digest: caller },
    ...{ structure: contract.structure, response_spec: contract.response_spec },
    ...{ scoring_basis: contract.scoring_basis, execution_plan: contract.execution_plan },
    ...{ availability: 'general_pool', published_at: NOW },
  });
  await db.insert(question_group_lifecycle).values({
    ...{ group_id: 'q', current_revision_id: 'r', availability: 'general_pool' },
    ...{ scoring_admission_state: 'withheld', scoring_admission_withheld_reason: 'owner_hold' },
    ...{ claim_policy: 'unbounded', created_at: NOW, updated_at: NOW },
  });
  const first = await resealAdmissionDigests(db, { apply: true });
  const rows = await db.select().from(question_revision);
  const added = rows.find((row) => row.revision_id !== 'r');
  expect([first.appended, added?.integrity_digest]).toEqual([1, canonical]);
  expect(rows.find((row) => row.revision_id === 'r')?.integrity_digest).toBe(caller);
  expect((await resealAdmissionDigests(db, { apply: true })).appended).toBe(0);
});
