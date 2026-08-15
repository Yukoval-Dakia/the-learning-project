import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
import { coachTaskSpec } from './coach';
import { conjectureGroupingTaskSpec, mindModelInductionTaskSpec } from './conjecture-induction';
import { conjectureProbeAuthorTaskSpec, conjectureProbeReviewTaskSpec } from './conjecture-probe';
import { dreamingTaskSpec } from './dreaming';
import { goalScopeTaskSpec } from './goal-scope';
import {
  interventionPackageAuthorTaskSpec,
  interventionPackageReviewTaskSpec,
  interventionRecommendationTaskSpec,
} from './intervention';
import { learningIntentOutlineTaskSpec } from './learning-intent';
import { memoryBriefTaskSpec } from './memory-brief';
import { researchMeetingDirectorTaskSpec } from './research-meeting-director';

export const agencyTaskSpecs = defineOwnedTaskSpecs('agency', {
  LearningIntentOutlineTask: learningIntentOutlineTaskSpec,
  GoalScopeTask: goalScopeTaskSpec,
  MindModelInductionTask: mindModelInductionTaskSpec,
  ConjectureGroupingTask: conjectureGroupingTaskSpec,
  ConjectureProbeAuthorTask: conjectureProbeAuthorTaskSpec,
  ConjectureProbeReviewTask: conjectureProbeReviewTaskSpec,
  InterventionRecommendationTask: interventionRecommendationTaskSpec,
  InterventionPackageAuthorTask: interventionPackageAuthorTaskSpec,
  InterventionPackageReviewTask: interventionPackageReviewTaskSpec,
  ResearchMeetingDirectorTask: researchMeetingDirectorTaskSpec,
  DreamingTask: dreamingTaskSpec,
  CoachTask: coachTaskSpec,
  MemoryBriefTask: memoryBriefTaskSpec,
});
