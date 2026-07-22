import { createProposalAcceptRegistry, getProposalAcceptDecl } from '@/kernel/proposals';
import { describe, expect, it, vi } from 'vitest';
import { capabilities } from './index';

const LEGACY_ACCEPT_FALLBACK_KINDS = ['record_links', 'record_promotion'];

describe('proposal accept compatibility fallback', () => {
  it('registers exactly the two live knowledge loaders without loading them eagerly', () => {
    const declarations = Object.fromEntries(
      capabilities
        .flatMap((capability) => capability.proposals?.kinds ?? [])
        .filter((candidate) => candidate.kind.startsWith('knowledge_'))
        .map((declaration) => [declaration.kind, declaration.accept]),
    );
    const nodeAccept = declarations.knowledge_node;
    const mutationAccept = declarations.knowledge_mutation;
    if (!nodeAccept) throw new Error('knowledge_node accept declaration missing');
    if (!mutationAccept) throw new Error('knowledge_mutation accept declaration missing');
    const nodeLoad = vi.spyOn(nodeAccept, 'load');
    const mutationLoad = vi.spyOn(mutationAccept, 'load');

    const registry = createProposalAcceptRegistry(capabilities);
    expect([...registry.keys()]).toEqual(['knowledge_node', 'knowledge_mutation']);
    expect(nodeLoad).not.toHaveBeenCalled();
    expect(mutationLoad).not.toHaveBeenCalled();

    expect(getProposalAcceptDecl(registry, 'knowledge_node')).toBe(nodeAccept);
    expect(getProposalAcceptDecl(registry, 'knowledge_mutation')).toBe(mutationAccept);
    expect(nodeLoad).not.toHaveBeenCalled();
    expect(mutationLoad).not.toHaveBeenCalled();
    nodeLoad.mockRestore();
    mutationLoad.mockRestore();
  });

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
