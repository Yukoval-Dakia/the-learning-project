import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Job, PgBoss } from 'pg-boss';
import type { Db } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { event } from '@/db/schema';
import {
  eventAllowsDerivationSql,
  readEventDerivationPolicy,
} from '@/kernel/events/derivation-policy';
import { enqueueMemoryBriefRegen } from '@/kernel/memory-brief-regen';
import { REFLECTION_BRIEF_SCOPE_KEYS } from '@/kernel/nightly-eligibility';
import {
  LEARNING_ACTIVITY_ACTIONS,
  resolveLearningEventSubjects,
} from '@/kernel/read-models/learner-activity';
import { BRIEF_REFRESH_BUDGET } from '@/kernel/tools/budgets';
import {
  listActiveSubjectsSinceRefresh,
  loadSubjectBriefEvents,
  selectSubjectsForRun,
  subjectScopeHasNewEvidence,
} from './active-subjects';
import {
  type GenerateBrief,
  listStaleBriefScopes,
  regenerateMemoryBrief,
  scopeHasNewEvidence,
} from './brief';
import { executePurposeBrief } from './brief-purpose';
import { isLearnerEvidenceAction } from './learner-evidence';
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

// Per-subject brief refresh lookback, also the bounded initial build for never-built
// subjects.
const BRIEF_REFRESH_LOOKBACK_DAYS = 30;
const SUBJECT_SCOPE_PREFIX = 'subject:';

export const MEMORY_EVENT_INGEST_QUEUE = 'memory_event_ingest';
export const MEMORY_BRIEF_SWEEP_QUEUE = 'memory_brief_sweep';
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
    name: MEMORY_BRIEF_SWEEP_QUEUE,
    cron: '0 3 * * *',
    tz: 'Asia/Shanghai',
    queue: 'fast',
    note: '每日 brief 兜底重算（per-event regen 的 backstop）',
  },
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
// Cap the per-event brief-regen fan-out: affected scopes are unbounded, so one bulk
// or import event could enqueue hundreds of jobs. A truncated tail is acceptable;
// the daily sweep partially backstops scopes that already have a brief row.
export const MAX_BRIEF_REGEN_SCOPES = 64;

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
    .where(and(eq(event.id, eventId), eventAllowsDerivationSql()))
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

// Outbox poll is the sole producer. `ingest_at IS NULL` is the once-only partition:
// the stamp commits with the enqueue, so no singleton key is needed.
export async function enqueueEventMemoryIngest(
  boss: Pick<BossLike, 'send'>,
  eventId: string,
  options?: object,
) {
  await boss.send(MEMORY_EVENT_INGEST_QUEUE, { event_id: eventId }, options);
}

// Completion digests retain the extracted text and created_ms alongside the id.
// Searching by opaque UUID embeds noise and rarely retrieves the memory itself.
export type { ReconcileMemInput } from './memory-reconcile-handoff-store';

export function buildMemoryEventIngestHandler(
  db: Db,
  boss: Pick<BossLike, 'send' | 'getJobById'>,
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

      // Two gates before extraction: agent-originated events never feed mem0 (the
      // model must not confirm its own output), and bank-authoring events are not
      // learner evidence. The brief still summarizes agent activity from PG, so the
      // brief fan-out below stays independent of the extraction actor gate.
      const learnerEvidence = isLearnerEvidenceAction(row.action);
      const admitToExtraction = learnerEvidence && shouldExtractToMemory(row);
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
      // Bounded, sequential, per-scope-isolated brief fan-out. The slice caps bulk
      // events; sequential sends avoid flooding the connection pool; one failure must
      // not skip the rest. The daily sweep only backstops scopes
      // that already have a brief row, so a first-appearance tail is best-effort.
      // Bank-authoring events fan out nothing: they are not learner evidence.
      const regenScopes = learnerEvidence
        ? row.affected_scopes.slice(0, MAX_BRIEF_REGEN_SCOPES)
        : [];
      if (learnerEvidence && row.affected_scopes.length > MAX_BRIEF_REGEN_SCOPES) {
        console.warn(
          `[memory_brief_bridge] event ${row.id} has ${row.affected_scopes.length} affected scopes; capping brief regen fan-out at ${MAX_BRIEF_REGEN_SCOPES} (best-effort, sweep partially backstops the rest)`,
        );
      }
      const regenFailures: { scope: string; reason: unknown }[] = [];
      for (const scopeKey of regenScopes) {
        try {
          await enqueueMemoryBriefRegen(boss, scopeKey);
        } catch (err) {
          regenFailures.push({ scope: scopeKey, reason: err });
        }
      }
      if (regenFailures.length > 0) {
        console.warn(
          `[memory_brief_bridge] affected_scopes brief regen enqueue failed for event ${row.id} (${regenFailures.length}/${regenScopes.length} scopes: ${regenFailures.map((f) => f.scope).join(', ')}); scopes with an existing brief are still swept, a first-appearance scope loses only this batch`,
          regenFailures.map((f) => f.reason),
        );
      }

      // Core learning events never tag `subject:*` in affected_scopes, so the
      // fan-out above cannot refresh a per-subject brief. Resolve the event to its
      // canonical subject and enqueue that scope, moving freshness from the nightly
      // sweep to hours. The subject singleton slot collapses bursts. Best-effort: a
      // bridge failure must not make the ingest job retry; the sweep backstops it.
      if ((LEARNING_ACTIVITY_ACTIONS as readonly string[]).includes(row.action)) {
        try {
          const subjectByEventId = await resolveLearningEventSubjects(db, [row], 'default_subject');
          const subjectId = subjectByEventId.get(row.id);
          if (subjectId) {
            await enqueueMemoryBriefRegen(boss, `${SUBJECT_SCOPE_PREFIX}${subjectId}`);
          }
        } catch (err) {
          console.warn(
            `[memory_brief_bridge] subject bridge failed for event ${row.id}; nightly sweep will backstop`,
            err,
          );
        }
      }
    }
  };
}

export function buildMemoryBriefRegenHandler(
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
      const scopeKey = job.data.scope_key;
      // One scope's provider/LLM throw must not reject the job and cause a retry
      // storm. The writer stays loud; this catch logs and continues. The prior brief
      // survives because the upsert is only reached on success.
      try {
        await executePurposeBrief(
          db,
          { scopeKey, operationId: job.data.purpose_operation_id, jobId: job.id },
          async (purposeTaskId) => {
            const purposeId = job.data.purpose_operation_id;
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
              // Reuse the sweep's now so detection and reload share the same lookback
              // floor; a fresh clock here could age an edge event out.
              const now = job.data.now ? new Date(job.data.now) : new Date();
              // loadSubjectBriefEvents floors at this subject's own refreshed_at, the same
              // predicate detection uses, so a flagged subject always reloads an event.
              const events = await loadSubjectBriefEvents(db, subjectId, {
                lookbackDays: BRIEF_REFRESH_LOOKBACK_DAYS,
                now,
              });
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
        // Leave the prior brief intact and continue; rethrowing would retry-storm.
        console.error(`[memory_brief_regen] scope ${scopeKey} failed; leaving prior brief`, err);
      }
    }
  };
}

/** Whether nightly eligibility turns the reflection brief scopes off for this sweep. */
export type ReflectionBriefsOff = (db: Db, now: Date) => Promise<boolean>;

export function buildMemoryBriefSweepHandler(
  db: Db,
  boss: Pick<BossLike, 'send'>,
  reflectionBriefsOff: ReflectionBriefsOff,
  // One now per sweep, shared with the regen jobs it enqueues, so detection and
  // reload use the same lookback floor. Also keeps fixed-now tests deterministic.
  opts?: { now?: Date },
): (jobs: Job<object>[]) => Promise<void> {
  return async () => {
    const now = opts?.now ?? new Date();

    // Stale non-subject scopes only: subject refresh is owned by the capped path
    // below, so this loop cannot bypass maxSubjectsPerRun. The global brief is never
    // subject to that cap.
    const staleScopes = await listStaleBriefScopes(db, now);
    const reflectionOff = await reflectionBriefsOff(db, now);
    for (const scopeKey of staleScopes) {
      if (reflectionOff && (REFLECTION_BRIEF_SCOPE_KEYS as readonly string[]).includes(scopeKey)) {
        continue;
      }
      await enqueueMemoryBriefRegen(boss, scopeKey);
    }

    // Activity-gated subject layer: subjects with evidence newer than their brief
    // (or never built inside the lookback), most recent first, capped per run.
    // Deferred subjects stay eligible next run, so nothing starves.
    const activeSubjects = await listActiveSubjectsSinceRefresh(db, {
      lookbackDays: BRIEF_REFRESH_LOOKBACK_DAYS,
      now,
    });
    for (const subject of selectSubjectsForRun(
      activeSubjects,
      BRIEF_REFRESH_BUDGET.maxSubjectsPerRun,
    )) {
      await enqueueMemoryBriefRegen(boss, subject.scopeKey, now);
    }
  };
}

// Transactional outbox poll: one batch of pending rows is locked SKIP LOCKED,
// enqueued, and stamped ingest_at in the same transaction. Concurrent pollers cannot
// double-enqueue, and a crash before commit reverts the stamp.
export function buildMemoryIngestOutboxPollHandler(
  db: Db,
  boss: Pick<BossLike, 'send'>,
): (jobs: Job<object>[]) => Promise<void> {
  return async () => {
    await db.transaction(async (tx) => {
      const pending = await tx
        .select({ id: event.id })
        .from(event)
        .where(isNull(event.ingest_at))
        .orderBy(event.created_at)
        .limit(OUTBOX_POLL_BATCH)
        .for('update', { skipLocked: true });
      if (pending.length === 0) return;
      for (const row of pending) {
        await enqueueEventMemoryIngest(boss, row.id, { db: fromPgBossDrizzleTx(tx) });
      }
      await tx
        .update(event)
        .set({ ingest_at: new Date() })
        .where(
          inArray(
            event.id,
            pending.map((r) => r.id),
          ),
        );
    });
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
