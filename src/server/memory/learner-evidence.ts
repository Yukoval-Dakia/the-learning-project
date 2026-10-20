// YUK-1629 — the event → learner-memory-input semantic mapping.
//
// A memory brief may only be driven by learner learning/feedback events
// (attempt / review / judge / correct / rate / record_capture / …).
// Question-bank authoring events audit changes to the bank itself — content
// edits, structured revisions, the draft pipeline, verify gates, canonical
// publish, archive/restore, block enrollment. They remain append-only audit
// history (event rows and affected_scopes are untouched) but are NOT learner
// evidence. This module owns that classification behind a narrow interface so
// every consumer stays in lockstep:
//
//   1. Extraction — buildMemoryEventIngestHandler (triggers.ts) conjoins this
//      predicate with the ADR-0039 actor gate BEFORE any mem0 call: a
//      user-actor question_edit would otherwise pass shouldExtractToMemory and
//      infer a revision "fact" into mem0, which a later brief's searchFacts
//      could then re-feed as evidence. Excluded events skip extraction, create
//      no reconcile handoff, and never mutate or delete existing memories.
//   2. Immediate refresh — the same handler fans out no enqueueBriefRegen for
//      the class: a canonical publish produces 0 memory_brief_regen jobs and
//      0 MemoryBriefTask calls.
//   3. Evidence reads — brief.ts loadEventsFromDb / scopeHasNewEvidence
//      exclude the class from both the brief event window and the "new
//      evidence" watermark check, so the nightly sweep cannot resurrect a
//      question revision as learning evidence (YUK-1559 C5 / YUK-1560
//      demand-driven downshift).
//
// Boundary: classify by action only — never actor_kind (real attempts can
// arrive on agent lanes) and never subject_kind (a real attempt's subject is
// also 'question'). The ADR-0039 actor gate stays intact; this predicate only
// narrows what reaches the paid surfaces, jointly with that gate.

import { inArray, sql } from 'drizzle-orm';
import { event } from '@/db/schema';

/**
 * Actions emitted by the question-bank authoring/publish pipeline. Every entry
 * was verified against its writeEvent site: each audits a bank-content mutation
 * (or its admission QA gate), not a learner interaction. Several of these
 * writers already stamp `ingest_at` (ADR-0021 outbox opt-out) — they are still
 * listed so the classification stays complete on the evidence-read side
 * regardless of write-time stamps.
 */
const QUESTION_BANK_AUTHORING_ACTIONS = [
  // Revision / draft audit (questions/write.ts, edit-question.ts,
  // proposal-appliers.ts)
  'experimental:question_edit',
  'experimental:question_structure_edit',
  'experimental:question_archive',
  'experimental:question_restore',
  'experimental:edit_question_block_structured',
  'experimental:question_draft_save',
  'experimental:question_draft_probe',
  'experimental:question_draft_submit',
  // Admission QA + canonical publish (verify jobs, submit-question,
  // kernel/records/assessment-publication.ts)
  'experimental:submit_question',
  'experimental:quiz_verify',
  'experimental:source_verify',
  'experimental:variant_verify',
  'experimental:assessment_publish',
  // Block creation / enrollment lifecycle (question_block-create-event.ts,
  // question-block-lifecycle-event.ts, auto-enroll.ts)
  'experimental:question_block_create',
  'experimental:question_block_lifecycle',
  'experimental:auto_enroll_observed',
] as const;

const NON_LEARNER_ACTIONS: ReadonlySet<string> = new Set(QUESTION_BANK_AUTHORING_ACTIONS);

/**
 * Row-level predicate for the ingest handler: does this event count as input to
 * the learner's memory? Bank-authoring actions return false; everything else
 * keeps its existing behavior.
 */
export function isLearnerEvidenceAction(action: string): boolean {
  return !NON_LEARNER_ACTIONS.has(action);
}

/**
 * Drizzle WHERE fragment applying the SAME classification to event-table scans
 * (brief evidence window + new-evidence watermark). `NOT inArray` keeps
 * semantics identical to the row-level predicate — the action list stays
 * private to this module so the two consumers can never drift.
 */
export function learnerEvidenceSql() {
  return sql`NOT (${inArray(event.action, [...QUESTION_BANK_AUTHORING_ACTIONS])})`;
}
