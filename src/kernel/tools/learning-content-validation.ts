// Practice owns assessment policy for authored learning content (content check,
// solve check, teaching quality). Execution owners supply only the database and their
// task runtime. Practice binds the validator at API and worker startup.

import type { TaskTextResult } from '@/ai/task-result';
import type { Db } from '@/db/client';
import type {
  LearningContentValidationOutcome,
  LearningContentValidationRequest,
} from '@/kernel/tools/types';

type ValidationTaskRun = {
  bivarianceHack(kind: string, input: unknown, ctx?: object): Promise<TaskTextResult>;
}['bivarianceHack'];

export interface LearningContentValidationDeps {
  db: Db;
  runTaskFn: ValidationTaskRun;
}

export type LearningContentValidator = (
  content: LearningContentValidationRequest,
  deps: LearningContentValidationDeps,
) => Promise<LearningContentValidationOutcome>;

let installedValidator: LearningContentValidator | undefined;

export function installLearningContentValidator(validator: LearningContentValidator): void {
  installedValidator = validator;
}

export async function validateLearningContent(
  content: LearningContentValidationRequest,
  deps: LearningContentValidationDeps,
): Promise<LearningContentValidationOutcome> {
  if (!installedValidator) {
    throw new Error(
      'learning-content validator is not installed; call installPracticeHostOperations at startup',
    );
  }
  return installedValidator(content, deps);
}
