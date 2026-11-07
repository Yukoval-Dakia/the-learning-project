// YUK-1548 (§2.1) — per-surface block allowlists. The surface is decided on
// the server from the caller, never from tool input.

import type { BlockKind } from './block';

export type BlockSurface = 'chat' | 'note' | 'question_material';

export const BLOCK_SURFACE_KINDS: Record<BlockSurface, readonly BlockKind[]> = {
  chat: [
    'diagram',
    'figure',
    'chart',
    'plot',
    'interactive',
    'question_ref',
    'entity_card',
    'drawing',
  ],
  note: ['diagram', 'figure', 'chart', 'plot', 'interactive', 'question_ref'],
  // Never interactive, question_ref or entity_card on a frozen question surface.
  question_material: ['diagram', 'figure', 'chart', 'plot'],
};

/** Kinds whose compose path exists in this build (slice 1). */
export const BLOCK_IMPLEMENTED_KINDS: readonly BlockKind[] = [
  'diagram',
  'figure',
  'chart',
  'plot',
  'question_ref',
  'entity_card',
];
