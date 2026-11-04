// YUK-1770 P1-1 deterministic check: three steering writes through the REAL
// command path produce three distinct reaction jobs (per-event singleton keys).
import { db } from '@/db/client';
import { createLearnerSteering, updateGoalScope, updateGoalStatus } from '@/kernel/records/goal-commands';
import type { SteeringGoalDataT } from '@/core/schema/steering';

const mk = (words: string, instr: string): SteeringGoalDataT => ({
  learner_words: words, instruction_md: instr, scope_text: null,
  scope_unresolved: [], excluded_subject_ids: [], excluded_knowledge_ids: [], metadata: {},
});

const goalId = await createLearnerSteering(db, {
  title: 'P1-1 job-count check', subject_id: 'math', scope_knowledge_ids: ['devseed:math:monotonicity'],
  sequence_hint: 0, effective_from: '2026-11-04', effective_until: '2026-11-20',
  steering: mk('11月20日期中考', 'P1 检查：11月20日考试'), source_ref: 'yuk1770-p1-job-count',
});
console.log('event1 create →', goalId);
await new Promise((r) => setTimeout(r, 1200));
await updateGoalScope(db, goalId, { title: 'P1-1 job-count check v2', steering: mk('11月20日期中考', 'P1 检查：修订') }, new Date(), 'steering-revise');
console.log('event2 revise done');
await new Promise((r) => setTimeout(r, 1200));
await updateGoalStatus(db, goalId, 'dormant', new Date(), { ended_by: 'learner' }, 'steering-end');
console.log('event3 end done');
process.exit(0);
