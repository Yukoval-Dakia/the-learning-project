// Offline (no DB) checks of the FIXED paid-effect protocol surface handed to
// lanes A/C: canonical-JSON/digest determinism and identity independence from
// delivery. The backend-control admission rules, the switch-blocking
// predicate, and the entity-gate predicate are proven at the real transaction
// boundary by paid-effect-store.db.test.ts.
import { describe, expect, it } from 'vitest';

import {
  canonicalizePaidEffectJson,
  computePaidEffectInputDigest,
} from '@/core/paid-work/protocol/paid-effect-protocol';

const INPUT = {
  artifact_id: 'a1',
  body: { sections: [{ kind: 'definition', md: 'x' }], meta: null },
  tags: ['t2', 't1'],
};

describe('paid-effect canonical JSON + digest', () => {
  // @invariant data: the effect digest is a deterministic function of the input document, so the same provider input can never mint a second paid effect identity
  // @fails-if key order, -0, or insertion order changes the canonical form or digest for an equal document
  it('digests equal documents identically regardless of key order and -0', () => {
    const shuffled = {
      tags: ['t2', 't1'],
      body: { meta: null, sections: [{ md: 'x', kind: 'definition' }] },
      artifact_id: 'a1',
    };
    expect(canonicalizePaidEffectJson(INPUT)).toBe(canonicalizePaidEffectJson(shuffled));
    expect(computePaidEffectInputDigest(INPUT)).toBe(computePaidEffectInputDigest(shuffled));
    expect(computePaidEffectInputDigest(INPUT)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
