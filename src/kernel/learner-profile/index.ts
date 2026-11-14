// Learner-profile module public surface: batch read with freshness, atomic
// invalidation, and the worker drain. Consumers use readLearnerProfiles /
// readLearnerProfileNumbers — the shared per-KC numeric source — instead of
// recomputing mastery/retention from separate readers.

export {
  type CanonicalProfileInputs,
  buildProfileJudgments,
  loadCanonicalProfileInputs,
} from './build';
export { type ComponentRead, buildLearnerJudgmentItem } from './build-judgment';
export { PROFILE_INTENT_SOURCE, appendLearnerProfileIntent } from './intents';
export type { LearnerProfileNumbers, ProfileNumericSource } from './numbers';
export { readLearnerProfileNumbers } from './numbers';
export type { LearnerProfileRead, ProfileFreshness } from './read';
export { readLearnerProfiles, readLearnerProfilesAsBatch } from './read';
export { drainLearnerProfileRefresh } from './refresh';
