import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';

export const evidenceSchema = z
  .object({
    evidenceId: z.string().min(1),
    questionId: z.string().min(1),
    answer: z.string().min(1),
    independent: z.boolean(),
    correct: z.boolean(),
    misconceptions: z.array(z.string()),
    observations: z.array(
      z.object({ part: z.string(), note: z.string(), confidence: z.number().min(0).max(1) }),
    ),
  })
  .strict();

export const snapshotSchema = z.object({
  learnerId: z.string(),
  version: z.number().int().positive(),
  evidence: evidenceSchema,
  evidenceCommittedAt: z.string(),
  nextActivity: z.string().nullable(),
});

export const arrangeSchema = z
  .object({
    learnerId: z.string().min(1),
    operationId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    validUntil: z.iso.datetime(),
    nextActivity: z.enum(['ellipse-transfer', 'ellipse-supported-review']),
    rationale: z.string().min(20),
  })
  .strict();

export const receiptSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('accepted'),
    version: z.number().int(),
    activity: z.string(),
    appliedAt: z.string(),
    latencyMs: z.number(),
  }),
  z.object({
    kind: z.literal('rejected'),
    reason: z.enum(['stale-version', 'expired']),
    version: z.number().int(),
  }),
]);

export type ArrangeCommand = z.infer<typeof arrangeSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type GateSql = ReturnType<typeof postgres>;

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Test-only schema. No application migrations or current production writers import this module.
export async function createGateSchema(sql: GateSql) {
  await sql`create schema if not exists yuk1338`;
  await sql`create table if not exists yuk1338.learner (
    id text primary key, version integer not null, evidence jsonb not null,
    evidence_at timestamptz not null default clock_timestamp(), next_activity text
  )`;
  await sql`create table if not exists yuk1338.evidence (
    learner_id text not null, id text not null, payload jsonb not null,
    primary key (learner_id, id)
  )`;
  await sql`create table if not exists yuk1338.receipt (
    operation_id text primary key, payload_digest text not null, result jsonb not null
  )`;
  await sql`create table if not exists yuk1338.effect (
    operation_id text primary key, learner_id text not null, activity text not null, version integer not null
  )`;
  await sql`create table if not exists yuk1338.model_attempt (
    workflow_id text not null, turn integer not null, input_digest text not null,
    response jsonb not null, created_at timestamptz not null default clock_timestamp()
  )`;
}

export async function readSnapshot(sql: GateSql, learnerId: string): Promise<Snapshot> {
  const [row] = await sql`select id as "learnerId", version, evidence,
    evidence_at::text as "evidenceCommittedAt", next_activity as "nextActivity"
    from yuk1338.learner where id = ${learnerId}`;
  return snapshotSchema.parse(row);
}

export async function recordAnswer(
  sql: GateSql,
  learnerId: string,
  input: unknown,
): Promise<Snapshot> {
  const evidence = evidenceSchema.parse(input);
  await sql.begin(async (tx) => {
    await tx`select id from yuk1338.learner where id = ${learnerId} for update`;
    const [prior] =
      await tx`select payload from yuk1338.evidence where learner_id = ${learnerId} and id = ${evidence.evidenceId}`;
    if (prior) {
      if (digest(evidenceSchema.parse(prior.payload)) !== digest(evidence))
        throw new Error('Evidence identity conflict');
      return;
    }
    await tx`insert into yuk1338.evidence (learner_id, id, payload) values (${learnerId}, ${evidence.evidenceId}, ${tx.json(evidence)})`;
    await tx`insert into yuk1338.learner (id, version, evidence) values (${learnerId}, 1, ${tx.json(evidence)})
      on conflict (id) do update set version = yuk1338.learner.version + 1,
      evidence = excluded.evidence, evidence_at = clock_timestamp(), next_activity = null`;
  });
  return readSnapshot(sql, learnerId);
}

// Owns the version fence, expiry, business effect and receipt in one transaction.
// A DBOS step may repeat this call after its own checkpoint was lost; the receipt is
// domain idempotency, not a second scheduler or workflow recovery mechanism.
export async function arrangeNext(sql: GateSql, input: unknown): Promise<Receipt> {
  const command = arrangeSchema.parse(input);
  return sql.begin(async (tx) => {
    const [row] = await tx`select version, evidence_at
      from yuk1338.learner where id = ${command.learnerId} for update`;
    const state = z.object({ version: z.number().int(), evidence_at: z.date() }).parse(row);
    const [prior] =
      await tx`select payload_digest, result from yuk1338.receipt where operation_id = ${command.operationId}`;
    if (prior) {
      if (prior.payload_digest !== digest(command)) throw new Error('Operation identity conflict');
      return receiptSchema.parse(prior.result);
    }
    // SELECT projections can run before FOR UPDATE finishes waiting. Read the
    // database clock only after owning the learner lock and checking prior receipts.
    const [clock] = await tx`select clock_timestamp() as now`;
    const { now } = z.object({ now: z.date() }).parse(clock);
    const result: Receipt =
      state.version !== command.expectedVersion
        ? { kind: 'rejected', reason: 'stale-version', version: state.version }
        : now.getTime() >= Date.parse(command.validUntil)
          ? { kind: 'rejected', reason: 'expired', version: state.version }
          : {
              kind: 'accepted',
              version: state.version + 1,
              activity: command.nextActivity,
              appliedAt: now.toISOString(),
              latencyMs: now.getTime() - state.evidence_at.getTime(),
            };
    if (result.kind === 'accepted') {
      await tx`update yuk1338.learner set version = ${result.version}, next_activity = ${result.activity} where id = ${command.learnerId}`;
      await tx`insert into yuk1338.effect (operation_id, learner_id, activity, version)
        values (${command.operationId}, ${command.learnerId}, ${result.activity}, ${result.version})`;
    }
    await tx`insert into yuk1338.receipt (operation_id, payload_digest, result)
      values (${command.operationId}, ${digest(command)}, ${tx.json(result)})`;
    return result;
  });
}
