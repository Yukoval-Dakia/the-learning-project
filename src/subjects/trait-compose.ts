// Inverse pure mapping between SubjectProfile and the six trait payloads, plus
// the assembly version. Browser-safe. Assembly reproduces the existing profile
// shape so server consumers see no change.

import type { SubjectProfile } from './profile-schema';
import type { SubjectTraitPayloads } from './trait-schemas';

export function decomposeProfileToTraitPayloads(profile: SubjectProfile): SubjectTraitPayloads {
  return {
    charter: {
      languageStyle: profile.languageStyle,
      roleNoun: profile.promptFragments.roleNoun,
      noteExamplePolicy: profile.promptFragments.noteExamplePolicy,
      variantExamplePolicy: profile.promptFragments.variantExamplePolicy,
      teachingStyle: profile.promptFragments.teachingStyle,
      checkQuestionPolicy: profile.promptFragments.checkQuestionPolicy,
      learningIntentPolicy: profile.promptFragments.learningIntentPolicy,
      noteTemplate: { ...profile.noteTemplate },
      // Runtime objects are raw literals and may predate these two sections.
      methodology: profile.promptFragments.methodology ?? '',
      rubricGuidance: profile.promptFragments.rubricGuidance ?? '',
    },
    judge_policy: {
      questionKinds: [...profile.questionKinds],
      judgePolicy: {
        preferredRoutes: [...profile.judgePolicy.preferredRoutes],
        notes: [...profile.judgePolicy.notes],
      },
      judgeCapabilities: [...profile.judgeCapabilities],
      ratingPolicy: structuredClone(profile.ratingPolicy),
    },
    cause_taxonomy: {
      causeCategories: profile.causeCategories.map((c) => ({ ...c })),
    },
    source_policy: {
      grounding: {
        requirement: profile.grounding.requirement,
        allowedSources: [...profile.grounding.allowedSources],
        uncertaintyPolicy: profile.grounding.uncertaintyPolicy,
      },
      sourceWhitelist: [...profile.sourceWhitelist],
      ...(profile.sourcingRoutePreference !== undefined
        ? { sourcingRoutePreference: structuredClone(profile.sourcingRoutePreference) }
        : {}),
      exampleSources: [...profile.exampleSources],
    },
    render_theme: {
      renderConfig: { ...profile.renderConfig },
    },
    scheduling: {
      schedulingHints: structuredClone(profile.schedulingHints),
    },
  };
}

export function assembleSubjectProfile(args: {
  id: string;
  displayName: string;
  // The composed judge identity string; the schema only requires a non-empty string.
  version: string;
  payloads: SubjectTraitPayloads;
}): SubjectProfile {
  const { charter, judge_policy, cause_taxonomy, source_policy, render_theme, scheduling } =
    args.payloads;
  return {
    id: args.id,
    version: args.version,
    displayName: args.displayName,
    languageStyle: charter.languageStyle,
    questionKinds: [...judge_policy.questionKinds],
    judgePolicy: {
      preferredRoutes: [...judge_policy.judgePolicy.preferredRoutes],
      notes: [...judge_policy.judgePolicy.notes],
    },
    exampleSources: [...source_policy.exampleSources],
    noteTemplate: { ...charter.noteTemplate },
    grounding: {
      requirement: source_policy.grounding.requirement,
      allowedSources: [...source_policy.grounding.allowedSources],
      uncertaintyPolicy: source_policy.grounding.uncertaintyPolicy,
    },
    promptFragments: {
      roleNoun: charter.roleNoun,
      noteExamplePolicy: charter.noteExamplePolicy,
      variantExamplePolicy: charter.variantExamplePolicy,
      teachingStyle: charter.teachingStyle,
      checkQuestionPolicy: charter.checkQuestionPolicy,
      learningIntentPolicy: charter.learningIntentPolicy,
      methodology: charter.methodology,
      rubricGuidance: charter.rubricGuidance,
    },
    causeCategories: cause_taxonomy.causeCategories.map((c) => ({ ...c })),
    ratingPolicy: structuredClone(judge_policy.ratingPolicy),
    renderConfig: { ...render_theme.renderConfig },
    schedulingHints: structuredClone(scheduling.schedulingHints),
    judgeCapabilities: [...judge_policy.judgeCapabilities],
    sourceWhitelist: [...source_policy.sourceWhitelist],
    ...(source_policy.sourcingRoutePreference !== undefined
      ? { sourcingRoutePreference: structuredClone(source_policy.sourcingRoutePreference) }
      : {}),
  };
}

// Composed at assembly, never persisted. Each part is trait_id@identity, where
// identity is the live revision or the seed identity actually used, so the string
// always names the configuration in effect. Render and scheduling are excluded
// because they cannot affect judging.
export type TraitVersionComponent = { traitId: string; effective: number | `seed:${string}` };

export function composeJudgeTraitVersion(components: {
  charter: TraitVersionComponent;
  judge_policy: TraitVersionComponent;
  cause_taxonomy: TraitVersionComponent;
  source_policy: TraitVersionComponent;
}): string {
  const part = (c: TraitVersionComponent) => `${c.traitId}@${c.effective}`;
  return `jt:${part(components.charter)};${part(components.judge_policy)};${part(components.cause_taxonomy)};${part(components.source_policy)}`;
}
