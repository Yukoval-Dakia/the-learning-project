import { eq, inArray } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type { CustomBlockT } from '@/core/schema/assessment/presentation';
import type { Db } from '@/db/client';
import { source_asset } from '@/db/schema';
import type { AssessmentAssetLoader } from '@/kernel/records/assessment-assets';
import { customBlocksOf, isValidEntry, verifyCode } from '../../ui/blocks/custom-sandbox';
import type { AdmissionResultReceipt, FrozenAdmissionInput } from '../admission/receipt';
import {
  type AdmissionPublishBuild,
  type PublishContract,
  buildResolvedPublishContract,
} from '../admission/resolved-publication';
import { createAssessmentAssetLoader } from '../assets';
import { previewBlockInChromium } from './chromium-runner';
import {
  type BlockPreviewEvidence,
  PREVIEW_POLICY,
  type PreviewLimits,
  validateLimits,
} from './types';

type Publication = Extract<AdmissionPublishBuild, { kind: 'ok' }>;

function contractKey(contract: PublishContract) {
  // Hash the actual layers too, rather than trusting a caller's declared digest.
  return canonicalHash({
    structure: contract.structure,
    response_spec: contract.response_spec,
    scoring_basis: contract.scoring_basis,
    execution_plan: contract.execution_plan,
    presentation: contract.presentation ?? null,
    integrity_digest: contract.integrity_digest,
  });
}

function publicInterface(contract: PublishContract) {
  return canonicalHash({
    blocks: contract.presentation ? customBlocksOf(contract.presentation) : [],
    slots: contract.response_spec.slots,
  });
}

function frozenIdentity(input: FrozenAdmissionInput, receipt: AdmissionResultReceipt) {
  return {
    group_id: input.group_id,
    revision_id: input.revision_id,
    revision_digest: input.revision_digest,
    admission_generation: input.admission_generation,
    input_contract_digest: input.contract.integrity_digest,
    input_contract_key: contractKey(input.contract),
    receipt_digest: canonicalHash(receipt),
  };
}

interface PreviewEvidence {
  policy_id: typeof PREVIEW_POLICY;
  source: 'question_admission_run';
  frozen: ReturnType<typeof frozenIdentity>;
  final_contract_digest: string;
  final_contract_key: string;
  public_interface_digest: string;
  configured_limits: PreviewLimits;
  status: 'passed' | 'failed';
  blocks: BlockPreviewEvidence[];
}

export type PreparedCustomPreview =
  | { kind: 'no_custom' }
  | { kind: 'blocked'; reason: string }
  | {
      kind: 'previewed';
      evidence: PreviewEvidence;
      /** Exact verified buffers only. Unknown/rebound storage keys fail the unchanged barrier. */
      readAssetBytes: (storageKey: string) => Promise<Uint8Array | null>;
    };

function assetFailure(
  block: CustomBlockT,
  reason: 'asset_unavailable' | 'asset_invalid',
): BlockPreviewEvidence {
  return {
    block_id: block.block_id,
    asset: { ...block.sandbox.asset },
    entry: block.sandbox.entry,
    binds: block.binds.map((bind) => ({ ...bind })),
    status: 'rejected',
    reason,
    observed_slots: [],
    elapsed_ms: 0,
    sandbox_confirmed: false,
    memory_enforcement: 'unavailable',
    network_enforcement: 'unavailable',
    enforced_limits: null,
    focus_out_observed_ms: 0,
    ready_received: false,
    termination: null,
  };
}

/** After receipt persistence, before application locks. Sequential per block; no new queue/task. */
export async function prepareAdmissionCustomPreview(
  db: Db,
  input: FrozenAdmissionInput,
  receipt: AdmissionResultReceipt,
  limits: PreviewLimits,
  signal?: AbortSignal,
): Promise<PreparedCustomPreview> {
  const result = receipt.result;
  const baseCustom = input.contract.presentation ? customBlocksOf(input.contract.presentation) : [];
  const resolvedCustom = result.resolved?.presentation
    ? customBlocksOf(result.resolved.presentation)
    : [];
  if (baseCustom.length === 0 && resolvedCustom.length === 0) return { kind: 'no_custom' };
  validateLimits(limits);
  let contract: PublishContract = input.contract;
  // Same admitted criterion as the existing checks; knowledge blockers still run under lock.
  if (
    result.status === 'admitted' &&
    result.per_unit.length > 0 &&
    result.per_unit.every((unit) => unit.status === 'admitted')
  ) {
    if (!result.resolved)
      return { kind: 'blocked', reason: 'custom_preview_missing_resolved_contract' };
    const resolved = buildResolvedPublishContract(input, result.resolved);
    if (resolved.kind === 'blocked') return resolved;
    contract = resolved.resolved.contract;
  }
  const blocks = contract.presentation ? customBlocksOf(contract.presentation) : [];
  if (blocks.length === 0) return { kind: 'no_custom' };
  signal?.throwIfAborted();
  const assetIds = [...new Set(blocks.map((block) => block.sandbox.asset.asset_id))];
  const rows = await db.select().from(source_asset).where(inArray(source_asset.id, assetIds));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const loader: AssessmentAssetLoader = createAssessmentAssetLoader(db);
  const bytesByKey = new Map<string, Uint8Array>();
  const loadedByAsset = new Map<string, Awaited<ReturnType<AssessmentAssetLoader>>>();
  const evidence: BlockPreviewEvidence[] = [];
  const slots = new Map(contract.response_spec.slots.map((slot) => [slot.slot_id, slot]));
  for (const block of blocks) {
    signal?.throwIfAborted();
    const row = byId.get(block.sandbox.asset.asset_id);
    if (!row || !['text/javascript', 'application/javascript'].includes(row.mime_type)) {
      evidence.push(assetFailure(block, 'asset_unavailable'));
      continue;
    }
    try {
      const assetSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(limits.total_ms)])
        : AbortSignal.timeout(limits.total_ms);
      if (!loadedByAsset.has(row.id)) {
        // Reserve the failed result too: never fetch a shared code asset twice in one pass.
        loadedByAsset.set(row.id, null);
        loadedByAsset.set(row.id, await loader(block.sandbox.asset, assetSignal));
      }
      const loaded = loadedByAsset.get(row.id);
      const bytes = loaded?.bytes;
      const code = bytes && verifyCode(bytes, block.sandbox.asset.digest);
      // Recheck the storage-key row used by the cache. No code executes on an unverified asset.
      const [fresh] = await db
        .select()
        .from(source_asset)
        .where(eq(source_asset.id, row.id))
        .limit(1);
      if (
        !bytes ||
        code == null ||
        !isValidEntry(block.sandbox.entry) ||
        row.id !== `sbx_${block.sandbox.asset.digest.slice(7, 39)}` ||
        `sha256:${row.sha256}` !== block.sandbox.asset.digest ||
        bytes.byteLength !== row.byte_size ||
        !fresh ||
        fresh.storage_key !== row.storage_key ||
        fresh.sha256 !== row.sha256 ||
        fresh.byte_size !== row.byte_size ||
        fresh.mime_type !== row.mime_type
      ) {
        evidence.push(assetFailure(block, 'asset_invalid'));
        continue;
      }
      // The very same byte view is hashed/decoded above and returned to the publish barrier.
      bytesByKey.set(row.storage_key, bytes);
      evidence.push(await previewBlockInChromium(block, code, slots, limits, signal));
    } catch {
      signal?.throwIfAborted();
      evidence.push(assetFailure(block, 'asset_unavailable'));
    }
  }
  signal?.throwIfAborted();
  return {
    kind: 'previewed',
    evidence: {
      policy_id: PREVIEW_POLICY,
      source: 'question_admission_run',
      frozen: frozenIdentity(input, receipt),
      final_contract_digest: contract.integrity_digest,
      final_contract_key: contractKey(contract),
      public_interface_digest: publicInterface(contract),
      configured_limits: { ...limits },
      status: evidence.every((block) => block.status === 'passed') ? 'passed' : 'failed',
      blocks: evidence,
    },
    readAssetBytes: async (key) => bytesByKey.get(key) ?? null,
  };
}

/** Lock-local decision over the ACTUAL built publish contract. Never changes the paid receipt. */
export function applyCustomPreviewDecision(
  prepared: PreparedCustomPreview,
  built: Publication,
  input: FrozenAdmissionInput,
  receipt: AdmissionResultReceipt,
  current: {
    revision_id: string | null;
    revision_digest: string | null;
    admission_generation: number | null;
  },
): AdmissionPublishBuild {
  const blocks = built.contract.presentation ? customBlocksOf(built.contract.presentation) : [];
  if (blocks.length === 0) return built; // original no-custom publication is byte-for-byte unchanged
  if (prepared.kind === 'blocked') return prepared;
  if (
    prepared.kind !== 'previewed' ||
    prepared.evidence.final_contract_key !== contractKey(built.contract) ||
    prepared.evidence.final_contract_digest !== built.contract.integrity_digest ||
    prepared.evidence.public_interface_digest !== publicInterface(built.contract) ||
    canonicalHash(prepared.evidence.frozen) !== canonicalHash(frozenIdentity(input, receipt)) ||
    built.publish.group_id !== input.group_id ||
    current.revision_id !== input.revision_id ||
    current.revision_digest !== input.contract.integrity_digest ||
    (input.revision_id !== null && current.revision_digest !== input.revision_digest) ||
    built.publish.expectedCurrentRevision !== current.revision_id ||
    built.publish.expectedAdmissionGeneration !== current.admission_generation
  ) {
    return { kind: 'blocked', reason: 'custom_preview_final_publication_identity_mismatch' };
  }
  const passed = prepared.evidence.status === 'passed';
  const admitted = built.admitted && passed;
  const verification = built.publish.verification;
  if (!verification) return { kind: 'blocked', reason: 'custom_preview_verification_missing' };
  return {
    ...built,
    admitted,
    publish: {
      ...built.publish,
      // Keep the final resolved candidate and its original paid binding even on rejection.
      ...(passed
        ? {}
        : {
            admission: { state: 'withheld' as const, reason: 'verification_failed' as const },
            suspension: undefined,
          }),
      readAssetBytes: prepared.readAssetBytes,
      verification: {
        ...verification,
        ...(passed ? {} : { outcome: 'failed' as const }),
        evidence: {
          ...verification.evidence,
          custom_block_preview: {
            ...prepared.evidence,
            // The frozen PAID generation remains verbatim. Re-pending may legitimately
            // replay that receipt under a new generation; bind that distinct CAS here.
            application: { ...current },
          },
        },
      },
    },
  };
}
