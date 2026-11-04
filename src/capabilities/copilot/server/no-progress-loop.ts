// A repeated identical call — the same signature again, or the same tool
// returning the identical result — ends the loop for lack of new evidence.
// Overlapping reads across different tools are normal and do not count.
// Once the loop closes, further root tool calls are denied so the model
// writes its answer from the evidence already collected; a model that keeps
// calling anyway is hard-stopped after a few denials. A settled
// non-mutating call anchors the closing window whether the read returned
// evidence or failed, so an error-only chain stops before the hard timeout.
// Turns, tool counts and spend stay uncapped (the 45 minute recovery window
// is unchanged). The stop is the repeat or that landing, not a fee or
// iteration ceiling.

import { createHash } from 'node:crypto';
import {
  type HelpProviderFault,
  helpExitLead,
  readHelpProviderFault,
} from '@/ai/help-provider-fault';
import type { PiAfterToolCall, PiBeforeToolCall } from '@/core/tool-call-contract';
import type { Db, Tx } from '@/db/client';
import { writeEvaluationCorrectionProposal } from '@/kernel/proposals/producers';
import { getQuestionTimeline } from '@/kernel/read-models/question-activity';

/** How long before the execution abort a further tool call is refused. */
export const NO_PROGRESS_BUDGET_LANDING_MARGIN_MS = 60_000;

const BLOCK_REASON =
  'more tool calls are returning no new evidence; stop and answer from what was collected';
const BUDGET_BLOCK_REASON =
  'execution window is closing; stop and answer from the evidence already collected';
const HELP_FAULT_BLOCK_REASON =
  'provider quota, gateway, or parse failure; stop and answer from the deterministic exit';

export type NoProgressCloseReason =
  | 'no_progress'
  | 'budget_landing'
  | 'help_quota'
  | 'help_bad_gateway'
  | 'help_parse';

export type EvidenceKind =
  | 'event'
  | 'attempt'
  | 'evaluation'
  | 'question'
  | 'judge_event'
  | 'knowledge'
  | 'outcome'
  | 'dispute'
  | 'tool_summary';

export interface EvidenceFact {
  readonly kind: EvidenceKind;
  readonly id: string;
  readonly tool: string;
  readonly detail?: string;
}

export interface NoProgressClosure {
  readonly reason: NoProgressCloseReason;
  readonly evidence: readonly EvidenceFact[];
}

export type VerifiedFallback =
  | {
      readonly kind: 'grading_correction';
      readonly operation: 'writeEvaluationCorrectionProposal';
      readonly evaluationId: string;
      readonly attemptEventId: string | null;
      /** explicit: the same object stated a dispute reason. none: ids only. */
      readonly dispute: 'explicit' | 'none';
    }
  | {
      readonly kind: 'continue_session';
      readonly operation: 'durable_copilot_session';
      readonly sessionId: string;
      readonly questionId: string | null;
      readonly attemptEventIds: readonly string[];
    };

/** Written only after the reply marker is accepted in the settlement transaction. */
export interface SealedCorrectionFiling {
  readonly evaluationId: string;
  readonly attemptEventId: string | null;
  readonly reasonMd: string;
  readonly evidenceEventIds: readonly string[];
  readonly actorRef: string;
  readonly taskRunId: string;
  readonly causedByEventId?: string;
}

type Phase =
  | { readonly status: 'collecting' }
  | { readonly status: 'closed'; readonly reason: NoProgressCloseReason };

/** Closing is the last minute before the hard timeout. Ready means a
 *  non-mutating root call has already settled. Success and error are the
 *  same anchor; a mutation never sets it. */
type BudgetLanding = {
  readonly window: 'open' | 'closing';
  readonly anchor: 'waiting' | 'ready';
};

type SettledRootCall =
  | { readonly kind: 'mutation'; readonly applied: boolean }
  | { readonly kind: 'read' };

function budgetLandingDue(state: BudgetLanding): boolean {
  return state.window === 'closing' && state.anchor === 'ready';
}

/** Blocked calls delivered while closed before the next one terminates the
 *  loop. Gives the model room to write its answer without buying an
 *  unbounded denial loop. */
const SOFT_DENIAL_LIMIT = 3;

const ID_KEYS: Record<string, EvidenceKind> = {
  evaluation_id: 'evaluation',
  effective_evaluation_id: 'evaluation',
  original_evaluation_id: 'evaluation',
  judge_event_id: 'judge_event',
  effective_event_id: 'judge_event',
  attempt_event_id: 'attempt',
  attemptEventId: 'attempt',
  question_id: 'question',
  knowledge_id: 'knowledge',
  node_id: 'knowledge',
  from_knowledge_id: 'knowledge',
  to_knowledge_id: 'knowledge',
};

const MUTATION_NAME =
  /^(propose_|write_|author_|edit_|update_|submit_|file_|archive_|restore_|dismiss_)/;

function classifyRootCall(tool: string, isError: boolean): SettledRootCall {
  if (MUTATION_NAME.test(tool)) return { kind: 'mutation', applied: !isError };
  return { kind: 'read' };
}

function domainToolName(name: string): string {
  const separator = name.lastIndexOf('__');
  return separator === -1 ? name : name.slice(separator + 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? 'null';
  const keys = Object.keys(value)
    .filter((key) => key !== 'context_budget' && key !== 'tool_use_id')
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function signatureOf(tool: string, args: Record<string, unknown>): string {
  return sha256(`${domainToolName(tool)}\n${stable(args)}`);
}

function parsePayload(output: unknown): unknown {
  if (typeof output === 'string') return parseText(output);
  if (!Array.isArray(output)) return output ?? null;
  const text = output
    .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
    .filter((part) => part.length > 0)
    .join('\n');
  return text.length > 0 ? parseText(text) : null;
}

function parseText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { summary: text.slice(0, 180) };
  }
}

function fingerprintOf(payload: unknown): string {
  const body = isRecord(payload) && 'output' in payload ? payload.output : payload;
  return sha256(stable(body));
}

function collectFacts(payload: unknown, tool: string): EvidenceFact[] {
  const facts: EvidenceFact[] = [];
  walk(payload, tool, facts, 0);
  return facts;
}

const STRING_LIST_KEYS = new Set(['node_ids', 'knowledge_ids', 'referenced_knowledge_ids']);
const DISPUTE_REASON_KEYS = ['dispute_reason', 'appeal_reason_md', 'contest_reason_md'] as const;
const EVALUATION_ID_KEYS = [
  'evaluation_id',
  'effective_evaluation_id',
  'original_evaluation_id',
] as const;

function walk(value: unknown, tool: string, facts: EvidenceFact[], depth: number): void {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, tool, facts, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  const disputeReason = disputeReasonOf(value);
  const disputeEvaluationId = evaluationIdOf(value);
  if (disputeReason && disputeEvaluationId) {
    facts.push({ kind: 'dispute', id: disputeEvaluationId, tool, detail: disputeReason });
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'context_budget' || key === 'tool_use_id') continue;
    if (typeof child === 'string' && child.length > 0 && child.length < 200) {
      const kind = ID_KEYS[key];
      if (kind) facts.push({ kind, id: child, tool });
      else if (key === 'event_id' || key === 'eventId') {
        facts.push({
          kind: value.action === 'attempt' ? 'attempt' : 'event',
          id: child,
          tool,
        });
      } else if (key === 'id' && typeof value.name === 'string') {
        facts.push({ kind: 'knowledge', id: child, tool });
      } else if (key === 'coarse_outcome' || key === 'outcome') {
        facts.push({ kind: 'outcome', id: child, tool, detail: key });
      }
    } else if (key === 'score' && typeof child === 'number' && Number.isFinite(child)) {
      facts.push({ kind: 'outcome', id: String(child), tool, detail: 'score' });
    } else if (key === 'summary' && typeof child === 'string' && child.length > 0) {
      facts.push({
        kind: 'tool_summary',
        id: sha256(`${tool}\n${child}`).slice(0, 16),
        tool,
        detail: child.slice(0, 180),
      });
    } else if (STRING_LIST_KEYS.has(key) && Array.isArray(child)) {
      for (const item of child) {
        if (typeof item === 'string' && item.length > 0 && item.length < 200) {
          facts.push({ kind: 'knowledge', id: item, tool });
        }
      }
    }
    walk(child, tool, facts, depth + 1);
  }
}

function factKey(fact: EvidenceFact): string {
  return `${fact.kind}:${fact.id}`;
}

function boundedId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length < 200 ? value : undefined;
}

function evaluationIdOf(record: Record<string, unknown>): string | undefined {
  for (const key of EVALUATION_ID_KEYS) {
    const id = boundedId(record[key]);
    if (id) return id;
  }
  return undefined;
}

function disputeReasonOf(record: Record<string, unknown>): string | undefined {
  for (const key of DISPUTE_REASON_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim().slice(0, 2000);
  }
  return undefined;
}

/**
 * One copilot turn's tool loop. The same args are not executed again: a
 * repeat of a settled signature closes the loop, and so does the same tool
 * returning the identical result. Once closed, root tool calls are denied —
 * the model sees the denial and answers from collected evidence — and only
 * escalate to a hard stop after SOFT_DENIAL_LIMIT denials; help faults
 * terminate immediately since the provider cannot answer anyway. A mutation
 * bumps the generation so one following read of the same args may observe
 * the write. Inside the closing window, the next root tool is denied once
 * any non-mutating call has settled, including a call that only failed.
 */
export function createNoProgressLoop(): {
  beforeToolCall: PiBeforeToolCall;
  afterToolCall: PiAfterToolCall;
  landBeforeBudget(): void;
  closure(): NoProgressClosure | undefined;
} {
  let phase: Phase = { status: 'collecting' };
  let softDenials = 0;
  let generation = 0;
  let budget: BudgetLanding = { window: 'open', anchor: 'waiting' };
  const settledAtGeneration = new Map<string, number>();
  const seenFingerprints = new Set<string>();
  const known = new Set<string>();
  const evidence: EvidenceFact[] = [];

  function close(reason: NoProgressCloseReason): void {
    if (phase.status === 'closed') return;
    phase = { status: 'closed', reason };
  }

  function armBudgetAnchor(): void {
    if (budget.anchor === 'ready') return;
    budget = { window: budget.window, anchor: 'ready' };
  }

  function remember(facts: readonly EvidenceFact[]): void {
    for (const fact of facts) {
      const key = factKey(fact);
      if (known.has(key)) continue;
      known.add(key);
      evidence.push(fact);
    }
  }

  function denyReasonFor(reason: NoProgressCloseReason): string {
    if (reason === 'budget_landing') return BUDGET_BLOCK_REASON;
    if (reason.startsWith('help_')) return HELP_FAULT_BLOCK_REASON;
    return BLOCK_REASON;
  }

  function deny(reason: NoProgressCloseReason): { block: true; terminate?: true; reason: string } {
    const soft = !reason.startsWith('help_') && softDenials < SOFT_DENIAL_LIMIT;
    softDenials += 1;
    return {
      block: true,
      ...(soft ? {} : { terminate: true }),
      reason: denyReasonFor(reason),
    };
  }

  const beforeToolCall: PiBeforeToolCall = (call, args) => {
    if (call.agentType !== undefined) return undefined;
    if (phase.status === 'closed') return deny(phase.reason);
    const signature = signatureOf(call.name, args);
    if (settledAtGeneration.get(signature) === generation) {
      close('no_progress');
      return deny('no_progress');
    }
    if (budgetLandingDue(budget)) {
      close('budget_landing');
      return deny('budget_landing');
    }
    return undefined;
  };

  const afterToolCall: PiAfterToolCall = (observation) => {
    if (observation.call.agentType !== undefined || observation.interrupted) return undefined;
    const tool = domainToolName(observation.call.name);
    const payload = parsePayload(observation.isError ? observation.error : observation.output);
    const fingerprint = fingerprintOf(payload);
    const incoming = collectFacts(payload, tool);
    const substantive = incoming.filter((fact) => fact.kind !== 'tool_summary');
    const novel = substantive.filter((fact) => !known.has(factKey(fact)));
    const fingerprintKey = `${tool}\n${fingerprint}`;
    const repeatedFingerprint = seenFingerprints.has(fingerprintKey);
    const settled = classifyRootCall(tool, observation.isError);
    if (settled.kind === 'mutation' && settled.applied) generation += 1;
    settledAtGeneration.set(signatureOf(observation.call.name, observation.args), generation);
    seenFingerprints.add(fingerprintKey);
    if (settled.kind === 'read') armBudgetAnchor();
    remember(novel.length > 0 ? incoming : incoming.filter((fact) => fact.kind === 'tool_summary'));
    if (incoming.length === 0) {
      remember([
        {
          kind: 'tool_summary',
          id: fingerprint.slice(0, 16),
          tool,
          detail: observation.isError ? '工具没有返回结果' : '工具返回里没有可引用的条目',
        },
      ]);
    }
    if (phase.status === 'closed') {
      return phase.reason.startsWith('help_') ? { terminate: true } : undefined;
    }
    if (observation.isError) {
      const fault = readHelpProviderFault(observation.error);
      if (fault) {
        close(helpCloseReason(fault));
        return { terminate: true };
      }
    }
    // The tool just paid for a call that returned exactly what an earlier
    // call of the same tool already produced. Close the loop; the denial on
    // the next root call tells the model to answer from what it has.
    if (repeatedFingerprint) close('no_progress');
    return undefined;
  };

  return {
    beforeToolCall,
    afterToolCall,
    landBeforeBudget() {
      if (budget.window === 'closing') return;
      budget = { window: 'closing', anchor: budget.anchor };
    },
    closure() {
      if (phase.status !== 'closed') return undefined;
      return { reason: phase.reason, evidence };
    },
  };
}

async function resolveEvaluation(
  db: Db,
  facts: readonly EvidenceFact[],
): Promise<{ evaluationId: string; attemptEventId: string | null } | null> {
  const direct = facts.find((fact) => fact.kind === 'evaluation');
  const attempt = facts.find((fact) => fact.kind === 'attempt');
  if (direct) return { evaluationId: direct.id, attemptEventId: attempt?.id ?? null };
  const questionIds = [
    ...new Set(facts.filter((fact) => fact.kind === 'question').map((fact) => fact.id)),
  ].slice(0, 3);
  const attemptIds = new Set(
    facts.filter((fact) => fact.kind === 'attempt' || fact.kind === 'event').map((fact) => fact.id),
  );
  const judgeIds = new Set(
    facts.filter((fact) => fact.kind === 'judge_event').map((fact) => fact.id),
  );
  for (const questionId of questionIds) {
    const timeline = await getQuestionTimeline(db, questionId, 10);
    const matched = timeline.find((entry) => {
      if (entry.kind !== 'attempt') return false;
      if (attemptIds.has(entry.event_id)) return true;
      const judge = entry.judge;
      return (
        judge !== null &&
        (judgeIds.has(judge.original_event_id) ||
          (judge.effective_event_id !== null && judgeIds.has(judge.effective_event_id)))
      );
    });
    const evaluationId =
      matched?.kind === 'attempt'
        ? (matched.assessment?.effective_evaluation_id ??
          matched.assessment?.original_evaluation_id)
        : null;
    if (matched?.kind === 'attempt' && evaluationId) {
      return { evaluationId, attemptEventId: matched.event_id };
    }
  }
  return null;
}

/**
 * Read-only choice. Attempt and evaluation ids from ordinary reads are disclosed,
 * not filed. A proposal is prepared only when the same object states a dispute reason.
 */
export async function chooseVerifiedFallback(input: {
  db: Db;
  sessionId: string;
  taskRunId: string;
  actorRef: string;
  causedByEventId?: string;
  allowProposal: boolean;
  evidence: readonly EvidenceFact[];
}): Promise<{ fallback: VerifiedFallback; filing?: SealedCorrectionFiling }> {
  const questionId = input.evidence.find((fact) => fact.kind === 'question')?.id ?? null;
  const attemptEventIds = input.evidence
    .filter((fact) => fact.kind === 'attempt')
    .map((fact) => fact.id);
  const continueSession: VerifiedFallback = {
    kind: 'continue_session',
    operation: 'durable_copilot_session',
    sessionId: input.sessionId,
    questionId,
    attemptEventIds,
  };
  const dispute = input.evidence.find((fact) => fact.kind === 'dispute' && fact.detail);
  let resolved: { evaluationId: string; attemptEventId: string | null } | null = null;
  if (dispute) {
    resolved = {
      evaluationId: dispute.id,
      attemptEventId: attemptEventIds[0] ?? null,
    };
  } else {
    try {
      resolved = await resolveEvaluation(input.db, input.evidence);
    } catch (error) {
      console.error('[no-progress-loop] evaluation lookup failed', { error });
    }
  }
  if (!resolved) return { fallback: continueSession };
  const filing =
    input.allowProposal && dispute?.detail && dispute.id === resolved.evaluationId
      ? {
          evaluationId: resolved.evaluationId,
          attemptEventId: resolved.attemptEventId,
          reasonMd: dispute.detail,
          evidenceEventIds: [
            ...new Set(
              input.evidence
                .filter(
                  (fact) =>
                    fact.kind === 'event' || fact.kind === 'attempt' || fact.kind === 'judge_event',
                )
                .map((fact) => fact.id),
            ),
          ].slice(0, 12),
          actorRef: input.actorRef,
          taskRunId: input.taskRunId,
          ...(input.causedByEventId ? { causedByEventId: input.causedByEventId } : {}),
        }
      : undefined;
  return {
    fallback: {
      kind: 'grading_correction',
      operation: 'writeEvaluationCorrectionProposal',
      evaluationId: resolved.evaluationId,
      attemptEventId: resolved.attemptEventId,
      dispute: filing ? 'explicit' : 'none',
    },
    ...(filing ? { filing } : {}),
  };
}

export async function fileSealedCorrection(
  db: Db | Tx,
  filing: SealedCorrectionFiling,
): Promise<void> {
  await writeEvaluationCorrectionProposal(db, {
    actor_ref: filing.actorRef,
    evaluation_id: filing.evaluationId,
    correction_kind: 'rejudge',
    reason_md: filing.reasonMd,
    attempt_event_id: filing.attemptEventId,
    observed: { dispute_reason: filing.reasonMd },
    evidence_refs: filing.evidenceEventIds.map((id) => ({ kind: 'event' as const, id })),
    task_run_id: filing.taskRunId,
    caused_by_event_id: filing.causedByEventId ?? null,
  });
}

export function mergeNoProgressReply(prose: string, closure: string): string {
  return [prose.trim(), closure.trim()].filter(Boolean).join('\n\n');
}

export function assistantProse(streamed: string, terminal: string): string {
  const stream = streamed.trim();
  const end = terminal.trim();
  if (!stream) return end;
  if (!end) return stream;
  if (stream === end || stream.endsWith(end) || end.endsWith(stream)) {
    return stream.length >= end.length ? stream : end;
  }
  return `${stream}\n\n${end}`;
}

function helpCloseReason(fault: HelpProviderFault): NoProgressCloseReason {
  if (fault.kind === 'quota') return 'help_quota';
  if (fault.kind === 'bad_gateway') return 'help_bad_gateway';
  return 'help_parse';
}

function helpFaultOfReason(reason: NoProgressCloseReason): HelpProviderFault | undefined {
  if (reason === 'help_quota') return { kind: 'quota', httpStatus: 429 };
  if (reason === 'help_bad_gateway') return { kind: 'bad_gateway', httpStatus: 502 };
  if (reason === 'help_parse') return { kind: 'parse' };
  return undefined;
}

/**
 * Learner-facing seal note appended to the model's own answer. It carries no
 * internal ids, tool names or operation names — the evidence list stays in
 * `NoProgressClosure.evidence` and the actionable entry in `fallback`, both
 * for the server's own settlement and correction-filing use only.
 */
export function renderNoProgressClosure(
  closure: NoProgressClosure,
  fallback: VerifiedFallback,
): string {
  const helpFault = helpFaultOfReason(closure.reason);
  const why = helpFault
    ? helpExitLead(helpFault)
    : closure.reason === 'budget_landing'
      ? '这次运行快到时间上限，先把已经拿到的内容交给你，不再继续查。'
      : '同样的查询没有带来新证据，所以停在这里，不再重复查。';
  const next =
    fallback.kind === 'grading_correction'
      ? fallback.dispute === 'explicit'
        ? '已经按这次对话里说明的判词异议登记了一条判分复核提案；接受后按冻结作答重判，不改写原来的评价。'
        : '如果对这次判分有疑问，直接在这条对话里说明，可以发起一次判分复核：复核按冻结作答重判，不改写原来的评价。'
      : '可以在这次对话里直接继续，说明下一步要看哪一题或哪一次作答。';
  return [why, '', '下一步', next].join('\n');
}
