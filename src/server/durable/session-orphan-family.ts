import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { learning_session, session_orphan_tick } from '@/db/schema';

export const sessionOrphanFamilySchema = z.enum([
  'prune_orphan_conversation_sessions',
  'prune_orphan_placement_sessions',
]);
export type SessionOrphanFamily = z.infer<typeof sessionOrphanFamilySchema>;
export const sessionOrphanPhaseSchema = z.enum([
  'pg-boss',
  'draining-pg-boss',
  'dbos',
  'draining-dbos',
]);
export type SessionOrphanPhase = z.infer<typeof sessionOrphanPhaseSchema>;
export const sessionOrphanBackendSchema = z.enum(['pg-boss', 'dbos']);
// Keep the original text. Date conversions would drop PostgreSQL microseconds.
export const sessionOrphanTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/)
  .refine((s) => Number.isFinite(Date.parse(s)), 'Invalid PG timestamp');
const versionSchema = z.number().int().nonnegative();
export const sessionOrphanCandidateSchema = z.strictObject({
  sessionId: z.string().min(1),
  selectedStartedAt: sessionOrphanTimestampSchema,
  selectedVersion: versionSchema,
});
const candidatesSchema = z.array(sessionOrphanCandidateSchema).superRefine((rows, ctx) => {
  for (let i = 1; i < rows.length; i++)
    if (rows[i - 1].sessionId >= rows[i].sessionId)
      ctx.addIssue({ code: 'custom', message: 'Candidates must be unique and sorted' });
});
export const sessionOrphanOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('abandoned'),
      fromVersion: versionSchema,
      toVersion: versionSchema,
    })
    .refine((r) => r.toVersion === r.fromVersion + 1, 'Transition version must increment once'),
  z.strictObject({
    kind: z.literal('skipped'),
    reason: z.enum(['missing', 'terminal', 'not-old']),
  }),
  z.strictObject({ kind: z.literal('deferred-known-failure'), error: z.string().min(1) }),
]);
export type SessionOrphanOutcome = z.infer<typeof sessionOrphanOutcomeSchema>;
const sourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dbos'), workflowId: z.string().min(1), scheduledAt: z.date() }),
  z.strictObject({
    kind: z.literal('pg-boss'),
    jobId: z.uuid().transform((id) => id.toLowerCase()),
  }),
]);
export const sessionOrphanRequestSchema = z
  .strictObject({ family: sessionOrphanFamilySchema, source: sourceSchema })
  .superRefine((r, ctx) => {
    if (
      r.source.kind === 'dbos' &&
      r.source.workflowId !== `sched-${r.family}-${r.source.scheduledAt.toISOString()}`
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Native identity must equal the exact family scheduled ID',
      });
  });
export type SessionOrphanRequest = z.infer<typeof sessionOrphanRequestSchema>;
export const sessionOrphanKeySchema = z.strictObject({
  family: sessionOrphanFamilySchema,
  tickId: z.string().min(1),
});
export type SessionOrphanKey = z.infer<typeof sessionOrphanKeySchema>;
export const sessionOrphanTickSchema = z
  .strictObject({
    family: sessionOrphanFamilySchema,
    tick_id: z.string().min(1),
    backend: sessionOrphanBackendSchema,
    provenance: z.enum(['scheduled', 'legacy-first-admission']),
    tick_at: sessionOrphanTimestampSchema,
    cutoff: sessionOrphanTimestampSchema,
    admission: z.enum(['admitted', 'fenced']),
    candidates: candidatesSchema,
    contract_version: z.literal(1),
  })
  .superRefine((r, ctx) => {
    if (
      (r.backend === 'dbos') !== (r.provenance === 'scheduled') ||
      (r.admission === 'fenced' && r.candidates.length)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid saved admission contract' });
    if (r.backend === 'dbos') {
      const at = new Date(r.tick_at).toISOString();
      if (r.tick_id !== `sched-${r.family}-${at}`)
        ctx.addIssue({ code: 'custom', message: 'Invalid saved scheduled identity' });
    } else if (
      !z.uuid().safeParse(r.tick_id.replace(/^legacy:/, '')).success ||
      !r.tick_id.startsWith('legacy:')
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid saved legacy identity' });
  });
export type SessionOrphanTick = z.infer<typeof sessionOrphanTickSchema>;
export type Counts = SessionOrphanKey & {
  candidates: number;
  abandoned: number;
  skipped: number;
  deferred: number;
};
export type SessionOrphanSummary =
  | (Counts & { kind: 'complete'; deferred: 0 })
  | (Counts & { kind: 'completed-with-deferred' })
  | (SessionOrphanKey & { kind: 'fenced'; candidates: 0; abandoned: 0; skipped: 0; deferred: 0 });
export type SessionOrphanBoundary = SessionOrphanKey &
  (
    | { kind: 'selection-committed' }
    | { kind: 'row-committed'; sessionId: string }
    | { kind: 'checkpoint-saved' }
  );
export type SessionOrphanBoundaryHook = (event: SessionOrphanBoundary) => Promise<void>;
export type SessionOrphanInspection =
  | { kind: 'committed'; outcome: SessionOrphanOutcome }
  | { kind: 'not-committed' }
  | { kind: 'unknown'; error: string };
export type SessionOrphanAdmissionInspection =
  | { kind: 'committed'; tick: SessionOrphanTick }
  | { kind: 'not-committed' }
  | { kind: 'unknown'; error: string };
export class SessionOrphanContractError extends Error {}
export class SessionOrphanIdentityConflict extends SessionOrphanContractError {}
export class SessionOrphanUnknownOutcome extends Error {
  constructor(
    readonly family: SessionOrphanFamily,
    readonly tickId: string,
    readonly sessionId: string | null,
    cause: unknown,
  ) {
    super(
      `Session orphan outcome unknown: ${family}/${tickId}${sessionId ? `/${sessionId}` : ''}`,
      { cause },
    );
  }
}
export function parseSessionOrphan<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SessionOrphanContractError(parsed.error.message);
  return parsed.data;
}
export function sessionOrphanKey(request: SessionOrphanRequest): SessionOrphanKey {
  return {
    family: request.family,
    tickId:
      request.source.kind === 'dbos' ? request.source.workflowId : `legacy:${request.source.jobId}`,
  };
}
export async function readSessionOrphanPhase(
  db: Pick<Db, 'execute'>,
  raw: SessionOrphanFamily,
): Promise<SessionOrphanPhase> {
  const family = parseSessionOrphan(sessionOrphanFamilySchema, raw);
  const rows = await db.execute(
    sql`select phase from session_orphan_control where family = ${family}`,
  );
  if (rows.length !== 1) throw new SessionOrphanContractError(`Missing control: ${family}`);
  return parseSessionOrphan(sessionOrphanPhaseSchema, rows[0].phase);
}
export async function lockSessionOrphanControl(
  tx: Tx,
  family: SessionOrphanFamily,
): Promise<SessionOrphanPhase> {
  const [primary] = await tx.execute(sql`select pg_is_in_recovery() as replica`);
  if (primary?.replica !== false) throw new Error('Writable primary required');
  await tx.execute(
    sql`select phase from session_orphan_control where family = ${family} for share`,
  );
  return readSessionOrphanPhase(tx, family);
}
export async function lockSessionOrphanTick(tx: Tx, key: SessionOrphanKey): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`session-orphan:v1:${key.family}:${key.tickId}`}, 0))`,
  );
}
export async function readSessionOrphanTick(
  tx: Tx,
  key: SessionOrphanKey,
): Promise<SessionOrphanTick | null> {
  const rows =
    await tx.execute(sql`select family, tick_id, backend, provenance, tick_at::text, cutoff::text,
    admission, candidates, contract_version from session_orphan_tick where family = ${key.family} and tick_id = ${key.tickId} for update`);
  if (!rows.length) return null;
  const saved = parseSessionOrphan(sessionOrphanTickSchema, rows[0]);
  const [time] =
    await tx.execute(sql`select ${saved.cutoff}::timestamptz = ${saved.tick_at}::timestamptz - interval '6 hours'
    and (${saved.backend} <> 'dbos' or ${saved.tick_at}::timestamptz = ${new Date(saved.tick_at).toISOString()}::timestamptz) as valid`);
  if (time?.valid !== true) throw new SessionOrphanContractError('Corrupt cutoff');
  return saved;
}
export async function validateIdentity(
  tx: Tx,
  saved: SessionOrphanTick,
  request: SessionOrphanRequest,
) {
  if (
    saved.family !== request.family ||
    saved.tick_id !== sessionOrphanKey(request).tickId ||
    saved.backend !== request.source.kind
  )
    throw new SessionOrphanIdentityConflict('Tick identity conflict');
  if (request.source.kind === 'dbos') {
    const [row] = await tx.execute(
      sql`select ${saved.tick_at}::timestamptz = ${request.source.scheduledAt.toISOString()}::timestamptz as same`,
    );
    if (row?.same !== true)
      throw new SessionOrphanIdentityConflict('Tick scheduled timestamp conflict');
  }
}
export async function readSessionOrphanReceipt(
  tx: Tx,
  key: SessionOrphanKey,
  sessionId: string,
): Promise<SessionOrphanOutcome | null> {
  const rows = await tx.execute(
    sql`select outcome from session_orphan_receipt where family = ${key.family} and tick_id = ${key.tickId} and session_id = ${sessionId}`,
  );
  return rows.length ? parseSessionOrphan(sessionOrphanOutcomeSchema, rows[0].outcome) : null;
}
export async function rejectSessionOrphanDisposition(
  tx: Tx,
  key: SessionOrphanKey,
  sessionId?: string,
): Promise<void> {
  const rows =
    await tx.execute(sql`select id from session_orphan_disposition where family = ${key.family}
    and ((kind = 'terminal-task' and task_id = ${key.tickId.startsWith('legacy:') ? key.tickId.slice(7) : key.tickId})
      or (kind = 'terminal-row' and tick_id = ${key.tickId} and session_id = ${sessionId ?? null}))`);
  if (rows.length) throw new SessionOrphanContractError('Disposition blocks new execution');
}
export function requireMember(saved: SessionOrphanTick, sessionId: string) {
  const candidate = saved.candidates.find((r) => r.sessionId === sessionId);
  if (!candidate)
    throw new SessionOrphanContractError('Row is outside the exact frozen family tick');
  return candidate;
}
export async function admitTick(db: Db, request: SessionOrphanRequest): Promise<SessionOrphanTick> {
  const key = sessionOrphanKey(request);
  return db.transaction(
    async (tx) => {
      const phase = await lockSessionOrphanControl(tx, key.family);
      await lockSessionOrphanTick(tx, key);
      const saved = await readSessionOrphanTick(tx, key);
      if (saved) {
        await validateIdentity(tx, saved, request);
        return saved;
      }
      await rejectSessionOrphanDisposition(tx, key);
      if (request.source.kind === 'pg-boss') {
        const [job] = await tx.execute(
          sql`select name from pgboss.job where id = ${request.source.jobId}::uuid`,
        );
        if (job?.name !== request.family)
          throw new SessionOrphanIdentityConflict('Legacy job missing or owned by another family');
      }
      const [clock] = await tx.execute(sql`select clock_timestamp()::text as at,
      coalesce(legacy_not_before <= clock_timestamp(), true) as ready from session_orphan_control where family = ${key.family}`);
      const at =
        request.source.kind === 'dbos'
          ? request.source.scheduledAt.toISOString()
          : parseSessionOrphan(sessionOrphanTimestampSchema, clock?.at);
      const [time] = await tx.execute(
        sql`select (${at}::timestamptz - interval '6 hours')::text as cutoff`,
      );
      const cutoff = parseSessionOrphan(sessionOrphanTimestampSchema, time?.cutoff);
      const authorized =
        request.source.kind === 'dbos'
          ? phase === 'dbos'
          : phase === 'pg-boss' && clock?.ready === true;
      let candidates: z.infer<typeof candidatesSchema> = [];
      if (authorized) {
        switch (request.family) {
          case 'prune_orphan_conversation_sessions':
            candidates = await tx
              .select({
                sessionId: learning_session.id,
                selectedStartedAt: sql<string>`${learning_session.started_at}::text`,
                selectedVersion: learning_session.version,
              })
              .from(learning_session)
              .where(
                and(
                  eq(learning_session.type, 'conversation'),
                  inArray(learning_session.status, ['active', 'idle']),
                  sql`${learning_session.started_at} < ${cutoff}::timestamptz`,
                ),
              )
              .orderBy(learning_session.id);
            break;
          case 'prune_orphan_placement_sessions':
            candidates = await tx
              .select({
                sessionId: learning_session.id,
                selectedStartedAt: sql<string>`${learning_session.started_at}::text`,
                selectedVersion: learning_session.version,
              })
              .from(learning_session)
              .where(
                and(
                  eq(learning_session.type, 'placement'),
                  eq(learning_session.status, 'started'),
                  sql`${learning_session.started_at} < ${cutoff}::timestamptz`,
                ),
              )
              .orderBy(learning_session.id);
            break;
          default: {
            const exhaustive: never = request.family;
            throw new SessionOrphanContractError(String(exhaustive));
          }
        }
      }
      parseSessionOrphan(candidatesSchema, candidates);
      await tx.insert(session_orphan_tick).values({
        family: key.family,
        tick_id: key.tickId,
        backend: request.source.kind,
        provenance: request.source.kind === 'dbos' ? 'scheduled' : 'legacy-first-admission',
        tick_at: sql`${at}::timestamptz`,
        cutoff: sql`${cutoff}::timestamptz`,
        admission: authorized ? 'admitted' : 'fenced',
        candidates,
        contract_version: 1,
      });
      const admitted = await readSessionOrphanTick(tx, key);
      if (!admitted) throw new SessionOrphanContractError('Admission did not persist');
      return admitted;
    },
    { isolationLevel: 'read committed' },
  );
}
export async function inspectSessionOrphanAdmission(
  db: Db,
  raw: SessionOrphanRequest,
): Promise<SessionOrphanAdmissionInspection> {
  const request = parseSessionOrphan(sessionOrphanRequestSchema, raw);
  const key = sessionOrphanKey(request);
  try {
    return await db.transaction(
      async (tx) => {
        await lockSessionOrphanControl(tx, key.family);
        await lockSessionOrphanTick(tx, key);
        const saved = await readSessionOrphanTick(tx, key);
        if (!saved) return { kind: 'not-committed' };
        await validateIdentity(tx, saved, request);
        return { kind: 'committed', tick: saved };
      },
      { isolationLevel: 'read committed' },
    );
  } catch (error) {
    if (error instanceof SessionOrphanContractError) throw error;
    return { kind: 'unknown', error: String(error) };
  }
}
export async function inspectSessionOrphanOutcome(
  db: Db,
  raw: SessionOrphanKey & { sessionId: string },
): Promise<SessionOrphanInspection> {
  const input = parseSessionOrphan(
    sessionOrphanKeySchema.extend({ sessionId: z.string().min(1) }),
    raw,
  );
  try {
    return await db.transaction(
      async (tx) => {
        await lockSessionOrphanControl(tx, input.family);
        await lockSessionOrphanTick(tx, input);
        const saved = await readSessionOrphanTick(tx, input);
        if (!saved) return { kind: 'not-committed' };
        requireMember(saved, input.sessionId);
        const outcome = await readSessionOrphanReceipt(tx, input, input.sessionId);
        return outcome ? { kind: 'committed', outcome } : { kind: 'not-committed' };
      },
      { isolationLevel: 'read committed' },
    );
  } catch (error) {
    if (error instanceof SessionOrphanContractError) throw error;
    return { kind: 'unknown', error: String(error) };
  }
}
