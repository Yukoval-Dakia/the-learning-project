import type { CapabilityManifest } from '../manifest';
import type { ProposalAcceptDecl } from './types';

export type ProposalAcceptRegistry = ReadonlyMap<string, ProposalAcceptDecl>;

export function createProposalAcceptRegistry(
  capabilities: CapabilityManifest[],
): ProposalAcceptRegistry {
  const owners = new Map<string, string>();
  const registry = new Map<string, ProposalAcceptDecl>();

  for (const capability of capabilities) {
    for (const declaration of capability.proposals?.kinds ?? []) {
      const owner = owners.get(declaration.kind);
      if (owner !== undefined) {
        throw new Error(
          `proposal kind '${declaration.kind}' declared by both '${owner}' and '${capability.name}'`,
        );
      }
      owners.set(declaration.kind, capability.name);
      if (declaration.accept !== undefined) {
        registry.set(declaration.kind, declaration.accept);
      }
    }
  }

  return registry;
}

export function getProposalAcceptDecl(
  registry: ProposalAcceptRegistry,
  kind: string,
): ProposalAcceptDecl | undefined {
  return registry.get(kind);
}
