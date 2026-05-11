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
const ALL_TABLES = [
  'user_appeal',
  'judgment',
  'answer',
  'completion_evidence',
  'review_event',
  'mistake',
  'study_log',
  'artifact',
  'learning_item',
  'question_block',
  'question',
  'ingestion_session',
  'source_document',
  'source_asset',
  'knowledge',
  'dreaming_proposal',
  'tool_call_log',
  'cost_ledger',
] as const;

export async function resetDb() {
  const db = testDb();
  for (const t of ALL_TABLES) {
    await db.execute(sql.raw(`TRUNCATE TABLE "${t}" RESTART IDENTITY CASCADE`));
  }
}
