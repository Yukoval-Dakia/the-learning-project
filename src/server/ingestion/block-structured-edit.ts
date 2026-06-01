// YUK-195 — single-owner service for agent-callable question structure edits.
//
// Design note: docs/superpowers/specs/2026-06-01-question-edit-domaintools-design.md
// Refs: YUK-164 (T-OC), ADR-0002 §"Agent 修改约束", P3.7.
//
// All six structure-edit mutations live here; the six DomainTools in
// `src/server/ai/tools/question-edit-tools.ts` are thin wrappers, and the
// figures PATCH route (`app/api/question-blocks/[id]/figures/[asset_id]`)
// reassigns figures by calling `reassignFigure` here (single owner, no dup
// logic).
//
// Cross-cutting mechanics (§3):
//   - Operates on the pre-import correction layer: draft `question_block`
//     `.structured` tree + `.figures`. Status guard: `status === 'draft'` →
//     soft `skipped:not_draft` (NOT a throw).
//   - Provenance: every touched structured node gets `source='agent_edit'` +
//     `last_modified_by=<actorRef>`.
//   - Concurrency: `block.version` bump on every write; `SELECT ... FOR UPDATE`
//     inside the tx serialises concurrent edits to the same block.
//   - SSE trail: `writeJobEvent(tx, { event_type: 'block.structured_edited' |
//     'figure.reassigned', ... })` so the ingestion SSE timeline live-updates.
//   - Soft failures return a discriminated result with a `status: 'skipped:*'`
//     code; callers decide how to surface it (tool → Output; route → 4xx).
//     Hard/unexpected conditions throw.

import { eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';

import type { QuestionKind } from '@/core/schema/business';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { question_block } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';

// ---------------------------------------------------------------------------
// Shared tree helpers
// ---------------------------------------------------------------------------

/** True if `target` matches the id of `node` or any descendant. */
export function idHasMatch(node: StructuredQuestionT, target: string): boolean {
  if (node.id === target) return true;
  for (const sub of node.sub_questions ?? []) {
    if (idHasMatch(sub, target)) return true;
  }
  return false;
}

/**
 * Return a deep-cloned tree with `mutate` applied in place to the node whose
 * id matches `target`, and `null` if no node matched. The mutation runs on the
 * cloned node so callers never alias the persisted jsonb.
 */
function mapNodeById(
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
      const res = mapNodeById(sub, target, mutate);
      if (res.matched) matched = true;
      return res.tree;
    });
  }
  return { tree: clone, matched };
}

/** Stamp agent-edit provenance onto a node (mutates in place). */
function stampProvenance(node: StructuredQuestionT, actorRef: string): void {
  node.source = 'agent_edit';
  node.last_modified_by = actorRef;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type EditStatus =
  | 'written'
  | 'skipped:not_draft'
  | 'skipped:node_not_found'
  | 'skipped:not_splittable'
  | 'skipped:cross_session'
  | 'skipped:block_not_found'
  | 'skipped:figure_not_found';

export interface EditResult {
  status: EditStatus;
  /** Set on `written`; the post-mutation version of the primary block. */
  version?: number;
}

export interface BaseEditParams {
  /** `callerActor.ref` of the tool caller, stamped as `last_modified_by`. */
  actorRef: string;
}

// ---------------------------------------------------------------------------
// Internal: load a draft block FOR UPDATE inside a tx
// ---------------------------------------------------------------------------

type BlockRow = typeof question_block.$inferSelect;

async function loadBlockForUpdate(tx: Tx, blockId: string): Promise<BlockRow | undefined> {
  const rows = await tx
    .select()
    .from(question_block)
    .where(eq(question_block.id, blockId))
    .for('update');
  return rows[0];
}

async function persistStructured(
  tx: Tx,
  blockId: string,
  structured: StructuredQuestionT,
  eventType: 'block.structured_edited',
  payload: Record<string, unknown>,
): Promise<number> {
  const updated = await tx
    .update(question_block)
    .set({
      structured,
      updated_at: new Date(),
      version: sql`${question_block.version} + 1`,
    })
    .where(eq(question_block.id, blockId))
    .returning({ version: question_block.version });
  await writeJobEvent(tx, {
    business_table: 'question_block',
    business_id: blockId,
    event_type: eventType,
    payload,
  });
  return updated[0].version;
}

// ---------------------------------------------------------------------------
// §4.1 updatePrompt
// ---------------------------------------------------------------------------

export interface UpdatePromptParams extends BaseEditParams {
  blockId: string;
  nodeId: string;
  promptText: string;
}

export async function updatePrompt(db: Db, params: UpdatePromptParams): Promise<EditResult> {
  return db.transaction(async (tx) => {
    const block = await loadBlockForUpdate(tx, params.blockId);
    if (!block) return { status: 'skipped:block_not_found' };
    if (block.status !== 'draft') return { status: 'skipped:not_draft' };
    if (!block.structured) return { status: 'skipped:node_not_found' };

    const { tree, matched } = mapNodeById(block.structured, params.nodeId, (n) => {
      n.prompt_text = params.promptText;
      stampProvenance(n, params.actorRef);
    });
    if (!matched) return { status: 'skipped:node_not_found' };

    const version = await persistStructured(tx, params.blockId, tree, 'block.structured_edited', {
      op: 'update_prompt',
      node_id: params.nodeId,
    });
    return { status: 'written', version };
  });
}

// ---------------------------------------------------------------------------
// §4.2 addOption
// ---------------------------------------------------------------------------

export interface AddOptionParams extends BaseEditParams {
  blockId: string;
  nodeId: string;
  option: { label: string; text: string };
}

export async function addOption(db: Db, params: AddOptionParams): Promise<EditResult> {
  return db.transaction(async (tx) => {
    const block = await loadBlockForUpdate(tx, params.blockId);
    if (!block) return { status: 'skipped:block_not_found' };
    if (block.status !== 'draft') return { status: 'skipped:not_draft' };
    if (!block.structured) return { status: 'skipped:node_not_found' };

    const { tree, matched } = mapNodeById(block.structured, params.nodeId, (n) => {
      n.options = [...(n.options ?? []), { label: params.option.label, text: params.option.text }];
      stampProvenance(n, params.actorRef);
    });
    if (!matched) return { status: 'skipped:node_not_found' };

    const version = await persistStructured(tx, params.blockId, tree, 'block.structured_edited', {
      op: 'add_option',
      node_id: params.nodeId,
    });
    return { status: 'written', version };
  });
}

// ---------------------------------------------------------------------------
// §4.3 setQuestionType — advisory `kind` hint (jsonb-internal, no DDL).
// ---------------------------------------------------------------------------

export interface SetQuestionTypeParams extends BaseEditParams {
  blockId: string;
  nodeId: string;
  kind: z.infer<typeof QuestionKind>;
}

export async function setQuestionType(db: Db, params: SetQuestionTypeParams): Promise<EditResult> {
  return db.transaction(async (tx) => {
    const block = await loadBlockForUpdate(tx, params.blockId);
    if (!block) return { status: 'skipped:block_not_found' };
    if (block.status !== 'draft') return { status: 'skipped:not_draft' };
    if (!block.structured) return { status: 'skipped:node_not_found' };

    const { tree, matched } = mapNodeById(block.structured, params.nodeId, (n) => {
      n.kind = params.kind;
      stampProvenance(n, params.actorRef);
    });
    if (!matched) return { status: 'skipped:node_not_found' };

    const version = await persistStructured(tx, params.blockId, tree, 'block.structured_edited', {
      op: 'set_question_type',
      node_id: params.nodeId,
      kind: params.kind,
    });
    return { status: 'written', version };
  });
}

// ---------------------------------------------------------------------------
// §4.4 splitStem — un-group a stem's sub_questions into standalone siblings.
// ---------------------------------------------------------------------------

export interface SplitStemParams extends BaseEditParams {
  blockId: string;
  nodeId: string;
}

/**
 * Promote a stem's sub_questions to `role='standalone'` (order preserved,
 * provenance stamped on each). Returns the promoted nodes.
 */
function promoteSubsToStandalone(
  stem: StructuredQuestionT,
  actorRef: string,
): StructuredQuestionT[] {
  return (stem.sub_questions ?? []).map((sub) => {
    const clone: StructuredQuestionT = { ...sub, role: 'standalone', sub_questions: undefined };
    stampProvenance(clone, actorRef);
    return clone;
  });
}

function isSplittableStem(node: StructuredQuestionT): boolean {
  return node.role === 'stem' && (node.sub_questions?.length ?? 0) > 0;
}

/**
 * Un-group the `target` stem. Two cases, both within-block (no new block):
 *
 *   - Root stem is the target: the block's single-root jsonb can't hold N
 *     sibling roots, so we keep a stem shell (empty passage) whose
 *     `sub_questions` are the former subs promoted to `role='standalone'`. The
 *     derived markdown drops the now-empty passage, yielding the un-grouped
 *     view. (A stem may legally hold standalone children; only non-stems are
 *     barred from having sub_questions by the schema refine.)
 *   - Nested stem is the target: splice the stem out of its parent's
 *     `sub_questions` and insert its promoted standalone children in its place,
 *     preserving order.
 *
 * Returns `{ tree, outcome }` where outcome is `split | not_found |
 * not_splittable`.
 */
function splitStemInTree(
  node: StructuredQuestionT,
  target: string,
  actorRef: string,
): { tree: StructuredQuestionT; outcome: 'split' | 'not_found' | 'not_splittable' } {
  if (node.id === target) {
    if (!isSplittableStem(node)) return { tree: node, outcome: 'not_splittable' };
    const shell: StructuredQuestionT = {
      id: node.id,
      role: 'stem',
      prompt_text: '',
      source: 'agent_edit',
      last_modified_by: actorRef,
      sub_questions: promoteSubsToStandalone(node, actorRef),
    };
    return { tree: shell, outcome: 'split' };
  }

  let outcome: 'split' | 'not_found' | 'not_splittable' = 'not_found';
  const nextSubs: StructuredQuestionT[] = [];
  for (const sub of node.sub_questions ?? []) {
    if (sub.id === target) {
      if (!isSplittableStem(sub)) {
        nextSubs.push(sub);
        outcome = 'not_splittable';
      } else {
        nextSubs.push(...promoteSubsToStandalone(sub, actorRef));
        outcome = 'split';
      }
      continue;
    }
    const res = splitStemInTree(sub, target, actorRef);
    nextSubs.push(res.tree);
    if (res.outcome === 'split') outcome = 'split';
    else if (res.outcome === 'not_splittable' && outcome === 'not_found') {
      outcome = 'not_splittable';
    }
  }
  const clone: StructuredQuestionT = {
    ...node,
    sub_questions: node.sub_questions ? nextSubs : undefined,
  };
  return { tree: clone, outcome };
}

export async function splitStem(db: Db, params: SplitStemParams): Promise<EditResult> {
  return db.transaction(async (tx) => {
    const block = await loadBlockForUpdate(tx, params.blockId);
    if (!block) return { status: 'skipped:block_not_found' };
    if (block.status !== 'draft') return { status: 'skipped:not_draft' };
    if (!block.structured) return { status: 'skipped:node_not_found' };
    if (!idHasMatch(block.structured, params.nodeId)) {
      return { status: 'skipped:node_not_found' };
    }

    const result = splitStemInTree(block.structured, params.nodeId, params.actorRef);
    if (result.outcome === 'not_found') return { status: 'skipped:node_not_found' };
    if (result.outcome === 'not_splittable') return { status: 'skipped:not_splittable' };

    const version = await persistStructured(
      tx,
      params.blockId,
      result.tree,
      'block.structured_edited',
      { op: 'split_stem', node_id: params.nodeId },
    );
    return { status: 'written', version };
  });
}

// ---------------------------------------------------------------------------
// §4.5 mergeQuestions — absorb sibling draft blocks into a primary block.
// ---------------------------------------------------------------------------

export interface MergeQuestionsParams extends BaseEditParams {
  primaryBlockId: string;
  mergeBlockIds: string[];
}

/** Top-level structured nodes of a block, normalised to an array. */
function topLevelNodes(structured: StructuredQuestionT | null): StructuredQuestionT[] {
  if (!structured) return [];
  // A block's structured jsonb is a single tree; its top-level node is the one
  // we absorb. (Sub-questions ride along inside it.)
  return [structured];
}

export async function mergeQuestions(db: Db, params: MergeQuestionsParams): Promise<EditResult> {
  return db.transaction(async (tx) => {
    const primary = await loadBlockForUpdate(tx, params.primaryBlockId);
    if (!primary) return { status: 'skipped:block_not_found' };
    if (primary.status !== 'draft') return { status: 'skipped:not_draft' };

    const mergeIds = params.mergeBlockIds.filter((id) => id !== params.primaryBlockId);
    if (mergeIds.length === 0) return { status: 'skipped:block_not_found' };

    const mergeBlocks = await tx
      .select()
      .from(question_block)
      .where(inArray(question_block.id, mergeIds))
      .for('update');
    // Every requested merge block must exist.
    if (mergeBlocks.length !== mergeIds.length) return { status: 'skipped:block_not_found' };
    // All blocks must be draft.
    if (mergeBlocks.some((b) => b.status !== 'draft')) return { status: 'skipped:not_draft' };
    // All blocks must share the primary's ingestion_session_id.
    if (mergeBlocks.some((b) => b.ingestion_session_id !== primary.ingestion_session_id)) {
      return { status: 'skipped:cross_session' };
    }

    // Absorb each merge block's top-level structured nodes into the primary as
    // appended sub_questions. The primary becomes a stem container holding all
    // nodes (its own + absorbed), preserving order. Provenance on the primary.
    const primaryNodes = topLevelNodes(primary.structured);
    const absorbed: StructuredQuestionT[] = [];
    for (const mb of mergeBlocks) {
      for (const node of topLevelNodes(mb.structured)) {
        const clone: StructuredQuestionT = { ...node, role: 'sub' };
        stampProvenance(clone, params.actorRef);
        absorbed.push(clone);
      }
    }
    const existingSubs =
      primary.structured && primary.structured.role === 'stem'
        ? (primary.structured.sub_questions ?? [])
        : primaryNodes.map((n) => ({ ...n, role: 'sub' as const }));
    const mergedTree: StructuredQuestionT = {
      id: primary.structured?.id ?? params.primaryBlockId,
      role: 'stem',
      prompt_text: primary.structured?.role === 'stem' ? primary.structured.prompt_text : '',
      source: 'agent_edit',
      last_modified_by: params.actorRef,
      sub_questions: [...existingSubs, ...absorbed],
    };

    await tx
      .update(question_block)
      .set({
        structured: mergedTree,
        merged_from_block_ids: [...(primary.merged_from_block_ids ?? []), ...mergeIds],
        updated_at: new Date(),
        version: sql`${question_block.version} + 1`,
      })
      .where(eq(question_block.id, params.primaryBlockId));

    await tx
      .update(question_block)
      .set({ status: 'ignored', updated_at: new Date() })
      .where(inArray(question_block.id, mergeIds));

    await writeJobEvent(tx, {
      business_table: 'question_block',
      business_id: params.primaryBlockId,
      event_type: 'block.structured_edited',
      payload: { op: 'merge_questions', merged_from_block_ids: mergeIds },
    });
    for (const id of mergeIds) {
      await writeJobEvent(tx, {
        business_table: 'question_block',
        business_id: id,
        event_type: 'block.structured_edited',
        payload: { op: 'merge_questions', merged_into_block_id: params.primaryBlockId },
      });
    }

    const after = await tx
      .select({ version: question_block.version })
      .from(question_block)
      .where(eq(question_block.id, params.primaryBlockId));
    return { status: 'written', version: after[0].version };
  });
}

// ---------------------------------------------------------------------------
// §4.6 reassignFigure — shared by the figures PATCH route and the agent tool.
// ---------------------------------------------------------------------------

export interface ReassignFigureParams extends BaseEditParams {
  blockId: string;
  assetId: string;
  attachedToIndex: string;
}

export type ReassignFigureStatus =
  | 'written'
  | 'skipped:not_draft'
  | 'skipped:block_not_found'
  | 'skipped:figure_not_found'
  | 'skipped:target_not_found';

export interface ReassignFigureResult {
  status: ReassignFigureStatus;
  figures?: FigureRefT[];
  version?: number;
}

/**
 * Core figure-reassignment mutation, owned here so both the PATCH route and the
 * `reassign_figure` DomainTool share one implementation (design note §4.6).
 *
 * The PATCH route (user-triggered) does NOT enforce a draft-status guard
 * (preserving existing behavior); the agent tool DOES (`enforceDraft: true`).
 * The route maps the discriminated result to HTTP errors; the tool maps it to
 * soft `skipped:*` Output.
 */
export async function reassignFigure(
  db: Db,
  params: ReassignFigureParams & { enforceDraft?: boolean },
): Promise<ReassignFigureResult> {
  return db.transaction(async (tx) => {
    const block = await loadBlockForUpdate(tx, params.blockId);
    if (!block) return { status: 'skipped:block_not_found' };
    if (params.enforceDraft && block.status !== 'draft') {
      return { status: 'skipped:not_draft' };
    }

    const figures = block.figures ?? [];
    const idx = figures.findIndex((f) => f.asset_id === params.assetId);
    if (idx < 0) return { status: 'skipped:figure_not_found' };

    const structured = block.structured;
    if (!structured || !idHasMatch(structured, params.attachedToIndex)) {
      return { status: 'skipped:target_not_found' };
    }

    const updatedFigures: FigureRefT[] = figures.map((f, i) =>
      i === idx
        ? {
            ...f,
            attached_to_index: params.attachedToIndex,
            attach_confidence: 'manual' as const,
            last_reassigned_at: new Date(),
          }
        : f,
    );

    const updated = await tx
      .update(question_block)
      .set({
        figures: updatedFigures,
        updated_at: new Date(),
        version: sql`${question_block.version} + 1`,
      })
      .where(eq(question_block.id, params.blockId))
      .returning({ version: question_block.version });

    await writeJobEvent(tx, {
      business_table: 'question_block',
      business_id: params.blockId,
      event_type: 'figure.reassigned',
      payload: { asset_id: params.assetId, attached_to_index: params.attachedToIndex },
    });

    return { status: 'written', figures: updatedFigures, version: updated[0].version };
  });
}
