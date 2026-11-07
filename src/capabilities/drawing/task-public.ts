// Task declarations only: composition must not initialize the application
// public barrel. The spec bundle is defined here directly — a re-export shell
// would be new pass-through debt under the architecture ratchet.
import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
import { drawingTaskSpec } from './tasks/drawing-task';

export const drawingTaskSpecs = defineOwnedTaskSpecs('drawing', {
  DrawingTask: drawingTaskSpec,
});
