import { describe, expect, it } from 'vitest';
import { capabilities } from './index';

const LEGACY_ACCEPT_FALLBACK_KINDS = ['record_links', 'record_promotion'];

describe('proposal accept compatibility fallback', () => {
  it('keeps only the two D11 tombstones outside capability ownership', () => {
    const declaredKinds = new Set(
      capabilities.flatMap((capability) =>
        (capability.proposals?.kinds ?? []).map((declaration) => declaration.kind),
      ),
    );

    expect(LEGACY_ACCEPT_FALLBACK_KINDS).toEqual(['record_links', 'record_promotion']);
    for (const kind of LEGACY_ACCEPT_FALLBACK_KINDS) {
      expect(declaredKinds.has(kind)).toBe(false);
    }
  });
});
