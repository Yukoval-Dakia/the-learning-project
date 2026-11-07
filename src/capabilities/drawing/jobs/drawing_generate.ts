// drawing_generate worker: claim → source+epoch re-check → Sol route assert →
// run → persist asset → ready. Waits re-arm a delayed send (quota) or a single
// route-scoped login probe (login) inside the same transition tx; cancelled /
// expired rows lose the claim CAS and the job exits without a provider call.
//
// Crash recovery: `running` rows are claimed by lease — once updated_at is
// older than the task timeout the generation is presumed dead and the next
// delivery takes over under the same CAS (the old worker's transitions lose
// on version). Duplicate deliveries of a completed generation claim nothing.

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { AgentRunError } from '@/ai/agent-run-error';
import type { Db, Tx } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { type DrawingStatus, drawing } from '@/db/schema';
import { getR2 } from '@/kernel/object-storage';
import { persistImmutableAsset } from '@/kernel/records/asset-store';
import { ChatGPTOAuthFileError } from '@/server/ai/chatgpt-oauth-store';
import { classifyLoginFailure } from '@/server/ai/login-failure';
import { TaskConfigError } from '@/server/ai/providers';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';
import { getStartedBoss } from '@/server/boss/client';
import {
  DRAWING_JOB_NAME,
  DRAWING_LOGIN_RETRY_MS,
  DRAWING_QUOTA_RETRY_MS,
  type DrawingBoss,
  drawingBossJobId,
  recheckSources,
  sourceEpochsIntact,
} from '../server/drawing-service';
import { DRAWING_LIVE_STATUSES } from '../server/drawing-state';
import { SOL_LANE, assertSolRoute } from '../server/route-assert';
import { DRAWING_TASK_KIND, DRAWING_TIMEOUT_MS, parseDrawingOutput } from '../tasks/drawing-task';

type DrawingRow = typeof drawing.$inferSelect;

/**
 * Atomic claim: exactly one delivery wins a live row past the expiry fence.
 * A `running` row whose lease (updated_at) predates the task timeout is
 * presumed dead — takeover is the crash-recovery path, still CAS-protected.
 */
async function claimDrawing(db: Db, id: string): Promise<DrawingRow | null> {
  const [row] = await db
    .update(drawing)
    .set({ status: 'running', version: sql`${drawing.version} + 1`, updated_at: new Date() })
    .where(
      and(
        eq(drawing.id, id),
        or(
          eq(drawing.status, 'queued'),
          and(
            inArray(drawing.status, ['waiting_quota', 'waiting_login']),
            sql`${drawing.retry_at} <= now()`,
          ),
          and(
            eq(drawing.status, 'running'),
            sql`${drawing.updated_at} <= now() - (${DRAWING_TIMEOUT_MS}::bigint * interval '1 millisecond')`,
          ),
        ),
        sql`${drawing.expires_at} > now()`,
      ),
    )
    .returning();
  return row ?? null;
}

async function transition(
  db: Db,
  row: DrawingRow,
  status: DrawingStatus,
  fields: Partial<typeof drawing.$inferInsert> = {},
): Promise<DrawingRow | null> {
  const [updated] = await db
    .update(drawing)
    .set({ status, version: row.version + 1, updated_at: new Date(), ...fields })
    .where(and(eq(drawing.id, row.id), eq(drawing.version, row.version)))
    .returning();
  return updated ?? null;
}

async function expireDrawing(db: Db, row: DrawingRow, detail: string): Promise<void> {
  await transition(db, row, 'expired', { error_kind: 'retracted', error_detail: detail });
}

async function waitAndRearm(
  db: Db,
  row: DrawingRow,
  status: 'waiting_quota' | 'waiting_login',
  retryAt: Date,
  detail: string,
  boss: DrawingBoss,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(drawing)
      .set({
        status,
        version: row.version + 1,
        retry_at: retryAt,
        error_kind: status === 'waiting_quota' ? 'quota' : 'login',
        error_detail: detail,
        updated_at: new Date(),
      })
      .where(and(eq(drawing.id, row.id), eq(drawing.version, row.version)))
      .returning({ id: drawing.id });
    if (!updated) return; // a cancel/expiry won the CAS — no retry is armed
    const adapter = fromPgBossDrizzleTx(tx);
    if (status === 'waiting_login') {
      // One route-scoped probe per lane — waiting drawings never self-probe
      // hourly. The probe wakes every wait on success, re-arms while any wait
      // remains (the same dedupe keeps only one live probe per route).
      await ensureLoginProbe(tx, boss, adapter);
      return;
    }
    await boss.send(
      DRAWING_JOB_NAME,
      { drawing_id: row.id },
      { id: drawingBossJobId(row.id, row.version + 1), startAfter: retryAt, db: adapter },
    );
  });
}

/**
 * Single login probe per route: a delayed drawing_generate job carrying
 * `login_probe` instead of a drawing id. Deduped inside pgboss.job so N
 * waiting drawings share one probe — the same shape admission uses
 * (`login_probe_route` on its family queue).
 */
async function ensureLoginProbe(
  tx: Tx,
  boss: DrawingBoss,
  adapter: ReturnType<typeof fromPgBossDrizzleTx>,
): Promise<void> {
  const existing = await tx.execute<{ id: string }>(sql`
    SELECT id FROM pgboss.job WHERE name = ${DRAWING_JOB_NAME}
      AND state IN ('created', 'retry', 'active')
      AND data ? 'login_probe' LIMIT 1`);
  if (existing.length > 0) return;
  await boss.send(
    DRAWING_JOB_NAME,
    {
      login_probe: { provider: SOL_LANE.provider, model: SOL_LANE.model },
    },
    {
      id: drawingBossJobId(`login_probe:${SOL_LANE.provider}/${SOL_LANE.model}`, 1),
      startAfter: new Date(Date.now() + DRAWING_LOGIN_RETRY_MS),
      db: adapter,
    },
  );
}

/** Cheap credential probe: route resolves and the auth file exists/parses. */
function probeSolCredentials(): { ok: boolean; reason?: string } {
  try {
    assertSolRoute();
  } catch (error) {
    if (error instanceof ChatGPTOAuthFileError) return { ok: false, reason: error.reason };
    if (error instanceof TaskConfigError) return { ok: false, reason: 'route_config' };
    throw error;
  }
  return { ok: true };
}

/** Probe delivery: on recovery every waiting_login row wakes at once. */
async function runLoginProbe(db: Db, boss: DrawingBoss): Promise<void> {
  const probe = probeSolCredentials();
  if (probe.ok) {
    await db.transaction(async (tx) => {
      const rows = await tx
        .update(drawing)
        .set({ retry_at: new Date(), version: sql`${drawing.version} + 1`, updated_at: new Date() })
        .where(and(eq(drawing.status, 'waiting_login'), sql`${drawing.expires_at} > now()`))
        .returning({ id: drawing.id, version: drawing.version });
      const adapter = fromPgBossDrizzleTx(tx);
      for (const row of rows) {
        await boss.send(
          DRAWING_JOB_NAME,
          { drawing_id: row.id },
          { id: drawingBossJobId(row.id, row.version), db: adapter },
        );
      }
    });
    return;
  }
  // Still failing: re-arm only while waits remain (else the probe line dies).
  const [remaining] = await db
    .select({ id: drawing.id })
    .from(drawing)
    .where(eq(drawing.status, 'waiting_login'))
    .limit(1);
  if (!remaining) return;
  await db.transaction(async (tx) => {
    await ensureLoginProbe(tx, boss, fromPgBossDrizzleTx(tx));
  });
}

function classifyQuota(error: unknown): { retryAfterMs?: number } | undefined {
  if (!(error instanceof AgentRunError)) return undefined;
  if (error.helpProviderFault?.kind === 'quota') return {};
  if (error.apiErrorStatus === 429 || error.providerFailure?.http_status === 429) {
    return {
      ...(error.providerFailure?.retry_after_ms !== undefined
        ? { retryAfterMs: error.providerFailure.retry_after_ms }
        : {}),
    };
  }
  return undefined;
}

async function processDrawing(db: Db, drawingId: string, boss: DrawingBoss): Promise<void> {
  const claimed = await claimDrawing(db, drawingId);
  if (!claimed) {
    // Nothing to claim: flip a live-but-expired row so the state stays honest.
    const [row] = await db.select().from(drawing).where(eq(drawing.id, drawingId));
    if (
      row &&
      (DRAWING_LIVE_STATUSES as readonly string[]).includes(row.status) &&
      row.expires_at.getTime() <= Date.now()
    ) {
      await transition(db, row, 'expired', { error_kind: 'expired' });
    }
    return;
  }
  let row = claimed;

  // Re-check every bound source AND every frozen usage epoch before the send;
  // a moved epoch is treated exactly like retraction.
  const sourceVerdict = await recheckSources(db, row.sources);
  if (!sourceVerdict.ok) {
    await expireDrawing(db, row, 'a bound source stopped allowing derivation');
    return;
  }
  if (!(await sourceEpochsIntact(db, row.source_epochs))) {
    await expireDrawing(db, row, 'a bound source changed usage epoch');
    return;
  }

  // Dedicated-route assert: misconfiguration fails before any provider call,
  // and a missing/invalid ChatGPT-login file parks on waiting_login (the most
  // common NAS failure shape), never on terminal config.
  try {
    assertSolRoute();
  } catch (error) {
    const login =
      classifyLoginFailure(error) ??
      (error instanceof ChatGPTOAuthFileError ? { kind: 'credential' as const } : undefined);
    if (login) {
      await waitAndRearm(
        db,
        row,
        'waiting_login',
        new Date(Date.now() + DRAWING_LOGIN_RETRY_MS),
        `login failure (${login.kind}${'reason' in login && login.reason ? `:${login.reason}` : ''})`,
        boss,
      );
      return;
    }
    if (error instanceof TaskConfigError) {
      await transition(db, row, 'failed', {
        error_kind: 'config',
        error_detail: error.message.slice(0, 500),
      });
      return;
    }
    throw error;
  }

  try {
    const runText = makeRunTaskTextFn(db);
    const result = await runText(
      DRAWING_TASK_KIND,
      { brief: row.brief, alt: row.alt, ...(row.caption ? { caption: row.caption } : {}) },
      {
        // Literal wire assert: closes the gap between the claim-time resolve
        // and the actual provider request (a repin mid-run cannot slip through).
        beforeProviderQuery: async ({ provider, model }) => {
          if (provider !== SOL_LANE.provider || model !== SOL_LANE.model) {
            throw new TaskConfigError(
              `DrawingTask wire pair '${provider}/${model}' is not ${SOL_LANE.provider}/${SOL_LANE.model} — refusing to send.`,
            );
          }
        },
      },
    );
    row = (await transition(db, row, 'running', { sol_task_run_id: result.task_run_id })) ?? row;
    let output: ReturnType<typeof parseDrawingOutput>;
    try {
      output = parseDrawingOutput(result.text);
    } catch (error) {
      await transition(db, row, 'failed', {
        error_kind: 'output',
        error_detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
      return;
    }
    let asset: { id: string; sha256: string };
    try {
      const persisted = await persistImmutableAsset(db, getR2(), {
        profile: 'svg_figure',
        bytes: new TextEncoder().encode(output.svg),
        provenance: {
          source_kind: 'svg_figure',
          actor_ref: 'drawing_generate',
          task_run_id: result.task_run_id,
          drawing_id: row.id,
        },
        authorize: async () => {},
      });
      asset = persisted.row;
    } catch (error) {
      await transition(db, row, 'failed', {
        error_kind: 'asset',
        error_detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
      return;
    }
    await transition(db, row, 'ready', {
      last_ready_asset_id: asset.id,
      last_ready_asset_digest: `sha256:${asset.sha256}`,
      last_ready_task_run_id: result.task_run_id,
      sol_task_run_id: result.task_run_id,
      error_kind: null,
      error_detail: null,
      retry_at: null,
    });
  } catch (error) {
    const login = classifyLoginFailure(error);
    if (login) {
      await waitAndRearm(
        db,
        row,
        'waiting_login',
        new Date(Date.now() + DRAWING_LOGIN_RETRY_MS),
        `login failure (${login.kind}${login.reason ? `:${login.reason}` : ''})`,
        boss,
      );
      return;
    }
    const quota = classifyQuota(error);
    if (quota) {
      await waitAndRearm(
        db,
        row,
        'waiting_quota',
        new Date(Date.now() + (quota.retryAfterMs ?? DRAWING_QUOTA_RETRY_MS)),
        'provider quota exhausted (bound 429)',
        boss,
      );
      return;
    }
    await transition(db, row, 'failed', {
      error_kind: 'provider',
      error_detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    // Ordinary provider failures stay failed — the pg-boss job completes so a
    // redelivery cannot burn a second paid call against the same generation.
  }
}

export function buildDrawingGenerateHandler(db: Db) {
  return async (jobs: Array<{ data: { drawing_id?: string; login_probe?: unknown } }>) => {
    const boss = await getStartedBoss();
    for (const job of jobs) {
      if (job.data?.login_probe) {
        await runLoginProbe(db, boss);
        continue;
      }
      const drawingId = job.data?.drawing_id;
      if (typeof drawingId === 'string') await processDrawing(db, drawingId, boss);
    }
  };
}
