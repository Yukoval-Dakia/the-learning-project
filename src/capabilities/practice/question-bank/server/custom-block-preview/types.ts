import type { CustomBlockT } from '@/core/schema/assessment/presentation';

/** Supplied by the admission consumer's approved policy, never by generated code. */
export interface PreviewLimits {
  total_ms: number;
  ready_ms: number;
  focus_observation_ms: number;
  memory_bytes: number;
}

export const PREVIEW_POLICY = 'custom-block-preview-v1' as const;

export type PreviewFailure =
  | 'asset_unavailable'
  | 'asset_invalid'
  | 'isolation_unavailable'
  | 'sandbox_unconfirmed'
  | 'timeout'
  | 'memory_limit'
  | 'load_throw'
  | 'invalid_envelope'
  | 'missing_bind'
  | 'navigation'
  | 'focus_grab_after_use'
  | 'focus_abuse'
  | 'browser_failed'
  | 'cleanup_failed';

export interface BlockPreviewEvidence {
  block_id: string;
  asset: CustomBlockT['sandbox']['asset'];
  entry: string;
  binds: CustomBlockT['binds'];
  status: 'passed' | 'rejected' | 'unavailable';
  reason?: PreviewFailure;
  /** Bounded diagnostic code only; never source, answer text, URLs or environment. */
  diagnostic?: string;
  observed_slots: string[];
  elapsed_ms: number;
  sandbox_confirmed: boolean;
  memory_enforcement: 'cgroup-v2' | 'unavailable';
  network_enforcement: 'linux-network-namespace' | 'unavailable';
  /** Null until actual cgroup membership and kernel sandbox/network checks succeed. */
  enforced_limits: { memory_bytes: number; total_ms: number } | null;
  focus_out_observed_ms: number;
  ready_received: boolean;
  termination: { method: 'cgroup.kill'; requested: boolean; empty_confirmed: boolean } | null;
}

export class PreviewError extends Error {
  constructor(
    readonly reason: PreviewFailure,
    readonly diagnostic?: string,
  ) {
    super(reason);
    this.name = 'PreviewError';
  }
}

export function validateLimits(limits: PreviewLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('Custom preview limits must be positive safe integers');
    }
  }
  if (limits.ready_ms + limits.focus_observation_ms >= limits.total_ms) {
    throw new Error('Custom preview deadline must include startup and observation');
  }
}
