import { describe, expect, it } from 'vitest';

import {
  SLASH_MENU_ITEMS,
  type SlashInsertItem,
  filterSlashMenuItems,
} from './slash-command-items';
import { CALLOUT_BLOCK_NODE, SEMANTIC_BLOCK_NODE } from './types';

function insertItem(id: string): SlashInsertItem {
  const item = SLASH_MENU_ITEMS.find((i) => i.id === id);
  if (!item || item.kind !== 'insert') throw new Error(`no insert item ${id}`);
  return item;
}

describe('SLASH_MENU_ITEMS', () => {
  it('offers the five semantic kinds, a callout, and a cross_link delegate', () => {
    expect(SLASH_MENU_ITEMS.map((i) => i.id)).toEqual([
      'semantic:definition',
      'semantic:mechanism',
      'semantic:example',
      'semantic:pitfall',
      'semantic:check',
      'callout',
      'cross_link',
    ]);
    expect(SLASH_MENU_ITEMS.find((i) => i.id === 'cross_link')?.kind).toBe('cross_link');
  });
});

describe('slash insert builders', () => {
  it('builds a semanticBlock with the chosen kind and a fresh minted id', () => {
    const node = insertItem('semantic:example').build();
    expect(node.type).toBe(SEMANTIC_BLOCK_NODE);
    expect(node.attrs.semantic_kind).toBe('example');
    expect(node.attrs.version).toBe(0);
    expect(node.attrs.source_tier).toBe('llm_only');
    expect(typeof node.attrs.id).toBe('string');
    expect((node.attrs.id as string).length).toBeGreaterThan(0);
  });

  it('builds a calloutBlock with a fresh minted id', () => {
    const node = insertItem('callout').build();
    expect(node.type).toBe(CALLOUT_BLOCK_NODE);
    expect(node.attrs.tone).toBe('info');
    expect(typeof node.attrs.id).toBe('string');
  });

  it('mints a unique id on every build (insert never reuses an existing id)', () => {
    const a = insertItem('semantic:definition').build();
    const b = insertItem('semantic:definition').build();
    expect(a.attrs.id).not.toBe(b.attrs.id);
  });
});

describe('filterSlashMenuItems', () => {
  it('returns the full menu for an empty query', () => {
    expect(filterSlashMenuItems('')).toHaveLength(SLASH_MENU_ITEMS.length);
    expect(filterSlashMenuItems('   ')).toHaveLength(SLASH_MENU_ITEMS.length);
  });

  it('matches by keyword case-insensitively', () => {
    const callout = filterSlashMenuItems('CALL');
    expect(callout.map((i) => i.id)).toContain('callout');
    const link = filterSlashMenuItems('关联');
    expect(link.map((i) => i.id)).toContain('cross_link');
  });

  it('returns no items for a non-matching query', () => {
    expect(filterSlashMenuItems('zzz-nomatch')).toEqual([]);
  });
});
