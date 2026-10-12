import { eq } from 'drizzle-orm';
import type { ModelRequestGuard } from '@/ai/request-guard';
import type { Db } from '@/db/client';
import { source_document } from '@/db/schema';

export const DOCX_REQUEST_LIMITS = Object.freeze({
  turns: 16,
  tools: 24,
  outputTokens: 4096,
  timeoutMs: 240_000,
  credits: 650_000_000,
});
const CONTEXT_WINDOW = 1_048_576;
const TOKEN_PLAN_ENDPOINTS = new Set(
  ['cn', 'sgp', 'ams'].map((region) => `https://token-plan-${region}.xiaomimimo.com/v1`),
);
// MiMo Token Plan v2.6-pro: input/cache/output = 300/2.5/600 credits per token.
// https://mimo.mi.com/docs/en-US/price/token-plan (2026-09-21).
// Reserve the entire model context (including images/tools/history) at cache-miss
// price. Image estimates are not hard bounds. These credits are NOT cash USD.
const reserveCredits = CONTEXT_WINDOW * 300 + DOCX_REQUEST_LIMITS.outputTokens * 600;

/** DOCX-only per-run limits; no subscription purchase, balance fallback or global
 * billing framework. Existing USD receipts remain untouched as historical evidence. */
export async function createDocxRequestBudget(
  db: Db,
  sourceId: string,
  runId: string,
  deadline: number,
): Promise<ModelRequestGuard> {
  const save = async (entry: Record<string, unknown>) => {
    await db.transaction(async (tx) => {
      const [source] = await tx
        .select()
        .from(source_document)
        .where(eq(source_document.id, sourceId))
        .for('update');
      if (!source) throw new Error('DOCX limits: source missing');
      const previous = source.provenance.docx_token_plan_usage ?? [];
      if (!Array.isArray(previous)) throw new Error('DOCX limits: invalid usage evidence');
      const entries = [...previous];
      const index = entries.findIndex((e) => e.runId === runId && e.request === entry.request);
      const value = { ...entry, runId };
      if (index < 0) entries.push(value);
      else entries[index] = value;
      await tx
        .update(source_document)
        .set({ provenance: { ...source.provenance, docx_token_plan_usage: entries } })
        .where(eq(source_document.id, sourceId));
    });
  };
  await save({ request: 0, status: 'not_sent', creditsUpper: 0 });
  let blocked: string | undefined;
  let requests = 0,
    tools = 0,
    chargedUpper = 0,
    pending = false;
  const deny = (reason: string): never => {
    blocked = `DOCX limits: ${reason}`;
    throw new Error(blocked);
  };
  const live = () => {
    if (blocked) throw new Error(blocked);
    if (Date.now() >= deadline) deny('deadline reached');
  };
  return {
    beforeToolCall() {
      live();
      if (++tools > DOCX_REQUEST_LIMITS.tools) deny('tool-call limit reached');
    },
    async beforeRequest(input) {
      live();
      if (pending) deny('previous request has no settled usage');
      if (requests >= DOCX_REQUEST_LIMITS.turns) deny('model-request limit reached');
      if (
        input.provider !== 'xiaomi-token-plan' ||
        input.model !== 'mimo-v2.6-pro' ||
        input.api !== 'openai-completions' ||
        !TOKEN_PLAN_ENDPOINTS.has(input.baseUrl) ||
        input.contextWindow !== CONTEXT_WINDOW
      )
        deny('not the approved Token Plan binding');
      const contextBytes = Buffer.byteLength(
        JSON.stringify(input.context, (_key, value) =>
          value?.type === 'image' ? { type: 'image', mimeType: value.mimeType } : value,
        ),
        'utf8',
      );
      if (contextBytes > 128_000) deny('assembled text/tool context exceeds byte limit');
      if (chargedUpper + reserveCredits > DOCX_REQUEST_LIMITS.credits)
        deny('insufficient run credits before request');
      pending = true;
      chargedUpper += reserveCredits;
      const entry = {
        request: ++requests,
        provider: input.provider,
        model: input.model,
        baseUrl: input.baseUrl,
        reservedCredits: reserveCredits,
        inputUpperTokens: CONTEXT_WINDOW,
        outputUpperTokens: DOCX_REQUEST_LIMITS.outputTokens,
        contextBytes,
        creditSource: 'mimo-token-plan/2026-09-21',
        catalogUsdEquivalentUpper:
          Math.ceil(CONTEXT_WINDOW * 0.435 + DOCX_REQUEST_LIMITS.outputTokens * 0.87) / 1_000_000,
        catalogSource: 'xiaomi-overseas-usd/2026-10-08',
      };
      await save({ ...entry, status: 'reserved', creditsUpper: reserveCredits });
      return {
        maxOutputTokens: DOCX_REQUEST_LIMITS.outputTokens,
        preparePayload(payload) {
          live();
          if (!payload || typeof payload !== 'object') deny('unknown request payload');
          const params = payload as Record<string, unknown>;
          if (
            params.model !== input.model ||
            params.web_search_options !== undefined ||
            (params.n !== undefined && params.n !== 1) ||
            (params.tools !== undefined &&
              (!Array.isArray(params.tools) ||
                params.tools.some((tool) => tool.type !== 'function')))
          )
            deny('unapproved request extension');
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
          if (!valid) {
            await save({ ...entry, status: 'unknown', creditsUpper: reserveCredits });
            pending = false;
            blocked = 'DOCX limits: unknown or out-of-bound provider usage; reservation retained';
            return;
          }
          const allInput = usage.input + usage.cacheRead + usage.cacheWrite;
          const creditsUpper = allInput * 300 + usage.output * 600;
          await save({
            ...entry,
            status: 'settled',
            creditsUpper,
            usage: {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
            },
            // Derived from observed tokens, NOT provider-reported account credits.
            estimatedCredits:
              (usage.input + usage.cacheWrite) * 300 + usage.cacheRead * 2.5 + usage.output * 600,
            // Public USD catalog equivalence for the owner's weekly budget report;
            // never call this subscription cash spend or a reconciled account bill.
            catalogUsdEquivalentUpper:
              Math.ceil(allInput * 0.435 + usage.output * 0.87) / 1_000_000,
          });
          chargedUpper += creditsUpper - reserveCredits;
          pending = false;
        },
      };
    },
  };
}
