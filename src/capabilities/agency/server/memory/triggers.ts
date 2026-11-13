import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Job, PgBoss } from 'pg-boss';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import {
  eventAllowsDerivationSql,
  readEventDerivationPolicy,
} from '@/kernel/events/derivation-policy';
import { loadSubjectBriefEvents, subjectScopeHasNewEvidence } from './active-subjects';
import { type GenerateBrief, regenerateMemoryBrief, scopeHasNewEvidence } from './brief';
import { executePurposeBrief } from './brief-purpose';
import { isLearnerAnswerAction, isLearnerEvidenceAction } from './learner-evidence';
import {
  type MemoryClient,
  type MemoryEventInput,
  createMem0OpaqueOperationContext,
  createMemoryClient,
  searchMemories,
} from './mem0-runtime';
import type { MemoryIngestReplayGrant } from './memory-ingest-recovery-contract';
import {
  assertMemoryIngestReplayGrant,
  claimMemoryIngestReplay,
  memoryIngestReplayAnchor,
} from './memory-ingest-recovery-store';
import {
  MemoryReconcileHandoffError,
  type ReconcileMemInput,
  claimMemoryIngest,
  persistIngestCompleted,
  readIngestCompleted,
} from './memory-reconcile-handoff-store';
import { recoverPurposeChanges } from './purpose-repair';

const SUBJECT_SCOPE_PREFIX = 'subject:';

export const MEMORY_EVENT_INGEST_QUEUE = 'memory_event_ingest';
// Outbox poller runs at the pg-boss cron minimum (one minute); the hourly recovery
// sweep catches whatever a restart or an oversized burst leaves behind.
export const MEMORY_INGEST_OUTBOX_POLL_QUEUE = 'memory_ingest_outbox_poll';
export const MEMORY_INGEST_OUTBOX_RECOVER_QUEUE = 'memory_ingest_outbox_recover';

/**
 * Static cron declarations: the same table drives boss.schedule registration and
 * the admin config read face, so the two cannot drift.
 */
export interface MemoryScheduleDeclaration {
  readonly name: string;
  readonly cron: string;
  readonly tz: string;
  readonly queue: 'fast';
  readonly note?: string;
}

export const MEMORY_INFRA_SCHEDULES: readonly MemoryScheduleDeclaration[] = [
  {
    name: MEMORY_INGEST_OUTBOX_POLL_QUEUE,
    cron: '* * * * *',
    tz: 'UTC',
    queue: 'fast',
    note: 'ADR-0021 outbox 每分钟 poller（pg-boss cron 最小粒度）',
  },
  {
    name: MEMORY_INGEST_OUTBOX_RECOVER_QUEUE,
    cron: '0 * * * *',
    tz: 'UTC',
    queue: 'fast',
    note: 'ADR-0021 outbox 每小时恢复扫描（poller 漏网的兜底）',
  },
];

const OUTBOX_POLL_BATCH = 50;
type BossLike = Pick<PgBoss, 'createQueue' | 'updateQueue'> & {
  work(name: string, ...args: unknown[]): Promise<unknown>;
  schedule(name: string, cron: string, data: object, options: object): Promise<unknown>;
  send(name: string, data: object, options?: object): Promise<string | null>;
  getJobById?(name: string, id: string): Promise<{ readonly state: string } | null>;
};

/** Deterministic event action → memory kind in the Mem0 payload. */
export function mapEventActionToKind(action: string): string {
  switch (action) {
    case 'judge':
    case 'propose':
    case 'experimental:user_cause':
      return 'weakness';
    case 'rate':
    case 'suppress':
    case 'accept_suggestion':
      return 'preference';
    case 'attempt':
    case 'review':
    case 'correct':
    case 'generate':
    case 'extract':
    case 'tool_use':
      return 'event';
    default:
      // experimental:* (non-reserved) and any future action → event (conservative)
      return 'event';
  }
}

async function defaultLoadEvent(db: Db, eventId: string): Promise<MemoryEventInput | null> {
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.id, eventId),
        eventAllowsDerivationSql(),
        // A deleting/deleted conversation stops feeding extraction at the load
        // choke point: outbox rows already queued simply resolve to null.
        sql`NOT EXISTS (
          SELECT 1 FROM learning_session ls
          WHERE ls.id = ${event.session_id}
            AND (ls.deletion_requested_at IS NOT NULL OR ls.deleted_at IS NOT NULL)
        )`,
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    actor_kind: row.actor_kind,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    payload: row.payload,
    affected_scopes: row.affected_scopes,
    created_at: row.created_at,
    kind: mapEventActionToKind(row.action),
  };
}

/**
 * Only user-originated events may feed mem0 extraction (ADR-0039). Agent output
 * entering extraction would let the model confirm its own prior output as a fact
 * on the next prompt. Fail closed: anything that is not exactly `user` is rejected.
 */
export function shouldExtractToMemory(event: Pick<MemoryEventInput, 'actor_kind'>): boolean {
  return event.actor_kind === 'user';
}

type EditedConjectureMemory = { claim: string; conjectureId: string };

function editedConjectureMemory(event: MemoryEventInput): EditedConjectureMemory | null {
  if (event.action !== 'rate' || event.subject_kind !== 'event') return null;
  if (typeof event.payload !== 'object' || event.payload === null) return null;
  const payload = event.payload as Record<string, unknown>;
  if (
    payload.rating !== 'accept' ||
    payload.corrected_by_owner !== true ||
    typeof payload.corrected_claim_md !== 'string' ||
    typeof payload.conjecture_id !== 'string'
  ) {
    return null;
  }
  const claim = payload.corrected_claim_md.trim();
  const conjectureId = payload.conjecture_id.trim();
  return claim && conjectureId ? { claim, conjectureId } : null;
}

// One source of truth for the kind projected from an owner-edited conjecture:
// verbatim projection metadata must not drift.
const CONJECTURE_EDIT_MEMORY_KIND = 'weakness';

// One stable RFC 9562 uuidv8 delivery identity per event: concurrent drains and
// crash replays present the engine with the identical job, so the once-only
// partition lives at the engine, not in the local stamp.
export function memoryIngestJobId(eventId: string): string {
  const digest = createHash('sha256').update(`memory-event-ingest@v1\0${eventId}`).digest('hex');
  const bytes = digest.slice(0, 32).split('');
  bytes[12] = '8';
  bytes[16] = ((Number.parseInt(bytes[16], 16) & 0x3) | 0x8).toString(16);
  const hex = bytes.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Outbox poll is the sole producer. A resolved send is the engine's acceptance
// signal (a null return names the pre-existing identical delivery); the
// ingest_at stamp is the acknowledgement written after that acceptance.
export async function enqueueEventMemoryIngest(boss: Pick<BossLike, 'send'>, eventId: string) {
  await boss.send(
    MEMORY_EVENT_INGEST_QUEUE,
    { event_id: eventId },
    { id: memoryIngestJobId(eventId) },
  );
}

// Completion digests retain the extracted text and created_ms alongside the id.
// Searching by opaque UUID embeds noise and rarely retrieves the memory itself.
export type { ReconcileMemInput } from './memory-reconcile-handoff-store';

export function buildMemoryEventIngestHandler(
  db: Db,
  _boss: Pick<BossLike, 'send' | 'getJobById'>,
  deps: {
    loadEvent?: (db: Db, eventId: string) => Promise<MemoryEventInput | null>;
    memoryClient?: MemoryClient;
    /** Explicit synchronous operator invocation only; never read from worker job data. */
    replayGrant?: MemoryIngestReplayGrant;
  } = {},
): (jobs: Pick<Job<{ event_id: string }>, 'data'>[]) => Promise<void> {
  const loadEvent = deps.loadEvent ?? defaultLoadEvent;
  let memoryClient = deps.memoryClient;
  return async (jobs) => {
    for (const job of jobs) {
      const row = await loadEvent(db, job.data.event_id);
      // Use the live derivation policy, not the write-time stamp: a consent
      // withdrawal after the event was written still gates it here.
      if (row && (await readEventDerivationPolicy(db, row.id)) !== 'allow') {
        if (deps.replayGrant) throw new MemoryReconcileHandoffError('restricted operator source');
        continue;
      }
      if (deps.replayGrant) {
        await assertMemoryIngestReplayGrant(db, deps.replayGrant, job.data.event_id);
        if (!row || row.id !== job.data.event_id)
          throw new MemoryReconcileHandoffError('operator source unavailable');
      }
      if (!row) continue;

      // Three gates before extraction: agent-originated events never feed mem0
      // (the model must not confirm its own output), bank-authoring events are
      // not learner evidence, and learner answers keep their verbatim text out
      // of the infer prompt. Curator separately reads permitted learner
      // activity — answers included — from PG.
      const learnerEvidence = isLearnerEvidenceAction(row.action);
      const admitToExtraction =
        learnerEvidence && shouldExtractToMemory(row) && !isLearnerAnswerAction(row.action);
      const editedConjecture = editedConjectureMemory(row);

      // Owner-edited conjectures are already canonical text. Persist the claim verbatim
      // (infer:false) so this job makes exactly one deterministic add+embedding call and
      // does not also ask the generic extraction LLM to infer a duplicate preference.
      const ingest = await (async () => {
        if (!admitToExtraction) return null;
        // Construct the client only for admitted events, so gated events never reach
        // the provider and a missing key cannot reject the job on their behalf.
        memoryClient ??= createMemoryClient();
        const client = memoryClient;
        const completed = await readIngestCompleted(db, row.id);
        if (completed?.memory_count === 0) {
          return { result: { results: [] }, resolution: completed.resolution } as const;
        }
        const operationAnchor = (anchor: string) =>
          deps.replayGrant ? memoryIngestReplayAnchor(deps.replayGrant, anchor) : anchor;
        const beforeProviderAdd = async () => {
          if (deps.replayGrant) {
            await claimMemoryIngestReplay(db, deps.replayGrant, row.id);
            return;
          }
          const claim = await claimMemoryIngest(db, row.id);
          if (claim !== 'winner')
            throw new MemoryReconcileHandoffError(
              `Mem0 add ${claim} for ${row.id}; exact lookup was incomplete or ambiguous`,
            );
        };
        if (editedConjecture) {
          const projectionKey = `conjecture-edit:${row.id}`;
          const existing = await client.findByEventId(row.id);
          if (existing.results.length > 0) {
            return {
              result: existing,
              resolution: completed?.resolution ?? ('event_lookup' as const),
            };
          }
          const result = await client.addVerbatimOnce(
            editedConjecture.claim,
            {
              source: 'conjecture_edit',
              event_id: row.id,
              conjecture_id: editedConjecture.conjectureId,
              // Mirror inferred scope metadata; scoped search maps scope_key to this field.
              affected_scopes: row.affected_scopes,
              corrected_by_owner: true,
              created_at: row.created_at.toISOString(),
              created_ms: row.created_at.getTime(),
              kind: CONJECTURE_EDIT_MEMORY_KIND,
            },
            projectionKey,
            createMem0OpaqueOperationContext({
              db,
              caller: 'worker',
              deadlineAt: new Date(Date.now() + 65_000),
              operationAnchor: operationAnchor(projectionKey),
            }),
            beforeProviderAdd,
          );
          return { result, resolution: 'provider_result' as const };
        }
        const once = await client.addEventMemoryOnce(
          row,
          createMem0OpaqueOperationContext({
            db,
            caller: 'worker',
            deadlineAt: new Date(Date.now() + 65_000),
            operationAnchor: operationAnchor(row.id),
          }),
          beforeProviderAdd,
        );
        return completed ? { ...once, resolution: completed.resolution } : once;
      })();
      const createdMs = row.created_at.getTime();
      const newMemories: ReconcileMemInput[] = (ingest?.result.results ?? []).map((memory) => ({
        id: memory.id,
        text: memory.memory,
        created_ms: createdMs,
        kind: editedConjecture ? CONJECTURE_EDIT_MEMORY_KIND : row.kind,
      }));
      if (ingest) {
        await persistIngestCompleted(db, {
          sourceEventId: row.id,
          resolution: ingest.resolution,
          memories: newMemories,
        });
        if ((await readEventDerivationPolicy(db, row.id)) !== 'allow') continue;
      }
    }
  };
}

export function buildContextPurposeRepairHandler(
  db: Db,
  deps: {
    memoryClient?: Pick<MemoryClient, 'search'>;
    generateBrief: GenerateBrief;
  },
): (
  jobs: Job<{ scope_key: string; now?: string; purpose_operation_id?: string }>[],
) => Promise<void> {
  // Do not construct the client at batch start: a missing key would reject the whole
  // job and defeat the per-scope catch. Mem0 facts are supplementary; brief regen
  // still runs from events.
  let memoryClient = deps.memoryClient;
  return async (jobs) => {
    for (const job of jobs) {
      if (!job.data.purpose_operation_id) throw new Error('purpose repair requires operation id');
      const scopeKey = job.data.scope_key;
      // Purpose commands use retryLimit=0. Failures remain visible without
      // automatically repeating an uncertain provider operation.
      try {
        await executePurposeBrief(
          db,
          { scopeKey, operationId: job.data.purpose_operation_id, jobId: job.id },
          async (purposeTaskId) => {
            const purposeId = job.data.purpose_operation_id;
            if (scopeKey === 'global:digest') {
              const { refreshTopicMetadata } = await import('../../context/topics');
              if (!(await refreshTopicMetadata(db, { taskRunId: purposeTaskId ?? job.id })))
                throw new Error('context purpose repair version conflict');
              return;
            }
            const searchFacts = async () => {
              // Lazily construct the client inside this try so a missing Mem0 key
              // degrades to no facts, while a missing LLM key fails later in generate.
              try {
                memoryClient ??= createMemoryClient();
                // Read through the wrapper so superseded facts never enter a long-term summary.
                const result = await searchMemories(memoryClient, `memory brief ${scopeKey}`, {
                  topK: 10,
                  filters: { scope_key: scopeKey },
                  providerOperation: createMem0OpaqueOperationContext({
                    db,
                    caller: 'worker',
                    deadlineAt: new Date(Date.now() + 65_000),
                    operationAnchor: `memory-brief:${job.id}:${scopeKey}`,
                  }),
                });
                return (result?.results ?? []).map((item) => ({
                  id: item.id,
                  memory: item.memory,
                }));
              } catch (err) {
                console.warn(
                  `[memory_brief_regen] Mem0 fact search unavailable for ${scopeKey}; proceeding without facts`,
                  err,
                );
                return [];
              }
            };

            // Subject scopes need the knowledge-resolved path: attempt/review never tag
            // `subject:` in affected_scopes, so the affected_scopes guard would return
            // false for an active subject. The active sweep already filtered, but the
            // guard still absorbs singleton re-fires and watermark skew.
            if (scopeKey.startsWith(SUBJECT_SCOPE_PREFIX)) {
              const subjectId = scopeKey.slice(SUBJECT_SCOPE_PREFIX.length);
              // Same clock as the sweep, so a delayed job does not slide the 7d/90d edges.
              const now = job.data.now ? new Date(job.data.now) : new Date();
              const events = await loadSubjectBriefEvents(db, subjectId, { now });
              if (!purposeId && !(await subjectScopeHasNewEvidence(db, scopeKey, events))) return;
              await regenerateMemoryBrief({
                db,
                scopeKey,
                purposeRepair: Boolean(purposeId),
                taskRunId: purposeTaskId,
                loadEvents: async () => events,
                searchFacts,
                generate: deps.generateBrief,
              });
              return;
            }

            // Global and legacy affected_scopes-tagged scopes.
            if (!purposeId && !(await scopeHasNewEvidence(db, scopeKey))) return;
            await regenerateMemoryBrief({
              db,
              scopeKey,
              purposeRepair: Boolean(purposeId),
              taskRunId: purposeTaskId,
              searchFacts,
              generate: deps.generateBrief,
            });
          },
        );
      } catch (err) {
        // Preserve the failure as a terminal queue outcome; never report a failed repair as complete.
        console.error(
          `[context_purpose_repair] scope ${scopeKey} failed; leaving prior brief`,
          err,
        );
        throw err;
      }
    }
  };
}

// Outbox poll: the durable intent is the unstamped event row itself. The claim
// transaction only partitions pending rows; the engine send runs after it
// commits under the stable delivery id, and ingest_at is stamped only for rows
// the engine accepted. A crash between send and stamp leaves the row pending —
// the next drain replays the identical delivery and dedupes at the engine.
export function buildMemoryIngestOutboxPollHandler(
  db: Db,
  boss: Pick<BossLike, 'send'>,
): (jobs: Job<object>[]) => Promise<void> {
  return async () => {
    const pending = await db.transaction(async (tx) =>
      tx
        .select({ id: event.id })
        .from(event)
        .where(isNull(event.ingest_at))
        .orderBy(event.created_at)
        .limit(OUTBOX_POLL_BATCH)
        .for('update', { skipLocked: true }),
    );
    const accepted: string[] = [];
    for (const row of pending) {
      try {
        await enqueueEventMemoryIngest(boss, row.id);
        accepted.push(row.id);
      } catch (error) {
        console.error('[memory_ingest_outbox_poll] engine send failed; row stays pending', {
          event_id: row.id,
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        });
      }
    }
    if (accepted.length === 0) return;
    await db.update(event).set({ ingest_at: new Date() }).where(inArray(event.id, accepted));
  };
}

// Hourly recovery sweep: drains rows the minute poller missed (outage, burst beyond
// the batch limit) by calling the poller until a cycle makes no progress, with a cap
// against pathological loops.
const OUTBOX_RECOVER_MAX_CYCLES = 1000;
export async function runMemoryRecoveryFloor(legs: {
  readonly ingest: () => Promise<void>;
  readonly purpose?: () => Promise<void>;
}): Promise<void> {
  const errors: unknown[] = [];
  try {
    await legs.ingest();
  } catch (error) {
    errors.push(error);
  }
  try {
    await legs.purpose?.();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw errors[0];
}

export function buildMemoryIngestOutboxRecoverHandler(
  db: Db,
  boss: Pick<BossLike, 'send' | 'getJobById'>,
): (jobs: Job<object>[]) => Promise<void> {
  const drainOnce = buildMemoryIngestOutboxPollHandler(db, boss);
  return async () => {
    await runMemoryRecoveryFloor({
      ingest: async () => {
        for (let cycle = 0; cycle < OUTBOX_RECOVER_MAX_CYCLES; cycle += 1) {
          const before = await countPendingIngest(db);
          if (before === 0) break;
          await drainOnce([]);
          const after = await countPendingIngest(db);
          if (after >= before) break;
        }
      },
      purpose: () => recoverPurposeChanges(db, boss),
    });
  };
}

async function countPendingIngest(db: Db): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(event)
    .where(isNull(event.ingest_at));
  return rows[0]?.count ?? 0;
}
