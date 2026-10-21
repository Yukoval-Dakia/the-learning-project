import { z } from 'zod';
import { SubjectProfileSchema } from '@/subjects/profile-schema';

// Editable Profile Studio MVP authoring/review wire schemas.
// Core layer: pure Zod, no IO. Consumed via direct-path import
// (`@/core/schema/profile-studio`); NOT routed through the `core/schema/index.ts`
// barrel (profile-domain schemas follow the direct-path convention, same as
// `profile-decl` / `SubjectProfileSchema`).

// SubjectProfileDraftSchema — the draft-JSON wire format the compile CLI accepts.
// It is `SubjectProfileSchema` with EXACTLY ONE delta: `version` is optional
// (the author/publish step assigns the version string; the impact report only
// *suggests* a bump). Nothing else is relaxed: no other field's optionality, type,
// or `.min(1)` constraint is loosened, so the draft stays as close to the published
// shape as possible and the compile gate is not weakened.
export const SubjectProfileDraftSchema = SubjectProfileSchema.extend({
  version: z.string().trim().min(1).optional(),
});
export type SubjectProfileDraft = z.infer<typeof SubjectProfileDraftSchema>;

// ProfileImpactReportSchema — the compile-script output (also the `--json` payload).
// `diff` granularity is locked at the TOP-LEVEL `SubjectProfile` key level:
// each entry in changed/added/removed is a top-level key name (e.g.
// `causeCategories`, `renderConfig`, `judgeCapabilities`). It does NOT drill into
// nested structures — a changed `causeCategories` array reports as the single key
// `causeCategories`, not a per-cause-id sub-diff. (Deeper diffing — e.g. the
// per-cause taxonomy diff — is deferred to the cause-taxonomy board.)
export const ProfileImpactDiffSchema = z.object({
  changed: z.array(z.string()),
  added: z.array(z.string()),
  removed: z.array(z.string()),
});
export type ProfileImpactDiff = z.infer<typeof ProfileImpactDiffSchema>;

export const ProfileImpactReportSchema = z.object({
  subject_id: z.string(),
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  diff: ProfileImpactDiffSchema,
  // the report SUGGESTS a version bump; the CLI never auto-bumps. The author
  // hand-edits the `version` string in response to this hint.
  suggested_bump: z.string().optional(),
});
export type ProfileImpactReport = z.infer<typeof ProfileImpactReportSchema>;
