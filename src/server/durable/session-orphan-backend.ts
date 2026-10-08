import { DBOS } from '@dbos-inc/dbos-sdk';
import { createId } from '@paralleldrive/cuid2';
import { eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { session_orphan_control, session_orphan_disposition } from '@/db/schema';
import {
  SessionOrphanContractError,
  type SessionOrphanFamily,
  type SessionOrphanPhase,
  lockSessionOrphanTick,
  parseSessionOrphan,
  readSessionOrphanReceipt,
  readSessionOrphanTick,
  sessionOrphanBackendSchema,
  sessionOrphanFamilySchema,
  sessionOrphanOutcomeSchema,
  sessionOrphanPhaseSchema,
  sessionOrphanRequestSchema,
  sessionOrphanTickSchema,
  sessionOrphanTimestampSchema,
} from './session-orphan-family';

type Executor = Pick<Db, 'execute'>;
const obligationSchema = z.strictObject({
  family: sessionOrphanFamilySchema,
  task_id: z.string().min(1),
  state: z.string().min(1),
  kind: z.enum(['task', 'receipt', 'forwarder']),
  tick_id: z.string().nullable(),
  session_id: z.string().nullable(),
});
export type SessionOrphanObligation = z.infer<typeof obligationSchema>;
const backendInputSchema = z.strictObject({
  family: sessionOrphanFamilySchema,
  backend: sessionOrphanBackendSchema,
});
export async function sessionOrphanObligations(
  db: Executor,
  raw: z.infer<typeof backendInputSchema>,
): Promise<SessionOrphanObligation[]> {
  const { family, backend } = parseSessionOrphan(backendInputSchema, raw);
  // Existence alone must not turn corrupt evidence into a settled obligation.
  const headers =
    await db.execute(sql`select family,tick_id,backend,provenance,tick_at::text,cutoff::text,
    admission,candidates,contract_version from session_orphan_tick where family = ${family} and backend = ${backend}`);
  const ticks = parseSessionOrphan(z.array(sessionOrphanTickSchema), headers);
  const receipts =
    await db.execute(sql`select r.tick_id,r.session_id,r.outcome from session_orphan_receipt r
    join session_orphan_tick t on t.family = r.family and t.tick_id = r.tick_id where r.family = ${family} and t.backend = ${backend}`);
  for (const rawReceipt of receipts) {
    const receipt = parseSessionOrphan(
      z.strictObject({
        tick_id: z.string(),
        session_id: z.string(),
        outcome: sessionOrphanOutcomeSchema,
      }),
      rawReceipt,
    );
    if (
      !ticks
        .find((t) => t.tick_id === receipt.tick_id)
        ?.candidates.some((r) => r.sessionId === receipt.session_id)
    )
      throw new SessionOrphanContractError('Receipt is outside its frozen family admission');
  }
  const tasks =
    backend === 'pg-boss'
      ? await db.execute(sql`select ${family}::text as family, j.id::text as task_id, j.state::text as state,
      'task' as kind, null::text as tick_id, null::text as session_id from pgboss.job j
      where j.name in (${family}, ${`${family}_dlq`}) and (j.state <> 'completed' or j.name = ${`${family}_dlq`})
      and not exists (select 1 from session_orphan_disposition d where d.family = ${family} and d.backend = 'pg-boss'
        and d.kind = 'terminal-task' and d.task_id = j.id::text and d.observed_state = j.state::text)
      union all select ${family}, j.id::text, j.state::text, 'forwarder', null::text, null::text
      from pgboss.job j where j.name = '__pgboss__send-it' and j.state <> 'completed'
      and (jsonb_typeof(j.data) is distinct from 'object' or jsonb_typeof(j.data->'name') is distinct from 'string'
        or j.data->>'name' = '' or j.data->>'name' = ${family}
        or not exists (select 1 from pgboss.queue q where q.name = j.data->>'name'))`)
      : await db.execute(sql`select ${family}::text as family, w.workflow_uuid as task_id, w.status as state,
      'task' as kind, null::text as tick_id, null::text as session_id from tlp_dbos.workflow_status w
      where w.name = ${family} and (w.status <> 'SUCCESS' or not exists
        (select 1 from session_orphan_tick t where t.family = ${family} and t.tick_id = w.workflow_uuid))
      and not exists (select 1 from session_orphan_disposition d where d.family = ${family} and d.backend = 'dbos'
        and d.kind = 'terminal-task' and d.task_id = w.workflow_uuid and d.observed_state = w.status)`);
  const gaps = await db.execute(sql`select t.family,
    case when t.backend = 'pg-boss' then substring(t.tick_id from 8) else t.tick_id end as task_id,
    'missing-receipt' as state, 'receipt' as kind, t.tick_id, c->>'sessionId' as session_id
    from session_orphan_tick t cross join lateral jsonb_array_elements(t.candidates) c
    where t.family = ${family} and t.backend = ${backend} and t.admission = 'admitted'
    and not exists (select 1 from session_orphan_receipt r where r.family = t.family and r.tick_id = t.tick_id and r.session_id = c->>'sessionId')
    and not exists (select 1 from session_orphan_disposition d where d.family = t.family and d.backend = t.backend
      and d.kind = 'terminal-row' and d.tick_id = t.tick_id and d.session_id = c->>'sessionId')`);
  return parseSessionOrphan(z.array(obligationSchema), [...tasks, ...gaps]);
}
export async function sessionOrphanRollbackHorizon(
  db: Executor,
  raw: SessionOrphanFamily,
): Promise<string> {
  const family = parseSessionOrphan(sessionOrphanFamilySchema, raw);
  // Validate backend identities before interpreting their suffix as a timestamp.
  const workflows = await db.execute(
    sql`select workflow_uuid from tlp_dbos.workflow_status where name = ${family}`,
  );
  let latest = '1970-01-01T00:00:00.000Z';
  for (const row of workflows) {
    const id = z.string().parse(row.workflow_uuid);
    const scheduledAt = new Date(id.slice(`sched-${family}-`.length));
    parseSessionOrphan(sessionOrphanRequestSchema, {
      family,
      source: { kind: 'dbos', workflowId: id, scheduledAt },
    });
    if (scheduledAt.getTime() > Date.parse(latest)) latest = scheduledAt.toISOString();
  }
  const [row] = await db.execute(sql`select (greatest(c.phase_changed_at, ${latest}::timestamptz,
    coalesce((select max(tick_at) from session_orphan_tick where family = ${family} and backend = 'dbos'), c.phase_changed_at))
    + interval '60 seconds')::text as not_before from session_orphan_control c where c.family = ${family}`);
  return parseSessionOrphan(sessionOrphanTimestampSchema, row?.not_before);
}
async function lockControl(tx: Tx, family: SessionOrphanFamily) {
  const [primary] = await tx.execute(sql`select pg_is_in_recovery() as replica`);
  if (primary?.replica !== false) throw new Error('Writable primary required');
  const [control] = await tx.execute(sql`select phase, phase_changed_at::text as barrier
    from session_orphan_control where family = ${family} for update`);
  return {
    phase: parseSessionOrphan(sessionOrphanPhaseSchema, control?.phase),
    barrier: parseSessionOrphan(sessionOrphanTimestampSchema, control?.barrier),
  };
}
async function requireQuiescence(
  tx: Tx,
  input: {
    family: SessionOrphanFamily;
    backend: 'pg-boss' | 'dbos';
    phase: SessionOrphanPhase;
    barrier: string;
  },
) {
  const [proof] =
    await tx.execute(sql`select id from session_orphan_disposition where family = ${input.family}
    and backend = ${input.backend} and kind = 'quiescence' and observed_state = ${input.phase}
    and barrier_at = ${input.barrier}::timestamptz`);
  if (!proof)
    throw new SessionOrphanContractError(
      'Drain requires observed process and producer quiescence at this family barrier',
    );
}
export async function attestSessionOrphanQuiescence(
  db: Db,
  raw: { family: SessionOrphanFamily; reason: string },
): Promise<void> {
  const input = parseSessionOrphan(
    z.strictObject({ family: sessionOrphanFamilySchema, reason: z.string().trim().min(1) }),
    raw,
  );
  await db.transaction(
    async (tx) => {
      const control = await lockControl(tx, input.family);
      if (control.phase !== 'draining-pg-boss' && control.phase !== 'draining-dbos')
        throw new SessionOrphanContractError('Quiescence requires a drain barrier');
      await tx.insert(session_orphan_disposition).values({
        family: input.family,
        id: createId(),
        backend: control.phase === 'draining-pg-boss' ? 'pg-boss' : 'dbos',
        kind: 'quiescence',
        observed_state: control.phase,
        reason: input.reason,
        barrier_at: sql`${control.barrier}::timestamptz`,
      });
    },
    { isolationLevel: 'read committed' },
  );
}
const dispositionBase = {
  family: sessionOrphanFamilySchema,
  backend: sessionOrphanBackendSchema,
  taskId: z.string().min(1),
  reason: z.string().trim().min(1),
};
export const sessionOrphanDispositionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...dispositionBase, kind: z.literal('terminal-task') }),
  z.strictObject({
    ...dispositionBase,
    kind: z.literal('terminal-row'),
    tickId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
]);
export type SessionOrphanDispositionInput = z.infer<typeof sessionOrphanDispositionSchema>;
export async function retireFailedSessionOrphan(
  db: Db,
  raw: SessionOrphanDispositionInput,
): Promise<void> {
  const input = parseSessionOrphan(sessionOrphanDispositionSchema, raw);
  if (input.backend === 'pg-boss') parseSessionOrphan(z.uuid(), input.taskId);
  await db.transaction(
    async (tx) => {
      const control = await lockControl(tx, input.family);
      const draining = input.backend === 'pg-boss' ? 'draining-pg-boss' : 'draining-dbos';
      if (control.phase !== draining)
        throw new SessionOrphanContractError('Retirement requires the owning drain phase');
      await requireQuiescence(tx, { family: input.family, backend: input.backend, ...control });
      const [task] =
        input.backend === 'pg-boss'
          ? await tx.execute(
              sql`select name, state::text as state from pgboss.job where id = ${input.taskId}::uuid for update`,
            )
          : await tx.execute(
              sql`select name, status as state from tlp_dbos.workflow_status where workflow_uuid = ${input.taskId} for update`,
            );
      const terminal =
        input.backend === 'pg-boss'
          ? ['failed', 'cancelled']
          : ['ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'];
      if (
        task?.name !== input.family ||
        typeof task.state !== 'string' ||
        !terminal.includes(task.state)
      )
        throw new SessionOrphanContractError(
          'Only a preserved exact-family terminal failure can be dispositioned',
        );
      const tickId = input.backend === 'pg-boss' ? `legacy:${input.taskId}` : input.taskId;
      const key = { family: input.family, tickId };
      await lockSessionOrphanTick(tx, key);
      const saved = await readSessionOrphanTick(tx, key);
      if (saved && saved.backend !== input.backend)
        throw new SessionOrphanContractError('Retirement backend conflict');
      if (input.kind === 'terminal-row') {
        if (
          input.tickId !== tickId ||
          !saved?.candidates.some((r) => r.sessionId === input.sessionId)
        )
          throw new SessionOrphanContractError('No exact unresolved frozen row');
        if (await readSessionOrphanReceipt(tx, key, input.sessionId))
          throw new SessionOrphanContractError('Row already has a receipt');
      } else if (saved) {
        const [gap] = await tx.execute(sql`select c->>'sessionId' as id from session_orphan_tick t
        cross join lateral jsonb_array_elements(t.candidates) c where t.family = ${input.family} and t.tick_id = ${tickId}
        and not exists (select 1 from session_orphan_receipt r where r.family = t.family and r.tick_id = t.tick_id and r.session_id = c->>'sessionId')
        and not exists (select 1 from session_orphan_disposition d where d.family = t.family and d.kind = 'terminal-row'
          and d.backend = ${input.backend} and d.tick_id = t.tick_id and d.session_id = c->>'sessionId')`);
        if (gap) throw new SessionOrphanContractError('Retire unresolved rows before their task');
      }
      await tx.insert(session_orphan_disposition).values({
        family: input.family,
        id: createId(),
        backend: input.backend,
        kind: input.kind,
        task_id: input.taskId,
        observed_state: task.state,
        reason: input.reason,
        ...(input.kind === 'terminal-row' ? { tick_id: tickId, session_id: input.sessionId } : {}),
      });
    },
    { isolationLevel: 'read committed' },
  );
}
export async function changeSessionOrphanPhase(
  db: Db,
  boss: Pick<PgBoss, 'unschedule'>,
  raw: { family: SessionOrphanFamily; target: SessionOrphanPhase },
  schedules: Pick<typeof DBOS, 'getSchedule' | 'pauseSchedule'> = DBOS,
): Promise<void> {
  const input = parseSessionOrphan(
    z.strictObject({ family: sessionOrphanFamilySchema, target: sessionOrphanPhaseSchema }),
    raw,
  );
  await db.transaction(
    async (tx) => {
      const control = await lockControl(tx, input.family);
      if (control.phase === input.target) return;
      const [legacySchedule] = await tx.execute(
        sql`select options from pgboss.schedule where name = ${input.family}`,
      );
      if (legacySchedule) {
        const options = z
          .object({ missed: z.string().nullish() })
          .passthrough()
          .parse(legacySchedule.options ?? {});
        if (options.missed != null && options.missed !== 'skip')
          throw new SessionOrphanContractError(
            'Family drain requires verified pg-boss missed=skip policy',
          );
      }
      const expected: Record<SessionOrphanPhase, SessionOrphanPhase> = {
        'draining-pg-boss': 'pg-boss',
        dbos: 'draining-pg-boss',
        'draining-dbos': 'dbos',
        'pg-boss': 'draining-dbos',
      };
      if (control.phase !== expected[input.target])
        throw new SessionOrphanContractError(
          `Invalid transition ${control.phase} -> ${input.target}`,
        );
      if (input.target === 'dbos' || input.target === 'pg-boss') {
        const backend = input.target === 'dbos' ? 'pg-boss' : 'dbos';
        const obligations = await sessionOrphanObligations(tx, { family: input.family, backend });
        const forwarders =
          input.target === 'pg-boss'
            ? (
                await sessionOrphanObligations(tx, { family: input.family, backend: 'pg-boss' })
              ).filter((r) => r.kind === 'forwarder')
            : [];
        if (obligations.length || forwarders.length)
          throw new SessionOrphanContractError(
            `Drain blocked: ${JSON.stringify([...obligations, ...forwarders])}`,
          );
        await requireQuiescence(tx, { family: input.family, backend, ...control });
        if (input.target === 'pg-boss') {
          const horizon = await sessionOrphanRollbackHorizon(tx, input.family);
          const [clock] = await tx.execute(
            sql`select clock_timestamp() >= ${horizon}::timestamptz as ready`,
          );
          if (clock?.ready !== true)
            throw new SessionOrphanContractError(`Rollback cooldown until ${horizon}`);
          await tx
            .update(session_orphan_control)
            .set({ legacy_not_before: sql`${horizon}::timestamptz` })
            .where(eq(session_orphan_control.family, input.family));
        }
      }
      if (await schedules.getSchedule(input.family)) await schedules.pauseSchedule(input.family);
      await boss.unschedule(input.family);
      await tx
        .update(session_orphan_control)
        .set({ phase: input.target, phase_changed_at: sql`clock_timestamp()` })
        .where(eq(session_orphan_control.family, input.family));
    },
    { isolationLevel: 'read committed' },
  );
}
export async function installSessionOrphanProducerFence(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('session-orphan:v1:install', 0))`,
    );
    for (const table of ['job', 'schedule']) {
      await tx.execute(
        sql.raw(`DROP TRIGGER IF EXISTS yuk1394_session_orphan_producer ON pgboss.${table}`),
      );
      await tx.execute(
        sql.raw(
          `CREATE TRIGGER yuk1394_session_orphan_producer BEFORE INSERT OR UPDATE OF name ON pgboss.${table} FOR EACH ROW EXECUTE FUNCTION fence_session_orphan_producer()`,
        ),
      );
    }
  });
}

export function parseSessionOrphanCommand(args: string[]) {
  const [flag, family, action, ...rest] = z
    .tuple([
      z.literal('--family'),
      sessionOrphanFamilySchema,
      z.enum([
        'status',
        'begin-dbos',
        'finish-dbos',
        'begin-rollback',
        'finish-rollback',
        'quiesce',
        'inspect',
        'retire',
      ]),
    ])
    .rest(z.string())
    .parse(args);
  void flag;
  if (action === 'inspect') {
    const [tickId, sessionId] = z.tuple([z.string().min(1), z.string().min(1)]).parse(rest);
    return { family, action, tickId, sessionId };
  }
  if (action === 'quiesce')
    return { family, action, reason: z.tuple([z.string().trim().min(1)]).parse(rest)[0] };
  if (action === 'retire') {
    const [backend, taskId, reason, tickId, sessionId] = z
      .union([
        z.tuple([sessionOrphanBackendSchema, z.string().min(1), z.string().trim().min(1)]),
        z.tuple([
          sessionOrphanBackendSchema,
          z.string().min(1),
          z.string().trim().min(1),
          z.string().min(1),
          z.string().min(1),
        ]),
      ])
      .parse(rest);
    const disposition = sessionOrphanDispositionSchema.parse(
      tickId && sessionId
        ? { family, backend, taskId, reason, kind: 'terminal-row', tickId, sessionId }
        : { family, backend, taskId, reason, kind: 'terminal-task' },
    );
    return { family, action, disposition };
  }
  z.tuple([]).parse(rest);
  return { family, action };
}
