import { createHash } from 'node:crypto';

export interface PlacementStarterIdentity {
  digest: string;
  /**
   * the deterministic per-subject starter anchor node id
   * (`placement-starter:<subject>`). It no longer encodes the revision digest:
   * the anchor is shared across goals/revisions and named after the SUBJECT,
   * never the goal text. The claim's `knowledge_id` holds the RESOLVED anchor
   * (an explicit-scope KC wins over this fallback) — see
   * `resolvePlacementStarterAnchor` in placement-starter-store.ts.
   */
  knowledgeId: string;
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
    knowledgeId: `placement-starter:${subjectId}`,
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
