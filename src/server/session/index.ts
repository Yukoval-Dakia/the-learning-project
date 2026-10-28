// LearningSession multi-type module entrypoint (ADR-0008).
//
// Non-ingestion callers import namespaces:
//   import { Conversation, Placement } from '@/server/session';
//
// Ingestion writes belong to @/capabilities/ingestion/server/session-lifecycle.
// Each session type has one lifecycle owner (ADR-0005).

export type { LearningSessionTypeT } from '@/core/schema/learning_session';
export * as Conversation from './conversation';
export * as Placement from './placement';
