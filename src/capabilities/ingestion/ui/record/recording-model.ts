// One recording as the page shows it (YUK-1473). Pure; recording-read.ts feeds it.
//
// A finished recording is read from GET /api/ingestion-sessions/{id}/history: each question shows
// what it was when the run finished (state_at_finish, frozen preview), and today's state rides
// along separately as `now`. The event stream (recording-live.ts) only fills in a run that is still
// going. Missing evidence is carried as `gaps` so nothing unknown ever reads as "none".

import type {
  Block,
  HistoryAsk,
  HistoryItem,
  HistoryPriorRun,
  SessionDetail,
  SessionHistory,
} from './record-api';
import type { LiveFold } from './recording-live';

export type ItemState = HistoryItem['state_at_finish'];
export type RunState = 'in_progress' | 'waiting' | 'done' | 'failed' | 'lost';

/** Today's serving state of a question that came in. Never replaces the at-finish state. */
export interface Now {
  servable: boolean;
  holdReason: string | null;
}

export interface AgentItem {
  id: string;
  no: string | null;
  page: number | null;
  preview: string | null;
  truncated: boolean;
  status: ItemState;
  reason: string | null;
  problem: string | null;
  now: Now | null;
}

export type AskAnswer = NonNullable<HistoryAsk['resolved']>['answer'];

export interface Ask {
  id: string;
  itemId: string | null;
  no: string | null;
  prompt: string;
  kind: 'choice' | 'short';
  options: { id: string; label: string }[];
  placeholder: string;
  expiresAt: string | null;
  answer: AskAnswer | null;
  answeredAt: string | null;
  /** Still waiting for the learner right now. */
  open: boolean;
}

export interface PriorRun {
  ref: string | null;
  state: RunState;
  at: string;
  items: AgentItem[];
  asks: Ask[];
}

/** Evidence the server says it cannot prove — each one gets its own plain sentence. */
export type Gap =
  | 'unparsed'
  | 'expired'
  | 'errors_cut'
  | 'items_unknown'
  | 'asks_unknown'
  | 'nothing_kept';

export type Phase = 'not_started' | 'working' | 'finished' | 'failed';
export type BlocksRead = 'none' | 'loading' | 'ready' | 'failed';

export interface Recording {
  id: string;
  status: string;
  phase: Phase;
  lane: 'agent' | 'extract' | 'unknown';
  /** The server's own lane verdict from history (null until read, or nothing ran). */
  path: 'agent' | 'extract' | null;
  /** 'loading' until the run's own record is read; 'unreadable' when that read failed. */
  read: 'live' | 'history' | 'loading' | 'unreadable';
  runState: RunState | null;
  stage: string | null;
  pages: { done: number; total: number } | null;
  items: AgentItem[];
  asks: Ask[];
  stop: { code: string; retryable: boolean } | null;
  priorRuns: PriorRun[];
  gaps: Gap[];
  blocks: Block[];
  /** Whether the recording's blocks are read: none to read, still reading, read, or failed. */
  blocksRead: BlocksRead;
  createdAt: number | null;
  cost: {
    evidence: NonNullable<SessionHistory['cost_evidence']> | null;
    state: 'loading' | 'unavailable' | 'failed' | 'ready' | 'stale';
  };
}

const WORKING = new Set(['queued', 'extracting']);
const FINISHED = new Set(['extracted', 'partial', 'reviewed', 'imported']);

function nowOf(c: HistoryItem['current']): Now | null {
  return c ? { servable: c.servable, holdReason: c.hold_reason } : null;
}

function historyAsk(a: HistoryAsk): Ask {
  return {
    id: a.ask_id,
    itemId: a.item_id,
    no: a.question_no,
    prompt: a.prompt_md,
    kind: a.answer_kind,
    options: (a.options ?? []).map((o) => ({ id: o.id, label: o.label_md })),
    placeholder: a.placeholder,
    expiresAt: a.expires_at,
    // A timeout is a resolution of its own; unresolved and expired-unresolved stay null (未回答).
    answer: a.resolved
      ? a.resolved.via === 'timeout'
        ? { kind: 'skipped', by: 'timeout' }
        : a.resolved.answer
      : null,
    answeredAt: a.resolved?.at ?? null,
    open: a.unresolved && !a.expired_unresolved,
  };
}

function historyItem(i: HistoryItem, problems: Map<string, string>): AgentItem {
  return {
    id: i.item_id,
    no: i.question_no,
    page: i.page,
    preview: i.preview_md,
    truncated: i.preview_truncated,
    status: i.state_at_finish,
    reason: i.reason,
    problem: problems.get(i.item_id) ?? null,
    now: nowOf(i.current),
  };
}

function priorRun(r: HistoryPriorRun): PriorRun {
  const problems = new Map(
    r.errors.flatMap((e) => (e.item_id ? [[e.item_id, e.code] as const] : [])),
  );
  return {
    ref: r.run_ref,
    state: r.run_state,
    at: r.captured_at,
    items: r.items.map((i) => ({
      id: i.item_id,
      no: i.question_no,
      page: i.page,
      preview: i.preview_md,
      truncated: false,
      status: i.status,
      reason: i.reason,
      problem: problems.get(i.item_id) ?? null,
      now: null,
    })),
    asks: r.asks.map((a) => ({ ...historyAsk(a), open: false })),
  };
}

function gapsOf(
  h: SessionHistory,
  settled: boolean,
  lane: Recording['lane'],
  blocks: number,
): Gap[] {
  const missing = new Set(h.evidence.missing);
  const gaps: Gap[] = [];
  if (missing.has('unparsed_history')) gaps.push('unparsed');
  if (h.session.path === null && blocks === 0) {
    if (settled) gaps.push('nothing_kept');
    return gaps;
  }
  if (lane !== 'agent') return gaps;
  // No run record and nothing left of the event window: the process aged out, the questions stay.
  const aged = missing.has('run') && !h.evidence.snapshot && !h.evidence.live_events;
  if (aged) gaps.push('expired');
  if (missing.has('errors')) gaps.push('errors_cut');
  if (missing.has('items')) gaps.push('items_unknown');
  if (missing.has('asks') && !aged) gaps.push('asks_unknown');
  return gaps;
}

export function deriveRecording(input: {
  id: string;
  detail: SessionDetail | undefined;
  history: SessionHistory | undefined;
  historyFailed: boolean;
  live: LiveFold | null;
  /** False when the stored run state is left over and must not decide anything. */
  runCounts: boolean;
  blocks: Block[];
  blocksRead: BlocksRead;
  now: number;
}): Recording {
  const { detail, history: h, live, blocks, now } = input;
  const status = detail?.session.status ?? h?.session.status ?? 'queued';
  const created = Date.parse(detail?.session.created_at ?? h?.session.started_at ?? '');
  const createdAt = Number.isFinite(created) ? created : null;
  const runState = input.runCounts ? (h?.run?.run_state ?? null) : null;

  // The recording's own status decides first; a run's state (which can be left over from an
  // earlier attempt) only speaks while the status has not settled.
  let phase: Phase = 'working';
  if (status === 'uploaded') phase = 'not_started';
  else if (status === 'failed') phase = 'failed';
  else if (FINISHED.has(status)) phase = 'finished';
  else if (runState === 'failed' || runState === 'lost') phase = 'failed';
  else if (live?.stop && !WORKING.has(status)) phase = 'failed';
  else if (runState === 'done') phase = 'finished';
  else if (live?.ended && !WORKING.has(status)) phase = 'finished';
  const settled = phase === 'finished' || phase === 'failed';

  const problems = new Map(
    (h?.run?.errors ?? []).flatMap((e) => (e.item_id ? [[e.item_id, e.code] as const] : [])),
  );
  // History also lists the recording's own blocks as lines; those show as blocks, with their
  // actions, so they are left out of the helper's lines here.
  const blockIds = new Set(blocks.map((b) => b.id));
  const items = new Map(
    (h?.items ?? [])
      .filter((i) => !blockIds.has(i.item_id))
      .map((i) => [i.item_id, historyItem(i, problems)]),
  );
  const asks = new Map((h?.asks ?? []).map((a) => [a.ask_id, historyAsk(a)]));
  // A run still going: the stream's view of this run overlays the stored one, row by row.
  if (live && !settled) {
    for (const [id, item] of live.items)
      items.set(id, { ...item, now: items.get(id)?.now ?? null });
    // Each ask's own expiry decides; no expiry means it waits until answered.
    for (const [id, a] of live.asks) {
      const expired = a.expiresAt !== null && Date.parse(a.expiresAt) <= now;
      asks.set(id, { ...a, open: a.answer === null && !expired });
    }
  } else {
    for (const a of asks.values()) a.open = false;
  }

  const stopCode = h?.run?.errors.find((e) => e.scope === 'session');
  // The lane is what the recording shows, not which start was tried: blocks with no helper lines
  // or asks read as a plain reading even when an agent start was attempted (and turned down).
  const helperShown = items.size > 0 || asks.size > 0 || live?.agent === true;
  const lane: Recording['lane'] =
    blocks.length > 0 && !helperShown
      ? 'extract'
      : (h?.session.path ?? (live?.agent ? 'agent' : live ? 'extract' : 'unknown'));
  const read: Recording['read'] =
    live && !settled ? 'live' : h ? 'history' : input.historyFailed ? 'unreadable' : 'loading';
  const costEvidence = h?.cost_evidence ?? null;

  return {
    id: input.id,
    status,
    phase,
    lane,
    path: h?.session.path ?? null,
    read,
    runState,
    stage: live?.stage ?? h?.run?.stage ?? null,
    pages: live?.pages ?? null,
    items: [...items.values()],
    asks: [...asks.values()],
    stop:
      (live && !settled ? live.stop : null) ??
      (stopCode ? { code: stopCode.code, retryable: stopCode.retryable } : (live?.stop ?? null)),
    priorRuns: (h?.prior_runs ?? []).map(priorRun),
    // A run still going has not left its record yet; only an unreadable old record is worth saying.
    gaps: h
      ? gapsOf(h, settled, lane, blocks.length).filter((g) => settled || g === 'unparsed')
      : [],
    blocks,
    blocksRead: input.blocksRead,
    createdAt,
    cost: {
      evidence: costEvidence,
      state: input.historyFailed
        ? costEvidence
          ? 'stale'
          : 'failed'
        : !h
          ? 'loading'
          : costEvidence
            ? 'ready'
            : 'unavailable',
    },
  };
}
