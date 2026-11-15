import { inArray } from 'drizzle-orm';
import { acceptedProcessEventId } from '@/core/assessment-input';
import { crisisDerivationPayload } from '@/core/crisis/classify';
import { canonicalHash } from '@/core/migration/canonical';
import { GroupInputContractError } from '@/core/schema/assessment/group-input';
import {
  AcceptedLearnerProcess,
  type AcceptedLearnerProcessT,
} from '@/core/schema/assessment/judgment';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';

const ACCEPTED_PROCESS_ACTION = 'experimental:assessment_accepted_process';
type ProcessRow = Pick<
  typeof event.$inferSelect,
  'id' | 'action' | 'actor_kind' | 'actor_ref' | 'subject_kind' | 'subject_id' | 'payload'
>;

/** Missing means historical/absent; null means an untrusted or malformed binding. */
export function projectAcceptedProcesses(rows: readonly ProcessRow[]) {
  const bindings = new Map<string, AcceptedLearnerProcessT | null>();
  for (const row of rows) {
    if (row.id !== acceptedProcessEventId(row.subject_id) && row.action !== ACCEPTED_PROCESS_ACTION)
      continue;
    const parsed = AcceptedLearnerProcess.safeParse(row.payload);
    const valid =
      parsed.success &&
      row.id === acceptedProcessEventId(parsed.data.submission_id) &&
      row.action === ACCEPTED_PROCESS_ACTION &&
      row.actor_kind === 'user' &&
      row.actor_ref === 'self' &&
      row.subject_kind === 'submission' &&
      row.subject_id === parsed.data.submission_id;
    bindings.set(row.subject_id, valid && parsed.success ? parsed.data : null);
  }
  return bindings;
}

/** One bounded read shared by grading, activation and verdict batch projection. */
export async function loadAcceptedProcesses(db: Db | Tx, submissionIds: readonly string[]) {
  const bindings = new Map<string, AcceptedLearnerProcessT | null>();
  for (let offset = 0; offset < submissionIds.length; offset += 64) {
    const ids = submissionIds.slice(offset, offset + 64).map(acceptedProcessEventId);
    const rows = await db.select().from(event).where(inArray(event.id, ids));
    const projected = projectAcceptedProcesses(rows);
    for (const [index, id] of ids.entries()) {
      const row = rows.find((item) => item.id === id);
      if (row) bindings.set(submissionIds[offset + index], projected.get(row.subject_id) ?? null);
    }
  }
  return bindings;
}

/** Caller holds the formal acceptance transaction; never call for a replayed submission. */
export async function recordAcceptedProcess(
  tx: Tx,
  process: AcceptedLearnerProcessT,
  submittedAt: string,
) {
  const payload = AcceptedLearnerProcess.parse(process);
  await writeEvent(tx, {
    id: acceptedProcessEventId(payload.submission_id),
    actor_kind: 'user',
    actor_ref: 'self',
    action: ACCEPTED_PROCESS_ACTION,
    subject_kind: 'submission',
    subject_id: payload.submission_id,
    outcome: 'success',
    payload: { ...payload, ...crisisDerivationPayload(payload.reasoning_trace) },
    created_at: new Date(submittedAt),
    ingest_at: new Date(submittedAt),
    affected_scopes: [],
  });
  const stored = (await loadAcceptedProcesses(tx, [payload.submission_id])).get(
    payload.submission_id,
  );
  if (!stored || canonicalHash(stored) !== canonicalHash(payload)) {
    throw new GroupInputContractError('invalid_group_input', 'accepted process receipt conflicts');
  }
}
