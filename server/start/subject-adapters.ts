import { createStartGoal } from './goal-create-operation';
import { createStartLearningIntent } from './learning-intent-operation';
import { createStartSubject } from './subject-create-operation';
import { readStartSubjects } from './subject-reader';

// One family surface, constructed in the API graph when a Start operation first asks
// for it; each adapter keeps owning its own conversion, error and deadline handling.
export const subjectAdapters = {
  readStartSubjects,
  createStartSubject,
  createStartGoal,
  createStartLearningIntent,
};
