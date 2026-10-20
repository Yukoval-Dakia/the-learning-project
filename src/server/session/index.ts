// LearningSession multi-type module entrypoint (ADR-0008).
//
// Callers import namespaces:
//   import { Ingestion, Review } from '@/server/session';
//
// This is the only module exporting writes to `learning_session` (ADR-0005).

export type { LearningSessionTypeT } from '@/core/schema/learning_session';
export * as Conversation from './conversation';
export * as Ingestion from './ingestion';
export * as Placement from './placement';
export * as Review from './review';
export * as Tutor from './tutor';
