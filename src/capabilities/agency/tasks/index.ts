import { legacyTaskDefinitions } from '@/ai/legacy-task-definitions';
import { defineOwnedTaskSpecs, defineTransitionalTask } from '@/ai/owned-task-specs';

export const agencyTaskSpecs = defineOwnedTaskSpecs('agency', {
  InterventionRecommendationTask: defineTransitionalTask(
    legacyTaskDefinitions.InterventionRecommendationTask,
  ),
  InterventionPackageAuthorTask: defineTransitionalTask(
    legacyTaskDefinitions.InterventionPackageAuthorTask,
  ),
  InterventionPackageReviewTask: defineTransitionalTask(
    legacyTaskDefinitions.InterventionPackageReviewTask,
  ),
  ResearchMeetingDirectorTask: defineTransitionalTask(
    legacyTaskDefinitions.ResearchMeetingDirectorTask,
  ),
  MemoryBriefTask: defineTransitionalTask(legacyTaskDefinitions.MemoryBriefTask),
  DreamingTask: defineTransitionalTask(legacyTaskDefinitions.DreamingTask),
  CoachTask: defineTransitionalTask(legacyTaskDefinitions.CoachTask),
});
