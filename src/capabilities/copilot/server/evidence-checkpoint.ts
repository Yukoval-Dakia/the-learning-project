import { sha256CanonicalJson } from '@/kernel/canonical-json';
import type {
  ComparisonEvidenceSubmission,
  CopilotEvidenceComparisonResumeState,
  CopilotEvidenceLedgerRecord,
  CopilotEvidenceReferenceResumeState,
  ReferenceEvidenceSubmission,
} from './evidence-submission';

export const COPILOT_EVIDENCE_CHECKPOINT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type CopilotEvidenceCheckpointTaskKind =
  | 'CopilotEvidenceReviewTask'
  | 'CopilotEvidenceVerificationTask';

export interface CopilotEvidenceCheckpointBinding {
  readonly task_kind: CopilotEvidenceCheckpointTaskKind;
  readonly slot: string;
  readonly protocol_version: number;
  readonly prompt_fingerprint: string;
  readonly base_input_sha256: string;
  readonly source_catalog_sha256: string;
  readonly binding_extras: Readonly<Record<string, string>>;
}

export type CopilotEvidenceCheckpointAttemptAudit =
  | {
      readonly outcome: 'running';
      readonly task_run_id: string;
      readonly task_input_sha256: string;
      readonly started_at: string;
    }
  | {
      readonly outcome: 'failed_retryable' | 'failed_permanent' | 'success';
      readonly failure_kind?: string;
      readonly task_run_id: string;
      readonly task_input_sha256: string;
      readonly finished_at: string;
    };

export interface CopilotEvidenceCheckpointSeal {
  readonly output_json: unknown;
  readonly digest_sha256: string;
  readonly task_run_id: string;
}

export interface CopilotEvidenceCheckpoint {
  readonly id: string;
  readonly binding: CopilotEvidenceCheckpointBinding;
  readonly status: 'open' | 'sealed' | 'expired';
  readonly revision: number;
  readonly records: readonly CopilotEvidenceLedgerRecord[];
  readonly attempts: readonly CopilotEvidenceCheckpointAttemptAudit[];
  readonly sealed?: CopilotEvidenceCheckpointSeal;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string;
}

export interface CopilotEvidenceCheckpointStore {
  load(binding: CopilotEvidenceCheckpointBinding): Promise<CopilotEvidenceCheckpoint | undefined>;
  appendRecords(
    binding: CopilotEvidenceCheckpointBinding,
    records: readonly CopilotEvidenceLedgerRecord[],
  ): void | Promise<void>;
  recordAttempt(
    binding: CopilotEvidenceCheckpointBinding,
    attempt: CopilotEvidenceCheckpointAttemptAudit,
  ): void | Promise<void>;
  markSealed(
    binding: CopilotEvidenceCheckpointBinding,
    sealed: CopilotEvidenceCheckpointSeal,
  ): Promise<{ readonly status: 'ok' | 'conflict' }>;
  verifySealedRun(
    binding: CopilotEvidenceCheckpointBinding,
    sealed: CopilotEvidenceCheckpointSeal,
  ): Promise<boolean>;
  cleanupExpired(now?: Date): Promise<number>;
}

export function copilotEvidenceCheckpointId(binding: CopilotEvidenceCheckpointBinding): string {
  return sha256CanonicalJson(binding);
}

export function bindingsEqual(
  left: CopilotEvidenceCheckpointBinding,
  right: CopilotEvidenceCheckpointBinding,
): boolean {
  return copilotEvidenceCheckpointId(left) === copilotEvidenceCheckpointId(right);
}

export async function loadCheckpointFailClosed(
  store: Pick<CopilotEvidenceCheckpointStore, 'load'>,
  binding: CopilotEvidenceCheckpointBinding,
): Promise<CopilotEvidenceCheckpoint | undefined> {
  try {
    const checkpoint = await store.load(binding);
    if (!checkpoint) return undefined;
    if (!bindingsEqual(checkpoint.binding, binding)) {
      console.warn('[copilot-evidence-checkpoint] binding mismatch', {
        checkpoint_id: copilotEvidenceCheckpointId(binding),
      });
      return undefined;
    }
    return checkpoint;
  } catch (error) {
    console.warn('[copilot-evidence-checkpoint] load failed closed', {
      checkpoint_id: copilotEvidenceCheckpointId(binding),
      error_name: error instanceof Error ? error.name : 'unknown',
    });
    return undefined;
  }
}

export function rehydrateCopilotEvidenceSubmission(
  submission: ReferenceEvidenceSubmission | ComparisonEvidenceSubmission,
  records: readonly CopilotEvidenceLedgerRecord[],
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  for (const record of records) {
    let result: ReturnType<ReferenceEvidenceSubmission['appendEvidencePoints']>;
    switch (record.kind) {
      case 'evidence_points':
        if (!('appendEvidencePoints' in submission))
          return { ok: false, reason: 'record_kind_mismatch' };
        result = submission.appendEvidencePoints({ points: record.points });
        break;
      case 'trace_calls_not_material':
        if (!('markTraceCallsNotMaterial' in submission)) {
          return { ok: false, reason: 'record_kind_mismatch' };
        }
        result = submission.markTraceCallsNotMaterial({ calls: record.calls });
        break;
      case 'safe_reply':
        if (!('setSafeReply' in submission)) return { ok: false, reason: 'record_kind_mismatch' };
        result = submission.setSafeReply({ safe_reply: record.safe_reply });
        break;
      case 'reply_checks':
        if (!('appendReplyChecks' in submission))
          return { ok: false, reason: 'record_kind_mismatch' };
        result = submission.appendReplyChecks({ checks: record.checks });
        break;
    }
    if (!result.ok) return { ok: false, reason: result.reason };
  }
  return { ok: true };
}

export function referenceResumeInputBlock(state: CopilotEvidenceReferenceResumeState) {
  return { protocol: 'append_ledger_recovery_v1' as const, accepted: state };
}

export function comparisonResumeInputBlock(state: CopilotEvidenceComparisonResumeState) {
  return { protocol: 'append_ledger_recovery_v1' as const, accepted: state };
}

export function createInMemoryCopilotEvidenceCheckpointStore(): CopilotEvidenceCheckpointStore & {
  tamperStoredBinding(
    binding: CopilotEvidenceCheckpointBinding,
    replacement: CopilotEvidenceCheckpointBinding,
  ): void;
} {
  const checkpoints = new Map<string, CopilotEvidenceCheckpoint>();
  const now = () => new Date();
  const open = (binding: CopilotEvidenceCheckpointBinding): CopilotEvidenceCheckpoint => {
    const id = copilotEvidenceCheckpointId(binding);
    const existing = checkpoints.get(id);
    if (existing) {
      if (existing.status === 'expired' || Date.parse(existing.expires_at) <= now().getTime()) {
        checkpoints.set(id, {
          ...existing,
          status: 'expired',
          records: [],
          attempts: [],
          sealed: undefined,
        });
        throw new Error('copilot evidence checkpoint expired');
      }
      return existing;
    }
    const created = now();
    const checkpoint: CopilotEvidenceCheckpoint = {
      id,
      binding,
      status: 'open',
      revision: 0,
      records: [],
      attempts: [],
      created_at: created.toISOString(),
      updated_at: created.toISOString(),
      expires_at: new Date(created.getTime() + COPILOT_EVIDENCE_CHECKPOINT_TTL_MS).toISOString(),
    };
    checkpoints.set(id, checkpoint);
    return checkpoint;
  };
  return {
    load: async (binding) => {
      const checkpoint = checkpoints.get(copilotEvidenceCheckpointId(binding));
      if (
        !checkpoint ||
        checkpoint.status === 'expired' ||
        Date.parse(checkpoint.expires_at) <= now().getTime()
      ) {
        return undefined;
      }
      return checkpoint;
    },
    appendRecords: (binding, records) => {
      const checkpoint = open(binding);
      if (checkpoint.status === 'sealed') return;
      const existing = new Set(checkpoint.records.map((record) => sha256CanonicalJson(record)));
      const accepted = records.filter((record) => !existing.has(sha256CanonicalJson(record)));
      if (accepted.length === 0) return;
      const updated = now();
      checkpoints.set(checkpoint.id, {
        ...checkpoint,
        revision: checkpoint.revision + accepted.length,
        records: [...checkpoint.records, ...accepted],
        updated_at: updated.toISOString(),
        expires_at: new Date(updated.getTime() + COPILOT_EVIDENCE_CHECKPOINT_TTL_MS).toISOString(),
      });
    },
    recordAttempt: (binding, attempt) => {
      const checkpoint = open(binding);
      const existingIndex = checkpoint.attempts.findIndex(
        (item) => item.task_run_id === attempt.task_run_id,
      );
      if (existingIndex >= 0) {
        const existingAttempt = checkpoint.attempts[existingIndex];
        if (existingAttempt?.outcome !== 'running' || attempt.outcome === 'running') return;
        const attempts = [...checkpoint.attempts];
        attempts[existingIndex] = attempt;
        checkpoints.set(checkpoint.id, { ...checkpoint, attempts });
        return;
      }
      checkpoints.set(checkpoint.id, {
        ...checkpoint,
        attempts: [...checkpoint.attempts, attempt],
      });
    },
    markSealed: async (binding, sealed) => {
      const checkpoint = open(binding);
      if (checkpoint.sealed) {
        return sha256CanonicalJson(checkpoint.sealed) === sha256CanonicalJson(sealed)
          ? { status: 'ok' }
          : { status: 'conflict' };
      }
      checkpoints.set(checkpoint.id, { ...checkpoint, status: 'sealed', sealed });
      return { status: 'ok' };
    },
    verifySealedRun: async (binding, sealed) => {
      const checkpoint = checkpoints.get(copilotEvidenceCheckpointId(binding));
      return checkpoint?.sealed
        ? sha256CanonicalJson(checkpoint.sealed) === sha256CanonicalJson(sealed)
        : false;
    },
    cleanupExpired: async (at = now()) => {
      let deleted = 0;
      for (const [id, checkpoint] of checkpoints) {
        if (Date.parse(checkpoint.expires_at) <= at.getTime()) {
          checkpoints.set(id, {
            ...checkpoint,
            status: 'expired',
            records: [],
            attempts: [],
            sealed: undefined,
          });
          deleted += 1;
        }
      }
      return deleted;
    },
    tamperStoredBinding: (binding, replacement) => {
      const id = copilotEvidenceCheckpointId(binding);
      const checkpoint = checkpoints.get(id);
      if (checkpoint) checkpoints.set(id, { ...checkpoint, binding: replacement });
    },
  };
}
