// I02-C12 ReadHelpLatency. Four marks are sealed separately. A missing mark
// stays on the sample; failure, timeout and cancel stay in the denominator.
// Unknown cost is null, never a fabricated 0. CF-19 is a hypothesis: the read
// reports modality and sample size and does not claim a p95 bar.

export const HELP_LATENCY_MARKS = [
  'first_token',
  'first_executable_help',
  'complete_artifact',
  'calls_settled',
] as const;

export type HelpLatencyMark = (typeof HELP_LATENCY_MARKS)[number];

export type HelpTerminal = 'success' | 'failure' | 'timeout' | 'cancelled';

export type HelpModality = 'text' | 'vision' | 'deterministic' | 'reference' | 'copilot' | 'none';

/** Set only for a verified executable base. A finished model reply is not one. */
export type ExecutableHelpBasis = 'deterministic_step' | 'sealed_reference' | 'verified_fallback';

export type HelpCost =
  | { readonly basis: 'reported' | 'estimated'; readonly usd: number }
  | { readonly basis: 'unknown'; readonly usd: null };

export interface HelpLatencyMarks {
  readonly first_token_ms: number | null;
  readonly first_executable_help_ms: number | null;
  readonly complete_artifact_ms: number | null;
  readonly calls_settled_ms: number | null;
}

export interface HelpProgressBudget {
  readonly budget_ms: number | null;
  readonly elapsed_ms: number;
}

export interface SealedHelpLatency {
  readonly kind: 'help_latency';
  /** Epoch ms. Marks are offsets from this instant. */
  readonly origin_at: number;
  readonly terminal: HelpTerminal;
  readonly modality: HelpModality;
  readonly executable_help: ExecutableHelpBasis | null;
  readonly marks: HelpLatencyMarks;
  readonly cost: HelpCost;
  readonly progress_budget: HelpProgressBudget;
}

export interface HelpLatencyDraft {
  readonly origin_at: number;
  readonly terminal: HelpTerminal;
  readonly modality: HelpModality;
  readonly executable_help: ExecutableHelpBasis | null;
  readonly marks: HelpLatencyMarks;
  readonly cost: HelpCost;
  readonly progress_budget: HelpProgressBudget;
}

const TERMINALS = new Set<HelpTerminal>(['success', 'failure', 'timeout', 'cancelled']);
const MODALITIES = new Set<HelpModality>([
  'text',
  'vision',
  'deterministic',
  'reference',
  'copilot',
  'none',
]);
const BASES = new Set<ExecutableHelpBasis>([
  'deterministic_step',
  'sealed_reference',
  'verified_fallback',
]);

const TIMEOUT_ABORTS = new Set(['execution_timeout', 'session_deadline']);
const CANCEL_ABORTS = new Set(['caller_signal', 'lifecycle_abort']);

/** AbortSignal.timeout aborts with a TimeoutError. A bare caller abort does not. */
export function isBudgetTimeoutReason(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  return (reason as { name?: unknown }).name === 'TimeoutError';
}

export function nonnegativeElapsed(originAt: number, at: number): number {
  const ms = at - originAt;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export function helpModalityForTaskKind(kind: string): HelpModality | null {
  if (kind === 'CopilotTask') return 'copilot';
  if (kind === 'TeachingTurnVisionTask') return 'vision';
  if (kind === 'TeachingTurnTask') return 'text';
  return null;
}

export function helpTerminalForAttempt(input: {
  status: 'success' | 'failure';
  aborted: boolean;
  abortKinds: readonly string[];
  /** Reason on the caller signal. TimeoutError is the hint budget, not a cancel. */
  callerAbortReason?: unknown;
}): HelpTerminal {
  if (input.status === 'success') return 'success';
  if (input.abortKinds.some((kind) => TIMEOUT_ABORTS.has(kind))) return 'timeout';
  if (input.aborted && isBudgetTimeoutReason(input.callerAbortReason)) return 'timeout';
  if (
    input.aborted &&
    (input.abortKinds.length === 0 || input.abortKinds.some((kind) => CANCEL_ABORTS.has(kind)))
  ) {
    return 'cancelled';
  }
  return 'failure';
}

/** Unknown, missing, or negative amounts stay unknown. A real 0 with a known basis stays 0. */
export function helpCost(basis: string | undefined, usd: number | null | undefined): HelpCost {
  if (basis !== 'reported' && basis !== 'estimated') return { basis: 'unknown', usd: null };
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd < 0) {
    return { basis: 'unknown', usd: null };
  }
  return { basis, usd };
}

function markMs(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function sealHelpLatency(draft: HelpLatencyDraft): SealedHelpLatency {
  const terminal = TERMINALS.has(draft.terminal) ? draft.terminal : 'failure';
  const modality = MODALITIES.has(draft.modality) ? draft.modality : 'none';
  const executable =
    draft.executable_help !== null && BASES.has(draft.executable_help)
      ? draft.executable_help
      : null;
  const elapsed = Number.isFinite(draft.progress_budget.elapsed_ms)
    ? Math.max(0, draft.progress_budget.elapsed_ms)
    : 0;
  const budget = draft.progress_budget.budget_ms;
  return {
    kind: 'help_latency',
    origin_at: Number.isFinite(draft.origin_at) ? draft.origin_at : 0,
    terminal,
    modality,
    executable_help: executable,
    marks: {
      first_token_ms: markMs(draft.marks.first_token_ms),
      first_executable_help_ms: executable ? markMs(draft.marks.first_executable_help_ms) : null,
      complete_artifact_ms: markMs(draft.marks.complete_artifact_ms),
      calls_settled_ms: markMs(draft.marks.calls_settled_ms),
    },
    cost: helpCost(draft.cost.basis, draft.cost.usd),
    progress_budget: {
      budget_ms: budget !== null && Number.isFinite(budget) && budget >= 0 ? budget : null,
      elapsed_ms: elapsed,
    },
  };
}

export function parseSealedHelpLatency(value: unknown): SealedHelpLatency | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<HelpLatencyDraft> & { kind?: unknown };
  if (record.kind !== 'help_latency') return undefined;
  if (!record.marks || !record.cost || !record.progress_budget) return undefined;
  if (typeof record.origin_at !== 'number' || typeof record.terminal !== 'string') return undefined;
  if (typeof record.modality !== 'string') return undefined;
  return sealHelpLatency({
    origin_at: record.origin_at,
    terminal: record.terminal as HelpTerminal,
    modality: record.modality as HelpModality,
    executable_help: (record.executable_help ?? null) as ExecutableHelpBasis | null,
    marks: {
      first_token_ms: record.marks.first_token_ms ?? null,
      first_executable_help_ms: record.marks.first_executable_help_ms ?? null,
      complete_artifact_ms: record.marks.complete_artifact_ms ?? null,
      calls_settled_ms: record.marks.calls_settled_ms ?? null,
    },
    cost: record.cost,
    progress_budget: record.progress_budget,
  });
}

/** Rebase one mark onto another origin. Null stays null. */
export function rebaseHelpMark(
  seal: SealedHelpLatency,
  mark: HelpLatencyMark,
  toOriginAt: number,
): number | null {
  const relative = seal.marks[MARK_KEYS[mark]];
  if (relative === null) return null;
  return markMs(seal.origin_at + relative - toOriginAt);
}

export interface HelpLatencyDenominator {
  readonly included: number;
  readonly by_terminal: Record<HelpTerminal, number>;
  /** Failure, timeout and cancel are never removed. */
  readonly excluded: 0;
}

export interface ReadHelpLatency {
  readonly sample_size: number;
  readonly progress_budget: {
    readonly samples_with_budget: number;
    readonly within_budget: number;
    readonly over_budget: number;
    readonly budget_unknown: number;
  };
  readonly latency: {
    readonly marks: Record<
      HelpLatencyMark,
      { readonly observed: number; readonly absent: number; readonly p95_ms: number | null }
    >;
  };
  readonly denominator: HelpLatencyDenominator;
  readonly modality: readonly { readonly modality: string; readonly n: number }[];
  readonly cost: {
    readonly known_usd: number | null;
    readonly known_count: number;
    readonly unknown_count: number;
  };
  readonly cf19: {
    readonly status: 'hypothesis';
    readonly p95_claim: 'withheld';
    readonly reason: 'not_a_preregistered_confirmation';
  };
}

function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))] ?? null;
}

const MARK_KEYS = {
  first_token: 'first_token_ms',
  first_executable_help: 'first_executable_help_ms',
  complete_artifact: 'complete_artifact_ms',
  calls_settled: 'calls_settled_ms',
} as const satisfies Record<HelpLatencyMark, keyof HelpLatencyMarks>;

/** Every sample counts, including failure, timeout and cancel. */
export function readHelpLatency(samples: readonly SealedHelpLatency[]): ReadHelpLatency {
  const byTerminal: Record<HelpTerminal, number> = {
    success: 0,
    failure: 0,
    timeout: 0,
    cancelled: 0,
  };
  const modalityCounts = new Map<string, number>();
  const observed: Record<HelpLatencyMark, number[]> = {
    first_token: [],
    first_executable_help: [],
    complete_artifact: [],
    calls_settled: [],
  };
  let knownUsd = 0;
  let knownCount = 0;
  let unknownCount = 0;
  let withBudget = 0;
  let withinBudget = 0;
  let overBudget = 0;
  let budgetUnknown = 0;

  for (const sample of samples) {
    byTerminal[sample.terminal] += 1;
    modalityCounts.set(sample.modality, (modalityCounts.get(sample.modality) ?? 0) + 1);
    for (const mark of HELP_LATENCY_MARKS) {
      const value = sample.marks[MARK_KEYS[mark]];
      if (value !== null) observed[mark].push(value);
    }
    if (sample.cost.basis === 'unknown' || sample.cost.usd === null) unknownCount += 1;
    else {
      knownUsd += sample.cost.usd;
      knownCount += 1;
    }
    const budget = sample.progress_budget.budget_ms;
    if (budget === null) budgetUnknown += 1;
    else {
      withBudget += 1;
      if (sample.progress_budget.elapsed_ms <= budget) withinBudget += 1;
      else overBudget += 1;
    }
  }

  const marks = Object.fromEntries(
    HELP_LATENCY_MARKS.map((mark) => [
      mark,
      {
        observed: observed[mark].length,
        absent: samples.length - observed[mark].length,
        p95_ms: p95(observed[mark]),
      },
    ]),
  ) as ReadHelpLatency['latency']['marks'];

  return {
    sample_size: samples.length,
    progress_budget: {
      samples_with_budget: withBudget,
      within_budget: withinBudget,
      over_budget: overBudget,
      budget_unknown: budgetUnknown,
    },
    latency: { marks },
    denominator: {
      included: samples.length,
      by_terminal: byTerminal,
      excluded: 0,
    },
    modality: [...modalityCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([modality, n]) => ({ modality, n })),
    cost: {
      known_usd: knownCount === 0 ? null : knownUsd,
      known_count: knownCount,
      unknown_count: unknownCount,
    },
    cf19: {
      status: 'hypothesis',
      p95_claim: 'withheld',
      reason: 'not_a_preregistered_confirmation',
    },
  };
}
