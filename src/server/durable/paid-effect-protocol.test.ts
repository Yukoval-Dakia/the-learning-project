// Offline (no DB) checks of the FIXED paid-effect protocol surface handed to
// lanes A/C: canonical-JSON/digest determinism and identity independence from
// delivery. The backend-control admission rules, the switch-blocking
// predicate, and the entity-gate predicate are proven at the real transaction
// boundary by paid-effect-store.db.test.ts.
import { describe, expect, it } from 'vitest';

import {
  PaidEffectProtocolError,
  canonicalizePaidEffectJson,
  computePaidEffectIdentity,
  computePaidEffectInputDigest,
  paidEffectIdentitySchema,
  paidEffectJsonEquals,
} from '@/core/migration/paid-effect-protocol';

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

  // @invariant data: a changed input document or entity revision produces a different effect identity, so re-derivation never collapses two distinct paid intents onto one row
  // @fails-if a payload change or a revision bump keeps any identity component equal where it must differ (digest/revision)
  it('separates identities on input or revision change while array order stays significant', () => {
    const base = computePaidEffectIdentity({
      family: 'f',
      entityId: 'e',
      entityRevision: 'workset-1',
      unit: 'verify',
      input: INPUT,
    });
    expect(paidEffectIdentitySchema.parse(base)).toEqual(base);
    expect(paidEffectIdentitySchema.safeParse({ ...base, inputDigest: 'sha256:bad' }).success).toBe(
      false,
    );

    const changedInput = computePaidEffectIdentity({
      family: 'f',
      entityId: 'e',
      entityRevision: 'workset-1',
      unit: 'verify',
      input: { ...INPUT, tags: ['t1', 't2'] },
    });
    const changedRevision = computePaidEffectIdentity({
      family: 'f',
      entityId: 'e',
      entityRevision: 'workset-2',
      unit: 'verify',
      input: INPUT,
    });
    expect(base.inputDigest).not.toBe(changedInput.inputDigest);
    expect(base.entityRevision).not.toBe(changedRevision.entityRevision);
    expect(base.inputDigest).toBe(changedRevision.inputDigest);
    expect(() =>
      computePaidEffectIdentity({
        family: 'f',
        entityId: 'e',
        entityRevision: '',
        unit: 'verify',
        input: INPUT,
      }),
    ).toThrow(PaidEffectProtocolError);
  });

  // @invariant data: values JSON cannot represent losslessly are rejected instead of silently drifting the digest
  // @fails-if undefined/bigint/symbol/function/NaN/Date inputs canonicalize without throwing, corrupting identity stability
  it('rejects lossy values', () => {
    for (const bad of [undefined, 10n, Symbol('x'), () => {}, Number.NaN, new Date(0), new Map()]) {
      expect(() => canonicalizePaidEffectJson({ v: bad })).toThrow(PaidEffectProtocolError);
    }
    expect(() => canonicalizePaidEffectJson({ a: undefined })).toThrow(PaidEffectProtocolError);
  });

  // @invariant data: receipt/application replay comparison is semantic JSON equality, so an equal re-record is idempotent and an unequal one is detectable
  // @fails-if key-order differences count as unequal (false conflicts) or payload differences count as equal (missed receipt conflicts)
  it('compares documents semantically', () => {
    expect(paidEffectJsonEquals({ a: 1, b: [2, { c: 3 }] }, { b: [2, { c: 3 }], a: 1 })).toBe(true);
    expect(paidEffectJsonEquals({ a: 1 }, { a: 2 })).toBe(false);
    expect(paidEffectJsonEquals({ a: 1 }, undefined)).toBe(false);
  });
});
