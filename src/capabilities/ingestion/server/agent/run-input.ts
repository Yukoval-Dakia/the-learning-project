import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { redactIngestionText } from '../privacy-guard';
import { recordAgentRedaction } from '../tools/redaction-sink';
import type { AgentRunLedger } from './ledger';

/** Does this op attempt to write the authority provenance field? (R2-3) */
function opTouchesSource(op: unknown): boolean {
  if (op == null || typeof op !== 'object') return false;
  const o = op as {
    op?: string;
    target?: { kind?: string };
    fields?: Record<string, unknown>;
    field?: string;
  };
  if (o.target?.kind !== 'question') return false;
  if (o.op === 'set' && o.fields != null && 'source' in o.fields) return true;
  if ((o.op === 'clear' || o.op === 'replace_text') && o.field === 'source') return true;
  return false;
}

/**
 * Deterministic per-run tool-call identity (P1-5.5): a redelivery of the same
 * logical call replays the owner's idempotent write instead of duplicating it.
 * Provenance is system-owned here: document seeds are force-stamped
 * `{kind:'photo_ingest', ref:'ingestion_agent:<session>'}` and any attempt to
 * set `source` through ops (or seed from a published question) is rejected —
 * a page-copied key is always traceable back to this lane.
 */
export function agentInterceptInput(sessionId: string) {
  const stamp = { kind: 'photo_ingest', ref: `ingestion_agent:${sessionId}` };
  return (tool: { name: string; effect: unknown }, args: unknown) => {
    const input = args as Record<string, unknown>;
    if (input == null) return { args };
    if (tool.name === 'submit_question' && typeof input.draft === 'object' && input.draft) {
      const draftRef = (input.draft as { draft_ref?: unknown }).draft_ref;
      return {
        args: { ...input, request_id: `r8:${sessionId}:submit:${String(draftRef)}` },
      };
    }
    if (tool.name === 'edit_question') {
      // R2-3: provenance is system-owned on this lane. Reject (softStop — the
      // model sees a clear tool error, the tool never runs):
      //   - ops that set/clear/replace the document 'source' field;
      //   - edits seeded from a published question (the seed would carry the
      //     published source over unstamped — this lane owns drafts only).
      if (input.question_id != null) {
        return {
          args,
          softStop:
            'edit_question(question_id) is not available on the ingestion lane — create or edit your own drafts via document/draft_ref only',
        };
      }
      const ops = Array.isArray(input.ops) ? (input.ops as unknown[]) : [];
      if (ops.some(opTouchesSource)) {
        return {
          args,
          softStop:
            "the 'source' provenance field is system-owned on the ingestion lane (it is stamped ingestion_agent automatically); do not set it",
        };
      }
      const next = { ...input };
      if (ops.length > 0) {
        // R3-3 belt-and-braces: append a re-stamp op AFTER the model's ops so
        // the last thing applied before persist is our stamp — no op kind
        // (incl. whole-document replacement) can leave a foreign source.
        next.ops = [...ops, { op: 'set', target: { kind: 'question' }, fields: { source: stamp } }];
      }
      next.request_id = `r8:${sessionId}:edit:${sha256CanonicalJson({
        action: input.action ?? null,
        draft_ref: input.draft_ref ?? null,
        document: input.document ?? null,
        ops: next.ops ?? input.ops ?? null,
      })}`;
      if (input.document && typeof input.document === 'object') {
        const doc = input.document as Record<string, unknown>;
        const modelSource =
          doc.source && typeof doc.source === 'object'
            ? (doc.source as { note?: unknown }).note
            : undefined;
        next.document = {
          ...doc,
          source: { ...stamp, ...(typeof modelSource === 'string' ? { note: modelSource } : {}) },
        };
      }
      return { args: next };
    }
    return { args };
  };
}

// ---------- segment input ----------

interface SegmentInputArgs {
  sessionId: string;
  documentId: string | null;
  packageSummary: { kind: string | null; page_count: number };
  derivationPolicy: string;
  ledger: AgentRunLedger;
  segment: number;
  trigger: 'start' | 'resume' | 'continue';
  /** Present on real segments; the resume builder redacts answers through it. */
  toolCtx?: Parameters<typeof recordAgentRedaction>[0];
}

/** Redact the free-text part of a resolved answer before it enters the resume input. */
function redactAskAnswerForInput(
  ctx: Parameters<typeof recordAgentRedaction>[0] | undefined,
  answer: unknown,
): unknown {
  if (
    ctx == null ||
    answer == null ||
    typeof answer !== 'object' ||
    (answer as { kind?: string }).kind !== 'text' ||
    typeof (answer as { text?: unknown }).text !== 'string'
  ) {
    return answer;
  }
  const redacted = redactIngestionText((answer as { text: string }).text);
  recordAgentRedaction(ctx, redacted);
  return { ...(answer as Record<string, unknown>), text: redacted.text };
}

export function buildAgentSegmentInput(args: SegmentInputArgs): string {
  const { ledger } = args;
  const resume = args.segment > 1 || ledger.items.length > 0 || ledger.asks.length > 0;
  const items = ledger.items.map((item) => ({
    item_id: item.item_id,
    question_no: item.question_no,
    status: item.status,
    ...(item.page !== undefined ? { page: item.page } : {}),
    ...(item.draft_ref !== undefined ? { draft_ref: item.draft_ref } : {}),
    ...(item.question_id !== undefined ? { question_id: item.question_id } : {}),
  }));
  const asks = ledger.asks.map((ask) => ({
    ask_id: ask.ask_id,
    item_id: ask.created.item_id,
    question_no: ask.created.question_no,
    prompt_md: ask.created.prompt_md,
    answer_kind: ask.created.answer_kind,
    expires_at: ask.created.expires_at,
    ...(ask.created.context_md != null ? { context_md: ask.created.context_md } : {}),
    // R2-2: learner answer text is model input — redact it on the resume path
    // exactly like the ask_learner poll path does.
    resolved: ask.resolved ? redactAskAnswerForInput(args.toolCtx, ask.resolved.answer) : null,
  }));
  return JSON.stringify({
    task: 'ingest_source_package',
    session_id: args.sessionId,
    document_id: args.documentId,
    package: args.packageSummary,
    derivation_policy: args.derivationPolicy,
    segment: args.segment,
    trigger: args.trigger,
    resume: resume
      ? {
          last_stage: ledger.stage,
          items,
          asks,
          note: 'Resume: items/asks above are durable truth. Continue unfinished items; resolved asks carry the learner answer; open asks are still pending — keep working on other items or end the turn again.',
        }
      : null,
  });
}
