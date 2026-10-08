import type { RuleReferenceCriterionT } from '@/core/schema/assessment';
import type { ConjectureProbeSpecV2T } from '@/core/schema/business';

/** The complete model-facing V2 rule, shared by publication and provenance checks. */
export function createProbeV2Criterion({
  scoringUnitId,
  probeSpec,
}: {
  scoringUnitId: string;
  probeSpec: ConjectureProbeSpecV2T;
}): RuleReferenceCriterionT {
  return {
    kind: 'rule_reference',
    rule_id: `${scoringUnitId}:probe-v2`,
    source: 'system_proposed',
    statement_md: `${probeSpec.reference_md}\n\n完整正确作答得1分，否则0分；签名匹配独立判断，不以得分推断目标错误。`,
    probe_spec: probeSpec,
  };
}
