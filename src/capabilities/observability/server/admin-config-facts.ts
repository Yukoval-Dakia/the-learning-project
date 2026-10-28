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
  readonly status: 'unconfigured' | 'configured' | 'auth_failed';
  /** HTTP status of the failed /models read or inference probe; null otherwise. */
  readonly http_status: number | null;
  /** Provider error type of the failure (e.g. invalid_api_key); null otherwise. */
  readonly error_type: string | null;
}

/** One provider row; the only credential facts are key_present and the auth status. */
export interface AdminConfigProviderRow {
  readonly name: string;
  readonly auth_mode: 'key' | 'oauth';
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

/** Full fact bundle; recomputed per request for hot reload. */
export interface AdminConfigRuntimeFacts {
  /** Runtime global switch, validated by its real reader. Null includes an invalid switch. */
  readonly global_pin?: { provider: string; model?: string } | null;
  readonly task_bindings?: Readonly<
    Record<
      string,
      {
        provider: string | null;
        model: string | null;
        error: string | null;
      }
    >
  >;
  readonly providers: readonly AdminConfigProviderRow[];
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
