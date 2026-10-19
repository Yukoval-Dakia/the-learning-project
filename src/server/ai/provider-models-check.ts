// YUK-1563 — per configured provider, GET /models and reconcile with the
// models.dev bucket. Auth failure and a missing key are statuses. Neither
// removes a catalog model. Each implemented provider gets at most one auth
// probe; a stored receipt is what stops the next refresh from probing again.
// Chat probes ask for 1 token. Responses asks for 16, its API minimum.

import type { Provider } from '@/ai/task-spec';
import { CATALOG_PROVIDER_BY_INTERNAL } from './model-profiles';
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
const ERROR_TYPE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SESSION_HEADER = 'catalog-auth-probe';

export type ProviderAuthState =
  | { status: 'unconfigured' }
  | { status: 'ok' }
  | { status: 'auth_failed'; httpStatus: number; errorType: string }
  | { status: 'unreachable'; detail: string };

export interface ProviderProbeReceipt {
  status: 'succeeded' | 'failed';
  at: string;
  model: string;
  httpStatus: number | null;
  errorType: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  costBasis: 'estimated' | 'unknown';
}

export interface ProviderModelsCheck {
  provider: string;
  catalogProvider: string | null;
  auth: ProviderAuthState;
  listed: readonly string[];
  catalogOnly: readonly string[];
  providerOnly: readonly string[];
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
  | { kind: 'accepted'; httpStatus: number; tokensIn: number; tokensOut: number }
  | {
      kind: 'auth_failed';
      httpStatus: number;
      errorType: string;
      tokensIn: number;
      tokensOut: number;
    }
  | {
      kind: 'unsettled';
      httpStatus: number | null;
      errorType: string | null;
      tokensIn: number;
      tokensOut: number;
    };

export interface ProbeLedgerBill {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
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

function readUsage(body: string): { tokensIn: number; tokensOut: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { tokensIn: 0, tokensOut: 0 };
  }
  const usage = asJson(asJson(parsed)?.usage);
  const input = usage?.prompt_tokens ?? usage?.input_tokens;
  const output = usage?.completion_tokens ?? usage?.output_tokens;
  const tokensIn = typeof input === 'number' && input >= 0 ? input : 0;
  const tokensOut = typeof output === 'number' && output >= 0 ? output : 0;
  return { tokensIn, tokensOut };
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
  } catch {
    return { status: 'unreachable', detail: 'network' };
  }
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
      } catch {
        return [provider, { status: 'unreachable', detail: 'network' } as const] as const;
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
  const unsettled = {
    kind: 'unsettled' as const,
    httpStatus: null,
    errorType: null,
    tokensIn: 0,
    tokensOut: 0,
  };
  if (!spec || !credential || !root) return unsettled;
  const headers = { ...authHeaders(provider, credential), 'content-type': 'application/json' };
  try {
    const response = await fetchImpl(probeUrl(root, spec), {
      method: 'POST',
      headers,
      body: probeBody(spec),
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await response.text();
    const usage = readUsage(text);
    if (response.status === 401 || response.status === 403) {
      return {
        kind: 'auth_failed',
        httpStatus: response.status,
        errorType: readErrorType(text),
        ...usage,
      };
    }
    if (!response.ok) {
      return {
        kind: 'unsettled',
        httpStatus: response.status,
        errorType: readErrorType(text),
        ...usage,
      };
    }
    return { kind: 'accepted', httpStatus: response.status, ...usage };
  } catch {
    return unsettled;
  }
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

function authFromOutcome(outcome: ProbeOutcome): ProviderAuthState | undefined {
  if (outcome.kind === 'accepted') return { status: 'ok' };
  if (outcome.kind === 'auth_failed') {
    return { status: 'auth_failed', httpStatus: outcome.httpStatus, errorType: outcome.errorType };
  }
  return undefined;
}

function decisiveReceipt(probe: ProviderProbeReceipt | undefined): probe is ProviderProbeReceipt {
  if (!probe) return false;
  if (probe.status === 'succeeded') return true;
  return probe.httpStatus === 401 || probe.httpStatus === 403;
}

function authFromReceipt(probe: ProviderProbeReceipt): ProviderAuthState {
  if (probe.status === 'succeeded') return { status: 'ok' };
  return {
    status: 'auth_failed',
    httpStatus: probe.httpStatus ?? 401,
    errorType: probe.errorType ?? 'unknown',
  };
}

function authState(
  list: ModelsListResult,
  outcome: ProbeOutcome | undefined,
  previous: ProviderModelsCheck | undefined,
): ProviderAuthState {
  if (list.status === 'unconfigured') return { status: 'unconfigured' };
  if (list.status === 'auth_failed') {
    return { status: 'auth_failed', httpStatus: list.httpStatus, errorType: list.errorType };
  }
  if (list.status === 'ok') return { status: 'ok' };
  const live = outcome ? authFromOutcome(outcome) : undefined;
  if (live) return live;
  const receipt = previous?.probe;
  if (decisiveReceipt(receipt)) return authFromReceipt(receipt);
  if (list.status === 'unsupported') return { status: 'unreachable', detail: 'models_endpoint' };
  return { status: 'unreachable', detail: list.detail };
}

function shouldProbe(list: ModelsListResult, previous: ProviderModelsCheck | undefined): boolean {
  if (decisiveReceipt(previous?.probe)) return false;
  if (list.status === 'unconfigured' || list.status === 'auth_failed') return false;
  if (list.status === 'unreachable') return false;
  return true;
}

function receiptFor(
  outcome: Exclude<ProbeOutcome, { kind: 'unsettled' }>,
  model: string,
  at: string,
  price: ProbePrice,
): ProviderProbeReceipt {
  return {
    status: outcome.kind === 'accepted' ? 'succeeded' : 'failed',
    at,
    model,
    httpStatus: outcome.httpStatus,
    errorType: outcome.kind === 'accepted' ? null : outcome.errorType,
    tokensIn: outcome.tokensIn,
    tokensOut: outcome.tokensOut,
    costUsd: price.costUsd,
    costBasis: price.costBasis,
  };
}

function ledgerBill(
  provider: string,
  outcome: ProbeOutcome,
  model: string,
  price: ProbePrice,
): ProbeLedgerBill | undefined {
  const consumed = outcome.tokensIn + outcome.tokensOut > 0;
  if (outcome.kind === 'unsettled') {
    if (!consumed) return undefined;
    return {
      provider,
      model,
      tokensIn: outcome.tokensIn,
      tokensOut: outcome.tokensOut,
      costUsd: price.costUsd,
      costBasis: price.costBasis,
      costRef: price.costRef,
      outcome: 'failed_retryable',
    };
  }
  if (outcome.kind === 'auth_failed' && !consumed) return undefined;
  return {
    provider,
    model,
    tokensIn: outcome.tokensIn,
    tokensOut: outcome.tokensOut,
    costUsd: price.costUsd,
    costBasis: price.costBasis,
    costRef: price.costRef,
    outcome: outcome.kind === 'accepted' ? 'success' : 'failed_permanent',
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
    const bill = ledgerBill(
      provider,
      outcome,
      spec.model,
      priceProbe(provider, spec.model, outcome.tokensIn, outcome.tokensOut),
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
  };
}

export function canonicalProviderCheck(check: ProviderModelsCheck): ProviderModelsCheck {
  const auth = check.auth;
  const storedAuth: ProviderAuthState =
    auth.status === 'auth_failed'
      ? { status: 'auth_failed', httpStatus: auth.httpStatus, errorType: auth.errorType }
      : auth.status === 'unreachable'
        ? { status: 'unreachable', detail: auth.detail }
        : auth.status === 'ok'
          ? { status: 'ok' }
          : { status: 'unconfigured' };
  const stored: ProviderModelsCheck = {
    provider: check.provider,
    catalogProvider: check.catalogProvider,
    auth: storedAuth,
    listed: [...check.listed].sort(),
    catalogOnly: [...check.catalogOnly].sort(),
    providerOnly: [...check.providerOnly].sort(),
  };
  if (check.probe) stored.probe = copyProbe(check.probe);
  return stored;
}

export function parseProviderChecks(payload: unknown): ProviderModelsCheck[] {
  const raw = asJson(payload)?.provider_checks;
  if (!Array.isArray(raw)) return [];
  const checks: ProviderModelsCheck[] = [];
  for (const item of raw) {
    const row = asJson(item);
    if (!row || typeof row.provider !== 'string') continue;
    if (!isKnownProvider(row.provider)) continue;
    const auth = asJson(row.auth);
    if (!auth || typeof auth.status !== 'string') continue;
    let parsedAuth: ProviderAuthState;
    if (auth.status === 'unconfigured') parsedAuth = { status: 'unconfigured' };
    else if (auth.status === 'ok') parsedAuth = { status: 'ok' };
    else if (
      auth.status === 'auth_failed' &&
      typeof auth.httpStatus === 'number' &&
      typeof auth.errorType === 'string'
    ) {
      parsedAuth = {
        status: 'auth_failed',
        httpStatus: auth.httpStatus,
        errorType: auth.errorType,
      };
    } else if (auth.status === 'unreachable' && typeof auth.detail === 'string') {
      parsedAuth = { status: 'unreachable', detail: auth.detail };
    } else continue;
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    const check: ProviderModelsCheck = {
      provider: row.provider,
      catalogProvider: typeof row.catalogProvider === 'string' ? row.catalogProvider : null,
      auth: parsedAuth,
      listed: strings(row.listed),
      catalogOnly: strings(row.catalogOnly),
      providerOnly: strings(row.providerOnly),
    };
    const probe = asJson(row.probe);
    if (
      probe &&
      (probe.status === 'succeeded' || probe.status === 'failed') &&
      typeof probe.at === 'string' &&
      typeof probe.model === 'string'
    ) {
      check.probe = {
        status: probe.status,
        at: probe.at,
        model: probe.model,
        httpStatus: typeof probe.httpStatus === 'number' ? probe.httpStatus : null,
        errorType: typeof probe.errorType === 'string' ? probe.errorType : null,
        tokensIn: typeof probe.tokensIn === 'number' ? probe.tokensIn : 0,
        tokensOut: typeof probe.tokensOut === 'number' ? probe.tokensOut : 0,
        costUsd: typeof probe.costUsd === 'number' ? probe.costUsd : null,
        costBasis: probe.costBasis === 'estimated' ? 'estimated' : 'unknown',
      };
    }
    checks.push(canonicalProviderCheck(check));
  }
  return checks.sort((left, right) => left.provider.localeCompare(right.provider));
}

export function providerAuthLabel(check: ProviderModelsCheck): string {
  if (check.auth.status === 'auth_failed') {
    return `auth_failed:${check.auth.httpStatus}:${check.auth.errorType}`;
  }
  if (check.auth.status === 'unreachable') return `unreachable:${check.auth.detail}`;
  return check.auth.status;
}

export async function collectProviderProbes(input: {
  fetchImpl: ProviderFetch;
  env: Record<string, string | undefined>;
  listed: ReadonlyMap<string, ModelsListResult>;
  previous: readonly ProviderModelsCheck[];
}): Promise<ReadonlyMap<string, ProbeOutcome>> {
  const previousByProvider = new Map(input.previous.map((check) => [check.provider, check]));
  const probes = new Map<string, ProbeOutcome>();
  for (const provider of implementedProviderIds()) {
    if (!probeSpec(provider)) continue;
    const list = input.listed.get(provider) ?? {
      status: 'unreachable' as const,
      detail: 'missing',
    };
    if (!shouldProbe(list, previousByProvider.get(provider))) continue;
    probes.set(provider, await runProbe(provider, input.fetchImpl, input.env));
  }
  return probes;
}

export function finalizeProviderModelsChecks(input: {
  now: Date;
  catalogProviders: ProviderMap;
  previous: readonly ProviderModelsCheck[];
  listed: ReadonlyMap<string, ModelsListResult>;
  probes: ReadonlyMap<string, ProbeOutcome>;
  priceProbe: (provider: string, model: string, tokensIn: number, tokensOut: number) => ProbePrice;
}): { checks: ProviderModelsCheck[] } {
  const previousByProvider = new Map(input.previous.map((check) => [check.provider, check]));
  const checks: ProviderModelsCheck[] = [];
  for (const provider of implementedProviderIds()) {
    const list = input.listed.get(provider) ?? {
      status: 'unreachable' as const,
      detail: 'missing',
    };
    const previous = previousByProvider.get(provider);
    const keptReceipt = decisiveReceipt(previous?.probe) ? previous.probe : undefined;
    const outcome = keptReceipt ? undefined : input.probes.get(provider);
    const auth = authState(list, outcome, previous);
    const spec = probeSpec(provider);
    const catalogProvider = CATALOG_PROVIDER_BY_INTERNAL[provider] ?? null;
    const keptList = list.status !== 'ok' && auth.status === 'unreachable' ? previous : undefined;
    const listed = list.status === 'ok' ? [...list.ids] : keptList ? [...keptList.listed] : [];
    const sets =
      list.status === 'ok'
        ? reconcile(catalogIds(input.catalogProviders, catalogProvider), listed)
        : keptList
          ? { catalogOnly: [...keptList.catalogOnly], providerOnly: [...keptList.providerOnly] }
          : { catalogOnly: [] as string[], providerOnly: [] as string[] };
    const check: ProviderModelsCheck = {
      provider,
      catalogProvider,
      auth,
      listed,
      catalogOnly: sets.catalogOnly,
      providerOnly: sets.providerOnly,
    };
    if (keptReceipt) check.probe = copyProbe(keptReceipt);
    else if (outcome && spec) {
      const price = input.priceProbe(provider, spec.model, outcome.tokensIn, outcome.tokensOut);
      if (outcome.kind !== 'unsettled') {
        check.probe = receiptFor(outcome, spec.model, input.now.toISOString(), price);
        console.info(
          `[model-catalog] auth probe ${provider}/${spec.model} ${check.probe.status} tokens_in=${outcome.tokensIn} tokens_out=${outcome.tokensOut} cost_usd=${price.costUsd ?? 'unknown'}`,
        );
      }
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
