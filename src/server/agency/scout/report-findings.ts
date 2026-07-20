// YUK-572 / YUK-560 §2 — report_findings schema + capture seam + evidence-ref backstop
// (shared scout primitive).
//
// report_findings is the scout's ONLY output tool: the prompt forces "调查完必须调用
// 一次 report_findings 收尾". The LLM fills the tool args; the TS orchestration layer
// reads them back through the capture closure and persists — the LLM NEVER writes the
// DB directly (single-writer red line).

import { z } from 'zod';

// The three-question task-book answers (scout spec §2), plus a human-readable
// synthesis, primary evidence refs, and an internal calibration confidence.
//
// Passed to the SDK `tool()` factory as a RAW shape (ZodRawShape) — the SDK builds
// the z.object() internally for arg validation. The z.object() form (ReportFindingsSchema)
// is the standalone validator the orchestration layer uses on the captured value.
export const ReportFindingsShape = {
  // Q1 — single vs multi mechanism failure.
  single_or_multi_mechanism: z.enum(['single', 'multi', 'inconclusive']),
  // Q2 — where evidence and attribution contradict ("none" when they don't).
  evidence_attribution_contradiction: z.string().max(1500),
  // Q3 — the most discriminating probe angle.
  suggested_probe_angle: z.string().max(800),
  // Human-readable synthesis.
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
 * The single-writer capture closure. The report_findings handler sets `value`; the
 * orchestration layer reads it after the run. A mutable ref object (not a return
 * value) because the handler runs inside the SDK tool loop, out of the caller's
 * direct control flow.
 */
export interface FindingsCapture {
  value: ReportFindingsT | null;
}

/** A fresh, empty capture. */
export function createFindingsCapture(): FindingsCapture {
  return { value: null };
}

// agent_note ids are minted as `agent_note_<cuid>` (notes.ts writeAgentNote). A
// primary evidence ref is anything that is NOT an agent_note id — attempt / probe /
// prediction_score event ids do not carry this prefix.
const AGENT_NOTE_ID_PREFIX = 'agent_note_';

/** True when `id` is a first-hand (primary) evidence event id, i.e. NOT an agent_note. */
export function isPrimaryEvidenceRef(id: string): boolean {
  return !id.startsWith(AGENT_NOTE_ID_PREFIX);
}

/**
 * YUK-572 §7 red-line backstop: strip agent_note ids from an evidence_refs list so a
 * (possibly injection-poisoned) finding can never launder a soft hint into "evidence".
 * PURE FILTER (renamed from assert* — it never throws): returns ONLY primary refs,
 * order-preserving. The enforcement seam is the PR-2 orchestration layer, which
 * rejects the findings when this comes back empty ("need at least one first-hand
 * evidence ref") — a tool handler cannot enforce that contract because rejection
 * policy (warn vs discard) belongs to the run owner, not the capture.
 */
export function filterPrimaryEvidenceRefs(refs: string[]): string[] {
  return refs.filter(isPrimaryEvidenceRef);
}
