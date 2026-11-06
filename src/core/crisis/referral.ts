// Referral wire projection: the attempt write point (recordFormalAttemptCapture)
// persists the class/config-version mark via crisisDerivationPayload; response
// projections resolve that stored mark into the versioned template. Reading the
// mark never re-classifies.

import { z } from 'zod';
import { type CrisisDetectionClass, crisisTemplateForClass } from './config';

/** The crisis mark as persisted in the attempt event payload. */
export const CrisisAttemptMarkSchema = z.object({
  detection_class: z.enum(['explicit', 'indirect', 'quoted_ironic', 'distress']),
  guard_version: z.string(),
});
export type CrisisAttemptMark = z.infer<typeof CrisisAttemptMarkSchema>;

/** The learner-facing referral block on submit responses (201 and 202). */
export const CrisisReferralWireSchema = z.object({
  detection_class: z.enum(['explicit', 'indirect', 'quoted_ironic', 'distress']),
  guard_version: z.string(),
  template: z.object({
    version: z.string(),
    review_status: z.enum(['未审定', '已审定']),
    text_md: z.string(),
  }),
});
export type CrisisReferralWire = z.infer<typeof CrisisReferralWireSchema>;

/** Deterministic template resolution for a stored mark — no re-classification. */
export function buildCrisisReferral(mark: CrisisAttemptMark): CrisisReferralWire {
  const template = crisisTemplateForClass(
    mark.detection_class as Exclude<CrisisDetectionClass, 'none'>,
  );
  return {
    detection_class: mark.detection_class,
    guard_version: mark.guard_version,
    template: {
      version: template.version,
      review_status: template.review_status,
      text_md: template.text_md,
    },
  };
}
