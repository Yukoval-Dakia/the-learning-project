// Kernel facade for untrusted learner-text handling. Capability packages import
// this public boundary rather than reaching into the legacy agency scout tree.
export {
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  UNTRUSTED_TEXT_CHAR_CAP,
  truncate,
  truncateNullable,
  wrapTruncatedLearnerText,
  wrapUntrustedLearnerText,
} from '@/server/agency/scout/untrusted-text';
