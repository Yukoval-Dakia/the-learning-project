// Ingestion agent (R8) progress events, folded into one view for the /record
// progress panel. The three `ingestion_agent.stage|item|error` shapes are the
// backend lead's draft contract (tlp-status/discussions/ui-backend-contracts-2026-10-17.md).
//
// Lead ruling 2026-10-17 15:33 (same doc, last section; binding once the R8 PR
// lands) adds:
//   - `stage.pages?: { total, done }`
//   - `item.page?` (1-based) and `item.preview_md?` (redacted, ≤80 chars, shown as
//     plain text)
//   - `ingestion_agent.ask` {ask_id, item_id, question_no, prompt_md,
//     answer_kind, options?, placeholder, expires_at} and
//     `ingestion_agent.ask_resolved` {ask_id, answer} — follow-up questions
//     answered in place (ADR-0074 D5). An ask counts as answered only on
//     ask_resolved, never on the POST result.
//
// Everything here is a pure fold over the SSE event list; no fetches.

import type { SSEEvent } from './sse';

export const AGENT_STAGES = [
  'reading',
  'segmenting',
  'structuring',
  'solving',
  'calibrating',
  'presenting',
] as const;
export type AgentStage = (typeof AGENT_STAGES)[number] | 'done';

export type AgentItemStatus =
  | 'queued'
  | 'structuring'
  | 'solving'
  | 'calibrating'
  | 'admitted'
  | 'withheld'
  | 'failed';

export interface AgentCounts {
  items_total: number;
  items_done: number;
  items_withheld: number;
  items_failed: number;
}

/** The answer echoed back in `ask_resolved`; `skipped` is by the learner or by timeout. */
export type AskAnswer =
  | { kind: 'choice'; option_id: string }
  | { kind: 'text'; text: string; via_option?: 'none_of_these' }
  | { kind: 'skipped'; by: 'learner' | 'timeout' };

/** Server cap on a text answer. */
export const ASK_TEXT_MAX = 500;

export interface AgentAskOption {
  id: string;
  label_md: string;
}

export interface AgentAsk {
  ask_id: string;
  item_id: string | null;
  question_no: string | null;
  prompt_md: string;
  answer_kind: 'choice' | 'short';
  options: AgentAskOption[];
  placeholder: string | null;
  /** ISO time after which the agent stops waiting; null = waits indefinitely. */
  expires_at: string | null;
  answer: AskAnswer | null;
}

export interface AgentItem {
  item_id: string;
  question_no: string | null;
  page: number | null;
  preview: string | null;
  status: AgentItemStatus;
  reason: string | null;
  error: { code: string; retryable: boolean } | null;
}

export interface AgentView {
  /** True once any ingestion_agent.* event has arrived on this stream. */
  active: boolean;
  stage: AgentStage | null;
  pages: { total: number; done: number } | null;
  counts: AgentCounts;
  items: AgentItem[];
  asks: AgentAsk[];
  sessionError: { code: string; retryable: boolean } | null;
}

const ITEM_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'structuring',
  'solving',
  'calibrating',
  'admitted',
  'withheld',
  'failed',
]);
const STAGES: ReadonlySet<string> = new Set([...AGENT_STAGES, 'done']);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseAnswer(v: unknown): AskAnswer | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
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

export function foldAgentEvents(events: readonly SSEEvent[]): AgentView {
  let active = false;
  let stage: AgentStage | null = null;
  let pages: AgentView['pages'] = null;
  let stageCounts: AgentCounts | null = null;
  let sessionError: AgentView['sessionError'] = null;
  const items = new Map<string, AgentItem>();
  const asks = new Map<string, AgentAsk>();

  for (const e of events) {
    if (!e.event_type.startsWith('ingestion_agent.')) continue;
    active = true;
    const p = e.payload;
    switch (e.event_type) {
      case 'ingestion_agent.stage': {
        const s = str(p.stage);
        if (s && STAGES.has(s)) stage = s as AgentStage;
        const pg = p.pages as Record<string, unknown> | undefined;
        if (pg && num(pg.total) !== null && num(pg.done) !== null) {
          pages = { total: num(pg.total) as number, done: num(pg.done) as number };
        }
        const c = p.counts as Record<string, unknown> | undefined;
        if (c) {
          stageCounts = {
            items_total: num(c.items_total) ?? 0,
            items_done: num(c.items_done) ?? 0,
            items_withheld: num(c.items_withheld) ?? 0,
            items_failed: num(c.items_failed) ?? 0,
          };
        }
        // A new stage event after a session error means the run resumed.
        if (s && s !== 'done') sessionError = null;
        break;
      }
      case 'ingestion_agent.item': {
        const id = str(p.item_id);
        const status = str(p.status);
        if (!id || !status || !ITEM_STATUSES.has(status)) break;
        const prev = items.get(id);
        items.set(id, {
          item_id: id,
          question_no: str(p.question_no) ?? prev?.question_no ?? null,
          page: num(p.page) ?? prev?.page ?? null,
          preview: str(p.preview_md) ?? prev?.preview ?? null,
          status: status as AgentItemStatus,
          reason: status === 'withheld' ? (str(p.reason) ?? 'unknown') : null,
          // Any later status clears an item error, except a plain re-announce of failed.
          error: status === 'failed' ? (prev?.error ?? null) : null,
        });
        break;
      }
      case 'ingestion_agent.error': {
        const code = str(p.code) ?? 'unknown';
        const retryable = p.retryable === true;
        if (p.scope === 'item') {
          const id = str(p.item_id);
          const prev = id ? items.get(id) : undefined;
          if (prev)
            items.set(prev.item_id, { ...prev, status: 'failed', error: { code, retryable } });
        } else {
          sessionError = { code, retryable };
        }
        break;
      }
      case 'ingestion_agent.ask': {
        const id = str(p.ask_id);
        const prompt = str(p.prompt_md);
        if (!id || !prompt) break;
        const answerKind = p.answer_kind === 'choice' ? 'choice' : 'short';
        const options = Array.isArray(p.options)
          ? p.options.flatMap((o) => {
              const r = o as Record<string, unknown>;
              const oid = str(r?.id);
              const label = str(r?.label_md);
              return oid && label ? [{ id: oid, label_md: label }] : [];
            })
          : [];
        asks.set(id, {
          ask_id: id,
          item_id: str(p.item_id),
          question_no: str(p.question_no),
          prompt_md: prompt,
          answer_kind: answerKind,
          options,
          placeholder: str(p.placeholder),
          expires_at: str(p.expires_at),
          answer: asks.get(id)?.answer ?? null,
        });
        break;
      }
      case 'ingestion_agent.ask_resolved': {
        const id = str(p.ask_id);
        const prev = id ? asks.get(id) : undefined;
        if (prev) asks.set(prev.ask_id, { ...prev, answer: parseAnswer(p.answer) });
        break;
      }
    }
  }

  const list = [...items.values()];
  // Item events are the finer truth; stage counts fill in before items arrive.
  const counts: AgentCounts =
    list.length > 0
      ? {
          items_total: Math.max(list.length, stageCounts?.items_total ?? 0),
          items_done: list.filter((i) => i.status === 'admitted').length,
          items_withheld: list.filter((i) => i.status === 'withheld').length,
          items_failed: list.filter((i) => i.status === 'failed').length,
        }
      : (stageCounts ?? { items_total: 0, items_done: 0, items_withheld: 0, items_failed: 0 });

  return { active, stage, pages, counts, items: list, asks: [...asks.values()], sessionError };
}

// ── Learner-facing copy. Codes never reach the screen. ──────────────────────

export const STAGE_LABEL: Record<AgentStage, string> = {
  reading: '读页面',
  segmenting: '找题目',
  structuring: '整理题目',
  solving: '解题',
  calibrating: '核对答案',
  presenting: '准备展示',
  done: '完成',
};

export const ITEM_STATUS_LABEL: Record<AgentItemStatus, string> = {
  queued: '排队中',
  structuring: '整理中',
  solving: '解题中',
  calibrating: '核对中',
  admitted: '已收好',
  withheld: '暂不出题',
  failed: '出错了',
};

/** Same meaning as YUK-1514 hold_reason. Plain words; unknown codes fall back. */
const HOLD_REASON_COPY: Record<string, string> = {
  awaiting_admission: '答案还在核对，核对完才会出这道题',
  admission_failed: '两次独立解题的答案对不上，先不出这道题',
  source_check_failed: '原题来源没核对上，先不出这道题',
  verify_hold: '先扣下了，等你确认后再出',
  retraction_hold: '这道题已撤回',
  no_input_renderer: '这种作答方式暂时还不支持',
  invalid_presentation: '这道题的显示有问题，先不出',
  withdrawn: '这道题已撤下',
};
export function holdReasonCopy(reason: string | null): string {
  return (reason && HOLD_REASON_COPY[reason]) || '暂不出题';
}

/** Error codes per the lead's ruling; unknown codes get the generic line. */
const ERROR_COPY: Record<string, string> = {
  page_unreadable: '这一页看不清，换一张更清楚的照片会更好',
  solve_timeout: '解这道题用时太长，没有完成',
  model_unavailable: 'AI 暂时不可用',
  budget_exhausted: '本周的 AI 额度用完了',
  crop_failed: '没能把这道题的图裁出来',
  worker_lost: '后台任务中断了',
  structure_failed: '没能理清这道题的结构',
  ask_expired: '追问没等到回答，这道题没法判断',
};
export function errorCopy(code: string, scope: 'session' | 'item'): string {
  return ERROR_COPY[code] ?? (scope === 'session' ? '录入中断了' : '这道题处理时出错了');
}

/** Coarse "stops waiting" line for an ask with expires_at. */
export function expiresCopy(expiresAt: string, now: number): string | null {
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  const minutes = Math.ceil((t - now) / 60_000);
  if (minutes <= 0) return '马上不再等，会按现有信息处理';
  return `约 ${minutes} 分钟后不再等，会按现有信息处理`;
}

/** Inline copy for a rejected answer POST (409 / 422). */
export function answerRejectCopy(status: number, code: string | undefined): string {
  if (status === 409) return '这题已经有结果了，正在同步';
  if (status === 422) {
    if (code === 'option_not_found' || code === 'invalid_option')
      return '这个选项已经不在了，换一个试试';
    if (code === 'answer_too_long') return `最多 ${ASK_TEXT_MAX} 字`;
    if (code === 'answer_empty') return '先写点内容再确定';
    return '这个回答没被接受，改一下再试';
  }
  return '没有发出去，再试一次';
}
