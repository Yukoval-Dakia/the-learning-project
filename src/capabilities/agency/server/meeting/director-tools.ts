// YUK-572 PR-2 §5 — director write-face MCP server (research_meeting_director).
//
// A hand-rolled in-process `createSdkMcpServer('research_meeting_director', …)` (NOT the
// DomainTool registry — reusing it would leak copilot's full propose face to the
// director, violating the minimal tool surface, §0.B). Registers the director-only
// tools: get_meeting_context (read the precomputed agenda snapshot) + propose_conjecture
// + leave_agent_note (both PROPOSE-only, server-enforced single writer).
//
// SINGLE-WRITER RED LINE: the LLM only fills tool args; every DB write, cap, dedup, Zod
// validation and baseline_p snapshot happens HERE in the handler closure. The model can
// never write the DB directly and can never self-report the numbers the server owns
// (baseline_p / confidence / recurrence). Caps are a closure counter (`caps`) shared with
// the orchestrator — the same "server-side count + soft-stop reason" pattern dreaming
// runs through buildMcpServer.beforeExecute, hosted here bespoke because the write face
// does not go through the registry (§0.B).

import type {
  AgentNoteTarget,
  WriteAgentNoteInput,
  writeAgentNote as WriteAgentNoteReal,
} from '@/capabilities/agency/server/notes';
import { writeAgentNote } from '@/capabilities/agency/server/notes';
import { ConjectureDraft } from '@/core/schema/business';
import type { Db } from '@/db/client';
import {
  filterPrimaryEvidenceRefs,
  isPrimaryEvidenceRef,
} from '@/server/agency/scout/report-findings';
import {
  DIRECTOR_SERVER_NAME,
  DIRECTOR_WRITE_TOOL_LOCAL_NAMES,
  EVIDENCE_READ_TOOL_NAMES,
  GET_TRACES_TOOL_NAME,
  SPAWN_TOOL_NAME,
} from '@/server/agency/scout/tool-names';
import { conjectureKey } from '@/server/conjectures/evidence';
import { getMasteryProjection } from '@/server/mastery/state';
import { type WriteAiProposalInput, writeAiProposal } from '@/server/proposals/writer';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// ── Server-side caps + constants (§5 / 附录 A #3) ──────────────────────────────

/** propose_conjecture per-run cap (§5.1). */
export const DIRECTOR_MAX_PROPOSALS = 3;
/** leave_agent_note per-run cap (§5). */
export const DIRECTOR_MAX_NOTES = 2;
/** Fixed conservative confidence stamped on every agent-lane conjecture — the LLM
 *  never self-reports it (no N=3 agreement tally exists on the single-judgment lane;
 *  a self-reported number would inflate — 附录 A #3). Internal sort only, never rendered. */
export const DIRECTOR_FIXED_CONFIDENCE = 0.4;
/** summary_md upper bound for leave_agent_note — truncate (dreaming/coach have no
 *  truncation channel on the read side, so the cap is enforced at write). */
export const DIRECTOR_NOTE_SUMMARY_MAX_CHARS = 1200;
/** agent-note TTL: 30 days (§5). */
export const AGENT_NOTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** actor_ref / source_task_kind stamped by the agent lane (shadow label, §8). */
export const RESEARCH_MEETING_AGENT_ACTOR = 'research_meeting_agent';
/** target_agents a director note may address (§5.2). */
export const AGENT_NOTE_TARGET_WHITELIST: readonly AgentNoteTarget[] = Object.freeze([
  'dreaming',
  'coach',
  'research_meeting',
]);

const [PROPOSE_CONJECTURE_LOCAL_NAME, LEAVE_AGENT_NOTE_LOCAL_NAME] =
  DIRECTOR_WRITE_TOOL_LOCAL_NAMES;
const GET_MEETING_CONTEXT_LOCAL_NAME = 'get_meeting_context';

/** WIRE name of the director agenda read tool (declared here — PR-2 owns it). */
export const GET_MEETING_CONTEXT_TOOL_NAME = `mcp__${DIRECTOR_SERVER_NAME}__${GET_MEETING_CONTEXT_LOCAL_NAME}`;

/**
 * The director's injected allowlist (§5). Options.tools is a RESTRICTIVE whitelist, so
 * every tool the director may call — including `Task` (which spawns the scout; agents{}
 * only DEFINES it, it does not auto-allow the spawn tool — E-1 / Lens A #6) — must be
 * listed literally. Ordered read → agenda → write → spawn.
 */
export const DIRECTOR_ALLOWED_TOOLS: readonly string[] = Object.freeze([
  ...EVIDENCE_READ_TOOL_NAMES,
  GET_TRACES_TOOL_NAME,
  GET_MEETING_CONTEXT_TOOL_NAME,
  ...DIRECTOR_WRITE_TOOL_LOCAL_NAMES.map((local) => `mcp__${DIRECTOR_SERVER_NAME}__${local}`),
  SPAWN_TOOL_NAME,
]);

// ── Types ─────────────────────────────────────────────────────────────────────

/** One salience-sorted candidate cell in the agenda snapshot (advisory — the input
 *  values the director reasons over; the propose handler RE-snapshots baseline_p). */
export interface MeetingCandidateCell {
  knowledge_id: string;
  cause_category: string;
  recurrence_count: number;
  /** advisory: reference value; the value written on propose is re-snapshotted server-side. */
  baseline_p: number | null;
  theta_precision: number | null;
  probe_here: boolean;
  evidence_event_ids: string[];
}

/** The pre-computed agenda snapshot returned by get_meeting_context (§5). */
export interface MeetingContext {
  pending_conjectures: Array<{
    knowledge_id: string;
    cause_category: string;
    claim_excerpt: string;
  }>;
  candidate_cells: MeetingCandidateCell[];
  recent_failure_summary: { window_days: number; total_failures: number; distinct_kcs: number };
}

/** Closure counters shared with the orchestrator — the server-side single writer. */
export interface DirectorCaps {
  proposeCount: number;
  noteCount: number;
}

export function createDirectorCaps(): DirectorCaps {
  return { proposeCount: 0, noteCount: 0 };
}

type WriteAiProposalFn = (db: Db, input: WriteAiProposalInput) => Promise<string>;
type WriteAgentNoteFn = typeof WriteAgentNoteReal;
type GetMasteryProjectionFn = typeof getMasteryProjection;

export interface BuildDirectorServerOpts {
  db: Db;
  now: Date;
  meetingContext: MeetingContext;
  /** dedup base: cause×KC keys that already carry a PENDING conjecture (ALL actors —
   *  the deterministic lane's proposals included; §0.D shadow-with-suppression). */
  knownConjectureKeys: Set<string>;
  caps: DirectorCaps;
  /** provenance: the run's trigger event id (caused_by) + the synthetic tool-context run
   *  id (proposal.task_run_id / note.source_task_run_id — the real SDK task_run_id is
   *  minted inside runAgentTask and unavailable at build time, so we mint a synthetic
   *  one up front, mirroring dreaming's toolContextTaskRunId). */
  triggerEventId: string;
  toolContextTaskRunId: string;
  writeAiProposalFn?: WriteAiProposalFn;
  writeAgentNoteFn?: WriteAgentNoteFn;
  getMasteryProjectionFn?: GetMasteryProjectionFn;
}

export type SdkMcpServer = ReturnType<typeof createSdkMcpServer>;

export interface DirectorServer {
  server: SdkMcpServer;
  readProposalIds(): string[];
  readNoteIds(): string[];
}

// ── Tool arg shapes (the LLM-fillable fields ONLY — server fills baseline_p /
//    recurrence_count / confidence, §5) ─────────────────────────────────────────

const ProposeConjectureShape = {
  knowledge_id: z.string().min(1),
  cause_category: z.string().min(1),
  claim_md: z.string().min(1),
  probe_md: z.string().min(1),
  probe_reference_md: z.string().min(1),
  predicted_p: z.number().min(0).max(1),
  discriminating: z.boolean(),
  // PRIMARY event ids only (attempt / probe / prediction_score) — agent_note ids are
  // filtered out server-side (§7 backstop).
  evidence_refs: z.array(z.string()),
} as const;
const ProposeConjectureSchema = z.object(ProposeConjectureShape);

const LeaveAgentNoteShape = {
  target_agents: z.array(z.string()).min(1),
  signal_kind: z.string().min(1),
  summary_md: z.string().min(1),
  refs: z.array(z.object({ kind: z.string(), id: z.string() })),
} as const;
const LeaveAgentNoteSchema = z.object(LeaveAgentNoteShape);

// ── Helpers ─────────────────────────────────────────────────────────────────

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Build the director write-face MCP server + the proposal/note id accessors. `caps` is
 * mutated in place (the single-writer counter); the readers surface what landed.
 */
export function buildDirectorServer(opts: BuildDirectorServerOpts): DirectorServer {
  const {
    db,
    now,
    meetingContext,
    knownConjectureKeys,
    caps,
    triggerEventId,
    toolContextTaskRunId,
  } = opts;
  const writeAiProposalFn = opts.writeAiProposalFn ?? writeAiProposal;
  const writeAgentNoteFn = opts.writeAgentNoteFn ?? writeAgentNote;
  const getMasteryProjectionFn = opts.getMasteryProjectionFn ?? getMasteryProjection;

  const proposalIds: string[] = [];
  const noteIds: string[] = [];
  // Same-run dedup: a cause×KC proposed this run is added so the director can't re-raise
  // the same cell inside one meeting (§5.2). Seeded empty; the pending base is checked
  // via knownConjectureKeys.
  const proposedThisRun = new Set<string>();
  // Cheap lookup for the server-owned recurrence_count / baseline_p snapshot.
  const cellByKey = new Map<string, MeetingCandidateCell>();
  for (const c of meetingContext.candidate_cells) {
    cellByKey.set(conjectureKey(c.cause_category as never, c.knowledge_id), c);
  }

  const server = createSdkMcpServer({
    name: DIRECTOR_SERVER_NAME,
    tools: [
      tool(
        GET_MEETING_CONTEXT_LOCAL_NAME,
        'Read the precomputed meeting agenda: currently-pending conjectures, up to 20 salience-sorted candidate knowledge-point × cause cells (MATERIAL, not orders — pick any, none, or a KC outside the list via an agent-note hint), and a recent-failure summary. baseline_p on each cell is advisory; the value written on propose is re-snapshotted server-side.',
        {},
        async () => textResult(meetingContext),
      ),
      // propose_conjecture — server-enforced single writer (§5). Every gate lives here;
      // the LLM only fills the draft fields. A rejected proposal returns { ok:false,
      // reason } (soft, so the director can react) and NEVER consumes a cap slot.
      tool(
        PROPOSE_CONJECTURE_LOCAL_NAME,
        'PROPOSE (not write) one conjecture about how the owner thinks + its discriminating probe. At most 3 per night; a cause×KC that already has a pending conjecture is refused. evidence_refs must be first-hand event ids (attempt / probe / prediction_score) — agent_note ids are stripped. You do NOT supply baseline mastery — the server snapshots it by knowledge point.',
        ProposeConjectureShape,
        async (args) => {
          // Cap FIRST — before any work, and it is not consumed by a later reject.
          if (caps.proposeCount >= DIRECTOR_MAX_PROPOSALS) {
            return textResult({
              ok: false,
              reason: `本晚提案上限 ${DIRECTOR_MAX_PROPOSALS} 已达，停止提议`,
            });
          }
          const parsed = ProposeConjectureSchema.safeParse(args);
          if (!parsed.success) {
            return textResult({ ok: false, reason: '入参校验失败', issues: parsed.error.issues });
          }
          const a = parsed.data;

          // First-hand evidence only (§7 backstop): strip agent_note ids. KNOWN GAP
          // (YUK-581 follow-up, doc'd in the spec §7): filterPrimaryEvidenceRefs only
          // excludes the agent_note ID SHAPE — it does NOT verify each surviving ref
          // actually resolves to a real attempt/probe/prediction_score event for THIS
          // knowledge_id/cause. The LLM's evidence_refs are asserted, not verified.
          // Blast radius is bounded (propose-only + owner inbox review + reconcile
          // joins on conjecture_event_id, never on evidence_refs, so settlement can't
          // be poisoned by a bogus ref) — server-side existence/ownership verification
          // is scope'd out of this PR as hardening.
          const primaryRefs = filterPrimaryEvidenceRefs(a.evidence_refs);
          if (primaryRefs.length === 0) {
            return textResult({
              ok: false,
              reason: '需至少一条一手证据（attempt/probe/prediction_score 事件 id）',
            });
          }

          // Pending-dedup: ALL pending (cross-actor) + same-run. candidate_cells is
          // already deduped against pending, but an off-menu pick could still collide.
          const key = conjectureKey(a.cause_category as never, a.knowledge_id);
          if (knownConjectureKeys.has(key) || proposedThisRun.has(key)) {
            return textResult({ ok: false, reason: '该错因×知识点已有 pending 猜想，换一个' });
          }

          // recurrence_count is server-owned: the matching cell's count, else the count
          // of first-hand refs the director cited. The ConjectureDraft ≥2 floor (below)
          // enforces the recurrence invariant either way (an off-menu pick with <2
          // first-hand refs is rejected with a clear validation error).
          const matchedCell = cellByKey.get(key);
          const recurrenceCount = matchedCell?.recurrence_count ?? primaryRefs.length;

          const draftCheck = ConjectureDraft.safeParse({
            claim_md: a.claim_md,
            probe_md: a.probe_md,
            probe_reference_md: a.probe_reference_md,
            cause_category: a.cause_category,
            recurrence_count: recurrenceCount,
            predicted_p: a.predicted_p,
            discriminating: a.discriminating,
            agreement_count: 1,
          });
          if (!draftCheck.success) {
            return textResult({
              ok: false,
              reason: 'ConjectureDraft 校验失败',
              issues: draftCheck.error.issues,
            });
          }

          // baseline_p auto-snapshot (§5.4): the cell's value, else the live mastery
          // projection, else the cold-start neutral 0.5 — the LLM NEVER supplies it.
          let baselineP = matchedCell?.baseline_p ?? null;
          if (baselineP === null) {
            const projection = await getMasteryProjectionFn(db, [a.knowledge_id]);
            baselineP = projection.get(a.knowledge_id)?.mastery ?? 0.5;
          }

          const input: WriteAiProposalInput = {
            actor_ref: RESEARCH_MEETING_AGENT_ACTOR,
            outcome: 'partial',
            payload: {
              kind: 'conjecture',
              target: { subject_kind: 'mind_model', subject_id: a.knowledge_id },
              reason_md: a.claim_md,
              evidence_refs: primaryRefs.map((id) => ({ kind: 'event' as const, id })),
              proposed_change: {
                claim_md: a.claim_md,
                knowledge_id: a.knowledge_id,
                cause_category: a.cause_category,
                confidence: DIRECTOR_FIXED_CONFIDENCE,
                recurrence_count: recurrenceCount,
                probe_md: a.probe_md,
                probe_reference_md: a.probe_reference_md,
                discriminating: a.discriminating,
                corrected_by_owner: false,
                predicted_p: a.predicted_p,
                baseline_p_at_induction: baselineP,
              },
              cooldown_key: `conjecture:${key}`,
            },
            caused_by_event_id: triggerEventId,
            task_run_id: toolContextTaskRunId,
            cost_usd: 0, // cost rides the director run's scan event, not each proposal (§5)
          };

          let proposalId: string;
          try {
            proposalId = await writeAiProposalFn(db, input);
          } catch (err) {
            // A CauseCategory / payload parse failure (writeAiProposal → parseAiProposalPayload)
            // is a validation reject, not a run-fatal error — return it so the director can fix.
            return textResult({
              ok: false,
              reason: `提案写入被拒（校验）: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          caps.proposeCount += 1;
          proposedThisRun.add(key);
          proposalIds.push(proposalId);
          return textResult({ ok: true, proposal_id: proposalId });
        },
      ),
      // leave_agent_note — server-enforced cap ≤2 + target whitelist + summary truncate +
      // primary-ref filter (§5). Writes an experimental:agent_note via writeAgentNote.
      tool(
        LEAVE_AGENT_NOTE_LOCAL_NAME,
        'Leave a SOFT hint (not a fact) for dreaming / coach / the next research meeting. At most 2 per night. summary_md is truncated to 1200 chars; refs must be first-hand event ids (agent_note ids are stripped).',
        LeaveAgentNoteShape,
        async (args) => {
          if (caps.noteCount >= DIRECTOR_MAX_NOTES) {
            return textResult({ ok: false, reason: `本晚软提示上限 ${DIRECTOR_MAX_NOTES} 已达` });
          }
          const parsed = LeaveAgentNoteSchema.safeParse(args);
          if (!parsed.success) {
            return textResult({ ok: false, reason: '入参校验失败', issues: parsed.error.issues });
          }
          const a = parsed.data;

          const whitelist = new Set<string>(AGENT_NOTE_TARGET_WHITELIST);
          const invalid = a.target_agents.filter((t) => !whitelist.has(t));
          if (invalid.length > 0) {
            return textResult({
              ok: false,
              reason: `target_agents 含非白名单项: ${invalid.join(', ')}（仅 ${AGENT_NOTE_TARGET_WHITELIST.join('/')}）`,
            });
          }

          const primaryRefs = a.refs.filter((r) => isPrimaryEvidenceRef(r.id));
          const note: WriteAgentNoteInput = {
            target_agents: a.target_agents as AgentNoteTarget[],
            source_task_kind: RESEARCH_MEETING_AGENT_ACTOR,
            source_task_run_id: toolContextTaskRunId,
            refs: primaryRefs,
            summary_md: truncate(a.summary_md, DIRECTOR_NOTE_SUMMARY_MAX_CHARS),
            signal_kind: a.signal_kind,
            expires_at: new Date(now.getTime() + AGENT_NOTE_TTL_MS).toISOString(),
            caused_by_event_id: triggerEventId,
          };
          const noteId = await writeAgentNoteFn(db, note);
          caps.noteCount += 1;
          noteIds.push(noteId);
          return textResult({ ok: true, note_id: noteId });
        },
      ),
    ],
  });

  return {
    server,
    readProposalIds: () => proposalIds,
    readNoteIds: () => noteIds,
  };
}
