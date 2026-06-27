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

import { newId } from '@/core/ids';
import type { QuestionKind } from '@/core/schema/business';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { question_block } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { writeJobEvent } from '@/server/events/writer';
// YUK-471 W3-C3 — the per-entity SoT-flip wiring for question_block. ON → the projection write-through
// is the row writer; OFF (default) → the imperative UPDATE stays the SoT + the parity assert catches
// fold↔row drift during the double-write phase. Gated on hasQuestionBlockGenesisAnchor (a pre-W3
// un-backfilled block folds to null → stays imperative; mirrors the W2 goal queries pattern).
import {
  assertQuestionBlockParity,
  hasQuestionBlockGenesisAnchor,
  questionBlockLiveRowToSnapshot,
} from '@/server/projections/parity';
import { projectQuestionBlockGuarded } from '@/server/projections/question_block';
import { writeQuestionBlockLifecycleEvent } from '@/server/projections/question_block-lifecycle-event';
import { projectionIsWriter } from '@/server/projections/sot-flag';

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
  | 'skipped:figure_not_found'
  | 'skipped:null_structured';

export interface EditResult {
  status: EditStatus;
  /** Set on `written`; the post-mutation version of the primary block. */
  version?: number;
}

export interface BaseEditParams {
  /** `callerActor.ref` of the tool caller, stamped as `last_modified_by`. */
  actorRef: string;
  /**
   * Provenance for the canonical `experimental:edit_question_block_structured` event (YUK-471 W3-C1δ).
   * These structured-edit primitives are agent-callable DomainTools (default 'agent'); the proposal
   * accept path (`acceptBlockMergeProposal`) is user-driven and passes 'user'. NOT a fold input — the
   * question_block fold does not read actor_kind — so this is pure provenance, never parity-affecting.
   */
  actorKind?: 'agent' | 'user';
}

// The 4 single-block structured-rewrite ops (merge_questions is multi-row, handled inline). The
// canonical edit event's `op` enum (question-block-events.ts) gates fold cardinality.
type SingleBlockEditOp = 'update_prompt' | 'add_option' | 'set_question_type' | 'split_stem';

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

interface PersistStructuredParams {
  blockId: string;
  /** The AFTER full structured tree (non-null — single-block edits always rewrite the tree). */
  structured: StructuredQuestionT;
  op: SingleBlockEditOp;
  /** Legacy `job_events` SSE transport payload ({ op, node_id, … }) — UNCHANGED (orthogonal). */
  jobPayload: Record<string, unknown>;
  actorRef: string;
  actorKind: 'agent' | 'user';
  /**
   * The block's CURRENT (unchanged) status. persistStructured writes structured/figures/version/
   * updated_at but NEVER status, so the canonical edit snapshot MUST carry the existing status or
   * the fold (which reads status off the primary snapshot) would diverge from the row (B2 review).
   */
  currentStatus: string;
  /**
   * The block's CURRENT version (read inside the same FOR-UPDATE-locked tx). The next version is
   * `currentVersion + 1`; with the row lock held no concurrent tx can bump it, so this equals the
   * old SQL-side `version + 1`. Threaded in (YUK-471 W3-C3) so the ON-path projection write-through
   * can stamp the version WITHOUT the imperative UPDATE's `.returning()`.
   */
  currentVersion: number;
  /** Present ONLY when the op also re-points figures (splitStem nested-stem reattach); else the fold
   *  falls back to row.figures (design §5.2), so the snapshot omits figures too. */
  figures?: FigureRefT[];
}

async function persistStructured(tx: Tx, params: PersistStructuredParams): Promise<number> {
  // SINGLE clock — the row's updated_at MUST equal the canonical event's created_at so the fold's
  // `updated_at = event.created_at` reproduces the row byte-for-byte (design §3 single-clock model).
  const now = new Date();
  // FOR-UPDATE-locked (loadBlockForUpdate) → no concurrent bump, so currentVersion + 1 equals the old
  // SQL-side `version + 1`. Computed here so the canonical event + the ON-path projection share it.
  const version = params.currentVersion + 1;

  // Legacy SSE/transport row — UNCHANGED (the `job_events` channel is orthogonal to the canonical log).
  await writeJobEvent(tx, {
    business_table: 'question_block',
    business_id: params.blockId,
    event_type: 'block.structured_edited',
    payload: params.jobPayload,
  });

  // YUK-471 W3-C1δ — canonical edit event (FIRST, before the row write, so the projection / parity
  // assert reads it). A single-block op carries EXACTLY the primary (role='primary') with the AFTER
  // tree + new version + the block's CURRENT status (B2). figures ride ONLY when re-pointed; else
  // omitted so the fold falls back to row.figures (§5.2). A malformed payload throws at parseEvent →
  // rolls back this tx.
  await writeEvent(tx, {
    id: newId(),
    actor_kind: params.actorKind,
    actor_ref: params.actorRef,
    action: 'experimental:edit_question_block_structured',
    subject_kind: 'question_block',
    subject_id: params.blockId,
    outcome: 'success',
    payload: {
      op: params.op,
      affected_blocks: [
        {
          block_id: params.blockId,
          role: 'primary',
          structured: params.structured,
          ...(params.figures !== undefined ? { figures: params.figures } : {}),
          version,
          status: params.currentStatus,
        },
      ],
    },
    created_at: now,
    ingest_at: now,
  });

  // YUK-471 W3-C3 — applicability gate (the edit event is NOT a question_block anchor, so before/after
  // is equivalent; a pre-W3 un-backfilled block folds null → must stay on the imperative path).
  const wasEventSourced = await hasQuestionBlockGenesisAnchor(tx, params.blockId);
  if (projectionIsWriter('question_block') && wasEventSourced) {
    // ON (W3-D flip) — the projection write-through is the SOLE row writer; the imperative UPDATE is
    // skipped. The canonical edit event above carries the AFTER tree + version + status, so
    // projectQuestionBlockGuarded re-folds the create/genesis base + this edit and upserts the row.
    await projectQuestionBlockGuarded(tx, params.blockId);
  } else {
    await tx
      .update(question_block)
      .set({
        structured: params.structured,
        ...(params.figures !== undefined ? { figures: params.figures } : {}),
        updated_at: now,
        version,
      })
      .where(eq(question_block.id, params.blockId));
    // OFF — assert fold == the row the imperative UPDATE just wrote (only when event-sourced; a pre-W3
    // block folds to null and would false-mismatch). dev/test THROW on drift, prod warn (file header).
    if (wasEventSourced) {
      const [written] = await tx
        .select()
        .from(question_block)
        .where(eq(question_block.id, params.blockId))
        .limit(1);
      await assertQuestionBlockParity(
        tx,
        params.blockId,
        written ? questionBlockLiveRowToSnapshot(written) : null,
      );
    }
  }

  return version;
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

    const version = await persistStructured(tx, {
      blockId: params.blockId,
      structured: tree,
      op: 'update_prompt',
      jobPayload: { op: 'update_prompt', node_id: params.nodeId },
      actorRef: params.actorRef,
      actorKind: params.actorKind ?? 'agent',
      currentStatus: block.status,
      currentVersion: block.version,
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

    const version = await persistStructured(tx, {
      blockId: params.blockId,
      structured: tree,
      op: 'add_option',
      jobPayload: { op: 'add_option', node_id: params.nodeId },
      actorRef: params.actorRef,
      actorKind: params.actorKind ?? 'agent',
      currentStatus: block.status,
      currentVersion: block.version,
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

    const version = await persistStructured(tx, {
      blockId: params.blockId,
      structured: tree,
      op: 'set_question_type',
      jobPayload: { op: 'set_question_type', node_id: params.nodeId, kind: params.kind },
      actorRef: params.actorRef,
      actorKind: params.actorKind ?? 'agent',
      currentStatus: block.status,
      currentVersion: block.version,
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
 * Returns `{ tree, outcome, reattachFrom?, reattachTo? }` where outcome is
 * `split | not_found | not_splittable`. On the NESTED-stem split branch the
 * stem node is spliced out and its id disappears, so any figure that was
 * `attached_to_index === <stem id>` would dangle. We surface `reattachFrom`
 * (the vanished stem id) + `reattachTo` (the first promoted child id) so the
 * caller can re-point those figures (root-stem split keeps the id via the shell,
 * so it returns no reattach).
 */
function splitStemInTree(
  node: StructuredQuestionT,
  target: string,
  actorRef: string,
): {
  tree: StructuredQuestionT;
  outcome: 'split' | 'not_found' | 'not_splittable';
  reattachFrom?: string;
  reattachTo?: string;
} {
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
    // Root-stem keeps its id via the shell — no figure reattachment needed.
    return { tree: shell, outcome: 'split' };
  }

  let outcome: 'split' | 'not_found' | 'not_splittable' = 'not_found';
  let reattachFrom: string | undefined;
  let reattachTo: string | undefined;
  const nextSubs: StructuredQuestionT[] = [];
  for (const sub of node.sub_questions ?? []) {
    if (sub.id === target) {
      if (!isSplittableStem(sub)) {
        nextSubs.push(sub);
        outcome = 'not_splittable';
      } else {
        const promoted = promoteSubsToStandalone(sub, actorRef);
        nextSubs.push(...promoted);
        outcome = 'split';
        // Nested stem id vanishes on splice; re-point its figures to the first
        // promoted child so they don't dangle.
        reattachFrom = sub.id;
        reattachTo = promoted[0]?.id;
      }
      continue;
    }
    const res = splitStemInTree(sub, target, actorRef);
    nextSubs.push(res.tree);
    if (res.outcome === 'split') outcome = 'split';
    else if (res.outcome === 'not_splittable' && outcome === 'not_found') {
      outcome = 'not_splittable';
    }
    if (res.reattachFrom) {
      reattachFrom = res.reattachFrom;
      reattachTo = res.reattachTo;
    }
  }
  const clone: StructuredQuestionT = {
    ...node,
    sub_questions: node.sub_questions ? nextSubs : undefined,
  };
  return { tree: clone, outcome, reattachFrom, reattachTo };
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

    // Nested-stem split removes the stem id from the tree; re-point any figure
    // that was attached to it onto the first promoted child so it doesn't
    // dangle. Root-stem split keeps the id (shell), so reattachFrom is unset.
    let nextFigures: FigureRefT[] | undefined;
    if (result.reattachFrom && result.reattachTo) {
      const from = result.reattachFrom;
      const to = result.reattachTo;
      nextFigures = (block.figures ?? []).map((f) =>
        f.attached_to_index === from ? { ...f, attached_to_index: to } : f,
      );
    }

    const version = await persistStructured(tx, {
      blockId: params.blockId,
      structured: result.tree,
      op: 'split_stem',
      jobPayload: { op: 'split_stem', node_id: params.nodeId },
      actorRef: params.actorRef,
      actorKind: params.actorKind ?? 'agent',
      currentStatus: block.status,
      currentVersion: block.version,
      figures: nextFigures,
    });
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

    // Dedupe + drop the primary itself: a caller passing [m1, m1] or the primary
    // id must not inflate merged_from_block_ids or trip the length check below.
    const mergeIds = [...new Set(params.mergeBlockIds)].filter(
      (id) => id !== params.primaryBlockId,
    );
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
    // A null-structured block carries only legacy extracted_prompt_md, which has
    // no top-level node to absorb. Merging it would silently drop that content
    // while still marking the block ignored — refuse instead of losing it.
    if (!primary.structured) return { status: 'skipped:null_structured' };
    if (mergeBlocks.some((b) => b.structured === null)) {
      return { status: 'skipped:null_structured' };
    }

    // Absorb each merge block's top-level structured nodes into the primary as
    // appended sub_questions. The primary becomes a stem container holding all
    // nodes (its own + absorbed), preserving order. Provenance on the primary.
    const primaryNodes = topLevelNodes(primary.structured);
    // Iterate in caller-supplied `mergeIds` order (not the unordered `inArray`
    // SELECT result) so absorbed sub-question order is deterministic — §4.5
    // "appended ... preserving order".
    const blocksById = new Map(mergeBlocks.map((b) => [b.id, b]));
    const absorbed: StructuredQuestionT[] = [];
    for (const id of mergeIds) {
      const mb = blocksById.get(id);
      if (!mb) continue; // unreachable: length check above guarantees presence
      for (const node of topLevelNodes(mb.structured)) {
        // A merged block whose root is a stem (with sub_questions) must stay a
        // nested stem: forcing role='sub' onto a node that still carries
        // sub_questions produces an ILLEGAL StructuredQuestion (the refine bars
        // non-stems from holding subs) and structuredToPromptMarkdown would
        // render it as a leaf, silently dropping the sub-questions. Nested stems
        // are schema-legal; keep the whole subtree intact via structuredClone.
        const isStem = node.role === 'stem' && (node.sub_questions?.length ?? 0) > 0;
        const clone: StructuredQuestionT = isStem
          ? structuredClone(node)
          : { ...node, role: 'sub', sub_questions: undefined };
        // Stamp provenance only on the absorbed top node (subs keep their own).
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

    // Carry the merged blocks' figures onto the primary (union, in mergeIds
    // order). Absorbed subtrees keep every node id, so each figure's
    // attached_to_index still resolves inside the merged tree. Dedup by
    // asset_id (keep first): the same cropped asset could be attached to both
    // the primary and a merge block; reassignFigure / the PATCH route resolve a
    // figure by first asset_id match, so a duplicate would shadow later updates
    // and double-render in the review UI.
    const seenAssetIds = new Set<string>();
    const mergedFigures: FigureRefT[] = [
      ...(primary.figures ?? []),
      ...mergeIds.flatMap((id) => blocksById.get(id)?.figures ?? []),
    ].filter((f) => !seenAssetIds.has(f.asset_id) && seenAssetIds.add(f.asset_id));

    // F3 (YUK-471 W3 §3) — SINGLE clock for the primary UPDATE, the merged-blocks UPDATE, AND the
    // canonical event, so the fold's single-clock holds (the absorbed blocks + the primary all stamp
    // updated_at = event.created_at). Historically this used TWO independent `new Date()` (~:506/:513).
    const now = new Date();
    const [{ version: primaryVersion }] = await tx
      .update(question_block)
      .set({
        structured: mergedTree,
        figures: mergedFigures,
        merged_from_block_ids: [...(primary.merged_from_block_ids ?? []), ...mergeIds],
        updated_at: now,
        version: sql`${question_block.version} + 1`,
      })
      .where(eq(question_block.id, params.primaryBlockId))
      .returning({ version: question_block.version });

    await tx
      .update(question_block)
      .set({ status: 'ignored', updated_at: now })
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

    // YUK-471 W3-C1δ — ONE canonical edit event collapses the 1+N `job_events` transport rows (solves
    // C4). The primary (role='primary') carries the merged AFTER tree + figures + bumped version + its
    // CURRENT (unchanged) status; each absorbed block rides as role='merged_source' with status
    // 'ignored' and its UNCHANGED version (the live writer does NOT bump it) + its before-tree (undo).
    // subject_id = primary (the SoT anchor). The merged_source order = mergeIds order, so the fold
    // appends EXACTLY the live writer's merged_from_block_ids ([...primary.merged_from, ...mergeIds]).
    const mergedSourceEntries = mergeIds.map((id) => {
      const mb = blocksById.get(id);
      if (!mb) {
        // unreachable: the mergeBlocks.length === mergeIds.length check above guarantees presence.
        throw new Error(`mergeQuestions: merge block ${id} vanished before snapshot`);
      }
      return {
        block_id: id,
        role: 'merged_source' as const,
        structured: mb.structured,
        version: mb.version,
        status: 'ignored',
      };
    });
    await writeEvent(tx, {
      id: newId(),
      actor_kind: params.actorKind ?? 'agent',
      actor_ref: params.actorRef,
      action: 'experimental:edit_question_block_structured',
      subject_kind: 'question_block',
      subject_id: params.primaryBlockId,
      outcome: 'success',
      payload: {
        op: 'merge_questions',
        affected_blocks: [
          {
            block_id: params.primaryBlockId,
            role: 'primary',
            structured: mergedTree,
            figures: mergedFigures,
            version: primaryVersion,
            status: primary.status,
          },
          ...mergedSourceEntries,
        ],
      },
      created_at: now,
      ingest_at: now,
    });

    return { status: 'written', version: primaryVersion };
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

    // SINGLE clock (YUK-471 W3-D §3): one `now` stamps the figure's last_reassigned_at, the row's
    // updated_at, AND the canonical lifecycle event's created_at — so the carried figures array (which
    // embeds last_reassigned_at) matches between row and event, and the fold's updated_at = the event
    // time equals the row's updated_at (byte-exact parity).
    const now = new Date();
    const updatedFigures: FigureRefT[] = figures.map((f, i) =>
      i === idx
        ? {
            ...f,
            attached_to_index: params.attachedToIndex,
            attach_confidence: 'manual' as const,
            last_reassigned_at: now,
          }
        : f,
    );

    const updated = await tx
      .update(question_block)
      .set({
        figures: updatedFigures,
        updated_at: now,
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

    // YUK-471 W3-D — make the figure re-point fold-visible: ONE canonical lifecycle event carries the
    // FULL re-pointed figures array + bumped version (additive double-write; `writeJobEvent` above is
    // the orthogonal SSE transport, left untouched). subject_id = the block (the SoT anchor).
    await writeQuestionBlockLifecycleEvent(tx, {
      blockId: params.blockId,
      op: 'reassign_figures',
      figures: updatedFigures,
      nextVersion: updated[0].version,
      actorKind: params.actorKind ?? 'agent',
      actorRef: params.actorRef,
      now,
    });

    return { status: 'written', figures: updatedFigures, version: updated[0].version };
  });
}
