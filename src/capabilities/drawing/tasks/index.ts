import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
import { drawingTaskSpec } from './drawing-task';

export const drawingTaskSpecs = defineOwnedTaskSpecs('drawing', {
  DrawingTask: drawingTaskSpec,
});
