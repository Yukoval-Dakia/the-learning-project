import { sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { learning_session } from '@/db/schema';
import type {
  SessionOrphanFamily,
  SessionOrphanRequest,
} from '@/server/durable/session-orphan-family';
import { resetDb, testDb } from '../helpers/db';
export const families = [
  'prune_orphan_conversation_sessions',
  'prune_orphan_placement_sessions',
] as const;
export const scheduledAt = new Date('2026-10-09T00:00:00.000Z');
export const typeFor = (family: SessionOrphanFamily) =>
  family === families[0] ? 'conversation' : 'placement';
export const liveFor = (family: SessionOrphanFamily) =>
  family === families[0] ? 'active' : 'started';
export function native(family: SessionOrphanFamily, offset = 0): SessionOrphanRequest {
  const at = new Date(scheduledAt.getTime() + offset);
  return {
    family,
    source: { kind: 'dbos', workflowId: `sched-${family}-${at.toISOString()}`, scheduledAt: at },
  };
}
export async function resetOrphans(phase = 'dbos') {
  await resetDb();
  await testDb().execute(
    sql`truncate session_orphan_disposition, session_orphan_receipt, session_orphan_tick`,
  );
  await testDb().execute(
    sql`update session_orphan_control set phase = ${phase}, legacy_not_before = null, phase_changed_at = clock_timestamp()`,
  );
}
export async function startSession(
  family: SessionOrphanFamily,
  id: string,
  at = '2026-10-08 17:59:59.999999+00',
  status = liveFor(family),
) {
  await testDb()
    .insert(learning_session)
    .values({
      id,
      type: typeFor(family),
      status,
      started_at: sql`${at}::timestamptz`,
      version: 7,
      summary_md: '旧上下文 with nested mathematics\n'.repeat(300),
      warnings: ['uncertain goal', 'retain original evidence'],
      source_asset_ids: ['asset-a', 'asset-b'],
    });
  return id;
}
export async function effects(family: SessionOrphanFamily, id?: string) {
  return testDb().execute(sql`select business_id, event_type, payload from job_events
    where event_type = ${`${typeFor(family)}.abandoned`} and (${id ?? null}::text is null or business_id = ${id ?? null}) order by business_id`);
}
export async function legacyTask(family: SessionOrphanFamily) {
  const boss = new PgBoss({
    connectionString: process.env.TEST_DATABASE_URL,
    schedule: false,
    supervise: false,
  });
  boss.on('error', () => {});
  await boss.start();
  try {
    await boss.createQueue(family);
    const jobId = await boss.send(family, {});
    if (!jobId) throw new Error('Missing real legacy UUID');
    return { family, source: { kind: 'pg-boss', jobId } } satisfies SessionOrphanRequest;
  } finally {
    await boss.stop();
  }
}
