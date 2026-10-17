// LOFT ONLY (branch loft-ingest-progress, never merged).
//
// A scripted stand-in for the R8 ingestion agent's SSE stream. It replays a
// ~40 s run of a 4-page photo paper and exposes the same snapshot shape as
// useIngestionSSE, so the progress panel cannot tell the difference.
//
// Real question numbers and stems are NOT in git. On start the store asks the
// dev/preview server for `/__loft/ingest-fixture.json` (served from a local file
// outside the repo, see web/vite.config.ts); without it the replay uses the
// placeholder text below.

import { useSyncExternalStore } from 'react';
import { ApiError } from './api';
import { ASK_TEXT_MAX, type AskAnswer } from './ingestion-agent-events';
import type { UseIngestionSSEResult } from './sse';

interface FixtureItem {
  question_no: string;
  page: number;
  preview: string;
}
interface Fixture {
  pages: number;
  items: FixtureItem[];
  withheld: { question_no: string; reason: string };
  item_error: { question_no: string; code: string; retryable: boolean };
  asks: {
    choice: {
      question_no: string;
      prompt_md: string;
      options: { id: string; label_md: string }[];
    };
    short: { question_no: string; prompt_md: string; placeholder?: string };
  };
}

// Question numbers per page follow the shape of a typical 4-page paper.
const PLACEHOLDER_PAGES = [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4];
const PLACEHOLDER: Fixture = {
  pages: 4,
  items: PLACEHOLDER_PAGES.map((page, i) => ({
    question_no: String(i + 1),
    page,
    preview: `（题干占位：第 ${i + 1} 题）`,
  })),
  withheld: { question_no: '7', reason: 'admission_failed' },
  item_error: { question_no: '12', code: 'solve_timeout', retryable: true },
  asks: {
    choice: {
      question_no: '16',
      prompt_md: '（追问占位：第 4 页开头的小问，属于哪道题？）',
      options: [
        { id: 'a', label_md: '（选项占位：第 16 题的小问）' },
        { id: 'b', label_md: '（选项占位：第 15 题的一部分）' },
        { id: 'c', label_md: '（选项占位：单独一道题）' },
      ],
    },
    short: {
      question_no: '11',
      prompt_md: '（追问占位：第 11 题被笔迹盖住的那一段原文是什么？）',
      placeholder: '（输入占位）',
    },
  },
};

function isFixture(v: unknown): v is Fixture {
  const f = v as Fixture;
  return (
    !!f &&
    typeof f.pages === 'number' &&
    Array.isArray(f.items) &&
    f.items.every((i) => typeof i.question_no === 'string' && typeof i.page === 'number') &&
    !!f.asks?.choice &&
    !!f.asks?.short &&
    !!f.withheld &&
    !!f.item_error
  );
}

async function loadFixture(): Promise<Fixture> {
  try {
    const res = await fetch('/__loft/ingest-fixture.json', { cache: 'no-store' });
    if (!res.ok) return PLACEHOLDER;
    const json: unknown = await res.json();
    return isFixture(json) ? json : PLACEHOLDER;
  } catch {
    return PLACEHOLDER;
  }
}

// ── store ───────────────────────────────────────────────────────────────────

const IDLE: UseIngestionSSEResult = { events: [], status: 'idle', error: null };

let snapshot: UseIngestionSSEResult = IDLE;
let nextEventId = 1;
let generation = 0;
let timers: ReturnType<typeof setTimeout>[] = [];
let fixture: Fixture = PLACEHOLDER;
const listeners = new Set<() => void>();

function publish(next: Partial<UseIngestionSSEResult>) {
  snapshot = { ...snapshot, ...next };
  for (const l of listeners) l();
}

function emit(event_type: string, payload: Record<string, unknown>) {
  publish({ events: [...snapshot.events, { event_id: nextEventId++, event_type, payload }] });
}

function at(ms: number, fn: () => void) {
  const gen = generation;
  timers.push(
    setTimeout(() => {
      if (gen === generation) fn();
    }, ms),
  );
}

const itemId = (no: string) => `loft-item-${no}`;

// The short ask stops waiting this long after it is asked (demoes a timeout skip).
const SHORT_ASK_WAIT_MS = 75_000;
const resolvedAsks = new Set<string>();

/** After an ask resolves, carry the item on: answered → admitted; skipped → per kind. */
function continueItem(askId: string, answer: AskAnswer) {
  const ask = [...snapshot.events]
    .reverse()
    .find((e) => e.event_type === 'ingestion_agent.ask' && e.payload.ask_id === askId);
  const no = typeof ask?.payload.question_no === 'string' ? ask.payload.question_no : null;
  const f = no ? fixture.items.find((i) => i.question_no === no) : undefined;
  if (!f) return;
  // A skipped short ask leaves the agent without the missing text: it cannot decide.
  const cannotDecide = answer.kind === 'skipped' && ask?.payload.answer_kind === 'short';
  at(900, () => item(f, 'structuring'));
  if (cannotDecide) {
    at(2200, () => item(f, 'withheld'));
    return;
  }
  at(2000, () => item(f, 'solving'));
  at(3200, () => item(f, 'calibrating'));
  at(4300, () => item(f, 'admitted'));
}

function resolveAsk(askId: string, answer: AskAnswer) {
  if (resolvedAsks.has(askId)) return;
  resolvedAsks.add(askId);
  emit('ingestion_agent.ask_resolved', { ask_id: askId, answer });
  continueItem(askId, answer);
}

function item(f: FixtureItem, status: string, extra: Record<string, unknown> = {}) {
  emit('ingestion_agent.item', {
    item_id: itemId(f.question_no),
    question_no: f.question_no,
    page: f.page,
    preview_md: f.preview,
    status,
    ...extra,
  });
}

function schedule(fx: Fixture) {
  const items = fx.items;
  const askNos = new Set([fx.asks.choice.question_no, fx.asks.short.question_no]);
  const total = items.length;
  let t = 300;

  // 1 · reading pages
  emit('ingestion_agent.stage', { stage: 'reading', pages: { total: fx.pages, done: 0 } });
  for (let p = 1; p <= fx.pages; p++) {
    t += 1200;
    const done = p;
    at(t, () =>
      emit('ingestion_agent.stage', { stage: 'reading', pages: { total: fx.pages, done } }),
    );
  }

  // 2 · segmenting — questions appear one by one, page by page
  t += 500;
  at(t, () =>
    emit('ingestion_agent.stage', {
      stage: 'segmenting',
      pages: { total: fx.pages, done: fx.pages },
      counts: { items_total: 0, items_done: 0, items_withheld: 0, items_failed: 0 },
    }),
  );
  for (const f of items) {
    t += 300;
    at(t, () => item(f, 'queued'));
  }

  // 3 · structuring
  t += 500;
  at(t, () =>
    emit('ingestion_agent.stage', {
      stage: 'structuring',
      counts: { items_total: total, items_done: 0, items_withheld: 0, items_failed: 0 },
    }),
  );
  for (const f of items) {
    t += 280;
    at(t, () => item(f, 'structuring'));
  }

  // 4 · solving (the two ask items stop at structuring)
  const moving = items.filter((f) => !askNos.has(f.question_no));
  t += 400;
  at(t, () => emit('ingestion_agent.stage', { stage: 'solving' }));
  for (const f of moving) {
    t += 320;
    if (f.question_no === fx.item_error.question_no) {
      at(t, () => item(f, 'solving'));
      at(t + 1600, () =>
        emit('ingestion_agent.error', {
          scope: 'item',
          item_id: itemId(f.question_no),
          code: fx.item_error.code,
          retryable: fx.item_error.retryable,
        }),
      );
    } else {
      at(t, () => item(f, 'solving'));
    }
  }

  // 5 · calibrating
  const healthy = moving.filter((f) => f.question_no !== fx.item_error.question_no);
  t += 600;
  at(t, () => emit('ingestion_agent.stage', { stage: 'calibrating' }));
  for (const f of healthy) {
    t += 260;
    if (f.question_no === fx.withheld.question_no) {
      at(t, () => item(f, 'calibrating'));
      at(t + 1400, () => item(f, 'withheld', { reason: fx.withheld.reason }));
    } else {
      at(t, () => item(f, 'calibrating'));
    }
  }

  // 6 · presenting — admitted one by one
  t += 1200;
  at(t, () => emit('ingestion_agent.stage', { stage: 'presenting' }));
  for (const f of healthy) {
    if (f.question_no === fx.withheld.question_no) continue;
    t += 300;
    at(t, () => item(f, 'admitted'));
  }

  // 7 · follow-up asks
  const byNo = new Map(items.map((f) => [f.question_no, f]));
  t += 700;
  const choiceNo = fx.asks.choice.question_no;
  at(t, () =>
    emit('ingestion_agent.ask', {
      ask_id: 'loft-ask-choice',
      item_id: byNo.has(choiceNo) ? itemId(choiceNo) : null,
      question_no: choiceNo,
      prompt_md: fx.asks.choice.prompt_md,
      answer_kind: 'choice',
      options: fx.asks.choice.options,
      placeholder: null,
      expires_at: null,
    }),
  );
  t += 1400;
  const shortNo = fx.asks.short.question_no;
  at(t, () =>
    emit('ingestion_agent.ask', {
      ask_id: 'loft-ask-short',
      item_id: byNo.has(shortNo) ? itemId(shortNo) : null,
      question_no: shortNo,
      prompt_md: fx.asks.short.prompt_md,
      answer_kind: 'short',
      placeholder: fx.asks.short.placeholder ?? null,
      expires_at: new Date(Date.now() + SHORT_ASK_WAIT_MS).toISOString(),
    }),
  );
  at(t + SHORT_ASK_WAIT_MS, () => resolveAsk('loft-ask-short', { kind: 'skipped', by: 'timeout' }));
  t += 1200;
  at(t, () =>
    emit('ingestion_agent.stage', {
      stage: 'done',
      counts: {
        items_total: total,
        items_done: total - 4,
        items_withheld: 1,
        items_failed: 1,
      },
    }),
  );
}

function start() {
  generation++;
  for (const id of timers) clearTimeout(id);
  timers = [];
  nextEventId = 1;
  resolvedAsks.clear();
  snapshot = { events: [], status: 'connecting', error: null };
  const gen = generation;
  void loadFixture().then((fx) => {
    if (gen !== generation) return;
    fixture = fx;
    publish({ status: 'open' });
    schedule(fx);
  });
}

function stop() {
  generation++;
  for (const id of timers) clearTimeout(id);
  timers = [];
  snapshot = IDLE;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && snapshot.status === 'idle') start();
  return () => {
    listeners.delete(listener);
    queueMicrotask(() => {
      if (listeners.size === 0) stop();
    });
  };
}

const noopSubscribe = () => () => {};
const getSnapshot = () => snapshot;
const getIdle = () => IDLE;

export function useLoftIngestReplay(enabled: boolean): UseIngestionSSEResult {
  return useSyncExternalStore(
    enabled ? subscribe : noopSubscribe,
    enabled ? getSnapshot : getIdle,
    getIdle,
  );
}

/** Start the scripted run again from zero. */
export function restartLoftReplay() {
  start();
  for (const l of listeners) l();
}

/**
 * Stand-in for `POST /api/ingestion-sessions/:id/asks/:ask_id/answers`: validates
 * like the server (409 / 422), answers 202 {accepted, replayed}, then emits
 * `ingestion_agent.ask_resolved` on the stream a moment later.
 */
const seenKeys = new Set<string>();
export function answerLoftAsk(
  askId: string,
  answer: AskAnswer,
  idempotencyKey: string,
): Promise<{ accepted: boolean; replayed: boolean }> {
  return new Promise((resolve, reject) => {
    const gen = generation;
    setTimeout(() => {
      if (gen !== generation) return;
      if (seenKeys.has(idempotencyKey)) {
        resolve({ accepted: true, replayed: true });
        return;
      }
      if (resolvedAsks.has(askId)) {
        reject(new ApiError('ask already resolved', 409, 'ask_already_resolved'));
        return;
      }
      if (answer.kind === 'text') {
        if (answer.text.trim() === '') {
          reject(new ApiError('empty', 422, 'answer_empty'));
          return;
        }
        if (answer.text.length > ASK_TEXT_MAX) {
          reject(new ApiError('too long', 422, 'answer_too_long'));
          return;
        }
      }
      seenKeys.add(idempotencyKey);
      resolve({ accepted: true, replayed: false });
      at(500, () => resolveAsk(askId, answer));
    }, 250);
  });
}

/** Stand-in for retrying one failed item. */
export function retryLoftItem(id: string) {
  const no = id.replace('loft-item-', '');
  const f = fixture.items.find((i) => i.question_no === no);
  if (!f) return;
  at(300, () => item(f, 'solving'));
  at(1800, () => item(f, 'calibrating'));
  at(3000, () => item(f, 'admitted'));
}
