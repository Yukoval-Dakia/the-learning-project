import { createId } from '@paralleldrive/cuid2';
import { getSubagentRun } from '@/capabilities/copilot/server/subagent-mailbox';
import type { Db } from '@/db/client';
import { subagent_run } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { writeEvent } from '@/kernel/events';

/** Historical persisted rows, not a second implementation of retired dispatch/claim logic. */
export async function seedLegacySubagentRun(
  db: Db,
  input: {
    sessionId: string;
    parentTurnEventId: string;
    parentTaskRunId: string;
    launchKey: string;
    objective: string;
    status?: 'queued' | 'running';
  },
) {
  const id = `legacy_subagent_${createId()}`;
  const startedEventId = `subagent_started_${id}`;
  const now = new Date();
  const running = input.status === 'running';
  await db.insert(subagent_run).values({
    id,
    session_id: input.sessionId,
    parent_turn_event_id: input.parentTurnEventId,
    parent_task_run_id: input.parentTaskRunId,
    launch_key: input.launchKey,
    objective: input.objective,
    objective_hash: sha256CanonicalJson({ objective: input.objective }),
    started_event_id: startedEventId,
    status: input.status ?? 'queued',
    ...(running
      ? {
          started_at: now,
          claim_token: `historical_claim_${id}`,
          child_task_run_id: `historical_task_${id}`,
          lease_expires_at: new Date(now.getTime() + 30_000),
          hard_deadline_at: new Date(now.getTime() + 720_000),
        }
      : {}),
    created_at: now,
    updated_at: now,
  });
  await writeEvent(db, {
    id: startedEventId,
    session_id: input.sessionId,
    actor_kind: 'agent',
    actor_ref: 'agent:copilot',
    action: 'experimental:subagent_run_started',
    subject_kind: 'subagent_run',
    subject_id: id,
    outcome: null,
    payload: { run_id: id, launch_key: input.launchKey, objective: input.objective },
    caused_by_event_id: input.parentTurnEventId,
    task_run_id: input.parentTaskRunId,
    created_at: now,
  });
  return { record: await getSubagentRun(db, id) };
}
