import { createHash } from 'node:crypto';
import { type HelpProviderFault, readHelpProviderFault } from '@/ai/help-provider-fault';
import type { PiAfterToolCall, PiBeforeToolCall } from '@/core/tool-call-contract';

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

type Phase =
  | { readonly status: 'collecting' }
  | { readonly status: 'closed'; readonly reason: NoProgressCloseReason };

/** Closing is the last minute before the hard timeout. Read and pending
 *  receipts anchor landing, including failed reads; an applied mutation
 *  never sets the anchor. */
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

function classifyRootCall(
  observation: Parameters<PiAfterToolCall>[0],
  payload: unknown,
): SettledRootCall {
  if (observation.effect === 'read' || observation.effect === undefined) return { kind: 'read' };
  const body = isRecord(payload) && 'output' in payload ? payload.output : payload;
  const failed =
    isRecord(body) &&
    ((typeof body.status === 'string' &&
      (body.status === 'skipped' || body.status.startsWith('skipped:'))) ||
      body.status === 'pending' ||
      body.status === 'failed' ||
      body.status === 'rejected' ||
      body.status === 'invalid' ||
      body.status === 'unavailable' ||
      body.status === 'error' ||
      body.applied === false ||
      body.skipped === true ||
      body.ok === false ||
      body.success === false ||
      body.replayed === true ||
      body.error !== undefined);
  return { kind: 'mutation', applied: !observation.isError && isRecord(body) && !failed };
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
    return { summary: text.split('\n\nReceived arguments:')[0] };
  }
}

function fingerprintOf(payload: unknown, normalizePending: boolean): string {
  const body = isRecord(payload) && 'output' in payload ? payload.output : payload;
  if (normalizePending && isRecord(body) && body.status === 'pending') {
    const {
      elapsed: _elapsed,
      elapsed_ms: _elapsedMs,
      elapsed_seconds: _elapsedSeconds,
      ...receipt
    } = body;
    return sha256(stable(receipt));
  }
  if (
    isRecord(body) &&
    ((typeof body.status === 'string' &&
      (body.status === 'skipped' || body.status.startsWith('skipped:'))) ||
      body.status === 'failed' ||
      body.status === 'rejected' ||
      body.status === 'invalid' ||
      body.status === 'unavailable' ||
      body.status === 'error' ||
      body.error !== undefined)
  ) {
    const { status, error, code, reason, issues, next_action } = body;
    return sha256(stable({ status, error, code, reason, issues, next_action }));
  }
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
  if (typeof value.name === 'string' && isRecord(value.refs) && typeof value.refs.id === 'string') {
    facts.push({ kind: 'knowledge', id: value.refs.id, tool });
  }
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
 * One task's tool loop. The same args are not executed again: a
 * repeat of a settled signature closes the loop, and so does the same tool
 * returning the identical result. Once closed, root tool calls are denied —
 * the model sees the denial and answers from collected evidence — and only
 * escalate to a hard stop after SOFT_DENIAL_LIMIT denials; help faults
 * terminate immediately since the provider cannot answer anyway. An applied mutation
 * bumps the generation so one following read of the same args may observe
 * the write. Inside the closing window, the next root tool is denied once
 * any non-mutating call has settled, including a call that only failed.
 */
export function createNoProgressLoop(policy?: {
  normalize?(payload: unknown): unknown;
  progressed?(observation: Parameters<PiAfterToolCall>[0], payload: unknown): boolean;
  /** Argument-schema rejection: retryable, but never progress evidence. */
  validationError?(observation: Parameters<PiAfterToolCall>[0]): boolean;
}): {
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
  const pendingSignatures = new Set<string>();
  let pendingOnly = false;
  const known = new Set<string>();
  const evidence: EvidenceFact[] = [];
  /** Same invalid arguments may be retried once; a third call is blocked without
   *  closing the loop, so a different tool still gets its turn. */
  const invalidArgumentAttempts = new Map<string, number>();
  const INVALID_ARGUMENT_ATTEMPT_LIMIT = 2;
  const INVALID_ARGUMENT_BLOCK_REASON =
    'the same invalid arguments were rejected twice; correct them or answer from what was collected';

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
    if (pendingOnly)
      return 'The operation is still pending. Stop polling and give a status update from the evidence collected; unfinished work can resume later.';
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
    if (phase.status === 'closed') return deny(phase.reason);
    const signature = signatureOf(call.name, args);
    if ((invalidArgumentAttempts.get(signature) ?? 0) >= INVALID_ARGUMENT_ATTEMPT_LIMIT) {
      return { block: true, reason: INVALID_ARGUMENT_BLOCK_REASON };
    }
    if (
      settledAtGeneration.get(signature) === generation &&
      (!pendingSignatures.has(signature) || pendingOnly)
    ) {
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
    if (observation.interrupted) return undefined;
    const tool = domainToolName(observation.call.name);
    if (observation.isError && policy?.validationError?.(observation)) {
      const invalidSignature = signatureOf(observation.call.name, observation.args);
      invalidArgumentAttempts.set(
        invalidSignature,
        (invalidArgumentAttempts.get(invalidSignature) ?? 0) + 1,
      );
      // Validation is repairable by the model and proves nothing about the
      // question, so it must not enter the settled-signature/fingerprint sets.
      return undefined;
    }
    const payload = parsePayload(observation.isError ? observation.error : observation.output);
    const fingerprint = fingerprintOf(
      policy?.normalize ? policy.normalize(payload) : payload,
      !policy?.progressed,
    );
    const incoming = collectFacts(payload, tool);
    const substantive = incoming.filter((fact) => fact.kind !== 'tool_summary');
    const novel = substantive.filter((fact) => !known.has(factKey(fact)));
    const fingerprintKey = `${tool}\n${fingerprint}`;
    const body = isRecord(payload) && 'output' in payload ? payload.output : payload;
    // New evidence permits another poll; consecutive unchanged waits use the
    // ordinary soft-denial closure, leaving the model room to wrap up.
    const pending = !policy?.progressed && isRecord(body) && body.status === 'pending';
    const pollingOnly = pendingOnly;
    const settled = classifyRootCall(observation, payload);
    const progressed = policy?.progressed
      ? policy.progressed(observation, payload)
      : settled.kind === 'mutation' && settled.applied;
    if (progressed) {
      generation += 1;
      if (policy?.progressed) seenFingerprints.clear();
    }
    const repeatedFingerprint =
      !(policy?.progressed && progressed) && seenFingerprints.has(fingerprintKey);
    const signature = signatureOf(observation.call.name, observation.args);
    settledAtGeneration.set(signature, generation);
    if (pending) pendingSignatures.add(signature);
    else pendingSignatures.delete(signature);
    if (pending) pendingOnly = true;
    else if (
      progressed ||
      (!observation.isError && settled.kind === 'read' && !repeatedFingerprint)
    )
      pendingOnly = false;
    seenFingerprints.add(fingerprintKey);
    if (settled.kind === 'read' || pending) armBudgetAnchor();
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
    if (repeatedFingerprint && (!pending || pollingOnly)) close('no_progress');
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

function helpCloseReason(fault: HelpProviderFault): NoProgressCloseReason {
  if (fault.kind === 'quota') return 'help_quota';
  if (fault.kind === 'bad_gateway') return 'help_bad_gateway';
  return 'help_parse';
}
