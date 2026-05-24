import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

let _client: ReturnType<typeof postgres> | undefined;
let _db: Db | undefined;

export function testDb(): Db {
  if (_db) return _db;
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set — globalSetup did not run');
  _client = postgres(url, { max: 4 });
  _db = drizzle(_client, { schema }) as unknown as Db;
  return _db;
}

// Truncate all known tables, used in beforeEach for hermetic tests.
// CASCADE handles FK dependencies; whitelist of identifiers (not user input).
// Phase 1c.1 Step 9.J: mistake / review_event / dreaming_proposal /
// ingestion_session DROPped — removed from this list. Step 1.4: judgment +
// user_appeal previously dropped per data-assumptions §O2.
const ALL_TABLES = [
  'event',
  'proposal_signals',
  'material_fsrs_state',
  'knowledge_edge',
  'learning_session',
  'answer',
  'completion_evidence',
  'memory_brief_note',
  'learning_record',
  'artifact',
  'learning_item',
  'mistake_variant',
  'question_block',
  'question',
  'source_document',
  'source_asset',
  'knowledge',
  'ai_task_runs',
  'tool_call_log',
  'cost_ledger',
] as const;

export async function resetDb() {
  const db = testDb();
  for (const t of ALL_TABLES) {
    await db.execute(sql.raw(`TRUNCATE TABLE "${t}" RESTART IDENTITY CASCADE`));
  }
}
