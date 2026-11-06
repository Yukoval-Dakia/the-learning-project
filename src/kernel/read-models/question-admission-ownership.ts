import { sql } from 'drizzle-orm';
import { question } from '@/db/schema';

/** Declared generated groups already belong to admission; legacy verify must not reclaim them. */
export function declaredAdmissionOwned() {
  return sql<boolean>`coalesce(
    ${question.source} = 'quiz_gen'
    AND ${question.metadata}->>'schema_version' = '2'
    AND ${question.metadata}->>'draft_block_id' IS NOT NULL
    AND ${question.metadata}->'submit_source'->>'kind' = 'generated', false)`;
}
