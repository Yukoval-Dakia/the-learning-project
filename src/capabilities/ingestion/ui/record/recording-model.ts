// One recording as the page shows it (YUK-1473), derived from today's reads: the session facts,
// the replayed session event stream and the recognised blocks. Pure; recording-read.ts feeds it.
// When the backend's history read model lands, only this file and recording-read.ts change.
//
// Event payloads follow src/capabilities/ingestion/server/agent/contract.ts (ingestion_agent.*)
// and the ingestion.* lifecycle events on the same stream.

import type { SSEEvent } from '@/ui/lib/sse';
import type { Block, SessionDetail } from './record-api';

export type ItemStatus =
  | 'queued'
  | 'structuring'
  | 'solving'
  | 'calibrating'
  | 'admitted'
  | 'withheld'
  | 'failed';

export interface AgentItem {
  id: string;
  no: string | null;
  page: number | null;
  preview: string | null;
  status: ItemStatus;
  reason: string | null;
  problem: string | null;
}

export type AskAnswer =
  | { kind: 'choice'; option_id: string }
  | { kind: 'text'; text: string; via_option?: 'none_of_these' }
  | { kind: 'skipped'; by: 'learner' | 'timeout' };

export interface Ask {
  id: string;
  itemId: string;
  no: string;
  prompt: string;
  kind: 'choice' | 'short';
  options: { id: string; label: string }[];
  placeholder: string;
  expiresAt: string | null;
  answer: AskAnswer | null;
  /** Still waiting for the learner right now. */
  open: boolean;
}

export type Phase = 'not_started' | 'working' | 'finished' | 'failed';

export interface Recording {
  id: string;
  /** Session status as the server reports it. */
  status: string;
  phase: Phase;
  lane: 'agent' | 'extract' | 'unknown';
  /** 'expired' = the process record was pruned; only the questions that came in remain. */
  history: 'full' | 'expired' | 'loading';
  stage: string | null;
  pages: { done: number; total: number } | null;
  items: AgentItem[];
  asks: Ask[];
  stop: { code: string; retryable: boolean } | null;
  blocks: Block[];
  createdAt: number | null;
}

const ITEM: ReadonlySet<string> = new Set([
  'queued',
  'structuring',
  'solving',
  'calibrating',
  'admitted',
  'withheld',
  'failed',
]);
const DAY = 86_400_000;
const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function answerOf(v: unknown): AskAnswer | null {
  const o = (v ?? {}) as Record<string, unknown>;
  if (o.kind === 'choice' && typeof o.option_id === 'string') {
    return { kind: 'choice', option_id: o.option_id };
  }
  if (o.kind === 'text' && typeof o.text === 'string') {
    return o.via_option === 'none_of_these'
      ? { kind: 'text', text: o.text, via_option: 'none_of_these' }
      : { kind: 'text', text: o.text };
  }
  if (o.kind === 'skipped' && (o.by === 'learner' || o.by === 'timeout')) {
    return { kind: 'skipped', by: o.by };
  }
  return null;
}

interface Fold {
  agent: boolean;
  stage: string | null;
  pages: Recording['pages'];
  items: Map<string, AgentItem>;
  asks: Map<string, Omit<Ask, 'open'>>;
  stop: Recording['stop'];
  ended: boolean;
}

function fold(events: readonly SSEEvent[]): Fold {
  const f: Fold = {
    agent: false,
    stage: null,
    pages: null,
    items: new Map(),
    asks: new Map(),
    stop: null,
    ended: false,
  };
  for (const { event_type: type, payload: p } of events) {
    if (type === 'ingestion.queued') {
      // A new run (first start or a retry) clears the previous run's stop.
      f.agent = p.lane === 'agent';
      f.stop = null;
      f.ended = false;
    }
    if (type === 'ingestion.agent_run_completed') f.ended = true;
    if (type === 'ingestion.extraction_progress') {
      const done = int(p.done);
      const total = int(p.total);
      if (done !== null && total !== null) f.pages = { done, total };
    }
    if (!type.startsWith('ingestion_agent.')) continue;
    f.agent = true;
    if (type === 'ingestion_agent.stage') {
      f.stage = text(p.stage) ?? f.stage;
      if (f.stage === 'done') f.ended = true;
      const pg = (p.pages ?? null) as Record<string, unknown> | null;
      const done = int(pg?.done);
      const total = int(pg?.total);
      if (done !== null && total !== null) f.pages = { done, total };
    } else if (type === 'ingestion_agent.item') {
      const id = text(p.item_id);
      const status = text(p.status);
      if (!id || !status || !ITEM.has(status)) continue;
      const prev = f.items.get(id);
      f.items.set(id, {
        id,
        no: text(p.question_no) ?? prev?.no ?? null,
        page: int(p.page) ?? prev?.page ?? null,
        preview: text(p.preview_md) ?? prev?.preview ?? null,
        status: status as ItemStatus,
        reason: text(p.reason),
        problem: status === 'failed' ? (prev?.problem ?? null) : null,
      });
    } else if (type === 'ingestion_agent.error') {
      const code = text(p.code) ?? 'unknown';
      const id = text(p.item_id);
      if (p.scope === 'item' && id) {
        const prev = f.items.get(id);
        f.items.set(id, {
          id,
          no: prev?.no ?? null,
          page: prev?.page ?? null,
          preview: prev?.preview ?? null,
          status: 'failed',
          reason: null,
          problem: code,
        });
      } else if (p.scope === 'session') {
        f.stop = { code, retryable: p.retryable === true };
      }
    } else if (type === 'ingestion_agent.ask') {
      const id = text(p.ask_id);
      const itemId = text(p.item_id);
      const prompt = text(p.prompt_md);
      if (!id || !itemId || !prompt) continue;
      const options = (Array.isArray(p.options) ? p.options : []).flatMap((o) => {
        const r = (o ?? {}) as Record<string, unknown>;
        const oid = text(r.id);
        const label = text(r.label_md);
        return oid && label ? [{ id: oid, label }] : [];
      });
      f.asks.set(id, {
        id,
        itemId,
        no: text(p.question_no) ?? '',
        prompt,
        kind: p.answer_kind === 'choice' ? 'choice' : 'short',
        options,
        placeholder: text(p.placeholder) ?? '',
        expiresAt: text(p.expires_at),
        answer: f.asks.get(id)?.answer ?? null,
      });
    } else if (type === 'ingestion_agent.ask_resolved') {
      const prev = f.asks.get(text(p.ask_id) ?? '');
      if (prev) f.asks.set(prev.id, { ...prev, answer: answerOf(p.answer) });
    }
  }
  return f;
}

const WORKING = new Set(['queued', 'extracting']);
const FINISHED = new Set(['extracted', 'partial', 'reviewed', 'imported']);

export function deriveRecording(input: {
  id: string;
  detail: SessionDetail | undefined;
  events: readonly SSEEvent[];
  replayed: boolean;
  blocks: Block[];
  now: number;
}): Recording {
  const { detail, events, blocks, now } = input;
  const f = fold(events);
  const status = detail?.session.status ?? 'queued';
  const created = detail?.session.created_at ? Date.parse(detail.session.created_at) : null;
  const createdAt = created !== null && Number.isFinite(created) ? created : null;
  const age = createdAt === null ? 0 : now - createdAt;

  let phase: Phase = 'working';
  if (status === 'uploaded') phase = 'not_started';
  else if (status === 'failed' || (f.stop && !WORKING.has(status))) phase = 'failed';
  else if (FINISHED.has(status) || (f.ended && !WORKING.has(status))) phase = 'finished';

  const lane = f.agent ? 'agent' : blocks.length > 0 || events.length > 0 ? 'extract' : 'unknown';
  const settled = phase === 'finished' || phase === 'failed';
  // Asks wait at most 7 days (the sweep window); after that, or once the run stopped, an
  // unanswered ask stays unanswered.
  const asks = [...f.asks.values()].map((a) => ({
    ...a,
    open:
      a.answer === null &&
      !settled &&
      age < 7 * DAY &&
      (a.expiresAt === null || Date.parse(a.expiresAt) > now),
  }));

  let history: Recording['history'] = 'full';
  if (!detail || !input.replayed) history = 'loading';
  else if (settled && events.length === 0 && age > 30 * DAY) history = 'expired';

  return {
    id: input.id,
    status,
    phase,
    lane,
    history,
    stage: f.stage,
    pages: f.pages,
    items: [...f.items.values()],
    asks,
    stop: f.stop,
    blocks,
    createdAt,
  };
}

const TITLE_MAX = 20;
export const NO_TEXT_TITLE = '没认出题目文字';

/** The opening words of a question as a title: markup and line breaks dropped, about 20 characters. */
export function shortTitle(text: string | null | undefined): string | null {
  const plain = (text ?? '')
    .replace(/[#*_`>$\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return null;
  const chars = Array.from(plain);
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : plain;
}

/**
 * The automatic title of a recording: its first question's opening words. Null while nothing is
 * read yet; NO_TEXT_TITLE once the recording settled without any question text.
 */
export function firstQuestionTitle(rec: Recording): string | null {
  const byNo = [...rec.items].sort(
    (a, b) => (Number.parseInt(a.no ?? '', 10) || 0) - (Number.parseInt(b.no ?? '', 10) || 0),
  );
  const text =
    shortTitle(byNo.find((i) => i.preview)?.preview) ??
    shortTitle(rec.blocks[0]?.extracted_prompt_md);
  if (text) return text;
  return rec.phase === 'finished' || rec.phase === 'failed' || rec.history === 'expired'
    ? NO_TEXT_TITLE
    : null;
}
