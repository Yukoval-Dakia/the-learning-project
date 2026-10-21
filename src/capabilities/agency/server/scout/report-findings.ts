// report_findings schema + capture seam + evidence-ref backstop.
//
// report_findings is the scout's ONLY output tool. The LLM fills the tool args; the TS
// orchestration layer reads them back through the capture closure and persists — the
// LLM NEVER writes the DB directly (single-writer red line).

import { z } from 'zod';

// The three-question task-book answers, plus a human-readable synthesis, primary
// evidence refs, and an internal calibration confidence.
//
// Passed to the SDK `tool()` factory as a RAW shape (ZodRawShape); ReportFindingsSchema
// is the standalone validator the orchestration layer uses on the captured value.
export const ReportFindingsShape = {
  single_or_multi_mechanism: z.enum(['single', 'multi', 'inconclusive']),
  evidence_attribution_contradiction: z.string().max(1500),
  suggested_probe_angle: z.string().max(800),
  findings_md: z.string().max(4000),
  // PRIMARY event ids only (attempt / review / probe / prediction_score) — NEVER agent_note ids.
  // The structural stop is filterPrimaryEvidenceRefs (below); the .max(12) caps blast radius.
  evidence_refs: z.array(z.string()).max(12),
  // Internal calibration only — NEVER rendered to the user as a number.
  confidence: z.number().min(0).max(1),
} as const;

export const ReportFindingsSchema = z.object(ReportFindingsShape);

export type ReportFindingsT = z.infer<typeof ReportFindingsSchema>;

/**
 * Single-writer capture: the report_findings handler sets `value` and the
 * orchestration layer reads it after the run. A mutable ref because the handler runs
 * inside the SDK tool loop, out of the caller's direct control flow.
 */
export interface FindingsCapture {
  value: ReportFindingsT | null;
}

export function createFindingsCapture(): FindingsCapture {
  return { value: null };
}

// agent_note ids are minted as `agent_note_<cuid>`; attempt / review / probe /
// prediction_score event ids do not carry this prefix.
const AGENT_NOTE_ID_PREFIX = 'agent_note_';

/** True when `id` is a first-hand (primary) evidence event id, i.e. NOT an agent_note. */
export function isPrimaryEvidenceRef(id: string): boolean {
  return !id.startsWith(AGENT_NOTE_ID_PREFIX);
}

/**
 * Strip agent_note ids from an evidence_refs list so a (possibly injection-poisoned)
 * finding cannot launder a soft hint into "evidence". Order-preserving pure filter;
 * the caller decides whether an empty result rejects the findings.
 */
export function filterPrimaryEvidenceRefs(refs: string[]): string[] {
  return refs.filter(isPrimaryEvidenceRef);
}
