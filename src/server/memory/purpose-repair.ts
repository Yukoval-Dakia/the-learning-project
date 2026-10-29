import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import {
  eventAllowsDerivationSql,
  eventBelongsToDocumentSql,
  readEventDerivationPolicy,
} from '@/kernel/events/derivation-policy';
import {
  PURPOSE_CHANGE_ACTION,
  PURPOSE_REPAIR_ACTION,
  PurposeChangeReceipt,
  type PurposeRepairRecordT,
  readPurposeRepairs,
} from '@/kernel/read-models/purpose-change';
import { type MemoryClient, createMemoryClient } from './client';
import { readIngestCompleted, readMemoryIngestStarted } from './memory-reconcile-handoff-store';
import { recordPurposeRepair } from './purpose-repair-store';

function confirmedBriefJob(value: unknown, jobId: string, operationId: string, scopeKey: string) {
  return z
    .object({
      id: z.literal(jobId),
      data: z.object({
        scope_key: z.literal(scopeKey),
        purpose_operation_id: z.literal(operationId),
      }),
    })
    .safeParse(value).success;
}

/** Complete lookup and official exact-id delete only. No add, vector SQL, or LLM. */
async function cleanSource(db: Db, client: MemoryClient, operationId: string, sourceId: string) {
  let state: PurposeRepairRecordT['state'] = 'unknown';
  let detail = 'exact lookup not completed';
  let ids: string[] = [];
  try {
    if ((await readEventDerivationPolicy(db, sourceId)) === 'allow') return;
    const found = await client.findByEventId(sourceId);
    ids = found.results.map((row) => row.id);
    // Persist targets before external deletion. Crashes retain the exact obligation.
    await recordPurposeRepair(db, {
      operation_id: operationId,
      sink: 'mem0',
      source_id: sourceId,
      state: 'pending',
      memory_ids: ids,
      detail: 'exact event lookup complete; official deletes pending',
    });
    for (const id of ids) await client.hardDelete(id);
    const remaining = await client.findByEventId(sourceId);
    const completed = await readIngestCompleted(db, sourceId);
    const started = await readMemoryIngestStarted(db, sourceId);
    state = remaining.results.length
      ? 'pending'
      : completed && (!started || completed.resolution === 'provider_result')
        ? 'complete'
        : 'unknown';
    detail = remaining.results.length
      ? 'exact lookup still contains memories'
      : state === 'complete'
        ? 'official deletes and complete exact lookup confirm current Mem0 absence; copies/history remain unknown'
        : 'current exact lookup empty; an unresolved or legacy external add may still finish';
  } catch (error) {
    state = 'failed';
    detail = error instanceof Error ? error.message.slice(0, 300) : 'lookup/delete failed';
  }
  await recordPurposeRepair(db, {
    operation_id: operationId,
    sink: 'mem0',
    source_id: sourceId,
    state,
    memory_ids: ids,
    detail,
  });
}

/** The existing hourly recovery floor consumes permanent purpose obligations.
 * Scan exact source closure in bounded pages, wrapping to catch late birth.
 */
export async function recoverPurposeChanges(
  db: Db,
  boss: {
    send(name: string, data: object, options: object): Promise<string | null>;
    getJobById?: (name: string, id: string) => Promise<unknown>;
  },
  clientFactory = createMemoryClient,
) {
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, PURPOSE_CHANGE_ACTION),
        eq(event.actor_kind, 'user'),
        eq(event.actor_ref, 'self'),
        sql`${event.payload}->>'cleanup_required' = 'true'`,
      ),
    )
    .orderBy(
      sql`COALESCE((SELECT MAX(progress.dispatch_seq) FROM event progress
      WHERE progress.action = ${PURPOSE_REPAIR_ACTION} AND progress.subject_id = ${event.id}
        AND progress.payload->>'sink' = 'mem0_scan'), 0)`,
      asc(event.dispatch_seq),
    )
    .limit(1);
  let client: MemoryClient | undefined;
  for (const row of rows) {
    const receipt = PurposeChangeReceipt.parse(row.payload);
    const repairs = await readPurposeRepairs(db, receipt.operation_id);
    // Read-back recovery is safe after a crash between reservation and send.
    // An absent/archived job is still unknown and never authorizes redispatch.
    if (boss.getJobById)
      for (const repair of repairs
        .filter((r) => r.sink === 'brief_dispatch' && r.state === 'unknown' && r.job_id)
        .slice(0, 10)) {
        const jobId = repair.job_id;
        if (!jobId) continue;
        try {
          const job = await boss.getJobById('memory_brief_regen', jobId);
          if (confirmedBriefJob(job, jobId, receipt.operation_id, repair.source_id))
            await recordPurposeRepair(db, {
              operation_id: receipt.operation_id,
              sink: 'brief_dispatch',
              source_id: repair.source_id,
              state: 'pending',
              job_id: jobId,
              detail:
                'original reserved queue job read back with exact command/scope; no redispatch',
            });
        } catch {
          /* Keep the durable unknown reservation for later read-back. */
        }
      }
    const cursor = repairs.find((r) => r.sink === 'mem0_scan')?.cursor ?? '';
    const sources = await db
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          sql`${event.id} > ${cursor}`,
          sql`${event.action} NOT IN (${PURPOSE_CHANGE_ACTION}, ${PURPOSE_REPAIR_ACTION}, 'experimental:ingestion_usage_binding')`,
          eventBelongsToDocumentSql(receipt.input.source_document_id),
          sql`NOT (${eventAllowsDerivationSql()})`,
        ),
      )
      .orderBy(asc(event.id))
      .limit(50);
    for (const source of sources) {
      try {
        client ??= clientFactory();
        await cleanSource(db, client, receipt.operation_id, source.id);
      } catch (error) {
        await recordPurposeRepair(db, {
          operation_id: receipt.operation_id,
          sink: 'mem0',
          source_id: source.id,
          state: 'failed',
          detail: error instanceof Error ? error.message.slice(0, 300) : 'client unavailable',
        });
      }
    }
    await recordPurposeRepair(db, {
      operation_id: receipt.operation_id,
      sink: 'mem0_scan',
      source_id: receipt.input.source_document_id,
      state: 'pending',
      cursor: sources.length === 50 ? (sources.at(-1)?.id ?? '') : '',
      detail:
        'bounded exact-source scan; wraps for late results, never declares all copies withdrawn',
    });
    for (const scope of receipt.brief_scopes
      .filter(
        (scope) =>
          !repairs.some((r) => r.sink === 'brief_dispatch' && r.source_id === scope.scope_key),
      )
      .slice(0, 10)) {
      const jobId = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`purpose-brief:${receipt.operation_id}:${scope.scope_key}`}, 0))`,
        );
        const prior = (await readPurposeRepairs(tx, receipt.operation_id)).find(
          (r) => r.sink === 'brief_dispatch' && r.source_id === scope.scope_key,
        );
        if (prior) return null;
        const id = randomUUID();
        await recordPurposeRepair(tx, {
          operation_id: receipt.operation_id,
          sink: 'brief_dispatch',
          source_id: scope.scope_key,
          state: 'unknown',
          job_id: id,
          detail: 'dispatch reserved; queue receipt not yet confirmed',
        });
        return id;
      });
      if (!jobId) continue; // No automatic paid replay after reservation/unknown.
      try {
        const sent = await boss.send(
          'memory_brief_regen',
          { scope_key: scope.scope_key, purpose_operation_id: receipt.operation_id },
          {
            id: jobId,
            retryLimit: 0,
            singletonKey: `memory.purpose.${receipt.operation_id}.${scope.scope_key}`,
          },
        );
        const confirmed =
          sent === jobId ||
          (boss.getJobById &&
            confirmedBriefJob(
              await boss.getJobById('memory_brief_regen', jobId),
              jobId,
              receipt.operation_id,
              scope.scope_key,
            ));
        await recordPurposeRepair(db, {
          operation_id: receipt.operation_id,
          sink: 'brief_dispatch',
          source_id: scope.scope_key,
          state: confirmed ? 'pending' : 'unknown',
          job_id: jobId,
          detail: confirmed
            ? 'queue receipt confirmed; regeneration pending'
            : 'queue receipt unconfirmed; no paid redispatch',
        });
      } catch (error) {
        await recordPurposeRepair(db, {
          operation_id: receipt.operation_id,
          sink: 'brief_dispatch',
          source_id: scope.scope_key,
          state: 'unknown',
          job_id: jobId,
          detail: error instanceof Error ? error.message.slice(0, 300) : 'dispatch unknown',
        });
      }
    }
  }
}
