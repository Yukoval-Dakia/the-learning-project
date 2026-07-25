// Provider Manager — single source of truth for which upstream serves each
// AI task. The registry (src/ai/registry.ts) declares `defaultProvider +
// defaultModel` per task; `resolveTaskProvider()` looks up the provider here
// and returns a ResolvedProvider for the Claude Agent SDK runner to forward
// into the spawned `claude` subprocess.
//
// Two auth modes (YUK-365):
//   - authMode 'key'   — a bearer / x-api-key value (ANTHROPIC_API_KEY style),
//     optionally with a baseUrl override (xiaomi/mimo). The runner forwards it
//     as ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY. This is the default + the only
//     pre-YUK-365 behaviour, preserved exactly.
//   - authMode 'oauth' — a long-lived subscription OAuth token (the owner's
//     Claude Max sub, generated via `claude setup-token`). It works ONLY against
//     Anthropic's first-party endpoint and is MUTUALLY EXCLUSIVE with any
//     ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (precedence:
//     ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN). The runner therefore SETS
//     CLAUDE_CODE_OAUTH_TOKEN and explicitly UNSETS the three conflicting vars in
//     the subprocess env block (see runner.ts buildAgentEnv).
//
// Pre-2026-05-17 this module returned a Vercel AI SDK `LanguageModel`
// instance; the migration to @anthropic-ai/claude-agent-sdk replaces that
// with a plain config record because the SDK accepts no model handle —
// it reads its target from env vars when spawning the CLI.
//
// Adding a new key-auth provider: append an entry to PROVIDERS with
// authMode:'key', set the env-var name + baseURL. Adding a new task: edit
// registry.ts only.

import { type Provider, type TaskKind, tasks } from '@/ai/registry';

// YUK-608 — re-export the provider union so override consumers (solve-lane, verify-framework)
// type `override.provider` as `Provider` (matching the runner's RunTaskCallCtx) without each
// reaching back into the registry.
export type { Provider };

/** A key-auth provider: bearer/x-api-key value read from `apiKeyEnv`, optional baseUrl. */
interface KeyProviderConfig {
  authMode: 'key';
  /** Override ANTHROPIC_BASE_URL. Anthropic direct doesn't need one. */
  baseUrl?: string;
  /** Env var holding the bearer / x-api-key value. */
  apiKeyEnv: string;
  /** Optional human-readable note shown in errors when the env is missing. */
  description?: string;
}

/**
 * An OAuth-auth provider (YUK-365): a long-lived subscription token read from
 * `oauthTokenEnv`, run against Anthropic's first-party endpoint (NO baseUrl).
 */
interface OauthProviderConfig {
  authMode: 'oauth';
  /** Env var holding the subscription OAuth token. */
  oauthTokenEnv: string;
  description?: string;
}

type ProviderConfig = KeyProviderConfig | OauthProviderConfig;

const PROVIDERS: Record<Provider, ProviderConfig> = {
  anthropic: {
    authMode: 'key',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    description: 'Anthropic direct (pay-as-you-go API)',
  },
  xiaomi: {
    authMode: 'key',
    // No `/v1` suffix — both @anthropic-ai/sdk and the agent SDK append the
    // `/v1/messages` path themselves. Doubling up gives a 404.
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    apiKeyEnv: 'XIAOMI_API_KEY',
    description: 'Xiaomi Mimo Anthropic-protocol-compat endpoint (mimo-v2.5* models)',
  },
  // Zhipu BigModel GLM coding plan. Anthropic-protocol-compat endpoint (the same
  // one Claude Code points at for GLM). No `/v1` suffix — the SDK appends
  // `/v1/messages`. Key forwarded as ANTHROPIC_API_KEY (x-api-key); GLM accepts
  // it. glm-5.2 is coding-plan only (standard /api/paas/v4 → 403); it is served
  // on this /api/anthropic endpoint. ZHIPU_API_KEY already in env (GLM-OCR).
  zhipu: {
    authMode: 'key',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiKeyEnv: 'ZHIPU_API_KEY',
    description: 'Zhipu BigModel GLM coding plan Anthropic-compat endpoint (glm-5.2 etc.)',
  },
  openrouter: {
    authMode: 'key',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    description: 'OpenRouter unified multi-provider gateway (not currently in use)',
  },
  gateway: {
    authMode: 'key',
    baseUrl: 'https://ai-gateway.vercel.sh',
    apiKeyEnv: 'VERCEL_AI_GATEWAY_TOKEN',
    description: 'Vercel AI Gateway (not currently in use)',
  },
  openai: {
    authMode: 'key',
    apiKeyEnv: 'OPENAI_API_KEY',
    description: 'OpenAI direct (placeholder; not wired)',
  },
  // YUK-365 — subscription-OAuth lane. Opus 4.8 via the owner's Claude Max
  // subscription. No baseUrl (first-party endpoint only); no apiKeyEnv (it reads
  // the OAuth token, not a key). Opt-in ONLY via AI_PROVIDER_OVERRIDE.
  'anthropic-sub': {
    authMode: 'oauth',
    oauthTokenEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
    description: 'Anthropic first-party via Claude Max subscription OAuth (Opus 4.8)',
  },
};

/**
 * The model id used when the subscription-OAuth lane is selected and no explicit
 * model override is given. Claude Max defaults to Opus 4.8.
 */
export const ANTHROPIC_SUB_DEFAULT_MODEL = 'claude-opus-4-8';

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
 * before routing, without re-declaring the provider name set.
 */
export function isKnownProvider(name: string): name is Provider {
  return Object.hasOwn(PROVIDERS, name);
}

/**
 * YUK-608 — is this provider's credential lane configured in THIS process's env? An
 * OAuth provider needs its `oauthTokenEnv`; a key provider needs its `apiKeyEnv`.
 * Lets a caller PRE-FLIGHT an optional override lane and fail-open to the default
 * provider when the lane isn't wired here (e.g. the subscription token is absent on
 * a given deploy), instead of letting `resolveTaskProvider` throw mid-call. Mirrors
 * the missing-env checks `resolveTaskProvider` performs, without allocating a binding.
 */
export function isProviderLaneReady(provider: Provider): boolean {
  const config = PROVIDERS[provider];
  if (!config) return false;
  const envName = config.authMode === 'oauth' ? config.oauthTokenEnv : config.apiKeyEnv;
  return Boolean(process.env[envName]);
}

// YUK-608 — the KEY-auth providers actually wired to a working endpoint. openrouter / gateway /
// openai are reserved-but-not-implemented (their wire shapes differ) and `resolveTaskProvider`
// throws for them below. 'anthropic-sub' is the OAuth lane (handled before the key branch), so it
// is NOT in this key-auth set; `isProviderImplemented` folds it back in via `isOauthProvider`.
const IMPLEMENTED_KEY_PROVIDERS: ReadonlySet<Provider> = new Set(['anthropic', 'xiaomi', 'zhipu']);

/**
 * YUK-608 — is `provider` actually wired to a working endpoint (vs reserved-but-not-implemented)?
 * True for the wired key-auth providers plus every OAuth-lane provider (anthropic-sub). SINGLE
 * source of truth: `resolveTaskProvider`'s "reserved but not implemented" guard AND override
 * pre-flights (solve-lane) both read it, so a caller can fail-open to the default lane BEFORE
 * dispatch instead of resolving to a provider that throws mid-call — and the wired set can never
 * drift into two hard-coded copies.
 */
export function isProviderImplemented(provider: Provider): boolean {
  return IMPLEMENTED_KEY_PROVIDERS.has(provider) || isOauthProvider(provider);
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
 * (`override?.model ?? envOverride?.model ?? subDefaultModel`). So a caller that hands it only
 * `override.provider` — which is exactly what the durable judge's fallback lane does — still
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
  return provider === 'anthropic-sub' ? ANTHROPIC_SUB_DEFAULT_MODEL : tasks[kind].defaultModel;
}

/**
 * Resolved provider binding handed to the runner. Discriminated on `authMode`:
 *   - 'key'   → { apiKey, baseUrl? } forwarded as ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL.
 *   - 'oauth' → { oauthTokenEnv } whose value the runner SETS as CLAUDE_CODE_OAUTH_TOKEN
 *               while UNSETTING ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN.
 */
export type ResolvedProvider =
  | {
      authMode: 'key';
      provider: Provider;
      model: string;
      apiKey: string;
      /** undefined for Anthropic direct (uses SDK default). */
      baseUrl?: string;
    }
  | {
      authMode: 'oauth';
      provider: Provider;
      model: string;
      /** Env-var NAME the runner reads to populate CLAUDE_CODE_OAUTH_TOKEN. */
      oauthTokenEnv: string;
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
 * Per-task override is still available via the explicit `override` arg
 * (test/dev escape hatch), which takes precedence over the env switch.
 *
 * Returns undefined when unset → callers fall through to the registry default
 * (current mimo behaviour, byte-for-byte).
 */
function readEnvOverride(): { provider: Provider; model?: string } | undefined {
  const raw = process.env.AI_PROVIDER_OVERRIDE;
  if (!raw) return undefined;
  const provider = raw as Provider;
  if (!(provider in PROVIDERS)) {
    throw new Error(
      `AI_PROVIDER_OVERRIDE='${raw}' is not a known provider; expected one of ${Object.keys(PROVIDERS).join(' | ')}`,
    );
  }
  const model = process.env.AI_PROVIDER_MODEL || undefined;
  return { provider, model };
}

/**
 * YUK-576 — predicate form of the env switch for the runner's transient-retry
 * gate: when the operator pins the WHOLE process to one provider
 * (AI_PROVIDER_OVERRIDE), in-process retry stays off (pinned routing is an
 * explicit operator decision; see runner.ts transientRetryEnabled). Delegates
 * to `readEnvOverride()` so the truthiness/validation logic is never written
 * twice — an invalid override value throws the same clear config error here as
 * it would at resolution time.
 */
export function hasGlobalProviderOverride(): boolean {
  return readEnvOverride() !== undefined;
}

/**
 * Resolve a task to its concrete provider binding.
 *
 * Lookup order:
 *   1. `override.provider` / `override.model` if supplied (test/dev escape hatch)
 *   2. `AI_PROVIDER_OVERRIDE` / `AI_PROVIDER_MODEL` env switch (YUK-365 global override)
 *   3. Task registry's `defaultProvider` + `defaultModel`
 *
 * Throws if the resolved provider's required env var isn't set.
 */
export function resolveTaskProvider(
  kind: TaskKind,
  override?: { provider?: Provider; model?: string },
): ResolvedProvider {
  const def = tasks[kind];
  const envOverride = readEnvOverride();

  // Explicit arg > env switch > registry default. The arg may set only `model`,
  // so fall back through each layer per-field.
  const providerName: Provider = override?.provider ?? envOverride?.provider ?? def.defaultProvider;

  // Codex review P2 (Finding 4): when AI_PROVIDER_OVERRIDE switches the GLOBAL
  // provider to one whose endpoint won't accept the registry's mimo default model
  // (e.g. `anthropic` direct, or any future wired non-mimo provider) and no
  // AI_PROVIDER_MODEL is named, the layered model fallback below would carry the
  // task's registry `mimo-v2.5*` id onto a non-mimo endpoint → a first-party
  // request that 404s on an unknown model. The env switch is global, so this would
  // silently break EVERY task. Fail fast with a clear config error instead.
  //   - `anthropic-sub` is exempt: it has a built-in Opus 4.8 default (below).
  //   - `xiaomi` is exempt: it IS the mimo endpoint, so the registry default fits.
  //   - A per-call `override.model` (or AI_PROVIDER_MODEL) satisfies the guard.
  // The exempt set lives in `providerRequiresExplicitModel` (single source of truth, also read by
  // override pre-flights) so it can't drift from a second hard-coded copy.
  const cameFromEnvSwitch = !override?.provider && envOverride?.provider !== undefined;
  if (
    cameFromEnvSwitch &&
    providerRequiresExplicitModel(providerName) &&
    !override?.model &&
    !envOverride?.model
  ) {
    throw new Error(
      `AI_PROVIDER_OVERRIDE='${providerName}' selects a non-mimo provider, but no AI_PROVIDER_MODEL is set; the task registry default model ('${def.defaultModel}') is a mimo id that '${providerName}' won't accept. Set AI_PROVIDER_MODEL to a model the '${providerName}' endpoint serves, or use 'anthropic-sub' (defaults to ${ANTHROPIC_SUB_DEFAULT_MODEL}).`,
    );
  }

  // When the subscription lane is selected and no model is named anywhere, use
  // its Opus 4.8 default. Otherwise the layered model wins (arg > env > registry).
  const subDefaultModel =
    providerName === 'anthropic-sub' ? ANTHROPIC_SUB_DEFAULT_MODEL : def.defaultModel;
  const modelId = override?.model ?? envOverride?.model ?? subDefaultModel;

  const config = PROVIDERS[providerName];
  if (!config) {
    throw new Error(
      `Unknown provider '${providerName}' for task ${kind}; expected one of ${Object.keys(PROVIDERS).join(' | ')}`,
    );
  }

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
      oauthTokenEnv: config.oauthTokenEnv,
    };
  }

  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `${config.apiKeyEnv} is required to run task ${kind} (provider=${providerName}${config.description ? ` — ${config.description}` : ''})`,
    );
  }

  // anthropic + xiaomi + zhipu are wired for key-auth; all speak the Anthropic
  // Messages protocol and so are transparently routable via ANTHROPIC_BASE_URL
  // (zhipu = GLM coding plan on /api/anthropic, smoke-tested HTTP 200). openrouter
  // / gateway / openai land here as "not implemented" because their wire shapes
  // differ; revisit if a real trigger fires. ('anthropic-sub' is the oauth branch
  // above, so it never reaches here.) The wired set lives in `isProviderImplemented`
  // (single source of truth, also read by override pre-flights).
  if (!isProviderImplemented(providerName)) {
    throw new Error(
      `Provider '${providerName}' is reserved but not implemented; only 'anthropic', 'xiaomi', 'zhipu', and 'anthropic-sub' (subscription OAuth) are wired.`,
    );
  }

  return {
    authMode: 'key',
    provider: providerName,
    model: modelId,
    apiKey,
    baseUrl: config.baseUrl,
  };
}
