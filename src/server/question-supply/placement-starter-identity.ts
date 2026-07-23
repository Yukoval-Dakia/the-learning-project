import { createHash } from 'node:crypto';

export interface PlacementStarterIdentity {
  digest: string;
  knowledgeId: string;
  genesisEventId: string;
  claimId: string;
  demandId: string;
  targetId: string;
  fingerprint: string;
}

export function placementStarterIdentity(
  semanticGoalRevisionId: string,
  subjectId: string,
): PlacementStarterIdentity {
  const digest = createHash('sha256')
    .update(`placement-starter\0v1\0${semanticGoalRevisionId}\0${subjectId}`)
    .digest('hex');
  return {
    digest,
    knowledgeId: `goal-kc-v1-${digest.slice(0, 32)}`,
    genesisEventId: `goal-kc-genesis-v1-${digest}`,
    claimId: `placement-starter-claim-v1-${digest}`,
    demandId: `demand:placement-starter:v1:${digest}`,
    targetId: `supply-target:placement-starter:v1:${digest}`,
    fingerprint: `placement-starter|v1|${digest}`,
  };
}

export function placementStarterAttemptId(
  claimId: string,
  pgBossJobId: string,
  deliveryNo: number,
): string {
  return createHash('sha256')
    .update(`placement-starter-attempt\0v1\0${claimId}\0${pgBossJobId}\0${deliveryNo}`)
    .digest('hex');
}
