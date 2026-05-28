// YUK-127 / T-88 P4-A — Block-level patch op schema for Living Note v0.
//
// Defines the discriminated union of patch operations that NoteRefineTask
// produces and that the apply pipeline executes against an artifact's
// `body_blocks` TipTap doc (ADR-0020 §1).
//
// Op anchors live on `target_block_id` (stable per ADR-0020 §2 block_id rules).
// `append_block` has no anchor because it always appends to the doc root tail.
//
// The shape is intentionally derivable: P4-B (mutator vs propose gating)
// reads `ops.length` + the count of ops that introduce new blocks to apply the
// locked threshold `≤3 patch ops AND ≤2 new blocks → mutator; else propose`.
// `countNewBlocks` + `summarizeNotePatch` expose those counts so callers
// don't have to re-derive the rule. P4-B owns the gating call site; this
// lane only defines the shape and the counters.

import { z } from 'zod';
import { TipTapNodeJson } from './business';

// A single block payload — same TipTap PM node JSON that lives in
// ArtifactBodyBlocks.content. Patch ops that introduce a block (insert_after,
// replace_block, append_block) carry one; delete_block carries none.
export const NotePatchBlock = TipTapNodeJson;
export type NotePatchBlockT = z.infer<typeof NotePatchBlock>;

// insert_after — splice `block` immediately after the doc-root child with
// `attrs.id === target_block_id`. New block (counts toward mutator threshold).
export const NotePatchInsertAfter = z.object({
  kind: z.literal('insert_after'),
  target_block_id: z.string().min(1),
  block: NotePatchBlock,
});
export type NotePatchInsertAfterT = z.infer<typeof NotePatchInsertAfter>;

// replace_block — overwrite the doc-root child with `attrs.id ===
// target_block_id`. Replacement keeps block_id stability per ADR-0020 §2
// in-place edit: callers MUST keep `block.attrs.id === target_block_id`.
// Net new-block delta is 0 — does NOT count toward mutator threshold.
//
// The id-equals-target invariant is enforced in `NotePatchOp` below via
// superRefine — we keep this schema a plain ZodObject so it can sit inside
// `z.discriminatedUnion('kind', ...)` (which rejects ZodEffects branches).
export const NotePatchReplaceBlock = z.object({
  kind: z.literal('replace_block'),
  target_block_id: z.string().min(1),
  block: NotePatchBlock,
});
export type NotePatchReplaceBlockT = z.infer<typeof NotePatchReplaceBlock>;

// delete_block — remove the doc-root child with `attrs.id === target_block_id`.
// Annotations on the deleted block are lost (accepted tradeoff per ADR-0020 §2).
export const NotePatchDeleteBlock = z.object({
  kind: z.literal('delete_block'),
  target_block_id: z.string().min(1),
});
export type NotePatchDeleteBlockT = z.infer<typeof NotePatchDeleteBlock>;

// append_block — append `block` to the doc-root tail. No anchor.
// New block (counts toward mutator threshold).
export const NotePatchAppendBlock = z.object({
  kind: z.literal('append_block'),
  block: NotePatchBlock,
});
export type NotePatchAppendBlockT = z.infer<typeof NotePatchAppendBlock>;

// NotePatchOp — discriminated union over the 4 op kinds.
//
// The `replace_block` id-stability rule (block.attrs.id === target_block_id)
// is enforced here because the inner schema must be a plain ZodObject for the
// discriminator to work; superRefine wraps the union itself.
export const NotePatchOp = z
  .discriminatedUnion('kind', [
    NotePatchInsertAfter,
    NotePatchReplaceBlock,
    NotePatchDeleteBlock,
    NotePatchAppendBlock,
  ])
  .superRefine((op, ctx) => {
    if (op.kind !== 'replace_block') return;
    const attrs = op.block.attrs;
    const blockId =
      attrs && typeof attrs === 'object' && !Array.isArray(attrs)
        ? (attrs as Record<string, unknown>).id
        : undefined;
    if (typeof blockId !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'replace_block.block.attrs.id must be present (string)',
        path: ['block', 'attrs', 'id'],
      });
      return;
    }
    if (blockId !== op.target_block_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'replace_block.block.attrs.id must equal target_block_id (ADR-0020 §2 block_id stability)',
        path: ['block', 'attrs', 'id'],
      });
    }
  });
export type NotePatchOpT = z.infer<typeof NotePatchOp>;

// NotePatch — ordered list of ops applied left-to-right. Empty patch is legal
// (apply is a no-op, no event written). Upper bound is loose at the schema
// level (200) so a wild AI run doesn't OOM the apply pipeline; the mutator
// threshold is enforced at a different gate (P4-B).
export const NotePatch = z.object({
  ops: z.array(NotePatchOp).max(200),
});
export type NotePatchT = z.infer<typeof NotePatch>;

// ---------- Derived counts ----------
//
// Exposed so P4-B can apply the locked mutator threshold without
// re-implementing op-kind awareness. Locked threshold (see
// `docs/superpowers/plans/2026-05-29-wave6-ready-to-launch.md` §Human
// decision points): `≤3 patch ops AND ≤2 new blocks → mutator; else
// propose`. The thresholds themselves live with the gating code (P4-B),
// not here.

const NEW_BLOCK_OP_KINDS = new Set<NotePatchOpT['kind']>(['insert_after', 'append_block']);

export function countNewBlocks(patch: NotePatchT): number {
  return patch.ops.filter((op) => NEW_BLOCK_OP_KINDS.has(op.kind)).length;
}

export interface NotePatchSummary {
  ops_count: number;
  new_blocks: number;
}

export function summarizeNotePatch(patch: NotePatchT): NotePatchSummary {
  return {
    ops_count: patch.ops.length,
    new_blocks: countNewBlocks(patch),
  };
}
