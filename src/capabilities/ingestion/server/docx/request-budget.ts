import { eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ModelRequestGuard } from '@/ai/request-guard';
import { getConfig } from '@/core/config/store';
import type { Db } from '@/db/client';
import { ai_task_runs, source_document } from '@/db/schema';

export const DOCX_REQUEST_LIMITS = Object.freeze({
  turns: 16,
  tools: 24,
  outputTokens: 4096,
  timeoutMs: 240_000,
});
const USD = 1_000_000;
const WEEK_USD = 20;
const PRICE_REF = 'xiaomi-overseas-usd/2026-10-08';
const PRICE_SOURCE = 'https://mimo.mi.com/docs/en-US/price/pay-as-you-go';
// Accepted-request context ceiling, NOT a characters/token heuristic. Reserve the
// entire documented model window (including tools/history/server framing). The
// official image-understanding contract includes images + text in that ceiling:
// https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/image-understanding
// Only the pinned v2.6-pro binding below admits images; no per-image estimate is used.
// Model limits: https://mimo.mi.com/docs/zh-CN/quick-start/summary/model (2026-09-22).
const CONTEXT_WINDOW = 1_048_576;
const Approval = z
  .object({
    priceRef: z.literal(PRICE_REF),
    provider: z.literal('xiaomi'),
    model: z.enum(['mimo-v2.5', 'mimo-v2.6-pro']),
    currency: z.literal('USD'),
    // Explicit account-price attestation, never inferred from the shared API host.
    accountPricing: z.literal('overseas-pay-as-you-go-usd'),
    maxRunUsd: z.number().positive().max(1),
    expiresAt: z.string().datetime(),
  })
  .strict();
const Entry = z.object({
  runId: z.string(),
  request: z.number().int().nonnegative(),
  week: z.string(),
  amountMicros: z.number().int().nonnegative(),
  reservedMicros: z.number().int().nonnegative(),
  status: z.enum(['not_sent', 'reserved', 'settled', 'unknown']),
  priceRef: z.string(),
  priceSource: z.string(),
  accountPricing: z.string().optional(), // Older durable reservations remain readable.
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string(),
  inputUpperTokens: z.number().int(),
  outputUpperTokens: z.number().int(),
  contextBytes: z.number().int(),
});
const Entries = z.array(Entry);
function utcWeek(now: number): string {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString();
}

/** DOCX-only durable reservations. Existing cost rows are observed, never rewritten.
 * An interrupted wire keeps its full reservation. No refund on unknown usage.
 * Other task families are unchanged; this is not a global concurrent spend lock. */
export async function createDocxRequestBudget(
  db: Db,
  sourceId: string,
  runId: string,
  deadline: number,
): Promise<ModelRequestGuard> {
  // A zero-wire marker distinguishes admission rejection from unpriced paid work.
  await db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(source_document)
      .where(eq(source_document.id, sourceId))
      .for('update');
    if (!source) throw new Error('DOCX budget: source missing');
    const entries = Entries.parse(source.provenance.docx_request_budget ?? []);
    entries.push({
      runId,
      request: 0,
      week: utcWeek(Date.now()),
      amountMicros: 0,
      reservedMicros: 0,
      status: 'not_sent',
      priceRef: '',
      priceSource: '',
      provider: '',
      model: '',
      baseUrl: '',
      inputUpperTokens: 0,
      outputUpperTokens: 0,
      contextBytes: 0,
    });
    await tx
      .update(source_document)
      .set({ provenance: { ...source.provenance, docx_request_budget: entries } })
      .where(eq(source_document.id, sourceId));
  });
  let blocked: string | undefined;
  let requests = 0;
  let toolCalls = 0;
  let pending = false;
  let pinned: z.infer<typeof Approval> | undefined;
  function deny(reason: string): never {
    blocked = `DOCX budget: ${reason}`;
    throw new Error(blocked);
  }
  const live = () => {
    if (blocked) throw new Error(blocked);
    if (Date.now() >= deadline) deny('deadline reached');
  };
  return {
    beforeToolCall(call) {
      live();
      if (++toolCalls > DOCX_REQUEST_LIMITS.tools) deny('tool-call limit reached');
      // Do not mark a page as viewed when its pixels cannot reach the next model request.
      if (
        call.name === 'mcp__loom__read_docx_source' &&
        (call.args as { action?: string })?.action === 'image' &&
        pinned?.model !== 'mimo-v2.6-pro'
      )
        deny('unknown image token upper bound');
    },
    async beforeRequest(input) {
      live();
      if (pending) deny('previous request has no settled usage');
      if (requests >= DOCX_REQUEST_LIMITS.turns) deny('model-request limit reached');
      if (!pinned) {
        const raw = getConfig('DOCX_AGENT_BUDGET_APPROVAL');
        let parsed: unknown;
        try {
          parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined;
        } catch {
          deny('invalid approval');
        }
        const approval = Approval.safeParse(parsed);
        if (!approval.success) deny('missing approved USD price/binding');
        pinned = Object.freeze(approval.data);
      }
      const policy = pinned;
      if (Date.now() >= Date.parse(policy.expiresAt)) deny('approval expired');
      if (
        Date.now() >=
        Date.parse(policy.model === 'mimo-v2.5' ? '2026-10-21T02:00:00Z' : '2026-11-08T00:00:00Z')
      )
        deny('dated price/model evidence expired');
      if (
        input.provider !== policy.provider ||
        input.model !== policy.model ||
        input.baseUrl !== 'https://api.xiaomimimo.com/v1' ||
        input.api !== 'openai-completions' ||
        input.contextWindow !== CONTEXT_WINDOW
      )
        deny('unpriced or changed provider/model/endpoint/context limit');
      for (const message of input.context.messages) {
        if (
          policy.model !== 'mimo-v2.6-pro' &&
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === 'image')
        )
          deny('unknown image token upper bound');
      }
      // The byte guard bounds text/tool history, not base64. Image billing is
      // already reserved at the full context ceiling, including every image.
      const contextBytes = Buffer.byteLength(
        JSON.stringify(input.context, (_key, value) =>
          value?.type === 'image' ? { type: 'image', mimeType: value.mimeType } : value,
        ),
        'utf8',
      );
      if (contextBytes > 128_000) deny('assembled text/tool context exceeds byte limit');
      const rate =
        policy.model === 'mimo-v2.5'
          ? { input: 0.14, output: 0.28 }
          : { input: 0.435, output: 0.87 };
      const charge = (inputTokens: number, outputTokens: number) =>
        Math.ceil(inputTokens * rate.input + outputTokens * rate.output);
      const reserve = charge(CONTEXT_WINDOW, DOCX_REQUEST_LIMITS.outputTokens);
      const request = requests + 1;
      const week = utcWeek(Date.now());
      pending = true; // Serialize even accidental concurrent calls before awaiting the DB reservation.
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('docx-request-budget', 0))`,
        );
        const rows = await tx
          .select({ id: source_document.id, provenance: source_document.provenance })
          .from(source_document)
          .where(sql`${source_document.provenance} ? 'docx_request_budget'`);
        const entries = rows.flatMap((row) => Entries.parse(row.provenance.docx_request_budget));
        const currentWeek = entries.filter((entry) => entry.week === week);
        const accountedRuns = new Set(entries.map((entry) => entry.runId));
        const otherRuns = await tx
          .select({
            id: ai_task_runs.id,
            cost: ai_task_runs.cost_usd,
            basis: ai_task_runs.cost_basis,
          })
          .from(ai_task_runs)
          .where(gte(ai_task_runs.started_at, new Date(week)));
        let weekMicros = currentWeek.reduce((sum, entry) => sum + entry.amountMicros, 0);
        for (const row of otherRuns) {
          if (row.id === runId || accountedRuns.has(row.id)) continue;
          if (
            row.cost === null ||
            row.basis === 'unknown' ||
            row.basis === null ||
            !Number.isFinite(row.cost) ||
            row.cost < 0
          )
            deny('weekly cost contains unknown or active attempts');
          weekMicros += Math.ceil(row.cost * USD);
        }
        const spent = entries
          .filter((entry) => entry.runId === runId)
          .reduce((sum, entry) => sum + entry.amountMicros, 0);
        if (spent + reserve > Math.floor(policy.maxRunUsd * USD))
          deny('insufficient run budget before request');
        if (weekMicros + reserve > WEEK_USD * USD)
          deny('insufficient weekly budget before request');
        live();
        const [source] = await tx
          .select()
          .from(source_document)
          .where(eq(source_document.id, sourceId))
          .for('update');
        if (!source) deny('source missing');
        const owned = Entries.parse(source.provenance.docx_request_budget ?? []);
        owned.push({
          runId,
          request,
          week,
          amountMicros: reserve,
          reservedMicros: reserve,
          status: 'reserved',
          priceRef: policy.priceRef,
          priceSource: PRICE_SOURCE,
          accountPricing: policy.accountPricing,
          provider: input.provider,
          model: input.model,
          baseUrl: input.baseUrl,
          inputUpperTokens: CONTEXT_WINDOW,
          outputUpperTokens: DOCX_REQUEST_LIMITS.outputTokens,
          contextBytes,
        });
        await tx
          .update(source_document)
          .set({ provenance: { ...source.provenance, docx_request_budget: owned } })
          .where(eq(source_document.id, sourceId));
      });
      requests = request;
      return {
        maxOutputTokens: DOCX_REQUEST_LIMITS.outputTokens,
        preparePayload(payload) {
          live();
          if (!payload || typeof payload !== 'object') deny('unknown request payload');
          const params = payload as Record<string, unknown>;
          // Run after SDK serialization and any existing payload hook, immediately
          // before transport. Native paid search is not part of the token ceiling.
          if (
            params.model !== policy.model ||
            params.web_search_options !== undefined ||
            (params.n !== undefined && params.n !== 1) ||
            (params.tools !== undefined &&
              (!Array.isArray(params.tools) ||
                params.tools.some((tool) => tool.type !== 'function')))
          )
            deny('unpriced request extension');
          const { max_tokens: _legacyMax, ...rest } = params;
          return { ...rest, max_completion_tokens: DOCX_REQUEST_LIMITS.outputTokens };
        },
        async settle(usage) {
          const tokens = usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
          const valid =
            !!tokens &&
            tokens.every((n) => Number.isSafeInteger(n) && n >= 0) &&
            usage.input + usage.cacheRead + usage.cacheWrite > 0 &&
            usage.input + usage.cacheRead + usage.cacheWrite <= CONTEXT_WINDOW &&
            usage.output <= DOCX_REQUEST_LIMITS.outputTokens;
          // No catalog USD/Token-Plan "cost" is used. Only observed token counts
          // against the pinned USD account price can release the reservation.
          await db.transaction(async (tx) => {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended('docx-request-budget', 0))`,
            );
            const [source] = await tx
              .select()
              .from(source_document)
              .where(eq(source_document.id, sourceId))
              .for('update');
            if (!source) deny('cannot settle missing source');
            const entries = Entries.parse(source.provenance.docx_request_budget);
            const entry = entries.find((e) => e.runId === runId && e.request === request);
            if (entry?.status !== 'reserved') deny('reservation settlement mismatch');
            entry.status = valid ? 'settled' : 'unknown';
            if (valid)
              entry.amountMicros = charge(
                usage.input + usage.cacheRead + usage.cacheWrite,
                usage.output,
              );
            await tx
              .update(source_document)
              .set({ provenance: { ...source.provenance, docx_request_budget: entries } })
              .where(eq(source_document.id, sourceId));
          });
          pending = false;
          if (!valid) blocked = 'DOCX budget: unknown or out-of-bound provider usage';
        },
      };
    },
  };
}
