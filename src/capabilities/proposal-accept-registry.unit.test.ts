import { acceptSupportedProposalKinds } from '@/core/schema/proposal';
import { createProposalAcceptRegistry, getProposalAcceptDecl } from '@/kernel/proposals';
import { describe, expect, it, vi } from 'vitest';
import { capabilities } from './index';

describe('proposal accept capability registry', () => {
  it('registers every supported kind without loading capability code eagerly', async () => {
    const declarations = capabilities.flatMap((capability) =>
      (capability.proposals?.kinds ?? []).flatMap((declaration) =>
        declaration.accept ? [{ kind: declaration.kind, accept: declaration.accept }] : [],
      ),
    );
    const spies = declarations.map(({ accept }) => vi.spyOn(accept, 'load'));

    const registry = createProposalAcceptRegistry(capabilities);
    expect([...registry.keys()].sort()).toEqual([...acceptSupportedProposalKinds].sort());
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);

    for (const { kind, accept } of declarations) {
      expect(getProposalAcceptDecl(registry, kind)).toBe(accept);
    }
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);

    const node = getProposalAcceptDecl(registry, 'knowledge_node');
    await expect(node?.load()).resolves.toEqual(expect.any(Function));
    expect(spies.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBe(1);
    for (const spy of spies) spy.mockRestore();
  });

  it('leaves only observe-only kinds without accept loaders', () => {
    const registry = createProposalAcceptRegistry(capabilities);
    expect(getProposalAcceptDecl(registry, 'defer')).toBeUndefined();
    expect(getProposalAcceptDecl(registry, 'archive')).toBeUndefined();
    expect(getProposalAcceptDecl(registry, 'judge_retraction')).toBeUndefined();
  });
});
