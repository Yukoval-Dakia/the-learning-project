// YUK-150 P2-polish — pure, IO-free registry for the `/` slash-command block
// insert menu. Kept framework-free so it unit-tests without a running TipTap
// editor (mirrors cross-link-picker.ts).
//
// Each item builds a block-level node to insert. New blocks mint a fresh
// `attrs.id` via `newId()` (cuid2) exactly like buildCrossLinkInsertContent —
// inserting never touches an existing block's id (ADR-0022: block ids are
// stable semantic anchors). The `cross_link` item is special: rather than
// inserting an unanchored placeholder, it re-triggers the existing `@`
// cross_link picker (CrossLinkSuggestion, P5-A), so this registry marks it
// `kind: 'cross_link'` and the extension handles it without building a node.

import { newId } from '@/core/ids';
import {
  CALLOUT_BLOCK_NODE,
  SEMANTIC_BLOCK_NODE,
  SEMANTIC_KIND_LABEL,
  type SemanticKind,
} from './types';

/** A node-inserting menu item builds block JSON to insert at the trigger range. */
export interface SlashInsertItem {
  kind: 'insert';
  /** Stable key for keyboard/click handling + React list keys. */
  id: string;
  /** Menu label (zh). */
  label: string;
  /** Keywords matched against the typed query (lowercased). */
  keywords: string[];
  /** Builds a fresh block node (mints a new block id) to insert. */
  build: () => BlockInsertContent;
}

/** A delegate menu item hands off to another flow instead of inserting JSON. */
export interface SlashDelegateItem {
  kind: 'cross_link';
  id: string;
  label: string;
  keywords: string[];
}

export type SlashMenuItem = SlashInsertItem | SlashDelegateItem;

/** Minimal TipTap/ProseMirror JSON for a block node the slash menu inserts. */
export interface BlockInsertContent {
  type: string;
  attrs: Record<string, unknown>;
  content?: Array<{ type: string; content?: unknown[] }>;
}

const DEFAULT_SOURCE_TIER = 'llm_only';

function emptyParagraph(): { type: 'paragraph' } {
  return { type: 'paragraph' };
}

function buildSemanticBlock(kind: SemanticKind): BlockInsertContent {
  return {
    type: SEMANTIC_BLOCK_NODE,
    attrs: {
      id: newId(),
      semantic_kind: kind,
      source_tier: DEFAULT_SOURCE_TIER,
      user_verified: false,
      embedded_check: null,
      version: 0,
    },
    content: [emptyParagraph()],
  };
}

function buildCalloutBlock(): BlockInsertContent {
  return {
    type: CALLOUT_BLOCK_NODE,
    attrs: { id: newId(), tone: 'info', title: null },
    content: [emptyParagraph()],
  };
}

/**
 * The full slash menu, in display order: five semantic kinds, a callout, and a
 * cross_link delegate. Pure — `build()` mints a fresh id on each call.
 */
export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  ...(Object.keys(SEMANTIC_KIND_LABEL) as SemanticKind[]).map(
    (kind): SlashInsertItem => ({
      kind: 'insert',
      id: `semantic:${kind}`,
      label: SEMANTIC_KIND_LABEL[kind],
      keywords: [kind, SEMANTIC_KIND_LABEL[kind], 'block', 'semantic'],
      build: () => buildSemanticBlock(kind),
    }),
  ),
  {
    kind: 'insert',
    id: 'callout',
    label: '提示框 callout',
    keywords: ['callout', '提示', '提示框', 'note'],
    build: buildCalloutBlock,
  },
  {
    kind: 'cross_link',
    id: 'cross_link',
    label: '关联笔记 cross_link',
    keywords: ['cross_link', 'crosslink', '链接', '关联', 'link', '@'],
  },
];

/**
 * Filter the menu by a typed query (the text after `/`). Empty query returns
 * the full menu; otherwise matches the label or any keyword case-insensitively.
 */
export function filterSlashMenuItems(query: string): SlashMenuItem[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return SLASH_MENU_ITEMS;
  return SLASH_MENU_ITEMS.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      item.keywords.some((kw) => kw.toLowerCase().includes(q)),
  );
}
