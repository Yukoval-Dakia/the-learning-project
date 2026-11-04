// YUK-1770 debug: reproduce the record_steering genesis barrier failure.
import { db } from '@/db/client';
import { createLearnerSteering } from '@/kernel/records/goal-commands';
import type { SteeringGoalDataT } from '@/core/schema/steering';

const steering: SteeringGoalDataT = {
  learner_words: '11月20日期中考，范围是函数单调性和圆锥曲线',
  instruction_md: '11月20日期中考试，复习范围：函数单调性 + 圆锥曲线。',
  scope_text: '函数单调性和圆锥曲线',
  scope_unresolved: [],
  excluded_subject_ids: [],
  excluded_knowledge_ids: [],
  metadata: { exam_type: '期中考试' },
};

try {
  const id = await createLearnerSteering(db, {
    title: '11月20日期中考试',
    subject_id: 'math',
    scope_knowledge_ids: ['devseed:math:monotonicity', 'devseed:math:conic'],
    sequence_hint: 0,
    effective_from: '2026-11-04',
    effective_until: '2026-11-20',
    steering,
    source_ref: 'yuk1770-debug-script',
  });
  console.log('CREATED', id);
} catch (err) {
  console.log('FAILED:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.cause) console.log('CAUSE:', String(err.cause).slice(0, 800));
}
process.exit(0);
