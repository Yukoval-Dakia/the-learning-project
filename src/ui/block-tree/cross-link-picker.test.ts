import { describe, expect, it } from 'vitest';

import {
  type ArtifactSearchResult,
  type CrossLinkPickerItem,
  buildCrossLinkInsertContent,
  mapSearchResultsToPickerItems,
} from './cross-link-picker';
import { CROSS_LINK_BLOCK_NODE } from './types';

describe('mapSearchResultsToPickerItems', () => {
  it('maps rows → picker items preserving artifact_id/title/type', () => {
    const rows: ArtifactSearchResult[] = [
      { id: 'art_1', title: '论语·学而', type: 'note_atomic' },
      { id: 'art_2', title: '中庸', type: 'note_hub' },
    ];
    expect(mapSearchResultsToPickerItems(rows)).toEqual([
      { artifact_id: 'art_1', title: '论语·学而', type: 'note_atomic' },
      { artifact_id: 'art_2', title: '中庸', type: 'note_hub' },
    ]);
  });

  it('falls back to id when the title is blank', () => {
    const rows: ArtifactSearchResult[] = [{ id: 'art_3', title: '   ', type: 'note_long' }];
    expect(mapSearchResultsToPickerItems(rows)[0]).toMatchObject({
      artifact_id: 'art_3',
      title: 'art_3',
    });
  });

  it('drops rows without an id', () => {
    const rows = [
      { id: '', title: '坏行', type: 'note_atomic' },
      { id: 'art_4', title: '好行', type: 'note_atomic' },
    ] as ArtifactSearchResult[];
    const items = mapSearchResultsToPickerItems(rows);
    expect(items).toHaveLength(1);
    expect(items[0].artifact_id).toBe('art_4');
  });
});

describe('buildCrossLinkInsertContent', () => {
  const item: CrossLinkPickerItem = {
    artifact_id: 'art_99',
    title: '目标笔记',
    type: 'note_atomic',
  };

  it('builds a crossLinkBlock node with FLAT attrs (ADR-0022 / D3)', () => {
    const node = buildCrossLinkInsertContent(item, { id: 'fixed_id' });
    expect(node.type).toBe(CROSS_LINK_BLOCK_NODE);
    // Flat: artifact_id + title at the top of attrs, NOT nested under cross_link.
    expect(node.attrs).toEqual({
      id: 'fixed_id',
      artifact_id: 'art_99',
      title: '目标笔记',
    });
    expect((node.attrs as unknown as Record<string, unknown>).cross_link).toBeUndefined();
  });

  it('mints a fresh block id when none is supplied', () => {
    const a = buildCrossLinkInsertContent(item);
    const b = buildCrossLinkInsertContent(item);
    expect(a.attrs.id).toBeTruthy();
    expect(a.attrs.id).not.toBe(b.attrs.id);
  });

  it('includes block_id only when a block-level target is supplied', () => {
    expect(buildCrossLinkInsertContent(item).attrs.block_id).toBeUndefined();
    expect(buildCrossLinkInsertContent(item, { blockId: 'blk_7' }).attrs.block_id).toBe('blk_7');
  });
});
