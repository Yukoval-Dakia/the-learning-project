// Runtime facts for the admin config read face, injected by the composition root.
// Direct imports here would add forbidden capability-to-server and cross-capability
// edges, so the server layer gathers the truth sources and injects a per-request
// factory, keeping hot reload fresh.
//
// Providers expose only key-presence booleans and env names, never values. Effective
// values come from real readers. Without an injected source the read face reports
// facts_injected=false rather than inventing data.
import type { ConfigEffectiveFacts } from '@/core/config/effective';

/**
 * One catalog model row: every model in the provider's catalog bucket, runnable
 * or not. Missing catalog facts stay 'unknown'/'null' — they are never inferred.
 */
export interface AdminConfigCatalogModelRow {
  readonly id: string;
  /** Wire protocol; null when neither the catalog nor a protocol template declares it. */
  readonly api: string | null;
  /** Input modalities; ['unknown'] when the catalog does not declare them. */
  readonly input: readonly string[];
  /** Whether the save-time registry accepts this model (required executable facts present). */
  readonly runnable: boolean;
  readonly tool_call: boolean | 'unknown';
  readonly reasoning: boolean | 'unknown';
  readonly structured_output: boolean | 'unknown';
  readonly vision: boolean | 'unknown';
  readonly forced_tool_choice: boolean | 'unknown';
  readonly context_window_tokens: number | null;
  readonly max_input_tokens: number | null;
  readonly max_output_tokens: number | null;
  /** Catalog rate card (USD per Mtok); null when the catalog has no card (unknown, not free). */
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cache_read: number;
    readonly cache_write?: number;
  } | null;
}

/**
 * Auth status projected from the probe/settlement facts (provider-models-check);
 * the only credential-derived facts beyond key_present, and never the value.
 */
export interface AdminConfigProviderAuth {
  readonly status: 'unconfigured' | 'configured' | 'auth_failed' | 'login_lane';
  /** HTTP status of the failed /models read or inference probe; null otherwise. */
  readonly http_status: number | null;
  /** Provider error type of the failure (e.g. invalid_api_key); null otherwise. */
  readonly error_type: string | null;
}

/**
 * The provider's ACTIVE credential lane: 'key' / 'oauth' mirror the registry
 * authMode; 'oauth-file' means the credential resolved to the provider's auth
 * file lane (e.g. openai ChatGPT-login) — the declared authMode stays 'key'
 * there, but reporting 'key' would mislabel the live lane (YUK-1833).
 * 'conflict' means the key and auth-file envs are both set — a state the
 * resolver refuses at run time, so no lane is active at all.
 */
export type AdminConfigProviderAuthMode = 'key' | 'oauth' | 'oauth-file' | 'conflict';

/** One provider row; the only credential facts are key_present and the auth status. */
export interface AdminConfigProviderRow {
  readonly name: string;
  readonly auth_mode: AdminConfigProviderAuthMode;
  /** Env name only; the value is never serialized. */
  readonly credential_env: string;
  readonly key_present: boolean;
  /** Chat availability only; typed-only providers can be wired while this is false. */
  readonly implemented: boolean;
  /** Actual execution paths; absent for an older/uninjected facts source. */
  readonly implemented_for?: { readonly chat: boolean; readonly typed: boolean };
  /** Actual native pi identity; null for providers using a non-pi execution path. */
  readonly pi_provider?: string | null;
  /** Full catalog listing (YUK-1563 AC1); absent for an older/uninjected facts source. */
  readonly models?: readonly AdminConfigCatalogModelRow[];
  /** Absent for an older/uninjected facts source. */
  readonly auth?: AdminConfigProviderAuth;
}

/** Static cron declaration; read-only and triggers no worker behavior. */
export interface AdminConfigScheduleRow {
  readonly name: string;
  readonly cron: string;
  readonly tz: string;
  readonly owner: string;
  readonly queue: string;
  readonly source:
    | 'capability-manifest'
    | 'server-boss-infra'
    | 'server-memory-infra'
    | 'server-event-subscriptions';
  readonly note?: string;
}

/** Runtime constants, all from a single declaration point. */
export interface AdminConfigRuntimeSection {
  readonly port: number | null;
  readonly db_pool_max: number;
  readonly queue_tiers: {
    readonly expire_seconds: {
      readonly fast: number;
      readonly llm: number;
      readonly agent: number;
    };
    readonly retention_seconds: number;
  };
  readonly orchestration: {
    readonly anchor_cron: string;
    readonly tz: string;
    readonly queue: string;
    readonly catchup_window_seconds: number;
    readonly tick_interval_seconds: number;
    readonly node_timeout_seconds: number;
    readonly layer_stagger_seconds: number;
    /** DAG members have no cron; the orchestrator triggers them. */
    readonly dag_members: readonly string[];
  };
}

/**
 * YUK-1808 — the layer that produced a task's effective binding, frozen by the
 * resolver (providers.ts TaskSelectionRule). `call_override` appears when a
 * scoped lane (vision_judge / verify_solve) serves the task — the same rule
 * the run record writes for those invocations.
 */
export type AdminConfigTaskSelectionRule =
  | 'env_pin'
  | 'task_pair_priority'
  | 'call_override'
  | 'global_pin'
  | 'task_config'
  | 'registry_default';

/**
 * The resolver's per-task reasoning outcome (resolveTaskReasoning), projected
 * for the read face: `requested` is the stored level name (null when nothing
 * is configured), `applied` is what the wire will carry ('off'/'on'/a level/
 * 'none'), `error` is the readable config error when the stored level cannot
 * be honored at all.
 */
export interface AdminConfigTaskEffectiveReasoning {
  readonly source?: 'task' | 'global' | 'catalog';
  readonly requested: string | null;
  readonly applied: string | null;
  readonly error: string | null;
}

/**
 * The binding's credential lane as this process sees it. `verified_in_process`
 * is false when the credential can't be checked from here — the env var or
 * auth-file mount may live only in the worker — so an unverifiable credential
 * stays a fact about the projection, never a task-level error (and its file
 * path is never serialized). 'conflict' mirrors the provider row's auth_mode:
 * key + auth-file envs both set is a hard run-time error, not a lane.
 */
export interface AdminConfigTaskCredential {
  readonly lane: 'key' | 'oauth' | 'oauth-file' | 'conflict';
  readonly verified_in_process: boolean;
}

/** One task's effective binding projection — shared by the read face and the write receipt. */
export interface AdminConfigTaskEffectiveBinding {
  readonly provider: string | null;
  readonly model: string | null;
  readonly error: string | null;
  readonly selection_rule: AdminConfigTaskSelectionRule | null;
  readonly reasoning: AdminConfigTaskEffectiveReasoning | null;
  /** Absent on typed tasks and when the binding itself failed to resolve. */
  readonly credential?: AdminConfigTaskCredential | null;
  /**
   * Scoped lanes (`lane.<name>.*`) that also serve this kind through real call
   * paths — reported only when the kind's effective_binding stays on the
   * standard chain because some callers run it without an override (the solve
   * legs: quiz_verify's solve_check threads verify_solve; reference-solution /
   * source_verify / intervention paths don't). Lane-only kinds report
   * `call_override` in selection_rule instead; absent when no lane is live.
   */
  readonly also_on_lanes?: ('vision_judge' | 'verify_solve')[];
}

/**
 * One AI task's catalog defaults plus its next-invocation budget baseline, read
 * from the task registry by the composition root (the read face must not import it).
 */
export interface AdminConfigTaskFacts {
  readonly kind: string;
  readonly description: string;
  readonly default_provider: string;
  readonly default_model: string;
  readonly default_budget: {
    readonly maxIterations: number;
    readonly maxCost: number;
    readonly transientRetries: number;
    readonly timeout: number;
  };
  /** Typed tasks bypass the chat provider chain, so overrides and the global pin do not apply. */
  readonly typed: boolean;
  readonly budget_wiring: {
    readonly maxIterations: boolean;
    readonly maxCost: boolean;
    readonly transientRetries: boolean;
    readonly timeout: boolean;
  };
  readonly effective_budget: {
    readonly maxIterations: number | 'unbounded' | null;
    readonly maxCost: number | null;
    readonly transientRetries: number;
    readonly timeout: number;
  };
}

/**
 * YUK-1808 — the effective global provider switch for the config page: which
 * provider/model the global pin resolves to, which layer produced it ('env'
 * emergency pin vs 'db' panel-managed default), and the reader's error when
 * the configured name is invalid.
 */
export interface AdminConfigGlobalEffective {
  readonly reasoning?: {
    readonly level: string | null;
    readonly source: 'db' | 'env' | 'code-default' | 'compose-forced';
  };
  readonly provider: string | null;
  readonly model: string | null;
  /** The provider field's producing layer ('env' emergency pin vs 'db' panel default). */
  readonly source: 'env' | 'db' | null;
  /**
   * The model field's own producing layer — the pair can be mixed-source:
   * an env AI_PROVIDER_MODEL rides next to a DB provider, while an env pin
   * suppresses the DB model entirely (model then null).
   */
  readonly model_source?: 'env' | 'db' | null;
  readonly error: string | null;
}

/** Full fact bundle; recomputed per request for hot reload. */
export interface AdminConfigRuntimeFacts {
  /** Runtime global switch, validated by its real reader. Null includes an invalid switch. */
  readonly global_pin?: { provider: string; model?: string } | null;
  /** Effective global switch + its producing layer; absent for an older/uninjected source. */
  readonly global?: AdminConfigGlobalEffective;
  readonly task_bindings?: Readonly<Record<string, AdminConfigTaskEffectiveBinding>>;
  /** Registry order; the read face lays its task rows out in this order. */
  readonly task_catalog: readonly AdminConfigTaskFacts[];
  readonly providers: readonly AdminConfigProviderRow[];
  /** Cron declarations from capability manifests (jobs.handlers[].schedule). */
  readonly manifest_schedules: readonly AdminConfigScheduleRow[];
  readonly infra_schedules: readonly AdminConfigScheduleRow[];
  readonly runtime: AdminConfigRuntimeSection;
  readonly effective_values: ConfigEffectiveFacts;
}

export type AdminConfigRuntimeFactsSource = () => AdminConfigRuntimeFacts;

let factsSource: AdminConfigRuntimeFactsSource | undefined;

/** Injected at boot; the last injection wins. */
export function setAdminConfigRuntimeFacts(source: AdminConfigRuntimeFactsSource): void {
  factsSource = source;
}

/** Route-side read; null means the face reports facts_injected=false. */
export function getAdminConfigRuntimeFacts(): AdminConfigRuntimeFacts | null {
  return factsSource?.() ?? null;
}

/** Test isolation. */
export function __resetAdminConfigRuntimeFactsForTests(): void {
  factsSource = undefined;
}
