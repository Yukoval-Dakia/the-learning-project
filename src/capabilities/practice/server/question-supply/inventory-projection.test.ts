import { describe, expect, it } from 'vitest';
import {
  type InventoryProjectionInput,
  compareInventoryShadow,
  projectEvidenceInventory,
} from './inventory-projection';

const now = new Date('2026-07-19T00:00:00.000Z');

function input(over: Partial<InventoryProjectionInput> = {}): InventoryProjectionInput {
  return {
    subjectId: 'math',
    knowledgeId: 'kc-1',
    eligibleGoal: 2,
    now,
    questions: [],
    commitments: [],
    ...over,
  };
}

describe('EvidenceInventory v1 shadow projection', () => {
  it('stops when eligible on-hand satisfies the goal and labels the family proxy honestly', () => {
    const result = projectEvidenceInventory(
      input({
        questions: [
          { id: 'q1', ready: true },
          { id: 'q2', ready: true },
        ],
      }),
    );
    expect(result).toMatchObject({
      eligibleOnHand: 2,
      ready: 2,
      deficit: 0,
      recommendation: 'stop',
      distinctQuestionUpperBoundFamilyProxy: 2,
      familyProxyLabel: 'distinct_question_count_upper_bound_not_family_truth',
    });
  });

  it('waits on a live pipeline commitment without counting it as eligible on-hand', () => {
    const result = projectEvidenceInventory(
      input({
        eligibleGoal: 1,
        commitments: [{ id: 'c1', expiresAt: new Date('2026-07-20T00:00:00.000Z') }],
      }),
    );
    expect(result).toMatchObject({
      eligibleOnHand: 0,
      pipelineCommitments: 1,
      deficit: 1,
      uncoveredDeficitAfterPipeline: 0,
      recommendation: 'wait',
    });
  });

  it('uses the committed candidate count when one dispatch promises multiple deficit slots', () => {
    const result = projectEvidenceInventory(
      input({
        eligibleGoal: 2,
        commitments: [
          {
            id: 'batch-c',
            expiresAt: new Date('2026-07-20T00:00:00.000Z'),
            count: 2,
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      eligibleOnHand: 0,
      pipelineCommitments: 2,
      deficit: 2,
      uncoveredDeficitAfterPipeline: 0,
      recommendation: 'wait',
    });
  });

  it('does not let an expired commitment suppress genuine production', () => {
    const result = projectEvidenceInventory(
      input({
        eligibleGoal: 1,
        commitments: [{ id: 'expired-c', expiresAt: new Date('2026-07-18T00:00:00.000Z') }],
      }),
    );
    expect(result).toMatchObject({
      pipelineCommitments: 0,
      expiredPipelineCommitments: 1,
      recommendation: 'produce',
    });
  });

  it('separates exposure-blocked, quarantined and expired rows from eligible inventory', () => {
    const result = projectEvidenceInventory(
      input({
        eligibleGoal: 1,
        questions: [
          { id: 'q-exposed', ready: true, exposureBlocked: true },
          { id: 'q-quarantine', ready: false, quarantined: true },
          { id: 'q-expired', ready: true, expired: true },
        ],
      }),
    );
    expect(result).toMatchObject({
      eligibleOnHand: 0,
      ready: 1,
      exposureBlocked: 1,
      quarantined: 1,
      expired: 1,
      recommendation: 'produce',
    });
  });

  it('dual-read reports current produce versus shadow wait without changing either decision', () => {
    const projection = projectEvidenceInventory(
      input({
        eligibleGoal: 1,
        commitments: [{ id: 'c1', expiresAt: new Date('2026-07-20T00:00:00.000Z') }],
      }),
    );
    const comparisons = compareInventoryShadow(
      [
        {
          id: 'target-1',
          fingerprint: 'fp',
          gapKind: 'frontier_zero',
          subjectId: 'math',
          knowledgeIds: ['kc-1'],
          kind: 'any',
          difficultyBand: 'near',
          desiredCount: 1,
          minSourceTier: 2,
          routePreference: ['quiz_gen'],
          priority: 1,
          reason: 'current scanner deficit',
          constraints: {},
        },
      ],
      [projection],
    );
    expect(comparisons[0]).toMatchObject({
      currentRecommendation: 'produce',
      shadowRecommendation: 'wait',
      agrees: false,
    });
  });
});
