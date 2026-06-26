// M4-T4 (YUK-319) — practice 包的提议 accept-applier 真身，从 dispatch 壳
// （actions.ts @ src/server/proposals）等价平移（搬迁不改逻辑）。壳退化为
// 纯 dispatch，按 kind 一行委托到这里。
//
// practice 声明归属的 proposal kinds（manifest.proposals.kinds）：
//   - variant_question  → acceptVariantQuestionProposal（本文件）
//   - question_draft    → acceptQuestionDraftProposal（本文件）
//   - judge_retraction  → 有 producer（producers.ts 的 judge_retraction 提议）
//     但无 accept applier：accept 走 actions.ts 的 default throw
//     （unsupported_proposal_kind），剩余 producer 语义归 YUK-44。归属声明
//     与 applier 存在性解耦（见 kernel/manifest.ts 的 ProposalKindDecl 注释）。
//
// import 环 gate：本文件不得 import producers/writer/actions（含 type-only）；
// 共享 helper 一律走 @/server/proposals/applier-helpers。

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { QuestionEditOpT } from '@/core/schema/proposal';
import {
  StructuredQuestion,
  type StructuredQuestionT,
  findStructuredNode,
} from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { event, mistake_variant, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { ApiError } from '@/server/http/errors';
// YUK-471 W2 — mistake_variant accept (E2) write-through. accept already writes the rate(accept)
// event; the per-entity flag gates whether the projection (ON) or the imperative UPDATE (OFF)
// writes the row. OFF still runs the write-time fold==row parity assert.
import { projectMistakeVariantGuarded } from '@/server/projections/mistake_variant';
import {
  assertMistakeVariantParity,
  hasMistakeVariantGenesisAnchor,
  mistakeVariantLiveRowToSnapshot,
} from '@/server/projections/parity';
import { projectionIsWriter } from '@/server/projections/sot-flag';
import {
  asPlainRecord,
  ensureAcceptOnly,
  existingAcceptRate,
  requiredString,
} from '@/server/proposals/applier-helpers';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import {
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from '@/server/proposals/signals';
import { withAnswerClass } from '@/server/questions/answer-class-write';

import { initialFsrsState } from './fsrs';

// YUK-17 / ADR-0018 — swappable enqueue hook so DB tests can drive
// variant_question accept without spinning up pg-boss.
export type EnqueueVariantVerifyFn = (mistakeVariantId: string) => Promise<void>;

async function defaultEnqueueVariantVerify(mistakeVariantId: string): Promise<void> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  await boss.send('variant_verify', { mistake_variant_id: mistakeVariantId });
}

export interface VariantQuestionAcceptResult {
  kind: 'variant_question';
  rate_event_id: string;
  question_id: string;
  mistake_variant_id: string;
  idempotent?: boolean;
}

// ADR-0031 / YUK-304 (lane B) — copilot-authored draft question accept.
export interface QuestionDraftAcceptResult {
  kind: 'question_draft';
  rate_event_id: string;
  question_id: string;
  idempotent?: boolean;
}

// ADR-0032 D6-B (YUK-203 lane L6) — active-question structured node edit accept.
export interface QuestionEditAcceptResult {
  kind: 'question_edit';
  rate_event_id: string;
  question_id: string;
  // The structured-edit audit event id (the reversible before/after record);
  // null on the idempotent re-accept path (the edit already committed once).
  edit_event_id: string | null;
  // The post-edit version of the question row.
  version: number;
  idempotent?: boolean;
}

// Structural-minimal opts: the dispatch shell's AcceptAiProposalOpts is
// assignable to this (appliers must not import actions.ts for the full type).
export interface PracticeApplierOpts {
  decision?: string;
  user_note?: string;
  // YUK-17 — swappable enqueue (DB tests inject a no-op or vi.fn).
  enqueueVariantVerify?: EnqueueVariantVerifyFn;
}

/**
 * YUK-17 / ADR-0018 — variant_question accept materializes the question row
 * (source='mistake_variant', draft_status='active'), flips the mistake_variant
 * row from 'draft' to 'active', writes the rate event, and enqueues
 * VariantVerifyTask. The question + mistake_variant + rate-event writes share
 * one transaction so the row never sits half-materialized.
 */
export async function acceptVariantQuestionProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: PracticeApplierOpts,
): Promise<VariantQuestionAcceptResult> {
  if (opts.decision && opts.decision !== 'accept') {
    throw new ApiError(
      'validation_error',
      `variant_question proposal only supports accept, got ${opts.decision}`,
      400,
    );
  }

  // Already-accepted idempotency: a rate event exists.
  const existingRateRows = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    .limit(1);
  const existingRate = existingRateRows[0];
  if (existingRate) {
    const ratePayload = existingRate.payload as { rating?: string };
    if (ratePayload.rating !== 'accept') {
      throw new ApiError(
        'conflict',
        `proposal ${proposalId} already decided as ${ratePayload.rating}`,
        409,
      );
    }
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    const existingMv = (
      await db
        .select()
        .from(mistake_variant)
        .where(eq(mistake_variant.proposal_event_id, proposalId))
        .limit(1)
    )[0];
    if (!existingMv || !existingMv.variant_question_id) {
      // Rate was written but materialization did not complete — caller should
      // retract + re-run, not silently fix up. Surface explicitly.
      throw new ApiError(
        'inconsistent_state',
        `proposal ${proposalId} has a rate event but no materialized variant; retract + retry`,
        500,
      );
    }
    return {
      kind: 'variant_question',
      rate_event_id: existingRate.id,
      question_id: existingMv.variant_question_id,
      mistake_variant_id: existingMv.id,
      idempotent: true,
    };
  }

  const proposedChange = proposal.payload.proposed_change as {
    source_question_id?: string;
    source_attempt_event_id?: string;
    prompt_md?: string;
    reference_md?: string;
    difficulty?: number;
    knowledge_ids?: string[];
    parent_variant_id?: string;
    root_question_id?: string;
    variant_depth?: number;
  };
  if (
    !proposedChange?.prompt_md ||
    !proposedChange.reference_md ||
    typeof proposedChange.difficulty !== 'number' ||
    !proposedChange.source_question_id
  ) {
    throw new ApiError(
      'validation_error',
      `variant_question proposal ${proposalId} is missing required proposed_change fields`,
      400,
    );
  }

  const mvRows = await db
    .select()
    .from(mistake_variant)
    .where(eq(mistake_variant.proposal_event_id, proposalId))
    .limit(1);
  const mv = mvRows[0];
  if (!mv) {
    throw new ApiError(
      'not_found',
      `no mistake_variant draft row found for proposal ${proposalId}; variant_gen may not have written it`,
      404,
    );
  }
  if (mv.status !== 'draft') {
    throw new ApiError(
      'conflict',
      `mistake_variant ${mv.id} is in status ${mv.status}, expected 'draft'`,
      409,
    );
  }

  const now = new Date();
  const newQuestionId = createId();
  const rateEventId = newId();
  // YUK-471 W2 — gate who writes the mistake_variant ROW (the flag is read ONCE outside the tx so a
  // mid-tx env flip can't split the decision). ON → projection write-through; OFF → imperative.
  const flip = projectionIsWriter('mistake_variant');

  await db.transaction(async (tx) => {
    await tx.insert(question).values(
      withAnswerClass({
        id: newQuestionId,
        kind: 'short_answer',
        prompt_md: proposedChange.prompt_md as string,
        reference_md: proposedChange.reference_md ?? null,
        knowledge_ids: proposedChange.knowledge_ids ?? [],
        difficulty: proposedChange.difficulty as number,
        source: 'mistake_variant',
        draft_status: 'active',
        variant_depth: proposedChange.variant_depth ?? 1,
        root_question_id: proposedChange.root_question_id ?? null,
        parent_variant_id: proposedChange.parent_variant_id ?? null,
        created_by: {
          by: 'ai',
          task_kind: 'VariantGenTask',
          propose_event_id: proposalId,
        } as never,
        created_at: now,
        updated_at: now,
      }),
    );

    // The accept `rate` event — written BEFORE the row write-through so the fold (when the flag is
    // ON) sees the chained accept in the same tx and projects status='active' +
    // variant_question_id=materialized_question_id (E2). caused_by = the proposal (the chain key).
    await writeEvent(tx, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        rating: 'accept',
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
        materialized_question_id: newQuestionId,
        mistake_variant_id: mv.id,
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });

    // ROW writer — gated on the per-entity flag (critic A1). ON → the GUARDED projection folds
    // (create base + accept rate) and writes status='active' + variant_question_id; OFF → the
    // imperative UPDATE (current behavior) + the write-time fold==row parity assert. GUARDED (not
    // bare projectMistakeVariant): a pre-W2 / fixture-seeded variant with no create base folds to
    // null; the guard's anchor gate keeps that live row instead of DELETing it just after a question
    // was inserted + linked (B1 data-loss-on-flip — mirrors the dismiss/retract sites).
    if (flip) {
      await projectMistakeVariantGuarded(tx, mv.id);
    } else {
      await tx
        .update(mistake_variant)
        .set({
          status: 'active',
          variant_question_id: newQuestionId,
          updated_at: now,
        })
        .where(eq(mistake_variant.id, mv.id));
      // APPLICABILITY GATE — only assert for an EVENT-SOURCED variant (create-base/genesis/index
      // anchor). A pre-W2 / fixture-seeded mv row (no base event) folds to null and would
      // FALSE-mismatch; the backfill anchors those later. variant_gen-created variants always carry
      // the create base, so the assert runs for the real accept path.
      if (await hasMistakeVariantGenesisAnchor(tx, mv.id)) {
        const [written] = await tx
          .select()
          .from(mistake_variant)
          .where(eq(mistake_variant.id, mv.id))
          .limit(1);
        await assertMistakeVariantParity(
          tx,
          mv.id,
          written ? mistakeVariantLiveRowToSnapshot(written) : null,
        );
      }
    }
  });

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);

  const enqueue = opts.enqueueVariantVerify ?? defaultEnqueueVariantVerify;
  try {
    await enqueue(mv.id);
  } catch (err) {
    // Mirror attribution_followup → variant_gen wiring: enqueue failure must
    // not roll back the accepted variant. Operator can re-enqueue later.
    console.error('[acceptVariantQuestionProposal] enqueue variant_verify failed', err);
  }

  return {
    kind: 'variant_question',
    rate_event_id: rateEventId,
    question_id: newQuestionId,
    mistake_variant_id: mv.id,
  };
}

/**
 * ADR-0031 / YUK-304 (lane B) — question_draft accept. The draft question row
 * was INSERTed at propose time (runQuestionAuthor, same tx as the proposal —
 * 决定4); accept PROMOTES it: draft_status='draft' → 'active' + per-knowledge
 * FSRS enroll-if-absent (copied from the quiz_verify promotion path, the one
 * other place a draft enters the pool) + the rate event, all in one
 * transaction. Idempotency keys on caused_by_event_id = proposalId
 * (existingAcceptRate), like every sibling accept handler.
 *
 * Dismiss flows through the generic dismiss path (writeGenericRateEvent): the
 * draft row stays inert (draft_status='draft', never pooled / FSRS'd).
 * phase-deferred: dismissed-draft cleanup/archival is NOT implemented — orphan
 * draft rows accumulate harmlessly (invisible everywhere drafts are excluded).
 * Revisit with the YUK-304 follow-up batch; context: ADR-0031 决定5 + this
 * handler.
 */
export async function acceptQuestionDraftProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: PracticeApplierOpts,
): Promise<QuestionDraftAcceptResult> {
  ensureAcceptOnly('question_draft', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  const questionId = requiredString(change.question_id, 'question_id', proposalId);

  // Already-accepted idempotency: a rate event exists (409s on a non-accept
  // decision inside existingAcceptRate).
  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    const existing = (
      await db.select().from(question).where(eq(question.id, questionId)).limit(1)
    )[0];
    if (!existing || existing.draft_status === 'draft') {
      // Rate was written but the promotion did not complete — surface explicitly
      // rather than silently fixing up (variant_question precedent).
      throw new ApiError(
        'inconsistent_state',
        `proposal ${proposalId} has an accept rate event but question ${questionId} is ${existing ? 'still draft' : 'missing'}; retract + retry`,
        500,
      );
    }
    return {
      kind: 'question_draft',
      rate_event_id: existingRate.id,
      question_id: questionId,
      idempotent: true,
    };
  }

  const row = (await db.select().from(question).where(eq(question.id, questionId)).limit(1))[0];
  if (!row) {
    throw new ApiError('not_found', `question ${questionId} not found`, 404);
  }
  if (row.draft_status !== 'draft') {
    throw new ApiError(
      'conflict',
      `question ${questionId} is in draft_status ${row.draft_status ?? 'null'}, expected 'draft'`,
      409,
    );
  }

  const now = new Date();
  const rateEventId = newId();

  await db.transaction(async (tx) => {
    await tx
      .update(question)
      .set({ draft_status: 'active', updated_at: now })
      .where(eq(question.id, questionId));

    // FSRS enroll — copied from quiz_verify.ts (YUK-203 P3): per-knowledge
    // enroll-if-absent so a node with an existing review schedule is never
    // reset; question-level fallback when the row carries no knowledge ids.
    const initial = initialFsrsState(now);
    const fsrsSubjectIds = Array.from(new Set(row.knowledge_ids ?? []));
    if (fsrsSubjectIds.length > 0) {
      for (const knowledgeId of fsrsSubjectIds) {
        const existing = await getFsrsState(tx, 'knowledge', knowledgeId);
        if (existing) continue;
        await upsertFsrsState(tx, {
          subject_kind: 'knowledge',
          subject_id: knowledgeId,
          state: initial.state,
          due_at: initial.dueAt,
          last_review_event_id: rateEventId,
        });
      }
    } else {
      const existing = await getFsrsState(tx, 'question', questionId);
      if (!existing) {
        await upsertFsrsState(tx, {
          subject_kind: 'question',
          subject_id: questionId,
          state: initial.state,
          due_at: initial.dueAt,
          last_review_event_id: rateEventId,
        });
      }
    }

    await writeEvent(tx, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        rating: 'accept',
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
        materialized_question_id: questionId,
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });
  });

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);

  return { kind: 'question_draft', rate_event_id: rateEventId, question_id: questionId };
}

// ===========================================================================
// ADR-0032 D6-B (YUK-203 lane L6) — active-question structured node edit.
//
// This is the FIRST writer that mutates an ACTIVE question's `structured` jsonb
// tree. The flat-field active-question writer (src/server/questions/write.ts
// editQuestion) edits prompt_md / choices_md / etc. but never touches the
// recursive structured tree; the draft-layer structured editor
// (capabilities/ingestion block-structured-edit) only touches DRAFT
// question_block rows. The active-question structured write is owned HERE
// (practice domain owns the pooled question lifecycle), kept self-contained so
// the practice applier does not import the ingestion package (import-cycle
// hygiene + single domain ownership).
//
// Coordinate parity: nodes are addressed by `id` — the same id/role the L5
// addressable projection exposes through get_question_context(include:
// ['structure']). So the agent reads a node id and writes the same node id
// (read≡write).
// ===========================================================================

/**
 * Copy-on-write (path-copy) `node` and apply `mutate` to the node whose id
 * matches `target`. NOT a deep clone of the whole tree: only the root→target
 * path is freshly cloned (the matched node plus each of its ancestors); sibling
 * subtrees that do not contain the target are shared by reference with the
 * input. Because every node on the path to the match is fresh, mutating the
 * matched clone can never alias the persisted jsonb. Returns the new tree + whether a node matched.
 */
function mapStructuredNodeById(
  node: StructuredQuestionT,
  target: string,
  mutate: (n: StructuredQuestionT) => void,
): { tree: StructuredQuestionT; matched: boolean } {
  const clone: StructuredQuestionT = {
    ...node,
    sub_questions: node.sub_questions ? node.sub_questions.map((s) => ({ ...s })) : undefined,
  };
  if (clone.id === target) {
    mutate(clone);
    return { tree: clone, matched: true };
  }
  let matched = false;
  if (clone.sub_questions) {
    clone.sub_questions = clone.sub_questions.map((sub) => {
      const res = mapStructuredNodeById(sub, target, mutate);
      if (res.matched) matched = true;
      return res.tree;
    });
  }
  return { tree: clone, matched };
}

// The narrow set of structured-node fields a question_edit op may touch, plus
// provenance. Snapshotted before/after for the reversible audit event.
type NodeEditableSnapshot = Pick<
  StructuredQuestionT,
  'prompt_text' | 'answers' | 'analysis' | 'options' | 'kind'
>;

function snapshotNode(node: StructuredQuestionT): NodeEditableSnapshot {
  return {
    prompt_text: node.prompt_text,
    answers: node.answers,
    analysis: node.analysis,
    options: node.options,
    kind: node.kind,
  };
}

export type QuestionEditGateFailure =
  | 'node_not_found'
  | 'not_a_leaf' // set_choice targets a stem (only leaf/standalone carry options)
  | 'empty_edit' // edit_reference with neither answers nor analysis
  | 'invalid_structure'; // post-edit tree fails the StructuredQuestion invariants

export interface QuestionEditApplyResult {
  tree: StructuredQuestionT;
  before: NodeEditableSnapshot;
  after: NodeEditableSnapshot;
}

/**
 * Mini post-edit verify gate + apply. PURE — no IO. Returns the proposed tree on
 * success, or a typed failure code (the applier rejects without writing). The
 * gate enforces:
 *   1. the target node exists (node_not_found);
 *   2. op-specific node-shape constraints (set_choice → leaf only; edit_reference
 *      → at least one of answers/analysis);
 *   3. the resulting whole tree still satisfies the recursive StructuredQuestion
 *      schema (e.g. only a stem may carry sub_questions) — re-parsed, so a bad
 *      edit can never corrupt the persisted invariant.
 */
export function applyQuestionEdit(
  tree: StructuredQuestionT,
  edit: QuestionEditOpT,
  actorRef: string,
): QuestionEditApplyResult | { failure: QuestionEditGateFailure } {
  const target = findStructuredNode(tree, edit.node_id);
  if (!target) return { failure: 'node_not_found' };
  const before = snapshotNode(target);

  // Op-specific pre-conditions (gate part 1+2).
  if (edit.op === 'set_choice') {
    const isLeaf = target.role !== 'stem';
    if (!isLeaf) return { failure: 'not_a_leaf' };
  }
  if (edit.op === 'edit_reference' && edit.answers === undefined && edit.analysis === undefined) {
    return { failure: 'empty_edit' };
  }

  const { tree: nextTree, matched } = mapStructuredNodeById(tree, edit.node_id, (n) => {
    switch (edit.op) {
      case 'edit_node_text':
        n.prompt_text = edit.prompt_text;
        break;
      case 'edit_reference':
        if (edit.answers !== undefined) n.answers = [...edit.answers];
        if (edit.analysis !== undefined) n.analysis = edit.analysis;
        break;
      case 'set_choice':
        n.options = edit.options.map((o) => ({ label: o.label, text: o.text }));
        break;
      case 'set_node_kind':
        n.kind = edit.kind;
        break;
    }
    n.source = 'agent_edit';
    n.last_modified_by = actorRef;
  });
  // matched is guaranteed (findStructuredNode already hit), but keep the gate honest.
  if (!matched) return { failure: 'node_not_found' };

  // Gate part 3 — the resulting tree must still be a valid StructuredQuestion.
  const parsed = StructuredQuestion.safeParse(nextTree);
  if (!parsed.success) return { failure: 'invalid_structure' };

  const editedNode = findStructuredNode(nextTree, edit.node_id);
  // editedNode is present (we just mutated it); snapshot the after-state.
  const after = editedNode ? snapshotNode(editedNode) : before;
  return { tree: nextTree, before, after };
}

/**
 * ADR-0032 D6-B (YUK-203 lane L6) — question_edit accept. Applies the narrow
 * node op to an ACTIVE question's `structured` tree behind the mini verify gate
 * (applyQuestionEdit), bumps the row version, and writes BOTH an
 * `experimental:question_structure_edit` audit event (before/after node snapshot
 * — the reversible record) AND the `rate` accept event, all in one transaction.
 *
 * Idempotency keys on caused_by_event_id = proposalId (existingAcceptRate), like
 * every sibling accept handler: a re-accept returns the prior result without a
 * second mutation or audit event.
 *
 * Gate / not-found policy:
 *   - missing question row → 404;
 *   - question not active (draft_status='draft' / other) → 409 (this tool edits
 *     POOLED questions only; draft structure is the ingestion block-edit path);
 *   - question has no structured tree → 422 (nothing to address);
 *   - verify-gate failure (node missing / wrong shape / would break invariants)
 *     → 422 with the typed reason; the proposal stays pending so the user can
 *     retract or the agent can re-propose a corrected op.
 */
export async function acceptQuestionEditProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: PracticeApplierOpts,
): Promise<QuestionEditAcceptResult> {
  ensureAcceptOnly('question_edit', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  const questionId = requiredString(change.question_id, 'question_id', proposalId);
  const edit = change.edit as QuestionEditOpT | undefined;
  if (!edit || typeof edit !== 'object' || typeof (edit as { op?: unknown }).op !== 'string') {
    throw new ApiError(
      'validation_error',
      `proposal ${proposalId} is missing required proposed_change.edit`,
      400,
    );
  }

  const actorRef = proposal.actor_ref ?? 'agent:copilot';

  // Already-accepted idempotency: a rate event exists (409s on a non-accept
  // decision inside existingAcceptRate).
  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    const existing = (
      await db.select().from(question).where(eq(question.id, questionId)).limit(1)
    )[0];
    if (!existing) {
      throw new ApiError(
        'inconsistent_state',
        `proposal ${proposalId} has an accept rate event but question ${questionId} is missing; retract + retry`,
        500,
      );
    }
    return {
      kind: 'question_edit',
      rate_event_id: existingRate.id,
      question_id: questionId,
      edit_event_id: null,
      version: existing.version,
      idempotent: true,
    };
  }

  const row = (await db.select().from(question).where(eq(question.id, questionId)).limit(1))[0];
  if (!row) {
    throw new ApiError('not_found', `question ${questionId} not found`, 404);
  }
  if (row.draft_status !== 'active') {
    // Editing the structured tree of a pooled question only. A draft question's
    // structure is the ingestion block-edit path (draft layer); a re-drafted /
    // archived row is not an edit target.
    throw new ApiError(
      'conflict',
      `question ${questionId} is draft_status ${row.draft_status ?? 'null'}, expected 'active'`,
      409,
    );
  }
  if (!row.structured) {
    throw new ApiError(
      'unprocessable_entity',
      `question ${questionId} has no structured tree to edit`,
      422,
    );
  }

  const applied = applyQuestionEdit(row.structured, edit, actorRef);
  if ('failure' in applied) {
    throw new ApiError(
      'unprocessable_entity',
      `question_edit verify gate rejected the edit (${applied.failure}) for question ${questionId}`,
      422,
    );
  }

  const now = new Date();
  const rateEventId = newId();
  const editEventId = newId();
  const nextVersion = row.version + 1;

  await db.transaction(async (tx) => {
    // Optimistic write guarded by the version we read; a concurrent structured
    // edit bumps the version and this update matches 0 rows → conflict.
    const updated = await tx
      .update(question)
      .set({ structured: applied.tree, updated_at: now, version: nextVersion })
      .where(and(eq(question.id, questionId), eq(question.version, row.version)))
      .returning({ version: question.version });
    if (updated.length === 0) {
      throw new ApiError(
        'conflict',
        `question ${questionId} was modified concurrently; retry`,
        409,
      );
    }

    // Reversible audit trail (before/after node snapshot) — the structured edit
    // is correctable from this event without trusting the proposal payload.
    await writeEvent(tx, {
      id: editEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:question_structure_edit',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'success',
      payload: {
        question_id: questionId,
        proposal_event_id: proposalId,
        op: edit.op,
        node_id: edit.node_id,
        previous_version: row.version,
        next_version: nextVersion,
        before: applied.before,
        after: applied.after,
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });

    await writeEvent(tx, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        rating: 'accept',
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
        materialized_question_id: questionId,
        structure_edit_event_id: editEventId,
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });
  });

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);

  return {
    kind: 'question_edit',
    rate_event_id: rateEventId,
    question_id: questionId,
    edit_event_id: editEventId,
    version: nextVersion,
  };
}
