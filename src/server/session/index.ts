// Phase 1c.1 Step 5 — LearningSession multi-type module entrypoint (ADR-0008).
//
// Callers import namespaces:
//
//   import { Ingestion, Review } from '@/server/session';
//   await Ingestion.enqueueExtraction({ db, boss, sessionId });
//   const { sessionId } = await Review.startReviewSession(db);
//
// This is the only module exporting writes to `learning_session` (ADR-0005
// single-owner invariant, extended to all session types). Tests in
// tests/integration/session-single-owner.test.ts assert this structurally.

export * as Conversation from './conversation';
export * as Tutor from './tutor';
export * as Ingestion from './ingestion';
export * as Review from './review';
export * as Placement from './placement';
export type { LearningSessionTypeT } from '@/core/schema/learning_session';
