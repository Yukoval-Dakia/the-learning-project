import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { defineCapability } from '../manifest';
import { createProposalAcceptRegistry, getProposalAcceptDecl } from './registry';
import type { ProposalAcceptApplier, ProposalAcceptInput } from './types';

const applier: ProposalAcceptApplier = async (_db, { proposal }) => ({
  kind: proposal.payload.kind,
});

describe('proposal accept registry', () => {
  it('uses payload as the only proposal identity and discriminates decision options', () => {
    expectTypeOf<ProposalAcceptInput['proposal']>().not.toHaveProperty('kind');
    expectTypeOf<ProposalAcceptInput['proposal']>().not.toHaveProperty('target');
    expectTypeOf<Extract<ProposalAcceptInput, { decision: 'change_type' }>>()
      .toHaveProperty('new_relation_type')
      .toEqualTypeOf<string>();
    expectTypeOf<
      Extract<ProposalAcceptInput, { decision?: 'accept' }>['new_relation_type']
    >().toEqualTypeOf<undefined>();
  });

  it('indexes only proposal kinds with accept loaders without invoking them', () => {
    const load = vi.fn(async () => applier);
    const registry = createProposalAcceptRegistry([
      defineCapability({
        name: 'owned',
        description: 'test capability',
        proposals: {
          kinds: [{ kind: 'implemented', accept: { load } }, { kind: 'declared_only' }],
        },
      }),
    ]);

    expect([...registry.keys()]).toEqual(['implemented']);
    expect(load).not.toHaveBeenCalled();
  });

  it('loads the typed applier for a registered kind and returns undefined otherwise', async () => {
    const registry = createProposalAcceptRegistry([
      defineCapability({
        name: 'owned',
        description: 'test capability',
        proposals: { kinds: [{ kind: 'implemented', accept: { load: async () => applier } }] },
      }),
    ]);

    const decl = getProposalAcceptDecl(registry, 'implemented');
    expect(decl).toBeDefined();
    await expect(decl?.load()).resolves.toBe(applier);
    expect(getProposalAcceptDecl(registry, 'declared_only')).toBeUndefined();
  });

  it('rejects duplicate proposal kinds defensively', () => {
    expect(() =>
      createProposalAcceptRegistry([
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
