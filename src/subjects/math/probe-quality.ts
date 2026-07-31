import {
  type SubjectProbeValidator,
  registerSubjectProbeValidators,
} from '@/subjects/probe-quality';
import { compoundUnitDenominatorConversionValidator } from './probe-validators/unit-conversion';
import { unlikeDenominatorFractionAdditionValidator } from './probe-validators/unlike-denominator-fraction';

export const mathProbeValidators: readonly SubjectProbeValidator[] = [
  compoundUnitDenominatorConversionValidator,
  unlikeDenominatorFractionAdditionValidator,
];

registerSubjectProbeValidators('math', mathProbeValidators);
