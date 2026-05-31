// P5.4-L2 / YUK-174 — pure (no-DB) unit coverage for the adaptive-bias decision
// helpers: relation derive from cooldown_key + computeGateBump tighten-only /
// never-lock / cold-start invariants + findFeedbackCell. Lives in the fast
// (no-Docker) partition (see vitest.shared.ts fastTestInclude) — imports only
// the pure functions; the DB-touching getProposalFeedbackDigest is covered in
// the sibling adaptive-bias.test.ts (DB partition).

import { describe, expect, it } from 'vitest';
import {
  type GateBiasConfig,
  type ProposalFeedbackCell,
  computeGateBump,
  deriveRelationFromCooldownKey,
  findFeedbackCell,
} from './adaptive-bias';

const CONFIG: GateBiasConfig = { acceptanceThreshold: 0.3, minSamples: 5 };

function cell(partial: Partial<ProposalFeedbackCell>): ProposalFeedbackCell {
  return {
    kind: 'knowledge_edge',
    relation: 'prerequisite',
    accept_count: 0,
    dismiss_count: 0,
    total: 0,
    acceptance_rate: 0,
    top_dismiss_reasons: [],
    top_rubric_gates: [],
    ...partial,
  };
}

describe('deriveRelationFromCooldownKey', () => {
  it('parses the last |-segment for edge keys', () => {
    expect(
      deriveRelationFromCooldownKey('knowledge_edge', 'knowledge_edge:k1|k2|prerequisite'),
    ).toBe('prerequisite');
  });

  it('preserves a relation that itself contains a colon (experimental:* escape hatch)', () => {
    // Production parses ONLY `|`; a `:`-split would truncate `experimental:foo`.
    expect(
      deriveRelationFromCooldownKey('knowledge_edge', 'knowledge_edge:k1|k2|experimental:foo'),
    ).toBe('experimental:foo');
  });

  it('returns null for non-edge kinds', () => {
    expect(deriveRelationFromCooldownKey('completion', 'completion:li1')).toBeNull();
    expect(
      deriveRelationFromCooldownKey('knowledge_node', 'knowledge_node:parent:name'),
    ).toBeNull();
  });

  it('returns null when an edge key has no | segment', () => {
    expect(deriveRelationFromCooldownKey('knowledge_edge', 'knowledge_edge_malformed')).toBeNull();
  });
});

describe('computeGateBump — tighten-only / never-lock / cold-start (AB-3)', () => {
  it('cold start: undefined cell → no tighten', () => {
    expect(computeGateBump(undefined, CONFIG)).toEqual({ tightenMediumToStrong: false });
  });

  it('below minSamples: enough dismisses but too few decisions → no tighten', () => {
    const c = cell({ accept_count: 0, dismiss_count: 4, total: 4, acceptance_rate: 0 });
    expect(computeGateBump(c, CONFIG)).toEqual({ tightenMediumToStrong: false });
  });

  it('at/above threshold with enough samples → no tighten', () => {
    const c = cell({ accept_count: 7, dismiss_count: 3, total: 10, acceptance_rate: 0.7 });
    expect(computeGateBump(c, CONFIG)).toEqual({ tightenMediumToStrong: false });
    // Exactly at threshold (0.3) is NOT below → no tighten.
    const atThreshold = cell({
      accept_count: 3,
      dismiss_count: 7,
      total: 10,
      acceptance_rate: 0.3,
    });
    expect(computeGateBump(atThreshold, CONFIG)).toEqual({ tightenMediumToStrong: false });
  });

  it('below threshold with enough samples → tighten + carries audit metadata', () => {
    const c = cell({ accept_count: 1, dismiss_count: 9, total: 10, acceptance_rate: 0.1 });
    expect(computeGateBump(c, CONFIG)).toEqual({
      tightenMediumToStrong: true,
      acceptanceRate: 0.1,
      sampleCount: 10,
      threshold: 0.3,
    });
  });

  it('exactly minSamples boundary with low rate → tighten', () => {
    const c = cell({ accept_count: 0, dismiss_count: 5, total: 5, acceptance_rate: 0 });
    expect(computeGateBump(c, CONFIG)).toMatchObject({ tightenMediumToStrong: true });
  });
});

describe('findFeedbackCell', () => {
  const digest: ProposalFeedbackCell[] = [
    cell({ kind: 'knowledge_edge', relation: 'prerequisite', total: 5, acceptance_rate: 0.2 }),
    cell({ kind: 'knowledge_edge', relation: 'related_to', total: 3, acceptance_rate: 0.9 }),
    cell({ kind: 'completion', relation: null, total: 4, acceptance_rate: 0.8 }),
  ];

  it('matches a specific edge (kind, relation)', () => {
    expect(findFeedbackCell(digest, 'knowledge_edge', 'prerequisite')?.acceptance_rate).toBe(0.2);
    expect(findFeedbackCell(digest, 'knowledge_edge', 'related_to')?.acceptance_rate).toBe(0.9);
  });

  it('matches a non-edge kind via relation:null', () => {
    expect(findFeedbackCell(digest, 'completion', null)?.acceptance_rate).toBe(0.8);
  });

  it('returns undefined for an unseen cell (cold start for that cell)', () => {
    expect(findFeedbackCell(digest, 'knowledge_edge', 'contrasts_with')).toBeUndefined();
  });
});
