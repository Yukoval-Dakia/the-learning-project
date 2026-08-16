import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { acceptSupportedProposalKinds } from '@/core/schema/proposal';
import {
  createProposalLifecycleRegistry,
  getProposalLifecycleDecl,
  getProposalLifecycleOperation,
} from '@/kernel/proposals';
import { capabilities } from './index';

describe('proposal lifecycle capability registry', () => {
  it('registers every owned kind and every supported accept without loading capability code eagerly', async () => {
    const declarations = capabilities.flatMap((capability) =>
      (capability.proposals?.kinds ?? []).flatMap((declaration) =>
        declaration.accept ? [{ kind: declaration.kind, accept: declaration.accept }] : [],
      ),
    );
    const spies = declarations.map(({ accept }) => vi.spyOn(accept, 'load'));

    const registry = createProposalLifecycleRegistry(capabilities);
    expect([...registry.keys()].sort()).toEqual(
      capabilities
        .flatMap((capability) => capability.proposals?.kinds.map(({ kind }) => kind) ?? [])
        .sort(),
    );
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);

    for (const { kind, accept } of declarations) {
      expect(getProposalLifecycleOperation(registry, kind, 'accept')).toBe(accept);
    }
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);

    const node = getProposalLifecycleOperation(registry, 'knowledge_node', 'accept');
    await expect(node?.load()).resolves.toEqual(expect.any(Function));
    expect(spies.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBe(1);
    for (const spy of spies) spy.mockRestore();
  });

  it('leaves only observe-only kinds without accept loaders', () => {
    const registry = createProposalLifecycleRegistry(capabilities);
    expect(getProposalLifecycleOperation(registry, 'defer', 'accept')).toBeUndefined();
    expect(getProposalLifecycleOperation(registry, 'archive', 'accept')).toBeUndefined();
    expect(getProposalLifecycleOperation(registry, 'judge_retraction', 'accept')).toBeUndefined();
  });

  it('keeps knowledge_edge retract on the generic correction lane', () => {
    const registry = createProposalLifecycleRegistry(capabilities);
    expect(getProposalLifecycleOperation(registry, 'knowledge_edge', 'retract')).toBeUndefined();
  });

  it('declares corrected payload support only on the Agency conjecture accept capability', () => {
    const correctedPayloadKinds = capabilities.flatMap((capability) =>
      (capability.proposals?.kinds ?? []).flatMap(({ kind, accept }) =>
        accept && 'correctedPayload' in accept && accept.correctedPayload === true ? [kind] : [],
      ),
    );

    expect(correctedPayloadKinds).toEqual(['conjecture']);
  });

  it.each(['knowledge_node', 'variant_question'] as const)(
    'declares accept, dismiss, and retract semantics for %s',
    async (kind) => {
      const registry = createProposalLifecycleRegistry(capabilities);
      const lifecycle = getProposalLifecycleDecl(registry, kind);

      expect(lifecycle?.owner).toBe(kind === 'knowledge_node' ? 'knowledge' : 'practice');
      expect(lifecycle?.accept).toBeDefined();
      expect(lifecycle?.dismiss).toBeDefined();
      expect(lifecycle?.retract).toBeDefined();
      const operations = await Promise.all([
        lifecycle?.accept?.load(),
        lifecycle?.dismiss?.load(),
        lifecycle?.retract?.load(),
      ]);
      expect(operations.every((operation) => typeof operation === 'function')).toBe(true);
    },
  );

  it('keeps proposal-kind policy and capability appliers out of the central actions shell', async () => {
    const source = (
      await Promise.all(
        [
          'actions.ts',
          'action-types.ts',
          'accept-action.ts',
          'decision-resource.ts',
          'dismiss-action.ts',
          'retract-action.ts',
          'lifecycle-context.ts',
        ].map((file) => readFile(new URL(`../server/proposals/${file}`, import.meta.url), 'utf8')),
      )
    ).join('\n');
    const forbidden = [
      ...capabilities.flatMap(
        (capability) => capability.proposals?.kinds.map(({ kind }) => `'${kind}'`) ?? [],
      ),
      'applyArchive',
      'decideKnowledgeEdgeProposal',
      'dismissProposal',
      'undoNoteRefineApplyEvent',
    ];

    for (const literal of forbidden) expect(source).not.toContain(literal);
  });
});
