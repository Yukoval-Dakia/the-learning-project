import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { providerCostProjectedCte } from '@/kernel/read-models/provider-cost-projection';
import {
  type IngestionSessionCostEvidence,
  IngestionSessionCostEvidenceSchema,
} from '../api/contracts';
import { AGENT_TASK_KIND, readAgentBudget } from './agent/budget-state';

type Evidence = IngestionSessionCostEvidence;
type Identity = Pick<
  Evidence['unsettled'][number],
  'kind' | 'task_run_id' | 'operation_id' | 'attempt_id'
>;
type Reason = Evidence['unsettled'][number]['reasons'][number];

// Validate persisted identities without deriving ownership from their spelling.
const identitySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,511}$/);
const uuidSchema = z.uuid();
const textSchema = z.string().refine((value) => value.trim().length > 0);
const projectedRowSchema = z.object({
  ref: identitySchema,
  operation_id: uuidSchema.nullable(),
  task_kind: textSchema,
  source: z.enum(['cost_ledger', 'provider_attempt']),
  entry_kind: z.enum(['legacy', 'attempt']),
  cost_basis: z.enum(['reported', 'estimated', 'unknown']).nullable(),
  cost_ref: textSchema.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  cost: z.number().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  provider: textSchema,
  model: textSchema.nullable(),
});
const taskStateSchema = z.object({
  id: identitySchema,
  task_kind: textSchema,
  status: z.enum(['running', 'success', 'failure']),
  finished: z.boolean(),
});

function unavailable(reason: 'invalid_evidence' | 'read_failed'): never {
  throw new ApiError(
    'ingestion_cost_evidence_unavailable',
    '暂时无法确认这次录入的费用证据。',
    503,
    undefined,
    { reason },
  );
}

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) unavailable('invalid_evidence');
  return parsed.data;
}

function addAmount(previous: number | null, amount: number): number {
  const sum = (previous ?? 0) + amount;
  if (!Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER) unavailable('invalid_evidence');
  return sum;
}

/**
 * Complete private owner of session-attributable cost evidence. Only this owner
 * establishes isolation, reads durable ownership and canonical facts, classifies
 * gaps and emits the safe wire shape. It never reconciles or settles liabilities.
 * `as_of` describes this cost snapshot, not the other history/title/current reads.
 */
export async function readSessionCostEvidence(db: Db, sessionId: string): Promise<Evidence> {
  try {
    return await db.transaction(
      async (tx) => {
        // The first SELECT establishes the RR snapshot. Use its DB statement
        // time, not a later application clock after the evidence queries.
        const clock = await tx.execute<{ as_of: string }>(sql`
          SELECT statement_timestamp()::text AS as_of
        `);
        const time = new Date(clock[0]?.as_of ?? '');
        if (!Number.isFinite(time.getTime())) unavailable('invalid_evidence');
        const budget = await readAgentBudget(tx, sessionId);
        const missing: Evidence['missing'] = ['outside_agent_scope'];
        if (budget == null) missing.push('no_budget');

        const tasks = new Map<string, Identity>();
        for (const id of Object.keys(budget?.tasks ?? {})) {
          checked(identitySchema, id);
          tasks.set(id, {
            kind: 'agent_task',
            task_run_id: id,
            operation_id: null,
            attempt_id: null,
          });
        }
        const ocr = new Map<string, Identity>();
        const operations = new Map<string, Identity>();
        for (const binding of budget?.attributions ?? []) {
          checked(identitySchema, binding.task_run_id);
          checked(uuidSchema, binding.operation_id);
          if (binding.attempt_id !== undefined) checked(uuidSchema, binding.attempt_id);
          if (binding.tool !== 'glm_ocr') unavailable('invalid_evidence');
          const identity: Identity = {
            kind: 'ocr',
            task_run_id: binding.task_run_id,
            operation_id: binding.operation_id,
            attempt_id: binding.attempt_id ?? null,
          };
          const previous = operations.get(binding.operation_id);
          if (
            previous != null &&
            (previous.task_run_id !== identity.task_run_id ||
              previous.attempt_id !== identity.attempt_id)
          )
            unavailable('invalid_evidence');
          operations.set(binding.operation_id, identity);
          if (identity.attempt_id != null) {
            const priorAttempt = ocr.get(identity.attempt_id);
            if (priorAttempt != null && priorAttempt.operation_id !== identity.operation_id)
              unavailable('invalid_evidence');
            if (tasks.has(identity.attempt_id)) unavailable('invalid_evidence');
            ocr.set(identity.attempt_id, identity);
          }
        }
        // The global discovery writer can put another session's historical OCR
        // on this host. Even ownership='agent' does not prove this session owns it.
        for (const [attemptId, historical] of Object.entries(budget?.historical_ocr ?? {})) {
          checked(uuidSchema, attemptId);
          checked(uuidSchema, historical.operation_id);
          const binding = ocr.get(attemptId);
          if (binding != null && binding.operation_id !== historical.operation_id)
            unavailable('invalid_evidence');
          if (binding == null && !missing.includes('historical_ocr_attribution_unproven'))
            missing.push('historical_ocr_attribution_unproven');
        }
        if (tasks.size === 0 && operations.size === 0) missing.push('no_durable_identities');

        // No date/model/prefix/week ownership inference and no alternate SUM over
        // the ledger. The kernel alone decides attempt authority and suppression.
        const taskIds = [...tasks.keys()];
        const attemptIds = [...ocr.keys()];
        const taskFilter = taskIds.length
          ? sql`p.ref IN (${sql.join(
              taskIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql`false`;
        const ocrFilter = attemptIds.length
          ? sql`(p.source = 'provider_attempt' AND (${sql.join(
              [...ocr.values()].map(
                (identity) => sql`(p.ref = ${identity.attempt_id}
                  AND p.operation_id = ${identity.operation_id})`,
              ),
              sql` OR `,
            )}))`
          : sql`false`;
        const rawCosts =
          taskIds.length || attemptIds.length
            ? await tx.execute(sql`
              ${providerCostProjectedCte(new Date(0))}
              SELECT p.ref, p.operation_id, p.task_kind, p.source, p.entry_kind,
                p.cost_basis, p.cost_ref, p.currency, p.cost, p.provider, p.model
              FROM projected p WHERE ${taskFilter} OR ${ocrFilter}
              ORDER BY p.source, p.ref, p.operation_id, p.provider, p.model,
                p.currency, p.entry_kind, p.cost_basis, p.cost_ref, p.cost
            `)
            : [];
        const taskRows = taskIds.length
          ? await tx.execute<{
              id: string;
              task_kind: string;
              status: string;
              finished: boolean;
            }>(sql`
              SELECT id, task_kind, status, finished_at IS NOT NULL AS finished
              FROM ai_task_runs
              WHERE id IN (${sql.join(
                taskIds.map((id) => sql`${id}`),
                sql`, `,
              )})
            `)
          : [];
        const attemptRows = attemptIds.length
          ? await tx.execute<{ attempt_id: string; operation_id: string }>(sql`
              SELECT attempt_id::text, operation_id::text FROM provider_attempt
              WHERE attempt_id::text IN (${sql.join(
                attemptIds.map((id) => sql`${id}`),
                sql`, `,
              )})
            `)
          : [];
        for (const row of attemptRows) {
          if (ocr.get(row.attempt_id)?.operation_id !== row.operation_id)
            unavailable('invalid_evidence');
        }

        const reasons = new Map<Identity, Set<Reason>>();
        const note = (identity: Identity, reason: Reason) => {
          const set = reasons.get(identity) ?? new Set<Reason>();
          set.add(reason);
          reasons.set(identity, set);
        };
        const taskStates = new Map(
          taskRows.map((raw) => {
            const row = checked(taskStateSchema, raw);
            return [row.id, row];
          }),
        );
        for (const identity of tasks.values()) {
          const state = taskStates.get(identity.task_run_id);
          if (state == null) note(identity, 'missing_task_run');
          else if (state.task_kind !== AGENT_TASK_KIND) unavailable('invalid_evidence');
          else if (state.status === 'running' || !state.finished)
            note(identity, 'task_in_progress');
        }
        for (const identity of operations.values()) {
          if (identity.attempt_id == null) note(identity, 'missing_attempt_binding');
        }

        const observed = new Set<Identity>();
        const records: Evidence['records'] = [];
        const currencies = new Map<string, Evidence['by_currency'][number]>();
        for (const raw of rawCosts) {
          const row = checked(projectedRowSchema, raw);
          const identity = tasks.get(row.ref) ?? ocr.get(row.ref);
          if (identity == null) unavailable('invalid_evidence');
          if (identity.kind === 'agent_task' && row.task_kind !== AGENT_TASK_KIND)
            unavailable('invalid_evidence');
          if (row.source === 'provider_attempt') checked(uuidSchema, row.ref);
          if (
            (row.source === 'provider_attempt' &&
              (row.entry_kind !== 'attempt' || row.operation_id == null)) ||
            (row.entry_kind === 'legacy' && row.cost_basis != null)
          )
            unavailable('invalid_evidence');
          if (
            identity.kind === 'ocr' &&
            (row.source !== 'provider_attempt' || row.operation_id !== identity.operation_id)
          )
            unavailable('invalid_evidence');
          observed.add(identity);
          if (
            row.entry_kind !== 'legacy' &&
            row.cost_basis !== 'reported' &&
            row.cost_basis !== 'estimated'
          )
            note(identity, 'unknown_cost_basis');
          if (row.cost == null) note(identity, 'missing_amount');
          if (row.entry_kind !== 'legacy' && row.cost_ref == null)
            note(identity, 'missing_cost_reference');
          if (row.currency === 'XXX') note(identity, 'unknown_currency');
          const known =
            row.cost != null &&
            row.currency !== 'XXX' &&
            (row.entry_kind === 'legacy' || row.cost_ref != null) &&
            (row.entry_kind === 'legacy' ||
              row.cost_basis === 'reported' ||
              row.cost_basis === 'estimated');
          records.push({
            ...identity,
            attempt_id: row.source === 'provider_attempt' ? row.ref : null,
            operation_id: row.operation_id,
            provider: row.provider,
            model: row.model,
            source: row.source,
            entry_kind: row.entry_kind,
            cost_basis: row.cost_basis,
            cost_ref: row.cost_ref,
            currency: row.currency,
            amount: known ? row.cost : null,
          });
          const bucket = currencies.get(row.currency) ?? {
            currency: row.currency,
            known_subtotal: null,
            reported: null,
            estimated: null,
            legacy: null,
          };
          if (known && row.cost != null) {
            bucket.known_subtotal = addAmount(bucket.known_subtotal, row.cost);
            const basis = row.entry_kind === 'legacy' ? 'legacy' : row.cost_basis;
            if (basis === 'reported' || basis === 'estimated' || basis === 'legacy')
              bucket[basis] = addAmount(bucket[basis], row.cost);
          }
          currencies.set(row.currency, bucket);
        }
        for (const identity of [...tasks.values(), ...operations.values()]) {
          if (!observed.has(identity)) note(identity, 'missing_canonical_cost');
        }
        // Identity arrays are liabilities/evidence gaps, never provider call counts.
        return checked(IngestionSessionCostEvidenceSchema, {
          scope: 'ingestion_agent_observed',
          coverage: 'partial',
          as_of: time.toISOString(),
          total: null,
          by_currency: [...currencies.values()].sort((a, b) =>
            a.currency.localeCompare(b.currency),
          ),
          records,
          unsettled: [...reasons].map(([identity, gaps]) => ({ ...identity, reasons: [...gaps] })),
          missing,
        });
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 404 || error.code === 'ingestion_cost_evidence_unavailable')
    )
      throw error;
    // Never put budget JSON, DB errors, provider payloads or validation values
    // into the HTTP error (or an error message later logged by the route).
    unavailable('read_failed');
  }
}
