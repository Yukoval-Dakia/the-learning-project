import { expect, it } from 'vitest';
import { runAdmissionForQuestion as run } from '@/capabilities/practice/jobs/question_admission_run';
import { resealAdmissionDigests as reseal } from '@/kernel/records/admission-digest-reseal';
import * as norm from '@/kernel/records/assessment-normalization';
import { resetDb, testDb } from '../../../tests/helpers/db';

const RAW =
  '{"id":"q","kind":"choice","prompt_md":"哪项是受控变量？","reference_md":"B","rubric_json":null,"choices_md":["坡度","水量","流速"],"judge_kind_override":null,"structured":null,"source":"web_sourced"}';
// @invariant data: append once, grade a match, stale after a layer change
// @fails-if a rerun appends, a match is stale, or a changed layer is graded
it('appends once, grades a matching digest, and marks a changed layer stale', async () => {
  await resetDb();
  const db = testDb();
  const c = norm.normalizeQuestionRowToContract(JSON.parse(RAW) as norm.NormalizableQuestionRow);
  c.response_spec.slots[0].placement = { row: 0, col: 0, label: '1' };
  const canonical = norm.publishedContractSeal(c).canonical;
  const q = (layer: object) => JSON.stringify(layer).replaceAll("'", "''");
  await db.$client.unsafe(
    `insert into question (id,kind,prompt_md,source,created_at,updated_at) values ('q','x','x','m',now(),now()); insert into question_revision (revision_id,group_id,revision_ordinal,integrity_digest,structure,response_spec,scoring_basis,execution_plan,availability,published_at) values ('r','q',1,'${norm.contractIntegrityDigest(c)}','${q(c.structure)}'::jsonb,'${q(c.response_spec)}'::jsonb,'${q(c.scoring_basis)}'::jsonb,'${q(c.execution_plan)}'::jsonb,'general_pool',now()); insert into question_group_lifecycle (group_id,current_revision_id,availability,scoring_admission_state,scoring_admission_withheld_reason,claim_policy,created_at,updated_at) values ('q','r','general_pool','withheld','unverified_rules','unbounded',now(),now())`,
  );
  const first = await reseal(db, { apply: true });
  const id = first.appended_rows[0].to_revision_id;
  const job = { question_id: 'q', revision_id: id, expected_revision_digest: canonical };
  const stop = async () => Promise.reject(new Error('stop'));
  expect([first.appended, (await reseal(db, { apply: true })).appended]).toEqual([1, 0]);
  expect((await run(db, job, { id: 'd1' }, { runTask: stop })).status).toBe('pending');
  await db.$client.unsafe(
    `delete from paid_effect; do $$ begin alter table question_revision disable trigger question_revision_immutable; update question_revision set structure = jsonb_set(structure, '{parts,0,prompt_md}', '"改"') where revision_id = '${id}'; alter table question_revision enable trigger question_revision_immutable; exception when others then alter table question_revision enable trigger question_revision_immutable; raise; end $$`,
  );
  expect((await run(db, job, { id: 'd2' }, { runTask: stop })).status).toBe('stale');
});
