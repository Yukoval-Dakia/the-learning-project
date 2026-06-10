// YUK-214 (Strategy D · S1) — pure (no-DB) coverage for the practice source
// provenance mapping. `intentSourceToPracticeSource` is a pure switch; importing
// practice-read only loads @/db/schema table objects + drizzle (no connection),
// so this stays in the unit partition (mirrors paper-sections.test.ts). The
// DB-touching getPracticeList is covered by the db-partition tests.

import { describe, expect, it } from 'vitest';
import { intentSourceToPracticeSource } from './practice-read';

describe('intentSourceToPracticeSource (YUK-214)', () => {
  it('maps the three U5 paper provenances to their source tabs', () => {
    expect(intentSourceToPracticeSource('review_plan')).toBe('coach');
    expect(intentSourceToPracticeSource('quiz_gen')).toBe('custom');
    expect(intentSourceToPracticeSource('embedded_check')).toBe('note');
  });

  it("maps an imported paper (ingestion_paper) to the 'other' bucket (§Step 1)", () => {
    // List inclusion is decided by the inArray whitelist, not this source value;
    // ingestion_paper folds into 'other' until a dedicated tab ships (UI wave).
    expect(intentSourceToPracticeSource('ingestion_paper')).toBe('other');
  });

  it("falls back to 'other' for any unknown provenance", () => {
    expect(intentSourceToPracticeSource('made_up')).toBe('other');
  });
});
