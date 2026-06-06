import { describe, expect, it } from 'vitest';
import {
  SourceRefKind,
  WebSourcedProvenance,
  compareBySourceTierThenWhitelist,
  deriveSourceTier,
} from './provenance';

// ---------- 合约一：WebSourcedProvenance ----------

const validWebSourced = {
  url: 'https://example.edu/exam/2024-gaokao',
  title: '2024 高考语文真题',
  fetched_at: '2026-06-05T10:00:00Z',
  whitelist_match: true,
  extraction_hash: 'abc123',
  extract: '阅读下面的文言文，完成各题。',
};

describe('WebSourcedProvenance', () => {
  it('parses a valid block', () => {
    const parsed = WebSourcedProvenance.parse(validWebSourced);
    expect(parsed.whitelist_match).toBe(true);
    expect(parsed.url).toContain('example.edu');
  });

  it('allows extraction_hash to be omitted', () => {
    const { extraction_hash: _drop, ...rest } = validWebSourced;
    expect(() => WebSourcedProvenance.parse(rest)).not.toThrow();
  });

  it('rejects a non-URL url', () => {
    expect(() => WebSourcedProvenance.parse({ ...validWebSourced, url: 'not-a-url' })).toThrow();
  });

  it('rejects an empty title', () => {
    expect(() => WebSourcedProvenance.parse({ ...validWebSourced, title: '' })).toThrow();
  });

  it('rejects an empty fetched_at', () => {
    expect(() => WebSourcedProvenance.parse({ ...validWebSourced, fetched_at: '' })).toThrow();
  });

  it('requires whitelist_match (OF-2 demotion field)', () => {
    const { whitelist_match: _drop, ...rest } = validWebSourced;
    expect(() => WebSourcedProvenance.parse(rest)).toThrow();
  });

  it('accepts whitelist_match=false (off-whitelist, demoted not rejected)', () => {
    const parsed = WebSourcedProvenance.parse({ ...validWebSourced, whitelist_match: false });
    expect(parsed.whitelist_match).toBe(false);
  });

  it('requires a non-empty extract (F2 — deterministic grounding anchor)', () => {
    const { extract: _drop, ...rest } = validWebSourced;
    expect(() => WebSourcedProvenance.parse(rest)).toThrow();
    expect(() => WebSourcedProvenance.parse({ ...validWebSourced, extract: '' })).toThrow();
  });
});

// ---------- 合约三：SourceRefKind ----------

describe('SourceRefKind', () => {
  it('includes the four disambiguation kinds', () => {
    expect(SourceRefKind.options).toEqual([
      'trigger_ptr',
      'url',
      'ingestion_session',
      'source_document',
    ]);
  });

  it('rejects an unknown kind', () => {
    expect(() => SourceRefKind.parse('mystery')).toThrow();
  });
});

// ---------- deriveSourceTier — four-tier matrix + mix-layer defence ----------

describe('deriveSourceTier', () => {
  it('tier 1 authentic — ingestion_session_id present (ignores source value)', () => {
    // source is an ingestion ENTRYPOINT (vision_paper), not a tier marker — tier 1
    // is keyed solely off metadata.ingestion_session_id.
    const result = deriveSourceTier({
      source: 'vision_paper',
      metadata: {
        ingestion_session_id: 'sess_123',
        source_document_id: 'doc_1',
        question_block_id: 'blk_1',
      },
    });
    expect(result).toEqual({ tier: 1, name: 'authentic' });
  });

  it('tier 1 — even when source is some other entrypoint', () => {
    const result = deriveSourceTier({
      source: 'vision_single',
      metadata: { ingestion_session_id: 'sess_x' },
    });
    expect(result.tier).toBe(1);
  });

  it('tier 2 sourced — web_sourced source + valid web_sourced provenance + source_ref_kind=url', () => {
    const result = deriveSourceTier({
      source: 'web_sourced',
      metadata: { web_sourced: validWebSourced, source_ref_kind: 'url' },
    });
    expect(result).toEqual({ tier: 2, name: 'sourced' });
  });

  it('tier 2 — off-whitelist (whitelist_match=false) still tier 2 (demotion is a sort concern)', () => {
    const result = deriveSourceTier({
      source: 'web_sourced',
      metadata: {
        web_sourced: { ...validWebSourced, whitelist_match: false },
        source_ref_kind: 'url',
      },
    });
    expect(result.tier).toBe(2);
  });

  it('web_sourced source but MALFORMED provenance falls through to tier 4', () => {
    // source says web_sourced but the provenance block is not parseable → not tier 2.
    const result = deriveSourceTier({
      source: 'web_sourced',
      metadata: { web_sourced: { url: 'not-a-url' }, source_ref_kind: 'url' },
    });
    expect(result.tier).toBe(4);
  });

  it('web_sourced source WITHOUT top-level source_ref_kind is NOT tier 2 (合约三 discriminator required)', () => {
    // valid web_sourced block but missing the disambiguation discriminator → must not
    // bypass 合约三; falls through to tier 4.
    const result = deriveSourceTier({
      source: 'web_sourced',
      metadata: { web_sourced: validWebSourced },
    });
    expect(result.tier).toBe(4);
  });

  it('web_sourced source with a NON-url source_ref_kind is NOT tier 2', () => {
    const result = deriveSourceTier({
      source: 'web_sourced',
      metadata: { web_sourced: validWebSourced, source_ref_kind: 'trigger_ptr' },
    });
    expect(result.tier).toBe(4);
  });

  it('tier 3 material — quiz_gen + material_grounded + material_source_document_id', () => {
    const result = deriveSourceTier({
      source: 'quiz_gen',
      metadata: {
        quiz_gen: {
          generation_method: 'material_grounded',
          material_source_document_id: 'doc_passage_1',
        },
      },
    });
    expect(result).toEqual({ tier: 3, name: 'material' });
  });

  it('quiz_gen material_grounded WITHOUT material_source_document_id is NOT tier 3 (falls to tier 4)', () => {
    const result = deriveSourceTier({
      source: 'quiz_gen',
      metadata: { quiz_gen: { generation_method: 'material_grounded' } },
    });
    expect(result.tier).toBe(4);
  });

  it('tier 4 generated — quiz_gen search_grounded', () => {
    const result = deriveSourceTier({
      source: 'quiz_gen',
      metadata: { quiz_gen: { generation_method: 'search_grounded' } },
    });
    expect(result).toEqual({ tier: 4, name: 'generated' });
  });

  it('tier 4 generated — quiz_gen closed_book', () => {
    const result = deriveSourceTier({
      source: 'quiz_gen',
      metadata: { quiz_gen: { generation_method: 'closed_book' } },
    });
    expect(result.tier).toBe(4);
  });

  it('tier 4 generated — variant_gen', () => {
    const result = deriveSourceTier({ source: 'mistake_variant', metadata: {} });
    expect(result.tier).toBe(4);
  });

  // ----- MIX-LAYER DEFENCE (plan §0 实证1 / R1) -----
  // Real write path: embedded_check_generate.ts:237 inserts source='embedded' and
  // does NOT set metadata at all (column default → null). A non-ingestion question
  // sitting in the `question` table must NOT be misread as tier 1.
  it('mix-layer defence — embedded question (source=embedded, metadata null) → tier 4 NOT tier 1', () => {
    const result = deriveSourceTier({ source: 'embedded', metadata: null });
    expect(result).toEqual({ tier: 4, name: 'generated' });
  });

  it('mix-layer defence — embedded question with source_ref but no ingestion_session_id → tier 4', () => {
    // even if a row carries OTHER metadata keys (e.g. a source_document_id), tier 1
    // requires ingestion_session_id specifically.
    const result = deriveSourceTier({
      source: 'embedded',
      metadata: { source_document_id: 'doc_1', source_ref: 'art_1' },
    });
    expect(result.tier).toBe(4);
  });

  it('mix-layer defence — empty ingestion_session_id string is NOT tier 1', () => {
    const result = deriveSourceTier({
      source: 'vision_paper',
      metadata: { ingestion_session_id: '' },
    });
    expect(result.tier).toBe(4);
  });

  it('null metadata never throws and lands tier 4', () => {
    expect(() => deriveSourceTier({ source: 'quiz_gen', metadata: null })).not.toThrow();
    expect(deriveSourceTier({ source: 'quiz_gen', metadata: null }).tier).toBe(4);
  });
});

// ---------- 合约五：compareBySourceTierThenWhitelist (shared selection comparator) ----------
describe('compareBySourceTierThenWhitelist', () => {
  it('orders by tier ascending (high tier = low number first)', () => {
    const items = [
      { tier: 4, whitelistMatch: null },
      { tier: 1, whitelistMatch: null },
      { tier: 3, whitelistMatch: null },
      { tier: 2, whitelistMatch: null },
    ];
    items.sort(compareBySourceTierThenWhitelist);
    expect(items.map((i) => i.tier)).toEqual([1, 2, 3, 4]);
  });

  it('treats a null tier as the lowest (4)', () => {
    const items = [
      { tier: null, whitelistMatch: null },
      { tier: 2, whitelistMatch: null },
    ];
    items.sort(compareBySourceTierThenWhitelist);
    expect(items.map((i) => i.tier)).toEqual([2, null]);
  });

  it('OF-2 — within the same tier, only whitelist_match=false is demoted', () => {
    expect(
      compareBySourceTierThenWhitelist(
        { tier: 2, whitelistMatch: true },
        { tier: 2, whitelistMatch: false },
      ),
    ).toBeLessThan(0);
    // true vs null: equal (neither demoted).
    expect(
      compareBySourceTierThenWhitelist(
        { tier: 2, whitelistMatch: true },
        { tier: 2, whitelistMatch: null },
      ),
    ).toBe(0);
    // null is NOT demoted ahead of a real false.
    expect(
      compareBySourceTierThenWhitelist(
        { tier: 2, whitelistMatch: null },
        { tier: 2, whitelistMatch: false },
      ),
    ).toBeLessThan(0);
  });

  it('tier dominates whitelist (a higher tier off-whitelist still wins)', () => {
    // tier 1 off-whitelist beats tier 2 on-whitelist — tier is the primary key.
    expect(
      compareBySourceTierThenWhitelist(
        { tier: 1, whitelistMatch: false },
        { tier: 2, whitelistMatch: true },
      ),
    ).toBeLessThan(0);
  });
});
