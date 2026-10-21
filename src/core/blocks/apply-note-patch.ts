// Pure block-tree apply pipeline (no IO). Ops run left-to-right against doc-root
// children only; anchors are stable `attrs.id` strings. Persistence and the
// note_refine_apply event live in src/server/artifacts/note-refine-apply.ts.

import { ArtifactBodyBlocks, type ArtifactBodyBlocksT } from '../schema/business';
import type { NotePatchOpT, NotePatchT } from '../schema/note-patch';
import { isVerifiedBlock } from './is-verified-block';

export class NoteRefineApplyError extends Error {
  // Hard boundary: an AI mutator must never silently overwrite a human-verified
  // block. The job gate proposes instead; this throw is the cross-caller safety net.
  readonly code: 'target_not_found' | 'invalid_body_blocks' | 'user_verified_protected';
  constructor(
    code: 'target_not_found' | 'invalid_body_blocks' | 'user_verified_protected',
    message: string,
  ) {
    super(message);
    this.name = 'NoteRefineApplyError';
    this.code = code;
  }
}

export interface ApplyNotePatchOptions {
  // A human-approved accept path disables the guard: the human approved that exact
  // patch, so the AI-mutator protection must not reject it.
  enforceUserVerifiedGuard?: boolean;
}

export interface FilterMissingNotePatchTargetsResult {
  patch: NotePatchT;
  body_blocks: ArtifactBodyBlocksT;
  skipped_ops: number;
}

function cloneNode(node: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(node)) as Record<string, unknown>;
}

function blockIdOf(node: Record<string, unknown>): string | undefined {
  const attrs = node.attrs;
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) return undefined;
  const id = (attrs as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

export function applyNotePatch(
  bodyBlocks: unknown,
  patch: NotePatchT,
  options: ApplyNotePatchOptions = {},
): ArtifactBodyBlocksT {
  const enforceUserVerifiedGuard = options.enforceUserVerifiedGuard ?? true;
  const parsed = ArtifactBodyBlocks.safeParse(bodyBlocks);
  if (!parsed.success) {
    throw new NoteRefineApplyError(
      'invalid_body_blocks',
      `applyNotePatch: body_blocks invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  let content: Record<string, unknown>[] = (parsed.data.content ?? []).map((node) =>
    cloneNode(node as Record<string, unknown>),
  );

  for (const op of patch.ops) {
    content = applyOp(content, op, enforceUserVerifiedGuard);
  }

  return {
    ...parsed.data,
    content,
  };
}

/**
 * Pre-applies a patch one op at a time and removes only ops whose target is no longer present.
 * Later ops see the state produced by earlier accepted ops, so a patch may insert a block and then
 * target it. Errors other than target_not_found remain hard failures.
 */
export function filterMissingNotePatchTargets(
  bodyBlocks: unknown,
  patch: NotePatchT,
  options: ApplyNotePatchOptions = {},
): FilterMissingNotePatchTargetsResult {
  let nextBodyBlocks = applyNotePatch(bodyBlocks, { ops: [] }, options);
  const applicableOps: NotePatchOpT[] = [];
  let skippedOps = 0;

  for (const op of patch.ops) {
    try {
      nextBodyBlocks = applyNotePatch(nextBodyBlocks, { ops: [op] }, options);
      applicableOps.push(op);
    } catch (error) {
      if (error instanceof NoteRefineApplyError && error.code === 'target_not_found') {
        skippedOps += 1;
        continue;
      }
      throw error;
    }
  }

  return {
    patch: { ops: applicableOps },
    body_blocks: nextBodyBlocks,
    skipped_ops: skippedOps,
  };
}

function applyOp(
  content: Record<string, unknown>[],
  op: NotePatchOpT,
  enforceUserVerifiedGuard: boolean,
): Record<string, unknown>[] {
  switch (op.kind) {
    case 'insert_after': {
      // insert_after adds a sibling AFTER the target; it never touches the
      // target's content, so a verified target is fine (NARROW口径).
      const idx = content.findIndex((node) => blockIdOf(node) === op.target_block_id);
      if (idx === -1) {
        throw new NoteRefineApplyError(
          'target_not_found',
          `insert_after: target_block_id "${op.target_block_id}" not found in doc root`,
        );
      }
      return [
        ...content.slice(0, idx + 1),
        cloneNode(op.block as Record<string, unknown>),
        ...content.slice(idx + 1),
      ];
    }
    case 'replace_block': {
      const idx = content.findIndex((node) => blockIdOf(node) === op.target_block_id);
      if (idx === -1) {
        throw new NoteRefineApplyError(
          'target_not_found',
          `replace_block: target_block_id "${op.target_block_id}" not found in doc root`,
        );
      }
      if (enforceUserVerifiedGuard && isVerifiedBlock(content[idx])) {
        throw new NoteRefineApplyError(
          'user_verified_protected',
          `replace_block: target_block_id "${op.target_block_id}" is user-verified; AI must propose, not overwrite`,
        );
      }
      return [
        ...content.slice(0, idx),
        cloneNode(op.block as Record<string, unknown>),
        ...content.slice(idx + 1),
      ];
    }
    case 'delete_block': {
      const idx = content.findIndex((node) => blockIdOf(node) === op.target_block_id);
      if (idx === -1) {
        throw new NoteRefineApplyError(
          'target_not_found',
          `delete_block: target_block_id "${op.target_block_id}" not found in doc root`,
        );
      }
      if (enforceUserVerifiedGuard && isVerifiedBlock(content[idx])) {
        throw new NoteRefineApplyError(
          'user_verified_protected',
          `delete_block: target_block_id "${op.target_block_id}" is user-verified; AI must propose, not delete`,
        );
      }
      return [...content.slice(0, idx), ...content.slice(idx + 1)];
    }
    case 'append_block':
      return [...content, cloneNode(op.block as Record<string, unknown>)];
  }
}
