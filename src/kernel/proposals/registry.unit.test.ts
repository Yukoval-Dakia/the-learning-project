import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { defineCapability } from '../manifest';
import {
  createProposalLifecycleRegistry,
  getProposalLifecycleDecl,
  getProposalLifecycleOperation,
} from './registry';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalCorrectedPayload,
  ProposalDismissApplier,
  ProposalRetractApplier,
} from './types';

const applier: ProposalAcceptApplier = async (_db, { proposal }) => ({
  kind: proposal.payload.kind,
  result: { kind: proposal.payload.kind },
});

const dismiss: ProposalDismissApplier = async (_db, { proposal }) => ({
  kind: proposal.payload.kind,
  result: { kind: proposal.payload.kind },
});

const retract: ProposalRetractApplier = async () => {};

describe('proposal lifecycle registry', () => {
  it('uses payload as the only proposal identity and discriminates decision options', () => {
    expectTypeOf<ProposalAcceptInput['proposal']>().not.toHaveProperty('kind');
    expectTypeOf<ProposalAcceptInput['proposal']>().not.toHaveProperty('target');
    expectTypeOf<ProposalAcceptInput>().not.toHaveProperty('enqueueVariantVerify');
    expectTypeOf<ProposalAcceptInput>().not.toHaveProperty('imageCandidateDeps');
    expectTypeOf<Extract<ProposalAcceptInput, { decision?: 'accept' }>>()
      .toHaveProperty('corrected_payload')
      .toEqualTypeOf<ProposalCorrectedPayload | undefined>();
    expectTypeOf<Extract<ProposalAcceptInput, { decision: 'change_type' }>>()
      .toHaveProperty('new_relation_type')
      .toEqualTypeOf<string>();
    expectTypeOf<
      Extract<ProposalAcceptInput, { decision?: 'accept' }>['new_relation_type']
    >().toEqualTypeOf<undefined>();
  });

  it('indexes every owned proposal kind without invoking lifecycle loaders', () => {
    const acceptLoad = vi.fn(async () => applier);
    const dismissLoad = vi.fn(async () => dismiss);
    const retractLoad = vi.fn(async () => retract);
    const registry = createProposalLifecycleRegistry([
      defineCapability({
        name: 'owned',
        description: 'test capability',
        proposals: {
          kinds: [
            {
              kind: 'implemented',
              accept: { load: acceptLoad },
              dismiss: { load: dismissLoad },
              retract: { load: retractLoad },
            },
            { kind: 'declared_only' },
          ],
        },
      }),
    ]);

    expect([...registry.keys()]).toEqual(['implemented', 'declared_only']);
    expect(acceptLoad).not.toHaveBeenCalled();
    expect(dismissLoad).not.toHaveBeenCalled();
    expect(retractLoad).not.toHaveBeenCalled();
  });

  it.each([
    ['first', 'accept'],
    ['first', 'dismiss'],
    ['first', 'retract'],
    ['second', 'accept'],
    ['second', 'dismiss'],
    ['second', 'retract'],
  ] as const)('resolves %s owner %s operation', async (kind, operation) => {
    const registry = createProposalLifecycleRegistry([
      defineCapability({
        name: 'owned',
        description: 'test capability',
        proposals: {
          kinds: ['first', 'second'].map((ownedKind) => ({
            kind: ownedKind,
            accept: { load: async () => applier },
            dismiss: { load: async () => dismiss },
            retract: { load: async () => retract },
          })),
        },
      }),
    ]);

    const operationDecl = getProposalLifecycleOperation(registry, kind, operation);
    expect(operationDecl).toBeDefined();
    await expect(operationDecl?.load()).resolves.toBe(
      operation === 'accept' ? applier : operation === 'dismiss' ? dismiss : retract,
    );
  });

  it('returns the owner declaration while leaving unsupported operations absent', () => {
    const registry = createProposalLifecycleRegistry([
      defineCapability({
        name: 'owned',
        description: 'test capability',
        proposals: { kinds: [{ kind: 'declared_only' }] },
      }),
    ]);

    expect(getProposalLifecycleDecl(registry, 'declared_only')).toEqual({
      owner: 'owned',
      kind: 'declared_only',
    });
    expect(getProposalLifecycleOperation(registry, 'declared_only', 'accept')).toBeUndefined();
    expect(getProposalLifecycleOperation(registry, 'missing', 'dismiss')).toBeUndefined();
  });

  it('rejects duplicate proposal kinds defensively', () => {
    expect(() =>
      createProposalLifecycleRegistry([
        defineCapability({
          name: 'a',
          description: 'test capability',
          proposals: { kinds: [{ kind: 'duplicate', accept: { load: async () => applier } }] },
        }),
        defineCapability({
          name: 'b',
          description: 'test capability',
          proposals: { kinds: [{ kind: 'duplicate', accept: { load: async () => applier } }] },
        }),
      ]),
    ).toThrow("proposal kind 'duplicate' declared by both 'a' and 'b'");
  });
});
