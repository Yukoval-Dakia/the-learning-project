// YUK-127 / T-88 P4-A — pure block-tree apply pipeline for NotePatchOp.
//
// Lives in `core/` (no IO, cross-subject) so unit tests don't drag the DB
// chain in. The DB-touching wrapper that persists the result + writes an
// `experimental:note_refine_apply` event is in
// `src/server/artifacts/note-refine-apply.ts`.
//
// Apply semantics (ADR-0020 §1, §2):
//   - Ops execute left-to-right against doc-root children only (no recursion
//     into nested block content; nested mutation is a future concern).
//   - Anchors are `attrs.id` strings — stable per ADR-0020 §2 block_id rules.
//   - insert_after  → splice after target
//   - replace_block → overwrite target in place (schema enforces id stability)
//   - delete_block  → remove target (annotations on the block are lost,
//                     accepted tradeoff per ADR-0020 §2)
//   - append_block  → push to doc-root tail
//   - Missing targets throw NoteRefineApplyError(code='target_not_found');
//     invalid input doc throws code='invalid_body_blocks'. Callers decide
//     whether to retract the AI run or surface to the user.

import { ArtifactBodyBlocks, type ArtifactBodyBlocksT } from '../schema/business';
import type { NotePatchOpT, NotePatchT } from '../schema/note-patch';
import { isVerifiedBlock } from './is-verified-block';

export class NoteRefineApplyError extends Error {
  // C1a (YUK-358, ADR-0040 决定1): `user_verified_protected` is the hard
  // boundary — a replace_block/delete_block op targeting a user-verified block
  // is rejected so an AI mutator can never silently overwrite a block the human
  // owns. The job-gate (note-refine.ts) is the primary diversion to propose;
  // this throw is the cross-caller safety net for callers that bypass the gate
  // (hub_auto_sync_nightly, presence-store apply).
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
  // C1a (YUK-358): when true (default), replace_block/delete_block ops targeting
  // a user-verified block throw `user_verified_protected`. The accept-path
  // (acceptNoteUpdateProposal → persistNoteRefineApply actorRef
  // 'note_refine_accept') sets this false: a HUMAN approved that exact patch
  // through the inbox, so the AI-mutator guard must NOT kill it.
  enforceUserVerifiedGuard?: boolean;
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

// YUK-358 决定7 rider-1: isVerifiedBlock now lives in ./is-verified-block so the
// apply guard and the job-gate (note-refine-policy.ts) share ONE口径. The inline
// copy was extracted byte-equivalent — semantics here are unchanged.

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
