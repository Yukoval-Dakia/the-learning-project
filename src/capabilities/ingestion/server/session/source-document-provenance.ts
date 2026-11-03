import { eq, sql } from 'drizzle-orm';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { source_document } from '@/db/schema';
import { USAGE_POLICY_PROVENANCE_KEY } from '@/kernel/read-models/usage-policy';
import { type DocxExternalRefOmissionFacts, EXTERNAL_REF_OMISSION_NOTICE } from '../docx/omission';

// Sole ingestion writer of source_document.provenance. Each document key has one
// owner: birth facts here, source_package from the package producers, usage
// policy from the purpose-change command. Updates after birth merge only their
// own top-level keys in one UPDATE, so a writer that committed in between (e.g. a
// purpose change landing while a DOCX package is still uploading) is never
// overwritten by a stale whole-object copy.

export interface IngestionDocumentBirth {
  sourceAssetIds: string[];
  entrypoint: 'vision_single' | 'vision_paper' | 'docx';
  /** DOCX text line marker; the visual line and image uploads omit it. */
  line?: 'text';
  /** Key presence means an explicit learner choice; absence keeps the derived fallback. */
  learnerSelectedSubjectId?: string | null;
  /** Explicit consent only; absence reads as the legacy 'allow'. */
  derivationPolicy?: DerivationPolicyT | null;
  /** Both digests and the omitted part/rId/type facts, never the external Target URL. */
  externalRefOmission?: DocxExternalRefOmissionFacts;
  now: Date;
}

export async function insertIngestionSourceDocument(
  tx: Tx,
  id: string,
  birth: IngestionDocumentBirth,
): Promise<void> {
  const omission = birth.externalRefOmission;
  await tx.insert(source_document).values({
    id,
    title: null,
    source_asset_ids: birth.sourceAssetIds,
    body_md: null,
    provenance: {
      entrypoint: birth.entrypoint,
      ...(birth.line ? { line: birth.line } : {}),
      ...(birth.learnerSelectedSubjectId
        ? { learner_selected_subject_id: birth.learnerSelectedSubjectId }
        : {}),
      ...(birth.derivationPolicy
        ? { [USAGE_POLICY_PROVENANCE_KEY]: { derivation_policy: birth.derivationPolicy } }
        : {}),
      ...(omission
        ? {
            docx_external_ref_omission: {
              input_sha256: omission.inputSha256,
              converter_input_sha256: omission.converterInputSha256,
              omitted: omission.omissions,
              learner_notice: EXTERNAL_REF_OMISSION_NOTICE,
            },
          }
        : {}),
    } as Record<string, unknown>,
    created_at: birth.now,
    updated_at: birth.now,
    version: 0,
  });
}

// The UPDATE's own row lock serializes concurrent writers, and READ COMMITTED
// re-reads the latest committed provenance before applying `||`.
async function mergeProvenanceKeys(
  db: Db | Tx,
  sourceDocumentId: string,
  keys: Record<string, unknown>,
  columns: { body_md?: string | null; version?: number; updated_at?: Date } = {},
): Promise<void> {
  await db
    .update(source_document)
    .set({
      ...columns,
      provenance: sql`coalesce(${source_document.provenance}, '{}'::jsonb) || ${JSON.stringify(keys)}::jsonb`,
    })
    .where(eq(source_document.id, sourceDocumentId));
}

/** Package producers (create-session materialization and both DOCX lines). */
export async function recordSourcePackage(
  db: Db | Tx,
  sourceDocumentId: string,
  input: {
    sourcePackage: object;
    bodyMd: string | null;
    omittedMedia?: { path: string; reason: string }[];
  },
): Promise<void> {
  await mergeProvenanceKeys(
    db,
    sourceDocumentId,
    {
      source_package: input.sourcePackage,
      ...(input.omittedMedia?.length ? { source_package_omitted_media: input.omittedMedia } : {}),
    },
    { body_md: input.bodyMd, updated_at: new Date() },
  );
}

export async function recordSourcePackageAttachError(
  db: Db | Tx,
  sourceDocumentId: string,
  message: string,
): Promise<void> {
  await mergeProvenanceKeys(db, sourceDocumentId, {
    source_package_attach_error: message.slice(0, 500),
  });
}

/**
 * Purpose-change commit. The caller already holds the global budget lock, the
 * bound session rows and this document FOR UPDATE, and has validated the stored
 * policy shape; `doc` is that locked read, so its version is the CAS base.
 */
export async function commitDocumentUsagePolicy(
  tx: Tx,
  doc: { id: string; version: number; provenance: unknown },
  change: { target: 'allow' | 'answer_only'; epoch: string },
): Promise<void> {
  const rawPolicy = (doc.provenance as Record<string, unknown>)[USAGE_POLICY_PROVENANCE_KEY] as
    | Record<string, unknown>
    | undefined;
  await mergeProvenanceKeys(
    tx,
    doc.id,
    {
      [USAGE_POLICY_PROVENANCE_KEY]: { ...rawPolicy, derivation_policy: change.target },
      usage_epoch: change.epoch,
    },
    { version: doc.version + 1, updated_at: new Date() },
  );
}
