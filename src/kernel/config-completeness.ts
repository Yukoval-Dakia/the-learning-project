// Server settings whose absence does not stop the process but silently disables a feature.
// `/api/ready` and both boot paths report them, so a deploy that drops one is caught by the
// operator rather than by a learner. The rules mirror the readers that would otherwise fail
// closed (bank search: at least 32 characters and not the INTERNAL_TOKEN).
// Lives in kernel so readers in any capability (task-failure alerts) share the action and the
// payload shape without a capability → server edge.
import { z } from 'zod';
import type { Db } from '@/db/client';
import { writeEvents } from '@/kernel/events';

export const CONFIG_INCOMPLETE_EVENT_ACTION = 'experimental:config_incomplete';

export const ConfigIncompletePayloadSchema = z.object({
  version: z.literal(1),
  process: z.enum(['api', 'worker']),
  missing: z.array(z.string()).min(1),
});
export type ConfigIncompletePayload = z.infer<typeof ConfigIncompletePayloadSchema>;

/** Pure: reads only the given environment; names of missing settings, never their values. */
export function checkConfigCompleteness(env: NodeJS.ProcessEnv = process.env): {
  complete: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  const bankGap = env.BANK_GAP_EVIDENCE_SECRET;
  if (!bankGap || bankGap.length < 32 || bankGap === env.INTERNAL_TOKEN) {
    missing.push('BANK_GAP_EVIDENCE_SECRET');
  }
  return { complete: missing.length === 0, missing };
}

/** Loud boot log plus one event per process and UTC day, so the condition is visible later. */
export async function reportConfigCompleteness(
  db: Db,
  processName: 'api' | 'worker',
  now: Date = new Date(),
): Promise<void> {
  const { complete, missing } = checkConfigCompleteness();
  if (complete) return;
  console.error(
    `\n${'!'.repeat(78)}\n!! [config] ${processName} is missing required settings: ${missing.join(', ')}\n` +
      '!! The features that depend on them are disabled until they are set; /api/ready reports 503.\n' +
      `${'!'.repeat(78)}\n`,
  );
  const day = now.toISOString().slice(0, 10);
  const id = `config_incomplete:${processName}:${day}:${missing.join(',')}`;
  try {
    await writeEvents(db, [
      {
        id,
        session_id: null,
        actor_kind: 'system',
        actor_ref: 'config_completeness',
        action: CONFIG_INCOMPLETE_EVENT_ACTION,
        subject_kind: 'query',
        subject_id: id,
        outcome: 'failure',
        payload: { version: 1, process: processName, missing } satisfies ConfigIncompletePayload,
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        // Operational record: never feed the memory pipeline.
        ingest_at: now,
        created_at: now,
      },
    ]);
  } catch (err) {
    console.error('[config] could not record the config_incomplete event', err);
  }
}
