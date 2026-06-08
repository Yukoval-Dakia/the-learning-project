// Bug B (fix-docx-ingestion) — phase recovery from replayed SSE history.
//
// /record Vision state (sessionId + phase) used to live only in component
// useState, so switching tabs / leaving the page lost an in-flight ingestion
// even though the background job kept running. We now persist the active
// sessionId in the URL (?ingest=<id>); on mount VisionTab re-opens the SSE
// stream (the events route replays ALL history via Last-Event-ID) and derives
// the phase from that replayed history using this pure function.
//
// Pure + dependency-free on purpose: unit-tested in ingestion-phase.test.ts.

export interface PhaseEvent {
  event_type: string;
}

export interface ProgressEvent extends PhaseEvent {
  payload?: Record<string, unknown>;
}

export interface ExtractionProgress {
  done: number;
  total: number;
  stage?: string;
}

/**
 * Pick the latest `ingestion.extraction_progress` payload from replayed/live
 * events. Returns null when no progress event has arrived yet (the UI then
 * shows an indeterminate "等待 worker…" line). Pure — unit-tested.
 */
export function latestProgress(events: ProgressEvent[]): ExtractionProgress | null {
  let latest: ExtractionProgress | null = null;
  for (const e of events) {
    if (e.event_type !== 'ingestion.extraction_progress') continue;
    const p = e.payload ?? {};
    if (typeof p.done === 'number' && typeof p.total === 'number' && p.total > 0) {
      latest = {
        done: p.done,
        total: p.total,
        stage: typeof p.stage === 'string' ? p.stage : undefined,
      };
    }
  }
  return latest;
}

export type RecoverablePhase = 'extracting' | 'reviewing' | 'error';

/**
 * Derive the recovery phase from replayed ingestion job_events.
 *
 * Terminal events win (last-writer in the append-only history):
 *   - ingestion.imported           → reviewing is moot; treat as reviewing so the
 *     UI can load blocks (imported sessions are read-only but the blocks query
 *     still resolves). Callers that special-case "already imported" may branch
 *     before calling this; here we keep the simplest mapping.
 *   - ingestion.extraction_completed → 'reviewing' (load blocks)
 *   - ingestion.extraction_failed    → 'error'
 *   - none of the above              → 'extracting' (job still running; the
 *     replayed progress/extracting events keep the UI live)
 *
 * Synchronous text-line note: a hypothetical synchronous (pandoc/text) line
 * would already be 'extracted' before the SSE opens and would carry an
 * extraction_completed event in history → maps to 'reviewing' here, which is
 * correct. No such line exists in the current codebase (vision is the only
 * ingestion path), so this is a forward-compatible mapping, not dead code.
 */
export function derivePhaseFromEvents(events: PhaseEvent[]): RecoverablePhase {
  let phase: RecoverablePhase = 'extracting';
  for (const e of events) {
    if (e.event_type === 'ingestion.extraction_failed') {
      phase = 'error';
    } else if (
      e.event_type === 'ingestion.extraction_completed' ||
      e.event_type === 'ingestion.imported'
    ) {
      phase = 'reviewing';
    }
  }
  return phase;
}
