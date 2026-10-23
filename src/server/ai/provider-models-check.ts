// YUK-1563 — per configured provider, GET /models and reconcile with the
// models.dev bucket. Auth failure and a missing key are statuses. Neither
// removes a catalog model. A stored probe counts only for the key fingerprint
// that produced it. Chat probes ask for 1 token. Responses asks for 16, its API minimum.

import { createHash } from 'node:crypto';
import type { Provider } from '@/ai/task-spec';
import {
  customProviderDefinition,
  looksLikeCustomProviderId,
} from '@/core/config/custom-providers';
import { catalogProviderFor } from './model-profiles';
import { ANTHROPIC_SUB_CONTRACT_REF } from './pricing';
import {
  implementedProviderIds,
  isKnownProvider,
  providerAuthProbeModel,
  providerCredentialEnvName,
  providerModelsRoot,
} from './providers';

export type ProviderFetch = (
  url: string,
  init: RequestInit & { signal: AbortSignal },
) => Promise<Response>;

const LIST_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 10;
const PROBE_RETRY_BACKOFF_MS = 60 * 60 * 1000;
const ERROR_TYPE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SESSION_HEADER = 'catalog-auth-probe';
const SENT_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** Whether GET /models could be read. Independent of the inference probe. */
export type ModelListAccess =
  | { status: 'unconfigured' }
  | { status: 'readable' }
  | { status: 'auth_failed'; httpStatus: number; errorType: string }
  | { status: 'unreachable'; detail: string };

/** Whether the 1-token probe could call the model. A readable list does not set this to ok. */
export type InferenceAccess =
  | { status: 'unconfigured' }
  | { status: 'unprobed' }
  | { status: 'ok' }
  | { status: 'auth_failed'; httpStatus: number; errorType: string }
  | { status: 'unsettled'; httpStatus: number | null; errorType: string | null };

/** `known: false` is not zero usage. A known zero is `known: true` with both counts at 0. */
export type ProbeUsage = { known: true; tokensIn: number; tokensOut: number } | { known: false };

export interface ProviderProbeReceipt {
  status: 'succeeded' | 'failed' | 'unsettled' | 'claimed';
  at: string;
  model: string;
  httpStatus: number | null;
  errorType: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  costBasis: 'estimated' | 'unknown';
  /** sha256 prefix of the credential that produced this receipt. */
  credentialFingerprint: string;
}

export interface ProviderModelsCheck {
  provider: string;
  catalogProvider: string | null;
  list: ModelListAccess;
  inference: InferenceAccess;
  listed: readonly string[];
  catalogOnly: readonly string[];
  providerOnly: readonly string[];
  /** Null when this process has no credential for the provider. */
  credentialFingerprint: string | null;
  probe?: ProviderProbeReceipt;
}

export interface ProbePrice {
  costUsd: number | null;
  costBasis: 'estimated' | 'unknown';
  costRef: string;
}

type ModelsListResult =
  | { status: 'unconfigured' }
  | { status: 'ok'; ids: readonly string[] }
  | { status: 'auth_failed'; httpStatus: number; errorType: string }
  | { status: 'unsupported' }
  | { status: 'unreachable'; detail: string };

/** Probe verdict. Only `accepted` and `auth_failed` become a stored receipt. */
export type ProbeOutcome =
  | { kind: 'accepted'; httpStatus: number; usage: ProbeUsage }
  | {
      kind: 'auth_failed';
      httpStatus: number;
      errorType: string;
      usage: ProbeUsage;
    }
  | {
      kind: 'unsettled';
      httpStatus: number | null;
      errorType: string | null;
      usage: ProbeUsage;
      /** The request left this process. A later socket reset or header timeout still counts. */
      dispatched: boolean;
    };

export interface ProbeLedgerBill {
  provider: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  costBasis: 'estimated' | 'unknown';
  costRef: string;
  outcome: 'success' | 'failed_permanent' | 'failed_retryable';
}

/** A probe this process already spent. `owed` has no cost_ledger row yet. */
export type PaidProbePosting =
  | { readonly state: 'owed'; readonly bill: ProbeLedgerBill }
  | { readonly state: 'booked'; readonly bill: ProbeLedgerBill };

interface ProbeSpec {
  model: string;
  wire: 'openai-chat' | 'anthropic-messages' | 'openai-responses';
  /** Model-native body fields. DeepSeek high is its own value, not a shared tier. */
  extra?: Record<string, unknown>;
}

const PROBE_WIRES: Partial<Record<Provider, ProbeSpec['wire']>> = {
  // Same 1-token shape as the sealed deepseek receipt: reasoning_effort high,
  // thinking enabled, no tool_choice (thinking rejects forced tool_choice).
  'opencode-go': 'openai-chat',
  anthropic: 'anthropic-messages',
  'anthropic-sub': 'anthropic-messages',
  xiaomi: 'openai-chat',
  'xiaomi-token-plan': 'openai-chat',
  'zhipuai-coding-plan': 'openai-chat',
  openai: 'openai-responses',
};

function probeSpec(provider: Provider): ProbeSpec | undefined {
  const model = providerAuthProbeModel(provider);
  const wire = PROBE_WIRES[provider];
  if (!model || !wire) return undefined;
  if (provider !== 'opencode-go') return { model, wire };
  return { model, wire, extra: { reasoning_effort: 'high', thinking: { type: 'enabled' } } };
}

type Json = Record<string, unknown>;
type ProviderMap = Record<string, Json>;

function asJson(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function credentialFor(
  provider: Provider,
  env: Record<string, string | undefined>,
): string | undefined {
  const name = providerCredentialEnvName(provider);
  const value = name ? env[name]?.trim() : undefined;
  return value && value.length > 0 ? value : undefined;
}

/** First 16 hex chars of sha256(secret). Stored instead of the secret. */
export function credentialFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

export function providerCredentialFingerprint(
  provider: Provider,
  env: Record<string, string | undefined>,
): string | null {
  const secret = credentialFor(provider, env);
  return secret ? credentialFingerprint(secret) : null;
}

export function credentialFingerprints(
  env: Record<string, string | undefined>,
): ReadonlyMap<string, string | null> {
  return new Map(
    implementedProviderIds().map((provider) => [
      provider,
      providerCredentialFingerprint(provider, env),
    ]),
  );
}

function readErrorType(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return 'unknown';
  }
  const root = asJson(parsed);
  const error = asJson(root?.error);
  for (const candidate of [error?.type, error?.code, root?.type, root?.code]) {
    if (typeof candidate === 'string' && ERROR_TYPE.test(candidate)) return candidate;
  }
  return 'unknown';
}

function readUsage(body: string): ProbeUsage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { known: false };
  }
  const usage = asJson(asJson(parsed)?.usage);
  const input = usage?.prompt_tokens ?? usage?.input_tokens;
  const output = usage?.completion_tokens ?? usage?.output_tokens;
  if (typeof input !== 'number' || input < 0 || typeof output !== 'number' || output < 0) {
    return { known: false };
  }
  return { known: true, tokensIn: input, tokensOut: output };
}

function authHeaders(provider: Provider, credential: string): Record<string, string> {
  if (provider === 'anthropic' || provider === 'anthropic-sub') {
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
    if (provider === 'anthropic-sub' || credential.startsWith('sk-ant-oat')) {
      headers.authorization = `Bearer ${credential}`;
      // Bearer OAuth tokens are rejected without this beta.
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    } else {
      headers['x-api-key'] = credential;
    }
    return headers;
  }
  // A custom provider's wire shape comes from its configured protocol —
  // never from the donor lane its endpoint may resemble.
  if (looksLikeCustomProviderId(provider)) {
    if (customProviderDefinition(provider)?.protocol === 'anthropic-messages') {
      return { 'x-api-key': credential, 'anthropic-version': '2023-06-01' };
    }
    return { authorization: `Bearer ${credential}` };
  }
  const headers: Record<string, string> = { authorization: `Bearer ${credential}` };
  if (provider === 'opencode-go') headers['x-opencode-session'] = SESSION_HEADER;
  return headers;
}

async function readListedIds(
  fetchImpl: ProviderFetch,
  response: Response,
  headers: Record<string, string>,
): Promise<readonly string[] | undefined> {
  const ids: string[] = [];
  let current: Response | undefined = response;
  let complete = false;
  for (let page = 0; page < MAX_LIST_PAGES && current; page += 1) {
    const text = await current.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
    const root = asJson(parsed);
    const data = root?.data;
    if (!Array.isArray(data)) return undefined;
    for (const item of data) {
      const id = asJson(item)?.id;
      if (typeof id === 'string' && id.trim().length > 0) ids.push(id.trim());
    }
    if (root?.has_more !== true) {
      complete = true;
      break;
    }
    if (typeof root.last_id !== 'string' || root.last_id.length === 0) return undefined;
    const next = new URL(current.url);
    next.searchParams.set('after_id', root.last_id);
    try {
      const followed = await fetchImpl(next.toString(), {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      if (!followed.ok) return undefined;
      current = followed;
    } catch {
      return undefined;
    }
  }
  if (!complete) return undefined;
  return [...new Set(ids)].sort();
}

async function listOne(
  provider: Provider,
  fetchImpl: ProviderFetch,
  env: Record<string, string | undefined>,
): Promise<ModelsListResult> {
  const credential = credentialFor(provider, env);
  if (!credential) return { status: 'unconfigured' };
  const root = providerModelsRoot(provider, env);
  if (!root) return { status: 'unreachable', detail: 'base_url' };
  const headers = authHeaders(provider, credential);
  try {
    const response = await fetchImpl(`${root}/models`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'auth_failed',
        httpStatus: response.status,
        errorType: readErrorType(await response.text()),
      };
    }
    if (response.status === 404 || response.status === 405) return { status: 'unsupported' };
    if (!response.ok) return { status: 'unreachable', detail: `HTTP ${response.status}` };
    const ids = await readListedIds(fetchImpl, response, headers);
    if (!ids) return { status: 'unreachable', detail: 'unreadable' };
    return { status: 'ok', ids };
  } catch (error) {
    return { status: 'unreachable', detail: listFailureDetail(error) };
  }
}

function listFailureDetail(error: unknown): string {
  const typed = dispatchError(error);
  return typed === 'unanswered' ? 'network' : typed;
}

export async function listProviderModels(
  fetchImpl: ProviderFetch,
  env: Record<string, string | undefined>,
): Promise<ReadonlyMap<string, ModelsListResult>> {
  const providers = implementedProviderIds();
  const listed = await Promise.all(
    providers.map(async (provider) => {
      try {
        return [provider, await listOne(provider, fetchImpl, env)] as const;
      } catch (error) {
        return [
          provider,
          { status: 'unreachable' as const, detail: listFailureDetail(error) },
        ] as const;
      }
    }),
  );
  return new Map(listed);
}

function probeBody(spec: ProbeSpec): string {
  if (spec.wire === 'anthropic-messages') {
    return JSON.stringify({
      model: spec.model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
  }
  if (spec.wire === 'openai-responses') {
    // Responses rejects max_output_tokens below 16.
    return JSON.stringify({ model: spec.model, input: 'ping', max_output_tokens: 16 });
  }
  return JSON.stringify({
    model: spec.model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    ...spec.extra,
  });
}

function probeUrl(root: string, spec: ProbeSpec): string {
  if (spec.wire === 'anthropic-messages') return `${root}/messages`;
  if (spec.wire === 'openai-responses') return `${root}/responses`;
  return `${root}/chat/completions`;
}

async function runProbe(
  provider: Provider,
  fetchImpl: ProviderFetch,
  env: Record<string, string | undefined>,
): Promise<ProbeOutcome> {
  const spec = probeSpec(provider);
  const credential = credentialFor(provider, env);
  const root = providerModelsRoot(provider, env);
  const notSent = {
    kind: 'unsettled' as const,
    httpStatus: null,
    errorType: null,
    usage: { known: false as const },
    dispatched: false,
  };
  if (!spec || !credential || !root) return notSent;
  const headers = { ...authHeaders(provider, credential), 'content-type': 'application/json' };
  let response: Response;
  try {
    response = await fetchImpl(probeUrl(root, spec), {
      method: 'POST',
      headers,
      body: probeBody(spec),
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    if (!requestLeftTheProcess(error)) return notSent;
    return {
      kind: 'unsettled',
      httpStatus: null,
      errorType: dispatchError(error),
      usage: { known: false },
      dispatched: true,
    };
  }
  let text: string | undefined;
  try {
    text = await response.text();
  } catch {
    text = undefined;
  }
  const usage = text === undefined ? { known: false as const } : readUsage(text);
  const errorType = text === undefined ? 'unreadable' : readErrorType(text);
  if (response.status === 401 || response.status === 403) {
    return { kind: 'auth_failed', httpStatus: response.status, errorType, usage };
  }
  if (!response.ok) {
    return { kind: 'unsettled', httpStatus: response.status, errorType, usage, dispatched: true };
  }
  return { kind: 'accepted', httpStatus: response.status, usage };
}

function requestLeftTheProcess(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === 'object'; depth += 1) {
    const row = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (row.name === 'TimeoutError' || row.name === 'AbortError') return true;
    if (typeof row.code === 'string' && SENT_CODES.has(row.code)) return true;
    current = row.cause;
  }
  return false;
}

function dispatchError(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === 'object'; depth += 1) {
    const row = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (typeof row.code === 'string' && ERROR_TYPE.test(row.code)) return row.code;
    if (typeof row.name === 'string' && ERROR_TYPE.test(row.name)) return row.name;
    current = row.cause;
  }
  return 'unanswered';
}

function catalogIds(providers: ProviderMap, catalogProvider: string | null): ReadonlySet<string> {
  if (!catalogProvider) return new Set();
  const models = asJson(providers[catalogProvider]?.models);
  return new Set(models ? Object.keys(models) : []);
}

function reconcile(
  catalog: ReadonlySet<string>,
  listed: readonly string[],
): { catalogOnly: string[]; providerOnly: string[] } {
  const listedSet = new Set(listed);
  return {
    catalogOnly: [...catalog].filter((id) => !listedSet.has(id)).sort(),
    providerOnly: listed.filter((id) => !catalog.has(id)).sort(),
  };
}

function sameCredential(
  receipt: ProviderProbeReceipt | undefined,
  fingerprint: string | null,
): receipt is ProviderProbeReceipt {
  return (
    fingerprint !== null && receipt !== undefined && receipt.credentialFingerprint === fingerprint
  );
}

function holdIsFresh(receipt: ProviderProbeReceipt, now: Date): boolean {
  const at = Date.parse(receipt.at);
  return Number.isFinite(at) && now.getTime() < at + PROBE_RETRY_BACKOFF_MS;
}

/** A receipt blocks another probe only while it still belongs to this key. */
function blocksProbe(
  previous: ProviderModelsCheck | undefined,
  fingerprint: string | null,
  now: Date,
): boolean {
  const receipt = previous?.probe;
  if (!sameCredential(receipt, fingerprint)) return false;
  if (receipt.status === 'succeeded') return true;
  if (receipt.status === 'failed' && (receipt.httpStatus === 401 || receipt.httpStatus === 403)) {
    return true;
  }
  if (receipt.status === 'claimed' || receipt.status === 'unsettled')
    return holdIsFresh(receipt, now);
  return false;
}

function listAccess(list: ModelsListResult): ModelListAccess {
  if (list.status === 'unconfigured') return { status: 'unconfigured' };
  if (list.status === 'ok') return { status: 'readable' };
  if (list.status === 'auth_failed') {
    return { status: 'auth_failed', httpStatus: list.httpStatus, errorType: list.errorType };
  }
  if (list.status === 'unsupported') return { status: 'unreachable', detail: 'models_endpoint' };
  return { status: 'unreachable', detail: list.detail };
}

function inferenceFromOutcome(outcome: ProbeOutcome): InferenceAccess {
  if (outcome.kind === 'accepted') return { status: 'ok' };
  if (outcome.kind === 'auth_failed') {
    return { status: 'auth_failed', httpStatus: outcome.httpStatus, errorType: outcome.errorType };
  }
  return {
    status: 'unsettled',
    httpStatus: outcome.httpStatus,
    errorType: outcome.errorType,
  };
}

function inferenceFromReceipt(probe: ProviderProbeReceipt): InferenceAccess {
  if (probe.status === 'succeeded') return { status: 'ok' };
  return {
    status: 'auth_failed',
    httpStatus: probe.httpStatus ?? 401,
    errorType: probe.errorType ?? 'unknown',
  };
}

function inferenceAccess(
  outcome: ProbeOutcome | undefined,
  held: ProviderProbeReceipt | undefined,
): InferenceAccess {
  if (outcome) return inferenceFromOutcome(outcome);
  if (!held) return { status: 'unprobed' };
  if (held.status === 'claimed') return { status: 'unsettled', httpStatus: null, errorType: null };
  if (held.status === 'unsettled') {
    return { status: 'unsettled', httpStatus: held.httpStatus, errorType: held.errorType };
  }
  return inferenceFromReceipt(held);
}

function shouldProbe(
  list: ModelsListResult,
  previous: ProviderModelsCheck | undefined,
  fingerprint: string | null,
  now: Date,
): boolean {
  if (fingerprint === null) return false;
  if (list.status === 'unconfigured' || list.status === 'auth_failed') return false;
  if (list.status === 'unreachable') return false;
  if (blocksProbe(previous, fingerprint, now)) return false;
  return true;
}

function receiptTokens(usage: ProbeUsage): { tokensIn: number | null; tokensOut: number | null } {
  if (!usage.known) return { tokensIn: null, tokensOut: null };
  return { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut };
}

function receiptFor(
  outcome: ProbeOutcome,
  model: string,
  at: string,
  price: ProbePrice,
  fingerprint: string,
): ProviderProbeReceipt {
  const status =
    outcome.kind === 'accepted'
      ? 'succeeded'
      : outcome.kind === 'auth_failed'
        ? 'failed'
        : 'unsettled';
  return {
    status,
    at,
    model,
    httpStatus: outcome.httpStatus,
    errorType: outcome.kind === 'accepted' ? null : outcome.errorType,
    ...receiptTokens(outcome.usage),
    costUsd: price.costUsd,
    costBasis: price.costBasis,
    credentialFingerprint: fingerprint,
  };
}

function rememberOutcome(outcome: ProbeOutcome): boolean {
  if (outcome.kind === 'accepted' || outcome.kind === 'auth_failed') return true;
  if (outcome.httpStatus === null) return outcome.dispatched;
  return true;
}

function billOutcome(kind: ProbeOutcome['kind']): ProbeLedgerBill['outcome'] {
  if (kind === 'accepted') return 'success';
  if (kind === 'auth_failed') return 'failed_permanent';
  return 'failed_retryable';
}

function unobservedBill(provider: string, outcome: ProbeOutcome, model: string): ProbeLedgerBill {
  return {
    provider,
    model,
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
    costBasis: 'unknown',
    costRef: `unobserved:model-catalog-probe/${provider}/${model}`,
    outcome: billOutcome(outcome.kind),
  };
}

function ledgerBill(
  provider: string,
  outcome: ProbeOutcome,
  model: string,
  price: ProbePrice,
): ProbeLedgerBill | undefined {
  if (outcome.kind === 'unsettled' && outcome.httpStatus === null && !outcome.dispatched) {
    return undefined;
  }
  if (!outcome.usage.known) return unobservedBill(provider, outcome, model);
  const consumed = outcome.usage.tokensIn + outcome.usage.tokensOut > 0;
  if (outcome.kind === 'unsettled' && !consumed) return undefined;
  if (outcome.kind === 'auth_failed' && !consumed) return undefined;
  return {
    provider,
    model,
    tokensIn: outcome.usage.tokensIn,
    tokensOut: outcome.usage.tokensOut,
    costUsd: price.costUsd,
    costBasis: price.costBasis,
    costRef: price.costRef,
    outcome: billOutcome(outcome.kind),
  };
}

export function paidProbePostings(
  probes: ReadonlyMap<string, ProbeOutcome>,
  priceProbe: (provider: string, model: string, tokensIn: number, tokensOut: number) => ProbePrice,
): PaidProbePosting[] {
  const postings: PaidProbePosting[] = [];
  for (const [provider, outcome] of probes) {
    if (!isKnownProvider(provider)) continue;
    const spec = probeSpec(provider);
    if (!spec) continue;
    const usage = outcome.usage.known ? outcome.usage : { tokensIn: 0, tokensOut: 0 };
    const bill = ledgerBill(
      provider,
      outcome,
      spec.model,
      priceProbe(provider, spec.model, usage.tokensIn, usage.tokensOut),
    );
    if (bill) postings.push({ state: 'owed', bill });
  }
  return postings;
}

function copyProbe(probe: ProviderProbeReceipt): ProviderProbeReceipt {
  return {
    status: probe.status,
    at: probe.at,
    model: probe.model,
    httpStatus: probe.httpStatus,
    errorType: probe.errorType,
    tokensIn: probe.tokensIn,
    tokensOut: probe.tokensOut,
    costUsd: probe.costUsd,
    costBasis: probe.costBasis,
    credentialFingerprint: probe.credentialFingerprint,
  };
}

function copyListAccess(list: ModelListAccess): ModelListAccess {
  if (list.status === 'auth_failed') {
    return { status: 'auth_failed', httpStatus: list.httpStatus, errorType: list.errorType };
  }
  if (list.status === 'unreachable') return { status: 'unreachable', detail: list.detail };
  if (list.status === 'readable') return { status: 'readable' };
  return { status: 'unconfigured' };
}

function copyInference(inference: InferenceAccess): InferenceAccess {
  if (inference.status === 'auth_failed') {
    return {
      status: 'auth_failed',
      httpStatus: inference.httpStatus,
      errorType: inference.errorType,
    };
  }
  if (inference.status === 'ok') return { status: 'ok' };
  if (inference.status === 'unsettled') {
    return {
      status: 'unsettled',
      httpStatus: inference.httpStatus,
      errorType: inference.errorType,
    };
  }
  if (inference.status === 'unconfigured') return { status: 'unconfigured' };
  return { status: 'unprobed' };
}

export function canonicalProviderCheck(check: ProviderModelsCheck): ProviderModelsCheck {
  const stored: ProviderModelsCheck = {
    provider: check.provider,
    catalogProvider: check.catalogProvider,
    list: copyListAccess(check.list),
    inference: copyInference(check.inference),
    listed: [...check.listed].sort(),
    catalogOnly: [...check.catalogOnly].sort(),
    providerOnly: [...check.providerOnly].sort(),
    credentialFingerprint: check.credentialFingerprint,
  };
  if (check.probe) stored.probe = copyProbe(check.probe);
  return stored;
}

function readAuthFailed(row: Json): { httpStatus: number; errorType: string } | undefined {
  if (typeof row.httpStatus !== 'number' || typeof row.errorType !== 'string') return undefined;
  return { httpStatus: row.httpStatus, errorType: row.errorType };
}

function parseListAccess(value: unknown): ModelListAccess | undefined {
  const row = asJson(value);
  if (!row || typeof row.status !== 'string') return undefined;
  if (row.status === 'unconfigured') return { status: 'unconfigured' };
  if (row.status === 'readable') return { status: 'readable' };
  if (row.status === 'auth_failed') {
    const failed = readAuthFailed(row);
    return failed ? { status: 'auth_failed', ...failed } : undefined;
  }
  if (row.status === 'unreachable' && typeof row.detail === 'string') {
    return { status: 'unreachable', detail: row.detail };
  }
  return undefined;
}

function parseInference(value: unknown): InferenceAccess | undefined {
  const row = asJson(value);
  if (!row || typeof row.status !== 'string') return undefined;
  if (row.status === 'unconfigured') return { status: 'unconfigured' };
  if (row.status === 'unprobed') return { status: 'unprobed' };
  if (row.status === 'ok') return { status: 'ok' };
  if (row.status === 'unsettled') {
    return {
      status: 'unsettled',
      httpStatus: typeof row.httpStatus === 'number' ? row.httpStatus : null,
      errorType: typeof row.errorType === 'string' ? row.errorType : null,
    };
  }
  if (row.status === 'auth_failed') {
    const failed = readAuthFailed(row);
    return failed ? { status: 'auth_failed', ...failed } : undefined;
  }
  return undefined;
}

function legacyAccess(
  row: Json,
): { list: ModelListAccess; inference: InferenceAccess } | undefined {
  const auth = asJson(row.auth);
  if (!auth || typeof auth.status !== 'string') return undefined;
  const probe = asJson(row.probe);
  const probeFailed =
    probe?.status === 'failed' && (probe.httpStatus === 401 || probe.httpStatus === 403);
  const probeError = typeof probe?.errorType === 'string' ? probe.errorType : 'unknown';
  const probeStatus = typeof probe?.httpStatus === 'number' ? probe.httpStatus : 401;
  if (auth.status === 'unconfigured') {
    return { list: { status: 'unconfigured' }, inference: { status: 'unprobed' } };
  }
  if (auth.status === 'ok') {
    return {
      list: { status: 'readable' },
      inference: probeFailed
        ? { status: 'auth_failed', httpStatus: probeStatus, errorType: probeError }
        : { status: 'ok' },
    };
  }
  if (
    auth.status === 'auth_failed' &&
    typeof auth.httpStatus === 'number' &&
    typeof auth.errorType === 'string'
  ) {
    if (probeFailed) {
      return {
        list: { status: 'unreachable', detail: 'unrecorded' },
        inference: { status: 'auth_failed', httpStatus: probeStatus, errorType: probeError },
      };
    }
    return {
      list: { status: 'auth_failed', httpStatus: auth.httpStatus, errorType: auth.errorType },
      inference: { status: 'unprobed' },
    };
  }
  if (auth.status === 'unreachable' && typeof auth.detail === 'string') {
    return {
      list: { status: 'unreachable', detail: auth.detail },
      inference: probe?.status === 'succeeded' ? { status: 'ok' } : { status: 'unprobed' },
    };
  }
  return undefined;
}

function parseStoredAccess(
  row: Json,
): { list: ModelListAccess; inference: InferenceAccess } | undefined {
  const list = parseListAccess(row.list);
  const inference = parseInference(row.inference);
  if (list && inference) return { list, inference };
  return legacyAccess(row);
}

export function parseProviderChecks(payload: unknown): ProviderModelsCheck[] {
  const raw = asJson(payload)?.provider_checks;
  if (!Array.isArray(raw)) return [];
  const checks: ProviderModelsCheck[] = [];
  for (const item of raw) {
    const row = asJson(item);
    if (!row || typeof row.provider !== 'string') continue;
    if (!isKnownProvider(row.provider)) continue;
    const access = parseStoredAccess(row);
    if (!access) continue;
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    const check: ProviderModelsCheck = {
      provider: row.provider,
      catalogProvider: typeof row.catalogProvider === 'string' ? row.catalogProvider : null,
      list: access.list,
      inference: access.inference,
      listed: strings(row.listed),
      catalogOnly: strings(row.catalogOnly),
      providerOnly: strings(row.providerOnly),
      credentialFingerprint:
        typeof row.credentialFingerprint === 'string' && row.credentialFingerprint.length > 0
          ? row.credentialFingerprint
          : null,
    };
    const probe = asJson(row.probe);
    const probeStatus = probe?.status;
    const fingerprint =
      typeof probe?.credentialFingerprint === 'string' ? probe.credentialFingerprint : '';
    if (
      probe &&
      (probeStatus === 'succeeded' ||
        probeStatus === 'failed' ||
        probeStatus === 'unsettled' ||
        probeStatus === 'claimed') &&
      typeof probe.at === 'string' &&
      typeof probe.model === 'string' &&
      fingerprint.length > 0
    ) {
      check.probe = {
        status: probeStatus,
        at: probe.at,
        model: probe.model,
        httpStatus: typeof probe.httpStatus === 'number' ? probe.httpStatus : null,
        errorType: typeof probe.errorType === 'string' ? probe.errorType : null,
        tokensIn:
          probe.tokensIn === null ? null : typeof probe.tokensIn === 'number' ? probe.tokensIn : 0,
        tokensOut:
          probe.tokensOut === null
            ? null
            : typeof probe.tokensOut === 'number'
              ? probe.tokensOut
              : 0,
        costUsd: typeof probe.costUsd === 'number' ? probe.costUsd : null,
        costBasis: probe.costBasis === 'estimated' ? 'estimated' : 'unknown',
        credentialFingerprint: fingerprint,
      };
    }
    checks.push(canonicalProviderCheck(check));
  }
  return checks.sort((left, right) => left.provider.localeCompare(right.provider));
}

export function providerAuthLabel(check: ProviderModelsCheck): string {
  if (check.list.status === 'unconfigured' || check.inference.status === 'unconfigured') {
    return 'unconfigured';
  }
  if (check.inference.status === 'auth_failed') {
    return `auth_failed:${check.inference.httpStatus}:${check.inference.errorType}`;
  }
  if (check.list.status === 'auth_failed') {
    return `auth_failed:${check.list.httpStatus}:${check.list.errorType}`;
  }
  if (check.inference.status === 'ok') return 'ok';
  if (check.list.status === 'readable' && check.inference.status === 'unsettled') {
    return unsettledLabel(check.inference);
  }
  if (check.list.status === 'readable') return `inference:${check.inference.status}`;
  return `unreachable:${check.list.detail}`;
}

function unsettledLabel(access: { httpStatus: number | null; errorType: string | null }): string {
  if (access.httpStatus === null && access.errorType === null) return 'inference:unsettled';
  return `inference:unsettled:${access.httpStatus ?? 'none'}:${access.errorType ?? 'unknown'}`;
}

export function claimDueProbes(input: {
  now: Date;
  previous: readonly ProviderModelsCheck[];
  listed: ReadonlyMap<string, ModelsListResult>;
  fingerprints: ReadonlyMap<string, string | null>;
}): { checks: ProviderModelsCheck[]; due: readonly string[] } {
  const previousByProvider = new Map(input.previous.map((check) => [check.provider, check]));
  const due: string[] = [];
  const checks = input.previous.map((check) => canonicalProviderCheck(check));
  const byProvider = new Map(checks.map((check) => [check.provider, check]));
  for (const provider of implementedProviderIds()) {
    const spec = probeSpec(provider);
    if (!spec) continue;
    const fingerprint = input.fingerprints.get(provider) ?? null;
    const list = input.listed.get(provider) ?? {
      status: 'unreachable' as const,
      detail: 'missing',
    };
    if (!shouldProbe(list, previousByProvider.get(provider), fingerprint, input.now)) continue;
    if (!fingerprint) continue;
    due.push(provider);
    const previous = byProvider.get(provider);
    const settled = previous?.credentialFingerprint === fingerprint ? previous : undefined;
    byProvider.set(provider, {
      provider,
      catalogProvider: catalogProviderFor(provider) ?? settled?.catalogProvider ?? null,
      list: listAccess(list),
      inference: { status: 'unsettled', httpStatus: null, errorType: null },
      listed: settled?.listed ?? [],
      catalogOnly: settled?.catalogOnly ?? [],
      providerOnly: settled?.providerOnly ?? [],
      credentialFingerprint: fingerprint,
      probe: {
        status: 'claimed',
        at: input.now.toISOString(),
        model: spec.model,
        httpStatus: null,
        errorType: null,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        costBasis: 'unknown',
        credentialFingerprint: fingerprint,
      },
    });
  }
  return {
    checks: [...byProvider.values()].sort((left, right) =>
      left.provider.localeCompare(right.provider),
    ),
    due,
  };
}

export async function collectProviderProbes(input: {
  fetchImpl: ProviderFetch;
  env: Record<string, string | undefined>;
  due: readonly string[];
}): Promise<ReadonlyMap<string, ProbeOutcome>> {
  const probes = new Map<string, ProbeOutcome>();
  for (const provider of input.due) {
    if (!isKnownProvider(provider) || !probeSpec(provider)) continue;
    probes.set(provider, await runProbe(provider, input.fetchImpl, input.env));
  }
  return probes;
}

/**
 * A failed /models read does not revise absence conclusions.
 * `keep` means this key still has a settled reconciliation. Empty sets mean it does not:
 * the key was removed, or the stored sets belonged to a different key and were not copied.
 */
export type ProviderAbsenceRevision =
  | { kind: 'replace'; models: readonly string[] }
  | { kind: 'clear' }
  | { kind: 'keep' };

export function providerAbsenceRevision(check: ProviderModelsCheck): ProviderAbsenceRevision {
  if (
    check.credentialFingerprint === null ||
    check.list.status === 'unconfigured' ||
    check.inference.status === 'unconfigured'
  ) {
    return { kind: 'clear' };
  }
  if (check.list.status === 'readable') {
    return { kind: 'replace', models: check.catalogOnly };
  }
  const settledForThisKey =
    check.listed.length > 0 || check.catalogOnly.length > 0 || check.providerOnly.length > 0;
  return settledForThisKey ? { kind: 'keep' } : { kind: 'clear' };
}

function keptSets(
  list: ModelsListResult,
  previous: ProviderModelsCheck | undefined,
  fingerprint: string | null,
  catalog: ReadonlySet<string>,
): { listed: string[]; catalogOnly: string[]; providerOnly: string[] } {
  if (list.status === 'ok') {
    const listed = [...list.ids];
    const sets = reconcile(catalog, listed);
    return { listed, catalogOnly: sets.catalogOnly, providerOnly: sets.providerOnly };
  }
  if (
    previous &&
    fingerprint !== null &&
    previous.credentialFingerprint === fingerprint &&
    list.status !== 'unconfigured'
  ) {
    return {
      listed: [...previous.listed],
      catalogOnly: [...previous.catalogOnly],
      providerOnly: [...previous.providerOnly],
    };
  }
  return { listed: [], catalogOnly: [], providerOnly: [] };
}

export function finalizeProviderModelsChecks(input: {
  now: Date;
  catalogProviders: ProviderMap;
  previous: readonly ProviderModelsCheck[];
  listed: ReadonlyMap<string, ModelsListResult>;
  probes: ReadonlyMap<string, ProbeOutcome>;
  fingerprints: ReadonlyMap<string, string | null>;
  priceProbe: (provider: string, model: string, tokensIn: number, tokensOut: number) => ProbePrice;
}): { checks: ProviderModelsCheck[] } {
  const previousByProvider = new Map(input.previous.map((check) => [check.provider, check]));
  const checks: ProviderModelsCheck[] = [];
  for (const provider of implementedProviderIds()) {
    const list = input.listed.get(provider) ?? {
      status: 'unreachable' as const,
      detail: 'missing',
    };
    const fingerprint = input.fingerprints.get(provider) ?? null;
    const previous = previousByProvider.get(provider);
    const catalogProvider = catalogProviderFor(provider) ?? null;
    if (fingerprint === null || list.status === 'unconfigured') {
      checks.push(
        canonicalProviderCheck({
          provider,
          catalogProvider,
          list: { status: 'unconfigured' },
          inference: { status: 'unconfigured' },
          listed: [],
          catalogOnly: [],
          providerOnly: [],
          credentialFingerprint: null,
        }),
      );
      continue;
    }
    const receipt = previous?.probe;
    const bound = sameCredential(receipt, fingerprint) ? receipt : undefined;
    const permanent =
      bound?.status === 'succeeded' ||
      (bound?.status === 'failed' && (bound.httpStatus === 401 || bound.httpStatus === 403));
    const waiting =
      bound !== undefined &&
      (bound.status === 'claimed' || bound.status === 'unsettled') &&
      holdIsFresh(bound, input.now);
    const outcome =
      permanent || (waiting && bound.status !== 'claimed') ? undefined : input.probes.get(provider);
    const held = outcome ? undefined : permanent || waiting ? bound : undefined;
    const sets = keptSets(
      list,
      previous,
      fingerprint,
      catalogIds(input.catalogProviders, catalogProvider),
    );
    const listFailed = list.status === 'auth_failed';
    const check: ProviderModelsCheck = {
      provider,
      catalogProvider,
      list: listAccess(list),
      inference: listFailed
        ? { status: 'auth_failed', httpStatus: list.httpStatus, errorType: list.errorType }
        : inferenceAccess(outcome, held),
      listed: sets.listed,
      catalogOnly: sets.catalogOnly,
      providerOnly: sets.providerOnly,
      credentialFingerprint: fingerprint,
    };
    const spec = probeSpec(provider);
    if (!listFailed && held && held.status !== 'claimed') check.probe = copyProbe(held);
    else if (!listFailed && outcome && spec && rememberOutcome(outcome)) {
      const price = outcome.usage.known
        ? input.priceProbe(provider, spec.model, outcome.usage.tokensIn, outcome.usage.tokensOut)
        : {
            costUsd: null,
            costBasis: 'unknown' as const,
            costRef: `unobserved:model-catalog-probe/${provider}/${spec.model}`,
          };
      check.probe = receiptFor(outcome, spec.model, input.now.toISOString(), price, fingerprint);
      const tokens = outcome.usage.known
        ? `${outcome.usage.tokensIn}/${outcome.usage.tokensOut}`
        : 'unknown';
      console.info(
        `[model-catalog] auth probe ${provider}/${spec.model} ${check.probe.status} tokens=${tokens} cost_usd=${price.costUsd ?? 'unknown'}`,
      );
    } else if (!listFailed && waiting && bound?.status === 'claimed' && !outcome) {
      check.probe = copyProbe(bound);
    }
    checks.push(canonicalProviderCheck(check));
  }
  return { checks };
}

export function probePriceFor(
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
  rates: { input: number; output: number } | undefined,
): ProbePrice {
  if (provider === 'anthropic-sub') {
    return { costUsd: 0, costBasis: 'estimated', costRef: ANTHROPIC_SUB_CONTRACT_REF };
  }
  if (!rates) {
    return {
      costUsd: null,
      costBasis: 'unknown',
      costRef: `unpriced:model-catalog-probe/${provider}/${model}`,
    };
  }
  const cost = (tokensIn * rates.input + tokensOut * rates.output) / 1_000_000;
  if (!Number.isFinite(cost) || cost < 0) {
    return {
      costUsd: null,
      costBasis: 'unknown',
      costRef: `unpriced:model-catalog-probe/${provider}/${model}`,
    };
  }
  return { costUsd: cost, costBasis: 'estimated', costRef: `models.dev:${provider}/${model}` };
}
