import type { CapabilityManifest } from '../manifest';
import type { ProposalAcceptDecl, ProposalDismissDecl, ProposalRetractDecl } from './types';

export type ProposalLifecycleDecl = CapabilityManifest['proposals'] extends
  | { kinds: Array<infer Decl> }
  | undefined
  ? Decl & { owner: string }
  : never;

export type ProposalLifecycleRegistry = ReadonlyMap<string, ProposalLifecycleDecl>;

export function createProposalLifecycleRegistry(
  capabilities: CapabilityManifest[],
): ProposalLifecycleRegistry {
  const registry = new Map<string, ProposalLifecycleDecl>();

  for (const capability of capabilities) {
    for (const declaration of capability.proposals?.kinds ?? []) {
      const existing = registry.get(declaration.kind);
      if (existing !== undefined) {
        throw new Error(
          `proposal kind '${declaration.kind}' declared by both '${existing.owner}' and '${capability.name}'`,
        );
      }
      registry.set(declaration.kind, { owner: capability.name, ...declaration });
    }
  }

  return registry;
}

export function getProposalLifecycleDecl(
  registry: ProposalLifecycleRegistry,
  kind: string,
): ProposalLifecycleDecl | undefined {
  return registry.get(kind);
}

export function getProposalLifecycleOperation(
  registry: ProposalLifecycleRegistry,
  kind: string,
  operation: 'accept',
): ProposalAcceptDecl | undefined;
export function getProposalLifecycleOperation(
  registry: ProposalLifecycleRegistry,
  kind: string,
  operation: 'dismiss',
): ProposalDismissDecl | undefined;
export function getProposalLifecycleOperation(
  registry: ProposalLifecycleRegistry,
  kind: string,
  operation: 'retract',
): ProposalRetractDecl | undefined;
export function getProposalLifecycleOperation(
  registry: ProposalLifecycleRegistry,
  kind: string,
  operation: 'accept' | 'dismiss' | 'retract',
): ProposalAcceptDecl | ProposalDismissDecl | ProposalRetractDecl | undefined;
export function getProposalLifecycleOperation(
  registry: ProposalLifecycleRegistry,
  kind: string,
  operation: 'accept' | 'dismiss' | 'retract',
): ProposalAcceptDecl | ProposalDismissDecl | ProposalRetractDecl | undefined {
  return registry.get(kind)?.[operation];
}
