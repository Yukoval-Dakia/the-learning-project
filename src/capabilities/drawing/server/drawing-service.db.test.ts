import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { drawing, event } from '@/db/schema';
import { TurnSourceLedger } from '@/kernel/tools/source-ledger';
import { resetDb } from '../../../../tests/helpers/db';
import {
  type DrawingBoss,
  cancelDrawing,
  readDrawingStatus,
  redrawDrawing,
  requestDrawing,
} from './drawing-service';

function sessionId(): string {
  return `sess_${newId()}`;
}

async function stubBoss(sends: string[]): Promise<DrawingBoss> {
  return {
    send: async (_name: string, _data: unknown, options: { id: string }) => {
      sends.push(options.id);
      return options.id;
    },
    getJobById: async () => null,
  } as unknown as DrawingBoss;
}

/** A real event row so a ledger-bound {kind:'event'} source passes derivation. */
async function seedDerivableEvent(): Promise<string> {
  const id = `evt_${newId()}`;
  await db.insert(event).values({
    id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'test',
    action: 'experimental:drawing_test_source',
    subject_kind: 'event',
    subject_id: id,
    outcome: 'success',
    payload: {},
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
  return id;
}

function seedRow(over: Partial<typeof drawing.$inferInsert> = {}) {
  return db
    .insert(drawing)
    .values({
      id: `drw_${newId()}`,
      session_id: sessionId(),
      dedupe_key: newId(),
      status: 'ready',
      brief: '滴定装置',
      alt: '滴定装置示意',
      sources: [],
      source_complete: true,
      source_epochs: [],
      copilot_task_run_id: `run_${newId()}`,
      expires_at: new Date(Date.now() + 60_000),
      ...over,
    })
    .returning();
}

describe('drawing service invariants', () => {
  beforeEach(resetDb);

  // @invariant security: another session cannot read, cancel or redraw a drawing
  // it does not own — ownership miss is indistinguishable from absence.
  // @fails-if a status/cancel/redraw path returns or mutates a row scoped to a
  // different session_id.
  it('cross-session reads and mutations are refused', async () => {
    const [row] = await seedRow();
    const outsider = sessionId();

    expect(await readDrawingStatus(db, row.id, outsider)).toBeNull();
    expect(await cancelDrawing(db, row.id, outsider)).toBeNull();
    expect(await redrawDrawing(db, row.id, outsider)).toBeNull();

    const [still] = await db.select().from(drawing).where(eq(drawing.id, row.id));
    expect(still.status).toBe('ready');
    expect(still.session_id).toBe(row.session_id);
  });

  // @invariant security: when a bound source stops allowing derivation the
  // derived asset is never served again — the read flips the row to expired.
  // @fails-if a retracted source still yields a served asset or stays ready.
  it('retracted source expires the drawing and suppresses its asset', async () => {
    const [row] = await seedRow({
      sources: [{ kind: 'question', id: `q_missing_${newId()}` }],
      last_ready_asset_id: 'ast_x',
      last_ready_asset_digest: 'sha256:x',
    });
    const view = await readDrawingStatus(db, row.id, row.session_id);
    expect(view?.status).toBe('expired');
    expect(view?.error?.kind).toBe('retracted');
    expect(view?.asset).toBeNull();

    const [stored] = await db.select().from(drawing).where(eq(drawing.id, row.id));
    expect(stored.status).toBe('expired');
  });

  // @invariant concurrency: the same content dedupes onto one live drawing —
  // a repeated request returns the same id without a second dispatch.
  // @fails-if a duplicate request creates a second row or sends a second job.
  it('duplicate requests dedupe onto one drawing and one dispatch', async () => {
    const session = sessionId();
    const ledger = new TurnSourceLedger();
    ledger.note({ kind: 'event', id: await seedDerivableEvent() });
    const sends: string[] = [];
    const deps = { boss: async () => stubBoss(sends) };
    const input = { brief: '画一个滴定实验装置', alt: '滴定装置' };
    const ctx = { db, sessionId: session, taskRunId: `run_${newId()}`, actorRef: 'test', ledger };

    const first = await requestDrawing(ctx, input, deps);
    const second = await requestDrawing(ctx, input, deps);
    expect(first.status).toBe('ready');
    expect(second).toEqual(first);
    expect(sends).toHaveLength(1);

    const rows = await db.select().from(drawing).where(eq(drawing.session_id, session));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sources).toHaveLength(1);
    expect(rows[0]?.source_epochs).toBeDefined();
  });

  // @invariant concurrency: cancel and redraw are idempotent — a repeat call on
  // an already-terminal or already-live row returns state without re-sending.
  // @fails-if a second cancel mutates the row again, or a redraw on a live row
  // dispatches another job.
  it('cancel and redraw are idempotent state transitions', async () => {
    const session = sessionId();
    const ledger = new TurnSourceLedger();
    const sends: string[] = [];
    const deps = { boss: async () => stubBoss(sends) };
    const ctx = { db, sessionId: session, taskRunId: `run_${newId()}`, actorRef: 'test', ledger };

    const requested = await requestDrawing(ctx, { brief: '受力分析图', alt: '受力分析' }, deps);
    expect(requested.status).toBe('ready');
    const id = (requested as { drawing_id: string }).drawing_id;

    const cancelled = await cancelDrawing(db, id, session);
    expect(cancelled?.status).toBe('cancelled');
    const cancelledAgain = await cancelDrawing(db, id, session);
    expect(cancelledAgain).toEqual(cancelled);

    const redrawn = await redrawDrawing(db, id, session, deps);
    expect((redrawn as { status: string }).status).toBe('queued');
    const queuedAgain = await redrawDrawing(db, id, session, deps);
    expect((queuedAgain as { status: string }).status).toBe('queued');

    // One dispatch on request, one on the redraw that won the CAS — nothing more.
    expect(sends).toHaveLength(2);
    const [stored] = await db.select().from(drawing).where(eq(drawing.id, id));
    expect(stored.attempt).toBe(2);
  });

  // @invariant security: a source set that cannot be proven derivable refuses at
  // admission — no drawing row, no job, a typed restricted_source issue.
  // @fails-if an unprovable or unbindable source reaches insert or dispatch.
  it('unprovable sources refuse before insert', async () => {
    const session = sessionId();
    const ledger = new TurnSourceLedger();
    ledger.note({ kind: 'question', id: `q_missing_${newId()}` });
    const sends: string[] = [];
    const ctx = {
      db,
      sessionId: session,
      taskRunId: `run_${newId()}`,
      actorRef: 'test',
      ledger,
    };
    const outcome = await requestDrawing(
      ctx,
      { brief: '画受限资料图', alt: '受限' },
      { boss: async () => stubBoss(sends) },
    );
    expect(outcome.status).toBe('unavailable');
    expect((outcome as { issues: { code: string }[] }).issues[0]?.code).toBe('restricted_source');
    expect(sends).toHaveLength(0);
    expect(await db.select().from(drawing).where(eq(drawing.session_id, session))).toHaveLength(0);

    // An incomplete ledger (unbound aggregate context) refuses the same way.
    const incomplete = new TurnSourceLedger();
    incomplete.noteUnknown('learner_state_header');
    const refused = await requestDrawing(
      { ...ctx, ledger: incomplete },
      { brief: '同上', alt: '同上' },
      { boss: async () => stubBoss(sends) },
    );
    expect(refused.status).toBe('unavailable');
    expect(sends).toHaveLength(0);
  });
});
