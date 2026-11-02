// The live side of a recording (YUK-1473): folds the session event stream of a run that is still
// going. Only used while a run is in progress; a finished recording reads /history instead.
//
// Event payloads follow src/capabilities/ingestion/server/agent/contract.ts (ingestion_agent.*)
// and the ingestion.* lifecycle events on the same stream.

import type { SSEEvent } from '@/ui/lib/sse';
import type { AgentItem, Ask, AskAnswer, ItemState } from './recording-model';

const ITEM: ReadonlySet<string> = new Set([
  'queued',
  'structuring',
  'solving',
  'calibrating',
  'admitted',
  'withheld',
  'failed',
]);
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

export interface LiveFold {
  agent: boolean;
  stage: string | null;
  pages: { done: number; total: number } | null;
  items: Map<string, AgentItem>;
  asks: Map<string, Omit<Ask, 'open'>>;
  stop: { code: string; retryable: boolean } | null;
  ended: boolean;
}

function emptyFold(): LiveFold {
  return {
    agent: false,
    stage: null,
    pages: null,
    items: new Map(),
    asks: new Map(),
    stop: null,
    ended: false,
  };
}

function blankItem(id: string, prev: AgentItem | undefined): AgentItem {
  return {
    id,
    no: prev?.no ?? null,
    page: prev?.page ?? null,
    preview: prev?.preview ?? null,
    truncated: false,
    status: 'failed',
    reason: null,
    problem: null,
    now: null,
  };
}

export function foldLive(events: readonly SSEEvent[]): LiveFold {
  let f = emptyFold();
  for (const { event_type: type, payload: p } of events) {
    if (type === 'ingestion.queued') {
      // A new run (first start or a retry) starts from nothing: an earlier run's questions,
      // asks and stop belong to that run and are read from /history, never mixed in here.
      f = { ...emptyFold(), agent: p.lane === 'agent' };
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
        ...blankItem(id, prev),
        no: text(p.question_no) ?? prev?.no ?? null,
        page: int(p.page) ?? prev?.page ?? null,
        preview: text(p.preview_md) ?? prev?.preview ?? null,
        status: status as ItemState,
        reason: text(p.reason),
        problem: status === 'failed' ? (prev?.problem ?? null) : null,
      });
    } else if (type === 'ingestion_agent.error') {
      const code = text(p.code) ?? 'unknown';
      const id = text(p.item_id);
      if (p.scope === 'item' && id) {
        f.items.set(id, { ...blankItem(id, f.items.get(id)), problem: code });
      } else if (p.scope === 'session') {
        f.stop = { code, retryable: p.retryable === true };
      }
    } else if (type === 'ingestion_agent.ask') {
      const id = text(p.ask_id);
      const prompt = text(p.prompt_md);
      if (!id || !prompt) continue;
      const options = (Array.isArray(p.options) ? p.options : []).flatMap((o) => {
        const r = (o ?? {}) as Record<string, unknown>;
        const oid = text(r.id);
        const label = text(r.label_md);
        return oid && label ? [{ id: oid, label }] : [];
      });
      const prev = f.asks.get(id);
      f.asks.set(id, {
        id,
        itemId: text(p.item_id),
        no: text(p.question_no),
        prompt,
        kind: p.answer_kind === 'choice' ? 'choice' : 'short',
        options,
        placeholder: text(p.placeholder) ?? '',
        expiresAt: text(p.expires_at),
        answer: prev?.answer ?? null,
        answeredAt: prev?.answeredAt ?? null,
      });
    } else if (type === 'ingestion_agent.ask_resolved') {
      const prev = f.asks.get(text(p.ask_id) ?? '');
      if (prev) {
        f.asks.set(prev.id, { ...prev, answer: answerOf(p.answer), answeredAt: text(p.at) });
      }
    }
  }
  return f;
}
