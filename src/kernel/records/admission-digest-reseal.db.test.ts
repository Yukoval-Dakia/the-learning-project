import { sql } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { runAdmissionForQuestion } from '@/capabilities/practice/jobs/question_admission_run';
import { question, question_group_lifecycle, question_revision } from '@/db/schema';
import { resealAdmissionDigests } from '@/kernel/records/admission-digest-reseal';
import * as norm from '@/kernel/records/assessment-normalization';
import { resetDb, testDb } from '../../../tests/helpers/db';

const NOW = new Date('2026-10-18T00:00:00.000Z');
const RAW =
  '{"id":"q","kind":"choice","prompt_md":"哪项是受控变量？","reference_md":"B","rubric_json":null,"choices_md":["坡度","水量","流速"],"judge_kind_override":null,"structured":null,"source":"web_sourced"}';

beforeEach(resetDb);

async function plantCallerOrder() {
  const db = testDb();
  const contract = norm.normalizeQuestionRowToContract(
    JSON.parse(RAW) as norm.NormalizableQuestionRow,
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
    ...{
      scoring_admission_state: 'withheld',
      scoring_admission_withheld_reason: 'unverified_rules',
    },
    ...{ claim_policy: 'unbounded', created_at: NOW, updated_at: NOW },
  });
  return { db, caller, canonical };
}

// @invariant data: apply appends a canonical revision and leaves the caller-order digest
// @fails-if apply updates question_revision in place, or a second apply appends another revision
it('appends one canonical revision and a rerun appends none', async () => {
  const { db, caller, canonical } = await plantCallerOrder();
  const first = await resealAdmissionDigests(db, { apply: true });
  const rows = await db.select().from(question_revision);
  const added = rows.find((row) => row.revision_id !== 'r');
  expect([first.appended, added?.integrity_digest]).toEqual([1, canonical]);
  expect(rows.find((row) => row.revision_id === 'r')?.integrity_digest).toBe(caller);
  expect((await resealAdmissionDigests(db, { apply: true })).appended).toBe(0);
});

// @invariant data: a matching admission digest is graded and a changed stored layer is stale
// @fails-if a tampered layer is graded, or a matching digest is refused as stale
it('grades a matching digest and marks that revision stale after one layer changes', async () => {
  const { db, canonical } = await plantCallerOrder();
  const id = (await resealAdmissionDigests(db, { apply: true })).appended_rows[0].to_revision_id;
  const job = { question_id: 'q', revision_id: id, expected_revision_digest: canonical };
  const stop = async () => Promise.reject(new Error('stop'));
  const run = runAdmissionForQuestion;
  expect((await run(db, job, { id: 'd1' }, { runTask: stop })).status).toBe('pending');
  await db.execute(sql`delete from paid_effect`);
  await db.$client.unsafe(
    `do $$ begin alter table question_revision disable trigger question_revision_immutable; update question_revision set structure = jsonb_set(structure, '{parts,0,prompt_md}', '"改"') where revision_id = '${id}'; alter table question_revision enable trigger question_revision_immutable; exception when others then alter table question_revision enable trigger question_revision_immutable; raise; end $$`,
  );
  expect((await run(db, job, { id: 'd2' }, { runTask: stop })).status).toBe('stale');
});
