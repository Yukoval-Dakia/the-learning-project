// YUK-1811 acceptance runner — NOT committed.
//   --runs=N --label=<leg>   drive N fresh copilot sessions of 「今天我该做点什么」,
//                            record per-run: tools before first text, first sentence,
//                            startup segment chars/estTokens, cost, run/session ids.
//   --clean                  delete run-generated events (created_at >= seed boundary)
//                            + copilot session rows so the next run sees the same world.
// Env: BASE (dev origin), INTERNAL_TOKEN, DATABASE_URL; T0_FILE with the seed boundary.

import './load-env';

import { appendFileSync, mkdirSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8790';
const TOKEN = process.env.INTERNAL_TOKEN ?? '';
const USER_MESSAGE = '今天我该做点什么';
const POLL_MS = 3000;
const RUN_TIMEOUT_MS = 8 * 60 * 1000;

const CJK_RE = /[　-鿿豈-﫿＀-￯]/;
function estimateTokens(text: string): number {
  let units = 0;
  for (const ch of text) units += CJK_RE.test(ch) ? 1.6 : 1 / 3.5;
  return Math.ceil(units);
}

interface ToolCall {
  toolName: string;
  input?: Record<string, unknown>;
  status?: string;
}
interface Turn {
  role: 'user' | 'ai' | 'tombstone';
  text: string;
  at: string;
  event_id: string;
  tool_calls?: ToolCall[];
}
interface Snapshot {
  session_id: string | null;
  turns: Turn[];
  active_runs: Array<unknown>;
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-internal-token': TOKEN,
      ...(init?.headers ?? {}),
    },
  });
  return res;
}

function firstSentence(text: string): string {
  const m = /^[^\n。！？!?.]+[。！？!?]?/.exec(text.trim());
  return m?.[0] ?? text.trim().slice(0, 120);
}

async function runOnce(idx: number, label: string): Promise<Record<string, unknown>> {
  const startedAt = new Date();
  // 每次全新会话：启动段按 session 缓存，复用会话只会命中缓存，不算独立样本。
  const sres = await api('/api/copilot/sessions', { method: 'POST', body: '{}' });
  if (!sres.ok) throw new Error(`sessions POST ${sres.status}: ${await sres.text()}`);
  const sess = (await sres.json()) as { session: { id: string } };
  const idem = `yuk1811-${label}-${idx}-${startedAt.getTime()}`;
  const res = await api('/api/copilot/chat', {
    method: 'POST',
    headers: { 'Idempotency-Key': idem },
    body: JSON.stringify({
      session_id: sess.session.id,
      user_message: USER_MESSAGE,
      triggered_by: 'chat',
      durable: true,
    }),
  });
  if (!res.ok) throw new Error(`chat POST ${res.status}: ${await res.text()}`);
  const accepted = (await res.json()) as { run_id: string; session_id: string };

  let snap: Snapshot | null = null;
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const t = await api(
      `/api/copilot/turns?session_id=${encodeURIComponent(accepted.session_id)}&limit=100`,
    );
    if (!t.ok) throw new Error(`turns ${t.status}: ${await t.text()}`);
    snap = (await t.json()) as Snapshot;
    const settled = snap.active_runs.length === 0;
    const hasText = snap.turns.some((turn) => turn.role === 'ai' && turn.text.trim().length > 0);
    if (settled && hasText) break;
  }
  const settledAt = new Date();
  if (!snap) throw new Error('turns never returned');

  const toolsBefore: string[] = [];
  let firstAiText = '';
  for (const turn of snap.turns) {
    if (turn.role !== 'ai') continue;
    const hasText = turn.text.trim().length > 0;
    if (turn.tool_calls) for (const c of turn.tool_calls) toolsBefore.push(c.toolName);
    if (hasText) {
      firstAiText = turn.text;
      break;
    }
  }

  const headerRows = await db.execute<{
    h: string | null;
    at: string;
    trim: { dropped_units: string[]; tokens_before: number; tokens_after: number } | null;
  }>(sql`
    SELECT payload->>'header_md' AS h, created_at AS at,
           payload->'startup_trim' AS trim
    FROM event
    WHERE action = 'experimental:copilot_learner_state_header'
      AND session_id = ${accepted.session_id}
    ORDER BY created_at DESC LIMIT 1`);
  const headerMd = headerRows[0]?.h ?? null;
  const startupTrim = headerRows[0]?.trim ?? null;

  const costRows = await db.execute<{
    task_kind: string;
    n: number;
    cost: number | null;
    input: number | null;
    output: number | null;
    thinking: number | null;
  }>(sql`
    SELECT task_kind,
           count(*)::int AS n,
           sum(cost_usd)::float8 AS cost,
           sum((usage_json->>'inputTokens')::int)::float8 AS input,
           sum((usage_json->>'outputTokens')::int)::float8 AS output,
           max((usage_json->>'thinkingBlocks')::int)::float8 AS thinking
    FROM ai_task_runs
    WHERE started_at >= ${startedAt.toISOString()}::timestamptz
      AND started_at <= ${settledAt.toISOString()}::timestamptz + interval '10 seconds'
    GROUP BY task_kind ORDER BY task_kind`);

  const copilotCost = costRows.find((r) => r.task_kind === 'CopilotTask');
  return {
    idx,
    label,
    run_id: accepted.run_id,
    session_id: accepted.session_id,
    tools_before_first_text: toolsBefore,
    tool_count: toolsBefore.length,
    first_sentence: firstSentence(firstAiText),
    first_reply_chars: firstAiText.length,
    reply_text: firstAiText,
    header_chars: headerMd?.length ?? null,
    header_est_tokens: headerMd === null ? null : estimateTokens(headerMd),
    header_md: headerMd,
    startup_trim: startupTrim,
    cost_usd: copilotCost?.cost ?? null,
    thinking_blocks: copilotCost?.thinking ?? null,
    task_runs_in_window: costRows,
    wall_ms: settledAt.getTime() - startedAt.getTime(),
  };
}

async function clean(boundaryIso: string): Promise<void> {
  const del = await db.execute<{ delivery_seq: number }>(sql`
    DELETE FROM event_subscription_delivery
    WHERE source_event_id IN (SELECT id FROM event WHERE created_at >= ${boundaryIso}::timestamptz)
    RETURNING delivery_seq`);
  const ev = await db.execute<{ id: string }>(sql`
    DELETE FROM event WHERE created_at >= ${boundaryIso}::timestamptz RETURNING id`);
  const sess = await db.execute<{ id: string }>(sql`
    DELETE FROM learning_session WHERE created_at >= ${boundaryIso}::timestamptz RETURNING id`);
  // 运行期生成的物化实体同样要清：事件删了但 index/实体行留着会让
  // canonical-projections 迁移按「锚已死 / eventful 无锚」拒启动。
  const idx = await db.execute<{ materialized_id: string }>(sql`
    DELETE FROM materialized_id_index
    WHERE anchor_event_id NOT IN (SELECT id FROM event)
    RETURNING materialized_id`);
  const mv = await db.execute<{ id: string }>(sql`
    DELETE FROM mistake_variant WHERE created_at >= ${boundaryIso}::timestamptz RETURNING id`);
  console.log(
    `[yuk1811-run] clean: deleted ${ev.length} events (${del.length} deliveries), ${sess.length} sessions, ${idx.length} dangling index, ${mv.length} variants since ${boundaryIso}`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  if (args.includes('--clean')) {
    const boundary = get('t0') ?? process.env.YUK1811_T0;
    if (!boundary) throw new Error('--clean needs --t0=<iso> or YUK1811_T0');
    await clean(boundary);
    return;
  }
  const runs = Number(get('runs') ?? '5');
  const label = get('label') ?? 'run';
  if (!TOKEN) throw new Error('INTERNAL_TOKEN required');
  mkdirSync('.yuk1811', { recursive: true });
  const outPath = `.yuk1811/${label}.jsonl`;
  for (let i = 0; i < runs; i++) {
    const rec = await runOnce(i + 1, label);
    appendFileSync(outPath, `${JSON.stringify(rec)}\n`);
    console.log(
      `[yuk1811-run] ${label}#${i + 1} tools=${rec.tool_count} cost=$${rec.cost_usd} ` +
        `hdr=${rec.header_chars}ch/${rec.header_est_tokens}tok first=${JSON.stringify(rec.first_sentence)}`,
    );
  }
  console.log(`[yuk1811-run] wrote ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[yuk1811-run] failed', err);
    process.exit(1);
  });
