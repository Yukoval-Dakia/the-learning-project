/**
 * One-time stock repair: retire question-level FSRS cards whose question now
 * carries a knowledge label. Not a migration, and CI does not run it.
 *
 * Usage: pnpm ops:retire-labeled-question-cards [--dry-run]
 */
import './load-env';

import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { material_fsrs_state, question } from '@/db/schema';
import { retireQuestionFsrsState } from '@/kernel/records/scheduling-state';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const rows = await db
    .select({ questionId: material_fsrs_state.subject_id })
    .from(material_fsrs_state)
    .innerJoin(question, eq(question.id, material_fsrs_state.subject_id))
    .where(
      and(
        eq(material_fsrs_state.subject_kind, 'question'),
        sql`jsonb_array_length(${question.knowledge_ids}) > 0`,
      ),
    )
    .orderBy(material_fsrs_state.subject_id);
  const questionIds = rows.map((row) => row.questionId);
  let retired = 0;
  if (!dryRun) {
    await db.transaction(async (tx) => {
      for (const questionId of questionIds) {
        if (await retireQuestionFsrsState(tx, questionId)) retired += 1;
      }
    });
  }
  console.log(
    JSON.stringify(
      {
        operation: 'retire_labeled_question_cards',
        dry_run: dryRun,
        matched: questionIds.length,
        retired: dryRun ? 0 : retired,
        would_retire: dryRun ? questionIds.length : 0,
        question_ids: questionIds,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
