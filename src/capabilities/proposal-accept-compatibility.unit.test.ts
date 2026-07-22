import { createProposalAcceptRegistry, getProposalAcceptDecl } from '@/kernel/proposals';
import { describe, expect, it, vi } from 'vitest';
import { capabilities } from './index';

const LEGACY_ACCEPT_FALLBACK_KINDS = ['record_links', 'record_promotion'];

describe('proposal accept compatibility fallback', () => {
  it('registers exactly the live knowledge_node loader without loading it eagerly', async () => {
    const declaration = capabilities
      .flatMap((capability) => capability.proposals?.kinds ?? [])
      .find((candidate) => candidate.kind === 'knowledge_node');
    if (!declaration?.accept) throw new Error('knowledge_node accept declaration missing');
    const load = vi.spyOn(declaration.accept, 'load');

    const registry = createProposalAcceptRegistry(capabilities);
    expect([...registry.keys()]).toEqual(['knowledge_node']);
    expect(load).not.toHaveBeenCalled();

    expect(getProposalAcceptDecl(registry, 'knowledge_node')).toBe(declaration.accept);
    expect(load).not.toHaveBeenCalled();
    load.mockRestore();
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
