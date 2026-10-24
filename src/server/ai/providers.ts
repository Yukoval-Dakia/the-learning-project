// Task configuration owns model selection. The runtime catalog supplies facts,
// Pi supplies transport, and credentials stay scoped to the provider.

import { type KnownProvider, type TaskDefinition, canonicalProviderName } from '@/ai/task-spec';
import { type Provider, type TaskKind, tasks } from '@/capabilities/task-registry';
import {
  customProviderDefinition,
  customProviderDefinitions,
  looksLikeCustomProviderId,
} from '@/core/config/custom-providers';
import { getLaneOverride, getTaskOverride } from '@/core/config/store';
import { type ProviderModelBinding, resolveModelProfile } from './model-profiles';
import { executablePiModel, nativePiModelApi, piProviderId } from './pi-provider-catalog';

// YUK-608 — re-export the provider union so override consumers (solve-lane, verify-framework)
// type `override.provider` as `Provider` (matching the runner's RunTaskCallCtx) without each
// reaching back into the registry.
export type { Provider };

/** A key-auth provider: bearer/x-api-key value read from `apiKeyEnv`. */
interface KeyProviderConfig {
  authMode: 'key';
  /** Env var holding the bearer / x-api-key value. */
  apiKeyEnv: string;
  /** Optional human-readable note shown in errors when the env is missing. */
  description?: string;
}

/**
 * An OAuth-auth provider (YUK-365): a long-lived subscription token read from
 * `oauthTokenEnv`, using Anthropic's protocol and catalog endpoint.
 */
interface OauthProviderConfig {
  authMode: 'oauth';
  /** Env var holding the subscription OAuth token. */
  oauthTokenEnv: string;
  description?: string;
}

type ProviderConfig = KeyProviderConfig | OauthProviderConfig;

/** Execution policy only; model facts and exceptions belong to model-profiles. */
interface ProviderModelBindings {
  modelDefaults?: ProviderModelBinding;
  models?: Record<string, ProviderModelBinding>;
}

type BoundProviderConfig = ProviderConfig & ProviderModelBindings;

const PROVIDERS: Record<KnownProvider, BoundProviderConfig> = {
  anthropic: {
    authMode: 'key',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    description: 'Anthropic direct (pay-as-you-go API)',
    // YUK-924 site 3 — the ONLY metered pay-as-you-go lane: SDK result USD
    // totals are contractual and maxBudgetUsd is a real per-run ceiling.
    // (Was the hard-coded `resolved.provider === 'anthropic'` check in
    // runner.ts buildQueryOptions.)
    modelDefaults: { execution: { meteredUsd: true, budgetClass: 'heavy' } },
  },
  xiaomi: {
    authMode: 'key',
    apiKeyEnv: 'XIAOMI_API_KEY',
    description: 'Native pi Xiaomi preset (OpenAI Completions)',
    models: {
      'mimo-v2.5-pro': {
        execution: { localPricebook: true },
      },
      // YUK-924 site 5 — local USD token pricebook membership (rates remain the
      // dated public estimate in pricing.ts, reusing the model catalog).
      'mimo-v2.5': {
        execution: { localPricebook: true },
      },
    },
  },
  'xiaomi-token-plan': {
    authMode: 'key',
    apiKeyEnv: 'XIAOMI_TOKEN_PLAN_API_KEY',
    description: 'Xiaomi official Token Plan via native pi OpenAI Completions',
    modelDefaults: {
      execution: { meteredUsd: false },
    },
  },
  'zhipuai-coding-plan': {
    authMode: 'key',
    apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
    description: 'Native pi Z.AI Coding CN preset (OpenAI Completions)',
    models: {
      // YUK-924 site 1 — flash durable-evidence tier (YUK-839 ruling ①b): the
      // burn-in R2 measured leg maxima that justify the relaxed durable budgets
      // (evidence-review.ts maps this class to concrete ms values). glm-5.2 has
      // no such tier and keeps 'standard'.
      'glm-5.3-flash': {
        execution: { timeoutClass: 'durable-heavy', budgetClass: 'cheap' },
      },
      'glm-5.3': {
        execution: { budgetClass: 'heavy' },
      },
    },
  },
  openrouter: {
    authMode: 'key',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    description:
      'OpenRouter gateway — TYPED decisions lane only (native /api/v1/systemone, YUK-1049); no chat façade',
    models: {
      // Provider-reported cost is not a transport-enforced budget.
      'typesafe/jev-1.13': {
        execution: { budgetClass: 'cheap', meteredUsd: false },
      },
    },
  },
  gateway: {
    authMode: 'key',
    apiKeyEnv: 'VERCEL_AI_GATEWAY_TOKEN',
    description: 'Vercel AI Gateway (not currently in use)',
  },
  openai: {
    authMode: 'key',
    apiKeyEnv: 'OPENAI_API_KEY',
    description: 'OpenAI direct first-party (gpt-6-astra via the Responses API, YUK-1027)',
    modelDefaults: {
      // pi usage.cost is the catalog rate-card estimate, not a contractual
      // invoice (attempt-cost.ts classifies it 'estimated'); meteredUsd stays
      // false until the P2 budget work proves real accounting on this lane.
      execution: { meteredUsd: false },
    },
  },
  // The adapter adds x-opencode-session from the run id on every request.
  'opencode-go': {
    authMode: 'key',
    apiKeyEnv: 'OPENCODE_API_KEY',
    description: 'OpenCode Go subscription catalog via the pi execution adapter',
    modelDefaults: {
      // pi usage.cost is a catalog-rate estimate, not a contractual invoice
      // (design §6 R1): never metered.
      execution: { meteredUsd: false },
    },
  },
  // YUK-365 — subscription-OAuth lane. Opus 4.8 via the owner's Claude Max
  // subscription. No baseUrl (first-party endpoint only); no apiKeyEnv (it reads
  // the OAuth token, not a key). Opt-in ONLY via AI_PROVIDER_OVERRIDE.
  'anthropic-sub': {
    authMode: 'oauth',
    oauthTokenEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
    description: 'Anthropic first-party via Claude Max subscription OAuth (Opus 4.8)',
    // YUK-924 site 3 — the subscription lane serves the same claude models the
    // catalog describes, but flat quota means maxBudgetUsd would be a
    // wired-but-inert lie. Explicitly classified (not left to defaults) so the
    // binding stays the authoritative lane classification.
    modelDefaults: { execution: { meteredUsd: false, budgetClass: 'heavy' } },
  },
};

/**
 * YUK-924 — the model-binding half of the provider registry, derived from the
 * PROVIDERS entries above (single source of truth: edit the entries, not this
 * projection). ModelProfile merges this execution policy separately from catalog facts.
 */
export const PROVIDER_MODEL_BINDINGS: Readonly<Record<Provider, ProviderModelBindings>> =
  Object.fromEntries(
    Object.entries(PROVIDERS).map(([name, config]) => [
      name,
      {
        ...(config.modelDefaults !== undefined ? { modelDefaults: config.modelDefaults } : {}),
        ...(config.models !== undefined ? { models: config.models } : {}),
      },
    ]),
  ) as Readonly<Record<Provider, ProviderModelBindings>>;

/**
 * The model id used when the subscription-OAuth lane is selected and no explicit
 * model override is given. Claude Max defaults to Opus 4.8.
 */
export const ANTHROPIC_SUB_DEFAULT_MODEL = 'claude-opus-4-8';
/**
 * Declared model ids for the direct-provider lanes that don't ride pi — the
 * catalog role is identical to the binding `models` maps above, so C1-10 keeps
 * them here rather than scattered in lane clients:
 *   - LEGACY_GLM_MODEL_ID — Mem0 extraction + edge/memory reconciliation's
 *     unpinned fallback (glm.* chat-completions lanes, bigmodel endpoint)
 *   - GLM_OCR_MODEL_ID — glm.ocr-layout-parsing lane (Zhipu layout_parsing)
 *   - DASHSCOPE_EMBED_MODEL_ID — dashscope.embedding lane (ai/embed.ts) AND
 *     the Mem0 embedder default (memory/client.ts); the lane keeps its
 *     dedicated DashScope credential and lane-owned dimensions (1024).
 */
export const LEGACY_GLM_MODEL_ID = 'glm-5.2';
export const GLM_OCR_MODEL_ID = 'glm-ocr';
export const DASHSCOPE_EMBED_MODEL_ID = 'text-embedding-v4';
// YUK-1027 — the openai lane's only bound model (PROVIDERS.openai.models key);
// referenced by crossoverModelForProvider so a provider-only judge override
// resolves a pair the builtin catalog can actually serve.
export const OPENAI_ASTRA_MODEL_ID = 'gpt-6-astra';

/**
 * Single source of truth for which providers authenticate via the OAuth lane
 * and therefore require `oauthTokenEnv` at call time. Derived by filtering
 * `PROVIDERS` on `authMode === 'oauth'` so adding a new OAuth provider cannot
 * drift — every caller (vision-judge degrade-before-call check, future hooks)
 * delegates to this set rather than re-declaring provider names.
 */
export const OAUTH_PROVIDERS: ReadonlySet<Provider> = new Set(
  Object.entries(PROVIDERS)
    .filter(([, config]) => config.authMode === 'oauth')
    .map(([name]) => name as Provider),
);

/** Predicate form of `OAUTH_PROVIDERS` for readability at call sites. */
export function isOauthProvider(provider: Provider): boolean {
  return OAUTH_PROVIDERS.has(provider);
}

/**
 * YUK-608 — is `name` one of the known providers? Narrowing guard so callers that
 * receive an untrusted provider string (env-configured overrides) can validate it
 * before routing, without re-declaring the provider name set. Custom providers
 * (YUK-1563 part 4) count as known while their definition is live in the registry.
 */
export function isKnownProvider(name: string): name is Provider {
  if (Object.hasOwn(PROVIDERS, name)) return true;
  return looksLikeCustomProviderId(name) && customProviderDefinition(name) !== undefined;
}

export function readProviderId(name: string): Provider | undefined {
  const canonical = canonicalProviderName(name);
  if (Object.hasOwn(PROVIDERS, canonical)) return canonical as KnownProvider;
  return isKnownProvider(canonical) ? (canonical as Provider) : undefined;
}

/**
 * YUK-608 — is this provider's credential lane configured in THIS process's env? An
 * OAuth provider needs its `oauthTokenEnv`; a key provider needs its `apiKeyEnv`.
 * Lets a caller PRE-FLIGHT an optional override lane and fail-open to the default
 * provider when the lane isn't wired here (e.g. the subscription token is absent on
 * a given deploy), instead of letting `resolveTaskProvider` throw mid-call. Mirrors
 * the missing-env checks `resolveTaskProvider` performs, without allocating a binding.
 *
 * The env-NAME lookup lives in `providerCredentialEnvName` (single source) so the
 * admin config read face (via the composition-root facts seam) can surface WHICH
 * env var a lane reads without ever touching its VALUE.
 */
export function providerCredentialEnvName(provider: Provider): string | undefined {
  if (looksLikeCustomProviderId(provider)) return customProviderDefinition(provider)?.apiKeyEnv;
  const config = PROVIDERS[provider as KnownProvider];
  if (!config) return undefined;
  return config.authMode === 'oauth' ? config.oauthTokenEnv : config.apiKeyEnv;
}

export function isProviderLaneReady(provider: Provider): boolean {
  const envName = providerCredentialEnvName(provider);
  return envName !== undefined && Boolean(process.env[envName]);
}

/**
 * YUK-1007 — read-only projection of the provider registry's AUTH surface for the
 * config read face (`GET /api/admin/config` providers[]): one row per PROVIDERS
 * entry with the credential env NAME (never the value) and the implemented flag
 * (isProviderImplemented — same predicate resolveTaskProvider enforces). Derived
 * from PROVIDERS itself so adding a provider cannot drift this list.
 */
export interface ProviderAuthSurfaceRow {
  readonly name: Provider;
  readonly authMode: 'key' | 'oauth';
  readonly credentialEnvName: string;
  readonly implemented: boolean;
}

export function providerAuthSurface(): readonly ProviderAuthSurfaceRow[] {
  const known = (Object.keys(PROVIDERS) as KnownProvider[]).map((name) => ({
    name: name as Provider,
    authMode: PROVIDERS[name].authMode,
    credentialEnvName: providerCredentialEnvName(name) ?? '',
    implemented: isProviderImplemented(name),
  }));
  const custom = customProviderDefinitions().map((definition) => ({
    name: definition.id as Provider,
    authMode: 'key' as const,
    credentialEnvName: definition.apiKeyEnv,
    implemented: isProviderImplemented(definition.id),
  }));
  return [...known, ...custom];
}

// YUK-608 — the KEY-auth providers actually wired to a working endpoint. openrouter / gateway
// are reserved-but-not-implemented (their wire shapes differ) and `resolveTaskProvider`
// throws for them below. 'anthropic-sub' is the OAuth lane (handled before the key branch), so it
// is NOT in this key-auth set; `isProviderImplemented` folds it back in via `isOauthProvider`.
// YUK-921 P4 (YUK-1025) — post-SDK-retirement the pi adapter serves every
// implemented provider: 'opencode-go' joined the key-auth set when Adapter A
// was deleted (its pi-builtin catalog + per-request apiKey already worked).
const IMPLEMENTED_KEY_PROVIDERS: ReadonlySet<Provider> = new Set([
  'anthropic',
  'xiaomi',
  'xiaomi-token-plan',
  'zhipuai-coding-plan',
  'opencode-go',
  'openai',
]);

/**
 * YUK-608 — is `provider` actually wired to a working endpoint (vs reserved-but-not-implemented)?
 * True for the wired key-auth providers plus every OAuth-lane provider (anthropic-sub). SINGLE
 * source of truth: `resolveTaskProvider`'s "reserved but not implemented" guard AND override
 * pre-flights (solve-lane) both read it, so a caller can fail-open to the default lane BEFORE
 * dispatch instead of resolving to a provider that throws mid-call — and the wired set can never
 * drift into two hard-coded copies.
 */
export function isProviderImplemented(provider: Provider): boolean {
  if (looksLikeCustomProviderId(provider)) return customProviderDefinition(provider) !== undefined;
  return IMPLEMENTED_KEY_PROVIDERS.has(provider) || isOauthProvider(provider);
}

/**
 * Model used for the one-token catalog auth probe. This is not a task default:
 * the probe only checks that the credential is accepted.
 * opencode-go stays on deepseek-v4.1-flash at high effort, with no tool_choice.
 */
const AUTH_PROBE_PIN: Partial<Record<Provider, string>> = {
  'opencode-go': 'deepseek-v4.1-flash',
  anthropic: 'claude-haiku-4-5',
  'anthropic-sub': 'claude-opus-4-8',
  xiaomi: 'mimo-v2.5',
  'xiaomi-token-plan': 'mimo-v2.6-pro',
  'zhipuai-coding-plan': 'glm-5.3-flash',
  openai: 'gpt-6-astra',
};

export function providerAuthProbeModel(provider: Provider): string | undefined {
  return AUTH_PROBE_PIN[provider];
}

/** Implemented lanes, stable order. OpenRouter stays out: it is typed-only. */
export function implementedProviderIds(): readonly Provider[] {
  const known = (Object.keys(PROVIDERS) as KnownProvider[])
    .filter((provider) => isProviderImplemented(provider))
    .sort();
  const custom = customProviderDefinitions().map((definition) => definition.id as Provider);
  return [...known, ...custom];
}

/**
 * Root the product actually calls, with `/v1` included, for a provider `/models`
 * read. The probe model selects the same endpoint as execution.
 */
export function providerModelsRoot(
  provider: Provider,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!isProviderImplemented(provider)) return null;
  // Custom providers read their own configured endpoint; no probe model exists
  // and no probe is ever sent for them.
  if (looksLikeCustomProviderId(provider)) {
    const definition = customProviderDefinition(provider);
    if (!definition) return null;
    return definition.protocol === 'anthropic-messages' && !definition.baseUrl.endsWith('/v1')
      ? `${definition.baseUrl}/v1`
      : definition.baseUrl;
  }
  const model = providerAuthProbeModel(provider);
  if (!model) return null;
  try {
    const base = resolveModelProfile(provider, model, env).baseUrl;
    if (!base) return null;
    // Root routing depends only on the wire protocol; other facts gate execution,
    // not the endpoint. Without an api there is no protocol to route a root from.
    const api = nativePiModelApi(provider, model, env);
    if (!api) return null;
    return api === 'anthropic-messages' && !base.endsWith('/v1') ? `${base}/v1` : base;
  } catch {
    return null;
  }
}

// YUK-1049 — the openrouter lane is implemented ONLY for typed-execution
// tasks (execution:'typed'): its wired surface is the native decisions
// endpoint, not the chat façade pi drives. The lane is deliberately absent
// from IMPLEMENTED_KEY_PROVIDERS/isProviderImplemented so generic routing and
// override pre-flights still classify it as not-wired; resolveTaskProvider
// consults this predicate instead, keyed on the resolved task's own
// execution kind — a chat task can never resolve onto the typed lane, and a
// typed task resolves here even though the generic predicate says unimplemented.
export function isProviderImplementedForTask(provider: Provider, kind: TaskKind): boolean {
  // Custom providers are chat lanes only: their configured protocol has no
  // typed wire contract.
  if (looksLikeCustomProviderId(provider)) {
    return (
      ((tasks[kind] as TaskDefinition).execution ?? 'chat') === 'chat' &&
      customProviderDefinition(provider) !== undefined
    );
  }
  // The catalog map's value is the union of every spec's literal shape;
  // `execution` is an optional declared field — read through the interface
  // view (same pattern as TaskDefinition reads in run-lifecycle.ts).
  if (
    ((tasks[kind] as TaskDefinition).execution ?? 'chat') === 'typed' &&
    provider === 'openrouter'
  )
    return true;
  return isProviderImplemented(provider);
}

// YUK-365 / YUK-608 — providers whose registry-default model path yields a RUNNABLE model without
// an explicit override.model: xiaomi (the mimo endpoint IS the registry default) and anthropic-sub
// (built-in Opus 4.8 default). Every OTHER provider's registry default is a mimo id its endpoint
// won't accept, so selecting it via override REQUIRES an explicit model.
const PROVIDERS_WITH_RUNNABLE_DEFAULT_MODEL: ReadonlySet<Provider> = new Set([
  'xiaomi',
  'anthropic-sub',
]);

/**
 * YUK-608 — does selecting `provider` via an explicit override REQUIRE an explicit model? True for
 * every provider EXCEPT those with a runnable built-in default (xiaomi / anthropic-sub). Without
 * this, `{ provider: 'anthropic' }` alone resolves to the registry mimo model id and 404s on the
 * Anthropic-direct endpoint. SINGLE source of truth: `resolveTaskProvider`'s global-switch guard
 * AND override pre-flights (solve-lane) both read it, so the rule lives in exactly one place.
 */
export function providerRequiresExplicitModel(provider: Provider): boolean {
  return !PROVIDERS_WITH_RUNNABLE_DEFAULT_MODEL.has(provider);
}

/**
 * YUK-594 (W5 #TurRP) — the model a per-call provider CROSS-OVER must pin.
 *
 * `resolveTaskProvider` layers provider and model INDEPENDENTLY
 * (`override?.model ?? globalSwitch?.model ?? dbTaskOverride?.model ?? subDefaultModel`).
 * So a caller that hands it only `override.provider` — which is exactly what the durable judge's
 * fallback lane does — still
 * inherits a global `AI_PROVIDER_MODEL` from whatever lane it is crossing AWAY from. With
 * `AI_PROVIDER_OVERRIDE=xiaomi` + `AI_PROVIDER_MODEL=<mimo id>` and a fallback to
 * `anthropic-sub`, the last-chance retry would post a mimo model id to the subscription
 * endpoint and fail by construction — the one delivery whose whole job is to succeed.
 *
 * The per-provider answer: the subscription lane has its own built-in default; every other
 * runnable-default provider takes the task's registry model. Callers that cross providers must
 * pass this as `override.model` so nothing is inherited across the lane boundary.
 */
export function crossoverModelForProvider(provider: Provider, kind: TaskKind): string {
  // Lanes whose builtin catalog cannot serve the task's registry-default
  // (mimo) model id need their own crossover target — otherwise a provider-
  // only override resolves a pair that fails closed at adapter startup.
  if (provider === 'anthropic-sub') return ANTHROPIC_SUB_DEFAULT_MODEL;
  if (provider === 'openai') return OPENAI_ASTRA_MODEL_ID; // the lane's only bound model
  return tasks[kind].defaultModel;
}

/**
 * YUK-1547 — model-native reasoning params resolved from the per-task
 * `task.<kind>.reasoning` config layer. Keys are the model's own wire
 * parameter names (DeepSeek `reasoning_effort`); values pass through verbatim
 * — there is deliberately no unified effort-tier enum or mapping on this path
 * (owner 2026-10-18: don't force-align effort to preset tiers; validate only
 * against the values the model itself supports). Companion switches the
 * model's own compat requires (DeepSeek `thinking:{type:'enabled'}`) are
 * DERIVED at resolution from the model's thinkingFormat — never configured,
 * never applied to non-deepseek formats.
 */
export interface TaskNativeReasoningParams {
  readonly reasoning_effort?: string;
  /** Compat-derived wire switch (deepseek format only today). */
  readonly thinking?: { readonly type: 'enabled' };
}

/**
 * YUK-1547 — which layer produced the resolved provider, frozen at
 * resolution time and recorded on the run record (`model_profile_resolved`
 * `selection_rule`) + reopen preflight receipt, so a paid effect can be
 * proven against the layer that actually selected it.
 */
export type TaskSelectionRule =
  | 'env_pin' // AI_PROVIDER_OVERRIDE env pin replaced the binding
  | 'task_pair_priority' // task.<kind>.override_global_pin opt-in: complete task pair beat the global pin
  | 'call_override' // explicit per-call override/provider arg (solver2 env, modelBinding)
  | 'global_pin' // globalSwitch: AI_PROVIDER_* env or DB lane.global.*
  | 'task_config' // DB task.<kind>.provider with no pin present
  | 'registry_default'; // tasks[kind].defaultProvider

/**
 * Resolved provider binding handed to the runner. Discriminated on `authMode`:
 *   - 'key'   → { apiKey, baseUrl? } — the credential value, resolved once here.
 *   - 'oauth' → { apiKey } carries the subscription token VALUE (read once from
 *               `oauthTokenEnv`); pi's anthropic-messages driver detects the
 *               `sk-ant-oat*` shape and switches to Bearer auth + Claude Code
 *               identity headers against the first-party endpoint.
 */
export type ResolvedProvider =
  | {
      authMode: 'key';
      provider: Provider;
      model: string;
      apiKey: string;
      /** Undefined when neither the catalog nor a documented exception supplies it. */
      baseUrl?: string;
      /** Per-task model-native reasoning params, validated against the resolved model. */
      nativeReasoningParams?: TaskNativeReasoningParams;
      /** Which layer produced this binding — frozen at resolution for run receipts. */
      selectionRule?: TaskSelectionRule;
    }
  | {
      authMode: 'oauth';
      provider: Provider;
      model: string;
      /** Resolved subscription token value — passed as the per-request apiKey. */
      apiKey: string;
      /** Env-var NAME the token was read from (diagnostics only). */
      oauthTokenEnv: string;
      /** Per-task model-native reasoning params, validated against the resolved model. */
      nativeReasoningParams?: TaskNativeReasoningParams;
      /** Which layer produced this binding — frozen at resolution for run receipts. */
      selectionRule?: TaskSelectionRule;
    };

/**
 * YUK-365 — global provider override via env. When `AI_PROVIDER_OVERRIDE` is set
 * (e.g. `anthropic-sub`), EVERY task routes to that provider instead of its
 * registry `defaultProvider`. `AI_PROVIDER_MODEL` optionally overrides the model
 * (for `anthropic-sub` the default is `claude-opus-4-8`).
 *
 * SCOPE = GLOBAL (process-wide). This is the simplest switch that satisfies the
 * issue ("route AI tasks … to Opus via Max, default stays mimo"): the owner
 * flips the env and the whole process runs against the subscription lane.
 * For chat tasks the process env pin wins over explicit overrides, including
 * persisted model bindings. Typed non-chat protocols retain their explicit pin.
 *
 * Returns undefined when unset → callers fall through to the registry default
 * (current mimo behaviour, byte-for-byte).
 */
function readEnvOverride(
  env: NodeJS.ProcessEnv,
): { provider: Provider; model?: string } | undefined {
  const raw = env.AI_PROVIDER_OVERRIDE;
  if (!raw) return undefined;
  const provider = readProviderId(raw);
  if (!provider) {
    throw new Error(
      `AI_PROVIDER_OVERRIDE='${raw}' is not a known provider; expected one of ${Object.keys(PROVIDERS).join(' | ')}`,
    );
  }
  const model = env.AI_PROVIDER_MODEL || undefined;
  return { provider, model };
}

/**
 * YUK-1007 — 全局 provider pin 的合并层：env（AI_PROVIDER_OVERRIDE，operator
 * 钉死进程，最高优先）> DB `lane.global.provider`/`lane.global.model`（面板
 * 写的 DB 位）。env 缺席时 DB pin 生效；两者都缺席 → undefined。
 * DB 值经 hydrate schema + 写端 readProviderId 校验，但手工注入行可能在写端
 * 之外落地——这里仍走同一 unknown-name throw（与 env 侧一致的 config-error
 * 语义，让错配立刻可观测而不是静默降级）。
 *
 * YUK-1007 读面（P1 诚实修正）：本函数是全局 pin 的**运行时真相源**，导出供
 * 组合根 facts seam 投影 `lane.global.*` 的 effective（model-only 配置 runtime
 * 不消费 → effective=null；未知 provider 名 → throw 由调用方如实标 fail-visible）。
 */
export function readGlobalProviderSwitch(): { provider: Provider; model?: string } | undefined {
  return resolveGlobalProviderSwitch(process.env, getLaneOverride('global'));
}

/** Shared with transactional config validation; env provider selects the whole env pair. */
export function resolveGlobalProviderSwitch(
  envValues: NodeJS.ProcessEnv,
  db: { provider?: string; model?: string } | undefined,
): { provider: Provider; model?: string } | undefined {
  const env = readEnvOverride(envValues);
  if (env) return env;
  if (!db?.provider) return undefined;
  const provider = readProviderId(db.provider);
  if (!provider) {
    throw new Error(
      `lane.global.provider='${db.provider}' (DB config) is not a known provider; expected one of ${Object.keys(PROVIDERS).join(' | ')}`,
    );
  }
  return { provider, model: db.model };
}

/**
 * YUK-576 — predicate form of the env switch for the runner's transient-retry
 * gate: when the operator pins the WHOLE process to one provider
 * (AI_PROVIDER_OVERRIDE env 或 lane.global.* DB 行), in-process retry stays off
 * (pinned routing is an explicit operator decision; see runner.ts
 * transientRetryEnabled). Delegates to `readGlobalProviderSwitch()` so the
 * truthiness/validation logic is never written twice — an invalid override
 * value throws the same clear config error here as it would at resolution time.
 */
export function hasGlobalProviderOverride(): boolean {
  return readGlobalProviderSwitch() !== undefined;
}

/**
 * Model id this task will actually execute. Same layering as
 * resolveTaskProvider, without reading credentials — the serving gate compares
 * an admitted slice to this id, so a task.<kind>.model override cannot grade
 * under a slice that was admitted for a different model.
 */
export function resolveConfiguredTaskModel(kind: TaskKind): string {
  return resolveTaskBinding(kind).model;
}

/**
 * Provider + model a task will execute. Credential checks stay in
 * resolveTaskProvider so a missing key does not take down the serving gate.
 * YUK-1559 — exported so scripts/evals can assert against the resolved task
 * route instead of pinning a model literal.
 */
export function resolveTaskBinding(
  kind: TaskKind,
  override?: { provider?: Provider; model?: string },
): {
  provider: Provider;
  model: string;
  reasoning?: TaskNativeReasoningParams;
  selectionRule: TaskSelectionRule;
} {
  const def = tasks[kind];
  const dbTaskOverride = getTaskOverride(kind);
  const typed = 'execution' in def && def.execution === 'typed';
  // YUK-1547 — per-task explicit opt-in (task.<kind>.override_global_pin=true):
  // a COMPLETE+legal task.<kind> pair beats the global pin (env AI_PROVIDER_*
  // AND DB lane.global.*) for this task only. The explicit per-call override
  // arg still outranks the pair (solver2 env / modelBinding stay usable), and
  // an opted task with an incomplete or unservable pair is a config error —
  // never a silent paid fallback to the pinned/default model. Tasks without
  // the flag keep the old layering byte-for-byte.
  const taskPairBeatsGlobalPin = dbTaskOverride?.overrideGlobalPin === true && !typed;
  if (dbTaskOverride?.overrideGlobalPin === true && typed) {
    throw new Error(
      `task.${kind}.override_global_pin=true is meaningless on a typed-execution task — there is no chat lane to repoint. Clear the flag.`,
    );
  }
  if (taskPairBeatsGlobalPin) assertOptedTaskPair(kind, dbTaskOverride);
  // Product-wide incident pin must also cover explicit caller/modelBinding routes.
  // Typed primitives have a separate wire contract, not a chat model API.
  const envPin = typed || taskPairBeatsGlobalPin ? undefined : readEnvOverride(process.env);
  if (envPin) override = envPin;
  const globalSwitch = taskPairBeatsGlobalPin ? undefined : readGlobalProviderSwitch();

  // Chat env pin > explicit arg > DB global > DB per-task > registry —
  // with the opt-in: explicit arg > task pair > registry (global pin skipped).
  // The arg may set only `model`, so fall back through each layer per-field.
  const dbTaskProvider = dbTaskOverride?.provider
    ? readProviderId(dbTaskOverride.provider)
    : undefined;
  if (
    !override?.provider &&
    !globalSwitch?.provider &&
    dbTaskOverride?.provider &&
    !dbTaskProvider
  ) {
    const configured = dbTaskOverride.provider;
    // A deleted custom provider is the common way to land here: say what
    // actually happened instead of pointing at the legacy zhipu id.
    throw new Error(
      looksLikeCustomProviderId(configured)
        ? `task.${kind}.provider='${configured}' no longer exists (the custom provider definition was deleted). Recreate the provider or clear task.${kind}.provider; this never falls back to another lane.`
        : `task.${kind}.provider='${configured}' is not a native provider; migrate legacy 'zhipu' to 'zhipuai-coding-plan' and choose a model from its pi catalog.`,
    );
  }
  const providerName: Provider =
    override?.provider ?? globalSwitch?.provider ?? dbTaskProvider ?? def.defaultProvider;
  const selectionRule: TaskSelectionRule = envPin
    ? 'env_pin'
    : taskPairBeatsGlobalPin && !override?.provider
      ? 'task_pair_priority'
      : override?.provider
        ? 'call_override'
        : globalSwitch?.provider
          ? 'global_pin'
          : dbTaskProvider
            ? 'task_config'
            : 'registry_default';

  // Codex review P2 (Finding 4) — the global-switch model guard, now covering
  // BOTH the env pin and DB lane.global pin (identical semantics: the switch is
  // global, so a provider whose endpoint won't accept the registry's mimo
  // default would silently break EVERY task). A per-call `override.model`, the
  // switch's own model, or the DB task-level model satisfies the guard.
  //   - `anthropic-sub` is exempt: it has a built-in Opus 4.8 default (below).
  //   - `xiaomi` is exempt: it IS the mimo endpoint, so the registry default fits.
  // The exempt set lives in `providerRequiresExplicitModel` (single source of
  // truth, also read by override pre-flights + config write validation) so it
  // can't drift from a second hard-coded copy.
  const cameFromGlobalSwitch =
    envPin !== undefined || (!override?.provider && globalSwitch?.provider !== undefined);
  if (
    cameFromGlobalSwitch &&
    providerRequiresExplicitModel(providerName) &&
    !override?.model &&
    !globalSwitch?.model &&
    !dbTaskOverride?.model
  ) {
    const source = process.env.AI_PROVIDER_OVERRIDE
      ? 'AI_PROVIDER_OVERRIDE'
      : 'DB lane.global.provider';
    throw new Error(
      `${source}='${providerName}' selects a non-mimo provider, but no model is set; the task registry default model ('${def.defaultModel}') is a mimo id that '${providerName}' won't accept. Set AI_PROVIDER_MODEL or DB lane.global.model to a model the '${providerName}' endpoint serves, or use 'anthropic-sub' (defaults to ${ANTHROPIC_SUB_DEFAULT_MODEL}).`,
    );
  }

  // When the subscription lane is selected and no model is named anywhere, use
  // its Opus 4.8 default. Otherwise the layered model wins (chat env pin > arg > DB global > db task > registry).
  const subDefaultModel =
    providerName === 'anthropic-sub' ? ANTHROPIC_SUB_DEFAULT_MODEL : def.defaultModel;
  const modelId =
    override?.model ?? globalSwitch?.model ?? dbTaskOverride?.model ?? subDefaultModel;
  return {
    provider: providerName,
    model: modelId,
    reasoning: dbTaskOverride?.reasoning,
    selectionRule,
  };
}

/**
 * YUK-1547 — an opted-in task pair must be complete AND servable for this
 * task, checked at binding resolution (config error before any attempt/paid
 * call). Servable = provider implemented for the kind + model passes the
 * executable-facts gate; capability-fit still gates at run start.
 */
function assertOptedTaskPair(
  kind: TaskKind,
  dbTaskOverride: { provider?: string; model?: string } | undefined,
): void {
  function fail(reason: string): never {
    throw new Error(
      `task.${kind}.override_global_pin=true requires a complete+legal task.<kind> pair — ${reason}. Fix the pair or clear the flag; this opt-in never falls through to the global pin or the registry default.`,
    );
  }
  const rawProvider = dbTaskOverride?.provider;
  const model = dbTaskOverride?.model;
  const provider =
    typeof rawProvider === 'string' && rawProvider !== '' ? readProviderId(rawProvider) : undefined;
  if (!provider) {
    fail(`task.${kind}.provider='${rawProvider ?? '∅'}' is missing or not a known provider`);
  }
  if (typeof model !== 'string' || model === '') {
    fail(`task.${kind}.model is missing`);
  }
  if (!isProviderImplementedForTask(provider, kind)) {
    fail(`provider '${rawProvider}' is not implemented for task '${kind}'`);
  }
  if (!executablePiModel(provider, model)) {
    fail(`model '${model}' is not executable in native pi provider '${piProviderId(provider)}'`);
  }
}

/**
 * YUK-1547 — fail-closed validation + compat derivation for per-task native
 * reasoning params, resolved alongside the provider binding so a bad value is
 * a config error before any admission row, attempt row, or paid call (same
 * posture as the credential checks below). `reasoning_effort` is only honest
 * on an OpenAI-completions reasoning model, and only when the model's OWN
 * runtime directory names the value — the model declares its native levels
 * (e.g. low|high|max for deepseek-v4.1-flash), loom never invents or maps a
 * tier. Returns the FULL wire param set: for thinkingFormat='deepseek' the
 * model's own compat requires `thinking:{type:'enabled'}` beside the effort
 * (the same two fields pi emits from options.reasoningEffort); other formats
 * add nothing — DeepSeek fields are never imposed on all OpenAI models.
 */
function resolveTaskNativeReasoningParams(
  kind: TaskKind,
  provider: Provider,
  model: string,
  params: TaskNativeReasoningParams | undefined,
): TaskNativeReasoningParams | undefined {
  const effort = params?.reasoning_effort;
  if (effort === undefined) return undefined;
  const native = executablePiModel(provider, model);
  if (native?.api !== 'openai-completions' || native.reasoning !== true) {
    throw new Error(
      `task.${kind}.reasoning sets reasoning_effort='${effort}', but '${provider}/${model}' is not an executable OpenAI-completions reasoning model — the param would be dropped or rejected on the wire. Remove the task override or point the task at a lane whose own reasoning parameter is reasoning_effort.`,
    );
  }
  const supported = resolveModelProfile(provider, model).reasoning.supportedEfforts;
  if (!supported.includes(effort)) {
    throw new Error(
      `task.${kind}.reasoning reasoning_effort='${effort}' is not a value '${provider}/${model}' accepts. The runtime catalog declares [${supported.join(', ')}]. Pass one of those values verbatim.`,
    );
  }
  return native.thinkingFormat === 'deepseek'
    ? { reasoning_effort: effort, thinking: { type: 'enabled' } }
    : { reasoning_effort: effort };
}

/**
 * Resolve a task to its concrete provider binding.
 *
 * Lookup order（YUK-1007 DB override 层落地后）：
 *   1. Chat process env pin, then explicit `override.provider` / `override.model`
 *   2. 全局 switch：`AI_PROVIDER_OVERRIDE`/`AI_PROVIDER_MODEL` env → DB
 *      `lane.global.*`（owner 裁决：env pin 恒压 DB——它是 incident kill-switch）
 *   3. DB `task.<kind>.provider` / `.model` per-task override（面板写点）
 *   4. Task registry's `defaultProvider` + `defaultModel`
 *
 * Throws if the resolved provider's required env var isn't set.
 */
export function resolveTaskProvider(
  kind: TaskKind,
  override?: { provider?: Provider; model?: string },
): ResolvedProvider {
  const binding = resolveTaskBinding(kind, override);
  const { provider: providerName, model: modelId } = binding;

  // YUK-1563 part 4 — a custom provider resolves its credential from the
  // definition's env var NAME (never stored) and its endpoint from the same
  // definition via the runtime catalog bucket. No probe, no fallback.
  if (looksLikeCustomProviderId(providerName)) {
    const definition = customProviderDefinition(providerName);
    if (!definition) {
      throw new Error(
        `Unknown provider '${providerName}' for task ${kind}: the custom provider definition no longer exists. Remove the task override or recreate the provider.`,
      );
    }
    const wireReasoning = resolveTaskNativeReasoningParams(
      kind,
      providerName,
      modelId,
      binding.reasoning,
    );
    const apiKey = process.env[definition.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `${definition.apiKeyEnv} is required to run task ${kind} (provider=${providerName} — ${definition.displayName}). Place the key in .env.local / container env; it is never stored in the database.`,
      );
    }
    return {
      authMode: 'key',
      provider: providerName,
      model: modelId,
      apiKey,
      baseUrl: resolveModelProfile(providerName, modelId).baseUrl ?? definition.baseUrl,
      ...(wireReasoning !== undefined ? { nativeReasoningParams: wireReasoning } : {}),
      selectionRule: binding.selectionRule,
    };
  }

  const config = PROVIDERS[providerName as KnownProvider];
  if (!config) {
    throw new Error(
      `Unknown provider '${providerName}' for task ${kind}; expected one of ${Object.keys(PROVIDERS).join(' | ')}`,
    );
  }
  const wireReasoning = resolveTaskNativeReasoningParams(
    kind,
    providerName,
    modelId,
    binding.reasoning,
  );
  const nativeReasoning =
    wireReasoning !== undefined ? { nativeReasoningParams: wireReasoning } : {};
  const selectionRule = binding.selectionRule;

  if (config.authMode === 'oauth') {
    // YUK-365 subscription lane. Fail clearly if the token env is missing so an
    // accidental flip doesn't silently fall back to (now-unset) key auth.
    const token = process.env[config.oauthTokenEnv];
    if (!token) {
      throw new Error(
        `${config.oauthTokenEnv} is required to run task ${kind} via the subscription-OAuth lane (provider=${providerName}${config.description ? ` — ${config.description}` : ''}). Generate one with \`claude setup-token\` and place it in .env.local / container env.`,
      );
    }
    return {
      authMode: 'oauth',
      provider: providerName,
      model: modelId,
      apiKey: token,
      oauthTokenEnv: config.oauthTokenEnv,
      selectionRule,
      ...nativeReasoning,
    };
  }

  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `${config.apiKeyEnv} is required to run task ${kind} (provider=${providerName}${config.description ? ` — ${config.description}` : ''})`,
    );
  }

  // Chat lanes select native pi presets; typed OpenRouter retains its own executor.
  if (!isProviderImplementedForTask(providerName, kind)) {
    // Derive the wired list from the same predicate that gates this throw —
    // a hand-maintained copy drifts on every new lane (opencode-go, then
    // openai; flagged by review on YUK-1027).
    const wired = (Object.keys(PROVIDERS) as Provider[]).filter((p) =>
      isProviderImplementedForTask(p, kind),
    );
    throw new Error(
      `Provider '${providerName}' is reserved but not implemented; wired lanes: ${wired.join(', ')}.`,
    );
  }

  return {
    authMode: 'key',
    provider: providerName,
    model: modelId,
    apiKey,
    baseUrl: resolveModelProfile(providerName, modelId).baseUrl,
    selectionRule,
    ...nativeReasoning,
  };
}
