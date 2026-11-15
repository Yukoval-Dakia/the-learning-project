import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as genericAssetContentGET } from '@/capabilities/ingestion/api/asset-content';
import { saveResponseDraft, saveSubmission } from '@/capabilities/practice/grading/public';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { newId } from '@/core/ids';
import { taskInputHash } from '@/core/task-input-hash';
import { db } from '@/db/client';
import {
  ai_task_runs,
  assessment_issuance,
  assessment_response_draft,
  drawing,
  event,
  question,
  question_revision,
  source_asset,
  source_document,
} from '@/db/schema';
import {
  anyRestrictedLearnerSource,
  sourceAllowsDerivation,
} from '@/kernel/read-models/usage-policy';
import {
  contractIntegrityDigest,
  normalizeQuestionGroupToContract,
} from '@/kernel/records/assessment-normalization';
import { deleteImageAsset, persistImmutableAsset } from '@/kernel/records/asset-store';
import { captureDraftFocus } from '@/kernel/records/current-draft';
import { recordDrawingStudyAssistanceExposure } from '@/kernel/records/study-reference';
import { captureStudySources } from '@/kernel/records/study-sources';
import { TurnSourceLedger, recordToolReadSources } from '@/kernel/tools/source-ledger';
import {
  type ExecutionAdapter,
  type PreparedExecutionQuery,
  __setPiAdapterForTests,
} from '@/server/ai/execution-adapter';
import { _resetBossForTests, getStartedBoss } from '@/server/boss/client';
import { EXPIRE_LLM, createJobQueue } from '@/server/boss/queue-config';
import { resetDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';
import { buildDrawingGenerateHandler } from '../jobs/drawing_generate';
import {
  type DrawingBoss,
  cancelDrawing,
  readDrawingAsset,
  readDrawingStatus,
  redrawDrawing,
  requestDrawing,
} from './drawing-service';

const r2 = memR2();
r2.putIfAbsent = async (key, body) => {
  if (r2._store.has(key)) return 'exists';
  r2._store.set(key, body);
  return 'created';
};
vi.mock('@/kernel/object-storage', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getR2: () => r2,
}));
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

/** Minimal authored question (standalone — passes its own derivation check). */
async function seedQuestion(over: Partial<typeof question.$inferInsert> = {}): Promise<string> {
  const id = `q_${newId()}`;
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: '题干',
    source: 'manual',
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  });
  return id;
}

/** A routine system event carrying a derivation policy stamp. */
async function seedPolicyEvent(action: string, policy: string): Promise<string> {
  const id = `evt_${newId()}`;
  await db.insert(event).values({
    id,
    session_id: null,
    actor_kind: 'system',
    actor_ref: 'test',
    action,
    subject_kind: 'event',
    subject_id: id,
    outcome: 'success',
    payload: { derivation_policy: policy },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
  return id;
}

async function seedAttemptAndJudge(questionId: string): Promise<void> {
  const attemptId = `evt_${newId()}`;
  await db.insert(event).values({
    id: attemptId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'learner',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: {},
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
  await db.insert(event).values({
    id: `evt_${newId()}`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'judge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    payload: { coarse_outcome: 'incorrect' },
    caused_by_event_id: attemptId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
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

/** A published revision plus one open (unsubmitted) issuance for a question. */
async function seedStemDrawing(
  reference: string | null = '摩擦力方向沿斜面向上，大小等于 mgsinθ',
  prompt = '一个物块静止在粗糙斜面上。',
  scoringOnly = false,
  userMessage = '画一下题设',
  draftGroupRef?: string,
) {
  const documentId = `doc_${newId()}`;
  await db.insert(source_document).values({
    id: documentId,
    source_asset_ids: [],
    provenance: { usage_policy: { derivation_policy: 'allow' } },
    created_at: new Date(),
    updated_at: new Date(),
  });
  const questionId = await seedQuestion({
    prompt_md: prompt,
    reference_md: reference,
    metadata: { source_document_id: documentId },
  });
  const [q] = await db.select().from(question).where(eq(question.id, questionId));
  const contract = normalizeQuestionGroupToContract(q, []);
  if (scoringOnly) {
    contract.structure.materials = [];
    contract.structure.parts[0].material_ids = [];
  }
  contract.integrity_digest = contractIntegrityDigest(contract);
  const revisionId = `rev_${newId()}`;
  await db.insert(question_revision).values({
    revision_id: revisionId,
    group_id: questionId,
    revision_ordinal: 1,
    integrity_digest: contract.integrity_digest,
    structure: contract.structure,
    response_spec: contract.response_spec,
    scoring_basis: contract.scoring_basis,
    execution_plan: contract.execution_plan,
    availability: 'general_pool',
    published_at: new Date(),
  });
  const issuanceId = `iss_${newId()}`;
  await db.insert(assessment_issuance).values({
    issuance_id: issuanceId,
    revision_id: revisionId,
    part_ids: [contract.structure.parts[0].part_id],
    material_bindings: contract.structure.materials.map((material) => ({
      material_id: material.material_id,
      asset_digest: material.asset.digest,
    })),
    option_order: [],
    claim_policy: 'unbounded',
    claim_status: 'unclaimed',
    issued_at: new Date(),
  });
  const sources = await db.transaction((tx) =>
    captureStudySources(tx, questionId, [questionId], []),
  );
  if (!sources) throw new Error('study fixture must be derivable');
  await db.insert(event).values({
    id: `evt_${newId()}`,
    actor_kind: 'system',
    actor_ref: 'test',
    action: 'experimental:assessment_publish',
    subject_kind: 'question',
    subject_id: questionId,
    payload: { revision_id: revisionId, study_sources: sources },
    created_at: new Date(),
  });
  const draft = await saveResponseDraft(db, {
    issuance_id: issuanceId,
    response_set: { entries: [] },
    evaluation_group_ref: draftGroupRef,
  });
  if (draft.status !== 'saved' || draft.save_epoch !== 1)
    throw new Error('study fixture must have an accepted current draft');
  const session = sessionId();
  const askId = `evt_${newId()}`;
  await db.insert(event).values({
    id: askId,
    session_id: session,
    actor_kind: 'user',
    actor_ref: 'user:self',
    action: 'experimental:copilot_user_ask',
    subject_kind: 'query',
    subject_id: askId,
    payload: {
      surface: 'copilot',
      derivation_policy: 'allow',
      user_message: userMessage,
      draft_focus: await captureDraftFocus(db, {
        question_id: questionId,
        issuance_id: issuanceId,
        revision_id: revisionId,
        save_epoch: 1,
      }),
    },
    created_at: new Date(),
  });
  const ledger = new TurnSourceLedger();
  ledger.note({ kind: 'question', id: questionId });
  return {
    questionId,
    issuanceId,
    revisionId,
    ctx: {
      db,
      sessionId: session,
      taskRunId: `run_${newId()}`,
      actorRef: 'test',
      causedByEventId: askId,
      ledger,
    },
    input: { brief: prompt, alt: '题设' },
    submission: {
      issuance_id: issuanceId,
      evaluation_group_id: `eg_${newId()}`,
      idempotency_key: newId(),
      response_set: { entries: [] },
    },
  };
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

  // @invariant security: the scoped veto covers the four non-event source
  // tables plus dangling edges but ignores routine answer_only system events —
  // normal turns are never refused for rows the header cannot even read.
  // @fails-if a stock answer_only event vetoes a turn, or a dangling/restricted
  // non-event source slips past the global check.
  it('routine answer_only events pass while dangling or restricted non-event rows veto', async () => {
    const session = sessionId();
    const t0 = performance.now();
    expect(await anyRestrictedLearnerSource(db)).toBe(false);
    console.info(`anyRestrictedLearnerSource false-path: ${(performance.now() - t0).toFixed(1)}ms`);
    for (const action of [
      'question_admission_purpose',
      'memory_brief_purpose',
      'ingestion_usage_binding',
      'context_change',
    ]) {
      await seedPolicyEvent(action, 'answer_only');
    }
    const sends: string[] = [];
    const deps = { boss: async () => stubBoss(sends) };
    const clean = new TurnSourceLedger();
    clean.noteScoped('learner_state_header');
    const outcome = await requestDrawing(
      { db, sessionId: session, taskRunId: `run_${newId()}`, actorRef: 'test', ledger: clean },
      { brief: '画一个滴定装置', alt: '滴定' },
      deps,
    );
    expect(outcome.status).toBe('ready');
    expect(await anyRestrictedLearnerSource(db)).toBe(false);

    const danglingQ = await seedQuestion({
      source: 'ingestion',
      metadata: { source_document_id: 'doc_gone' },
    });
    expect(await sourceAllowsDerivation(db, { kind: 'question', id: danglingQ })).toBe(false);
    expect(await anyRestrictedLearnerSource(db)).toBe(true);
    await db.delete(question).where(eq(question.id, danglingQ));

    await db.insert(source_document).values({
      id: `doc_${newId()}`,
      title: 'restricted',
      provenance: { usage_policy: { derivation_policy: 'answer_only' } },
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(await anyRestrictedLearnerSource(db)).toBe(true);
  });

  // @invariant security: the scoped projection label persists on the row and
  // the non-event veto still applies at read time — a later-restricted source
  // flips the row expired instead of serving.
  // @fails-if source_scoped is dropped at insert or a restricted projection
  // keeps serving status/asset reads.
  it('persists the scoped label and applies the veto on later reads', async () => {
    const session = sessionId();
    const ledger = new TurnSourceLedger();
    const eventId = await seedDerivableEvent();
    ledger.note({ kind: 'event', id: eventId });
    ledger.noteScoped('learner_state_header');
    const accepted = await requestDrawing(
      { db, sessionId: session, taskRunId: `run_${newId()}`, actorRef: 'test', ledger },
      { brief: '受力分析', alt: '受力分析' },
      { boss: async () => stubBoss([]) },
    );
    expect(accepted.status).toBe('ready');
    const id = (accepted as { drawing_id: string }).drawing_id;
    const [row] = await db.select().from(drawing).where(eq(drawing.id, id));
    expect(row?.source_scoped).toEqual(['learner_state_header']);
    expect(row?.sources).toEqual([{ kind: 'event', id: eventId }]);

    await seedQuestion({ source: 'ingestion', metadata: { source_document_id: 'doc_gone' } });
    const fenced = await readDrawingStatus(db, id, session);
    expect(fenced?.status).toBe('expired');
    expect(fenced?.asset).toBeNull();
  });

  // @invariant security: drawing bytes live under their own asset identity —
  // the generic content route refuses them (before any caching) while an
  // ordinary figure asset with identical bytes still serves.
  // @fails-if a drawing asset is fetchable via /api/assets/:id/content, or a
  // figure asset is shadowed by a drawing row sharing its bytes.
  it('drawing assets carry a separate identity refused by the generic route', async () => {
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
    const drawingAsset = await persistImmutableAsset(db, r2, {
      profile: 'drawing_svg',
      bytes,
      provenance: { source_kind: 'drawing_svg' },
      authorize: async () => {},
    });
    const figureAsset = await persistImmutableAsset(db, r2, {
      profile: 'svg_figure',
      bytes,
      provenance: { source_kind: 'svg_figure' },
      authorize: async () => {},
    });
    expect(drawingAsset.row.id.startsWith('drg_')).toBe(true);
    expect(drawingAsset.row.storage_key.startsWith('assets/drawing-svg/')).toBe(true);
    expect(figureAsset.row.id.startsWith('svf_')).toBe(true);
    expect(figureAsset.row.id).not.toBe(drawingAsset.row.id);

    const generic = await genericAssetContentGET(new Request('http://t/x'), {
      id: drawingAsset.row.id,
    });
    expect(generic.status).toBe(404);
    const ordinary = await genericAssetContentGET(new Request('http://t/x'), {
      id: figureAsset.row.id,
    });
    expect(ordinary.status).toBe(200);
  });

  // @invariant security: a question surfaced through a bank read enters the
  // ledger via group_id/ref — an unjudged one blocks drawing, and a ref that
  // resolves to nothing keeps the turn incomplete.
  // @fails-if bank tool outputs leak a question the ledger never bound, or an
  // unresolvable ref still counts as a complete turn.
  it('bank-read questions bind through group_id and unresolvable refs stay incomplete', async () => {
    const session = sessionId();
    const questionId = await seedQuestion();
    const ledger = new TurnSourceLedger();
    recordToolReadSources(
      'read_bank',
      { refs: ['qrev1-abc'] },
      { items: [{ ref: 'qrev1-abc', status: 'ok', group_id: questionId }] },
      ledger,
    );
    expect(ledger.snapshot().complete).toBe(true);
    expect(ledger.snapshot().sources).toContainEqual({ kind: 'question', id: questionId });
    const sends: string[] = [];
    const refused = await requestDrawing(
      { db, sessionId: session, taskRunId: `run_${newId()}`, actorRef: 'test', ledger },
      { brief: '画这道题', alt: '题图' },
      { boss: async () => stubBoss(sends) },
    );
    expect(refused.status).toBe('unavailable');
    expect(sends).toHaveLength(0);

    const bad = new TurnSourceLedger();
    recordToolReadSources('read_bank', { refs: ['qrev1-missing'] }, { items: [] }, bad);
    expect(bad.snapshot().complete).toBe(false);
  });

  // @invariant security: an answer-bound question in the source lineage blocks
  // drawing until an outcome attempt on it is judged — then the same turn
  // proceeds.
  // @fails-if an unjudged lineage question yields a drawing, or a judged one
  // keeps blocking after the verdict is committed.
  it('unjudged lineage questions block until an attempt is judged', async () => {
    const session = sessionId();
    const questionId = await seedQuestion();
    const ledger = new TurnSourceLedger();
    ledger.note({ kind: 'question', id: questionId });
    const ctx = { db, sessionId: session, taskRunId: `run_${newId()}`, actorRef: 'test', ledger };
    const sends: string[] = [];
    const deps = { boss: async () => stubBoss(sends) };
    const refused = await requestDrawing(ctx, { brief: '画这道题', alt: '题图' }, deps);
    expect(refused.status).toBe('unavailable');
    expect(sends).toHaveLength(0);

    await seedAttemptAndJudge(questionId);
    const accepted = await requestDrawing(ctx, { brief: '画这道题', alt: '题图' }, deps);
    expect(accepted.status).toBe('ready');
    expect(sends).toHaveLength(1);
  });

  // @invariant concurrency: a ready row dedupes regardless of its wait TTL,
  // while an expired live row releases its key atomically so the next insert
  // wins a fresh drawing.
  // @fails-if ready expires under the wait TTL, or a stale queued row pins the
  // dedupe key forever.
  it('ready rows dedupe past the wait TTL and expired live rows release the key', async () => {
    const session = sessionId();
    const ledger = new TurnSourceLedger();
    ledger.note({ kind: 'event', id: await seedDerivableEvent() });
    const sends: string[] = [];
    const deps = { boss: async () => stubBoss(sends) };
    const ctx = { db, sessionId: session, taskRunId: `run_${newId()}`, actorRef: 'test', ledger };
    const input = { brief: '电路图', alt: '电路' };
    const first = await requestDrawing(ctx, input, deps);
    const firstId = (first as { drawing_id: string }).drawing_id;
    const past = new Date(Date.now() - 60_000);
    await db
      .update(drawing)
      .set({ status: 'ready', expires_at: past })
      .where(eq(drawing.id, firstId));
    const again = await requestDrawing(ctx, input, deps);
    expect((again as { drawing_id: string }).drawing_id).toBe(firstId);
    expect(sends).toHaveLength(1);

    const session2 = sessionId();
    const ctx2 = { ...ctx, sessionId: session2 };
    const second = await requestDrawing(ctx2, input, deps);
    const secondId = (second as { drawing_id: string }).drawing_id;
    await db
      .update(drawing)
      .set({ status: 'queued', expires_at: past })
      .where(eq(drawing.id, secondId));
    const redraw = await requestDrawing(ctx2, input, deps);
    const redrawId = (redraw as { drawing_id: string }).drawing_id;
    expect(redrawId).not.toBe(secondId);
    const [oldRow] = await db.select().from(drawing).where(eq(drawing.id, secondId));
    expect(oldRow?.status).toBe('expired');
    expect(sends).toHaveLength(3);
  });

  // @invariant security: only an accepted stem command with the frozen public face
  // may draw an unjudged question; answer intent or uncertain content never dispatches.
  // @fails-if short/final-line/frozen answers leak, or mutable references authorize a drawing.
  it('admits only proven frozen stems and refuses answer intent and uncertain content', async () => {
    for (const mode of [
      'clean',
      'answer_intent',
      'answer_brief',
      'free_form',
      'short',
      'final_line',
      'frozen_drift',
      'current_drift',
      'scoring_only',
      'missing_ask',
    ] as const) {
      const collision = ['short', 'frozen_drift', 'scoring_only'].includes(mode);
      const reference = collision
        ? '42'
        : mode === 'final_line'
          ? '计算过程\n最终答案42'
          : '摩擦力沿斜面向上';
      const prompt = collision
        ? '42'
        : mode === 'final_line'
          ? '最终答案42'
          : '物块静止在粗糙斜面上。';
      const fixture = await seedStemDrawing(
        reference,
        prompt,
        mode === 'scoring_only',
        mode === 'answer_intent' ? '把答案画出来' : '画一下题设',
      );
      if (mode === 'frozen_drift' || mode === 'current_drift')
        await db
          .update(question)
          .set({ reference_md: mode === 'frozen_drift' ? '99' : prompt })
          .where(eq(question.id, fixture.questionId));
      const sends: string[] = [];
      const outcome = await requestDrawing(
        { ...fixture.ctx, ...(mode === 'missing_ask' ? { causedByEventId: undefined } : {}) },
        mode === 'answer_brief'
          ? { brief: '把答案画出来', alt: '答案' }
          : mode === 'free_form'
            ? { brief: '给出受力方向', alt: '题设' }
            : fixture.input,
        { boss: async () => stubBoss(sends) },
      );
      const admitted = mode === 'clean' || mode === 'current_drift';
      expect(outcome.status, mode).toBe(admitted ? 'ready' : 'unavailable');
      if (outcome.status === 'unavailable')
        expect(outcome.issues[0]?.code, mode).toBe('unjudged_source');
      expect(sends, mode).toHaveLength(admitted ? 1 : 0);
      const rows = await db
        .select()
        .from(drawing)
        .where(eq(drawing.session_id, fixture.ctx.sessionId));
      expect(rows, mode).toHaveLength(admitted ? 1 : 0);
      if (admitted) expect(JSON.stringify(rows), mode).not.toContain(reference);
      expect(
        await db
          .select()
          .from(event)
          .where(
            sql`${event.action} = 'experimental:assessment_assistance' AND ${event.subject_id} = ${fixture.issuanceId}`,
          ),
        mode,
      ).toHaveLength(admitted ? 1 : 0);
    }
  });

  // @invariant concurrency: drawing exposure and submission share the issuance lock;
  // only one open coordinate records, and the sealed receipt includes every prior exposure.
  // @fails-if help moves to another issuance, ambiguity fabricates exposure, or either submit ordering seals the wrong receipt.
  it('serializes unique drawing exposure with submission and skips closed or ambiguous coordinates', async () => {
    const exposureRows = (issuanceId: string) =>
      db
        .select()
        .from(event)
        .where(
          sql`${event.action} = 'experimental:assessment_assistance' AND ${event.subject_id} = ${issuanceId}`,
        );
    const receipt = async (groupId: string) => {
      const [row] = await db
        .select()
        .from(event)
        .where(
          sql`${event.action} = 'experimental:assessment_submission' AND ${event.payload}->>'evaluation_group_id' = ${groupId}`,
        );
      return row?.payload.assistance;
    };
    for (const mode of [
      'unique',
      'none',
      'multiple',
      'all_submitted',
      'closed_focus_other_open',
      'submit_first',
      'drawing_first',
    ] as const) {
      const draftGroupRef = mode === 'closed_focus_other_open' ? `eg_${newId()}` : undefined;
      const fixture = await seedStemDrawing(undefined, undefined, false, undefined, draftGroupRef);
      const input = {
        issuanceId: mode === 'none' ? `iss_${newId()}` : fixture.issuanceId,
        questionId: fixture.questionId,
        actorRef: 'test',
        contentDigest: `sha256:${'a'.repeat(64)}`,
      };
      const otherIssuanceId = `iss_${newId()}`;
      if (mode === 'multiple' || mode === 'closed_focus_other_open') {
        const [issued] = await db
          .select()
          .from(assessment_issuance)
          .where(eq(assessment_issuance.issuance_id, fixture.issuanceId));
        await db.insert(assessment_issuance).values({ ...issued, issuance_id: otherIssuanceId });
      }
      if (mode === 'closed_focus_other_open') {
        expect((await saveSubmission(db, fixture.submission)).status).toBe('saved');
        const [retained] = await db
          .select()
          .from(assessment_response_draft)
          .where(eq(assessment_response_draft.issuance_id, fixture.issuanceId));
        expect(retained).toMatchObject({ evaluation_group_ref: draftGroupRef, save_epoch: 1 });
        const outcome = await requestDrawing(fixture.ctx, fixture.input, {
          boss: async () => stubBoss([]),
        });
        expect(outcome.status).toBe('ready');
        expect(
          await db.select().from(drawing).where(eq(drawing.session_id, fixture.ctx.sessionId)),
        ).toHaveLength(1);
        expect(await exposureRows(fixture.issuanceId)).toHaveLength(0);
        expect(await exposureRows(otherIssuanceId)).toHaveLength(0);
        const otherGroupId = `eg_${newId()}`;
        expect(
          (
            await saveSubmission(db, {
              ...fixture.submission,
              issuance_id: otherIssuanceId,
              evaluation_group_id: otherGroupId,
              idempotency_key: newId(),
            })
          ).status,
        ).toBe('saved');
        expect(await receipt(otherGroupId)).toMatchObject({ status: 'independent', event_ids: [] });
        continue;
      }
      if (mode === 'unique' || mode === 'multiple') {
        const sends: string[] = [];
        const deps = { boss: async () => stubBoss(sends) };
        const first = await requestDrawing(fixture.ctx, fixture.input, deps);
        expect(first.status, mode).toBe('ready');
        const again = await requestDrawing(fixture.ctx, fixture.input, deps);
        expect(again, mode).toEqual(first);
        const rows = await exposureRows(fixture.issuanceId);
        expect(rows, mode).toHaveLength(mode === 'unique' ? 2 : 0);
        if (mode === 'unique') {
          expect(rows.map((row) => row.payload)).toEqual([
            expect.objectContaining({ kind: 'chat_context', phase: 'before_submit', dose: null }),
            expect.objectContaining({ kind: 'chat_context', phase: 'before_submit', dose: null }),
          ]);
          expect((await saveSubmission(db, fixture.submission)).status).toBe('saved');
          expect(await receipt(fixture.submission.evaluation_group_id)).toMatchObject({
            status: 'unknown',
            event_ids: expect.arrayContaining(rows.map((row) => row.id)),
          });
        }
        continue;
      }
      if (mode === 'all_submitted')
        expect((await saveSubmission(db, fixture.submission)).status).toBe('saved');
      if (mode === 'none' || mode === 'all_submitted') {
        expect(await recordDrawingStudyAssistanceExposure(db, input), mode).toBeUndefined();
        expect(await exposureRows(fixture.issuanceId), mode).toHaveLength(0);
        continue;
      }
      const locked = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const winner = db.transaction(async (tx) => {
        const result =
          mode === 'submit_first'
            ? await saveSubmission(tx, fixture.submission)
            : await recordDrawingStudyAssistanceExposure(tx, input);
        const [connection] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        locked.resolve(connection.pid);
        await release.promise;
        return result;
      });
      let loser: Promise<unknown> | undefined;
      try {
        const blocker = await Promise.race([
          locked.promise,
          winner.then(() => {
            throw new Error('lock barrier not reached');
          }),
        ]);
        loser =
          mode === 'submit_first'
            ? recordDrawingStudyAssistanceExposure(db, input)
            : saveSubmission(db, fixture.submission);
        await expect
          .poll(
            async () =>
              (
                await db.execute(sql`
          select pid from pg_stat_activity where datname = current_database()
          and ${blocker} = any(pg_blocking_pids(pid))
        `)
              ).length,
          )
          .toBeGreaterThan(0);
      } finally {
        release.resolve();
        await Promise.all([winner, loser]);
      }
      const rows = await exposureRows(fixture.issuanceId);
      expect(rows, mode).toHaveLength(mode === 'drawing_first' ? 1 : 0);
      expect(await receipt(fixture.submission.evaluation_group_id), mode).toMatchObject({
        status: mode === 'drawing_first' ? 'unknown' : 'independent',
        event_ids: rows.map((row) => row.id),
      });
      if (mode === 'submit_first') expect(await loser).toBeUndefined();
      else expect(await loser).toMatchObject({ status: 'saved' });
    }
  });
});

const READY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">' +
  '<rect x="10" y="10" width="40" height="60" fill="none" stroke="#000"/></svg>';

describe('drawing_generate handler invariants', () => {
  const adapterStats = { startups: 0, queries: 0 };
  const providerInputs: unknown[] = [];
  const scriptQueue: Array<{ frames?: unknown[]; error?: unknown }> = [];
  const adapterHooks: {
    beforeStartup?: () => Promise<void>;
    beforeReply?: () => Promise<void>;
  } = {};

  const fakeAdapter: ExecutionAdapter = {
    id: 'pi' as const,
    startup: async () => {
      adapterStats.startups += 1;
      await adapterHooks.beforeStartup?.();
      const prepared: PreparedExecutionQuery = {
        query: (prompt) =>
          (async function* () {
            if (typeof prompt !== 'string') {
              for await (const message of prompt) providerInputs.push(message.message.content);
            }
            adapterStats.queries += 1;
            const next = scriptQueue.shift() ?? { error: new Error('no scripted attempt') };
            if (next.error) throw next.error;
            await adapterHooks.beforeReply?.();
            for (const frame of next.frames ?? []) yield frame as never;
          })(),
        close: async () => {},
      };
      return prepared;
    },
  };

  function pushSvg() {
    scriptQueue.push({
      frames: [
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: READY_SVG }] },
        },
        { type: 'result', subtype: 'success', is_error: false, result: READY_SVG },
      ],
    });
  }

  beforeAll(async () => {
    // Synthetic ChatGPT-login file; the Sol route resolves against it.
    const authPath = join(mkdtempSync(join(tmpdir(), 'yuk1548-test-auth-')), 'auth.json');
    writeFileSync(
      authPath,
      JSON.stringify({
        openai: { type: 'oauth', access: 'stub-access', refresh: 'stub-refresh' },
      }),
    );
    process.env.OPENAI_CHATGPT_AUTH_FILE = authPath;
    delete process.env.OPENAI_API_KEY;
    _resetBossForTests();
    const boss = await getStartedBoss();
    await createJobQueue(boss, 'drawing_generate', EXPIRE_LLM);
    __setPiAdapterForTests(fakeAdapter);
    setTestConfig({
      'task.DrawingTask.provider': 'openai',
      'task.DrawingTask.model': 'gpt-6.1-sol',
      'task.DrawingTask.reasoning': { level: 'high' },
      'task.DrawingTask.override_global_pin': true,
    });
  });

  afterAll(() => {
    __setPiAdapterForTests(undefined);
    resetTestConfig();
  });

  beforeEach(async () => {
    await resetDb();
    adapterStats.startups = 0;
    adapterStats.queries = 0;
    providerInputs.length = 0;
    scriptQueue.length = 0;
    adapterHooks.beforeStartup = undefined;
    adapterHooks.beforeReply = undefined;
  });

  // @invariant security: only verified public figures from the accepted issued
  // revision can leave the worker; private and mutable attachments never do.
  // @fails-if an unbound/corrupt figure is sent, an edited request publishes,
  // or later answer edits revoke a published figure with unchanged sources.
  it.each([
    'verified',
    'corrupt',
    'unbound',
    'edited',
    'withdrawn_before_send',
    'corrupted_before_publish',
  ] as const)('sends only the frozen public figure, refusing %s source changes', async (mode) => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8X8AAAAASUVORK5CYII=',
      'base64',
    );
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const asset = { asset_id: `ast_${newId()}`, digest: `sha256:${sha256}` };
    const assetIds = [asset.asset_id, 'private-answer', 'not-issued'];
    await db.insert(source_asset).values(
      assetIds.map((id) => ({
        id,
        kind: 'image',
        storage_key: id,
        mime_type: 'image/png',
        byte_size: bytes.length,
        sha256,
        created_at: new Date(),
      })),
    );
    r2._store.set(asset.asset_id, mode === 'corrupt' ? Buffer.alloc(bytes.length) : bytes);
    const documentId = `doc_${newId()}`;
    await db.insert(source_document).values({
      id: documentId,
      source_asset_ids: assetIds,
      provenance: { usage_epoch: 'frozen-epoch', usage_policy: { derivation_policy: 'allow' } },
      created_at: new Date(),
      updated_at: new Date(),
    });
    const qid = await seedQuestion({
      image_refs: ['mutable-whole-page-answer'],
      metadata: { source_document_id: documentId },
    });
    await seedAttemptAndJudge(qid);
    const [q] = await db.select().from(question).where(eq(question.id, qid));
    const contract = normalizeQuestionGroupToContract(q, []);
    contract.structure.materials = [
      {
        material_id: 'figure',
        kind: 'figure',
        visibility: 'public',
        asset,
        contains_learner_handwriting: true,
      },
      {
        material_id: 'private',
        kind: 'figure',
        visibility: 'private',
        asset: { asset_id: 'private-answer', digest: asset.digest },
      },
      {
        material_id: 'other-part',
        kind: 'figure',
        visibility: 'public',
        asset: { asset_id: 'not-issued', digest: asset.digest },
      },
    ];
    contract.structure.parts[0].material_ids = ['figure', 'private'];
    contract.structure.parts.push({
      part_id: 'other',
      prompt_md: '另一部分',
      material_ids: ['other-part'],
    });
    contract.integrity_digest = contractIntegrityDigest(contract);
    const revisionId = `rev_${newId()}`;
    await db.insert(question_revision).values({
      revision_id: revisionId,
      group_id: qid,
      revision_ordinal: 1,
      integrity_digest: contract.integrity_digest,
      structure: contract.structure,
      response_spec: contract.response_spec,
      scoring_basis: contract.scoring_basis,
      execution_plan: contract.execution_plan,
      availability: 'general_pool',
      published_at: new Date(),
    });
    const binding = {
      revision_id: revisionId,
      part_ids: [contract.structure.parts[0].part_id],
      material_bindings: [
        { material_id: 'figure', asset_digest: asset.digest },
        { material_id: 'private', asset_digest: asset.digest },
      ],
      option_order: [],
    };
    const issuanceId = `iss_${newId()}`;
    await db.insert(assessment_issuance).values({
      issuance_id: issuanceId,
      ...binding,
      claim_policy: 'unbounded',
      claim_status: 'unclaimed',
      issued_at: new Date(),
    });
    await db.insert(assessment_response_draft).values({
      issuance_id: issuanceId,
      response_set: { entries: [] },
      save_epoch: 1,
      updated_at: new Date(),
    });
    const sealedSources = await db.transaction((tx) =>
      captureStudySources(
        tx,
        qid,
        contract.structure.parts.map((part) => part.part_id),
        assetIds,
      ),
    );
    if (!sealedSources) throw new Error('source fixture must be derivable');
    await db.insert(event).values({
      id: `evt_${newId()}`,
      actor_kind: 'system',
      actor_ref: 'test',
      action: 'experimental:assessment_publish',
      subject_kind: 'question',
      subject_id: qid,
      payload: { revision_id: revisionId, study_sources: sealedSources },
      created_at: new Date(),
    });
    const session = sessionId();
    const focus = {
      question_id: qid,
      issuance_id: issuanceId,
      revision_id: revisionId,
      save_epoch: 1,
    };
    const askId = `evt_${newId()}`;
    await db.insert(event).values({
      id: askId,
      session_id: session,
      actor_kind: 'user',
      actor_ref: 'user:self',
      subject_kind: 'query',
      subject_id: askId,
      created_at: new Date(),
      action: 'experimental:copilot_user_ask',
      payload: {
        surface: 'copilot',
        derivation_policy: 'allow',
        draft_focus: await captureDraftFocus(db, focus),
      },
    });
    const ledger = new TurnSourceLedger();
    ledger.note({ kind: 'question', id: qid });
    const outcome = await requestDrawing(
      {
        db,
        sessionId: session,
        ledger,
        causedByEventId: askId,
        taskRunId: `run_${newId()}`,
        actorRef: 'test',
      },
      { brief: '标出辅助线', alt: '题图' },
      { boss: async () => stubBoss([]) },
    );
    if (outcome.status !== 'ready') throw new Error(JSON.stringify(outcome));
    if (mode === 'unbound') {
      await db
        .update(drawing)
        .set({ source_event_id: null })
        .where(eq(drawing.id, outcome.drawing_id));
    }
    if (mode === 'edited') {
      adapterHooks.beforeReply = async () => {
        await db
          .update(assessment_response_draft)
          .set({ save_epoch: 2 })
          .where(eq(assessment_response_draft.issuance_id, issuanceId));
      };
    }
    if (mode === 'withdrawn_before_send') {
      adapterHooks.beforeStartup = async () => {
        await deleteImageAsset(db, r2, asset.asset_id);
      };
    }
    if (mode === 'corrupted_before_publish') {
      adapterHooks.beforeReply = async () => {
        r2._store.set(asset.asset_id, Buffer.alloc(bytes.length));
      };
    }
    pushSvg();
    const handler = buildDrawingGenerateHandler(db);
    await handler([{ data: { drawing_id: outcome.drawing_id } }]);
    await handler([{ data: { drawing_id: outcome.drawing_id } }]);
    const [stored] = await db.select().from(drawing).where(eq(drawing.id, outcome.drawing_id));
    if (mode !== 'verified') {
      expect(adapterStats.queries).toBe(
        ['edited', 'corrupted_before_publish'].includes(mode) ? 1 : 0,
      );
      expect(stored.last_ready_asset_id).toBeNull();
      expect(['failed', 'expired']).toContain(stored.status);
      return;
    }
    const text = JSON.stringify({
      brief: '标出辅助线',
      alt: '题图',
      image_manifest: [
        { ...focus, material_id: 'figure', ...asset, contains_learner_handwriting: true },
      ],
    });
    const data = bytes.toString('base64');
    expect(providerInputs).toEqual([
      [
        { type: 'text', text },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      ],
    ]);
    expect(adapterStats.queries).toBe(1);
    expect(stored.status).toBe('ready');
    if (!stored.sol_task_run_id) throw new Error('ready drawing needs its paid run');
    const [run] = await db
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, stored.sol_task_run_id));
    expect(run.input_hash).toBe(
      taskInputHash({ text, images: [{ data, mediaType: 'image/png' }] }),
    );
    await db
      .update(assessment_response_draft)
      .set({ save_epoch: 2 })
      .where(eq(assessment_response_draft.issuance_id, issuanceId));
    expect(await readDrawingStatus(db, stored.id, session)).toMatchObject({ status: 'ready' });
    expect(await readDrawingAsset(db, stored.id, session)).toMatchObject({
      asset_id: stored.last_ready_asset_id,
    });
    expect(await redrawDrawing(db, stored.id, session)).toMatchObject({ status: 'refused' });
    await db
      .delete(assessment_response_draft)
      .where(eq(assessment_response_draft.issuance_id, issuanceId));
    expect(await readDrawingStatus(db, stored.id, session)).toMatchObject({ status: 'ready' });
    expect(await readDrawingAsset(db, stored.id, session)).toMatchObject({
      asset_id: stored.last_ready_asset_id,
    });
    await deleteImageAsset(db, r2, asset.asset_id);
    expect(await readDrawingStatus(db, stored.id, session)).toMatchObject({
      status: 'expired',
      asset: null,
    });
    expect(await readDrawingAsset(db, stored.id, session)).toBeNull();
  });

  // @invariant concurrency: a running row whose lease predates the task timeout
  // is presumed dead — the next delivery claims it under the same CAS and the
  // generation completes instead of wedging forever.
  // @fails-if a crashed worker leaves a drawing stuck in running forever.
  it('stale running lease is reclaimed by the next delivery', async () => {
    const [row] = await seedRow({
      status: 'running',
      expires_at: new Date(Date.now() + 60_000),
      updated_at: new Date(Date.now() - 21 * 60 * 1000), // > DRAWING_TIMEOUT_MS
    });
    pushSvg();
    await buildDrawingGenerateHandler(db)([{ data: { drawing_id: row.id } }]);
    const [stored] = await db.select().from(drawing).where(eq(drawing.id, row.id));
    expect(stored.status).toBe('ready');
    expect(stored.last_ready_asset_id).not.toBeNull();
    expect(adapterStats.queries).toBe(1);
  });

  // @invariant concurrency: a redelivered job for a completed generation burns
  // no second provider call — the claim CAS rejects the duplicate delivery.
  // @fails-if a duplicate delivery re-runs the paid Sol call.
  it('duplicate delivery of a finished generation runs nothing', async () => {
    const [row] = await seedRow({
      status: 'ready',
      last_ready_asset_id: 'ast_x',
      last_ready_asset_digest: 'sha256:x',
      expires_at: new Date(Date.now() + 60_000),
    });
    await buildDrawingGenerateHandler(db)([{ data: { drawing_id: row.id } }]);
    const [stored] = await db.select().from(drawing).where(eq(drawing.id, row.id));
    expect(stored.status).toBe('ready');
    expect(adapterStats.queries).toBe(0);
    expect(adapterStats.startups).toBe(0);
  });

  // @invariant security: a cancel/timeout/retraction landing while the
  // delivery waits on provider admission aborts the send — the brief never
  // reaches the provider and the winning terminal state is kept.
  // @fails-if a mid-admission lifecycle change still sends the brief, or the
  // abort is reclassified as a provider failure.
  it.each([
    {
      name: 'cancelled during admission',
      mutate: async (id: string) => {
        await db
          .update(drawing)
          .set({ status: 'cancelled', version: sql`${drawing.version} + 1` })
          .where(eq(drawing.id, id));
      },
      expect: 'cancelled',
    },
    {
      name: 'lease clock ran out',
      mutate: async (id: string) => {
        await db
          .update(drawing)
          .set({ expires_at: new Date(Date.now() - 1000) })
          .where(eq(drawing.id, id));
      },
      expect: 'expired',
    },
    {
      name: 'scoped source restricted',
      mutate: async () => {
        await db.insert(source_document).values({
          id: `doc_${newId()}`,
          title: 'restricted',
          provenance: { usage_policy: { derivation_policy: 'answer_only' } },
          created_at: new Date(),
          updated_at: new Date(),
        });
      },
      expect: 'expired',
    },
  ])('pre-send fence aborts without a provider call ($name)', async ({ mutate, expect: wants }) => {
    const [row] = await seedRow({
      status: 'queued',
      expires_at: new Date(Date.now() + 60_000),
      source_scoped: ['learner_state_header'],
    });
    adapterHooks.beforeStartup = () => mutate(row.id);
    pushSvg();
    await buildDrawingGenerateHandler(db)([{ data: { drawing_id: row.id } }]);
    expect(adapterStats.queries).toBe(0);
    const [stored] = await db.select().from(drawing).where(eq(drawing.id, row.id));
    expect(stored.status).toBe(wants);
  });

  // @invariant concurrency: the dispatch insert commits inside the same
  // transaction as the drawing row — a rolled-back request leaves no orphan job.
  // @fails-if the job send escapes the admission transaction.
  it('the dispatch job is written through the admission transaction', async () => {
    const session = sessionId();
    const ledger = new TurnSourceLedger();
    ledger.note({ kind: 'event', id: await seedDerivableEvent() });
    // A boss stub that genuinely writes through the provided tx adapter —
    // proving send's db option lands inside the admission transaction.
    const boss: DrawingBoss = {
      send: async (name: string, data: unknown, options: { id: string; db: unknown }) => {
        const adapter = options.db as {
          executeSql: (text: string, values: unknown[]) => Promise<unknown>;
        };
        await adapter.executeSql('INSERT INTO pgboss.job (id, name, data) VALUES ($1, $2, $3)', [
          options.id,
          name,
          JSON.stringify(data),
        ]);
        return options.id;
      },
      getJobById: async () => null,
    } as unknown as DrawingBoss;
    const outcome = await requestDrawing(
      { db, sessionId: session, taskRunId: `run_${newId()}`, actorRef: 'test', ledger },
      { brief: '事务入队', alt: 'tx' },
      { boss: async () => boss },
    );
    expect(outcome.status).toBe('ready');
    const jobs = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'drawing_generate'`,
    );
    expect(jobs[0]?.n).toBe(1);
  });

  // @invariant concurrency: if the dispatch write throws inside the admission
  // transaction, the whole request rolls back — neither the drawing row nor a
  // pgboss job survives.
  // @fails-if a failed send leaves a drawing row claiming a job that does not
  // exist, or an orphan job for a drawing that was never inserted.
  it('a failed dispatch rolls back both the row and the job', async () => {
    const session = sessionId();
    const ledger = new TurnSourceLedger();
    ledger.note({ kind: 'event', id: await seedDerivableEvent() });
    let sentJobId: string | null = null;
    const boss: DrawingBoss = {
      send: async (name: string, data: unknown, options: { id: string; db: unknown }) => {
        const adapter = options.db as {
          executeSql: (text: string, values: unknown[]) => Promise<unknown>;
        };
        await adapter.executeSql('INSERT INTO pgboss.job (id, name, data) VALUES ($1, $2, $3)', [
          options.id,
          name,
          JSON.stringify(data),
        ]);
        sentJobId = options.id;
        throw new Error('dispatch exploded after job write');
      },
      getJobById: async () => null,
    } as unknown as DrawingBoss;
    await expect(
      requestDrawing(
        { db, sessionId: session, taskRunId: `run_${newId()}`, actorRef: 'test', ledger },
        { brief: '回滚', alt: '回滚' },
        { boss: async () => boss },
      ),
    ).rejects.toThrow('dispatch exploded after job write');
    expect(await db.select().from(drawing).where(eq(drawing.session_id, session))).toHaveLength(0);
    const jobs = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pgboss.job WHERE id = ${sentJobId ?? ''}`,
    );
    expect(sentJobId).not.toBeNull();
    expect(jobs[0]?.n).toBe(0);
  });
});
