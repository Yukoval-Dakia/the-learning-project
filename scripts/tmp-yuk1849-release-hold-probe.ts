// tmp probe: does release_verify_hold on a config_error-held draft serve an
// unverified question? Runs the real command entry against the dev DB, then
// re-reads lifecycle + serving projection.
//   DATABASE_URL=... pnpm exec tsx scripts/tmp-yuk1849-release-hold-probe.ts <questionId>
import { eq, sql } from 'drizzle-orm';
import { runServingAction } from '@/capabilities/practice/question-bank/server/serving-actions';
import { db } from '@/db/client';
import { question, question_group_lifecycle } from '@/db/schema';
import { readQuestionServing } from '@/kernel/read-models/question-serving';

const qid = process.argv[2];
if (!qid) throw new Error('usage: probe <questionId>');

const before = await db.execute(sql`
  select q.id, q.draft_status, l.suspended, l.suspension_reason,
         l.scoring_admission_state, l.scoring_admission_withheld_reason,
         l.current_revision_id
  from question q left join question_group_lifecycle l on l.group_id = q.id
  where q.id = ${qid}`);
console.log('BEFORE', JSON.stringify((before as unknown as unknown[])[0]));
const verif = await db.execute(sql`
  select policy_id, outcome, evidence->>'config_error' as config_error, generation
  from question_admission_verification
  where revision_id = ${(before as unknown as Array<{ current_revision_id: string }>)[0]?.current_revision_id ?? ''}
  order by recorded_at desc limit 3`);
console.log('VERIFICATIONS', JSON.stringify(verif));
const servingBefore = await readQuestionServing(db, [qid]);
console.log('SERVING_BEFORE', JSON.stringify(servingBefore.byId.get(qid)));

const result = await runServingAction(db, {
  questionId: qid,
  command: 'release_verify_hold',
  idempotencyKey: `arc-release-probe-${qid.slice(-8)}`,
  actor: 'user',
});
console.log('RELEASE_RESULT', JSON.stringify(result));

const after = await db.execute(sql`
  select q.id, q.draft_status, l.suspended, l.suspension_reason,
         l.scoring_admission_state, l.scoring_admission_withheld_reason
  from question q left join question_group_lifecycle l on l.group_id = q.id
  where q.id = ${qid}`);
console.log('AFTER', JSON.stringify((after as unknown as unknown[])[0]));
const servingAfter = await readQuestionServing(db, [qid]);
const s = servingAfter.byId.get(qid);
console.log('SERVING_AFTER', JSON.stringify(s));
console.log(
  'VERDICT',
  s?.servable === true ? 'P1: UNVERIFIED QUESTION SERVABLE' : 'safe: not servable',
);
process.exit(0);
