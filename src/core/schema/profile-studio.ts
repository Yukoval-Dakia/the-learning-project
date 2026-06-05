import { SubjectProfileSchema } from '@/subjects/profile-schema';
import { z } from 'zod';

// U7 (YUK-203) — Editable Profile Studio MVP authoring/review wire schemas.
// Core layer: pure Zod, no IO. Consumed via direct-path import
// (`@/core/schema/profile-studio`); NOT routed through the `core/schema/index.ts`
// barrel (that barrel re-exports only `./business` + `./proposal` — profile-domain
// schemas follow the direct-path convention, same as `profile-decl` /
// `SubjectProfileSchema`). See plan §3 / Cross-统合 S1.

// SubjectProfileDraftSchema — the draft-JSON wire format the compile CLI accepts.
// It is `SubjectProfileSchema` with EXACTLY ONE delta: `version` is optional
// (Q7 — the author/publish step assigns the version string; the impact report only
// *suggests* a bump). Nothing else is relaxed: no other field's optionality, type,
// or `.min(1)` constraint is loosened, so the draft stays as close to the published
// shape as possible and the compile gate is not weakened (Cross-统合 G2).
export const SubjectProfileDraftSchema = SubjectProfileSchema.extend({
  version: z.string().trim().min(1).optional(),
});
export type SubjectProfileDraft = z.infer<typeof SubjectProfileDraftSchema>;

// ProfileImpactReportSchema — the compile-script output (also the `--json` payload).
// `diff` granularity is locked at the TOP-LEVEL `SubjectProfile` key level
// (Cross-统合 G1): each entry in changed/added/removed is a top-level key name (e.g.
// `causeCategories`, `renderConfig`, `judgeCapabilities`). It does NOT drill into
// nested structures — a changed `causeCategories` array reports as the single key
// `causeCategories`, not a per-cause-id sub-diff. (Deeper diffing — e.g. the
// per-cause taxonomy diff — is DEFERRED to the cause-taxonomy board, RL1.)
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
  // Q7 — the report SUGGESTS a version bump; the CLI never auto-bumps. The author
  // hand-edits the `version` string in response to this hint.
  suggested_bump: z.string().optional(),
});
export type ProfileImpactReport = z.infer<typeof ProfileImpactReportSchema>;
