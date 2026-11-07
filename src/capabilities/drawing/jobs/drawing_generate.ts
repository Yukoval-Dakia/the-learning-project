// drawing_generate worker: claim → source re-check → Sol route assert → run →
// persist asset → ready. Waits (quota/login) re-arm a delayed send inside the
// same transition tx; cancelled/expired rows lose the claim CAS and the job
// exits without a provider call.

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { AgentRunError } from '@/ai/agent-run-error';
import type { Db } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { DRAWING_LIVE_STATUSES, type DrawingStatus, drawing } from '@/db/schema';
import { getR2 } from '@/kernel/object-storage';
import { persistImmutableAsset } from '@/kernel/records/asset-store';
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
} from '../server/drawing-service';
import { assertSolRoute } from '../server/route-assert';
import {
  DRAWING_TASK_KIND,
  SOL_MODEL,
  SOL_PROVIDER,
  parseDrawingOutput,
} from '../tasks/drawing-task';

type DrawingRow = typeof drawing.$inferSelect;

/** Atomic claim: exactly one job wins a live row past the expiry fence. */
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
    await boss.send(
      DRAWING_JOB_NAME,
      { drawing_id: row.id },
      { id: drawingBossJobId(row.id, row.version + 1), startAfter: retryAt, db: adapter },
    );
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

  // Re-check every bound source before the send; retraction stops dispatch.
  const sourceVerdict = await recheckSources(db, row.sources);
  if (!sourceVerdict.ok) {
    await expireDrawing(db, row, 'a bound source stopped allowing derivation');
    return;
  }

  // Dedicated-route assert: misconfiguration fails before any provider call.
  try {
    assertSolRoute();
  } catch (error) {
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
          if (provider !== SOL_PROVIDER || model !== SOL_MODEL) {
            throw new TaskConfigError(
              `DrawingTask wire pair '${provider}/${model}' is not ${SOL_PROVIDER}/${SOL_MODEL} — refusing to send.`,
            );
          }
        },
      },
    );
    row = (await transition(db, row, 'running', { sol_task_run_id: result.task_run_id })) ?? row;
    const output = parseDrawingOutput(result.text);
    const { row: asset } = await persistImmutableAsset(db, getR2(), {
      profile: 'svg_figure',
      bytes: new TextEncoder().encode(output.svg),
      provenance: {
        source_kind: 'svg_figure',
        actor_ref: 'drawing_generate',
        task_run_id: result.task_run_id,
      },
      authorize: async () => {},
    });
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
  return async (jobs: Array<{ data: { drawing_id?: string } }>) => {
    const boss = await getStartedBoss();
    for (const job of jobs) {
      const drawingId = job.data?.drawing_id;
      if (typeof drawingId === 'string') await processDrawing(db, drawingId, boss);
    }
  };
}
