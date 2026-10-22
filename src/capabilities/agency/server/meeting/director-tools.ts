// Director write-face tool set (research_meeting_director).
//
// A bespoke in-process AgentTool set namespaced `mcp__research_meeting_director__*`;
// reusing the DomainTool registry would leak copilot's propose face to the director.
//
// SINGLE-WRITER RED LINE: the LLM only fills tool args; every DB write, cap, dedup,
// Zod validation and baseline_p snapshot happens in the handler closure. The model can
// never write the DB or self-report server-owned numbers (baseline_p / confidence /
// recurrence). Caps are closure counters shared with the orchestrator.

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  conjectureKey,
  effectiveCauseForConjectureFailure,
} from '@/capabilities/agency/server/conjecture/evidence';
import { CONJECTURE_EVIDENCE_CHOICES_PER_FIELD } from '@/capabilities/agency/server/conjecture/evidence-enrichment';
import {
  type ConjectureHistory,
  type LoadConjectureHistoryFn,
  applyConjectureHistoryGate,
  loadConjectureHistory,
} from '@/capabilities/agency/server/conjecture/history';
import {
  ConjectureProbeQualityOperationalError,
  type PrepareConjectureProbePairResult,
  prepareConjectureProbePair,
} from '@/capabilities/agency/server/conjecture/probe-quality';
import {
  type AgentNoteTarget,
  type WriteAgentNoteInput,
  type writeAgentNote as WriteAgentNoteReal,
  writeAgentNote,
} from '@/capabilities/agency/server/notes';
import {
  ConjectureDiagnosticSpecV2,
  ConjectureHypothesisProposalDraft,
} from '@/core/schema/business';
import { CauseCategoryId } from '@/core/schema/cause';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { type WriteAiProposalInput, writeAiProposal } from '@/kernel/proposals/writer';
import type { FailureAttempt } from '@/kernel/read-models/failure-attempts';
import { getFailureAttemptById } from '@/kernel/read-models/failure-attempts';
import { getMasteryProjection } from '@/kernel/read-models/mastery-projection';
import { resolveSubjectProfileForKnowledgeIds } from '@/kernel/read-models/subject-profile';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { piCustomTool } from '@/server/ai/tools/pi-tools';
import { filterPrimaryEvidenceRefs, isPrimaryEvidenceRef } from '../scout/report-findings';
import {
  DIRECTOR_SERVER_NAME,
  DIRECTOR_WRITE_TOOL_LOCAL_NAMES,
  EVIDENCE_READ_TOOL_NAMES,
  GET_TRACES_TOOL_NAME,
  SPAWN_TOOL_NAME,
} from '../scout/tool-names';
import { UNTRUSTED_TEXT_CHAR_CAP, wrapTruncatedLearnerText } from '../scout/untrusted-text';

// ── Server-side caps + constants ──────────────────────────────────────────────

/** propose_conjecture per-run cap. */
export const DIRECTOR_MAX_PROPOSALS = 3;
/** leave_agent_note per-run cap. */
export const DIRECTOR_MAX_NOTES = 2;
/** Fixed conservative confidence stamped on every agent-lane conjecture — the LLM
 *  never self-reports it (no N=3 agreement tally exists on the single-judgment lane;
 *  a self-reported number would inflate it). Internal sort only, never rendered. */
export const DIRECTOR_FIXED_CONFIDENCE = 0.4;
/** summary_md upper bound for leave_agent_note — truncate (dreaming/coach have no
 *  truncation channel on the read side, so the cap is enforced at write). */
export const DIRECTOR_NOTE_SUMMARY_MAX_CHARS = 1200;
/** agent-note TTL: 30 days. */
export const AGENT_NOTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** actor_ref / source_task_kind stamped by the agent lane. */
export const RESEARCH_MEETING_AGENT_ACTOR = 'research_meeting_agent';
/** target_agents a director note may address. */
export const AGENT_NOTE_TARGET_WHITELIST: readonly AgentNoteTarget[] = Object.freeze([
  'dreaming',
  'coach',
  'research_meeting',
]);

function wrapTextList(values: string[] | null): string[] | null {
  return (
    values
      ?.slice(0, CONJECTURE_EVIDENCE_CHOICES_PER_FIELD)
      .map((value) => wrapTruncatedLearnerText(value, UNTRUSTED_TEXT_CHAR_CAP)) ?? null
  );
}

/**
 * Director evidence is an immutable meeting snapshot that still contains
 * learner/question-authored text; truncate-then-delimit it without changing the
 * evidence shape or provenance.
 */
function sanitizeFailureAttemptForProbeQuality(failure: FailureAttempt): FailureAttempt {
  const sanitizeQuestion = (
    question: NonNullable<NonNullable<FailureAttempt['question_snapshot']>['parent_question']>,
  ) => ({
    ...question,
    prompt_md: wrapTruncatedLearnerText(question.prompt_md, UNTRUSTED_TEXT_CHAR_CAP),
    reference_md: wrapTruncatedLearnerText(question.reference_md, UNTRUSTED_TEXT_CHAR_CAP),
    choices_md: wrapTextList(question.choices_md),
  });
  const snapshot = failure.question_snapshot;
  return {
    ...failure,
    answer_md: wrapTruncatedLearnerText(failure.answer_md, UNTRUSTED_TEXT_CHAR_CAP),
    question_snapshot:
      snapshot == null
        ? snapshot
        : {
            ...snapshot,
            question: sanitizeQuestion(snapshot.question),
            parent_question:
              snapshot.parent_question === null ? null : sanitizeQuestion(snapshot.parent_question),
          },
    judge:
      failure.judge === undefined
        ? undefined
        : {
            ...failure.judge,
            cause: {
              ...failure.judge.cause,
              analysis_md: wrapTruncatedLearnerText(
                failure.judge.cause.analysis_md,
                UNTRUSTED_TEXT_CHAR_CAP,
              ),
            },
          },
    user_cause:
      failure.user_cause === undefined
        ? undefined
        : {
            ...failure.user_cause,
            user_notes: wrapTruncatedLearnerText(
              failure.user_cause.user_notes,
              UNTRUSTED_TEXT_CHAR_CAP,
            ),
          },
  };
}

// Literal names, not positional destructuring of DIRECTOR_WRITE_TOOL_LOCAL_NAMES:
// a reorder of that shared tuple would silently swap these string constants. The
// assignment below is the compile-time consistency check.
const PROPOSE_CONJECTURE_LOCAL_NAME = 'propose_conjecture';
const LEAVE_AGENT_NOTE_LOCAL_NAME = 'leave_agent_note';
const _directorWriteToolOrderCheck: readonly [
  typeof PROPOSE_CONJECTURE_LOCAL_NAME,
  typeof LEAVE_AGENT_NOTE_LOCAL_NAME,
] = DIRECTOR_WRITE_TOOL_LOCAL_NAMES;
void _directorWriteToolOrderCheck;
const GET_MEETING_CONTEXT_LOCAL_NAME = 'get_meeting_context';

/** WIRE name of the director agenda read tool. */
export const GET_MEETING_CONTEXT_TOOL_NAME = `mcp__${DIRECTOR_SERVER_NAME}__${GET_MEETING_CONTEXT_LOCAL_NAME}`;

/**
 * The director's injected allowlist. `options.tools` is a RESTRICTIVE whitelist, so
 * every callable tool — including `Task` (agents{} only defines the scout, it does not
 * auto-allow spawning) — must be listed literally.
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
  /** Required owner wording for a terminal identity that cleared the fresh-evidence floor. */
  prior_claim_md?: string;
}

/** The pre-computed agenda snapshot returned by get_meeting_context. */
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
type EvidenceRefsExistFn = (db: Db, refs: string[]) => Promise<boolean>;

// The probe author/reviewer currently receives FailureAttempt projections only.
// Keep the accepted event vocabulary exactly aligned with what that projection
// can materialize; accepting probe_result/prediction_score here would certify a
// proposal after silently dropping part of its cited evidence.
const PRIMARY_EVIDENCE_ACTIONS = ['attempt', 'review'] as const;

async function evidenceRefsExist(db: Db, refs: string[]): Promise<boolean> {
  if (refs.length === 0) return false;
  const rows = await db
    .select({ id: event.id, action: event.action })
    .from(event)
    .where(
      and(
        inArray(event.id, refs),
        inArray(event.action, PRIMARY_EVIDENCE_ACTIONS),
        or(
          ne(event.action, 'review'),
          and(eq(event.subject_kind, 'question'), eq(event.outcome, 'failure')),
        ),
      ),
    );
  if (rows.length !== refs.length) return false;
  const reviewIds = rows.filter((row) => row.action === 'review').map((row) => row.id);
  const activeReviews = await Promise.all(reviewIds.map((id) => getFailureAttemptById(db, id)));
  return activeReviews.every((review) => review !== null);
}

export interface BuildDirectorServerOpts {
  db: Db;
  now: Date;
  meetingContext: MeetingContext;
  /** dedup base: cause×KC keys that already carry a pending conjecture from any actor. */
  knownConjectureKeys: Set<string>;
  caps: DirectorCaps;
  /** provenance: the run's trigger event id (caused_by) plus the preallocated outer SDK
   *  task id used by both runAgentTask and its tool context. Sharing the real id lets
   *  nested same-lane runTask calls borrow the outer admission slot safely. */
  triggerEventId: string;
  toolContextTaskRunId: string;
  writeAiProposalFn?: WriteAiProposalFn;
  writeAgentNoteFn?: WriteAgentNoteFn;
  getMasteryProjectionFn?: GetMasteryProjectionFn;
  evidenceRefsExistFn?: EvidenceRefsExistFn;
  runTaskFn?: TaskTextRunFn;
  /** Outer director-attempt cancellation. Nested probe tasks inherit this signal,
   * but never the owning controller, so a child timeout cannot abort its parent. */
  parentLifecycleSignal: AbortSignal;
  resolveSubjectProfileForKnowledgeIdsFn?: typeof resolveSubjectProfileForKnowledgeIds;
  /** Same failure-attempt snapshot as the deterministic lane, read once at meeting
   * start. Only conjecture history is re-read fresh by the write handler below. */
  failureAttempts: FailureAttempt[];
  loadConjectureHistoryFn?: LoadConjectureHistoryFn;
}

export interface DirectorServer {
  /** Pi AgentTools mounted via a `custom` PiToolMount. */
  tools: AgentTool[];
  readProposalIds(): string[];
  readNoteIds(): string[];
  /**
   * Probe Author/Review outages are returned to the model as well-formed soft tool
   * results, then rethrown by the outer orchestrator so the worker can retry.
   */
  readRetryableProbeError(): Error | null;
}

// ── Tool arg shapes (LLM-fillable fields only — server fills baseline_p /
//    recurrence_count / confidence) ─────────────────────────────────────────────

const ProposeConjectureShape = {
  knowledge_id: z.string().min(1),
  cause_category: z.string().min(1),
  claim_md: z.string().min(1),
  diagnostic_spec: ConjectureDiagnosticSpecV2,
  // A terminal identity may reopen only after the director has read and echoed the
  // owner-corrected claim supplied by get_meeting_context (or a soft rejection).
  prior_claim_md: z.string().trim().min(1).max(280).optional(),
  // Materializable failed attempt/review ids only — agent_note ids are filtered
  // out server-side and other event kinds fail closed below. .max(12) mirrors the
  // scout's evidence_refs bound; the duplicate check stops one event id repeated N
  // times from inflating primaryRefs.length (and thus the off-menu recurrenceCount)
  // past the ≥2 first-hand-evidence floor.
  evidence_refs: z
    .array(z.string())
    .max(12)
    .refine((refs) => new Set(refs).size === refs.length, {
      message: 'evidence_refs must not contain duplicate event ids',
    }),
} as const;
const ProposeConjectureSchema = z.object(ProposeConjectureShape);

const LeaveAgentNoteShape = {
  // Duplicate guard for consistency with evidence_refs; the whitelist check is set-based.
  target_agents: z
    .array(z.string())
    .min(1)
    .refine((agents) => new Set(agents).size === agents.length, {
      message: 'target_agents must not contain duplicates',
    }),
  signal_kind: z.string().min(1),
  summary_md: z.string().min(1),
  // Same duplicate-id guard as propose_conjecture's evidence_refs; kind is normalized
  // to 'event' server-side, so id alone is the uniqueness key.
  refs: z
    .array(z.object({ kind: z.string(), id: z.string() }))
    .refine((refs) => new Set(refs.map((r) => r.id)).size === refs.length, {
      message: 'refs must not contain duplicate ids',
    }),
} as const;
const LeaveAgentNoteSchema = z.object(LeaveAgentNoteShape);

// ── Helpers ─────────────────────────────────────────────────────────────────

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const tool = (
  name: string,
  description: string,
  schema: Record<string, z.ZodTypeAny>,
  handler: (args: Record<string, unknown>) => Promise<ReturnType<typeof textResult>>,
): AgentTool => piCustomTool(DIRECTOR_SERVER_NAME, name, description, schema, handler);

// Visible marker on WRITE-side truncation: leave_agent_note.summary_md is persisted
// and consumed downstream by dreaming/coach, so a silent cut could be mistaken for the
// LLM's complete thought. Read-side caps (evidence-mcp truncate) stay unmarked.
export const NOTE_TRUNCATION_MARKER = '…[truncated]';

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= NOTE_TRUNCATION_MARKER.length) return text.slice(0, max); // degenerate: cap smaller than the marker itself
  return `${text.slice(0, max - NOTE_TRUNCATION_MARKER.length)}${NOTE_TRUNCATION_MARKER}`;
}

/**
 * Build the director write-face tool set; `caps` is mutated in place.
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
    failureAttempts,
  } = opts;
  const writeAiProposalFn = opts.writeAiProposalFn ?? writeAiProposal;
  const writeAgentNoteFn = opts.writeAgentNoteFn ?? writeAgentNote;
  const getMasteryProjectionFn = opts.getMasteryProjectionFn ?? getMasteryProjection;
  const evidenceRefsExistFn = opts.evidenceRefsExistFn ?? evidenceRefsExist;
  const baseRunTaskFn = opts.runTaskFn ?? makeRunTaskFn(db);
  // Keep the nested-run lineage and cancellation contract inside this module's
  // interface. Injected adapters cannot accidentally drop either field, while a
  // child only receives the signal and therefore cannot abort the parent controller.
  const runTaskFn: TaskTextRunFn = (kind, input, ctx) =>
    baseRunTaskFn(kind, input, {
      ...ctx,
      parentTaskRunId: toolContextTaskRunId,
      signal: opts.parentLifecycleSignal,
    });
  const loadConjectureHistoryFn = opts.loadConjectureHistoryFn ?? loadConjectureHistory;
  const resolveSubjectProfileForKnowledgeIdsFn =
    opts.resolveSubjectProfileForKnowledgeIdsFn ?? resolveSubjectProfileForKnowledgeIds;

  const proposalIds: string[] = [];
  const noteIds: string[] = [];
  // Operational outages are identity-scoped: a successful retry of key A resolves A,
  // but must not erase a still-unresolved outage on key B.
  const retryableProbeErrors = new Map<string, Error>();
  // Same-run dedup: a cause×KC proposed this run is added so the director can't re-raise
  // the same cell inside one meeting. The pending base is checked via knownConjectureKeys.
  const proposedThisRun = new Set<string>();
  const failureByAttemptId = new Map(
    failureAttempts.map((failure) => [failure.attempt_event_id, failure] as const),
  );
  // Cheap lookup for the server-owned recurrence_count / baseline_p snapshot.
  // c.cause_category comes from meetingContext.candidate_cells, a server-side
  // projection built from gatherConjectureEvidence() — never LLM input.
  const cellByKey = new Map<string, MeetingCandidateCell>();
  for (const c of meetingContext.candidate_cells) {
    cellByKey.set(conjectureKey(c.cause_category, c.knowledge_id), c);
  }

  const tools = [
    tool(
      GET_MEETING_CONTEXT_LOCAL_NAME,
      'Read the precomputed meeting agenda: currently-pending conjectures, up to 20 salience-sorted candidate knowledge-point × cause cells (MATERIAL, not orders — pick any, none, or a KC outside the list via an agent-note hint), and a recent-failure summary. baseline_p on each cell is advisory; the value written on propose is re-snapshotted server-side.',
      {},
      async () => textResult(meetingContext),
    ),
    // propose_conjecture — every gate lives here; the LLM only fills the draft fields.
    // A rejected proposal returns { ok:false, reason } (soft, so the director can react)
    // and never consumes a cap slot.
    tool(
      PROPOSE_CONJECTURE_LOCAL_NAME,
      'PROPOSE (not write) one conjecture about how the owner thinks plus a frozen DiagnosticSpec V2. New proposals must use schema_version=2 and set causal_direction_required=true for causal claims; V1 exists only to read historical rows. Do not author probes: the server runs the shared author + independent-review quality gate before writing. At most 3 per night; pending, lifecycle, and freshness gates still apply.',
      ProposeConjectureShape,
      async (args) => {
        if (opts.parentLifecycleSignal.aborted) {
          return textResult({ ok: false, reason: '父级 Director run 已取消，停止提案' });
        }
        // TOCTOU: Claude can emit multiple tool_use blocks in one turn, and handlers may
        // run back-to-back until their own first `await`. All synchronous validation
        // runs first, then the cap/dedup reservation lands before this handler's first
        // await; without that, a second same-cell call passes every check against the
        // same unreserved state. Every post-reservation failure must roll it back.
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

        // First-hand evidence only: strip agent_note ids before the existence gate.
        // The materialization gate below requires every surviving ref to be a text-only
        // failed attempt/review present in this meeting's immutable snapshot.
        const primaryRefs = filterPrimaryEvidenceRefs(a.evidence_refs);
        if (primaryRefs.length === 0) {
          return textResult({
            ok: false,
            reason: '需至少一条可物化的一手失败证据（attempt/review 事件 id）',
          });
        }

        // cause_category is LLM-supplied and must be validated before it feeds the
        // dedup key: a differently-cased or spaced string would hash to a different
        // conjectureKey and bypass pending-dedup.
        const causeCategoryCheck = CauseCategoryId.safeParse(a.cause_category);
        if (!causeCategoryCheck.success) {
          return textResult({
            ok: false,
            reason:
              'cause_category 格式不合法（须为小写字母数字下划线，字母开头）；请改用候选单元里出现过的错因类别',
          });
        }
        const causeCategory = causeCategoryCheck.data;

        // Pending-dedup: all pending (cross-actor) plus same-run. candidate_cells is
        // already deduped against pending, but an off-menu pick could still collide.
        const key = conjectureKey(causeCategory, a.knowledge_id);
        if (knownConjectureKeys.has(key) || proposedThisRun.has(key)) {
          return textResult({ ok: false, reason: '该错因×知识点已有 pending 猜想，换一个' });
        }

        // recurrence_count is server-owned: the matching cell's count, else the count
        // of first-hand refs the director cited.
        const matchedCell = cellByKey.get(key);
        const recurrenceCount = matchedCell?.recurrence_count ?? primaryRefs.length;

        // Check the hypothesis ≥2 recurrence floor explicitly with a human-readable
        // reason instead of surfacing a raw Zod dump for a fixable "cite one more ref".
        if (recurrenceCount < 2) {
          return textResult({
            ok: false,
            reason: '证据不足需≥2条一手证据，请补充或另选候选单元',
          });
        }

        const hypothesisCheck = ConjectureHypothesisProposalDraft.safeParse({
          kind: 'proposal',
          claim_md: a.claim_md,
          knowledge_id: a.knowledge_id,
          evidence_event_ids: primaryRefs,
          diagnostic_spec: a.diagnostic_spec,
          cause_category: causeCategory,
          recurrence_count: recurrenceCount,
        });
        if (!hypothesisCheck.success) {
          return textResult({
            ok: false,
            reason: 'Conjecture hypothesis 校验失败',
            issues: hypothesisCheck.error.issues,
          });
        }

        const referencedFailures = primaryRefs
          .map((eventId) => failureByAttemptId.get(eventId))
          .filter((failure): failure is FailureAttempt => failure !== undefined);
        if (referencedFailures.length !== primaryRefs.length) {
          return textResult({
            ok: false,
            reason:
              'evidence_refs 含本次质量门无法物化的事件；只可引用会议快照中的失败 attempt/review',
          });
        }
        for (const failure of referencedFailures) {
          const snapshot = failure.question_snapshot;
          if (snapshot == null) {
            return textResult({
              ok: false,
              reason: `证据 ${failure.attempt_event_id} 缺少有效题目快照，无法送入 probe 质量门`,
            });
          }
          const hasImages =
            failure.answer_image_refs.length > 0 ||
            snapshot.question.image_refs.length > 0 ||
            snapshot.question.figures.length > 0 ||
            (snapshot.parent_question?.image_refs.length ?? 0) > 0 ||
            (snapshot.parent_question?.figures.length ?? 0) > 0;
          if (hasImages) {
            return textResult({
              ok: false,
              reason: `证据 ${failure.attempt_event_id} 含图片/图形；当前 Director 质量门尚不能完整物化，拒绝静默丢弃`,
            });
          }
        }
        const probeEvidenceFailures = referencedFailures.map(sanitizeFailureAttemptForProbeQuality);

        // Keep the cap/dedup reservation immediately before this handler's first await.
        // Validation failures above remain free; evidence lookup failures below are
        // rolled back just like write-time failures.
        caps.proposeCount += 1;
        proposedThisRun.add(key);
        let reservationReleased = false;
        const releaseReservation = () => {
          if (reservationReleased) return;
          reservationReleased = true;
          caps.proposeCount -= 1;
          proposedThisRun.delete(key);
        };

        let refsExist: boolean;
        try {
          refsExist = await evidenceRefsExistFn(db, primaryRefs);
        } catch (err) {
          releaseReservation();
          return textResult({
            ok: false,
            reason: `evidence_refs 事件校验失败: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
        if (!refsExist) {
          releaseReservation();
          return textResult({
            ok: false,
            reason: 'evidence_refs 含不存在或非一手证据类型的事件 id',
          });
        }

        let historyByKey: Map<string, ConjectureHistory>;
        try {
          historyByKey = await loadConjectureHistoryFn(db, [
            {
              key,
              knowledge_id: a.knowledge_id,
            },
          ]);
        } catch (err) {
          releaseReservation();
          return textResult({
            ok: false,
            reason: `conjecture history 加载失败: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }

        try {
          // Fresh terminal-reopen evidence is identity-scoped, not merely meeting-scoped:
          // only cited failures attributed to this exact cause × KC may satisfy the floor.
          const identityFailureRefs = primaryRefs.filter((eventId) => {
            const failure = failureByAttemptId.get(eventId);
            if (!failure || !failure.referenced_knowledge_ids.includes(a.knowledge_id)) {
              return false;
            }
            return effectiveCauseForConjectureFailure(failure)?.primary_category === causeCategory;
          });
          const historyGate = applyConjectureHistoryGate(
            [{ key, evidence_event_ids: identityFailureRefs }],
            failureAttempts,
            historyByKey,
            now,
          );
          if (historyGate.cells.length === 0) {
            releaseReservation();
            return textResult({
              ok: false,
              reason: '该错因×知识点受 owner decision / conjecture lifecycle gate 阻断',
            });
          }
          const requiredPriorClaimMd = historyGate.priorClaimMdByKey.get(key);
          if (
            requiredPriorClaimMd !== undefined &&
            a.prior_claim_md?.trim() !== requiredPriorClaimMd
          ) {
            releaseReservation();
            return textResult({
              ok: false,
              reason: '该 terminal 猜想重开前必须读取并原样回传 owner prior_claim_md',
              prior_claim_md: requiredPriorClaimMd,
            });
          }
        } catch (err) {
          releaseReservation();
          return textResult({
            ok: false,
            reason: `conjecture history gate 校验失败: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }

        let probeQuality: PrepareConjectureProbePairResult;
        try {
          const subjectProfile = await resolveSubjectProfileForKnowledgeIdsFn(db, [a.knowledge_id]);
          probeQuality = await prepareConjectureProbePair({
            hypothesis: hypothesisCheck.data,
            evidencePayload: {
              evidence_refs: primaryRefs,
              failure_attempts: probeEvidenceFailures,
            },
            // Image-bearing snapshots fail closed above. Unlike the deterministic
            // nightly lane, Director currently has no asset loader, so [] means
            // "verified text-only evidence", never silently dropped visual evidence.
            evidenceImages: [],
            runTaskFn,
            subjectProfile,
          });
        } catch (err) {
          releaseReservation();
          if (opts.parentLifecycleSignal.aborted) {
            return textResult({ ok: false, reason: '父级 Director run 已取消，停止提案' });
          }
          const taskKind =
            err instanceof ConjectureProbeQualityOperationalError ? err.taskKind : 'unknown';
          retryableProbeErrors.set(
            key,
            err instanceof Error
              ? err
              : new Error(`probe quality gate operational failure: ${String(err)}`),
          );
          console.error('[director-tools] conjecture probe quality gate failed', err);
          return textResult({
            ok: false,
            reason: `probe quality gate operational failure (${taskKind}); retry later`,
          });
        }
        // The same identity reached a real quality conclusion, so its earlier outage
        // (if any) is resolved. Other identities remain latched for worker recovery.
        retryableProbeErrors.delete(key);
        if (opts.parentLifecycleSignal.aborted) {
          releaseReservation();
          return textResult({ ok: false, reason: '父级 Director run 已取消，停止提案' });
        }
        if (probeQuality.outcome === 'rejected') {
          releaseReservation();
          return textResult({
            ok: false,
            reason: '两次完整探针包均未通过质量门；本次不创建猜想提案',
            probe_quality_attempts: probeQuality.attempts,
          });
        }

        // baseline_p auto-snapshot: the cell's value, else the live mastery
        // projection, else the cold-start neutral 0.5 — the LLM never supplies it.
        let baselineP = matchedCell?.baseline_p ?? null;
        if (baselineP === null) {
          // A mastery-projection read is advisory input to the server-owned snapshot,
          // not a proposal validity gate: fall back to the cold-start neutral 0.5
          // rather than rejecting an otherwise-valid proposal.
          try {
            const projection = await getMasteryProjectionFn(db, [a.knowledge_id]);
            baselineP = projection.get(a.knowledge_id)?.mastery ?? 0.5;
          } catch (err) {
            console.error(
              '[director-tools] getMasteryProjectionFn failed — falling back to baseline_p=0.5',
              err,
            );
            baselineP = 0.5;
          }
        }

        // The nested quality run can finish at the same instant that the outer
        // director times out or loses its provider lease. Recheck at the final
        // pre-write seam so a completed child cannot START publishing after the
        // parent has already degraded and released its admission permit. A write
        // already in flight retains the proposal writer's own transaction semantics.
        if (opts.parentLifecycleSignal.aborted) {
          releaseReservation();
          return textResult({ ok: false, reason: '父级 Director run 已取消，停止提案' });
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
              cause_category: causeCategory,
              confidence: DIRECTOR_FIXED_CONFIDENCE,
              recurrence_count: recurrenceCount,
              probe_md: probeQuality.package.primary.prompt_md,
              probe_reference_md: probeQuality.package.primary.reference_md,
              followup_probe_md: probeQuality.package.followup.prompt_md,
              followup_probe_reference_md: probeQuality.package.followup.reference_md,
              diagnostic_spec: hypothesisCheck.data.diagnostic_spec,
              probe_spec: probeQuality.package.primary,
              followup_probe_spec: probeQuality.package.followup,
              probe_quality: probeQuality.audit,
              discriminating: true,
              corrected_by_owner: false,
              predicted_p: probeQuality.package.predicted_p,
              baseline_p_at_induction: baselineP,
            },
            cooldown_key: `conjecture:${key}`,
          },
          caused_by_event_id: triggerEventId,
          event_override: {
            action: 'experimental:proposal',
            subject_kind: 'mind_model',
            subject_id: a.knowledge_id,
            payload: {
              director_tool_context_task_run_id: toolContextTaskRunId,
              probe_quality_task_run_ids: probeQuality.task_run_ids,
              probe_quality_attempts: probeQuality.attempts,
            },
          },
          task_run_id: probeQuality.primary_task_run_id ?? toolContextTaskRunId,
          cost_usd: probeQuality.cost_usd,
        };

        let proposalId: string;
        try {
          proposalId = await writeAiProposalFn(db, input);
        } catch (err) {
          // A validation reject (writeAiProposal → parseAiProposalPayload) is retryable,
          // not run-fatal: return it so the director can fix and roll back the reservation.
          releaseReservation();
          return textResult({
            ok: false,
            reason: `提案写入被拒（校验）: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        proposalIds.push(proposalId);
        return textResult({ ok: true, proposal_id: proposalId });
      },
    ),
    // leave_agent_note — server-enforced cap ≤2 + target whitelist + summary truncate +
    // primary-ref filter. Writes an experimental:agent_note via writeAgentNote.
    tool(
      LEAVE_AGENT_NOTE_LOCAL_NAME,
      'Leave a SOFT hint (not a fact) for dreaming / coach / the next research meeting. At most 2 per night. summary_md is truncated to 1200 chars; refs must be first-hand event ids (agent_note ids are stripped).',
      LeaveAgentNoteShape,
      async (args) => {
        if (opts.parentLifecycleSignal.aborted) {
          return textResult({ ok: false, reason: '父级 Director run 已取消，停止写入软提示' });
        }
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

        // An empty refs[] is a legitimate pure textual hint. Only reject the case
        // where refs was non-empty but every entry was an agent_note id (soft hints
        // masquerading as primary evidence). Kind is normalized to 'event' server-side
        // so the model cannot inject an arbitrary string into agent_note.refs[].kind.
        const primaryRefs = a.refs
          .filter((r) => isPrimaryEvidenceRef(r.id))
          .map((r) => ({ kind: 'event' as const, id: r.id }));
        if (a.refs.length > 0 && primaryRefs.length === 0) {
          return textResult({
            ok: false,
            reason: '全部 refs 都是软提示引用（非一手证据），请改用一手事件 id 或留空',
          });
        }
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
        // Same TOCTOU fix as propose_conjecture: reserve the cap slot synchronously
        // before the first await and roll it back on write failure.
        caps.noteCount += 1;
        let noteId: string;
        try {
          noteId = await writeAgentNoteFn(db, note);
        } catch (err) {
          caps.noteCount -= 1;
          return textResult({
            ok: false,
            reason: `note 写入被拒（校验/DB）: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        noteIds.push(noteId);
        return textResult({ ok: true, note_id: noteId });
      },
    ),
  ];

  return {
    tools,
    readProposalIds: () => proposalIds,
    readNoteIds: () => noteIds,
    readRetryableProbeError: () => retryableProbeErrors.values().next().value ?? null,
  };
}
