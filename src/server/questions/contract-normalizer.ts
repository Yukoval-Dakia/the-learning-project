// Compatibility entrypoint for the shared assessment publication engine.

export type {
  ConversionIssue,
  NormalizableQuestionRow,
  NormalizedContract,
  PartRow,
  RuleProvenance,
} from '@/kernel/records/assessment-normalization';
export {
  contractIntegrityDigest,
  mintMaterialId,
  mintOptionId,
  normalizeQuestionGroupToContract,
  normalizeQuestionRowToContract,
  ruleProvenanceFor,
} from '@/kernel/records/assessment-normalization';
