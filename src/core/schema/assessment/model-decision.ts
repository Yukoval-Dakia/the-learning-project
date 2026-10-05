import { z } from 'zod';
import { ConjectureProbeSignatureMatch } from '../conjecture-probe-response';
import { EvidenceCitation } from './judgment';

// Models report a published rule decision or a published level. They never
// return aggregation weights, new criteria, a normalized coarse score or FSRS ratings.
const support = {
  confidence: z.number().min(0).max(1),
  feedback_md: z.string(),
  evidence_citations: z.array(EvidenceCitation).min(1),
};
export const AssessmentRuleDecision = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('rule'),
      rule_id: z.string().min(1),
      points_awarded: z.number().min(0),
      probe_signature_match: ConjectureProbeSignatureMatch.optional(),
      ...support,
    })
    .strict(),
  z.object({ kind: z.literal('level'), level_id: z.string().min(1), ...support }).strict(),
  z.object({ kind: z.literal('pending'), detail: z.string().min(1) }).strict(),
]);
export type AssessmentRuleDecisionT = z.infer<typeof AssessmentRuleDecision>;
