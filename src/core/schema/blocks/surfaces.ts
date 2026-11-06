// YUK-1548 (§2.1) — per-surface block allowlists. The surface is decided on
// the server from the caller, never from tool input.

import type { BlockKind } from './block';

export type BlockSurface = 'chat' | 'note' | 'question_material';

export const BLOCK_SURFACE_KINDS: Record<BlockSurface, readonly BlockKind[]> = {
  chat: ['diagram', 'figure', 'chart', 'interactive', 'question_ref'],
  note: ['diagram', 'figure', 'chart', 'interactive', 'question_ref'],
  // Never interactive or question_ref on a frozen question surface.
  question_material: ['diagram', 'figure', 'chart'],
};

/** Kinds whose compose path exists in this build (slice 1). */
export const BLOCK_IMPLEMENTED_KINDS: readonly BlockKind[] = ['diagram', 'figure', 'question_ref'];
