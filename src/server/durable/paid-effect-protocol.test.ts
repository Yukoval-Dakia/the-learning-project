// Offline (no DB) checks of the FIXED paid-effect protocol surface handed to
// lanes A/C: canonical-JSON/digest determinism, identity independence from
// delivery, the pure backend-control admission rules, the switch-blocking
// predicate, and the duplicated note_verify family literal lockstep.
import { describe, expect, it } from 'vitest';

import { NOTE_VERIFY_PAID_EFFECT_FAMILY } from '@/capabilities/notes/jobs/note_verify';

import { NOTE_VERIFY_FAMILY } from './note-verify-family';
import { NOTE_VERIFY_OBLIGATION_FAMILY } from './paid-effect-note-obligations';
import {
  PAID_EFFECT_SWITCH_BLOCKING_STATES,
  type PaidEffectControlSnapshot,
  PaidEffectProtocolError,
  type PaidEffectState,
  canonicalizePaidEffectJson,
  computePaidEffectIdentity,
  computePaidEffectInputDigest,
  decidePaidEffectControlAdmission,
  paidEffectGateBlocks,
  paidEffectGateLockKey,
  paidEffectJsonEquals,
  summarizePaidEffectSwitchBlocking,
} from './paid-effect-protocol';

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

describe('paid-effect backend control admission (pure decision)', () => {
  const explicitPgboss: PaidEffectControlSnapshot = {
    family: 'f',
    backend: 'pg-boss',
    generation: 2,
    explicit: true,
  };
  const explicitDbos: PaidEffectControlSnapshot = {
    family: 'f',
    backend: 'dbos',
    generation: 5,
    explicit: true,
  };
  const bootstrap: PaidEffectControlSnapshot = {
    family: 'f',
    backend: 'pg-boss',
    generation: 0,
    explicit: false,
  };

  // @invariant concurrency: a delivery from the backend that does not own the family is fenced before any paid work, symmetrically for pg-boss and DBOS
  // @fails-if an explicit dbos owner admits a pg-boss delivery (or vice versa), letting two backends run one paid family concurrently
  it('fences the opposite backend symmetrically', () => {
    expect(
      decidePaidEffectControlAdmission(explicitDbos, { backend: 'pg-boss', deliveryId: 'j1' }),
    ).toMatchObject({ kind: 'fenced', reason: 'backend_mismatch', owner: 'dbos' });
    expect(
      decidePaidEffectControlAdmission(explicitPgboss, { backend: 'dbos', deliveryId: 'w1' }),
    ).toMatchObject({ kind: 'fenced', reason: 'backend_mismatch', owner: 'pg-boss' });
  });

  // @invariant concurrency: absence of a control row is the bootstrap default owner pg-boss generation 0, and DBOS never default-admits
  // @fails-if a missing control row admits a DBOS delivery or fences pg-boss before the parent migration lands
  it('bootstrap default admits only pg-boss', () => {
    expect(
      decidePaidEffectControlAdmission(bootstrap, { backend: 'pg-boss', deliveryId: 'j1' }),
    ).toMatchObject({ kind: 'admitted' });
    expect(
      decidePaidEffectControlAdmission(bootstrap, { backend: 'dbos', deliveryId: 'w1' }),
    ).toMatchObject({ kind: 'fenced', reason: 'backend_mismatch', owner: 'pg-boss' });
  });

  // @invariant concurrency: a stale ownership generation is fenced even when the backend name matches again after an A→B→A round trip
  // @fails-if generation is ignored on admission, letting a pre-switch delivery execute under post-switch ownership
  // @invariant concurrency: a stale ownership generation is fenced even when the backend name matches again after an A→B→A round trip, and a DBOS delivery without a dispatch generation is never admitted against an explicit control row
  // @fails-if generation is ignored on admission or accepted as null for DBOS, letting a pre-switch delivery execute under post-switch ownership
  it('fences stale and missing generations, admits current ones', () => {
    expect(
      decidePaidEffectControlAdmission(explicitDbos, {
        backend: 'dbos',
        deliveryId: 'w1',
        generation: 4,
      }),
    ).toMatchObject({ kind: 'fenced', reason: 'stale_generation' });
    expect(
      decidePaidEffectControlAdmission(explicitDbos, { backend: 'dbos', deliveryId: 'w1' }),
    ).toMatchObject({ kind: 'fenced', reason: 'missing_generation' });
    expect(
      decidePaidEffectControlAdmission(explicitDbos, {
        backend: 'dbos',
        deliveryId: 'w2',
        generation: 5,
      }),
    ).toMatchObject({ kind: 'admitted' });
    expect(
      decidePaidEffectControlAdmission(explicitPgboss, { backend: 'pg-boss', deliveryId: 'j1' }),
    ).toMatchObject({ kind: 'admitted' });
  });
});

describe('paid-effect switch blocking predicate', () => {
  // @invariant concurrency: a backend switch is blocked by ANY unfinished obligation (pending intent, in-flight or unknown send, or unapplied receipt); only fully applied effects do not block
  // @fails-if any unfinished state fails to block the switch (ownership moves under a paid call or an unapplied receipt), or an applied effect wrongly blocks it
  it('blocks on every unfinished state', () => {
    const counts = (states: PaidEffectState[]) => {
      const byState: Partial<Record<PaidEffectState, number>> = {};
      for (const state of states) byState[state] = (byState[state] ?? 0) + 1;
      return byState;
    };
    expect(summarizePaidEffectSwitchBlocking(counts(['pending']))).toEqual({
      blocked: true,
      blocking: { pending: 1, sending: 0, unknown: 0, receipt_ready: 0 },
    });
    expect(summarizePaidEffectSwitchBlocking(counts(['receipt_ready', 'unknown']))).toEqual({
      blocked: true,
      blocking: { pending: 0, sending: 0, unknown: 1, receipt_ready: 1 },
    });
    expect(summarizePaidEffectSwitchBlocking(counts(['applied']))).toEqual({
      blocked: false,
      blocking: { pending: 0, sending: 0, unknown: 0, receipt_ready: 0 },
    });
    expect(summarizePaidEffectSwitchBlocking({})).toEqual({
      blocked: false,
      blocking: { pending: 0, sending: 0, unknown: 0, receipt_ready: 0 },
    });
    expect([...PAID_EFFECT_SWITCH_BLOCKING_STATES]).toEqual([
      'pending',
      'sending',
      'unknown',
      'receipt_ready',
    ]);
  });
});

describe('paid-effect fixed entity-gate predicate', () => {
  // @invariant concurrency: the ONE fixed gate policy — sibling units of the same revision are exempt (parallel rep sends), while a same-revision same-unit input change and ANY cross-revision open send are blocked
  // @fails-if rep siblings block each other, or a changed digest under the same unit / an old unknown under a new revision buys a new send
  it('exempts only same-revision sibling units', () => {
    const claim = { entityRevision: 'rev-1', unit: 'method-a/rep:2' };
    expect(paidEffectGateBlocks({ entityRevision: 'rev-1', unit: 'method-a/rep:1' }, claim)).toBe(
      false,
    );
    expect(paidEffectGateBlocks({ entityRevision: 'rev-1', unit: 'method-a/rep:2' }, claim)).toBe(
      true,
    );
    expect(paidEffectGateBlocks({ entityRevision: 'rev-2', unit: 'method-a/rep:1' }, claim)).toBe(
      true,
    );
    expect(paidEffectGateBlocks({ entityRevision: 'rev-2', unit: 'method-a/rep:2' }, claim)).toBe(
      true,
    );
  });

  // @invariant concurrency: gate serialization is keyed on family+entity only — claims for DIFFERENT revisions of one entity must contend on the same advisory lock or the cross-revision block can be raced past
  // @fails-if the lock key includes the revision (or unit/digest), letting two revisions of one entity serialize independently
  it('locks on family+entity without revision', () => {
    const base = {
      family: 'f',
      entityId: 'e1',
      entityRevision: 'rev-1',
      unit: 'u',
      inputDigest: 'sha256:' + 'a'.repeat(64),
    };
    expect(paidEffectGateLockKey(base)).toBe('paid-effect:gate:v1:f:e1');
    expect(paidEffectGateLockKey({ ...base, entityRevision: 'rev-2' })).toBe(
      'paid-effect:gate:v1:f:e1',
    );
    expect(paidEffectGateLockKey({ ...base, entityId: 'e2' })).toBe('paid-effect:gate:v1:f:e2');
  });
});

describe('note_verify family literal lockstep', () => {
  // @invariant concurrency: the pg-boss consumer, the DBOS adapter, and the switch-gate obligation probe name the same control family so backend fencing covers every half of note_verify
  // @fails-if any literal drifts and one half of note_verify escapes the control gate or the switch probe the others enforce
  it('keeps all three family literals equal', () => {
    expect(NOTE_VERIFY_PAID_EFFECT_FAMILY).toBe('note_verify');
    expect(NOTE_VERIFY_FAMILY).toBe('note_verify');
    expect(NOTE_VERIFY_OBLIGATION_FAMILY).toBe('note_verify');
  });
});
